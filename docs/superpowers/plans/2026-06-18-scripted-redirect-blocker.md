# Scripted Cross-Origin Top-Frame Redirect Blocker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block scripted (non-user-gesture) cross-origin top-frame navigations in the content webview on all four platforms, cancelling the navigation and surfacing a toast with an "Open anyway" action — without breaking normal browsing.

**Architecture:** A pure, unit-tested Rust predicate (`redirect_guard.rs`) holds the policy and an app-initiated-navigation registry; each platform's native nav-policy hook (Linux `decide-policy`, Windows `NavigationStarting`, macOS `WKNavigationDelegate`, Android `shouldOverrideUrlLoading`+JNI) derives the four inputs and cancels + emits a `redirect.blocked` event. The chrome raises a toast whose "Open anyway" reuses the existing `tabs.create` to open the URL in a new tab.

**Tech Stack:** Rust (Tauri 2, webkit2gtk 2.0.2, webview2-com, objc2-web-kit 0.3.2, jni), React 19 + TypeScript (vitest), Kotlin (Android WebView).

**Reference spec:** `docs/superpowers/specs/2026-06-18-scripted-redirect-blocker-design.md`

---

## Conventions & key facts (read once before starting)

- **IPC chokepoint:** add a channel/event in three places — `shared/types.ts` (`IPC` const + `AegisApi`), the Rust dispatcher / `emit_event`, and `src/lib/ipcClient.ts`. (This feature adds **one event only**, `redirect.blocked`; "Open anyway" reuses the existing `tabs.create`.)
- **Event names:** keep dotted in `shared/types.ts`; `emit_event` (`lib.rs:76`) translates `.`→`:`; `tauriInvoke.ts:20` (`on()`) translates back. Never emit a raw dotted name.
- **`Url`** is re-exported from `tauri` (`use tauri::Url;`); `Url::origin()` is available (url 2.5.8, transitive).
- **Field naming:** events use `viewId` (e.g. `BlockedCount.viewId` at `shared/types.ts:222`), not `tabId`. Use `viewId` in the `RedirectBlocked` payload.
- **Test commands:**
  - Rust: `cd src-tauri && cargo test` (unit tests live in `#[cfg(test)] mod tests` in each file, e.g. `nav.rs:480`).
  - TS: `npm test` (vitest; node project for `shared/`+`scripts/`, jsdom for `src/`); targeted: `npx vitest run src/lib/toast.test.ts`.
  - Windows cross-check (from Linux, mingw installed): `cd src-tauri && cargo check --target x86_64-pc-windows-gnu`.
  - Android Rust gate: `cd src-tauri && AR_aarch64_linux_android=$NDK/.../llvm-ar CC_… cargo check --target aarch64-linux-android` (see `memory/aegis-android-build-gates-runnable-locally.md` for the exact env block).
  - Android Kotlin gate: `cd src-tauri/gen/android && ./gradlew compileUniversalDebugKotlin`.
  - macOS: **cannot build on this Linux host** (objc2 needs a macOS C toolchain) — CI-only (`tauri-build-check.yml`, macos-latest).
- **TDD:** write the failing test first, see it fail, implement minimally, see it pass, commit.

---

## File structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `src-tauri/src/redirect_guard.rs` | **Create** | Pure `should_block` + `is_cross_origin_http`; `PendingNavs` registry; `decide`; app-level `expect`/`decide_for`/`on_blocked`; Android JNI export. |
| `src-tauri/src/nav.rs` | Modify | `navigate_tab` helper; route the 5 `.navigate()` call sites + `spawn_tab` initial load; wire per-platform glue into `spawn_tab`. |
| `src-tauri/src/linux_layout.rs` | Modify | `connect_redirect_guard` (`decide-policy` hook). |
| `src-tauri/src/nav_policy_win.rs` | **Create** | Windows `add_NavigationStarting` handler. |
| `src-tauri/src/nav_policy_mac.rs` | **Create** | macOS `WKNavigationDelegate` (`decidePolicyForNavigationAction`). |
| `src-tauri/src/lib.rs` | Modify | `mod` decls; `.manage(PendingNavs::default())`. |
| `src-tauri/gen/android/.../MainActivity.kt` | Modify | Redirect guard in `shouldOverrideUrlLoading` + `window.__aegisRedirectBlocked` bridge. |
| `src-tauri/gen/android/.../NativeRedirectGuard.kt` | **Create** | Kotlin `external fun shouldBlock`. |
| `shared/types.ts` | Modify | `evtRedirectBlocked` channel + `RedirectBlocked` type + `AegisApi.redirect.onBlocked`. |
| `src/lib/ipcClient.ts` | Modify | `redirect.onBlocked` subscription (+ Android bridge branch). |
| `src/lib/toast.ts` | Modify | Optional `action` on toasts; `info(msg, opts)` signature. |
| `src/components/Toaster.tsx` | Modify | Render the action button. |
| `src/App.tsx` | Modify | `redirect.onBlocked` listener → toast with "Open anyway". |
| `src-tauri/CLAUDE.md`, `shared/CLAUDE.md` | Modify | Document the new hook + event. |
| Test files | Create | `redirect_guard` cargo tests (in-file); `src/lib/toast.test.ts`; `src/components/Toaster.test.tsx`. |

---

## Phase 1 — Pure core (platform-independent, fully testable)

### Task 1: `redirect_guard::should_block` + `is_cross_origin_http`

**Files:**
- Create: `src-tauri/src/redirect_guard.rs`
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Create the file with the predicate + failing tests**

```rust
// src-tauri/src/redirect_guard.rs
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
```

- [ ] **Step 2: Add `mod redirect_guard;` so it compiles & tests run**

In `src-tauri/src/lib.rs`, add alongside the other adblock-engine-style mods (near `lib.rs:11`, after `mod adblock_engine;`):

```rust
#[cfg(any(desktop, target_os = "android", test))]
mod redirect_guard;
```

- [ ] **Step 3: Run the tests — expect FAIL first, then PASS**

Run: `cd src-tauri && cargo test redirect_guard`
Expected: all `redirect_guard::tests::*` PASS (7 tests). If `Url::origin` errors, confirm `use tauri::Url;`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/redirect_guard.rs src-tauri/src/lib.rs
git commit -m "feat(redirect-guard): pure cross-origin top-frame predicate"
```

---

### Task 2: `PendingNavs` registry + `decide`

**Files:**
- Modify: `src-tauri/src/redirect_guard.rs`

- [ ] **Step 1: Add the registry, `same_target`, and `decide` with failing tests**

Append to `redirect_guard.rs` (above the `#[cfg(test)]` module):

```rust
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
```

Add these tests inside the existing `mod tests`:

```rust
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
```

- [ ] **Step 2: Run tests — expect PASS**

Run: `cd src-tauri && cargo test redirect_guard`
Expected: all (12) tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/redirect_guard.rs
git commit -m "feat(redirect-guard): app-initiated nav registry + decide()"
```

---

### Task 3: App-level glue (`expect`/`decide_for`/`on_blocked`) + state registration

**Files:**
- Modify: `src-tauri/src/redirect_guard.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1: Add the AppHandle wrappers to `redirect_guard.rs`**

Add near the top (after the `use tauri::Url;` line, add `Manager`):

```rust
use tauri::{AppHandle, Manager};
```

Append these functions (after `decide`):

```rust
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
```

> Note: `try_state`/`AppHandle`/`emit_event` aren't available under `test`, but they're only referenced by non-test code; `cargo test` still compiles them. If `cargo test` complains about unused `Manager` import under some cfg, that's fine — keep it; it's used by `expect`/`decide_for`.

- [ ] **Step 2: Register the state in `lib.rs`**

In `src-tauri/src/lib.rs`, in the `.manage(...)` chain (`lib.rs:380-384`), add a line:

```rust
        .manage(sync::SyncState::default());
```
becomes:
```rust
        .manage(sync::SyncState::default())
        .manage(redirect_guard::PendingNavs::default());
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cd src-tauri && cargo build`
Expected: compiles cleanly (no warnings about `PendingNavs` unused — it's now managed).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/redirect_guard.rs src-tauri/src/lib.rs
git commit -m "feat(redirect-guard): app-level expect/decide_for/on_blocked + managed state"
```

---

## Phase 2 — Navigation chokepoint (desktop)

### Task 4: `nav::navigate_tab` + route all app navigations through it

**Files:**
- Modify: `src-tauri/src/nav.rs` (helper + call sites `214`, `418`, `430`, `440`, `452`, and `spawn_tab`)

- [ ] **Step 1: Add the `navigate_tab` helper + a `label_id` helper**

In `src-tauri/src/nav.rs`, after `content_label` (`nav.rs:38-41`), add:

```rust
/// Parse the tab id out of a `content:{id}` label (defaults to 1).
fn label_id(label: &str) -> u32 {
    label.strip_prefix("content:").and_then(|s| s.parse().ok()).unwrap_or(1)
}

/// Navigate a tab's content webview, FIRST registering the target as an
/// app-initiated navigation so the redirect guard never blocks it. Every
/// programmatic content navigation must go through here.
#[cfg(desktop)]
pub fn navigate_tab(app: &AppHandle, id: u32, url: Url) {
    crate::redirect_guard::expect(app, id, url.as_str());
    if let Some(w) = app.get_webview(&content_label(id)) {
        let _ = w.navigate(url);
    }
}
```

- [ ] **Step 2: Route the HTTPS-Only upgrade (`nav.rs:204-214`)**

The upgrade currently does (inside `run_on_main_thread`, ~`nav.rs:210-214`):
```rust
            if let (Some(w), Ok(p)) = (app_main.get_webview(&lbl), Url::parse(&https)) {
                let _ = w.navigate(p);
            }
```
Replace with (register before navigating; `nav_id` is in scope here):
```rust
            if let Ok(p) = Url::parse(&https) {
                crate::redirect_guard::expect(&app_main, nav_id, p.as_str());
                if let Some(w) = app_main.get_webview(&lbl) {
                    let _ = w.navigate(p);
                }
            }
```

- [ ] **Step 3: Route the dispatch arms (`nav.navigate` 418, `nav.back` 430, `nav.forward` 440, `nav.home` 452)**

In `dispatch` (`nav.rs:406`), these arms call `w.navigate(...)` on `content` for `label`. Register each. The `nav.navigate` arm (`nav.rs:413-421`) becomes:

```rust
        "nav.navigate" => {
            let url_s = payload.get("url").and_then(|v| v.as_str()).unwrap_or("");
            match Url::parse(url_s) {
                Ok(u) => match content {
                    Some(w) => {
                        crate::redirect_guard::expect(app, label_id(&label), u.as_str());
                        w.navigate(u).map(|_| Value::Null).map_err(|e| e.to_string())
                    }
                    None => Ok(Value::Null),
                },
                Err(e) => Err(format!("invalid url '{url_s}': {e}")),
            }
        }
```

For `nav.back` (`nav.rs:430`) and `nav.forward` (`nav.rs:440`), each has `if let Ok(u) = Url::parse(&url) { let _ = w.navigate(u); }` — change to:
```rust
            if let Ok(u) = Url::parse(&url) {
                crate::redirect_guard::expect(app, label_id(&label), u.as_str());
                let _ = w.navigate(u);
            }
```

For `nav.home` (`nav.rs:452`) `let _ = w.navigate(crate::settings::home_url(app));` — change to:
```rust
            let home = crate::settings::home_url(app);
            crate::redirect_guard::expect(app, label_id(&label), home.as_str());
            let _ = w.navigate(home);
```

- [ ] **Step 4: Register the initial load in `spawn_tab` (`nav.rs:104`)**

Near the top of `spawn_tab`, right after `let label = content_label(id);`, add:
```rust
    crate::redirect_guard::expect(app, id, url.as_str());
```
(The initial page load reaches the policy hook as a gesture-less navigation; this exempts it.)

- [ ] **Step 5: Build & run existing tests**

Run: `cd src-tauri && cargo build && cargo test`
Expected: compiles; all existing tests still pass (no behavior change yet — nothing reads the registry except `decide`, which no platform calls until Phase 3+).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/nav.rs
git commit -m "feat(redirect-guard): route all app navigations through navigate_tab/expect"
```

---

## Phase 3 — Linux (spike first, then implement)

### Task 5: Linux `decide-policy` SPIKE (investigation — resolves §8 risks 1 & 2)

**Goal:** Empirically determine, before building blocking logic: (a) a second `connect_decide_policy` handler RUNS alongside wry's; (b) it sees `NavigationAction` with gesture/type/target; (c) `decision.ignore()` actually cancels; (d) the reliable main-frame discriminator. **This is investigative, not TDD.**

**Files:**
- Modify: `src-tauri/src/linux_layout.rs` (temporary logging hook), `src-tauri/src/nav.rs` (call it for Linux)

- [ ] **Step 1: Add a logging-only `decide-policy` handler**

In `linux_layout.rs`, add (mirrors `connect_block_counter` at `linux_layout.rs:73`):

```rust
/// SPIKE (temporary): log every decide-policy NavigationAction to learn whether a
/// second handler runs, what it sees, and whether ignore() cancels.
pub fn spike_decide_policy(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else { return };
    let _ = content.with_webview(move |pw| {
        use webkit2gtk::{PolicyDecisionExt, NavigationPolicyDecisionExt, WebViewExt, URIRequestExt};
        pw.inner().connect_decide_policy(move |wv, decision, dtype| {
            if dtype != webkit2gtk::PolicyDecisionType::NavigationAction {
                return false;
            }
            if let Some(nav) = decision.dynamic_cast_ref::<webkit2gtk::NavigationPolicyDecision>() {
                if let Some(mut action) = nav.navigation_action() {
                    let target = action.request().and_then(|r| r.uri()).map(|s| s.to_string()).unwrap_or_default();
                    let current = wv.uri().map(|s| s.to_string()).unwrap_or_default();
                    eprintln!(
                        "[aegis-spike] decide-policy type={:?} gesture={} redirect={} frame_name={:?} current={} target={}",
                        action.navigation_type(),
                        action.is_user_gesture(),
                        action.is_redirect(),
                        action.frame_name(),
                        current,
                        target,
                    );
                }
            }
            false // do NOT interfere yet — observe only
        });
    });
}
```

Call it in `spawn_tab`'s Linux block (`nav.rs:344`), after `connect_block_counter`:
```rust
        crate::linux_layout::spike_decide_policy(app, &label);
```

- [ ] **Step 2: Run the app and observe (the empirical "test")**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && AEGIS_NAV_DEBUG=1 npm run tauri:dev` (see `memory/aegis-live-testing-setup.md`).
Then, in the running browser: (1) load a normal page and click a link; (2) load a page with a cross-origin iframe (e.g. a YouTube embed); (3) load streamex and let it attempt its redirect; (4) type a URL in the address bar.

Record in the commit message / a scratch note:
- Does `[aegis-spike]` print at all? (→ a second handler runs.)
- For the streamex redirect: `type=Other gesture=false`? For a link click: `type=LinkClicked gesture=true`?
- `frame_name` value for the **main frame** vs an **iframe** navigation (this decides main-frame detection).
- Whether changing the temporary `false` to `{ decision.ignore(); true }` for a chosen test URL actually cancels the navigation (test once manually, then revert).

- [ ] **Step 3: Decide main-frame detection + cancel semantics**

From the observations, choose:
- `MAIN_FRAME_EXPR` — e.g. `action.frame_name().is_none()` if iframes reliably report a name / differ; otherwise the spike's proven alternative.
- The handler return contract — whether returning `true` after `decision.ignore()` is required to cancel.

Write the two decisions into the Task 6 implementation. If the spike shows a second handler does **not** run or cannot cancel, STOP and escalate (see spec §8 fallbacks) before Task 6.

- [ ] **Step 4: Remove the spike, commit the findings**

Delete `spike_decide_policy` and its call. Commit:
```bash
git add src-tauri/src/linux_layout.rs src-tauri/src/nav.rs
git commit -m "chore(redirect-guard): Linux decide-policy spike findings (see message)

Findings: second handler runs=<Y/N>; ignore() cancels=<Y/N>;
main-frame detection=<expr>; scripted redirect shows type=Other gesture=false."
```

---

### Task 6: Linux `connect_redirect_guard` (real blocking)

**Files:**
- Modify: `src-tauri/src/linux_layout.rs`, `src-tauri/src/nav.rs:344` (Linux block)

> Use `MAIN_FRAME_EXPR` and the cancel contract determined in Task 5. The code below assumes the spike confirmed `frame_name().is_none()` for the main frame and that `{ ignore(); true }` cancels — adjust to the spike's actual findings.

- [ ] **Step 1: Add `connect_redirect_guard`**

In `linux_layout.rs`:

```rust
/// Cancel scripted (non-user-gesture) cross-origin top-frame redirects on this tab.
/// Connects a second `decide-policy` handler (verified to run + cancel in the Task 5
/// spike). The policy itself lives in `redirect_guard` (shared with the other platforms).
pub fn connect_redirect_guard(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else { return };
    let Some(id) = label.strip_prefix("content:").and_then(|s| s.parse::<u32>().ok()) else { return };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        use webkit2gtk::{PolicyDecisionExt, NavigationPolicyDecisionExt, WebViewExt, URIRequestExt};
        pw.inner().connect_decide_policy(move |wv, decision, dtype| {
            if dtype != webkit2gtk::PolicyDecisionType::NavigationAction {
                return false;
            }
            let Some(nav) = decision.dynamic_cast_ref::<webkit2gtk::NavigationPolicyDecision>() else {
                return false;
            };
            let Some(mut action) = nav.navigation_action() else { return false };
            let scripted = action.navigation_type() == webkit2gtk::NavigationType::Other
                && !action.is_user_gesture();
            let is_redirect = action.is_redirect();
            let main_frame = action.frame_name().is_none(); // MAIN_FRAME_EXPR from Task 5
            let target = action.request().and_then(|r| r.uri()).map(|s| s.to_string()).unwrap_or_default();
            let current = wv.uri().map(|s| s.to_string()).unwrap_or_default();
            if crate::redirect_guard::decide_for(&app, id, &current, &target, scripted, main_frame, is_redirect) {
                decision.ignore();
                crate::redirect_guard::on_blocked(&app, id, &current, &target);
                return true; // cancel contract from Task 5
            }
            false
        });
    });
}
```

- [ ] **Step 2: Wire it into `spawn_tab` Linux block (`nav.rs:344`)**

After `crate::linux_layout::connect_block_counter(app, &label);` add:
```rust
        crate::linux_layout::connect_redirect_guard(app, &label);
```

- [ ] **Step 3: Build + live-verify (the test)**

Run: `cd src-tauri && cargo build`, then `cd .. && AEGIS_NAV_DEBUG=1 npm run tauri:dev`.
Verify:
- streamex no longer bounces to `google.com`; `[aegis-redirect] BLOCK …` logs.
- Address-bar navigation, link clicks, a cross-origin iframe embed, and a URL shortener all still work (no false block).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/linux_layout.rs src-tauri/src/nav.rs
git commit -m "feat(redirect-guard): Linux decide-policy blocking + event"
```

---

## Phase 4 — Chrome UX (toast + Open-anyway)

### Task 7: Toast action support (`toast.ts`)

**Files:**
- Modify: `src/lib/toast.ts`
- Test: `src/lib/toast.test.ts` (create)

- [ ] **Step 1: Write failing tests**

Create `src/lib/toast.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toast, subscribeToasts, __resetToasts, type ToastItem } from './toast';

describe('toast actions', () => {
  beforeEach(() => __resetToasts());

  it('attaches an action to the toast', () => {
    let latest: ToastItem[] = [];
    const off = subscribeToasts((t) => { latest = t; });
    const onClick = vi.fn();
    toast.info('Blocked a redirect to evil.com', { action: { label: 'Open anyway', onClick } });
    expect(latest).toHaveLength(1);
    expect(latest[0].message).toContain('evil.com');
    expect(latest[0].action?.label).toBe('Open anyway');
    latest[0].action?.onClick();
    expect(onClick).toHaveBeenCalledOnce();
    off();
  });

  it('respects a custom duration', () => {
    vi.useFakeTimers();
    let latest: ToastItem[] = [];
    subscribeToasts((t) => { latest = t; });
    toast.info('x', { durationMs: 6000 });
    vi.advanceTimersByTime(4000);
    expect(latest).toHaveLength(1); // not yet dismissed at the old 4s default
    vi.advanceTimersByTime(2000);
    expect(latest).toHaveLength(0);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run src/lib/toast.test.ts`
Expected: FAIL (`toast.info` takes one arg; no `action` on `ToastItem`).

- [ ] **Step 3: Implement**

In `src/lib/toast.ts`:
- Add the action type + field:
```ts
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}
```
- Change `push` to accept options:
```ts
interface PushOpts {
  action?: ToastAction;
  durationMs?: number;
}

function push(kind: ToastKind, message: string, opts: PushOpts = {}): void {
  const item: ToastItem = { id: nextId++, kind, message, action: opts.action };
  toasts = [...toasts, item];
  emit();
  const handle = setTimeout(() => {
    dismissTimers.delete(item.id);
    toasts = toasts.filter((t) => t.id !== item.id);
    emit();
  }, opts.durationMs ?? 4000);
  dismissTimers.set(item.id, handle);
}
```
- Update the public API so `info` accepts options (keep `success`/`error` as-is):
```ts
export const toast = {
  success(m: string): void { push('success', m); },
  error(m: string): void { push('error', m); },
  info(m: string, opts?: { action?: ToastAction; durationMs?: number }): void {
    push('info', m, opts);
  },
};
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run src/lib/toast.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/toast.ts src/lib/toast.test.ts
git commit -m "feat(toast): optional action button + custom duration"
```

---

### Task 8: Render the action in `<Toaster>`

**Files:**
- Modify: `src/components/Toaster.tsx`
- Test: `src/components/Toaster.test.tsx` (create)

- [ ] **Step 1: Write failing test**

Create `src/components/Toaster.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from './Toaster';
import { toast, __resetToasts } from '../lib/toast';

describe('Toaster action', () => {
  beforeEach(() => { __resetToasts(); cleanup(); });

  it('renders the action button and fires onClick', async () => {
    render(<Toaster />);
    const onClick = vi.fn();
    toast.info('Blocked a redirect to evil.com', { action: { label: 'Open anyway', onClick } });
    const btn = await screen.findByRole('button', { name: 'Open anyway' });
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
```
> If `@testing-library/user-event` isn't a dependency, use `fireEvent.click` from `@testing-library/react` instead (check how other `src/**/*.test.tsx` files click).

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run src/components/Toaster.test.tsx`
Expected: FAIL (no button rendered).

- [ ] **Step 3: Implement**

Replace the `.map` body in `src/components/Toaster.tsx`:
```tsx
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__message">{t.message}</span>
          {t.action && (
            <button
              type="button"
              className="toast__action"
              onClick={() => t.action?.onClick()}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run src/components/Toaster.test.tsx`
Expected: PASS.

- [ ] **Step 5: (Optional) style the button**

Add to `src/index.css` near the existing `.toast` rules:
```css
.toast__action {
  margin-left: 12px;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 2px 8px;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
```

- [ ] **Step 6: Commit**

```bash
git add src/components/Toaster.tsx src/components/Toaster.test.tsx src/index.css
git commit -m "feat(toast): render action button in Toaster"
```

---

### Task 9: `redirect.blocked` event wiring (types + ipcClient + App listener)

**Files:**
- Modify: `shared/types.ts`, `src/lib/ipcClient.ts`, `src/App.tsx`

- [ ] **Step 1: Add the channel + type + API in `shared/types.ts`**

In the `IPC` const, in the events section (near `evtAdblockBlockedCount`, `shared/types.ts:~60`), add:
```ts
  evtRedirectBlocked: 'redirect.blocked',
```
Add the payload interface (near `BlockedCount`, `shared/types.ts:222`):
```ts
export interface RedirectBlocked {
  viewId: ViewId;
  from: string;
  to: string;
}
```
Add to the `AegisApi` interface a `redirect` group (near the `adblock` group):
```ts
  redirect: {
    onBlocked(cb: (r: RedirectBlocked) => void): () => void;
  };
```
> Make sure `RedirectBlocked` is exported and imported where `AegisApi` is declared (same file).

- [ ] **Step 2: Add the subscription in `src/lib/ipcClient.ts`**

Import `RedirectBlocked` in the type import list, then add a `redirect` group (mirror `adblock.onBlockedCount` at `ipcClient.ts:199`, and the Android-bridge branch from `nav.onState` at `ipcClient.ts:114`):
```ts
  redirect: {
    onBlocked: (cb: (r: RedirectBlocked) => void) => {
      // Android has no Tauri event bus on the content side; the Kotlin client pushes
      // RedirectBlocked via window.__aegisRedirectBlocked (set up here), mirroring nav state.
      if (androidBridge()) {
        const w = window as unknown as {
          __aegisRedirectBlockedCbs?: Set<(r: RedirectBlocked) => void>;
          __aegisRedirectBlocked?: (r: RedirectBlocked) => void;
        };
        const cbs = (w.__aegisRedirectBlockedCbs ??= new Set());
        cbs.add(cb);
        w.__aegisRedirectBlocked = (r) => cbs.forEach((f) => f(r));
        return () => { cbs.delete(cb); };
      }
      return on<RedirectBlocked>(IPC.evtRedirectBlocked, cb);
    },
  },
```
> Use the exact name of the existing Android-detection helper (`androidBridge()` per `ipcClient.ts:114`); confirm its name when editing.

- [ ] **Step 3: Add the listener in `src/App.tsx`**

Near the other event `useEffect`s (e.g. `nav.onFailed` at `App.tsx:~234`), add a new effect. Ensure `toast` and `aegis`/`tabs` are imported (they are — `toast` from `./lib/toast`, tabs API in scope):
```tsx
  useEffect(() => {
    return aegis.redirect.onBlocked((r) => {
      if (r.viewId !== tabs.activeId) return;
      let host = r.to;
      try { host = new URL(r.to).hostname; } catch { /* keep raw */ }
      toast.info(`Blocked a redirect to ${host}`, {
        durationMs: 6000,
        action: { label: 'Open anyway', onClick: () => { void tabs.create(r.to, false); } },
      });
    });
  }, [tabs.activeId]);
```
> Use the same handle the file already uses for the API object (the explorer saw `aegis.nav.onFailed(...)`); match it (`aegis` vs `ipcClient`). Confirm the toast import exists; add `import { toast } from './lib/toast';` if not.

- [ ] **Step 4: Run the TS test suite + typecheck the touched files**

Run: `npm test`
Expected: all vitest pass (479+ baseline + the new toast/Toaster tests). No type errors in `shared/types.ts`, `ipcClient.ts`, `App.tsx` (the task's own files).

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts src/lib/ipcClient.ts src/App.tsx
git commit -m "feat(redirect-guard): redirect.blocked event + Open-anyway toast"
```

---

## Phase 5 — Windows

### Task 10: Windows `NavigationStarting` handler

**Files:**
- Create: `src-tauri/src/nav_policy_win.rs`
- Modify: `src-tauri/src/lib.rs` (mod decl), `src-tauri/src/nav.rs:376-383` (Windows block)

- [ ] **Step 1: Create `nav_policy_win.rs`**

Mirror `adblock_win.rs:23` (`install` + `*EventHandler::create`). `NavigationStarting` on the top-level `ICoreWebView2` fires for top-frame navigations only, so `main_frame = true`.

```rust
// src-tauri/src/nav_policy_win.rs
//! Windows redirect guard: cancels scripted cross-origin top-frame redirects via
//! WebView2's NavigationStarting event (top-frame only by definition). Policy is
//! shared via `redirect_guard`. Install inside `content.with_webview(|pw| ...)`.
use tauri::AppHandle;
use webview2_com::NavigationStartingEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2NavigationStartingEventArgs,
};
use windows::core::Interface;

pub fn install(pw: &tauri::webview::PlatformWebview, app: AppHandle, id: u32) {
    let controller = pw.controller();
    unsafe {
        let Ok(core) = controller.CoreWebView2() else { return };
        let handler = NavigationStartingEventHandler::create(Box::new(move |core, args| {
            if let (Some(core), Some(args)) = (core, args) {
                // Fail open: never break navigation if our check errors.
                let _ = handle(&app, id, &core, &args);
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_NavigationStarting(&handler, &mut token);
    }
}

unsafe fn handle(
    app: &AppHandle,
    id: u32,
    core: &ICoreWebView2,
    args: &ICoreWebView2NavigationStartingEventArgs,
) -> windows::core::Result<()> {
    let target = {
        let mut p = windows::core::PWSTR::null();
        args.Uri(&mut p)?;
        p.to_string().unwrap_or_default()
    };
    let current = {
        let mut p = windows::core::PWSTR::null();
        core.Source(&mut p)?;
        p.to_string().unwrap_or_default()
    };
    let mut user = windows::core::BOOL::default();
    args.IsUserInitiated(&mut user)?;
    let mut redirected = windows::core::BOOL::default();
    args.IsRedirected(&mut redirected)?;
    let scripted = !user.as_bool();
    if crate::redirect_guard::decide_for(app, id, &current, &target, scripted, true, redirected.as_bool()) {
        args.SetCancel(true)?;
        crate::redirect_guard::on_blocked(app, id, &current, &target);
    }
    Ok(())
}
```
> If `Source`, `Uri`, `IsUserInitiated`, `IsRedirected`, `SetCancel`, or `NavigationStartingEventHandler` resolve to a different path/signature, adjust to the bindings in `webview2-com` (the same crate `adblock_win.rs` imports from). The cross-check compile in Step 4 will surface any mismatch.

- [ ] **Step 2: Add the mod decl in `lib.rs`**

Next to `#[cfg(target_os = "windows")] mod nav_url_win;` (`lib.rs:~9`):
```rust
#[cfg(target_os = "windows")]
mod nav_policy_win;
```

- [ ] **Step 3: Wire into `spawn_tab` Windows block (`nav.rs:376-383`)**

Inside the existing `with_webview` closure (after `crate::nav_url_win::install(&pw, app_url, id);`), add — note it needs its own `app` clone since `app_url` is moved:
```rust
    #[cfg(target_os = "windows")]
    if let Some(content) = app.get_webview(&label) {
        let app_url = app.clone();
        let app_rg = app.clone();
        let _ = content.with_webview(move |pw| {
            crate::adblock_win::install(&pw);
            crate::nav_url_win::install(&pw, app_url, id);
            crate::nav_policy_win::install(&pw, app_rg, id);
        });
    }
```

- [ ] **Step 4: Cross-check compile (the test)**

Run: `cd src-tauri && cargo check --target x86_64-pc-windows-gnu`
Expected: compiles cleanly. (Runtime verification happens later on a Windows desktop — note it for the parity checklist.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/nav_policy_win.rs src-tauri/src/lib.rs src-tauri/src/nav.rs
git commit -m "feat(redirect-guard): Windows NavigationStarting blocking"
```

---

## Phase 6 — macOS

### Task 11: macOS `WKNavigationDelegate`

**Files:**
- Create: `src-tauri/src/nav_policy_mac.rs`
- Modify: `src-tauri/src/lib.rs` (mod decl), `src-tauri/src/nav.rs:388-394` (macOS block)

> macOS has no public user-gesture API, so `scripted = navigationType == .other`; no redirect flag, so `is_redirect = false`. **Cannot be compiled on this Linux host** — verified via CI only (macos-latest). **Risk:** wry owns the `WKNavigationDelegate`; setting ours may need to forward to wry's. Implement to compile; mark runtime-verify deferred (no mac GUI available). See spec §8.3.

- [ ] **Step 1: Create `nav_policy_mac.rs`**

Mirror the `objc2::define_class!` pattern in `nav_url_mac.rs:26`.

```rust
// src-tauri/src/nav_policy_mac.rs
//! macOS redirect guard: a WKNavigationDelegate that cancels scripted cross-origin
//! top-frame redirects. Heuristic (no gesture API): navigationType==.other.
//! Policy shared via `redirect_guard`. CI-compile-only (no mac GUI here).
//! RISK: wry owns the navigation delegate — see spec §8.3; runtime-verify deferred.
#![cfg(target_os = "macos")]
use objc2::{define_class, msg_send, rc::Retained, runtime::NSObject, DefinedClass};
use objc2::runtime::ProtocolObject;
use objc2_foundation::{NSObjectProtocol, NSString};
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationType, WKWebView,
};
use tauri::AppHandle;

pub struct GuardIvars {
    app: AppHandle,
    id: u32,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = GuardIvars]
    pub struct NavPolicy;

    unsafe impl NSObjectProtocol for NavPolicy {}

    unsafe impl WKNavigationDelegate for NavPolicy {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        unsafe fn decide_policy(
            &self,
            web_view: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::Block<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let allow = WKNavigationActionPolicy::Allow;
            let cancel = WKNavigationActionPolicy::Cancel;

            let main_frame = action.targetFrame().map(|f| f.isMainFrame()).unwrap_or(false);
            let scripted = action.navigationType() == WKNavigationType::Other;
            let target = action.request().URL()
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string()).unwrap_or_default();
            let current = web_view.URL()
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string()).unwrap_or_default();

            let ivars = self.ivars();
            let block = crate::redirect_guard::decide_for(
                &ivars.app, ivars.id, &current, &target, scripted, main_frame, false,
            );
            if block {
                crate::redirect_guard::on_blocked(&ivars.app, ivars.id, &current, &target);
                handler.call((cancel,));
            } else {
                handler.call((allow,));
            }
        }
    }
);

impl NavPolicy {
    fn new(app: AppHandle, id: u32) -> Retained<Self> {
        let this = Self::alloc().set_ivars(GuardIvars { app, id });
        unsafe { msg_send![super(this), init] }
    }
}

/// Install on the content WKWebView. Leaked for the tab/app lifetime (like the KVO
/// observer in nav_url_mac). NOTE: this REPLACES the navigationDelegate — verify it
/// does not break wry's load/URL tracking before relying on it at runtime (spec §8.3).
pub fn install(pw: &tauri::webview::PlatformWebview, app: AppHandle, id: u32) {
    let ptr = pw.inner() as *mut WKWebView;
    if ptr.is_null() { return; }
    let webview: Retained<WKWebView> = match unsafe { Retained::retain(ptr) } {
        Some(w) => w,
        None => return,
    };
    let delegate = NavPolicy::new(app, id);
    unsafe {
        let proto: &ProtocolObject<dyn WKNavigationDelegate> = ProtocolObject::from_ref(&*delegate);
        webview.setNavigationDelegate(Some(proto));
    }
    std::mem::forget(delegate);
}
```
> The `block2` crate is used for the decision-handler block; if it isn't already a transitive dep, add `block2 = "0.6"` to the `[target.'cfg(target_os = "macos")'.dependencies]` block in `src-tauri/Cargo.toml` (next to `objc2-web-kit`). The method names (`targetFrame`, `isMainFrame`, `navigationType`, `request`, `setNavigationDelegate`) and `WKNavigationType::Other` must match objc2-web-kit 0.3.2. Since this can't compile on this Linux host, the CI build (Step 4) is authoritative — iterate via CI if it fails.

- [ ] **Step 2: Add the mod decl in `lib.rs`**

Next to `#[cfg(target_os = "macos")] mod nav_url_mac;` (`lib.rs:~11`):
```rust
#[cfg(target_os = "macos")]
mod nav_policy_mac;
```

- [ ] **Step 3: Wire into `spawn_tab` macOS block (`nav.rs:388-394`)**

```rust
    #[cfg(target_os = "macos")]
    if let Some(content) = app.get_webview(&label) {
        let app_url = app.clone();
        let app_rg = app.clone();
        let _ = content.with_webview(move |pw| {
            crate::nav_url_mac::install(&pw, app_url, id);
            crate::nav_policy_mac::install(&pw, app_rg, id);
        });
    }
```

- [ ] **Step 4: Verify via CI (cannot build locally)**

Locally confirm no Linux/Windows/Android regression: `cd src-tauri && cargo check && cargo check --target x86_64-pc-windows-gnu`.
Push to a branch and confirm `tauri-build-check.yml` is green on **macos-latest** (the authoritative macOS gate). Iterate on the objc2 specifics via CI if needed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/nav_policy_mac.rs src-tauri/src/lib.rs src-tauri/src/nav.rs
git commit -m "feat(redirect-guard): macOS WKNavigationDelegate blocking (CI-verified)"
```

---

## Phase 7 — Android

### Task 12: Android JNI export + Kotlin binding

**Files:**
- Modify: `src-tauri/src/redirect_guard.rs` (JNI export)
- Create: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/NativeRedirectGuard.kt`

- [ ] **Step 1: Add the JNI export to `redirect_guard.rs`**

Mirror `adblock_engine.rs:163` (the `Java_..._shouldBlock` export). Android computes `scripted`/`main_frame` in Kotlin and passes them in; the registry isn't needed on Android (`loadUrl` bypasses `shouldOverrideUrlLoading`), so this calls the pure `should_block`.

```rust
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
```

- [ ] **Step 2: Create the Kotlin binding**

Create `NativeRedirectGuard.kt` (mirror `NativeAdblock.kt`):
```kotlin
package com.aegis.browser

/**
 * Scripted cross-origin top-frame redirect guard, backed by the Rust
 * `redirect_guard` module — the same policy the desktop builds use. Native symbol
 * lives in libapp_lib.so (see [NativeAdblock] for the loading note).
 */
object NativeRedirectGuard {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /** True if a navigation from [current] to [target] should be blocked. */
  external fun shouldBlock(current: String, target: String, scripted: Boolean, mainFrame: Boolean): Boolean
}
```

- [ ] **Step 3: Compile the Rust Android target**

Run (with the NDK env from `memory/aegis-android-build-gates-runnable-locally.md`):
`cd src-tauri && cargo check --target aarch64-linux-android`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/redirect_guard.rs src-tauri/gen/android/app/src/main/java/com/aegis/browser/NativeRedirectGuard.kt
git commit -m "feat(redirect-guard): Android JNI shouldBlock + Kotlin binding"
```

---

### Task 13: Android `shouldOverrideUrlLoading` guard + chrome event bridge

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

- [ ] **Step 1: Add the guard in `shouldOverrideUrlLoading` (`MainActivity.kt:166-183`)**

`shouldOverrideUrlLoading` is exactly where page-initiated main-frame navigations (incl. scripted redirects) surface, and `WebResourceRequest` exposes `hasGesture()` + `isForMainFrame`. Add the redirect-guard check BEFORE the existing malware/https logic. Current top URL is the already-tracked `pageUrls[id]`.

```kotlin
    override fun shouldOverrideUrlLoading(
      view: WebView,
      request: WebResourceRequest,
    ): Boolean {
      val raw = request.url?.toString() ?: return false
      if (!raw.startsWith("http")) return false

      // Scripted cross-origin top-frame redirect guard (anti-malvertising).
      val current = pageUrls[id] ?: ""
      val scripted = !request.hasGesture()
      if (current.isNotEmpty() &&
          NativeRedirectGuard.shouldBlock(current, raw, scripted, request.isForMainFrame)) {
        Log.i("AegisRedirect", "BLOCK $raw (from $current)")
        pushRedirectBlocked(id, current, raw)
        return true
      }

      return when (val target = secureUrl(raw)) {
        null -> { showMalwareWarning(raw); true }
        raw -> false
        else -> { view.loadUrl(target); true }
      }
    }
```

- [ ] **Step 2: Add `pushRedirectBlocked` — mirror `pushNavState`**

Find `pushNavState` in `MainActivity.kt` (it evaluates JS on the CHROME webview to deliver events to the React UI). Add a sibling that calls `window.__aegisRedirectBlocked` with the same delivery mechanism. Follow `pushNavState`'s exact pattern (JSON building + `chromeWebView.evaluateJavascript(...)` on the UI thread):

```kotlin
  /** Deliver a blocked-redirect notice to the chrome (React) UI. Mirrors pushNavState. */
  private fun pushRedirectBlocked(id: Int, from: String, to: String) {
    val json = org.json.JSONObject()
      .put("viewId", id)
      .put("from", from)
      .put("to", to)
      .toString()
    runOnUiThread {
      chromeWebView?.evaluateJavascript(
        "window.__aegisRedirectBlocked && window.__aegisRedirectBlocked($json)",
        null,
      )
    }
  }
```
> Use the exact chrome-webview field name and threading helper that `pushNavState` uses (the field may be named differently than `chromeWebView`); copy its mechanism verbatim. This is the same bridge the `ipcClient.redirect.onBlocked` Android branch (Task 9 Step 2) reads.

- [ ] **Step 3: Compile the Kotlin gate**

Run: `cd src-tauri/gen/android && ./gradlew compileUniversalDebugKotlin`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Device-verify**

Build + install the release APK to the phone (`npm run android:build` then `adb install -r` — beware the debug-vs-release package-id gotcha in `memory/aegis-android-jni-upcall-crash.md`). On streamex: the redirect is blocked + the "Open anyway" toast appears + tapping it opens the URL in a new tab. Link clicks / address-bar nav still work.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt
git commit -m "feat(redirect-guard): Android shouldOverrideUrlLoading guard + chrome bridge"
```

---

## Phase 8 — Docs + final verification

### Task 14: Documentation + full-suite parity check

**Files:**
- Modify: `src-tauri/CLAUDE.md`, `shared/CLAUDE.md`

- [ ] **Step 1: Document the feature in `src-tauri/CLAUDE.md`**

Add a short entry (in the navigation/security section) describing: the `redirect_guard` module (pure predicate + `PendingNavs` registry), the per-platform hooks (Linux `connect_redirect_guard` decide-policy; Windows `nav_policy_win` NavigationStarting; macOS `nav_policy_mac` WKNavigationDelegate; Android `shouldOverrideUrlLoading`+JNI), the `navigate_tab` chokepoint invariant (all app navigations must register via `expect`), and that it's always-on with the Open-anyway toast as the only escape hatch. Note the Linux decide-policy-coexistence finding from Task 5 and the macOS delegate-ownership caveat.

- [ ] **Step 2: Document the new event in `shared/CLAUDE.md`**

Add `redirect.blocked` (`evtRedirectBlocked`, payload `RedirectBlocked { viewId, from, to }`) to the IPC contract doc, noting "Open anyway" reuses `tabs.create`.

- [ ] **Step 3: Run the full test suites**

Run:
```bash
cd src-tauri && cargo test
cd .. && npm test
cd src-tauri && cargo check --target x86_64-pc-windows-gnu
cd src-tauri && cargo check --target aarch64-linux-android   # with NDK env
cd src-tauri/gen/android && ./gradlew compileUniversalDebugKotlin
```
Expected: cargo tests green (incl. the 12 `redirect_guard` tests); vitest green (baseline + toast/Toaster tests); Windows + Android Rust check green; Kotlin compile green. macOS verified separately via CI.

- [ ] **Step 4: Verify the parity checklist (spec §9)**

Confirm each box: Linux runtime-verified (streamex + regressions); Windows CI-green (+ runtime when a Windows desktop is available); macOS CI compile-green; Android device-verified; unit tests pass; docs updated.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/CLAUDE.md shared/CLAUDE.md
git commit -m "docs(redirect-guard): document the redirect guard + redirect.blocked event"
```

---

## Self-review notes (author)

- **Spec coverage:** predicate (T1) · registry+redirect-continuation (T2) · state/event (T3) · app-nav chokepoint (T4) · Linux spike+impl (T5,T6) · toast+Open-anyway (T7-T9) · Windows (T10) · macOS (T11) · Android (T12,T13) · docs+parity (T14). All spec §5–§9 items mapped.
- **Spike honesty:** the only deferred values are Linux main-frame detection + the decide-policy cancel contract — that is the spike's explicit purpose (T5 → T6); candidates are given.
- **CI-only macOS:** T11 can't build locally; CI is the authoritative gate, called out in the task.
- **Type consistency:** `should_block`/`decide`/`decide_for`/`expect`/`on_blocked`/`navigate_tab`/`PendingNavs` names are identical across all tasks; event payload uses `viewId` (matching `BlockedCount`) everywhere; "Open anyway" reuses `tabs.create(url, false)` consistently.
