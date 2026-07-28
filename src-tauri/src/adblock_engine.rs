//! Network ad-blocking via Brave's `adblock` matching engine. Used where the
//! webview can intercept subresource requests and answer synchronously — Android's
//! `WebViewClient.shouldInterceptRequest` (via the JNI export below). Desktop
//! Linux/macOS can't intercept WebKit requests, so they block declaratively with
//! WebKit content filters (`adblock_webkit.rs`); this is their Chromium-side
//! counterpart, reusing the same EasyList and engine the desktop converter parses.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;

/// Live ad-block policy, mirrored from the Tauri-managed `AdblockState` by
/// `adblock::dispatch` (the JNI `should_block` runs without an AppHandle, so it
/// reads these instead). Defaults match `AdblockState::default()` (on, empty), so no
/// startup sync is needed.
static ENABLED: AtomicBool = AtomicBool::new(true);
static ALLOWLIST: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn allowlist() -> &'static Mutex<HashSet<String>> {
    ALLOWLIST.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Mirror the ad-block on/off + per-host allowlist into the engine's view. Called
/// from `adblock::dispatch` after every state change.
pub fn set_policy(enabled: bool, allowlisted_hosts: &[String]) {
    ENABLED.store(enabled, Ordering::Relaxed);
    let mut a = allowlist().lock().unwrap_or_else(|e| e.into_inner());
    a.clear();
    a.extend(allowlisted_hosts.iter().map(|h| h.to_ascii_lowercase()));
}

/// Lowercased host of a URL (minimal parse — scheme://[user@]host[:port]/...).
fn host_of(url: &str) -> Option<String> {
    let authority = url.split("://").nth(1)?.split('/').next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// `adblock::Engine` is `!Send` (its `ResourceStorage` holds a `Box<dyn ...>`), and
/// the only public constructor wraps the network `Blocker` inside it — so the engine
/// can't be shared across the webview's network threads directly. Instead it lives on
/// one dedicated thread that owns it for the process lifetime; callers send a query
/// and block on the reply. Only `String`/`bool` cross threads, so this is `Send`-safe,
/// and there's exactly one engine (~one EasyList parse, ~20 MB) regardless of how many
/// threads `shouldInterceptRequest` runs on.
struct Query {
    url: String,
    source: String,
    rtype: String,
    reply: Sender<bool>,
}

/// Messages to the engine thread. The `!Send` `Engine` lives on that one thread, so a
/// FilterSet rebuild can't happen in-place from a caller — it's requested via `Reload`,
/// which carries the extra list texts (enabled subscriptions + custom filters) to fold in
/// alongside the bundled lists. `Query` and `Reload` are processed FIFO, so a query sent
/// after a reload always sees the rebuilt engine.
enum Msg {
    Query(Query),
    Reload(Vec<String>),
}

/// Build the matching engine from every bundled list (ads + trackers + Peter Lowe's +
/// abuse-TLDs — see `adblock_lists`) plus the caller-supplied `extra` list texts. One
/// EasyList-scale parse (~20 MB); runs on the engine thread.
fn build_engine(extra: &[String]) -> Engine {
    let mut set = FilterSet::new(false); // false = matching engine (not convert)
    for list in crate::adblock_lists::ALL {
        set.add_filters(list.lines(), ParseOptions::default());
    }
    for text in extra {
        set.add_filters(text.lines(), ParseOptions::default());
    }
    Engine::from_filter_set(set, true)
}

static TX: OnceLock<Sender<Msg>> = OnceLock::new();

fn tx() -> &'static Sender<Msg> {
    TX.get_or_init(|| {
        let (tx, rx) = channel::<Msg>();
        std::thread::spawn(move || {
            let mut engine = build_engine(&[]);
            while let Ok(msg) = rx.recv() {
                match msg {
                    Msg::Query(q) => {
                        let blocked = match Request::new(&q.url, &q.source, &q.rtype) {
                            Ok(req) => engine.check_network_request(&req).matched,
                            Err(_) => false, // fail open: unparseable URL is allowed
                        };
                        let _ = q.reply.send(blocked);
                    }
                    // Rebuild the FilterSet + Engine in place on this thread (the only
                    // place the !Send Engine can be replaced).
                    Msg::Reload(extra) => engine = build_engine(&extra),
                }
            }
        });
        tx
    })
}

/// Rebuild the engine's FilterSet from the bundled lists + `extra_lists` (the enabled
/// subscriptions' text + the user's custom filters) so a filter change takes effect on
/// Windows/macOS/Android (which otherwise never re-read them after boot). Fire-and-forget;
/// the FIFO channel guarantees the next query sees the rebuilt engine. Called from
/// `adblock_refresh::refresh`. (Linux's declarative WebKit tier reloads separately.)
pub fn reload_lists(extra_lists: Vec<String>) {
    let _ = tx().send(Msg::Reload(extra_lists));
}

/// Whether a subresource request to `url`, made by the page at `source_url` (with a
/// best-effort `request_type` such as "script"/"image"/"document"), should be
/// blocked. Honors the on/off toggle and per-page-host allowlist; fails open on any
/// error, so ad-blocking never breaks a page.
pub fn should_block(url: &str, source_url: &str, request_type: &str) -> bool {
    // Off, or the page's host is allowlisted → allow everything (malware blocking is
    // separate, in the Kotlin guard).
    if !ENABLED.load(Ordering::Relaxed) {
        return false;
    }
    if let Some(host) = host_of(source_url) {
        if allowlist()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&host)
        {
            return false;
        }
    }
    // Reuse one reply channel per calling thread (the GTK main thread on Linux — where
    // this runs for EVERY allowed subresource — and the WebView network threads on
    // Android). Each call sends exactly one Query then immediately recvs its one reply,
    // so the channel holds at most one in-flight value and never accumulates stale
    // replies. This avoids a per-subresource `channel()` heap allocation on the hot path.
    REPLY.with(|(reply, answer)| {
        let q = Query {
            url: url.to_owned(),
            source: source_url.to_owned(),
            rtype: request_type.to_owned(),
            reply: reply.clone(),
        };
        if tx().send(Msg::Query(q)).is_err() {
            return false;
        }
        answer.recv().unwrap_or(false)
    })
}

thread_local! {
    /// Per-thread reusable reply channel for `should_block` (see its body for why this is
    /// safe: strictly one send → one recv per call). Created lazily on first use.
    static REPLY: (Sender<bool>, Receiver<bool>) = channel();
}

/// Whether a new-window / pop-under request to `url` should be dropped rather than
/// opened as a background tab. Two cases:
/// 1. A **blank/script-scheme shell** — `window.open('about:blank')` (or no URL) that
///    the opener then scripts. Aegis opens new windows as separate tabs and can't
///    share that window handle, so the tab just stays blank ("no content loads") —
///    these are almost always ad pop-unders. No legit "open in new tab" targets
///    `about:`/`javascript:`/blank.
/// 2. An **ad/tracker destination** (honors the on/off toggle + allowlist).
///
/// A normal `target=_blank` link (a real http(s) page) is NOT dropped.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn is_unwanted_popup(url: &str, opener_url: &str) -> bool {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    if u.is_empty() || lower.starts_with("about:") || lower.starts_with("javascript:") {
        return true;
    }
    should_block(url, opener_url, "document")
}

/// JNI bridge for Android's `NativeAdblock.shouldBlock` (a Kotlin `object`, so the
/// symbol is `Java_<pkg>_NativeAdblock_shouldBlock` and the second arg is the
/// singleton instance, ignored). Called from the content WebView's
/// `shouldInterceptRequest`. Lives in `libapp_lib.so`, loaded at startup.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeAdblock_shouldBlock(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    url: jni::objects::JString,
    source_url: jni::objects::JString,
    request_type: jni::objects::JString,
) -> jni::sys::jboolean {
    let url: String = env.get_string(&url).map(|s| s.into()).unwrap_or_default();
    let source: String = env
        .get_string(&source_url)
        .map(|s| s.into())
        .unwrap_or_default();
    let rtype: String = env
        .get_string(&request_type)
        .map(|s| s.into())
        .unwrap_or_default();
    should_block(&url, &source, &rtype) as jni::sys::jboolean
}

#[cfg(test)]
mod tests {
    use super::{is_unwanted_popup, reload_lists, set_policy, should_block};

    // Blank/script-scheme shells are dropped without consulting the engine, so this
    // is policy-independent (won't race the policy-mutating test below).
    #[test]
    fn unwanted_popup_drops_blank_and_script_shells() {
        assert!(is_unwanted_popup("about:blank", "https://site.example"));
        assert!(is_unwanted_popup("", "https://site.example"));
        assert!(is_unwanted_popup("  ", "https://site.example"));
        assert!(is_unwanted_popup(
            "javascript:void(0)",
            "https://site.example"
        ));
        assert!(is_unwanted_popup("ABOUT:BLANK", "https://site.example"));
        // A real http(s) link is decided by the ad engine, not the shell check.
        assert!(!is_unwanted_popup(
            "https://example.org/article",
            "https://site.example"
        ));
    }

    // One test (not several) because it mutates the process-wide policy globals.
    #[test]
    fn blocks_ads_and_honors_toggle_and_allowlist() {
        // Default: on, empty allowlist. `||adnxs.com^` is an unconditional anchor in
        // the vendored EasyList; example.com is clean.
        assert!(
            should_block(
                "https://adnxs.com/tag.js",
                "https://news.example.com",
                "script"
            ),
            "a known ad/tracker domain must be blocked"
        );
        // Trackers/analytics live in EasyPrivacy, NOT EasyList — these prove the
        // privacy list is actually in the engine (they would NOT block on EasyList
        // alone, which is exactly the coverage gap this bundle closes).
        assert!(
            should_block(
                "https://www.google-analytics.com/analytics.js",
                "https://news.example.com",
                "script"
            ),
            "an analytics tracker (EasyPrivacy) must be blocked"
        );
        assert!(
            should_block(
                "https://sb.scorecardresearch.com/beacon.js",
                "https://news.example.com",
                "script"
            ),
            "a comScore tracker (EasyPrivacy) must be blocked"
        );
        // Rotating malvertising domains on throwaway TLDs (the streamex pop-under/banner
        // networks) — caught by the abuse-TLD block (`||cfd^`), since no static domain
        // list can keep up with disposable random names like these.
        assert!(
            should_block(
                "https://cupcake.limbycocking.cfd/banner.jpg",
                "https://streamex.sh/watch",
                "image"
            ),
            "a rotating .cfd malvertising domain must be blocked by the abuse-TLD list"
        );
        assert!(
            should_block(
                "https://1x39.r5zkgi2ufhmkn5ty2i.cfd/x",
                "https://streamex.sh/watch",
                "script"
            ),
            "any .cfd host must be blocked regardless of the random subdomain"
        );
        assert!(
            !should_block(
                "https://cfd.example.com/app.js",
                "https://example.com",
                "script"
            ),
            "a host that merely contains 'cfd' as a non-TLD label must NOT be blocked"
        );
        assert!(
            !should_block("https://example.com/", "https://example.com/", "document"),
            "a normal first-party page must not be blocked"
        );
        assert!(
            !should_block(
                "https://example.com/styles.css",
                "https://example.com/",
                "stylesheet"
            ),
            "a normal first-party asset must not be blocked"
        );
        // A pop-under (top-level document) to an ad domain is blocked too — this is
        // exactly what nav::on_new_window checks to drop ad pop-unders into nowhere.
        assert!(
            should_block(
                "https://adnxs.com/popunder",
                "https://news.example.com",
                "document"
            ),
            "an ad-domain pop-under (document) must be blocked"
        );
        assert!(
            !should_block(
                "https://example.org/article",
                "https://news.example.com",
                "document"
            ),
            "a legit target=_blank link (clean domain) must still open"
        );
        // is_unwanted_popup combines the blank-shell check with the ad-domain check.
        assert!(
            is_unwanted_popup("https://adnxs.com/popunder", "https://news.example.com"),
            "an ad-domain pop-under must be dropped"
        );

        // Toggle OFF → nothing is ad-blocked.
        set_policy(false, &[]);
        assert!(
            !should_block(
                "https://adnxs.com/tag.js",
                "https://news.example.com",
                "script"
            ),
            "with ad-block off, even ad domains are allowed"
        );

        // ON, page host allowlisted → ads allowed on that page, blocked elsewhere.
        set_policy(true, &["news.example.com".to_string()]);
        assert!(
            !should_block(
                "https://adnxs.com/tag.js",
                "https://news.example.com/article",
                "script"
            ),
            "ads on an allowlisted page must be allowed"
        );
        assert!(
            should_block(
                "https://adnxs.com/tag.js",
                "https://other.example.org/",
                "script"
            ),
            "ads on a non-allowlisted page must still block"
        );

        // Reset to default so nothing else sees a mutated engine.
        set_policy(true, &[]);
        assert!(should_block(
            "https://adnxs.com/tag.js",
            "https://news.example.com",
            "script"
        ));

        // reload_lists folds extra filter text (an enabled subscription / a custom rule)
        // into the engine. `reloadtest.example` is in NO bundled list, so it only blocks
        // after the reload — proving the FilterSet rebuild took effect (FIFO: the query
        // below is processed after the reload).
        reload_lists(vec!["||reloadtest.example^".to_string()]);
        assert!(
            should_block(
                "https://reloadtest.example/x",
                "https://site.example",
                "script"
            ),
            "a reloaded custom filter must take effect"
        );
        assert!(
            should_block(
                "https://adnxs.com/tag.js",
                "https://news.example.com",
                "script"
            ),
            "the bundled lists still apply after a reload"
        );
        // Reset the engine to the bundled-only lists so other tests don't see it blocked.
        reload_lists(vec![]);
        assert!(
            !should_block(
                "https://reloadtest.example/x",
                "https://site.example",
                "script"
            ),
            "after reloading without the custom filter, it no longer blocks"
        );
    }
}
