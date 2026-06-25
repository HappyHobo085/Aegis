//! The bundled filter lists, in ONE place so every ad-block tier blocks from the
//! identical set — the matching engine (`adblock_engine`, used by Android's JNI
//! path, the Windows WebView2 interceptor, and desktop pop-under blocking), the
//! WebKit content-filter converter (Linux, in `lib::install_adblock`), and the
//! injected-JS tier (`adblock_inject`, Windows/macOS). Adding a list here widens
//! coverage on every platform at once, which is the whole point of keeping it
//! single-sourced (Linux/Windows/macOS/Android stay at parity).
//!
//! What's bundled, and why these three:
//! - **EasyList** — ad servers. The baseline ad list; by design it does NOT block
//!   analytics/trackers (that is EasyPrivacy's job), so on its own it misses a whole
//!   category users expect blocked (google-analytics, hotjar, scorecardresearch, …).
//! - **EasyPrivacy** — trackers / analytics / telemetry. The missing category above.
//! - **Peter Lowe's** ad + tracking server list — a compact, high-signal host list
//!   that complements both.
//! - **Abuse-TLDs** (`abuse-tlds.txt`) — a curated `||tld^` block of throwaway TLDs
//!   (.cfd, .sbs, …) used by rotating malvertising networks. Static domain lists can't
//!   keep up with disposable random domains (e.g. limbycocking.cfd on streaming sites);
//!   blocking the abuse TLD does. Deliberately excludes TLDs with legitimate use.
//!
//! This mirrors uBlock Origin's default-enabled set (EasyList + EasyPrivacy + Peter
//! Lowe's). User subscriptions (`subs.rs`) and custom rules (`customfilters.rs`) are
//! layered on top of these by the callers that support them.
//!
//! Some consts/items are unused under certain target cfgs (e.g. only the engine
//! consumes the lists on Android), so the module allows dead code like its sibling
//! `adblock_convert`/`adblock_webkit`.
#![allow(dead_code)]

/// EasyList — ad servers (baseline ad blocking).
pub const EASYLIST: &str = include_str!("../resources/easylist.txt");
/// EasyPrivacy — trackers / analytics / telemetry (EasyList omits these by design).
pub const EASYPRIVACY: &str = include_str!("../resources/easyprivacy.txt");
/// Peter Lowe's ad + tracking server list (ABP `||host^` format).
pub const PETER_LOWE: &str = include_str!("../resources/peter-lowe.txt");
/// Curated abuse-TLD block (`||tld^`) for rotating-domain malvertising networks.
pub const ABUSE_TLDS: &str = include_str!("../resources/abuse-tlds.txt");

/// Every bundled list, as separate sources. Use this when a consumer parses each
/// list's lines (the matching engine, the content-filter converter, the inject
/// builder). Keeping them separate — rather than one pre-joined blob — lets the
/// content-filter cache key in `install_adblock` hash each independently and lets
/// parsers attribute a rule to its origin list.
pub const ALL: [&str; 4] = [EASYLIST, EASYPRIVACY, PETER_LOWE, ABUSE_TLDS];

/// The three large upstream lists (EasyList/EasyPrivacy/Peter Lowe's), excluding the
/// tiny hand-curated abuse-TLD list — used by the size sanity-check in tests.
#[cfg(test)]
const LARGE_LISTS: [&str; 3] = [EASYLIST, EASYPRIVACY, PETER_LOWE];

#[cfg(test)]
mod tests {
    use super::{ABUSE_TLDS, EASYLIST, EASYPRIVACY, LARGE_LISTS};

    #[test]
    fn bundles_easylist_and_easyprivacy_and_peter_lowe() {
        // The three large upstream lists are non-trivial (guards against a truncated/
        // empty vendored file silently shrinking coverage).
        for (i, list) in LARGE_LISTS.iter().enumerate() {
            assert!(
                list.len() > 10_000,
                "bundled list {i} looks too small: {} bytes",
                list.len()
            );
        }
        // EasyList carries an ad server it's known for; EasyPrivacy carries a tracker
        // EasyList deliberately omits — proving the privacy tier is actually bundled.
        assert!(EASYLIST.contains("doubleclick.net"));
        assert!(EASYPRIVACY.contains("google-analytics.com"));
        assert!(
            !EASYLIST.contains("google-analytics.com"),
            "EasyList shouldn't carry analytics — that's EasyPrivacy's job"
        );
        // The abuse-TLD list blocks the throwaway TLD that served the streamex ad.
        assert!(
            ABUSE_TLDS.contains("||cfd^"),
            "abuse-TLD list must block .cfd"
        );
    }
}
