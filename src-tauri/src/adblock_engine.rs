//! Network ad-blocking via Brave's `adblock` matching engine. Used where the
//! webview can intercept subresource requests and answer synchronously — Android's
//! `WebViewClient.shouldInterceptRequest` (via the JNI export below). Desktop
//! Linux/macOS can't intercept WebKit requests, so they block declaratively with
//! WebKit content filters (`adblock_webkit.rs`); this is their Chromium-side
//! counterpart, reusing the same EasyList and engine the desktop converter parses.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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
    reply: Sender<Verdict>,
    /// Echoed back with the answer so a caller can tell ITS reply from a late one (see
    /// `should_block`). Only a `String`/`bool`/`u64` crosses threads, so this stays
    /// `Send`-safe.
    seq: u64,
}

/// One answer from the engine thread, tagged with the `seq` of the `Query` it belongs to.
struct Verdict {
    seq: u64,
    blocked: bool,
}

/// Messages to the engine thread. The `!Send` `Engine` lives on that one thread, so a
/// FilterSet rebuild can't happen in-place from a caller — it's requested via `Reload`,
/// which carries the extra list texts (enabled subscriptions + custom filters) to fold in
/// alongside the bundled lists. `Query` and `Reload` are processed FIFO, so a query sent
/// after a reload always sees the rebuilt engine.
enum Msg {
    Query(Query),
    /// A rebuild request. The texts live in `PENDING_RELOAD` rather than in the message so
    /// a burst of requests collapses into one (see `reload_lists`).
    Reload,
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

/// How many verdicts to memoise before dropping the lot.
///
/// Sized for a heavy page's worth of distinct subresources with room to spare. The cap
/// is a memory bound, not an eviction policy: when it is hit the whole map is dropped,
/// which costs one re-match per entry and needs no ordering bookkeeping. Measured on
/// this box, one re-match is ~284 us and one whole-map drop is ~0, so clearing is
/// strictly cheaper than any LRU would be.
const VERDICT_CACHE_MAX: usize = 4096;

/// Verdicts this engine thread has already computed, keyed by the exact triple
/// `should_block` was called with.
///
/// The engine answers a pure function of `(url, source, request_type)` — the same three
/// strings produce the same `matched` for as long as the engine is unchanged — so a
/// repeat query can be answered without re-running the match. Measured on this box,
/// that match is ~284 us for a non-blocked URL and ~130 us for a blocked one, while the
/// channel round-trip around it is ~9 us: the match is ~97% of the cost, so skipping it
/// is nearly the whole win.
///
/// Lives INSIDE the engine thread on purpose. That makes it `Send`-free (no lock, no
/// atomic), gives it exactly one writer, and lets it be dropped in the one place the
/// engine can change: `Msg::Reload`. It is deliberately NOT in the callers — a
/// caller-side memo would still pay the round-trip to learn whether a reload had
/// happened, and two callers would need to agree on invalidation.
struct VerdictCache {
    map: HashMap<(String, String, String), bool>,
}

impl VerdictCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
        }
    }

    fn get(&self, key: &(String, String, String)) -> Option<bool> {
        self.map.get(key).copied()
    }

    fn put(&mut self, key: (String, String, String), blocked: bool) {
        if self.map.len() >= VERDICT_CACHE_MAX {
            self.map.clear();
        }
        self.map.insert(key, blocked);
    }

    /// Forget every memoised verdict. Called only when the engine is replaced.
    fn clear(&mut self) {
        self.map.clear();
    }
}

/// Every URL the engine thread has actually run a match for, in test builds only.
///
/// Keyed by URL rather than counted globally on purpose: a bare counter would be moved
/// by every OTHER test that calls `should_block`, and this suite runs in parallel, so a
/// delta assertion on a shared counter is a flake waiting to happen. A per-URL tally is
/// immune to that, because no other test queries this URL.
#[cfg(test)]
static MATCHED_URLS: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[cfg(test)]
fn record_match(url: &str) {
    MATCHED_URLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(url.to_string());
}

/// Test seam: how many times the engine ran a real match for `url` (cache misses only).
#[cfg(test)]
pub fn match_count_for(url: &str) -> usize {
    MATCHED_URLS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter(|u| u.as_str() == url)
        .count()
}

static TX: OnceLock<Sender<Msg>> = OnceLock::new();

fn tx() -> &'static Sender<Msg> {
    TX.get_or_init(|| {
        let (tx, rx) = channel::<Msg>();
        std::thread::spawn(move || {
            let mut engine = build_engine(&[]);
            // Owned by this thread, so it needs no synchronisation and can only be
            // invalidated here.
            let mut cache = VerdictCache::new();
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
                            // The key is built once and used for both the lookup and the
                            // store, so a hit costs three small allocations (~100 ns)
                            // against a ~284 us match it avoids.
                            let key = (q.url.clone(), q.source.clone(), q.rtype.clone());
                            let blocked = match cache.get(&key) {
                                Some(known) => known,
                                None => {
                                    let b = match Request::new(&q.url, &q.source, &q.rtype) {
                                        Ok(req) => {
                                            #[cfg(test)]
                                            record_match(&q.url);
                                            engine.check_network_request(&req).matched
                                        }
                                        // Fail open: an unparseable URL is allowed, and is
                                        // memoised as such because re-parsing it would
                                        // fail the same way every time.
                                        Err(_) => false,
                                    };
                                    cache.put(key, b);
                                    b
                                }
                            };
                            let _ = q.reply.send(Verdict {
                                seq: q.seq,
                                blocked,
                            });
                        }
                        // Rebuild the FilterSet + Engine in place on this thread (the only
                        // place the !Send Engine can be replaced). Take the pending texts
                        // and clear the "queued" flag FIRST, so a reload that arrives while
                        // this one is building still queues its own rebuild rather than
                        // being folded into this one and lost.
                        Msg::Reload => {
                            let extra = std::mem::take(
                                &mut *PENDING_RELOAD.lock().unwrap_or_else(|e| e.into_inner()),
                            );
                            PENDING_QUEUED.store(false, Ordering::Release);
                            #[cfg(test)]
                            REBUILDS.fetch_add(1, Ordering::Relaxed);
                            engine = build_engine(&extra);
                            // The engine just changed, so every memoised verdict is stale.
                            // Placed AFTER the assignment on purpose: `build_engine` can
                            // panic, and if it does the old engine (and this cache) are
                            // still a valid pair.
                            cache.clear();
                        }
                    }
                }));
                if outcome.is_err() {
                    eprintln!(
                        "[aegis-adblock] engine panic recovered; keeping the previous engine"
                    );
                    // A Query that panicked never reached its `reply.send`, so its caller
                    // would otherwise block until QUERY_TIMEOUT. Fail open explicitly.
                    if let Msg::Query(q) = &msg {
                        let _ = q.reply.send(Verdict {
                            seq: q.seq,
                            blocked: false,
                        });
                    }
                }
            }
        });
        tx
    })
}

/// Rebuild the engine's FilterSet from the bundled lists + `extra_lists` (the enabled
/// subscriptions' text + the user's custom filters) so a filter change takes effect on
/// Windows/macOS/Android (which otherwise never re-read them after boot). Non-blocking, and
/// **coalescing**: a burst of requests collapses into one rebuild from the most recent state
/// (see the body). The FIFO channel still guarantees the next query sees the rebuilt engine.
/// Called from `adblock_refresh::refresh`. (Linux's declarative WebKit tier reloads
/// separately.)
pub fn reload_lists(extra_lists: Vec<String>) {
    // Coalesce, don't queue. `Msg::Reload` is FIFO on the SAME channel as `Msg::Query`,
    // so N queued reloads means N full EasyList re-parses sitting in front of every
    // in-flight query — and a query that waits out `QUERY_TIMEOUT` there fails OPEN,
    // which is a real under-block, not just a slow test. A user who toggles a filter,
    // edits a custom filter and updates a subscription in quick succession (or a sync
    // that touches several stores) must cost ONE rebuild, not one per call.
    //
    // "Last write wins": the newest `extra` overwrites the pending one, and the engine
    // rebuilds once from it. `PENDING` doubles as the "a reload is already queued" flag,
    // so the steady state costs one atomic swap and allocates nothing.
    PENDING_RELOAD
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone_from(&extra_lists);
    if PENDING_QUEUED.swap(true, Ordering::AcqRel) {
        return; // one is already in the channel; it will pick up the value above
    }
    let _ = tx().send(Msg::Reload);
}

/// The `extra` list texts for a reload that has not been picked up by the engine thread
/// yet, plus the flag saying a `Msg::Reload` is already in the channel.
static PENDING_RELOAD: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PENDING_QUEUED: AtomicBool = AtomicBool::new(false);

/// How many rebuilds the engine thread has actually performed. Test-only: it is what makes
/// "a burst costs ONE rebuild" an assertion instead of a claim, since the only externally
/// visible effect of coalescing is that fewer rebuilds happen.
#[cfg(test)]
static REBUILDS: AtomicU64 = AtomicU64::new(0);

/// The number of rebuilds performed so far (test-only helper).
#[cfg(test)]
fn rebuild_count() -> u64 {
    REBUILDS.load(Ordering::Relaxed)
}

// Whether the most recent `should_block` on this thread gave up because the engine did not
// answer, rather than because the engine answered `false`.
//
// Both are the same `bool` to a caller, and telling them apart is what lets a test wait for
// the engine to become RESPONSIVE without waiting for it to change its MIND. It is the
// difference between "the engine says allow this" (a verdict — retrying cannot help) and "the
// engine is still busy" (no verdict — retrying is the only thing that helps). A test that
// cannot see the difference has to retry until a deadline, which is both slow and wrong: it
// reports a false failure whenever the answer really is `false`, and it cannot stop early when
// the answer is `true`.
//
// THREAD-LOCAL on purpose, and that is load-bearing rather than tidiness: a query's verdict
// is per-thread (`REPLY` above is a `thread_local!` channel, one per calling thread), so the
// flag that describes that verdict has to be per-thread too. As a plain `static` it was a
// cross-thread bug: an unrelated test thread's `should_block` — anything not holding
// `test_support::lock()` — cleared the flag between one thread's timeout and its own read of
// it, so that thread concluded "the engine answered" with a `false` that was really a fail-open
// timeout, and the warm-up gave up instantly. It reproduced as `a_late_reply_...` and
// `the_unanswered_flag_...` both failing their warm-up in the FULL suite while passing in
// isolation.
//
// (`//` rather than `///` on purpose: a doc comment cannot attach to a `thread_local!`
// macro invocation, so clippy reports it as an unused doc comment.)
#[cfg(test)]
thread_local! {
    static LAST_QUERY_UNANSWERED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Record that the last `should_block` failed to get a verdict. Compiled out entirely in a
/// release build, so the flag costs nothing in production.
#[cfg(test)]
fn mark_query_unanswered() {
    LAST_QUERY_UNANSWERED.with(|unanswered| unanswered.set(true));
}

#[cfg(not(test))]
#[inline]
fn mark_query_unanswered() {}

/// Whether the last `should_block` on this thread timed out instead of returning a verdict.
#[cfg(test)]
fn last_query_was_unanswered() -> bool {
    LAST_QUERY_UNANSWERED.with(|unanswered| unanswered.get())
}

/// Whether a subresource request to `url`, made by the page at `source_url` (with a
/// best-effort `request_type` such as "script"/"image"/"document"), should be
/// blocked. Honors the on/off toggle and per-page-host allowlist; fails open on any
/// error, so ad-blocking never breaks a page.
pub fn should_block(url: &str, source_url: &str, request_type: &str) -> bool {
    // Cleared up front, before every return path below, so a caller can never read a flag
    // left over from a previous call on this thread.
    #[cfg(test)]
    LAST_QUERY_UNANSWERED.with(|unanswered| unanswered.set(false));
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
    // Android). Each call sends exactly one Query then immediately recvs its one reply.
    //
    // The `seq` is what makes that safe beyond the happy path. A bare `bool` channel only
    // carries ONE in-flight reply as long as NOTHING ever times out; on a timeout the
    // engine thread has not replied yet, so the reply lands AFTER we stopped looking, and
    // the next `should_block` on this thread would read it and answer a DIFFERENT request
    // with the previous one's verdict. (Draining in the timeout arm cannot fix that — the
    // channel is still empty at that instant, so the drain is a no-op.) Tagging the answer
    // makes the leftover harmless: it is received, recognised as not-ours, and dropped.
    REPLY.with(|(reply, answer)| {
        let seq = next_seq();
        let q = Query {
            url: url.to_owned(),
            source: source_url.to_owned(),
            rtype: request_type.to_owned(),
            reply: reply.clone(),
            seq,
        };
        if tx().send(Msg::Query(q)).is_err() {
            mark_query_unanswered();
            return false;
        }
        // Bounded wait. `Msg` is FIFO on ONE channel, so a `Msg::Reload` (any filter
        // toggle, custom-filter edit or subscription update) makes every in-flight
        // `should_block` queue behind a full EasyList re-parse. Unbounded, that froze the
        // GTK main thread — `should_block` is called from `nav::decide_navigation` for
        // every subresource, so 40 iframes x a filter edit meant 40 serialized stalls.
        // Timing out fails OPEN (the request is allowed), so the worst case is that a
        // filter edit briefly under-blocks instead of hanging the window.
        //
        // The deadline is on the WHOLE wait, not per-reply: a late reply from an earlier
        // call is skipped inside the same budget rather than extending it.
        let deadline = Instant::now() + QUERY_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match answer.recv_timeout(left) {
                Ok(v) if v.seq == seq => return v.blocked,
                // Someone else's answer (see the `seq` note above). Drop it and keep
                // waiting for ours.
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => {
                    mark_query_unanswered();
                    return false;
                } // fail open
                // The engine thread is gone (disconnected). It cannot recover itself, so
                // just fail open — same as a dead filter engine, and far better than
                // blocking.
                Err(RecvTimeoutError::Disconnected) => {
                    mark_query_unanswered();
                    return false;
                }
            }
        }
    })
}

/// Per-thread-monotonic id stamped on each `Query` and echoed in its `Verdict`.
///
/// This is `Relaxed` and therefore NOT a unique id across threads — it only has to
/// distinguish consecutive queries *on one thread's reply channel*, and each thread has
/// its own channel, so a per-thread counter is sufficient and allocation-free.
fn next_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

thread_local! {
    /// Per-thread reusable reply channel for `should_block` (see its body for why this is
    /// safe: strictly one send → one recv per call). Created lazily on first use.
    static REPLY: (Sender<Verdict>, Receiver<Verdict>) = channel();
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
    use super::{
        is_unwanted_popup, last_query_was_unanswered, mark_query_unanswered, match_count_for,
        rebuild_count, reload_lists, set_policy, should_block, Duration, Verdict, REPLY,
    };

    // A URL no other test queries, so the per-URL match tally belongs to this test alone
    // and cannot be moved by a parallel test (see `MATCHED_URLS`).
    const CACHE_PROBE_URL: &str = "https://cache-probe.example/assets/only-me-7f3a.js";
    const CACHE_PROBE_PAGE: &str = "https://cache-probe.example/page";

    // Counts MATCHES, not calls — the whole point of the cache is that a repeat call is
    // answered without touching the engine, so a counter on `should_block` itself would
    // count the very thing being optimised away.
    //
    // The assertion is `<= 1`, not `== 1`: the cache is process-global and outlives this
    // test, so the first of the five calls may legitimately already be a hit. Five
    // identical calls that produce at most one match is the property; without the cache
    // they produce exactly five.
    #[test]
    fn repeated_queries_are_answered_without_re_running_the_engine_match() {
        let _guard = crate::test_support::lock();
        let before = match_count_for(CACHE_PROBE_URL);
        for _ in 0..5 {
            let _ = should_block(CACHE_PROBE_URL, CACHE_PROBE_PAGE, "other");
        }
        let matches = match_count_for(CACHE_PROBE_URL) - before;
        assert!(
            matches <= 1,
            "five identical queries ran the engine match {matches} times; the verdict cache \
             is not being consulted"
        );
    }

    // Without this the cache would be a correctness bug, not an optimisation: a user who
    // edits a filter list would keep getting the pre-edit verdict for every URL already
    // seen, and the list would appear to do nothing until the app restarted.
    #[test]
    fn a_filter_reload_invalidates_every_memoised_verdict() {
        let _guard = crate::test_support::lock();
        // Warm the cache for this URL, and assert it is genuinely cached first, so a
        // failure below cannot be mistaken for the cache never having engaged.
        let _ = should_block(CACHE_PROBE_URL, CACHE_PROBE_PAGE, "other");
        let warm = match_count_for(CACHE_PROBE_URL);
        let _ = should_block(CACHE_PROBE_URL, CACHE_PROBE_PAGE, "other");
        assert_eq!(
            match_count_for(CACHE_PROBE_URL),
            warm,
            "precondition: the repeat query must be a cache hit, or this test proves nothing"
        );

        // Add a filter that blocks the probe URL, exactly as a user's edit would.
        reload_lists(vec![
            "||cache-probe.example/assets/only-me-7f3a.js^".to_string()
        ]);

        let blocked_now = should_block(CACHE_PROBE_URL, CACHE_PROBE_PAGE, "other");
        assert!(
            blocked_now,
            "a freshly added filter must take effect on a URL whose old verdict was cached"
        );
        assert!(
            match_count_for(CACHE_PROBE_URL) > warm,
            "the post-reload query must have re-run the match, i.e. the cache was cleared"
        );
        // Leave the process-wide engine as we found it for the other tests.
        reload_lists(vec![]);
    }

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
    /// Block until the engine thread actually returns a verdict for `(url, source, rtype)`,
    /// or `ENGINE_WARM_DEADLINE` elapses. Returns the last answer, so `false` is a real
    /// "the engine did not block this" and the caller's `assert!` is what reports it.
    ///
    /// Retry is driven by `last_query_was_unanswered`, NOT by "the answer was `false`".
    /// Those are different situations and the difference is the whole point:
    /// `should_block` reports both as the same `bool`, so a helper that retries on `false`
    /// cannot tell "the engine says allow this" from "the engine is still re-parsing", and
    /// has to spin until its deadline. That is how this helper failed CI run 36631144042:
    /// the `rust` job's `cargo test` step passed 643/643 uninstrumented, and then the
    /// `cargo llvm-cov` step failed all three tests that wait on the engine, because under
    /// instrumentation the engine answered late enough for the busy loop to burn its whole
    /// 30 s deadline. Spinning also floods the engine thread with a query per iteration,
    /// which is the opposite of what a "wait for it to settle" helper should do.
    ///
    /// So: retry only while there is no verdict yet, stop the instant there is one, and
    /// sleep between attempts so a retry cannot outrun the engine it is waiting for. A
    /// `false` verdict is a real answer and is returned immediately — the caller's
    /// `assert!` then fails at once, and with the engine's own reason rather than after a
    /// pointless 30 s.
    fn wait_until_engine_blocks(url: &str, source: &str, rtype: &str) -> bool {
        wait_until_engine_blocks_for(url, source, rtype, Duration::from_secs(30))
    }

    /// `wait_until_engine_blocks` with the deadline exposed, so the timeout path is
    /// testable without a 30 s test.
    fn wait_until_engine_blocks_for(
        url: &str,
        source: &str,
        rtype: &str,
        deadline: Duration,
    ) -> bool {
        let started = std::time::Instant::now();
        loop {
            let blocked = should_block(url, source, rtype);
            if blocked || !last_query_was_unanswered() {
                return blocked;
            }
            if started.elapsed() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Ask the engine for its decision about `(url, source, rtype)` and return that
    /// decision — retrying only while the engine has not answered at all.
    ///
    /// This is the primitive every assertion about engine behaviour should use, and the
    /// reason is the same one above: a bare `should_block` cannot tell the caller whether
    /// its `false` is "allow this" or "the engine never answered", and a *negative*
    /// assertion cannot tell at all — a fail-open timeout looks exactly like the verdict
    /// it hoped for, so such a test passes for the wrong reason. A positive assertion is
    /// merely flaky on the same input. That is not theoretical: with the warm-up alone,
    /// `blocks_ads_and_honors_toggle_and_allowlist` still failed once on
    /// "a known ad/tracker domain must be blocked" at line 741, because
    /// `a_burst_of_reload_requests_ends_on_the_last_one` runs first and its final
    /// `reload_lists` was still in flight — a rebuild the warm-up cannot cover, since it
    /// can land *after* the warm-up's answer. The assertion then queued behind a ~20 MB
    /// parse and failed open. A warm-up is a precondition, not a guarantee; only asking
    /// for a verdict is a guarantee.
    fn verdict_of(url: &str, source: &str, rtype: &str) -> bool {
        let started = std::time::Instant::now();
        let deadline = Duration::from_secs(30);
        loop {
            let blocked = should_block(url, source, rtype);
            // `blocked` short-circuits the `!`, so a `true` is returned even if the flag is
            // somehow still set: a positive answer is never ambiguous.
            if blocked || !last_query_was_unanswered() {
                return blocked;
            }
            if started.elapsed() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// THE REGRESSION TEST for the bug this file's `seq` protocol exists to prevent.
    ///
    /// A `should_block` that times out leaves its answer sitting in the thread's reused
    /// `REPLY` channel, because the engine thread has not sent it yet at the moment the
    /// caller stops waiting. Before the `seq` protocol, the NEXT `should_block` on this
    /// thread read that leftover and returned it — answering a *different request* with
    /// the *previous* one's verdict. The old "drain on timeout" was supposed to prevent
    /// this and could not: at timeout the channel is still empty, so `try_recv` found
    /// nothing to drain.
    ///
    /// The leftover is injected directly, which makes the interleaving deterministic
    /// instead of a 1-in-20 flake. A stale `true` for a host in no filter list MUST NOT be
    /// returned as the answer; on the pre-fix code this assertion fails.
    #[test]
    fn a_late_reply_from_a_timed_out_query_is_never_read_as_this_querys_answer() {
        let _guard = crate::test_support::lock();
        // Warm the engine so the query below is answered from a warm engine and cannot be
        // confused with a cold-start timeout.
        assert!(wait_until_engine_blocks(
            "https://adnxs.com/tag.js",
            "https://news.example.com",
            "script"
        ));
        // The exact leftover a timed-out query leaves behind: a `true` belonging to some
        // other request. `u64::MAX` can never collide with a real `next_seq()` value.
        REPLY.with(|(reply, _answer)| {
            let _ = reply.send(Verdict {
                seq: u64::MAX,
                blocked: true,
            });
        });
        // This host is in no filter list, so the honest answer is `false`. Reading the
        // stale verdict instead would return `true` — the pre-fix behaviour.
        assert!(
            !should_block(
                "https://stale-reply-probe.example/app.js",
                "https://site.example",
                "script"
            ),
            "a leftover verdict from a timed-out query must not answer this one"
        );
        // And the channel is still usable: the very next query gets its OWN answer, so the
        // drop loop does not swallow replies.
        assert!(should_block(
            "https://adnxs.com/tag.js",
            "https://news.example.com",
            "script"
        ));
    }

    /// The observable property `reload_lists`' coalescing must preserve: after a burst of
    /// reload requests, the engine reflects the LAST one. Coalescing collapses the burst
    /// into a single rebuild that reads the newest pending value, so a filter edit followed
    /// by a subscription update cannot leave the engine on the older list. Run this in a
    /// loop with the requests interleaved the worst way available — one landing while a
    /// previous rebuild is still in flight — because the "queued" flag is what decides
    /// whether a late request is dropped or re-queued, and getting that wrong silently
    /// loses the user's most recent filter list.
    #[test]
    fn a_burst_of_reload_requests_ends_on_the_last_one() {
        let _guard = crate::test_support::lock();
        assert!(wait_until_engine_blocks(
            "https://adnxs.com/tag.js",
            "https://news.example.com",
            "script"
        ));
        for round in 0..3 {
            let before = rebuild_count();
            // Fire a burst with NO waiting between requests — the case a real user makes by
            // toggling a filter, editing a custom filter and updating a subscription at once,
            // and the case a sync import makes. Every one of these used to cost a full
            // ~20 MB re-parse, all of them queued in front of every in-flight query.
            for i in 0..200 {
                reload_lists(vec![format!("||superseded-{i}.example^")]);
            }
            reload_lists(vec![format!("||coalesce-final-{round}.example^")]);
            // Wait for the engine to settle on the final value: the last request must win,
            // and the superseded ones must NOT linger (that is the coalescing's whole point).
            loop {
                if should_block(
                    &format!("https://coalesce-final-{round}.example/x"),
                    "https://site.example",
                    "script",
                ) {
                    break;
                }
            }
            // 201 requests, and the whole point is that they did NOT cost 201 rebuilds. A
            // handful is right: one for the request already in the channel when the burst
            // started, plus one for whatever arrived after the flag was cleared. Unbounded
            // growth here is the bug — each rebuild is a ~20 MB parse that every in-flight
            // `should_block` queues behind, which is how they time out and fail OPEN.
            let rebuilds = rebuild_count() - before;
            assert!(
                rebuilds <= 4,
                "a burst of 201 reload requests must collapse into a couple of rebuilds, \
                 not {rebuilds} (round {round})"
            );
            for i in [0usize, 100, 199] {
                assert!(
                    !should_block(
                        &format!("https://superseded-{i}.example/x"),
                        "https://site.example",
                        "script"
                    ),
                    "an earlier reload in the burst must not survive (round {round})"
                );
            }
        }
        reload_lists(vec![]);
    }

    /// The flag the warm-up helper reads is the whole reason it can tell "the engine said
    /// allow" from "the engine never answered", so the flag's contract is asserted directly
    /// rather than inferred from a slow run.
    ///
    /// `should_block` returns a bare `bool` and reports BOTH "allow" and "timed out" as
    /// `false`. Under `cargo llvm-cov` everything is far slower, so CI run 36631144042 had
    /// the engine miss a query's 5 s budget; the old helper could not distinguish that from
    /// a real verdict, so it kept retrying and burned its entire deadline. The flag makes
    /// the distinction observable. If the flag were not cleared at the top of
    /// `should_block`, a stale `true` would make the helper give up early and report a
    /// fail-open as a verdict — so that half is asserted too, not just the setting.
    #[test]
    fn the_unanswered_flag_distinguishes_a_real_verdict_from_a_timeout() {
        let _guard = crate::test_support::lock();
        // Warm up first: a `true` can only come from the engine actually deciding, so this
        // guarantees the calls below are ANSWERED rather than timing out — which is the
        // precondition for the flag assertions to mean anything.
        assert!(wait_until_engine_blocks(
            "https://adnxs.com/tag.js",
            "https://news.example.com",
            "script"
        ));
        // An answered query must leave the flag DOWN, or the helper would treat a real
        // `false` as a timeout and keep retrying (which is the run-36631144042 failure).
        should_block(
            "https://example.org/somewhere",
            "https://example.org/",
            "script",
        );
        assert!(
            !last_query_was_unanswered(),
            "an answered query must not report itself unanswered, or the helper would \\
             treat a real verdict as a timeout and keep retrying"
        );
        // Now the flag is raised, as a timeout raises it.
        mark_query_unanswered();
        assert!(
            last_query_was_unanswered(),
            "a query the engine never answered must be visible as such"
        );
        // And the NEXT query clears it, so a raised flag can never leak into a later
        // verdict. This is the stale-value half: without the clear at the top of
        // `should_block`, the helper would give up on the next call before the engine
        // ever spoke.
        should_block(
            "https://example.net/elsewhere",
            "https://example.net/",
            "script",
        );
        assert!(
            !last_query_was_unanswered(),
            "the following answered query must clear the flag, or the helper would give up \\
             on the next call before the engine ever spoke"
        );
    }

    /// The warm-up helper's job is to be impossible to fool. Vacuity control: pointed at a
    /// host in no filter list it must give up and report `false`, not spin forever or invent
    /// a `true`. Without this, the warm-up in the test below could be a no-op that always
    /// "succeeds".
    #[test]
    fn the_warm_up_helper_gives_up_on_a_host_no_list_blocks() {
        let _guard = crate::test_support::lock();
        assert!(
            !wait_until_engine_blocks_for(
                "https://warm-up-never-blocks.example/app.js",
                "https://site.example",
                "script",
                Duration::from_millis(300),
            ),
            "the helper must give up and report false on a host no list blocks"
        );
    }

    #[test]
    fn blocks_ads_and_honors_toggle_and_allowlist() {
        let _guard = crate::test_support::lock();
        // Wait until the engine genuinely answers BEFORE asserting anything.
        //
        // The first `should_block` in the process pays the one-time ~20 MB EasyList parse on
        // the engine thread, and that cost lands INSIDE the caller's `QUERY_TIMEOUT`, which
        // FAILS OPEN on expiry. Whichever test makes that first call is chosen by alphabetical
        // test order, so it is this one. Run 36447158645 failed the first assertion below here.
        //
        // A single throwaway warm-up query does NOT protect it, and that is measured, not
        // assumed. `should_block` is FIFO behind `Msg::Reload` on the ONE engine thread, so
        // a burst of filter/subscription edits queues full re-parses in front of it. A
        // `recv_timeout` expiry leaves the query still QUEUED, so the engine is *busy*, not
        // *warm*, and the very next query queues behind the same backlog and fails open too.
        // Probe result with 4 queued reloads and a 50 ms timeout: `warmup=false real=false
        // settled=false` — a warm-up buys nothing, which is why "1 failure in 20 runs,
        // always on this assertion" went unfixed. (`reload_lists` now coalesces, which
        // removes most of the backlog at its source, but the queue is still shared with
        // queries and the test must not depend on the backlog being empty.)
        //
        // So warm up on the assertion's OWN query and retry until it answers `true`. A blocking
        // verdict can only come from the engine actually deciding, which makes `true` an
        // unambiguous warm signal, and each attempt also advances the FIFO. Retrying cannot
        // manufacture a pass: if the engine never blocks this domain, every attempt fails open
        // and the assert below fires with the helper's `false`.
        let _ = wait_until_engine_blocks(
            "https://adnxs.com/tag.js",
            "https://news.example.com",
            "script",
        );
        // Default: on, empty allowlist. `||adnxs.com^` is an unconditional anchor in
        // the vendored EasyList; example.com is clean.
        assert!(
            verdict_of(
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
            verdict_of(
                "https://www.google-analytics.com/analytics.js",
                "https://news.example.com",
                "script"
            ),
            "an analytics tracker (EasyPrivacy) must be blocked"
        );
        assert!(
            verdict_of(
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
            verdict_of(
                "https://cupcake.limbycocking.cfd/banner.jpg",
                "https://streamex.sh/watch",
                "image"
            ),
            "a rotating .cfd malvertising domain must be blocked by the abuse-TLD list"
        );
        assert!(
            verdict_of(
                "https://1x39.r5zkgi2ufhmkn5ty2i.cfd/x",
                "https://streamex.sh/watch",
                "script"
            ),
            "any .cfd host must be blocked regardless of the random subdomain"
        );
        assert!(
            !verdict_of(
                "https://cfd.example.com/app.js",
                "https://example.com",
                "script"
            ),
            "a host that merely contains 'cfd' as a non-TLD label must NOT be blocked"
        );
        assert!(
            !verdict_of("https://example.com/", "https://example.com/", "document"),
            "a normal first-party page must not be blocked"
        );
        assert!(
            !verdict_of(
                "https://example.com/styles.css",
                "https://example.com/",
                "stylesheet"
            ),
            "a normal first-party asset must not be blocked"
        );
        // A pop-under (top-level document) to an ad domain is blocked too — this is
        // exactly what nav::on_new_window checks to drop ad pop-unders into nowhere.
        assert!(
            verdict_of(
                "https://adnxs.com/popunder",
                "https://news.example.com",
                "document"
            ),
            "an ad-domain pop-under (document) must be blocked"
        );
        assert!(
            !verdict_of(
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
            !verdict_of(
                "https://adnxs.com/tag.js",
                "https://news.example.com",
                "script"
            ),
            "with ad-block off, even ad domains are allowed"
        );

        // ON, page host allowlisted → ads allowed on that page, blocked elsewhere.
        set_policy(true, &["news.example.com".to_string()]);
        assert!(
            !verdict_of(
                "https://adnxs.com/tag.js",
                "https://news.example.com/article",
                "script"
            ),
            "ads on an allowlisted page must be allowed"
        );
        assert!(
            verdict_of(
                "https://adnxs.com/tag.js",
                "https://other.example.org/",
                "script"
            ),
            "ads on a non-allowlisted page must still block"
        );

        // Reset to default so nothing else sees a mutated engine.
        set_policy(true, &[]);
        assert!(verdict_of(
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
            verdict_of(
                "https://reloadtest.example/x",
                "https://site.example",
                "script"
            ),
            "a reloaded custom filter must take effect"
        );
        assert!(
            verdict_of(
                "https://adnxs.com/tag.js",
                "https://news.example.com",
                "script"
            ),
            "the bundled lists still apply after a reload"
        );
        // Reset the engine to the bundled-only lists so other tests don't see it blocked.
        reload_lists(vec![]);
        assert!(
            !verdict_of(
                "https://reloadtest.example/x",
                "https://site.example",
                "script"
            ),
            "after reloading without the custom filter, it no longer blocks"
        );
    }
}
