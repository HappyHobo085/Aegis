//! Blocks scripted (non-user-gesture) cross-origin top-frame redirects — the
//! anti-malvertising guard. The POLICY lives here once; each platform's native
//! nav-policy hook derives the four inputs and calls in. See
//! docs/superpowers/specs/2026-06-18-scripted-redirect-blocker-design.md.
use tauri::Url;

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
}
