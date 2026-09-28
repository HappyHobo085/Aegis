//! Per-host WebRTC IP-leak exemptions — a **local-only** list, deliberately separate from
//! the ad-block allowlist.
//!
//! # Why this is its own store
//!
//! The ad-block allowlist ("show me this site's ads") is a SYNCED store, and every device
//! holding the account data key can write a record into it. It used to double as the WebRTC
//! escape hatch, which meant one poisoned record on one paired device permanently disabled
//! WebRTC IP-leak protection for that host on **every device the user owns**, with nothing
//! on screen reporting a sync event as the cause. A false-positive list and a privacy
//! guarantee are not the same switch, and one is synced while the other must not be.
//!
//! The sibling farbling exemption (`fp-allowlist`, local-only) is the pattern this follows —
//! see `farble.rs`, which has been local-only from the start. So `adblock::host_allowlisted`
//! now drives ad-blocking alone, and this store drives WebRTC alone.
//!
//! # Scope
//!
//! Exact host or a subdomain of it, via [`crate::adblock::host_covered`] — the one definition
//! of "allowlisted" in the crate, so the two lists cannot drift in what they match even
//! though they are separate sets.
//!
//! # Android
//!
//! The composed document-start script is built on a JNI thread with no `AppHandle`, so the
//! exemption is mirrored into a process-global by [`note_exempt_hosts`], and
//! [`seed_from_disk`] pushes it at boot exactly as `farble::seed_from_disk` does for the
//! farble level. If you add a store like this, that boot push is not optional.

use serde_json::{json, Value};
#[cfg(any(target_os = "android", test))]
use std::sync::{OnceLock, RwLock};
use tauri::{AppHandle, Runtime};

/// The store name. Local-only: deliberately NOT in `sync_stores::SYNCABLE`, which is what
/// stops a remote record from reaching it.
pub const STORE: &str = "webrtc-allowlist";

// ── the Android/JNI process-global mirror ────────────────────────────────────

/// Mirrors [`STORE`] for callers with no `AppHandle`. `cfg`'d to Android + test rather than
/// `#[allow(dead_code)]`: the absence of a reader on other platforms IS the truth, and this
/// crate's convention is a gate over an allow for exactly that reason.
#[cfg(any(target_os = "android", test))]
static ANDROID_EXEMPT: OnceLock<RwLock<Vec<String>>> = OnceLock::new();

#[cfg(any(target_os = "android", test))]
fn android_exempt_hosts() -> &'static RwLock<Vec<String>> {
    ANDROID_EXEMPT.get_or_init(|| RwLock::new(Vec::new()))
}

/// Push the exempt hosts into the app-free global. Called by [`seed_from_disk`] at boot and
/// after every mutation. Take the write lock inside the call so a caller cannot forget.
#[cfg(any(target_os = "android", test))]
pub fn note_exempt_hosts(hosts: &[String]) {
    *android_exempt_hosts()
        .write()
        .unwrap_or_else(|e| e.into_inner()) = hosts.to_vec();
}

/// Whether `host` is exempt, with no `AppHandle`. The JNI document-start path.
///
/// Read by the Android WebRTC shim getter
/// (`Java_com_aegis_browser_NativeWebrtc_shimScript`), which receives the tab's content host
/// and has no other way to reach this store — there is no `AppHandle` on a JNI thread. That
/// getter is why this is a real production caller on Android and not merely a test seam; the
/// app's rule is that a capability must not work on desktop and quietly not work on Android.
#[cfg(any(target_os = "android", test))]
pub fn android_host_exempt(host: &str) -> bool {
    let g = android_exempt_hosts()
        .read()
        .unwrap_or_else(|e| e.into_inner());
    crate::adblock::host_covered(&g, host)
}

// ── the AppHandle-backed store ───────────────────────────────────────────────

/// Seed the app-free global from disk. Must be called from the boot hook alongside
/// `webrtc_shim::note_policy` and `farble::seed_from_disk`.
pub fn seed_from_disk<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(any(target_os = "android", test))]
    note_exempt_hosts(&crate::jsonstore::live_hosts(app, STORE));
    let _ = app;
}

/// The exempt hosts as a JSON array, for the `webrtc.getExemptHosts` reply.
pub fn state_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    json!({ "exemptHosts": crate::jsonstore::live_hosts(app, STORE) })
}

/// Whether `host` is exempt from the WebRTC IP-leak defence.
pub fn host_exempt<R: Runtime>(app: &AppHandle<R>, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    crate::adblock::host_covered(&crate::jsonstore::live_hosts(app, STORE), host)
}

fn host_of(payload: &Value) -> Result<String, String> {
    let h = payload
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if h.is_empty() {
        return Err("host must not be empty".into());
    }
    // The same shape checks `adblock_webkit::usable_if_domain` applies before a host reaches
    // a WebKit filter, for the same reason: a hostile host string must not become a rule.
    if h.len() > 253
        || !h
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        || !h.contains('.')
    {
        return Err("host must be a dotted host name".into());
    }
    Ok(h)
}

/// `webrtc.*` channels. Returns `None` for a channel that is not ours.
///
/// Deliberately does NOT call `sync::nudge`: this store is local-only, so there is nothing to
/// push. `farble`'s mutation arms do nudge because farbling state is reachable from a synced
/// `fingerprint.*` setting; copying that here would be a copy of the wrong thing.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    // Each arm is a named function rather than an inline block, so `dispatch` needs no `?`
    // (which cannot be used in a function returning `Option<Result<..>>`) and no sentinel
    // string to smuggle "this channel is not mine" through. The same shape as
    // `find::dispatch`.
    let res = match channel {
        "webrtc.getExemptHosts" => Ok(state_json(app)),
        "webrtc.toggleExempt" => toggle(app, payload),
        "webrtc.removeExempt" => remove(app, payload),
        "webrtc.clearExempt" => clear(app),
        _ => return None,
    };
    Some(res)
}

fn toggle<R: Runtime>(app: &AppHandle<R>, payload: &Value) -> Result<Value, String> {
    let h = host_of(payload)?;
    let hosts = crate::jsonstore::live_hosts(app, STORE);
    let exempt = if hosts.iter().any(|e| e == &h) {
        crate::jsonstore::remove_host(app, STORE, &h).map_err(|e| e.to_string())?;
        false
    } else {
        crate::jsonstore::add_host(app, STORE, &h).map_err(|e| e.to_string())?;
        true
    };
    reseed(app);
    Ok(json!({ "exempt": exempt }))
}

fn remove<R: Runtime>(app: &AppHandle<R>, payload: &Value) -> Result<Value, String> {
    let h = host_of(payload)?;
    crate::jsonstore::remove_host(app, STORE, &h).map_err(|e| e.to_string())?;
    reseed(app);
    Ok(json!({ "removed": h }))
}

fn clear<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    crate::jsonstore::clear_hosts(app, STORE).map_err(|e| e.to_string())?;
    reseed(app);
    Ok(json!({ "cleared": true }))
}

/// Refresh the app-free global after a mutation. Separate from [`seed_from_disk`] so the
/// boot path reads as boot and the mutation path reads as mutation.
fn reseed<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(any(target_os = "android", test))]
    note_exempt_hosts(&crate::jsonstore::live_hosts(app, STORE));
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;
    // `with_tmp_app` already takes the global test LOCK for its whole body — taking it
    // here as well DEADLOCKS, because it is a plain (non-reentrant) Mutex. That is the
    // one way a test in this module can hang the entire suite.
    use crate::test_support::with_tmp_app;

    /// THE DECOUPLING. Before this store existed, the ad-block allowlist was the WebRTC
    /// escape hatch — so a synced record written by any device holding the data key turned
    /// off IP-leak protection on every device. The ad-block allowlist must no longer do it.
    #[test]
    fn the_ad_block_allowlist_no_longer_exempts_a_host_from_webrtc() {
        with_tmp_app(|app| {
            crate::adblock::dispatch(
                app,
                "adblock.toggleAllowlist",
                &json!({ "host": "ads.example" }),
            )
            .expect("channel is ours")
            .expect("toggle succeeds");
            assert!(
                crate::adblock::host_allowlisted(app, "ads.example"),
                "precondition: the host IS ad-block allowlisted"
            );
            assert!(
                !host_exempt(app, "ads.example"),
                "an ad-block allowlist entry must NOT disable the WebRTC IP-leak defence"
            );
            assert!(
                !host_exempt(app, "tracker.example"),
                "and an unrelated host is not exempt either"
            );
        });
    }

    /// The new list is its own switch, scoped exactly like the old one.
    #[test]
    fn a_webrtc_exemption_covers_the_host_and_its_subdomains() {
        with_tmp_app(|app| {
            dispatch(
                app,
                "webrtc.toggleExempt",
                &json!({ "host": "Trusted.Example" }),
            )
            .expect("channel is ours")
            .expect("toggle succeeds");
            assert!(
                host_exempt(app, "trusted.example"),
                "exact host, case-folded"
            );
            assert!(host_exempt(app, "www.trusted.example"), "subdomain");
            assert!(
                !host_exempt(app, "nottrusted.example"),
                "not a suffix match"
            );
            assert!(!host_exempt(app, ""), "an empty host is never exempt");
        });
    }

    /// Toggling twice removes it, so the channel is a genuine toggle.
    #[test]
    fn toggling_twice_returns_to_exempt_and_not_exempt() {
        with_tmp_app(|app| {
            let on = dispatch(app, "webrtc.toggleExempt", &json!({ "host": "t.example" }))
                .unwrap()
                .unwrap();
            assert_eq!(on["exempt"], json!(true));
            let off = dispatch(app, "webrtc.toggleExempt", &json!({ "host": "t.example" }))
                .unwrap()
                .unwrap();
            assert_eq!(off["exempt"], json!(false));
            assert!(!host_exempt(app, "t.example"));
        });
    }

    /// The security property itself: the store is NOT in `sync_stores::SYNCABLE`, so a
    /// synced record can never reach it. This is a direct assertion on the constant rather
    /// than on behaviour, because the behaviour (absence of a pull path) is hard to observe
    /// from a unit test — but this is the fact the whole store exists to guarantee.
    #[test]
    fn the_exemption_store_is_not_reachable_from_sync() {
        assert!(
            !crate::sync_stores::SYNCABLE.contains(&STORE),
            "a synced exemption store would re-create the defect this module exists to fix"
        );
    }

    /// A hostile host string is refused: these entries become a WebKit/WebView2 exemption
    /// and are matched by substring-style comparisons in two engines.
    #[test]
    fn a_hostile_exemption_host_is_refused() {
        with_tmp_app(|app| {
            for bad in [
                "",
                "   ",
                "no-dot",
                "has space.example",
                "has/slash.example",
                "wild*.example",
                "a.example:8080",
            ] {
                let r = dispatch(app, "webrtc.toggleExempt", &json!({ "host": bad }));
                assert!(r.is_some(), "the channel is ours even for a bad host");
                assert!(
                    r.unwrap().is_err(),
                    "a hostile host must be refused, not stored: {bad:?}"
                );
            }
        });
    }

    /// Clearing removes every entry, so the IP-leak defence is restorable in one action —
    /// which is the property that makes this list safe to expose in a UI.
    #[test]
    fn clearing_restores_the_defence_for_every_host() {
        with_tmp_app(|app| {
            for h in ["a.example", "b.example"] {
                dispatch(app, "webrtc.toggleExempt", &json!({ "host": h }))
                    .unwrap()
                    .unwrap();
            }
            assert!(host_exempt(app, "a.example") && host_exempt(app, "b.example"));
            dispatch(app, "webrtc.clearExempt", &json!({}))
                .unwrap()
                .unwrap();
            assert!(!host_exempt(app, "a.example"));
            assert!(!host_exempt(app, "b.example"));
        });
    }

    /// The app-free global is what the JNI document-start path reads, so it must agree with
    /// the store after a mutation — a divergence would mean Android's tier disagreed with
    /// every other platform, which is the exact class of bug this wave has been fixing.
    #[test]
    fn the_app_free_global_tracks_every_mutation() {
        with_tmp_app(|app| {
            seed_from_disk(app);
            assert!(!android_host_exempt("m.example"), "nothing stored yet");
            dispatch(app, "webrtc.toggleExempt", &json!({ "host": "m.example" }))
                .unwrap()
                .unwrap();
            assert!(android_host_exempt("m.example"), "a toggle must reseed");
            assert!(android_host_exempt("sub.m.example"), "and keep the scope");
            dispatch(app, "webrtc.removeExempt", &json!({ "host": "m.example" }))
                .unwrap()
                .unwrap();
            assert!(!android_host_exempt("m.example"), "a removal must reseed");
        });
    }

    /// A `getExemptHosts` reply carries the array, so the UI can render the list without a
    /// second round trip.
    #[test]
    fn the_state_reply_lists_the_exempt_hosts() {
        with_tmp_app(|app| {
            dispatch(app, "webrtc.toggleExempt", &json!({ "host": "s.example" }))
                .unwrap()
                .unwrap();
            let s = dispatch(app, "webrtc.getExemptHosts", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(s["exemptHosts"], json!(["s.example"]));
        });
    }

    /// Guards the `removeExempt` reply: it must name the host it removed, or a UI cannot
    /// tell a no-op removal from a real one.
    #[test]
    fn removing_reports_the_host_it_removed() {
        with_tmp_app(|app| {
            let r = dispatch(
                app,
                "webrtc.removeExempt",
                &json!({ "host": "never.example" }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(r["removed"], json!("never.example"));
        });
    }

    /// Non-`webrtc.*` channels must fall through untouched, or the new dispatch would
    /// shadow another module's channel.
    #[test]
    fn a_foreign_channel_is_not_claimed() {
        with_tmp_app(|app| {
            assert!(dispatch(app, "adblock.getState", &json!({})).is_none());
            assert!(dispatch(app, "settings.get", &json!({})).is_none());
        });
    }
}
