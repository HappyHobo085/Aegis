//! Convert adblock filter-list syntax (EasyList etc.) into WebKit/Safari
//! content-blocker JSON, for the WebKit ad-block tier (Linux/macOS/iOS). Uses the
//! `adblock` crate's built-in `content_blocking` converter (Brave's engine), so we
//! ship one filter-list source and target both the Chromium engine and WebKit.
//! The converted rules include cosmetic `css-display-none` actions, so a single
//! content filter handles network blocking AND element hiding.
//!
//! ## The per-host allowlist
//!
//! Every ad-block tier except this one could honour the allowlist by simply not asking
//! the engine, but a declarative filter list has no such seam: the rules are already
//! compiled into WebKit. The content-blocker format's own escape hatch is an
//! `ignore-previous-rules` action scoped by `if-domain`, so `to_content_blocker_chunks`
//! takes the allowlist and appends one exemption per host (see `allowlist_exemptions`).
//!
//! There is no `#![allow(dead_code)]` here either. This module IS reachable on every
//! platform, but only through `install_adblock`, which is `#[cfg(target_os = "linux")]`,
//! so on Windows/macOS/Android nothing in the file has a caller. The honest way to say
//! that is a cfg gate on the `mod` declaration in lib.rs, not an allow that would also
//! hide a real dead item on Linux. The gate keeps a `test` arm so these conversion tests
//! still run on every platform.
use adblock::content_blocking::{CbAction, CbRule, CbTrigger, CbType};
use adblock::lists::{FilterSet, ParseOptions};

/// Convert filter-list text into WebKit content-blocker JSON, split into chunks of
/// at most `max_per_chunk` rules each (WebKit caps a single filter near ~50k rules;
/// each chunk is loaded as its own content filter). Returns one JSON array string
/// per chunk. Rules the content-blocker format can't express are dropped.
///
/// `allowlist` are hosts the user has exempted from ad-blocking; one
/// `ignore-previous-rules` rule per usable host is appended (see [`allowlist_exemptions`]).
/// It MUST be part of the cache key the caller derives, or a stale filter is reused
/// across an allowlist change.
pub fn to_content_blocker_chunks(
    filter_lists: &[&str],
    max_per_chunk: usize,
    allowlist: &[String],
) -> Result<Vec<String>, String> {
    // `into_content_blocking` requires debug mode (it reads each rule's raw text).
    let mut set = FilterSet::new(true);
    for list in filter_lists {
        set.add_filters(list.lines(), ParseOptions::default());
    }
    let (rules, _used) = set
        .into_content_blocking()
        .map_err(|_| "into_content_blocking failed".to_string())?;
    let exemptions = allowlist_exemptions(allowlist);
    // Every chunk gets its own copy of the exemptions — and this is the whole subtlety of
    // the feature, so it is worth being explicit about why.
    //
    // `adblock_webkit::install_on` loads EACH chunk as its own WebKit content filter
    // (`aegis-{i}`), and WebKit's `ignore-previous-rules` reaches only rules in the SAME
    // filter: "it is not possible to ignore the rules of an other extension; each
    // extension is isolated from the others" (webkit.org/blog/3476). With ~78k bundled
    // rules at 25k per chunk that is 4 filters, so a single exemption appended at the end
    // of the rule list would land in the LAST filter alone — where it can only undo that
    // filter's own rules, leaving the other ~53k still blocking an allowlisted site. The
    // output would look completely correct and exempt almost nothing.
    //
    // So the exemptions are appended to the tail of every chunk: each copy undoes the block
    // rules in its own filter plus every earlier one, since filters are added in order.
    // The cost is a handful of extra rules per chunk (a few dozen bytes against a 25k-rule
    // chunk, and WebKit's cap is ~50k), which is far cheaper than the feature being a no-op.
    let mut chunks = Vec::new();
    for chunk in rules.chunks(max_per_chunk.max(1)) {
        let mut owned = chunk.to_vec();
        owned.extend(exemptions.iter().cloned());
        chunks.push(serde_json::to_string(&owned).map_err(|e| e.to_string())?);
    }
    Ok(chunks)
}

/// One `ignore-previous-rules` exemption per allowlisted host, in content-blocker form.
///
/// `if-domain` is the right key, and it means the TOP-LEVEL PAGE's domain — not the
/// resource's. That is the conversion Brave itself performs: an ABP `domain=` option is a
/// page-domain condition, and `CbRuleEquivalent` maps it straight onto `if_domain`
/// (`adblock-0.12.5/src/content_blocking.rs:430-476`). `ignore-previous-rules` ignores
/// every earlier rule in the same filter, so this restores both the network requests AND
/// the cosmetic `css-display-none` rules for that page — which is what "allowlist this
/// site" has to mean on a tier with no other seam.
///
/// A single `*host` entry covers the host and its subdomains (the format: "Add * in front
/// to match domain and subdomains"), which is exactly the subdomain semantics of
/// `adblock::host_allowlisted` — so allowlisting `example.com` also exempts
/// `www.example.com`, as the UI promises. Brave emits the same lone `*host` form.
fn allowlist_exemptions(allowlist: &[String]) -> Vec<CbRule> {
    let mut out = Vec::new();
    for host in allowlist {
        let Some(host) = usable_if_domain(host) else {
            continue;
        };
        out.push(CbRule {
            action: CbAction {
                typ: CbType::IgnorePreviousRules,
                selector: None,
            },
            trigger: CbTrigger {
                url_filter: ".*".to_string(),
                if_domain: Some(vec![format!("*{host}")]),
                ..CbTrigger::default()
            },
        });
    }
    out
}

/// Normalize `host` into a value the content-blocker format will accept, or `None` to
/// skip it.
///
/// The format requires `if-domain` values to be "lowercase ASCII, or punycode for
/// non-ASCII", and the failure mode is severe rather than cosmetic: a filter whose JSON
/// WebKit cannot compile is dropped wholesale, which would turn off ad-blocking for
/// EVERY site. The allowlist is a SYNCABLE store, so a remote device (or a hand-edited
/// store) can put an arbitrary string in it — a bad host must be dropped here, not
/// handed to WebKit.
///
/// In practice the UI seeds this from `location.hostname`, which every current engine
/// already serves as punycode, so a non-ASCII entry is not expected. Punycoding it
/// properly would mean taking a direct dependency on `idna` for a path that should never
/// be reached; dropping the exemption degrades to "this one host stays filtered", which
/// is the right way to fail.
fn usable_if_domain(host: &str) -> Option<String> {
    let h = host.trim().trim_start_matches('.').to_ascii_lowercase();
    if h.is_empty() {
        return None;
    }
    // Hostname labels only: letters, digits, `-`, and the `.` separators. No `_`, no
    // `:port`, no wildcard (the caller adds exactly one leading `*`), no path.
    if !h
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return None;
    }
    Some(h)
}

#[cfg(test)]
mod tests {
    use super::to_content_blocker_chunks;

    /// Convert one filter list and return the first (single) chunk's JSON, or `"[]"`.
    fn convert_one(list: &str) -> String {
        to_content_blocker_chunks(&[list], usize::MAX, &[])
            .unwrap()
            .into_iter()
            .next()
            .unwrap_or_else(|| "[]".to_string())
    }

    #[test]
    fn converts_a_network_rule_to_a_block_action() {
        let json = convert_one("||ads.example.com^");
        assert_ne!(json, "[]", "expected at least one rule");
        assert!(
            json.contains("ads.example.com") || json.contains("ads\\\\.example"),
            "json: {json}"
        );
        assert!(
            json.contains("\"block\""),
            "expected a block action: {json}"
        );
    }

    #[test]
    fn empty_input_yields_empty_array() {
        assert_eq!(convert_one(""), "[]");
    }

    #[test]
    fn bundled_lists_convert_and_cover_trackers() {
        // The Linux tier blocks page subresources via these converted content filters
        // (NOT the engine), so prove EasyPrivacy's tracker rules survive conversion to
        // WebKit JSON — a tracker EasyList alone would miss must appear in the output.
        let chunks = to_content_blocker_chunks(&crate::adblock_lists::ALL, 25_000, &[]).unwrap();
        assert!(
            !chunks.is_empty(),
            "bundled lists must convert to at least one chunk"
        );
        let all: String = chunks.concat();
        assert!(all.contains("doubleclick"), "EasyList ad rule must convert");
        assert!(
            all.contains("google-analytics"),
            "EasyPrivacy tracker rule must convert (Linux content-filter coverage)"
        );
    }

    #[test]
    fn chunks_respect_the_max_size() {
        let rules = (0..50)
            .map(|i| format!("||ads{i}.example.com^"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = to_content_blocker_chunks(&[&rules], 10, &[]).unwrap();
        assert!(
            chunks.len() >= 5,
            "expected several chunks, got {}",
            chunks.len()
        );
        // each chunk is a valid JSON array
        for c in &chunks {
            assert!(c.starts_with('[') && c.ends_with(']'));
        }
    }

    // ── WAVE 1 PROBE: the ad-block allowlist never reaches the declarative tier ────
    //
    // On Linux the *only* thing that blocks a page's subresources is these content
    // filters — there is no request interception to fall back on. An allowlisted site
    // is therefore still fully filtered, the opposite of what the toggle promises.
    // The exemption mechanism already exists in the content-blocker format: an
    // `ignore-previous-rules` action scoped by `if-domain`.
    //
    // WebKit's own docs are explicit that this reaches only rules in the SAME rule
    // list ("it is not possible to ignore the rules of an other extension; each
    // extension is isolated from the others"), and `adblock_webkit::install_on` loads
    // each chunk as a SEPARATE filter — so the exception must be appended INSIDE the
    // final chunk's array, not emitted as an extra chunk of its own.
    //
    // The assertion is keyed on `if-domain` + the allowlisted host, NOT on the mere
    // presence of `ignore-previous-rules`: Brave's converter always appends a
    // default `{"url-filter":".*","resource-type":["document"],"load-type":
    // ["first-party"]}` exception so a top-level first-party navigation is never
    // blocked. An earlier version of this probe asserted only on the action type and
    // PASSED against the unfixed converter — vacuously, for that unrelated default.
    //
    // Written against the current signature on purpose so it compiles and FAILS today
    // rather than failing to compile: the converter has no allowlist input at all,
    // which is precisely the defect. The claim is the assertion; only the way it names
    // the allowlisted case changes once that input exists.
    #[test]
    fn allowlisted_hosts_get_an_ignore_previous_rules_exception() {
        let chunks = to_content_blocker_chunks(
            &["||ads.example.com^"],
            usize::MAX,
            &["trusted.example".to_string()],
        )
        .unwrap();
        let all = chunks.concat();
        assert!(
            all.contains("if-domain") && all.contains("trusted.example"),
            "an ad-block-allowlisted host must be exempted from the declarative WebKit \
             filters by an ignore-previous-rules action scoped with if-domain, but no \
             such trigger was emitted. \
             (Note: a bare `ignore-previous-rules` is ALWAYS present from Brave's \
             first-party-document default, so asserting on that alone is vacuous.) \
             output: {all}"
        );
        // The exemption must be scoped to the host AND its subdomains, since
        // `adblock::host_allowlisted` treats allowlisting `example.com` as also covering
        // `www.example.com` and the UI says so. A single `*host` entry is how the
        // content-blocker format expresses that ("Add * in front to match domain and
        // subdomains"), and it is the form Brave's own converter emits.
        assert!(
            all.contains("*trusted.example"),
            "the exemption must cover subdomains of an allowlisted host (star-prefixed \
             if-domain entry). output: {all}"
        );
        // The host itself must still be a plain `*`-prefixed LABEL, not a bare
        // `*example.com`-shaped wildcard that also swallows unrelated hosts, and the
        // block rule must be untouched.
        assert!(
            all.contains("ads\\\\.example\\\\.com"),
            "the block rule must still be present alongside the exemption. output: {all}"
        );
    }

    /// THE decisive test for this tier. WebKit's `ignore-previous-rules` reaches only rules
    /// in the SAME content filter, and `adblock_webkit::install_on` loads each chunk as its
    /// own filter — so an exemption that appears in only one chunk cancels only that
    /// chunk's rules. With the real bundle that is 4 filters, i.e. ~3/4 of the block rules
    /// still firing on an allowlisted site while the output looks perfectly correct.
    ///
    /// This is the test that caught the "append once at the end of the rule list"
    /// implementation, which passed the single-chunk assertion above and still exempted
    /// nothing in production.
    #[test]
    fn every_chunk_carries_the_exemption_not_just_the_last() {
        let rules = (0..50)
            .map(|i| format!("||ads{i}.example.com^"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks =
            to_content_blocker_chunks(&[&rules], 10, &["trusted.example".to_string()]).unwrap();
        assert!(
            chunks.len() >= 5,
            "expected the 50 rules split across several chunks, got {}",
            chunks.len()
        );
        for (i, c) in chunks.iter().enumerate() {
            assert!(
                c.contains("if-domain") && c.contains("trusted.example"),
                "chunk {i}/{} carries no exemption, so its block rules still apply to an \
                 allowlisted page (WebKit scopes ignore-previous-rules to one content \
                 filter). chunk: {c}",
                chunks.len()
            );
        }
        // The exemption must be ADDED to each chunk, never substituted for its rules. A
        // chunk holding only exception rules is legitimate and expected — Brave appends a
        // default first-party-document exception, which can be the sole member of the final
        // chunk — so the invariant is stated against the no-allowlist baseline: every chunk
        // that blocks without the allowlist must still block with it.
        let baseline = to_content_blocker_chunks(&[&rules], 10, &[]).unwrap();
        assert_eq!(
            chunks.len(),
            baseline.len(),
            "the allowlist must not change how the rules are chunked"
        );
        for (i, (with, without)) in chunks.iter().zip(baseline.iter()).enumerate() {
            assert_eq!(
                with.contains("\"block\""),
                without.contains("\"block\""),
                "chunk {i} gained/lost block rules when the allowlist was added: {with}"
            );
        }
        assert!(
            baseline.iter().any(|c| c.contains("\"block\"")),
            "the baseline must actually block somewhere, or the test above is vacuous"
        );
    }

    /// The exemptions must not change how the rules are chunked in a way that could push a
    /// chunk past WebKit's ~50k per-filter cap. Adding a few rules to each 25k chunk is
    /// fine; the invariant worth pinning is that the count of chunks is unchanged by the
    /// allowlist, i.e. the exemptions ride along with existing chunks instead of creating
    /// new ones.
    #[test]
    fn exemptions_do_not_create_extra_chunks() {
        let rules = (0..50)
            .map(|i| format!("||ads{i}.example.com^"))
            .collect::<Vec<_>>()
            .join("\n");
        let without = to_content_blocker_chunks(&[&rules], 10, &[]).unwrap();
        let with = to_content_blocker_chunks(
            &[&rules],
            10,
            &["a.example".to_string(), "b.example".to_string()],
        )
        .unwrap();
        assert_eq!(
            with.len(),
            without.len(),
            "exemptions must ride along inside existing chunks, not append a chunk of \
             their own (a chunk holding no block rules cannot exempt anything)"
        );
    }

    /// A host the content-blocker format would reject must be DROPPED, not passed through.
    /// WebKit discards a whole filter it cannot compile, so one malformed `if-domain` from
    /// the (syncable, hence remotely-writable) allowlist would disable ad-blocking for
    /// every site — a far worse outcome than one host staying filtered.
    #[test]
    fn unusable_allowlist_hosts_are_dropped_not_emitted() {
        for bad in [
            "",                 // empty
            "  ",               // whitespace
            ".example.com",     // leading dot only -> normalises to example.com, OK
            "ex ample.com",     // space
            "example.com/ads",  // path
            "exämple.com",      // non-ASCII (not punycode)
            "example.com:8080", // port
            "exa_mple.com",     // underscore
        ] {
            let chunks =
                to_content_blocker_chunks(&["||ads.example.com^"], usize::MAX, &[bad.to_string()])
                    .unwrap();
            let all = chunks.concat();
            let usable = bad.trim().trim_start_matches('.').to_ascii_lowercase();
            let expect_emitted = !usable.is_empty()
                && usable
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.');
            assert_eq!(
                all.contains("if-domain"),
                expect_emitted,
                "host {bad:?} -> {all}"
            );
        }
    }
}
