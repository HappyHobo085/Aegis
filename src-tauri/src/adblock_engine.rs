//! Network ad-blocking via Brave's `adblock` matching engine. Used where the
//! webview can intercept subresource requests and answer synchronously — Android's
//! `WebViewClient.shouldInterceptRequest` (via the JNI export below). Desktop
//! Linux/macOS can't intercept WebKit requests, so they block declaratively with
//! WebKit content filters (`adblock_webkit.rs`); this is their Chromium-side
//! counterpart, reusing the same EasyList and engine the desktop converter parses.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use adblock::lists::{FilterSet, ParseOptions};
use adblock::request::Request;
use adblock::Engine;

/// Live ad-block policy, mirrored from the Tauri-managed `AdblockState` by
/// `adblock::dispatch` (the JNI `should_block` runs without an AppHandle, so it
/// reads these instead). Defaults match `AdblockState::default()` (on, empty), so no
/// startup sync is needed.
///
/// A `Vec`, not a `HashSet`: the veto is a subdomain test (`adblock::host_covered`), which
/// a set cannot answer, and the list is a handful of user-added hosts — cheaper to scan
/// than to hash a string per request.
static ENABLED: AtomicBool = AtomicBool::new(true);
static ALLOWLIST: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn allowlist() -> &'static Mutex<Vec<String>> {
    ALLOWLIST.get_or_init(|| Mutex::new(Vec::new()))
}

/// The mirrored on/off toggle, for callers with no `AppHandle` — Android's
/// `NativeAdblock.enabled()` JNI getter, which the Kotlin side uses to key its
/// document-start script cache. Reads the SAME `ENABLED` global `should_block` reads, so
/// the injected JS tier and the network tier cannot disagree about whether ad-blocking is
/// on: they are one value with two readers.
///
/// Live on Android (the `NativeAdblock.enabled()` getter) and under `test` (which reaches it
/// through `adblock_inject::android_document_start_layer`). Nothing else has a use for it:
/// every other tier reads the `AppHandle`-backed `adblock::enabled` instead.
#[cfg(any(target_os = "android", test))]
pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Mirror the ad-block on/off + per-host allowlist into the engine's view. Called
/// from `adblock::dispatch` after every state change.
pub fn set_policy(enabled: bool, allowlisted_hosts: &[String]) {
    ENABLED.store(enabled, Ordering::Relaxed);
    let mut a = allowlist().lock().unwrap_or_else(|e| e.into_inner());
    a.clear();
    a.extend(allowlisted_hosts.iter().map(|h| h.to_ascii_lowercase()));
}

/// Whether the engine's mirrored allowlist covers `host`, with the same scope as
/// `adblock::host_allowlisted` (exact or subdomain). Exists because the JNI tier runs
/// without an `AppHandle` and so cannot read `AdblockState`; it reads the same mirror
/// `should_block` does.
pub fn host_is_allowlisted(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    let g = allowlist().lock().unwrap_or_else(|e| e.into_inner());
    crate::adblock::host_covered(&g, host)
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

/// How long `should_block` waits for the engine thread's verdict before failing open.
///
/// Generous on purpose: a `Msg::Reload` re-parses ~20 MB of filter lists on that thread,
/// and a filter edit is a foreground user action, so the cost of timing out too eagerly is
/// a briefly under-blocked page while the cost of waiting too long is a frozen window.
const QUERY_TIMEOUT: Duration = Duration::from_secs(5);

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
                // A panic here must NOT kill this thread. The `!Send` Engine exists ONLY on
                // this thread, so a dead thread turns ad-blocking off permanently and
                // silently: every later `tx().send` fails, `should_block` fails open, and
                // the user just sees a working browser with no ad-blocking and no error.
                // Catch per message and keep serving. `Msg::Reload` only assigns after
                // `build_engine` returns, so a panicking reload leaves the previous (still
                // perfectly valid) engine in place — the failure mode is "your new filter
                // list didn't apply", not "ad-blocking died".
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    match &msg {
                        Msg::Query(q) => {
                            let blocked = match Request::new(&q.url, &q.source, &q.rtype) {
                                Ok(req) => engine.check_network_request(&req).matched,
                                Err(_) => false, // fail open: unparseable URL is allowed
                            };
                            let _ = q.reply.send(blocked);
                        }
                        // Rebuild the FilterSet + Engine in place on this thread (the only
                        // place the !Send Engine can be replaced).
                        Msg::Reload(extra) => engine = build_engine(extra),
                    }
                }));
                if outcome.is_err() {
                    eprintln!(
                        "[aegis-adblock] engine panic recovered; keeping the previous engine"
                    );
                    // A Query that panicked never reached its `reply.send`, so its caller
                    // would otherwise block until QUERY_TIMEOUT. Fail open explicitly.
                    if let Msg::Query(q) = &msg {
                        let _ = q.reply.send(false);
                    }
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
        if host_is_allowlisted(&host) {
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
        // Bounded wait. `Msg` is FIFO on ONE channel, so a `Msg::Reload` (any filter
        // toggle, custom-filter edit or subscription update) makes every in-flight
        // `should_block` queue behind a full EasyList re-parse. Unbounded, that froze the
        // GTK main thread — `should_block` is called from `nav::decide_navigation` for
        // every subresource, so 40 iframes x a filter edit meant 40 serialized stalls.
        // Timing out fails OPEN (the request is allowed), so the worst case is that a
        // filter edit briefly under-blocks instead of hanging the window.
        match answer.recv_timeout(QUERY_TIMEOUT) {
            Ok(blocked) => blocked,
            Err(RecvTimeoutError::Timeout) => {
                // A late reply is now sitting in this thread's REUSED channel. It must be
                // drained, or the NEXT query would consume the previous query's verdict
                // and answer the wrong request.
                while answer.try_recv().is_ok() {}
                false
            }
            // The engine thread is gone (disconnected). It cannot recover itself, so just
            // fail open — same as a dead filter engine, and far better than blocking.
            Err(RecvTimeoutError::Disconnected) => false,
        }
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
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
// name means two libraries could export the same symbol, which the linker leaves
// undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
// by name), so it is allowed here explicitly rather than by the module scope —
// `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
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
    // Fails OPEN on a panic, matching `should_block`'s own contract: ad-blocking must
    // never be the reason a page fails to load.
    match crate::ffi_guard(|| should_block(&url, &source, &rtype)) {
        Some(blocked) => blocked as jni::sys::jboolean,
        None => {
            eprintln!("[aegis-adblock] should_block panicked; failing open for this request");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_unwanted_popup, reload_lists, set_policy, should_block};

    // The blank/script-scheme shells are dropped without consulting the engine, so those
    // assertions are policy-independent. The last one is not: a real http(s) link IS
    // decided by the engine, so this test takes the same `test_support::lock()` as the
    // policy-mutating test below. (The claim that this whole test "won't race" was wrong —
    // it survives today only because it asserts the NOT-blocked answer, and every race
    // direction pushes `should_block` toward failing open. Do not rely on that polarity.)
    #[test]
    fn unwanted_popup_drops_blank_and_script_shells() {
        let _guard = crate::test_support::lock();
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
    //
    // `ENABLED`/`ALLOWLIST` are process-wide, not per-`AppHandle`, and `set_policy` is
    // written from two directions: `adblock::dispatch`'s `sync_engine`, and
    // `adblock_refresh::refresh` (reached by the `customfilters`/`subs`/`picker`/
    // `data`/`sync_stores` tests). Every one of those goes through `with_tmp_app`,
    // which holds `test_support::lock()` for its whole body — but this test is NOT an
    // AppHandle test, so without taking that lock itself it ran concurrently with all
    // of them under `cargo test`'s parallel execution.
    //
    // That was a real CI flake, not a theory: run 36280528312 failed this test on its
    // FIRST assertion ("a known ad/tracker domain must be blocked") while run
    // 36279563358 passed the identical code. `adblock::tests::set_enabled_flips_the_flag`
    // is the only writer of `enabled = false` in the crate and holds it across a
    // `dispatch` round-trip; interleaved into here, `should_block` takes its fail-open
    // `!ENABLED` early return. `AdblockState::default()` is `enabled: true` so the
    // other re-mirrors are harmless today — but "harmless today" is precisely how this
    // broke, which is why the whole test is serialised rather than reasoning about which
    // hosts each caller happens to use. The allowlist is the same story: it is
    // currently disjoint from the hosts asserted below, and that is not enforced.
    //
    // `test_support::lock()` (not a lock of our own) is the interlock: a second,
    // module-local mutex would not exclude the `with_tmp_app` tests at all. Its own doc
    // comment already names `adblock_engine`'s policy statics as a reason it is `pub`.
    #[test]
    fn blocks_ads_and_honors_toggle_and_allowlist() {
        let _guard = crate::test_support::lock();
        // Warm the engine BEFORE asserting anything. The first `should_block` in the process
        // pays the one-time ~20 MB EasyList parse on the engine thread, and that cost lands
        // INSIDE the caller's `QUERY_TIMEOUT`, which fails OPEN on expiry. Whichever test
        // makes that first call is chosen by alphabetical test order, so it is this one — and
        // adding tests anywhere else in the suite adds load at exactly that moment. Measured
        // on this box: 1 failure in 20 full-suite runs with extra tests present, 0 in 12
        // without, always on the assertion below, and never in isolation. A throwaway query
        // absorbs the build cost; if it does time out, the engine is warm by the time the real
        // assertions run. (The sibling test above is immune for a different reason: it asserts
        // the NOT-blocked answer, which is also what a timeout produces.)
        let _ = should_block("https://example.com/", "https://example.com/", "document");
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
