//! WebRTC IP-leak defense.
//!
//! A document-start JS shim (baked into the content webview's injection on desktop, and
//! registered as a per-tab document-start script on Android) that stops a page from
//! reading the user's LAN / loopback / link-local IP via WebRTC ICE candidates, while
//! keeping TURN/relay candidates so real calls still work. Three policies:
//!   - `"public-only"` (default): filter local/private candidates + rewrite private SDP
//!     connection addresses; keep relay + public reflexive.
//!   - `"disable"`: replace `RTCPeerConnection` with a constructor that throws.
//!   - `"default"`: no interference.
//!
//! The shim is **FAIL-OPEN**: any parse/runtime error keeps the candidate / returns the
//! SDP unchanged, so a shim bug can never break a page's own JS.
//!
//! The public-only shim wraps every surface a page can read a candidate from: the
//! `icecandidate` event (`addEventListener` + the `onicecandidate` handler), the SDP from
//! `createOffer`/`createAnswer` and the `localDescription` getters, AND `getStats()` (whose
//! `local-candidate`/`remote-candidate` entries carry `.address`/`.ip`). It preserves the
//! constructor's static methods (e.g. `generateCertificate`) so pages don't break.
//!
//! ## Single tested artifact (drift control)
//! The SHIPPED JS lives in `webrtc_shim.public-only.js` / `webrtc_shim.disable.js`,
//! `include_str!`'d here AND executed by the vitest runtime test
//! (`src/lib/webrtcShim.test.ts`) against a fake `RTCPeerConnection` — so the test covers
//! the exact bytes shipped (that test is AUTHORITATIVE for runtime behavior). The Rust
//! `is_local_address` / `keep_candidate` / `filter_sdp` are a parallel **reference** (also
//! unit-tested for IPv4 ranges, IPv6, fail-open, idempotency); the JS `isLocalAddr` mirrors
//! `is_local_address` rule-for-rule. `getStats` filtering is JS-only (no string analog).
//!
//! ## Coverage residual (honest)
//! Document-start injection covers the page + iframe frames but NOT Web Worker /
//! SharedWorker global scopes. In practice this is moot for the leak vector: per the WebRTC
//! spec `RTCPeerConnection` is `[Exposed=Window]` — it is NOT constructible in a Worker scope
//! on spec-compliant engines (WebKit/Chromium), so there's no peer connection there to leak
//! through. The native backstops (Linux `set_enable_webrtc`, Windows
//! `--force-webrtc-ip-handling-policy`) ARE engine-wide and remain belt-and-suspenders should a
//! non-standard engine ever expose it in a worker; macOS and Android are shim-only (so they'd
//! rely solely on the Window-only exposure holding). See the matrix in src-tauri/CLAUDE.md.

use std::sync::OnceLock;

/// True if `addr` is a local/private/loopback/link-local/mDNS address that must be
/// dropped so it can't leak. FAIL-OPEN: anything we can't classify (unexpected form,
/// non-dotted-quad, unknown IPv6) returns false → the candidate is kept. Mirrors the JS
/// `isLocalAddr` in `shim_for`.
#[allow(dead_code)] // reference rule-set; production filtering runs in the shim JS (see module doc)
pub fn is_local_address(addr: &str) -> bool {
    let lower = addr.trim().to_ascii_lowercase();
    let mut a: &str = &lower; // may be narrowed to the embedded IPv4 of a mapped address below
    if a.is_empty() {
        return false;
    }
    if a.ends_with(".local") {
        return true; // mDNS host
    }
    if a.contains(':') {
        // IPv6 (or IPv4-mapped IPv6).
        if a == "::1" {
            return true; // loopback
        }
        // IPv4-mapped (e.g. `::ffff:192.168.1.5`): classify by the embedded IPv4 — the dotted
        // quad sits after the last ':'. Otherwise it's a pure IPv6 form.
        let c = a.rfind(':').unwrap_or(0);
        if a.find('.').is_some_and(|d| d > c) {
            a = &a[c + 1..]; // fall through to the IPv4 logic below
        } else {
            // ULA fc00::/7 (fc.. / fd..) + link-local fe80::/10 (fe8../fe9../fea../feb..).
            // Any other IPv6 form (incl. unexpected) → keep (fail open).
            return a.starts_with("fc")
                || a.starts_with("fd")
                || a.starts_with("fe8")
                || a.starts_with("fe9")
                || a.starts_with("fea")
                || a.starts_with("feb");
        }
    }
    // IPv4 dotted-quad (or a mapped ::ffff:x.x.x.x narrowed above).
    let octets: Vec<&str> = a.split('.').collect();
    if octets.len() != 4 {
        return false; // not a dotted quad → keep (fail open)
    }
    let (Ok(n0), Ok(n1)) = (octets[0].parse::<u16>(), octets[1].parse::<u16>()) else {
        return false; // unparseable octets → keep (fail open)
    };
    n0 == 10                                    // 10.0.0.0/8
        || n0 == 127                            // loopback 127.0.0.0/8
        || (n0 == 192 && n1 == 168)             // 192.168.0.0/16
        || (n0 == 169 && n1 == 254)             // link-local 169.254.0.0/16
        || (n0 == 172 && (16..=31).contains(&n1)) // 172.16.0.0/12
}

/// Whether an ICE candidate line should be KEPT. Drops `typ host`/`srflx`/`prflx`
/// candidates whose connection-address is local/private (the leak vector); always keeps
/// `typ relay` (TURN) and public reflexive candidates. FAIL-OPEN: a malformed/truncated/
/// unrecognized line is kept. Mirrors the JS `keepCand`.
#[allow(dead_code)] // reference rule-set; production filtering runs in the shim JS (see module doc)
pub fn keep_candidate(line: &str) -> bool {
    let l = line.trim();
    let idx = match l.find("candidate:") {
        Some(i) => i,
        None => return true, // not a candidate line → keep
    };
    let toks: Vec<&str> = l[idx..].split_whitespace().collect();
    // candidate:<foundation> <comp> <transport> <prio> <addr> <port> typ <type> ...
    if toks.len() < 8 {
        return true; // truncated → keep
    }
    let cand_type = match toks
        .iter()
        .position(|t| *t == "typ")
        .and_then(|i| toks.get(i + 1))
    {
        Some(t) => *t,
        None => return true, // no type → keep
    };
    if cand_type == "relay" {
        return true; // TURN relay → keep so calls survive
    }
    !is_local_address(toks[4]) // toks[4] = connection-address; drop if local/private
}

/// Rewrite an SDP blob to remove local-IP leakage: drop private host/srflx candidate
/// lines (keep relay + public), and rewrite private `c=`/`o=` connection addresses to
/// `0.0.0.0`/`::`. Idempotent and FAIL-OPEN. Mirrors the JS `filterSdp`.
#[allow(dead_code)] // reference rule-set; production filtering runs in the shim JS (see module doc)
pub fn filter_sdp(sdp: &str) -> String {
    let nl = if sdp.contains("\r\n") { "\r\n" } else { "\n" };
    let trailing = sdp.ends_with('\n');
    let mut out: Vec<String> = Vec::new();
    for line in sdp.lines() {
        if line.starts_with("a=candidate:") || line.starts_with("candidate:") {
            if keep_candidate(line) {
                out.push(line.to_string());
            }
            continue; // dropped private candidate
        }
        out.push(rewrite_connection_address(line));
    }
    let joined = out.join(nl);
    if trailing {
        format!("{joined}{nl}")
    } else {
        joined
    }
}

/// Rewrite a single SDP `c=`/`o=` line's address to `0.0.0.0`/`::` if it is private.
fn rewrite_connection_address(line: &str) -> String {
    if let Some(rest) = line.strip_prefix("c=IN IP4 ") {
        return if is_local_address(rest.trim()) {
            "c=IN IP4 0.0.0.0".to_string()
        } else {
            line.to_string()
        };
    }
    if let Some(rest) = line.strip_prefix("c=IN IP6 ") {
        return if is_local_address(rest.trim()) {
            "c=IN IP6 ::".to_string()
        } else {
            line.to_string()
        };
    }
    if line.starts_with("o=") {
        // o=<user> <sess-id> <sess-ver> <nettype> <addrtype> <addr>
        let parts: Vec<&str> = line.split(' ').collect();
        if parts.len() == 6 && is_local_address(parts[5]) {
            let mut p = parts.clone();
            p[5] = if parts[4] == "IP6" { "::" } else { "0.0.0.0" };
            return p.join(" ");
        }
    }
    line.to_string()
}

// Pre-computed shim variants: built once at boot, served as `&'static str` on every
// tab spawn. Avoids cloning the JS string on the hot path.
static SHIM_DEFAULT: OnceLock<String> = OnceLock::new();
static SHIM_PUBLIC_ONLY: OnceLock<String> = OnceLock::new();
static SHIM_DISABLE: OnceLock<String> = OnceLock::new();

/// Pre-warm all three policy variants at boot (cheap — three string builds). Must be
/// called before the first tab spawns so the hot path can use `get_precomputed`.
pub fn prewarm() {
    let _ = SHIM_DEFAULT.set(shim_for_inner("default"));
    let _ = SHIM_PUBLIC_ONLY.set(shim_for_inner("public-only"));
    let _ = SHIM_DISABLE.set(shim_for_inner("disable"));
}

/// Return a pre-computed shim `&'static str` for `policy`, or `None` if `prewarm()`
/// hasn't been called yet (or the policy is unknown). Caller falls back to `shim_for`.
pub fn get_precomputed(policy: &str) -> Option<&'static str> {
    match policy {
        "default" => SHIM_DEFAULT.get().map(|s| s.as_str()),
        "public-only" => SHIM_PUBLIC_ONLY.get().map(|s| s.as_str()),
        "disable" => SHIM_DISABLE.get().map(|s| s.as_str()),
        _ => None,
    }
}

/// Inner shim builder (the actual string construction). Separated from the public
/// `shim_for` so `prewarm` can call it without the host-allowlist check.
fn shim_for_inner(policy: &str) -> String {
    match policy {
        "disable" => DISABLE_JS.to_string(),
        "public-only" => PUBLIC_ONLY_JS.to_string(),
        _ => String::new(),
    }
}

/// The document-start JS shim for `policy`. Returns `""` (no interference) for
/// `"default"`, an allowlisted host, or any unrecognized policy.
pub fn shim_for(policy: &str, host_allowlisted: bool) -> String {
    if host_allowlisted {
        return String::new();
    }
    // Fast path: use pre-computed variant when available.
    if let Some(precomputed) = get_precomputed(policy) {
        return precomputed.to_string();
    }
    shim_for_inner(policy)
}

// The shipped shim JS, single-sourced from sibling .js files so the vitest runtime test
// (src/lib/webrtcShim.test.ts) executes the EXACT bytes shipped here. The JS `isLocalAddr`
// mirrors `is_local_address` above; the vitest test is authoritative for runtime behavior.
const DISABLE_JS: &str = include_str!("webrtc_shim.disable.js");
const PUBLIC_ONLY_JS: &str = include_str!("webrtc_shim.public-only.js");

/// Android-only: the policy the document-start shim getter reads. Seeded at boot and
/// updated on settings change from the Rust side (the JNI getter has no `AppHandle` to
/// read settings itself). Off Android this is unused — desktop bakes the policy per-tab
/// from settings directly in `adblock_inject::script`.
#[cfg(target_os = "android")]
static ANDROID_POLICY: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

/// Record the current WebRTC policy for the Android shim getter. Android-only: the JNI
/// getter has no `AppHandle`, so the policy is pushed here (seeded at boot, updated on
/// settings change). Desktop reads settings directly in `adblock_inject::script`.
#[cfg(target_os = "android")]
pub fn note_policy(policy: &str) {
    if let Ok(mut g) = ANDROID_POLICY.write() {
        *g = policy.to_string();
    }
}

#[cfg(target_os = "android")]
fn android_policy() -> String {
    let p = ANDROID_POLICY.read().map(|g| g.clone()).unwrap_or_default();
    if p.is_empty() {
        "public-only".to_string()
    } else {
        p
    }
}

/// JNI bridge for Android's `NativeWebrtc.shimScript()`. Returns the WebRTC shim JS for
/// the current policy. The per-site allowlist escape hatch is desktop-only in v1, so
/// `host_allowlisted` is false here. Registered as a per-tab document-start script in
/// `MainActivity.createTabWebView`. Null jstring on failure (Kotlin skips registration).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeWebrtc_shimScript<'a>(
    env: jni::JNIEnv<'a>,
    _this: jni::objects::JObject<'a>,
) -> jni::sys::jstring {
    let s = shim_for(&android_policy(), false);
    match env.new_string(s) {
        Ok(js) => js.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_ipv4_private_and_public() {
        for a in [
            "10.0.0.1",
            "10.255.255.255",
            "192.168.1.5",
            "172.16.0.1",
            "172.31.255.1",
            "169.254.1.1",
            "127.0.0.1",
        ] {
            assert!(is_local_address(a), "{a} should be local/private");
        }
        for a in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1",
            "172.32.0.1",
            "172.8.0.1",
            "203.0.113.7",
            "0.0.0.0",
        ] {
            assert!(!is_local_address(a), "{a} should be public/keepable");
        }
    }

    #[test]
    fn classifies_ipv6_private_and_public() {
        for a in [
            "::1",
            "fe80::1",
            "fe80::abcd",
            "fc00::1",
            "fd12:3456::1",
            "FE80::1",
            // IPv4-mapped IPv6: classify by the embedded private IPv4 (the leak this closes).
            "::ffff:192.168.1.5",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
        ] {
            assert!(is_local_address(a), "{a} should be local/private");
        }
        for a in [
            "2001:4860:4860::8888",
            "2606:4700::1111",
            // A mapped PUBLIC IPv4 must stay keepable.
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_local_address(a), "{a} should be public/keepable");
        }
    }

    #[test]
    fn keep_candidate_keeps_relay_and_public_drops_private() {
        // Private host → drop.
        assert!(!keep_candidate(
            "candidate:1 1 udp 2122260223 192.168.1.5 51000 typ host generation 0"
        ));
        // mDNS host → drop.
        assert!(!keep_candidate(
            "a=candidate:1 1 udp 2122260223 abc-def.local 51000 typ host"
        ));
        // Public srflx → keep.
        assert!(keep_candidate("candidate:2 1 udp 1686052607 203.0.113.7 51000 typ srflx raddr 192.168.1.5 rport 51000"));
        // TURN relay even with a private-looking raddr → keep (calls survive).
        assert!(keep_candidate(
            "candidate:3 1 udp 41885439 198.51.100.9 60000 typ relay raddr 10.0.0.2 rport 0"
        ));
        // Private srflx (rare) → drop.
        assert!(!keep_candidate(
            "candidate:4 1 udp 1686052607 10.0.0.9 51000 typ srflx"
        ));
    }

    #[test]
    fn keep_candidate_fails_open_on_garbage() {
        // Non-candidate, truncated, missing-typ, empty → keep (never break the page).
        assert!(keep_candidate(""));
        assert!(keep_candidate("a=group:BUNDLE 0 1"));
        assert!(keep_candidate("candidate:1 1 udp"));
        assert!(keep_candidate(
            "candidate:1 1 udp 123 192.168.1.5 5000 generation 0"
        )); // no typ
        assert!(keep_candidate(
            "garbage candidate: with no real fields here at all"
        ));
    }

    #[test]
    fn filter_sdp_drops_private_candidates_rewrites_addresses_and_is_idempotent() {
        let sdp = "v=0\r\n\
o=- 46117 2 IN IP4 192.168.1.5\r\n\
c=IN IP4 192.168.1.5\r\n\
a=candidate:1 1 udp 2122260223 192.168.1.5 51000 typ host\r\n\
a=candidate:2 1 udp 1686052607 203.0.113.7 51000 typ srflx\r\n\
a=candidate:3 1 udp 41885439 198.51.100.9 60000 typ relay\r\n";
        let out = filter_sdp(sdp);
        assert!(
            !out.contains("192.168.1.5"),
            "private IP must be gone: {out}"
        );
        assert!(
            out.contains("c=IN IP4 0.0.0.0"),
            "private c= rewritten: {out}"
        );
        assert!(
            out.contains("o=- 46117 2 IN IP4 0.0.0.0"),
            "private o= rewritten: {out}"
        );
        assert!(
            !out.contains("typ host"),
            "private host candidate dropped: {out}"
        );
        assert!(
            out.contains("203.0.113.7") && out.contains("typ srflx"),
            "public srflx kept: {out}"
        );
        assert!(out.contains("typ relay"), "relay kept: {out}");
        // Idempotent: a second pass changes nothing.
        assert_eq!(filter_sdp(&out), out);
        // CRLF line endings preserved.
        assert!(out.contains("\r\n"));
    }

    #[test]
    fn shim_for_emits_the_right_artifact_per_policy() {
        // default / unknown / allowlisted → no interference.
        assert_eq!(shim_for("default", false), "");
        assert_eq!(shim_for("nonsense", false), "");
        assert_eq!(shim_for("public-only", true), ""); // allowlisted host
        assert_eq!(shim_for("disable", true), "");

        // disable → throwing constructor.
        let dis = shim_for("disable", false);
        assert!(dis.contains("window.RTCPeerConnection = Blocked"));
        assert!(dis.contains("WebRTC disabled by Aegis"));

        // public-only → the emitted JS embeds the SAME rule-set as the Rust fns + the
        // RTCPeerConnection/candidate/SDP wrapping (test covers the shipped string).
        let js = shim_for("public-only", false);
        for marker in [
            "isLocalAddr",
            "keepCand",
            "filterSdp",
            "endsWith('.local')",
            "fe8",
            "n0===10",
            "n0===127",
            "n0===192 && n1===168",
            "n0===169 && n1===254",
            "n0===172 && n1>=16 && n1<=31",
            "'relay'",
            "c=IN IP4 0.0.0.0",
            "createOffer",
            "localDescription",
            "window.RTCPeerConnection = Patched",
            // The review-driven additions: getStats leak filter, onicecandidate replace
            // semantics, and static-method preservation must be present in the shipped JS.
            "getStats",
            "local-candidate",
            "removeEventListener",
            "getOwnPropertyNames",
        ] {
            assert!(
                js.contains(marker),
                "shipped public-only JS missing marker: {marker}"
            );
        }
    }
}
