//! The paging core of `GET /v1/records`: one page out of a namespace that is already sorted by
//! uuid, resuming after a cursor, within the response caps.
use crate::wire::{wire_bytes, WireRecord, MAX_RESPONSE_BYTES, MAX_RESPONSE_RECORDS};

/// One page of a namespace's records plus the cursor to resume after it.
#[derive(Default)]
pub struct Page {
    pub records: Vec<WireRecord>,
    /// `Some(last_uuid_served)` when the namespace has more records after this page; `None`
    /// when the page reached the end of the namespace.
    pub next: Option<String>,
}

/// Serve one page out of `sorted`, which MUST yield one namespace's records in ascending `uuid`
/// order, resuming strictly after `cursor` (the client's retain is `uuid > cursor`).
///
/// Moved from the native `page_records`, which now sorts its map and calls this; the loop body is
/// unchanged. Both response caps apply: `limit` is clamped to `1..=MAX_RESPONSE_RECORDS`, and the
/// page stops before the record that would take it past `MAX_RESPONSE_BYTES` (as counted by
/// [`wire_bytes`]), except that the FIRST record is always served.
///
/// `sorted` is consumed lazily, so a host whose store is already ordered (the mesh service's
/// `list-keys`) reads at most one record past the page.
pub fn page_sorted<'a, I: Iterator<Item = &'a WireRecord>>(
    sorted: I,
    cursor: Option<&str>,
    limit: usize,
) -> Page {
    // Clamp rather than trust the caller: `limit` is an authenticated but still untrusted query
    // parameter, and it is the knob that bounds this response. A zero/oversized value must not be
    // able to defeat `MAX_RESPONSE_RECORDS` or stall the client's loop.
    let limit = limit.clamp(1, MAX_RESPONSE_RECORDS);
    let mut records: Vec<WireRecord> = Vec::new();
    let mut bytes = 0u64;
    let mut next: Option<String> = None;
    // `sorted` is ascending, so "skip while <= cursor" is the native `retain(uuid > cursor)`.
    let after_cursor = sorted.skip_while(|r| cursor.is_some_and(|c| r.uuid.as_str() <= c));
    for r in after_cursor {
        if records.len() >= limit {
            // The page is full but the namespace is not exhausted: hand back a cursor.
            next = Some(records.last().map(|w| w.uuid.clone()).unwrap_or_default());
            break;
        }
        // The byte budget is the real bound — a record count alone does not account for
        // ciphertext size. The FIRST record is always served regardless of budget: refusing it
        // would hand back a cursor that makes no progress, and the client loop would spin.
        bytes += wire_bytes(r) as u64;
        if records.is_empty() && bytes > MAX_RESPONSE_BYTES {
            records.push(r.clone());
            next = Some(r.uuid.clone());
            break;
        }
        if bytes > MAX_RESPONSE_BYTES {
            next = Some(records.last().map(|w| w.uuid.clone()).unwrap_or_default());
            break;
        }
        records.push(r.clone());
    }
    Page { records, next }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{
        wire_bytes, WireRecord, MAX_CT_LEN, MAX_RESPONSE_BYTES, MAX_RESPONSE_RECORDS,
    };
    use serde_json::json;

    fn recs(n: usize, ct_len: usize) -> Vec<WireRecord> {
        (0..n)
            .map(|i| WireRecord {
                uuid: format!("u{i:05}"),
                hlc: json!({ "wall_ms": 1, "counter": 0, "node": "n" }),
                ct: "a".repeat(ct_len),
                ..WireRecord::default()
            })
            .collect()
    }

    fn ids(p: &Page) -> Vec<&str> {
        p.records.iter().map(|r| r.uuid.as_str()).collect()
    }

    #[test]
    fn page_sorted_resumes_after_cursor() {
        let all = recs(10, 2);
        let p = page_sorted(all.iter(), Some("u00003"), 3);
        assert_eq!(ids(&p), ["u00004", "u00005", "u00006"]);
        // A cursor between two uuids resumes at the next one; past the end is empty.
        let p = page_sorted(all.iter(), Some("u00003x"), 100);
        assert_eq!(ids(&p).first(), Some(&"u00004"));
        assert_eq!(p.next, None);
        let p = page_sorted(all.iter(), Some("zzz"), 100);
        assert!(p.records.is_empty());
        assert_eq!(p.next, None);
    }

    #[test]
    fn page_sorted_reports_next() {
        let all = recs(10, 2);
        let p = page_sorted(all.iter(), None, 4);
        assert_eq!(
            p.next.as_deref(),
            Some("u00003"),
            "next is the last uuid served"
        );
        let p = page_sorted(all.iter(), None, 10);
        assert_eq!(p.next, None, "a page that reaches the end has no next");
        // `limit` is clamped to 1..=MAX_RESPONSE_RECORDS.
        let p = page_sorted(all.iter(), None, 0);
        assert_eq!(ids(&p), ["u00000"]);
        assert_eq!(p.next.as_deref(), Some("u00000"));
        let many = recs(MAX_RESPONSE_RECORDS + 1, 0);
        let p = page_sorted(many.iter(), None, usize::MAX);
        assert_eq!(p.records.len(), MAX_RESPONSE_RECORDS);
        assert!(p.next.is_some());
    }

    /// R2: the byte budget is enforced as the native `page_records` did: stop BEFORE the record
    /// that would cross `MAX_RESPONSE_BYTES`, but always serve the first record.
    #[test]
    fn page_sorted_enforces_the_byte_budget() {
        let per = wire_bytes(&recs(1, MAX_CT_LEN)[0]) as u64;
        let fit = (MAX_RESPONSE_BYTES / per) as usize;
        let all = recs(fit + 5, MAX_CT_LEN);
        let p = page_sorted(all.iter(), None, MAX_RESPONSE_RECORDS);
        assert_eq!(p.records.len(), fit);
        assert_eq!(p.next.as_deref(), Some(all[fit - 1].uuid.as_str()));
        // The first record is served even if it alone is over budget.
        let mut huge = recs(2, 0);
        huge[0].ct = "a".repeat(MAX_RESPONSE_BYTES as usize + 1);
        let p = page_sorted(huge.iter(), None, 10);
        assert_eq!(ids(&p), ["u00000"]);
        assert_eq!(p.next.as_deref(), Some("u00000"));
    }
}
