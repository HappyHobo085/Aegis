//! Blocks scripted (non-user-gesture) cross-origin top-frame redirects — the
//! anti-malvertising guard. The POLICY lives here once; each platform's native
//! nav-policy hook derives the four inputs and calls in. See
//! docs/superpowers/specs/2026-06-18-scripted-redirect-blocker-design.md.
use tauri::{AppHandle, Manager, Url};

/// The core test: a script-initiated, cross-origin navigation targeting the top
/// frame. All four platforms feed it the same inputs. (Freshness — excluding
/// redirect hops and app-initiated navs — is layered on by `decide`.)
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
/// BEFORE navigating; the guard consumes a match so app navigations are never
/// blocked. Page-script navigations never match.
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

/// Decide whether to BLOCK this navigation (true = cancel). `is_redirect` marks a
/// redirect hop continuing an already-vetted navigation.
pub fn decide(
    pending: &PendingNavs,
    tab: u32,
    current: &str,
    target: &str,
    scripted: bool,
    main_frame: bool,
    is_redirect: bool,
) -> bool {
    if is_redirect {
        return false; // continuation of a vetted navigation
    }
    if pending.take_if_match(tab, target) {
        return false; // app-initiated
    }
    should_block(current, target, scripted, main_frame)
}

/// Record an app-initiated navigation so the guard won't block it.
pub fn expect(app: &AppHandle, tab: u32, url: &str) {
    if let Some(s) = app.try_state::<PendingNavs>() {
        s.expect(tab, url);
    }
}

/// AppHandle-bound `decide`: pulls the shared registry from Tauri state.
pub fn decide_for(
    app: &AppHandle,
    tab: u32,
    current: &str,
    target: &str,
    scripted: bool,
    main_frame: bool,
    is_redirect: bool,
) -> bool {
    let Some(s) = app.try_state::<PendingNavs>() else {
        return false;
    };
    decide(s.inner(), tab, current, target, scripted, main_frame, is_redirect)
}

/// Emit the `redirect.blocked` event so the chrome can raise its toast.
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

/// What a NavigationAction told us, kept so the Response phase (where the main-frame flag is
/// reliable) can apply the guard with the gesture/redirect info that's only on the action.
#[derive(Clone)]
pub struct NavInfo {
    pub scripted: bool,
    pub is_redirect: bool,
    pub current: String,
}

/// Linux two-phase correlation: the gesture/type live on `NavigationAction`, but reliable
/// main-frame detection lives on `ResponsePolicyDecision`. We record each NavigationAction by
/// (tab, normalized-url) here, then look it up at Response time. Linux-only (the other
/// platforms get gesture + main-frame in one place).
#[derive(Default)]
pub struct NavActions(pub Mutex<HashMap<(u32, String), NavInfo>>);

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

/// Record a NavigationAction (for the Response phase to consume).
pub fn record_action(app: &AppHandle, tab: u32, target: &str, info: NavInfo) {
    if let Some(s) = app.try_state::<NavActions>() {
        s.0.lock().unwrap().insert((tab, norm_key(target)), info);
    }
}

/// Take the recorded NavigationAction matching `target` for `tab`, if any.
pub fn take_action(app: &AppHandle, tab: u32, target: &str) -> Option<NavInfo> {
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
    #[test]
    fn redirect_hop_is_allowed() {
        let p = PendingNavs::default();
        assert!(!decide(&p, 1, "https://a.com/", "https://b.com/", true, true, true));
    }
    #[test]
    fn app_initiated_is_allowed_and_consumed() {
        let p = PendingNavs::default();
        p.expect(1, "https://b.com/");
        assert!(!decide(&p, 1, "https://a.com/", "https://b.com/", true, true, false));
        // consumed: a second identical scripted nav now blocks
        assert!(decide(&p, 1, "https://a.com/", "https://b.com/", true, true, false));
    }
    #[test]
    fn app_initiated_match_ignores_fragment_and_trailing_slash() {
        let p = PendingNavs::default();
        p.expect(1, "https://b.com/path");
        assert!(!decide(&p, 1, "https://a.com/", "https://b.com/path/#frag", true, true, false));
    }
    #[test]
    fn fresh_scripted_cross_origin_blocks() {
        let p = PendingNavs::default();
        assert!(decide(&p, 1, "https://a.com/", "https://evil.com/", true, true, false));
    }
    #[test]
    fn pending_is_per_tab() {
        let p = PendingNavs::default();
        p.expect(1, "https://b.com/");
        // tab 2 has no pending entry → still blocked
        assert!(decide(&p, 2, "https://a.com/", "https://b.com/", true, true, false));
    }
}
