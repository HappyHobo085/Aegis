//! Blocks scripted (non-user-gesture) cross-origin top-frame redirects — the
//! anti-malvertising guard. The POLICY lives here once; each platform's native
//! nav-policy hook derives the inputs and calls in. See
//! docs/superpowers/specs/2026-06-18-scripted-redirect-blocker-design.md.
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
use tauri::{AppHandle, Manager, Url};

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
        self.0.lock().unwrap().insert(tab, url.to_string());
    }
    /// Consume the tab's expected target if `target` matches it. Returns true on match.
    pub fn take_if_match(&self, tab: u32, target: &str) -> bool {
        let mut m = self.0.lock().unwrap();
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
pub struct ChainStart {
    pub from: String,
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
pub fn note_nav(app: &AppHandle, tab: u32, from: &str, target: &str, scripted: bool, is_redirect: bool) {
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
            s.0.lock().unwrap().insert(tab, c.clone());
        }
        c
    };
    record_action(app, tab, target, chain);
}

/// Linux Response phase: decide whether to CANCEL `final_url`, returning `Some(from)` to block.
/// Resolves app-initiated HERE — consuming the one-shot PendingNavs match against the chain's
/// ORIGIN target (the URL the app asked for, which differs from `final_url` when the server
/// redirected). Doing it at the single committed Response (not per NavigationAction) makes it
/// robust to WebKit firing NavigationAction several times for one navigation.
pub fn decide_at_response(app: &AppHandle, tab: u32, final_url: &str) -> Option<String> {
    let chain = take_action(app, tab, final_url)?;
    let app_initiated = app
        .try_state::<PendingNavs>()
        .is_some_and(|p| p.take_if_match(tab, &chain.origin_target));
    should_block_pred(chain.scripted, &chain.from, final_url, app_initiated).then(|| chain.from)
}

/// Windows NavigationStarting phase (top-frame only, fires once per hop): decide whether to
/// CANCEL `target`, returning `Some(from)` to block. Resolves app-initiated at the non-redirect
/// hop (consuming the PendingNavs match) and stores the verdict so a following redirect hop
/// inherits it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn block_at_start(
    app: &AppHandle,
    tab: u32,
    from: &str,
    target: &str,
    scripted: bool,
    is_redirect: bool,
) -> Option<String> {
    let chain = if is_redirect {
        chain_origin(app, tab).unwrap_or_else(|| {
            let app_initiated =
                app.try_state::<PendingNavs>().is_some_and(|p| p.take_if_match(tab, target));
            ChainStart { from: from.to_string(), origin_target: target.to_string(), scripted, app_initiated }
        })
    } else {
        let app_initiated =
            app.try_state::<PendingNavs>().is_some_and(|p| p.take_if_match(tab, target));
        let c = ChainStart { from: from.to_string(), origin_target: target.to_string(), scripted, app_initiated };
        if let Some(s) = app.try_state::<Chains>() {
            s.0.lock().unwrap().insert(tab, c.clone());
        }
        c
    };
    should_block_pred(chain.scripted, &chain.from, target, chain.app_initiated).then(|| chain.from)
}

/// The in-flight chain origin for a redirect hop, if one was recorded for this tab.
pub fn chain_origin(app: &AppHandle, tab: u32) -> Option<ChainStart> {
    Some(app.try_state::<Chains>()?.0.lock().unwrap().get(&tab)?.clone())
}

/// Drop a tab's in-flight chain once its top-frame load resolves.
pub fn clear_chain(app: &AppHandle, tab: u32) {
    if let Some(s) = app.try_state::<Chains>() {
        s.0.lock().unwrap().remove(&tab);
    }
}

/// Record an app-initiated navigation so the guard won't block it (or its redirects).
pub fn expect(app: &AppHandle, tab: u32, url: &str) {
    if let Some(s) = app.try_state::<PendingNavs>() {
        s.expect(tab, url);
    }
}

/// Emit the `redirect.blocked` event so the chrome can raise its notification bar.
pub fn on_blocked(app: &AppHandle, tab: u32, from: &str, to: &str) {
    if std::env::var_os("AEGIS_NAV_DEBUG").is_some() {
        eprintln!("[aegis-redirect] BLOCK {to} (from {from})");
    }
    crate::emit_event(
        app,
        "redirect.blocked",
        serde_json::json!({ "viewId": tab, "from": from, "to": to }),
    );
}

/// Linux two-phase correlation: the gesture/redirect type live on `NavigationAction`,
/// but reliable main-frame detection lives on `ResponsePolicyDecision`. We record the
/// resolved `ChainStart` for each NavigationAction by (tab, normalized-url), then look
/// it up at the (main-frame) Response. Linux-only — the other platforms get gesture +
/// main-frame in one place.
#[derive(Default)]
pub struct NavActions(pub Mutex<HashMap<(u32, String), ChainStart>>);

/// Normalize a URL into a stable correlation key (ignore fragment / trailing slash, since the
/// NavigationAction target and the Response URL can differ in those).
fn norm_key(url: &str) -> String {
    match Url::parse(url) {
        Ok(u) => format!(
            "{}://{}:{}{}?{}",
            u.scheme(),
            u.host_str().unwrap_or(""),
            u.port_or_known_default().map(|p| p.to_string()).unwrap_or_default(),
            u.path().trim_end_matches('/'),
            u.query().unwrap_or(""),
        ),
        _ => url.to_string(),
    }
}

/// Record the `ChainStart` to apply at the Response for `target` (Linux two-phase).
pub fn record_action(app: &AppHandle, tab: u32, target: &str, chain: ChainStart) {
    if let Some(s) = app.try_state::<NavActions>() {
        s.0.lock().unwrap().insert((tab, norm_key(target)), chain);
    }
}

/// Take the recorded `ChainStart` matching `target` for `tab`, if any.
pub fn take_action(app: &AppHandle, tab: u32, target: &str) -> Option<ChainStart> {
    let s = app.try_state::<NavActions>()?;
    let info = s.0.lock().unwrap().remove(&(tab, norm_key(target)));
    info
}

/// Drop a tab's recorded NavigationActions once its top-frame load resolves, so subframe
/// entries that never matched a main-frame Response don't accumulate.
pub fn clear_tab_actions(app: &AppHandle, tab: u32) {
    if let Some(s) = app.try_state::<NavActions>() {
        s.0.lock().unwrap().retain(|(t, _), _| *t != tab);
    }
}

/// JNI bridge for Android's `NativeRedirectGuard.shouldBlock` (a Kotlin `object`).
/// Android derives scripted (=!hasGesture) + main_frame (=isForMainFrame) and the
/// URLs; this applies the shared cross-origin predicate. Lives in libapp_lib.so.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeRedirectGuard_shouldBlock(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    current: jni::objects::JString,
    target: jni::objects::JString,
    scripted: jni::sys::jboolean,
    main_frame: jni::sys::jboolean,
) -> jni::sys::jboolean {
    let current: String = env.get_string(&current).map(|s| s.into()).unwrap_or_default();
    let target: String = env.get_string(&target).map(|s| s.into()).unwrap_or_default();
    should_block(&current, &target, scripted != 0, main_frame != 0) as jni::sys::jboolean
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- should_block (the cross-origin predicate, Android's entry) ---
    #[test]
    fn blocks_scripted_cross_origin_top_frame() {
        assert!(should_block("https://streamex.to/watch", "https://google.com/", true, true));
    }
    #[test]
    fn allows_same_origin() {
        assert!(!should_block("https://a.com/x", "https://a.com/y", true, true));
    }
    #[test]
    fn allows_user_gesture() {
        assert!(!should_block("https://a.com/", "https://b.com/", false, true));
    }
    #[test]
    fn allows_subframe() {
        assert!(!should_block("https://a.com/", "https://b.com/", true, false));
    }
    #[test]
    fn ignores_non_http_target() {
        assert!(!should_block("https://a.com/", "about:blank", true, true));
        assert!(!should_block("https://a.com/", "data:text/html,x", true, true));
        assert!(!should_block("https://a.com/", "javascript:void(0)", true, true));
    }
    #[test]
    fn fails_open_on_unparseable() {
        assert!(!should_block("", "https://b.com/", true, true));
        assert!(!should_block("not a url", "https://b.com/", true, true));
    }
    #[test]
    fn cross_origin_by_port_and_scheme() {
        assert!(should_block("https://a.com/", "http://a.com/", true, true)); // scheme differs
        assert!(should_block("https://a.com:8443/", "https://a.com/", true, true)); // port differs
    }

    // --- should_block_pred (the chain verdict applied at the decision point; `from` is the chain
    //     origin, `target` is the displayable destination, `app_initiated` resolved from pending) ---
    #[test]
    fn pred_blocks_scripted_cross_origin_direct() {
        assert!(should_block_pred(true, "https://streamex.to/watch", "https://google.com/", false));
    }
    #[test]
    fn pred_blocks_scripted_cross_origin_after_redirect() {
        // THE BUG: streamex → google.com (scripted) → 301 → www.google.com. The destination
        // hop carries is_redirect=true, but the chain ORIGIN was scripted + non-app-initiated,
        // so the displayable destination must still be blocked.
        assert!(should_block_pred(true, "https://streamex.to/watch", "https://www.google.com/", false));
    }
    #[test]
    fn pred_allows_app_initiated_chain() {
        // Address-bar nav whose server redirects cross-origin (e.g. youtu.be → youtube.com):
        // app_initiated=true (the PendingNavs match against the chain's origin target).
        assert!(!should_block_pred(true, "https://old.example/", "https://www.google.com/", true));
    }
    #[test]
    fn pred_allows_user_gesture_chain() {
        // A clicked link that bounces through OAuth/shortener redirects (scripted=false).
        assert!(!should_block_pred(false, "https://app.example/", "https://accounts.google.com/", false));
    }
    #[test]
    fn pred_allows_same_origin() {
        assert!(!should_block_pred(true, "https://a.com/x", "https://a.com/y", false));
    }
    #[test]
    fn pred_ignores_non_http_target() {
        assert!(!should_block_pred(true, "https://a.com/", "about:blank", false));
        assert!(!should_block_pred(true, "https://a.com/", "data:text/html,x", false));
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
