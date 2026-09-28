//! Blocks scripted (non-user-gesture) cross-origin top-frame redirects — the
//! anti-malvertising guard. The POLICY lives here once; each platform's native
//! nav-policy hook derives the inputs and calls in. See
//! The design spec that used to live at
//! `docs/superpowers/specs/2026-06-18-scripted-redirect-blocker-design.md` was deleted in
//! commit 58d2c4b and is not recoverable from this repo; everything it said about the
//! policy now lives in this header plus `src-tauri/AGENTS.md` (gotcha 14).
//!
//! A navigation is judged by WHO STARTED ITS CHAIN, not by the individual hop.
//! Malvertising commonly bounces the top frame through a redirect (e.g. streamex's
//! resize-detection script sends the tab to `google.com`, which 301s to
//! `www.google.com`). The destination hop carries `is_redirect=true`, so an
//! is_redirect short-circuit would wave it straight through. Instead we remember the
//! chain's first (non-redirect) hop — was it scripted? app-initiated? — and apply
//! that verdict to the final displayable navigation, however many redirect hops it
//! took. Legit redirect chains (a user-clicked OAuth/shortener bounce, or an
//! address-bar nav that the server redirects) stay allowed because their chain
//! ORIGIN was a user gesture or an app-initiated nav.
//!
//! # Which platforms wire a hook
//!
//! Linux calls `note_nav` + `decide_at_response` (two-phase: `NavigationAction` carries the
//! gesture/redirect flags, `ResponsePolicyDecision` carries reliable main-frame), Windows calls
//! `block_at_start` (top-frame `NavigationStarting` has both in one place), and Android calls
//! `should_block` through JNI. **macOS wires none of them** — there is no `nav_policy_mac.rs` —
//! so on that target only `expect` (from `nav.rs`) is reachable and the rest of this module is
//! inert. Rather than annotate a dozen items for a target that has no implementation, the allow
//! below is scoped to macOS; Linux, Windows and Android keep dead-code linting fully on.
//!
//! Note: `-D warnings` only surfaces one wave of diagnostics per run. While this module had
//! macOS *type* errors, rustc aborted before the late dead-code pass, so the macOS job reported
//! none of this — fixing those errors is what exposed it.
#![cfg_attr(target_os = "macos", allow(dead_code))]
use tauri::{AppHandle, Manager, Runtime, Url};

/// The core cross-origin test, exposed for Android's JNI hook (which has reliable
/// main-frame + gesture in one place and no redirect chains to track). `scripted`
/// = no user gesture; `main_frame` = top-frame navigation. (Desktop goes through the
/// chain-aware hooks instead, so this is only reached on Android + in tests.)
#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
pub fn should_block(current: &str, target: &str, scripted: bool, main_frame: bool) -> bool {
    scripted && main_frame && is_cross_origin_http(current, target)
}

/// Target must be http/https and a different origin (scheme+host+port) than the
/// current top document. Fails OPEN (returns false) on unparseable input.
fn is_cross_origin_http(current: &str, target: &str) -> bool {
    let (Ok(cur), Ok(tgt)) = (Url::parse(current), Url::parse(target)) else {
        return false;
    };
    if !matches!(tgt.scheme(), "http" | "https") {
        return false; // about:, data:, blob:, javascript:, mailto:, custom schemes
    }
    cur.origin() != tgt.origin()
}

use std::collections::HashMap;
use std::sync::Mutex;

/// One expected app-initiated target URL per tab. The app records the URL it is
/// about to navigate to (address bar, new tab, HTTPS upgrade, Open-anyway, restore)
/// BEFORE navigating; the decision phase consumes a match (against the chain's origin target)
/// so app navigations — and the redirect chains they trigger — are never blocked. Page-script
/// navigations never match.
#[derive(Default)]
pub struct PendingNavs(pub Mutex<HashMap<u32, String>>);

impl PendingNavs {
    /// Record (overwrite) the tab's one-shot expected target.
    pub fn expect(&self, tab: u32, url: &str) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(tab, url.to_string());
    }
    /// Consume the tab's expected target if `target` matches it. Returns true on match.
    pub fn take_if_match(&self, tab: u32, target: &str) -> bool {
        let mut m = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if m.get(&tab).is_some_and(|exp| same_target(exp, target)) {
            m.remove(&tab);
            return true;
        }
        false
    }
}

/// Equal up to fragment / trailing-slash differences (the engine may canonicalize
/// the URL it passes back into the policy hook).
fn same_target(a: &str, b: &str) -> bool {
    match (Url::parse(a), Url::parse(b)) {
        (Ok(x), Ok(y)) => {
            x.scheme() == y.scheme()
                && x.host_str() == y.host_str()
                && x.port_or_known_default() == y.port_or_known_default()
                && x.path().trim_end_matches('/') == y.path().trim_end_matches('/')
                && x.query() == y.query()
        }
        _ => a == b,
    }
}

/// The origin of a navigation chain: the trust inputs of its first (non-redirect) hop, carried
/// forward through every redirect hop. `from` is the document we are leaving (for the cross-origin
/// test); `origin_target` is the first hop's URL — what an app-initiated nav registered via
/// PendingNavs, matched at the decision point even when the server later redirects elsewhere;
/// `scripted` = the first hop had no user gesture. `app_initiated` is meaningful only on Windows
/// (`block_at_start` resolves it at the top-frame NavigationStarting); Linux leaves it `false`
/// here and resolves app-initiated in `decide_at_response` (the one-shot PendingNavs match must
/// happen once, at the committed Response — WebKit fires NavigationAction repeatedly).
#[derive(Clone)]
#[cfg_attr(target_os = "android", allow(dead_code))]
pub struct ChainStart {
    pub from: String,
    // Read only by Linux's `decide_at_response`, which matches PendingNavs against the chain's
    // ORIGIN target (the URL the app asked for) rather than the post-redirect `final_url`.
    // Windows' `block_at_start` matches against `target` directly at each hop instead.
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    pub origin_target: String,
    pub scripted: bool,
    // Read only on Windows (`block_at_start`); Linux resolves app-initiated in `decide_at_response`.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub app_initiated: bool,
}

/// Per-tab record of the in-flight navigation chain's origin: seeded at a non-redirect hop
/// (`note_nav` / `block_at_start`), read by redirect hops (`chain_origin`) so they inherit the
/// origin, and cleared when the top-frame load resolves (`clear_chain`).
#[derive(Default)]
pub struct Chains(pub Mutex<HashMap<u32, ChainStart>>);

/// The core block predicate: a scripted, non-app-initiated navigation that crosses origin from
/// where its chain started. User-gesture (`scripted=false`) and app-initiated chains pass.
pub fn should_block_pred(scripted: bool, from: &str, target: &str, app_initiated: bool) -> bool {
    scripted && !app_initiated && is_cross_origin_http(from, target)
}

/// Record a chain for the given navigation, keyed by (tab, target) so the Response phase can look
/// it up. A non-redirect hop seeds `Chains[tab]` so a later redirect hop inherits the chain's
/// origin. The `app_initiated` field is left unresolved here (false) — it is resolved ONCE, at the
/// decision point, because WebKit fires `NavigationAction` repeatedly (and for subframes) and the
/// PendingNavs match is one-shot. Used by Linux's two-phase hook (`decide_at_response` decides).
#[cfg_attr(target_os = "android", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))] // Linux-only phase; Windows uses `block_at_start`.
pub fn note_nav<R: tauri::Runtime>(
    app: &AppHandle<R>,
    tab: u32,
    from: &str,
    target: &str,
    scripted: bool,
    is_redirect: bool,
    main_frame: bool,
) {
    let chain = if is_redirect {
        chain_origin(app, tab).unwrap_or(ChainStart {
            from: from.to_string(),
            origin_target: target.to_string(),
            scripted,
            app_initiated: false,
        })
    } else {
        let c = ChainStart {
            from: from.to_string(),
            origin_target: target.to_string(),
            scripted,
            app_initiated: false,
        };
        if let Some(s) = app.try_state::<Chains>() {
            s.0.lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(tab, c.clone());
        }
        c
    };
    record_action(app, tab, target, chain, main_frame);
}

/// Linux Response phase: decide whether to CANCEL `final_url`, returning `Some(from)` to block.
/// Resolves app-initiated HERE — consuming the one-shot PendingNavs match against the chain's
/// ORIGIN target (the URL the app asked for, which differs from `final_url` when the server
/// redirected). Doing it at the single committed Response (not per NavigationAction) makes it
/// robust to WebKit firing NavigationAction several times for one navigation.
#[cfg_attr(target_os = "android", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))] // Linux's committed-Response phase; Windows decides at NavigationStarting.
pub fn decide_at_response(app: &AppHandle, tab: u32, final_url: &str) -> Option<String> {
    let chain = take_action(app, tab, final_url)?;
    let app_initiated = app
        .try_state::<PendingNavs>()
        .is_some_and(|p| p.take_if_match(tab, &chain.origin_target));
    should_block_pred(chain.scripted, &chain.from, final_url, app_initiated).then_some(chain.from)
}

/// Windows NavigationStarting phase (top-frame only, fires once per hop): decide whether to
/// CANCEL `target`, returning `Some(from)` to block. Resolves app-initiated at the non-redirect
/// hop (consuming the PendingNavs match) and stores the verdict so a following redirect hop
/// inherits it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn block_at_start<R: tauri::Runtime>(
    app: &AppHandle<R>,
    tab: u32,
    from: &str,
    target: &str,
    scripted: bool,
    is_redirect: bool,
) -> Option<String> {
    let chain = if is_redirect {
        chain_origin(app, tab).unwrap_or_else(|| {
            let app_initiated = app
                .try_state::<PendingNavs>()
                .is_some_and(|p| p.take_if_match(tab, target));
            ChainStart {
                from: from.to_string(),
                origin_target: target.to_string(),
                scripted,
                app_initiated,
            }
        })
    } else {
        let app_initiated = app
            .try_state::<PendingNavs>()
            .is_some_and(|p| p.take_if_match(tab, target));
        let c = ChainStart {
            from: from.to_string(),
            origin_target: target.to_string(),
            scripted,
            app_initiated,
        };
        if let Some(s) = app.try_state::<Chains>() {
            s.0.lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(tab, c.clone());
        }
        c
    };
    should_block_pred(chain.scripted, &chain.from, target, chain.app_initiated)
        .then_some(chain.from)
}

/// The in-flight chain origin for a redirect hop, if one was recorded for this tab.
pub fn chain_origin<R: tauri::Runtime>(app: &AppHandle<R>, tab: u32) -> Option<ChainStart> {
    Some(
        app.try_state::<Chains>()?
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&tab)?
            .clone(),
    )
}

/// Drop a tab's in-flight chain once its top-frame load resolves.
#[cfg_attr(target_os = "android", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))] // Linux clears the chain at its Response; Windows never seeds one it must clear.
pub fn clear_chain<R: Runtime>(app: &AppHandle<R>, tab: u32) {
    if let Some(s) = app.try_state::<Chains>() {
        s.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&tab);
    }
}

/// Record an app-initiated navigation so the guard won't block it (or its redirects).
pub fn expect<R: Runtime>(app: &AppHandle<R>, tab: u32, url: &str) {
    if let Some(s) = app.try_state::<PendingNavs>() {
        s.expect(tab, url);
    }
}

/// Admission control for [`on_blocked_redirect_to_new_tab`].
///
/// Extracted from that function so the decision is unit-testable without an `AppHandle` — the
/// function's only other effect is spawning a timer thread, which a test cannot observe.
///
/// The [`Clone`] is load-bearing, not convenience: the auto-close timer runs on a `'static`
/// thread, and `tauri::State<'r, T>`'s own clone keeps the `'r` borrow of the `AppHandle`, so
/// the state itself cannot be moved into the thread. Cloning out the `Arc` gives a handle with
/// no borrow, which can.
#[derive(Clone, Default)]
pub struct RedirectBudget(std::sync::Arc<std::sync::Mutex<RedirectBudgetInner>>);

#[derive(Default)]
struct RedirectBudgetInner {
    /// `(from, to)` pairs this guard already acted on, with the time it did so.
    recent: std::collections::HashMap<(String, String), std::time::Instant>,
    /// Tabs this guard opened and has not yet released (auto-closed, or the user closed it).
    live: std::collections::HashSet<u32>,
}

/// How many redirect-opened background tabs may be live at once.
///
/// The 30 s auto-close timer is what makes a count a sound bound rather than a rate: a tab
/// occupies its slot for at most 30 s, so this caps the concurrent tab count without
/// rate-limiting the user. Three leaves room for a page that genuinely bounces the user through
/// a couple of ad hops while still making an unbounded loop impossible.
pub const MAX_LIVE_REDIRECT_TABS: usize = 3;

/// How long a `(from, to)` pair stays "already handled" after the guard acts on it.
///
/// Must be ≥ the 30 s auto-close timer, or a loop running slower than the timer would re-open
/// the same destination on every cycle, forever. It is deliberately longer than the timer so a
/// second hop to the same destination is still refused after the first tab auto-closed.
pub const REDIRECT_DEDUP_WINDOW: std::time::Duration = std::time::Duration::from_secs(120);

impl RedirectBudget {
    fn inner(&self) -> std::sync::MutexGuard<'_, RedirectBudgetInner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether a hop from `from` to `to` should open a background tab right now.
    ///
    /// Two independent refusals, because key dedup alone does not bound anything: a loop that
    /// visits a fresh destination each time has all-distinct keys, and a loop that reuses one
    /// key is what the dedup catches.
    ///  - **Already handled** within [`REDIRECT_DEDUP_WINDOW`]. The window is longer than the
    ///    30 s auto-close, so a slow loop is still refused on its second pass.
    ///  - **No live slot** in [`MAX_LIVE_REDIRECT_TABS`]. The auto-close timer returns every
    ///    slot unconditionally (whether or not it actually closed the tab), so this cannot
    ///    ratchet shut after the user closes a tab by hand.
    ///
    /// The check and the key record happen under one lock, so a concurrent repeat of the same
    /// hop cannot both slip through. The slot is claimed separately, by `occupy`, because the
    /// tab id does not exist until `open_redirect_background` returns — so N genuinely
    /// simultaneous *distinct*-key hops can transiently exceed the cap by N-1. That overshoot is
    /// bounded by the thread count, not by anything the page controls.
    pub fn admit(&self, from: &str, to: &str) -> bool {
        let now = std::time::Instant::now();
        let mut g = self.inner();
        // Expire first, or `recent` grows for the life of the process.
        g.recent.retain(|_, at| {
            now.checked_duration_since(*at)
                .is_some_and(|d| d < REDIRECT_DEDUP_WINDOW)
        });
        let key = (from.to_string(), to.to_string());
        if g.recent.contains_key(&key) {
            return false;
        }
        if g.live.len() >= MAX_LIVE_REDIRECT_TABS {
            return false;
        }
        g.recent.insert(key, now);
        true
    }

    /// Record that tab `id` is now live, occupying one of the budget's slots.
    pub fn occupy(&self, id: u32) {
        self.inner().live.insert(id);
    }

    /// Give `id`'s slot back. Called from the auto-close timer, and safe to call twice.
    pub fn release(&self, id: u32) {
        self.inner().live.remove(&id);
    }
}

/// When a redirect would be blocked, open the destination in a new background tab.
/// If the user hasn't activated (viewed) that tab within 30 seconds, it is
/// automatically closed — preventing a blocked redirect from silently accumulating
/// background tabs the user never intended to visit.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn on_blocked_redirect_to_new_tab(app: &AppHandle, _tab: u32, from: &str, to: &str) {
    let Some(budget) = app.try_state::<RedirectBudget>() else {
        return;
    };
    if !budget.admit(from, to) {
        return;
    }
    let new_id = crate::tabs::open_redirect_background(app, to, false);
    budget.occupy(new_id);
    let app = app.clone();
    // `budget` is a `State<'_, _>`; clone the `Arc` out of it so the timer thread gets a handle
    // with no borrow of `app` (see `RedirectBudget`'s doc).
    let budget: RedirectBudget = (*budget).clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        // Only close if the tab still exists AND hasn't been activated (i.e. the
        // user never switched to it). Once activated, background_creation is cleared
        // and the tab becomes a normal tab the user chose to keep.
        //
        // The registry read is safe here: it is lock-protected plain state, no engine
        // object involved. The CLOSE is not — see below.
        let should_close = {
            let tabs = app.try_state::<crate::tabs::Tabs>();
            match tabs {
                None => false,
                Some(t) => {
                    let reg = t.reg.lock().unwrap_or_else(|e| e.into_inner());
                    // The tab must still exist and still be marked as background-created
                    // (never activated by the user).
                    reg.is_background_tab(new_id) && reg.active_id() != new_id
                }
            }
        };
        if should_close {
            // `close_tab` reaches `Webview::close()`, the window-layout bookkeeping
            // (`linux_layout::remove_webview_label`, which touches the native window's
            // GtkOverlay) and `view::apply_inset` (which sets webview bounds). All of
            // those are main-thread-only on EVERY platform — on Linux the WebKitGTK
            // objects behind them are not `Send` at all, so calling them from a worker
            // thread is undefined behaviour, not merely a warning. WebView2 is STA and
            // WKWebView is main-thread-only for the same reason.
            //
            // So hop to the main thread for the engine work, exactly as
            // `decide_navigation`'s pop-under auto-close does. The registry read above
            // deliberately stays on this thread: it is plain state under a mutex, and
            // keeping it here means the decision is still made at wake time.
            let app_close = app.clone();
            let _ = app.run_on_main_thread(move || {
                crate::tabs::close_tab(&app_close, new_id);
            });
        }
        // Released OUTSIDE the hop on purpose: if the event loop is already gone
        // (shutdown) `run_on_main_thread` refuses the closure and the tab is never
        // closed — the redirect budget slot must still come back, or a burst of
        // redirects during teardown would wedge the budget for the next launch.
        budget.release(new_id);
    });
}

/// Linux two-phase correlation: the gesture/redirect type live on `NavigationAction`,
/// but reliable main-frame detection lives on `ResponsePolicyDecision`. We record the
/// resolved `ChainStart` for each NavigationAction by (tab, normalized-url), then look
/// it up at the (main-frame) Response. Linux-only — the other platforms get gesture +
/// main-frame in one place.
///
/// The value carries the recording NavigationAction's main-frame flag. A subframe shares the
/// tab id with the main frame, so without this a subframe to the same normalized URL would
/// either overwrite the main frame's entry or be CONSUMED by the main-frame Response lookup —
/// and a consumed entry means `decide_at_response` returns `None`, i.e. the guard FAILS OPEN
/// for a navigation it was supposed to police. Subframe entries are never consumed and never
/// overwrite a main-frame one; `clear_tab` drops them.
#[derive(Default)]
#[cfg_attr(target_os = "android", allow(dead_code))]
// The Linux (tab, url) -> action correlation map. Registered unconditionally in lib.rs so the
// state shape is identical everywhere, but only the Linux two-phase path ever reads it.
#[cfg_attr(target_os = "windows", allow(dead_code))]
pub struct NavActions(pub Mutex<HashMap<(u32, String), (ChainStart, bool)>>);

/// Normalize a URL into a stable correlation key (ignore fragment / trailing slash, since the
/// NavigationAction target and the Response URL can differ in those).
#[cfg_attr(target_os = "android", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))] // Linux correlation key; Windows has one signal, not two to correlate.
fn norm_key(url: &str) -> String {
    match Url::parse(url) {
        Ok(u) => format!(
            "{}://{}:{}{}?{}",
            u.scheme(),
            u.host_str().unwrap_or(""),
            u.port_or_known_default()
                .map(|p| p.to_string())
                .unwrap_or_default(),
            u.path().trim_end_matches('/'),
            u.query().unwrap_or(""),
        ),
        _ => url.to_string(),
    }
}

/// Record the `ChainStart` to apply at the Response for `target` (Linux two-phase).
/// `main_frame` is the recording `NavigationAction`'s frame flag.
#[cfg_attr(target_os = "android", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))] // Linux-only; only `note_nav` (Linux) records.
pub fn record_action<R: tauri::Runtime>(
    app: &AppHandle<R>,
    tab: u32,
    target: &str,
    chain: ChainStart,
    main_frame: bool,
) {
    if let Some(s) = app.try_state::<NavActions>() {
        let key = (tab, norm_key(target));
        let mut m = s.0.lock().unwrap_or_else(|e| e.into_inner());
        // A subframe must not clobber a main-frame entry that is still awaiting its Response.
        if !main_frame && m.get(&key).is_some_and(|(_, mf)| *mf) {
            return;
        }
        m.insert(key, (chain, main_frame));
    }
}

/// Take the recorded main-frame `ChainStart` matching `target` for `tab`, if any.
///
/// A subframe entry under the same key is deliberately LEFT IN PLACE and reported as no match:
/// consuming it would strip the main frame's decision (fail-open), and this is only ever called
/// from the main-frame Response path, so `None` is the correct answer for a subframe-only key.
#[cfg_attr(target_os = "android", allow(dead_code))]
#[cfg_attr(target_os = "windows", allow(dead_code))] // Linux-only; only `decide_at_response` (Linux) consumes.
pub fn take_action(app: &AppHandle, tab: u32, target: &str) -> Option<ChainStart> {
    let s = app.try_state::<NavActions>()?;
    let key = (tab, norm_key(target));
    let mut m = s.0.lock().unwrap_or_else(|e| e.into_inner());
    match m.get(&key) {
        Some((_, true)) => m.remove(&key).map(|(c, _)| c),
        _ => None,
    }
}

/// Drop a tab's recorded NavigationActions, so subframe entries that never matched a
/// main-frame Response don't accumulate.
///
/// Called from TWO places, because neither alone bounds the map on every platform:
///
/// * `linux_layout`'s top-frame main-resource Response path — the subframe case this was
///   written for. It fires far more often and also clears cross-navigation staleness within
///   a still-open tab.
/// * `tabs::forget_closed_tab`, on tab close, which is the ONLY cleanup reachable on
///   Windows, Android and macOS.
///
/// **The two former `#[cfg_attr(…, allow(dead_code))]` attributes on this function were false
/// claims and are removed** — but the reason they were false is NOT the one a grep suggests,
/// and getting this wrong cost three revisions of this comment.
///
/// A grep for `record_action`'s callers looks damning: it is reached from `expect()`, and
/// `expect()` is called from the `#[cfg(desktop)]` `navigate_tab` / `decide_navigation` /
/// `spawn_tab` and four `#[cfg(mobile)]` dispatch arms, so Windows and Android *appear* to
/// record NavigationActions with nothing ever removing them. They do not. The audit
/// recorded that conclusion, and so did I, before the probe's own PRECONDITION failed and
/// forced a read of the writers:
///
/// * `NavActions` is written by `record_action` alone, and `record_action` is called by
///   `note_nav` alone — and `note_nav` is Linux-only (it carries
///   `#[cfg_attr(…, allow(dead_code))]` with the accurate comment "Linux-only phase; Windows
///   uses `block_at_start`"). Those attributes on `note_nav` and `record_action` are TRUE
///   and are still in place.
/// * `block_at_start`, the single-phase path Windows and Android actually use, never calls
///   `record_action` at all.
///
/// So on those three platforms `NavActions` stays empty and the `allow` attributes on THIS
/// function were only ever *vacuous*, not load-bearing. What the audit's grep did find, by
/// accident, is the real defect one function over: `Chains` is written on BOTH paths — by
/// `block_at_start` and by `note_nav` — but cleared only on Linux, so a closed tab's
/// `Chains` entry survived forever on Windows, Android and macOS, and `chain_origin` would
/// hand a later tab that reused the id a chain belonging to an already-closed tab. That is
/// `clear_chain`, and [`crate::tabs::forget_closed_tab`] now calls both on close.
///
/// The second call site is kept deliberately: it costs one `retain` and removes a whole
/// class of within-tab staleness that the Linux top-frame path only clears when a top-frame
/// load actually resolves.
pub fn clear_tab_actions<R: Runtime>(app: &AppHandle<R>, tab: u32) {
    if let Some(s) = app.try_state::<NavActions>() {
        s.0.lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(t, _), _| *t != tab);
    }
}

/// JNI bridge for Android's `NativeRedirectGuard.shouldBlock` (a Kotlin `object`).
/// Android derives scripted (=!hasGesture) + main_frame (=isForMainFrame) and the
/// URLs; this applies the shared cross-origin predicate. Lives in libapp_lib.so.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
// name means two libraries could export the same symbol, which the linker leaves
// undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
// by name), so it is allowed here explicitly rather than by the module scope —
// `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeRedirectGuard_shouldBlock(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    current: jni::objects::JString,
    target: jni::objects::JString,
    scripted: jni::sys::jboolean,
    main_frame: jni::sys::jboolean,
) -> jni::sys::jboolean {
    let current: String = env
        .get_string(&current)
        .map(|s| s.into())
        .unwrap_or_default();
    let target: String = env
        .get_string(&target)
        .map(|s| s.into())
        .unwrap_or_default();
    // Fails OPEN on a panic, matching `should_block`'s own contract.
    match crate::ffi_guard(|| should_block(&current, &target, scripted != 0, main_frame != 0)) {
        Some(blocked) => blocked as jni::sys::jboolean,
        None => {
            eprintln!("[aegis-redirect] should_block panicked; failing open for this navigation");
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- the redirect-tab budget: a hostile page must not drive unbounded tabs or writes ---

    /// The bug this pins: `on_blocked_redirect_to_new_tab` had no admission control at all, so
    /// a page running a redirect loop called it once per hop. Each call opened a tab AND did a
    /// full `serde_json::to_string_pretty` of the whole registry plus an fsync+rename
    /// (`tabs::open_redirect_background` → `emit_and_persist` → `persist`), and spawned a 30 s
    /// timer thread. N hops therefore cost N tabs, N full serialisations, N fsyncs and N
    /// threads — O(N·T) work driven entirely by a third-party page.
    ///
    /// The loop shape is `A → B → A → B …`, so the DISTINCT keys are only two. The important
    /// property is therefore that a repeated key is served once, and that the number of tabs
    /// the guard can have open at once is bounded — including when every `to` is distinct, which
    /// is the shape that defeats key-based dedup alone.
    #[test]
    fn a_redirect_loop_cannot_drive_unbounded_background_tabs() {
        let b = RedirectBudget::default();
        // A ping-pong loop: the same two keys over and over.
        let mut opened = 0usize;
        for i in 0..500 {
            let (from, to) = if i % 2 == 0 {
                ("https://a.test/", "https://b.test/")
            } else {
                ("https://b.test/", "https://a.test/")
            };
            if b.admit(from, to) {
                opened += 1;
                b.occupy(i as u32);
            }
        }
        assert!(
            opened <= MAX_LIVE_REDIRECT_TABS,
            "500 blocked hops across a two-key ping-pong opened {opened} background tabs; the \
             live set is capped at {MAX_LIVE_REDIRECT_TABS}"
        );
        // And the distinct-URL shape, which key dedup alone cannot collapse.
        let b2 = RedirectBudget::default();
        let mut opened2 = 0usize;
        for i in 0..500 {
            if b2.admit("https://a.test/", &format!("https://t{i}.test/")) {
                opened2 += 1;
                b2.occupy(i as u32);
            }
        }
        assert!(
            opened2 <= MAX_LIVE_REDIRECT_TABS,
            "500 blocked hops to 500 DISTINCT destinations opened {opened2} background tabs; \
             the live set is capped at {MAX_LIVE_REDIRECT_TABS}"
        );
    }

    /// The budget must not leak: a slot released by the auto-close timer has to come back, or
    /// the third redirect of a session would be silently dropped and the user would never see
    /// the destination of a legitimately-blocked hop.
    #[test]
    fn a_released_slot_comes_back_so_later_redirects_still_work() {
        let b = RedirectBudget::default();
        let mut first = Vec::new();
        for i in 0..MAX_LIVE_REDIRECT_TABS as u32 {
            assert!(
                b.admit("https://a.test/", &format!("https://t{i}.test/")),
                "hop {i} is within budget and must be admitted"
            );
            b.occupy(i);
            first.push(i);
        }
        assert!(
            !b.admit("https://a.test/", "https://over.test/"),
            "with every slot taken, another hop must be refused"
        );
        for id in first {
            b.release(id);
        }
        assert!(
            b.admit("https://a.test/", "https://after.test/"),
            "a released slot must be reusable, otherwise the budget ratchets shut and the user \
             permanently stops seeing blocked-redirect destinations"
        );
    }

    /// A repeat of a key this guard already acted on is refused *while the first tab is still
    /// live*, because opening a second tab for the same hop serves no purpose — the first one
    /// is already there. This is the property that collapses the classic A→B→A→B loop to a
    /// single tab, and it is the reason `admit` remembers keys and not just counts.
    #[test]
    fn the_same_hop_is_not_opened_twice_while_its_tab_is_live() {
        let b = RedirectBudget::default();
        assert!(
            b.admit("https://a.test/", "https://b.test/"),
            "the first hop is admitted"
        );
        b.occupy(7);
        assert!(
            !b.admit("https://a.test/", "https://b.test/"),
            "re-opening the same blocked redirect while its tab is still live just doubles the \
             tabs and the writes for no user benefit"
        );
        // A DIFFERENT hop is not affected while under the cap, so this cannot pass by refusing
        // everything.
        assert!(
            b.admit("https://c.test/", "https://d.test/"),
            "an unrelated blocked redirect must still be admitted while the budget has room"
        );
    }

    /// `admit` records the key itself, so a repeat after the slot is released is still refused
    /// for the remainder of the dedup window — otherwise a loop that runs slower than the
    /// auto-close timer would re-open the same tab every 30 s forever.
    #[test]
    fn a_repeat_is_still_refused_after_the_slot_is_released() {
        let b = RedirectBudget::default();
        assert!(b.admit("https://a.test/", "https://b.test/"));
        b.occupy(7);
        b.release(7);
        assert!(
            !b.admit("https://a.test/", "https://b.test/"),
            "the dedup window must outlive the auto-close timer, or a slow loop re-opens the \
             same destination every 30 s indefinitely"
        );
    }

    /// `RedirectBudget` is shared with a `'static` timer thread, so the `Arc` clone is the only
    /// thing that makes the release work. If someone makes it a bare `Mutex`, this stops
    /// compiling; this test documents the requirement in prose as well as in the type.
    #[test]
    fn the_budget_is_cheaply_clonable_for_the_timer_thread() {
        let b = RedirectBudget::default();
        let moved: RedirectBudget = b.clone();
        assert!(moved.admit("https://a.test/", "https://b.test/"));
        // Fill every slot through the ORIGINAL handle...
        for i in 0..MAX_LIVE_REDIRECT_TABS as u32 {
            assert!(b.admit("https://a.test/", &format!("https://t{i}.test/")));
            b.occupy(i);
        }
        // ...and the CLONE must already see them all taken. A copy would see an empty set.
        assert!(
            !moved.admit("https://a.test/", "https://fresh.test/"),
            "a clone must share state with the original, or `release` from the timer thread \
             would decrement a different set than `occupy` incremented, and the live set would \
             never come back down"
        );
        // And the reverse direction, which is the one the timer thread actually relies on.
        moved.release(0);
        assert!(
            b.admit("https://a.test/", "https://after-release.test/"),
            "a release through the clone must free the slot the original's `occupy` took"
        );
    }

    // --- should_block (the cross-origin predicate, Android's entry) ---
    #[test]
    fn blocks_scripted_cross_origin_top_frame() {
        assert!(should_block(
            "https://streamex.to/watch",
            "https://google.com/",
            true,
            true
        ));
    }
    #[test]
    fn allows_same_origin() {
        assert!(!should_block(
            "https://a.com/x",
            "https://a.com/y",
            true,
            true
        ));
    }
    #[test]
    fn allows_user_gesture() {
        assert!(!should_block(
            "https://a.com/",
            "https://b.com/",
            false,
            true
        ));
    }
    #[test]
    fn allows_subframe() {
        assert!(!should_block(
            "https://a.com/",
            "https://b.com/",
            true,
            false
        ));
    }
    #[test]
    fn ignores_non_http_target() {
        assert!(!should_block("https://a.com/", "about:blank", true, true));
        assert!(!should_block(
            "https://a.com/",
            "data:text/html,x",
            true,
            true
        ));
        assert!(!should_block(
            "https://a.com/",
            "javascript:void(0)",
            true,
            true
        ));
    }
    #[test]
    fn fails_open_on_unparseable() {
        assert!(!should_block("", "https://b.com/", true, true));
        assert!(!should_block("not a url", "https://b.com/", true, true));
    }
    #[test]
    fn cross_origin_by_port_and_scheme() {
        assert!(should_block("https://a.com/", "http://a.com/", true, true)); // scheme differs
        assert!(should_block(
            "https://a.com:8443/",
            "https://a.com/",
            true,
            true
        )); // port differs
    }

    // --- should_block_pred (the chain verdict applied at the decision point; `from` is the chain
    //     origin, `target` is the displayable destination, `app_initiated` resolved from pending) ---
    #[test]
    fn pred_blocks_scripted_cross_origin_direct() {
        assert!(should_block_pred(
            true,
            "https://streamex.to/watch",
            "https://google.com/",
            false
        ));
    }
    #[test]
    fn pred_blocks_scripted_cross_origin_after_redirect() {
        // THE BUG: streamex → google.com (scripted) → 301 → www.google.com. The destination
        // hop carries is_redirect=true, but the chain ORIGIN was scripted + non-app-initiated,
        // so the displayable destination must still be blocked.
        assert!(should_block_pred(
            true,
            "https://streamex.to/watch",
            "https://www.google.com/",
            false
        ));
    }
    #[test]
    fn pred_allows_app_initiated_chain() {
        // Address-bar nav whose server redirects cross-origin (e.g. youtu.be → youtube.com):
        // app_initiated=true (the PendingNavs match against the chain's origin target).
        assert!(!should_block_pred(
            true,
            "https://old.example/",
            "https://www.google.com/",
            true
        ));
    }
    #[test]
    fn pred_allows_user_gesture_chain() {
        // A clicked link that bounces through OAuth/shortener redirects (scripted=false).
        assert!(!should_block_pred(
            false,
            "https://app.example/",
            "https://accounts.google.com/",
            false
        ));
    }
    #[test]
    fn pred_allows_same_origin() {
        assert!(!should_block_pred(
            true,
            "https://a.com/x",
            "https://a.com/y",
            false
        ));
    }
    #[test]
    fn pred_ignores_non_http_target() {
        assert!(!should_block_pred(
            true,
            "https://a.com/",
            "about:blank",
            false
        ));
        assert!(!should_block_pred(
            true,
            "https://a.com/",
            "data:text/html,x",
            false
        ));
    }
    #[test]
    fn pred_fails_open_on_unparseable_origin() {
        assert!(!should_block_pred(true, "", "https://b.com/", false));
    }

    // --- PendingNavs (app-initiated matching) ---
    #[test]
    fn pending_match_is_consumed_once() {
        let p = PendingNavs::default();
        p.expect(1, "https://b.com/");
        assert!(p.take_if_match(1, "https://b.com/"));
        // consumed: a second identical nav no longer matches
        assert!(!p.take_if_match(1, "https://b.com/"));
    }
    #[test]
    fn pending_match_ignores_fragment_and_trailing_slash() {
        let p = PendingNavs::default();
        p.expect(1, "https://b.com/path");
        assert!(p.take_if_match(1, "https://b.com/path/#frag"));
    }
    #[test]
    fn pending_is_per_tab() {
        let p = PendingNavs::default();
        p.expect(1, "https://b.com/");
        // tab 2 has no pending entry → no match
        assert!(!p.take_if_match(2, "https://b.com/"));
    }
}
