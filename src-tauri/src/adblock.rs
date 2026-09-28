//! Ad-block on/off + allowlist state, and the `adblock.*` IPC. On Linux,
//! enabling re-installs the WebKit content filters (cached → fast) and disabling
//! removes them.
//!
//! Every tier honours the per-host allowlist, which required a different mechanism in
//! each because they block in genuinely different places:
//!   - the matching engine (`adblock_engine`) just doesn't ask — `set_policy` mirrors the
//!     hosts in, and `should_block` returns "allowed" for an allowlisted page host. This
//!     is the tier Android's `shouldInterceptRequest` and the desktop pop-under check use.
//!   - the declarative WebKit filters (Linux) have no such seam, so the allowlist is
//!     compiled INTO the rules as `ignore-previous-rules` exemptions scoped by
//!     `if-domain` (`adblock_convert::allowlist_exemptions`), and an allowlist change
//!     rebuilds them (`after_allowlist_change`).
//!   - the injected JS (`adblock_inject`) is not emitted at all for an allowlisted page.
//!
//! The allowlist doubles as the per-site WebRTC escape hatch ("trusted site"), and unlike
//! the farbling allowlist it is SYNCABLE — see `sync_stores::SYNCABLE`.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::jsonstore;

// --- Blocked-resource counters (the shield badge) ---
// The actual blocking is platform-specific (Linux WebKit content filters, etc.), so
// counting hooks into the per-platform request path: on Linux, the resource-load-started
// signal runs each subresource through the engine and calls `note_blocked` on a match.
static SESSION_BLOCKED: AtomicU32 = AtomicU32::new(0);
static PAGE_BLOCKED: OnceLock<Mutex<HashMap<u32, u32>>> = OnceLock::new();
fn page_map() -> &'static Mutex<HashMap<u32, u32>> {
    PAGE_BLOCKED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Monotonic session total of ad/tracker requests blocked (for the badge + `getState`).
pub fn session_blocked() -> u32 {
    SESSION_BLOCKED.load(Ordering::Relaxed)
}

/// The active tab's current-page blocked count. `getState` returns this so the chrome
/// recovers the count on mount / tab-switch — live `adblock.blockedCount` events emitted
/// before the chrome subscribed (e.g. the restored boot page) would otherwise be lost.
fn active_page_blocked<R: Runtime>(app: &AppHandle<R>) -> u32 {
    let id = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
        .unwrap_or(1);
    page_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .copied()
        .unwrap_or(0)
}

/// Test-only reader for one tab's per-page count, so the close path can be asserted
/// rather than assumed. `#[cfg(test)]` because production reads it through
/// `active_page_blocked` (the active tab only) — the same shape as
/// `nav::tab_has_content`, added for the same reason.
#[cfg(test)]
pub fn test_page_blocked(id: u32) -> u32 {
    page_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .copied()
        .unwrap_or(0)
}

/// Drop tab `id`'s per-page count entirely, rather than zeroing it.
///
/// `zero_page` is a RESET (the same tab navigated again); this is a REMOVAL, because the
/// tab is gone. Without it `PAGE_BLOCKED` is the one process-global table in the crate that
/// nothing ever removes an entry from, so it grows for the process lifetime — and, worse, a
/// REUSED id inherits the dead tab's count. Reuse is reachable: 6(8) established that a
/// hand-edited `tabs.json` or a restored backup can hand back an id that is not in the
/// registry, because allocation only skips ids still present. The shield badge reads
/// `active_page_blocked`, so a new tab would report blocks for a page the user never
/// visited — the badge reporting something untrue.
///
/// Called from `tabs::forget_closed_tab`, the single definition both close paths already
/// use, so this is cleaned on every platform by construction.
pub fn forget_page_blocked(id: u32) {
    page_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
}

/// Pure counter update for one blocked subresource on tab `id`: bumps the monotonic
/// session total and the tab's per-page count, returning `(session, page)`. Split out
/// from `note_blocked` so the accumulation logic is unit-testable without a Tauri
/// `AppHandle` (the emit half needs the app; this half does not).
// Dead on Android and macOS, which wire no request-level block hook — see `note_blocked`.
#[cfg_attr(any(target_os = "android", target_os = "macos"), allow(dead_code))]
fn bump_blocked(id: u32) -> (u32, u32) {
    let session = SESSION_BLOCKED.fetch_add(1, Ordering::Relaxed) + 1;
    let page = {
        let mut m = page_map().lock().unwrap_or_else(|e| e.into_inner());
        let c = m.entry(id).or_insert(0);
        *c += 1;
        *c
    };
    (session, page)
}

/// Pure per-page reset for tab `id` (zero its page count), returning the unchanged
/// session total. Split out from `reset_page` for the same testability reason.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn zero_page(id: u32) -> u32 {
    page_map()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, 0);
    session_blocked()
}

/// Count one blocked subresource on tab `id` and push the running totals to the chrome
/// badge via `adblock.blockedCount`. Called from each platform's request path: Linux's
/// `resource-load-started` hook (`linux_layout::connect_block_counter`) and Windows'
/// WebView2 `WebResourceRequested` handler (`adblock_win`). (Android keeps an equivalent
/// counter in Kotlin — it has no `AppHandle` and no Tauri event bus on the content side —
/// and pushes `window.__aegisBlockedCount` directly; see `MainActivity.kt`.)
///
/// macOS wires no hook either: WKWebView exposes no per-subresource-request callback, so
/// there is nothing to count from and the shield badge stays at 0 there. Dead on Android
/// and macOS; live (via the two call sites above) on Linux and Windows.
#[cfg_attr(any(target_os = "android", target_os = "macos"), allow(dead_code))]
pub fn note_blocked<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let (session, page) = bump_blocked(id);
    crate::emit_event(
        app,
        "adblock.blockedCount",
        json!({ "viewId": id, "page": page, "session": session }),
    );
}

/// Reset a tab's per-page blocked count on a new top-frame navigation, and refresh the
/// badge (page → 0, session unchanged). Called from the desktop nav path (`nav.rs`).
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn reset_page<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let session = zero_page(id);
    crate::emit_event(
        app,
        "adblock.blockedCount",
        json!({ "viewId": id, "page": 0, "session": session }),
    );
}

pub struct AdblockState(pub Mutex<Inner>);

pub struct Inner {
    pub enabled: bool,
    pub allowlist: Vec<String>,
}

impl Default for AdblockState {
    fn default() -> Self {
        AdblockState(Mutex::new(Inner {
            enabled: true,
            allowlist: Vec::new(),
        }))
    }
}

/// The ONE definition of the ad-block allowlist's scope: whether `host` is an exact
/// match for, or a subdomain of, one of `allowlist`'s entries. Allowlisting
/// `example.com` therefore also covers `www.example.com` but NOT `notexample.com`.
///
/// Shared by every tier that cannot ask the engine whether to block (`adblock_engine`'s
/// per-request veto, `adblock_inject`'s compose decision, and `host_allowlisted` below)
/// because each of them previously spelled this out on its own and they had drifted: the
/// engine's was an exact `HashSet` hit with no subdomain case at all, so an allowlisted
/// site's subdomains stayed filtered there while the UI promised otherwise.
///
/// Deliberately byte-exact, like the `adblock::host_allowlisted` expression it replaces:
/// callers normalise case first (the engine lowercases the URL host, and
/// `adblock_engine::set_policy` lowercases on store), so this stays a pure scope test and
/// a case-folding change remains a separate, independently testable decision.
///
/// Allocation-free on purpose — `adblock_engine::should_block` calls this for EVERY
/// intercepted subresource, so the `ends_with(&format!(".{h}"))` idiom it replaces (a
/// String per entry, per request) is not affordable there.
pub fn host_covered(allowlist: &[String], host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    allowlist.iter().any(|entry| {
        if entry.is_empty() {
            return false;
        }
        if host == entry {
            return true;
        }
        // Subdomain test as a byte offset instead of `ends_with(&format!(".{entry}"))`.
        // `>` not `>=` so `host == entry` (already handled) can't be re-matched, and the
        // byte at the boundary must be the dot — which is what keeps `notexample.com`
        // from matching entry `example.com`.
        host.len() > entry.len() + 1
            && host.ends_with(entry.as_str())
            && host.as_bytes()[host.len() - entry.len() - 1] == b'.'
    })
}

/// The WebView2 `COREWEBVIEW2_WEB_RESOURCE_CONTEXT` value -> the ad-block request-type
/// string that type options (`$script`, `$image`, `$stylesheet`, `$xhr`, …) are matched
/// against. The Windows tier used to pass the literal `"other"` for EVERY request, which
/// silently disabled every type option in the bundled lists on Windows while the very same
/// rules blocked everywhere else.
///
/// It lives here, and not in `adblock_win`, for the same reason `host_covered` lives here
/// rather than in each tier: `adblock_win` is `#[cfg(target_os = "windows")]`, so a test for
/// it can never run on the runner that gates this crate, and this table is pure data.
///
/// `context` is the enum's `i32` value, NOT a bitmask — WebView2 reports exactly ONE context
/// per request, so this is a `match` and the fallthrough covers both `OTHER` and anything a
/// future WebView2 release adds. `adblock_win::tests` reads these keys back as the real
/// `COREWEBVIEW2_WEB_RESOURCE_CONTEXT_*` constants, which is the one check a Linux host cannot
/// make by itself: the numbers here are plain integers, and a renumbering by WebView2 would
/// otherwise re-type every request with no signal at all. That test runs on the Windows CI leg
/// (the module is windows-gated) and is kept compiling everywhere by the
/// `x86_64-pc-windows-gnu` cross-check. It cannot be a `const _: () = { assert!(…) }` block
/// instead: comparing `&str` literals is not const-evaluable on the pinned stable toolchain
/// (E0658, `PartialEq` is not yet a const trait).
///
/// Two folds are deliberate. `FETCH` and `XML_HTTP_REQUEST` both become `"xhr"`, because
/// adblock-rs has no `Fetch` variant and `$xhr`/`$xmlhttprequest` are the type options that
/// have to cover `fetch()`. `MANIFEST` is spelled out rather than left in the fallthrough
/// even though adblock-rs folds `"web_manifest"` into `Other`, so a future adblock-rs that
/// distinguishes it needs no change here.
///
/// Gated `any(windows, test)` rather than `allow(dead_code)`: the only production caller is
/// the Windows tier, and a cfg gate keeps the lint on for every other platform while still
/// letting a Linux test reach the table. Same shape as `adblock_engine::enabled()`.
#[cfg(any(target_os = "windows", test))]
pub const fn win_resource_type(context: i32) -> &'static str {
    match context {
        // The names below are the TAIL of each `COREWEBVIEW2_WEB_RESOURCE_CONTEXT_*`
        // constant, elided to keep the table readable; `adblock_win`'s own `mod tests`
        // asserts these same pairs against the real constants.
        1 => "document",      // DOCUMENT
        2 => "stylesheet",    // STYLESHEET
        3 => "image",         // IMAGE
        4 => "media",         // MEDIA
        5 => "font",          // FONT
        6 => "script",        // SCRIPT
        7 | 8 => "xhr",       // XML_HTTP_REQUEST | FETCH
        11 => "websocket",    // WEBSOCKET
        12 => "web_manifest", // MANIFEST
        14 => "ping",         // PING
        15 => "csp_report",   // CSP_VIOLATION_REPORT
        // TEXT_TRACK (9), EVENT_SOURCE (10), SIGNED_EXCHANGE (13), OTHER (16),
        // ALL (0) and any value a future WebView2 adds have no type option of their own.
        _ => "other",
    }
}

/// Whether `host` is covered by the ad-block allowlist. Reused as the WebRTC per-site
/// escape hatch: an allowlisted site is "trusted", so its WebRTC isn't filtered by the
/// shim / native backstops.
#[cfg_attr(target_os = "android", allow(dead_code))] // desktop-only escape hatch in v1
pub fn host_allowlisted<R: Runtime>(app: &AppHandle<R>, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    match app.try_state::<AdblockState>() {
        Some(s) => {
            let g = s.0.lock().unwrap_or_else(|e| e.into_inner());
            host_covered(&g.allowlist, host)
        }
        None => false,
    }
}

/// The live ad-block on/off toggle, for tiers that need to read it WITHOUT going through
/// `dispatch` — chiefly `adblock_inject::script`, which composes the injected JS tier and
/// previously consulted only the allowlist, so turning ad-blocking off left the whole
/// fetch/XHR/cosmetic body plus the pop-under guard live in every new tab.
///
/// Defaults to `true` when the state is absent, matching both `AdblockState::default()`
/// and `state_json`'s no-state branch: a tier that cannot read the policy must not decide
/// to stop blocking.
pub fn enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    match app.try_state::<AdblockState>() {
        Some(s) => s.0.lock().unwrap_or_else(|e| e.into_inner()).enabled,
        None => true,
    }
}

// --- Persisted allowlist (allowlist.json, a syncable store of {host, uuid, hlc, deleted}) ---
// Before this the allowlist was in-memory only (lost on restart). It's now a syncable
// store; the in-memory Inner.allowlist is a fast cache reseeded from it after every change
// and at boot.

/// The live allowlisted hosts from the persisted store.
pub fn load_allowlist_hosts<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    jsonstore::live_hosts(app, "allowlist")
}

/// Add a host (revive a tombstone in place, or stamp a new record).
fn add_host<R: Runtime>(app: &AppHandle<R>, host: &str) -> Result<(), String> {
    jsonstore::add_host(app, "allowlist", host)
}

/// Tombstone a host.
fn remove_host<R: Runtime>(app: &AppHandle<R>, host: &str) -> Result<(), String> {
    jsonstore::remove_host(app, "allowlist", host)
}

/// Tombstone every live host (clear).
fn clear_hosts<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    jsonstore::clear_hosts(app, "allowlist")
}

/// Refresh the in-memory Inner.allowlist cache from the persisted store.
fn reseed_inner<R: Runtime>(app: &AppHandle<R>) {
    let hosts = load_allowlist_hosts(app);
    if let Some(s) = app.try_state::<AdblockState>() {
        s.0.lock().unwrap_or_else(|e| e.into_inner()).allowlist = hosts;
    }
}

/// Seed the (already `.manage()`'d) AdblockState from disk at boot — MUTATE the managed
/// state (it's managed before `setup()` runs, so it can't be constructed with data) — then
/// mirror the policy into the engine. Fixes the restart-loses-allowlist bug on all platforms.
pub fn seed_from_disk<R: Runtime>(app: &AppHandle<R>) {
    reseed_inner(app);
    sync_engine(app);
}

fn state_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    match app.try_state::<AdblockState>() {
        Some(s) => {
            let g = s.0.lock().unwrap_or_else(|e| e.into_inner());
            json!({ "enabled": g.enabled, "allowlistedHosts": g.allowlist, "sessionBlocked": session_blocked(), "pageBlocked": active_page_blocked(app) })
        }
        None => {
            json!({ "enabled": true, "allowlistedHosts": [], "sessionBlocked": session_blocked(), "pageBlocked": active_page_blocked(app) })
        }
    }
}

/// Mirror the ad-block policy (on/off + allowlist) into the matching engine. Android
/// honors it in `shouldInterceptRequest`; Windows in its WebView2 interceptor; all
/// desktops in `nav::on_new_window` (pop-under blocking). On Linux the page-resource
/// blocking is the WebKit content filters (reconfigured directly above) — the engine
/// is consulted only for pop-unders, but it still must honor the toggle + allowlist.
fn sync_engine<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(any(desktop, target_os = "android", test))]
    if let Some(s) = app.try_state::<AdblockState>() {
        let g = s.0.lock().unwrap_or_else(|e| e.into_inner());
        crate::adblock_engine::set_policy(g.enabled, &g.allowlist);
    }
    #[cfg(not(any(desktop, target_os = "android", test)))]
    let _ = app;
}

/// Re-apply every tier that depends on the allowlist after it changed, then nudge sync.
///
/// The Linux rebuild is the step that used to be missing, and it is not optional. WebKit
/// has no "reconfigure the installed filters" call, and the allowlist is compiled INTO the
/// rules as `ignore-previous-rules` exemptions (`adblock_convert::allowlist_exemptions`),
/// so the only way an allowlisted host stops being filtered is to reconvert and reload.
/// Without it, toggling the allowlist did nothing at all on Linux — the tier that blocks
/// every subresource on that platform. The cost is a full ~78k-rule conversion on a
/// background thread, identical to what a filter-list edit already pays
/// (`adblock_refresh::refresh`), and the result is hash-cached, so a repeat is cheap.
fn after_allowlist_change<R: Runtime>(app: &AppHandle<R>) {
    reseed_inner(app); // refresh the in-memory cache from the persisted store
    sync_engine(app);
    #[cfg(target_os = "linux")]
    crate::install_adblock(app.clone());
    crate::sync::nudge(app); // allowlist is SYNCABLE (no-op when sync is disabled)
}

/// Handle `adblock.*` channels. Returns `None` if not an adblock channel.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "adblock.getState" => Some(Ok(state_json(app))),

        "adblock.setEnabled" => {
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if let Some(s) = app.try_state::<AdblockState>() {
                s.0.lock().unwrap_or_else(|e| e.into_inner()).enabled = enabled;
            }
            #[cfg(target_os = "linux")]
            {
                if enabled {
                    crate::install_adblock(app.clone());
                } else {
                    crate::adblock_webkit::remove_all(app);
                }
            }
            sync_engine(app);
            Some(Ok(state_json(app)))
        }

        "adblock.toggleAllowlist" | "adblock.removeAllowlist" => {
            let host = payload
                .get("host")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !host.is_empty() {
                // A failed write is reported, not swallowed — otherwise the caller gets `Ok`,
                // the UI re-renders as if the toggle took, and nothing actually changed.
                // `removeAllowlist` and the "currently listed" toggle both mean the same thing:
                // drop it. Only the not-present case adds.
                let listed = load_allowlist_hosts(app).iter().any(|h| h == &host);
                let saved = if channel == "adblock.removeAllowlist" || listed {
                    remove_host(app, &host)
                } else {
                    add_host(app, &host) // toggle on
                };
                if let Err(e) = saved {
                    return Some(Err(e));
                }
            }
            after_allowlist_change(app);
            Some(Ok(state_json(app)))
        }

        "adblock.clearAllowlist" => {
            // Same contract: a silently-failed "clear all" would resurrect every host.
            if let Err(e) = clear_hosts(app) {
                return Some(Err(e));
            }
            after_allowlist_change(app);
            Some(Ok(state_json(app)))
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;
    use serde_json::Value;

    // ── AppHandle-backed state-machine tests (use the mock harness) ──────────────

    #[test]
    fn default_state_is_enabled_with_empty_allowlist() {
        with_tmp_app(|app| {
            let s = dispatch(app, "adblock.getState", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(s.get("enabled").and_then(Value::as_bool), Some(true));
            assert!(s
                .get("allowlistedHosts")
                .and_then(Value::as_array)
                .unwrap()
                .is_empty());
        });
    }

    #[test]
    fn set_enabled_flips_the_flag() {
        with_tmp_app(|app| {
            let off = dispatch(app, "adblock.setEnabled", &json!({ "enabled": false }))
                .unwrap()
                .unwrap();
            assert_eq!(
                off.get("enabled").and_then(Value::as_bool),
                Some(false),
                "flag is false after setEnabled(false)"
            );
            let on = dispatch(app, "adblock.setEnabled", &json!({ "enabled": true }))
                .unwrap()
                .unwrap();
            assert_eq!(
                on.get("enabled").and_then(Value::as_bool),
                Some(true),
                "flag is true after setEnabled(true)"
            );
        });
    }

    #[test]
    fn toggle_allowlist_adds_then_removes_and_persists() {
        with_tmp_app(|app| {
            // toggle on
            let on = dispatch(
                app,
                "adblock.toggleAllowlist",
                &json!({ "host": "ads.example.com" }),
            )
            .unwrap()
            .unwrap();
            let hosts: Vec<&str> = on
                .get("allowlistedHosts")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert!(
                hosts.contains(&"ads.example.com"),
                "host appears in allowlistedHosts after toggle-on"
            );
            assert_eq!(
                load_allowlist_hosts(app),
                vec!["ads.example.com".to_string()],
                "persisted store reflects the added host"
            );
            // toggle off
            let off = dispatch(
                app,
                "adblock.toggleAllowlist",
                &json!({ "host": "ads.example.com" }),
            )
            .unwrap()
            .unwrap();
            assert!(
                off.get("allowlistedHosts")
                    .and_then(Value::as_array)
                    .unwrap()
                    .is_empty(),
                "allowlistedHosts is empty after toggle-off"
            );
            assert!(
                load_allowlist_hosts(app).is_empty(),
                "persisted store is empty after toggle-off"
            );
        });
    }

    // ── `host_covered`: the shared allowlist-scope predicate ──────────────────────
    //
    // Pure and global-state-free, so it needs no lock. It is the ONE definition every tier
    // goes through, so these cases are the contract for all of them — the engine's
    // per-request veto, the injected-JS compose decision, and `host_allowlisted` below.
    #[test]
    fn host_covered_is_exact_or_subdomain() {
        let al = vec!["example.com".to_string()];
        // exact
        assert!(host_covered(&al, "example.com"));
        // subdomains, at any depth
        assert!(host_covered(&al, "www.example.com"));
        assert!(host_covered(&al, "a.b.c.example.com"));
        // NOT a suffix match: `notexample.com` and `example.com.evil.test` are unrelated
        // hosts that merely end with (or contain) the entry.
        assert!(
            !host_covered(&al, "notexample.com"),
            "suffix, not substring"
        );
        assert!(
            !host_covered(&al, "example.com.evil.test"),
            "must not match an entry that is only a PREFIX of the host"
        );
        // a leading-dot entry (`host == entry` would be false, but the subdomain test
        // must not accidentally match the bare host either)
        assert!(!host_covered(&al, "ample.com"));
        // empty host never matches
        assert!(!host_covered(&al, ""));
        // an empty entry must not match everything (the `host.len() > entry.len() + 1`
        // arithmetic would underflow-then-pass on an empty entry if unguarded)
        assert!(!host_covered(&[String::new()], "example.com"));
        // multiple entries, and the empty-host guard applies to the caller too
        let many = vec!["a.test".to_string(), "b.test".to_string()];
        assert!(host_covered(&many, "x.b.test"));
        assert!(!host_covered(&many, "c.test"));
        assert!(
            !host_covered(&[], "anything.test"),
            "empty list covers nothing"
        );
    }

    /// The subdomain case is what the ENGINE tier was missing. `adblock_engine`'s veto used
    /// to be an exact `HashSet` hit, so an allowlisted `example.com` still had requests from
    /// `www.example.com` blocked while `adblock::host_allowlisted` (and the UI) said the
    /// whole site was trusted. This drives the real engine, so it takes the process-global
    /// lock (`adblock_engine`'s policy statics are process-wide — see that module's notes).
    #[test]
    fn engine_veto_covers_subdomains_of_an_allowlisted_host() {
        let _guard = crate::test_support::lock();
        crate::adblock_engine::set_policy(true, &["trusted.example".to_string()]);
        // The shared predicate the engine now calls must agree with `host_allowlisted`.
        assert!(
            crate::adblock_engine::host_is_allowlisted("www.trusted.example"),
            "an allowlisted host must cover its subdomains at the engine tier, not just \
             an exact hit"
        );
        assert!(!crate::adblock_engine::host_is_allowlisted(
            "untrusted.example"
        ));
        // Reset so no other test sees a mutated engine.
        crate::adblock_engine::set_policy(true, &[]);
    }

    #[test]
    fn host_allowlisted_covers_subdomains() {
        with_tmp_app(|app| {
            dispatch(
                app,
                "adblock.toggleAllowlist",
                &json!({ "host": "example.com" }),
            )
            .unwrap()
            .unwrap();
            assert!(
                host_allowlisted(app, "example.com"),
                "exact host is allowlisted"
            );
            assert!(
                host_allowlisted(app, "www.example.com"),
                "subdomain is covered by the allowlist entry"
            );
            assert!(
                !host_allowlisted(app, "notexample.com"),
                "unrelated host is not allowlisted"
            );
            assert!(!host_allowlisted(app, ""), "empty string never matches");
        });
    }

    #[test]
    fn clear_allowlist_tombstones_everything() {
        with_tmp_app(|app| {
            dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "a.test" }))
                .unwrap()
                .unwrap();
            dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "b.test" }))
                .unwrap()
                .unwrap();
            let cleared = dispatch(app, "adblock.clearAllowlist", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                cleared
                    .get("allowlistedHosts")
                    .and_then(Value::as_array)
                    .unwrap()
                    .is_empty(),
                "getState returns empty allowlistedHosts after clearAllowlist"
            );
            assert!(
                load_allowlist_hosts(app).is_empty(),
                "persisted store is empty after clearAllowlist"
            );
        });
    }

    #[test]
    fn note_blocked_increments_session_and_page_counters() {
        with_tmp_app(|app| {
            let tab_id = 9201u32; // disjoint from Plan G's tab ids
            zero_page(tab_id);
            let before = session_blocked();
            note_blocked(app, tab_id);
            note_blocked(app, tab_id);
            assert_eq!(
                session_blocked(),
                before + 2,
                "session total increments by 2 after two note_blocked calls"
            );
            // reset_page zeroes per-page count; session total is unchanged.
            let session_after = session_blocked();
            reset_page(app, tab_id);
            assert_eq!(
                session_blocked(),
                session_after,
                "session total is unchanged after reset_page"
            );
            assert_eq!(
                page_map()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&tab_id)
                    .copied(),
                Some(0),
                "per-page count is zero after reset_page"
            );
        });
    }

    // ── Pure counter tests (no AppHandle needed — Plan G) ────────────────────────

    // SESSION_BLOCKED is process-global; these tests reset it and use disjoint tab ids
    // so they don't interfere. They run single-threaded relative to each other only by
    // not sharing tab ids — the session counter assertions read deltas, not absolutes.
    #[test]
    fn page_count_accumulates_per_tab_and_resets() {
        let id = 9001; // a tab id no other test uses
        zero_page(id);
        let (_s1, p1) = bump_blocked(id);
        let (_s2, p2) = bump_blocked(id);
        assert_eq!(p1, 1);
        assert_eq!(p2, 2, "page count accumulates within a tab");
        let s = zero_page(id);
        assert_eq!(
            page_map()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                .copied(),
            Some(0)
        );
        // zero_page returns the *session* total, which is monotonic and unaffected.
        let (s_after, p_after) = bump_blocked(id);
        assert_eq!(p_after, 1, "page count restarts at 1 after a reset");
        assert!(
            s_after >= s,
            "session total is monotonic across a page reset"
        );
    }

    #[test]
    fn session_count_is_shared_across_tabs_and_monotonic() {
        let (a, b) = (9101, 9102);
        zero_page(a);
        zero_page(b);
        let before = session_blocked();
        let (sa, pa) = bump_blocked(a);
        let (sb, pb) = bump_blocked(b);
        assert_eq!(pa, 1, "tab a's page count is independent");
        assert_eq!(pb, 1, "tab b's page count is independent");
        assert!(sb > sa, "session total advances across different tabs");
        // SESSION_BLOCKED is global — other tests may interleave, so we assert
        // deltas relative to `before` rather than exact values.
        assert!(sa > before, "sa advanced past before");
        assert!(sb >= before + 2, "sb advanced past sa");
    }
    /// The Windows network tier handed the engine the literal `"other"` for every
    /// intercepted request, so every `$script` / `$image` / `$stylesheet` / `$xhr` type
    /// option in EasyList and EasyPrivacy was dead on Windows while working on every other
    /// platform. `win_resource_type` is the fix; this is the table's own half.
    ///
    /// The keys here are plain integers, so on their own they mean nothing: it is
    /// `adblock_win`'s own `mod tests` that pins each integer to the real
    /// `COREWEBVIEW2_WEB_RESOURCE_CONTEXT_*` constant. That module only RUNS on the
    /// Windows CI leg, but the gnu cross-check compiles it, and a `const _: () =`
    /// compile-time proof is impossible here (E0658: `&str` equality is not yet a
    /// const trait), which is why it is a test rather than an assertion in a
    /// constant. These asserts are about the value -> adblock-type half; that module
    /// is about the value -> WebView2-constant half. Neither is redundant.
    #[test]
    fn every_webview2_context_maps_to_the_adblock_type_that_can_match_it() {
        for (context, expected, name) in [
            (1, "document", "DOCUMENT"),
            (2, "stylesheet", "STYLESHEET"),
            (3, "image", "IMAGE"),
            (4, "media", "MEDIA"),
            (5, "font", "FONT"),
            (6, "script", "SCRIPT"),
            (7, "xhr", "XML_HTTP_REQUEST"),
            (8, "xhr", "FETCH"),
            (11, "websocket", "WEBSOCKET"),
            (12, "web_manifest", "MANIFEST"),
            (14, "ping", "PING"),
            (15, "csp_report", "CSP_VIOLATION_REPORT"),
            // The four WebView2 contexts adblock-rs has no type option for, plus its own
            // catch-all. These are the ONLY ones allowed to answer "other".
            (0, "other", "ALL"),
            (9, "other", "TEXT_TRACK"),
            (10, "other", "EVENT_SOURCE"),
            (13, "other", "SIGNED_EXCHANGE"),
            (16, "other", "OTHER"),
        ] {
            assert_eq!(
                win_resource_type(context),
                expected,
                "WebView2 context {context} ({name}) must map to {expected:?}"
            );
        }
    }

    /// The defect in one assertion: a context a rule CAN name must never fall through to
    /// `"other"`, because adblock-rs only consults a `$type` option when the request's type
    /// matches it.
    #[test]
    fn no_context_a_filter_can_target_collapses_to_other() {
        for (context, name) in [
            (1, "DOCUMENT"),
            (2, "STYLESHEET"),
            (3, "IMAGE"),
            (4, "MEDIA"),
            (5, "FONT"),
            (6, "SCRIPT"),
            (7, "XML_HTTP_REQUEST"),
            (8, "FETCH"),
            (11, "WEBSOCKET"),
            (12, "MANIFEST"),
            (14, "PING"),
            (15, "CSP_VIOLATION_REPORT"),
        ] {
            assert_ne!(
                win_resource_type(context),
                "other",
                "WebView2 context {context} ({name}) stays typed — a `$type` option in the \
                 bundled lists can only match a typed request"
            );
        }
    }

    /// A future WebView2 that adds a context, or a corrupt value arriving through COM, must
    /// answer `other` — the string the pre-fix code sent for everything — rather than
    /// panic or fall into a neighbouring arm.
    #[test]
    fn an_unrecognised_context_is_reported_as_other_rather_than_guessed_at() {
        for context in [17, 18, 99, -1, i32::MAX, i32::MIN] {
            assert_eq!(
                win_resource_type(context),
                "other",
                "an unknown WebView2 context {context} must not be mapped to a real type"
            );
        }
    }
}
