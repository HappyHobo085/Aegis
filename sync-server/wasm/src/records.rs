//! `GET /v1/records` and `POST /v1/records`, as the native handlers answer them, over the
//! record layout of [`crate::keys`].
use std::collections::VecDeque;

use aegis_sync_core::canon::{canonicalize_body, reject_client_poisoning_stamps};
use aegis_sync_core::env::Entropy;
use aegis_sync_core::order::{order_bytes, tie_ord};
use aegis_sync_core::wire::{
    MAX_CT_LEN, MAX_FIELD_LEN, MAX_RECORDS_PER_REQUEST, MAX_RESPONSE_RECORDS, WireRecord, hlc_key,
    hlc_well_formed, wire_bytes,
};
use serde::Deserialize;
use serde_json::json;
use wstd::http::{Body, HeaderValue, Response};

use crate::caps::{self, MAX_RECORDS_PER_ACCOUNT, MAX_TOTAL_CT_BYTES, MAX_TOTAL_RECORDS};
use crate::http::{Resp, json, query_pairs, status};
use crate::keys;
use crate::meshnode::kv::store as kv;
use crate::{auth, retention, store};

// ----------------------------------------------------------------------------- GET

struct RecordsQuery {
    ns: String,
    cursor: Option<String>,
    limit: Option<usize>,
}

/// The native `Query<RecordsQuery>`: `ns` required, `limit` a `usize`, a repeated field is an
/// error. Unknown fields are ignored. Every failure is a `400`, before authentication.
fn parse_query(q: &str) -> Result<RecordsQuery, u16> {
    let (mut ns, mut cursor, mut limit) = (None, None, None);
    for (k, v) in query_pairs(q) {
        let slot = match k.as_str() {
            "ns" => &mut ns,
            "cursor" => &mut cursor,
            "limit" => &mut limit,
            _ => continue,
        };
        if slot.replace(v).is_some() {
            return Err(400);
        }
    }
    let limit = match limit {
        Some(l) => Some(l.parse::<usize>().map_err(|_| 400u16)?),
        None => None,
    };
    Ok(RecordsQuery {
        ns: ns.ok_or(400u16)?,
        cursor,
        limit,
    })
}

/// One page of `(account, ns)` in uuid order after `cursor`, with the tie `ord` applied.
///
/// The page is the core's `page::page_sorted` page (same limit clamp, the same stop before
/// the record that would cross the byte budget, the first record always served, `next` the
/// last uuid served) with the byte budget [`MESH_MAX_RESPONSE_BYTES`] instead of the core's
/// `MAX_RESPONSE_BYTES`. It is computed record by record while the response body streams, so
/// guest memory holds one record and one output chunk, not the page (held as records, then
/// cloned, then serialized, a page would cost about three times its size). The harness checks
/// every page it walks against the same loop with the mesh budget, and pins that loop to
/// `page_sorted` at the core's budget.
pub fn get(query: &str, authz: Option<&str>) -> Resp {
    let q = match parse_query(query) {
        Ok(q) => q,
        Err(code) => return status(code),
    };
    let caller = match auth::authenticate(authz, auth::member) {
        Ok(c) => c,
        Err(code) => return status(code),
    };
    if q.ns.is_empty() {
        return status(400);
    }
    if q.ns.len() > MAX_FIELD_LEN || q.cursor.as_ref().is_some_and(|c| c.len() > MAX_FIELD_LEN) {
        return status(413);
    }
    let prefix = keys::rec_prefix(&caller.account, &q.ns);
    let pager = Pager {
        after: q.cursor.map(|c| format!("{prefix}{c}")),
        prefix,
        account: caller.account,
        ns: q.ns,
        limit: q
            .limit
            .unwrap_or(MAX_RESPONSE_RECORDS)
            .clamp(1, MAX_RESPONSE_RECORDS),
        queued: VecDeque::new(),
        exhausted: false,
        served: 0,
        bytes: 0,
        last: None,
        end_after: None,
        state: PagerState::Head,
    };
    let mut resp = Response::new(Body::from_stream(futures_lite::stream::iter(pager)));
    resp.headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    resp
}

/// The byte budget of one `GET /v1/records` page on the mesh: 6 MiB, not the core's 32 MiB
/// `wire::MAX_RESPONSE_BYTES`. The runtime caps a service's RESPONSE body at its
/// `max_body_bytes` (8 MiB by default, spec §5.3) just as it caps the request body, so a 32 MiB
/// page would come back as a 500 and the client could never page past it. 6 MiB of
/// `wire_bytes` leaves room under 8 MiB for JSON that `wire_bytes`' per-record slack does not
/// cover (string escapes). The record limit stays `MAX_RESPONSE_RECORDS`. The vendored core
/// stays byte-identical, so the constant lives here.
pub const MESH_MAX_RESPONSE_BYTES: u64 = 6 * 1024 * 1024;

/// Bytes the pager gathers before handing a chunk to the response stream.
const CHUNK: usize = 64 * 1024;

enum PagerState {
    Head,
    Records,
    Done,
}

enum Step {
    Emit(WireRecord),
    End(Option<String>),
}

/// The streaming page: an iterator of body chunks `{"records":[` … `],"next":…}`.
struct Pager {
    account: String,
    ns: String,
    prefix: String,
    /// The `start-after` key of the next `list-keys` call.
    after: Option<String>,
    limit: usize,
    /// Keys listed but not read yet.
    queued: VecDeque<String>,
    /// `list-keys` has nothing more after `after`.
    exhausted: bool,
    served: usize,
    bytes: u64,
    last: Option<String>,
    /// The page ends right after the record just emitted, with this `next`.
    end_after: Option<Option<String>>,
    state: PagerState,
}

impl Pager {
    /// The namespace's next record in uuid order, as served (tie `ord` included). Lists keys
    /// only as far as needed: at most one record past a page that fills by count.
    fn next_record(&mut self) -> Option<WireRecord> {
        loop {
            if let Some(key) = self.queued.pop_front() {
                // A key listed but deleted before this read is simply gone.
                let Some(mut rec) = store::record(&key) else {
                    continue;
                };
                rec.uuid = key[self.prefix.len()..].to_string();
                rec.ord = None;
                if store::tied_below(&self.account, &self.ns, &rec) {
                    rec.ord = Some(tie_ord(&rec));
                }
                return Some(rec);
            }
            if self.exhausted {
                return None;
            }
            let want = (self.limit - self.served.min(self.limit) + 1).min(store::PAGE as usize);
            let batch = kv::list_keys(&self.prefix, self.after.as_deref(), want as u32);
            self.exhausted = batch.len() < want;
            if let Some(k) = batch.last() {
                self.after = Some(k.clone());
            }
            self.queued.extend(batch);
        }
    }

    /// One iteration of `page_sorted`'s loop.
    fn step(&mut self) -> Step {
        if let Some(next) = self.end_after.take() {
            return Step::End(next);
        }
        let Some(r) = self.next_record() else {
            return Step::End(None);
        };
        if self.served >= self.limit {
            // The page is full but the namespace is not exhausted.
            return Step::End(self.last.clone());
        }
        self.bytes += wire_bytes(&r) as u64;
        if self.served == 0 && self.bytes > MESH_MAX_RESPONSE_BYTES {
            // The first record is always served, even over budget, so the cursor moves.
            self.served = 1;
            self.end_after = Some(Some(r.uuid.clone()));
            return Step::Emit(r);
        }
        if self.bytes > MESH_MAX_RESPONSE_BYTES {
            return Step::End(self.last.clone());
        }
        self.served += 1;
        self.last = Some(r.uuid.clone());
        Step::Emit(r)
    }
}

impl Iterator for Pager {
    type Item = Vec<u8>;

    fn next(&mut self) -> Option<Vec<u8>> {
        match self.state {
            PagerState::Head => {
                self.state = PagerState::Records;
                Some(b"{\"records\":[".to_vec())
            }
            PagerState::Records => {
                let mut chunk = Vec::new();
                while chunk.len() < CHUNK {
                    match self.step() {
                        Step::Emit(r) => {
                            if self.served > 1 {
                                chunk.push(b',');
                            }
                            serde_json::to_writer(&mut chunk, &r).expect("a record serializes");
                        }
                        Step::End(next) => {
                            chunk.extend_from_slice(b"],\"next\":");
                            serde_json::to_writer(&mut chunk, &next).expect("a string serializes");
                            chunk.push(b'}');
                            self.state = PagerState::Done;
                            break;
                        }
                    }
                }
                Some(chunk)
            }
            PagerState::Done => None,
        }
    }
}

// ----------------------------------------------------------------------------- POST

#[derive(Deserialize)]
struct PostRecords {
    ns: String,
    records: Vec<WireRecord>,
}

/// `wasi:random`, for the separator `canon::unique_uuid` draws when a synthesized id is taken.
struct WasiEntropy;

impl Entropy for WasiEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        let bytes = wasip2::random::random::get_random_bytes(buf.len() as u64);
        buf.copy_from_slice(&bytes);
    }
}

pub fn post(body: &[u8], authz: Option<&str>) -> Resp {
    match post_inner(body, authz) {
        Ok(()) => json(&json!({ "ok": true })),
        Err(code) => status(code),
    }
}

fn post_inner(body: &[u8], authz: Option<&str>) -> Result<(), u16> {
    // The native `Json<PostRecords>` extractor runs before authentication.
    let body: PostRecords = serde_json::from_slice(body).map_err(|_| 400u16)?;
    let caller = auth::authenticate(authz, auth::member)?;
    let acct = caller.account.as_str();
    let ns = body.ns.as_str();
    if ns.is_empty() {
        return Err(400);
    }
    if body.records.len() > MAX_RECORDS_PER_REQUEST || ns.len() > MAX_FIELD_LEN {
        return Err(413);
    }
    // NUL is refused before canonicalisation: `canonicalize_body` takes a uuid beginning with
    // its internal "\0empty:" slot prefix for a MISSING id, so such a uuid would be given a
    // synthesized id (possibly an existing one) instead of being stored as sent. The store
    // also refuses NUL in a key. The native server has no such check; this is a mesh bound.
    if ns.contains('\0') {
        return Err(400);
    }
    let mut records = body.records;
    for r in &mut records {
        if r.uuid.len() > MAX_FIELD_LEN || r.nonce.len() > MAX_FIELD_LEN || r.ct.len() > MAX_CT_LEN
        {
            return Err(413);
        }
        if r.uuid.contains('\0') || r.nonce.contains('\0') {
            return Err(400);
        }
        if !hlc_well_formed(&r.hlc) {
            return Err(400);
        }
        // `ord` is the server's own ordering stamp, never the client's to set.
        r.ord = None;
    }
    let now = auth::now_ms();
    let records = reject_client_poisoning_stamps(records, now);
    // `canonicalize_body` needs the stored uuids only to keep a synthesized id (for a record
    // pushed with an empty uuid) off an existing one. The ord it may compute from them is
    // dropped below (the mesh serves `tie_ord` at read time), so each stands in as a default
    // record, and the namespace is listed only when an id must be synthesized.
    let existing: Vec<(String, WireRecord)> = if records.iter().any(|r| r.uuid.is_empty()) {
        store::uuids(acct, ns)
            .into_iter()
            .map(|u| (u, WireRecord::default()))
            .collect()
    } else {
        Vec::new()
    };
    let incoming = canonicalize_body(
        records,
        ns,
        existing.iter().map(|(u, r)| (u.as_str(), r)),
        &mut WasiEntropy,
    );
    drop(existing);

    // The replicated store's own bounds, checked for the whole request before anything is
    // written: a key over 512 bytes, an order over 64 bytes (an `hlc.node` over 48 bytes); NUL
    // was refused above. A live record's tie-index key must fit too; a tombstone is stored
    // without it rather than refused (`store::put_record`), as a delete must not fail. The
    // native server has no such bounds; these are the mesh's.
    for (uuid, rec) in &incoming {
        if keys::rec_key(acct, ns, uuid).len() > keys::MAX_KEY
            || (!rec.deleted && keys::hlcidx_key(acct, ns, &rec.hlc, uuid).len() > keys::MAX_KEY)
            || order_bytes(&rec.hlc).len() > keys::MAX_ORDER
        {
            return Err(413);
        }
    }

    // HLC last-writer-wins against this node's view: keep the incoming record only if its
    // `hlc` strictly dominates the stored one (`hlc` against `hlc`, never `ord`). The store's
    // `set-ordered` applies the same order across replicas; checking here as well skips
    // writing (and replicating) a stale or repeated push, as the native server keeps the
    // stored record on an equal `hlc`.
    let mut writes = Vec::new();
    let mut new_keys = 0usize;
    // Ciphertext growth, as native counts it: over every incoming record (stale ones too),
    // each record's growth only, so an update that keeps or shrinks its size never counts.
    let mut growth: u64 = 0;
    for (uuid, mut rec) in incoming {
        let old = store::stored_meta(&keys::rec_key(acct, ns, &uuid));
        let old_len = old.as_ref().map_or(0, |o| o.ct_len);
        growth += rec.ct.len().saturating_sub(old_len) as u64;
        match &old {
            Some(o) if hlc_key(&rec.hlc) <= hlc_key(&o.hlc) => continue,
            Some(_) => {}
            None => new_keys += 1,
        }
        rec.uuid = uuid;
        rec.ord = None;
        writes.push((rec, old));
    }
    // Per-account cap over this node's view: refuse to GROW the account past it (updates to
    // existing records always pass). The mesh total may exceed it by what other nodes admit
    // concurrently.
    if new_keys > 0 {
        let current = store::count_keys(&keys::account_prefix(acct), MAX_RECORDS_PER_ACCOUNT + 1);
        if current + new_keys > MAX_RECORDS_PER_ACCOUNT {
            return Err(507);
        }
    }
    // The server-wide caps (native order: records, then bytes), soft, over the per-node
    // counters (`caps.rs`). Only growth is refused: a full server still takes edits and
    // deletes that add no key and no bytes.
    if new_keys > 0 || growth > 0 {
        let totals = caps::totals();
        if new_keys > 0 && !caps::fits(totals.records, new_keys as u64, MAX_TOTAL_RECORDS as u64) {
            return Err(507);
        }
        if growth > 0 && !caps::fits(totals.ct_bytes, growth, MAX_TOTAL_CT_BYTES) {
            return Err(507);
        }
    }
    // The counters count only what the store actually kept: a key that read as absent can
    // still refuse an older write (a pruned uuid's ordered tombstone, see `put_record`), and a
    // client re-pushing such a stale copy must not grow the counts on every push.
    let mut stored_keys: i64 = 0;
    let mut ct_delta: i64 = 0;
    for (rec, old) in &writes {
        if store::put_record(acct, ns, rec, old.as_ref(), now) {
            stored_keys += i64::from(old.is_none());
            ct_delta += rec.ct.len() as i64 - old.as_ref().map_or(0, |o| o.ct_len) as i64;
        }
    }
    // Retention after the merge, as native reaps after it: this push's own namespace.
    let pruned = retention::prune(acct, ns, now);
    caps::add(caps::RECORDS, stored_keys - pruned.records);
    caps::add(caps::CT_BYTES, ct_delta - pruned.ct_bytes);
    Ok(())
}
