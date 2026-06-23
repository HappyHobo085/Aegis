# Scripted Cross-Origin Top-Frame Redirect Blocker — Design

**Date:** 2026-06-18
**Status:** Approved design — ready for implementation plan
**Owner:** Aegis core

---

## 1. Goal

Block **scripted (non-user-gesture) cross-origin top-frame redirects** in the
content webview, on all four platforms (Linux, Windows, macOS, Android), without
breaking legitimate browsing. This is an anti-malvertising feature: hostile pages
(e.g. streamex) bounce the top frame to another origin (`google.com`) with no user
action, which is never something the user asked for.

When such a navigation is detected, Aegis **cancels** it and surfaces a transient
toast naming the blocked destination with an **"Open anyway"** action that opens
that URL in a new tab.

## 2. Background

This is the deferred follow-up from the 2026-06-18 streamex-redirect investigation
(see `memory/aegis-linux-overlay-zorder.md`). The earlier mitigations shipped and
remain in place but are insufficient on their own:

- `POPUP_GUARD` (blocks cross-origin `window.open`),
- `visibility_shim.js` (fakes `visibilityState`/`hidden`/`hasFocus`, swallows
  `visibilitychange` + window blur/focus), injected via
  `nav.rs` `initialization_script_for_all_frames`,
- `nav.rs` cancels content navigation while a full overlay covers the page
  (`overlay && !sidebar`).

A JS-only shim **cannot** solve this: it can't reliably distinguish a user gesture
from a scripted `location.href=` assignment, malware can capture `location` before
the shim runs or navigate from a Worker, and the streamex trigger is a legitimate
`resize` event that the shim must not break. The robust fix is a **native
navigation-policy hook** on each platform. The existing shims stay as complementary
defense-in-depth.

## 3. Non-goals

- **No global Settings toggle** and **no persistent per-site allowlist.** The
  per-event "Open anyway" action is the only escape hatch. (Explicit user choice:
  "always on, no controls".)
- Not blocking same-origin scripted navigation (SPA routing, in-site redirects).
- Not blocking cross-origin **sub-frame** navigation (legit embeds: video players,
  OAuth iframes, ads — ads are already handled by the ad-block engine).
- Not blocking user-initiated navigation (link clicks, form submits, back/forward,
  reload) or app-initiated navigation (address bar, new tab, HTTPS-Only upgrade,
  session restore, Open-anyway).
- Not a general HTTP-redirect blocker — redirect _hops_ that continue an
  already-allowed navigation pass through.

## 4. Architecture overview

```
content webview: a navigation is about to start  (per-platform hook)
      │  the platform glue derives four inputs:
      │     current_top_url : the content webview's current top-document URL
      │     target_url      : where the navigation wants to go
      │     scripted        : no legitimate user/app initiation detected
      │     main_frame      : the navigation targets the top frame
      ▼
redirect_guard::evaluate(app, tab_id, current, target, scripted, main_frame, is_redirect)
      │   ├─ is_redirect            → ALLOW (continuation of a vetted nav)
      │   ├─ matches pending nav    → ALLOW + consume (app-initiated)
      │   └─ should_block(...)==true→ BLOCK
      │ BLOCK → cancel the navigation + emit  redirect.blocked {from,to,tabId}
      ▼
chrome (React): toast  "🛡 Blocked a redirect to <to>   [ Open anyway ]"
      │  Open anyway → open <to> in a NEW tab (routed through nav::navigate_tab,
      │                so it registers app-initiated and is not re-blocked)
```

The **policy** is single-sourced in Rust (`redirect_guard.rs`); each platform's glue
only derives the four inputs from its native APIs and performs the cancel. This
mirrors the existing single-sourced ad-block engine (Android calls Rust over JNI).

## 5. Components

### 5.1 `src-tauri/src/redirect_guard.rs` (new) — pure policy + state

**Pure predicate (the heart of the feature, fully unit-testable):**

```rust
/// The core test: a script-initiated, cross-origin navigation targeting the top
/// frame. All four platforms feed it the same inputs. (Freshness — i.e. excluding
/// redirect hops and app-initiated navs — is layered on by `evaluate`, below.)
pub fn should_block(current: &str, target: &str, scripted: bool, main_frame: bool) -> bool {
    scripted && main_frame && is_cross_origin_http(current, target)
}

/// Target must be http/https and a different origin (scheme+host+port) than the
/// current top document. Uses the `url` crate (already a dependency).
fn is_cross_origin_http(current: &str, target: &str) -> bool {
    let (Ok(cur), Ok(tgt)) = (url::Url::parse(current), url::Url::parse(target)) else {
        return false; // unparseable current/target → don't block (fail open)
    };
    if !matches!(tgt.scheme(), "http" | "https") {
        return false; // about:, blob:, data:, javascript:, mailto:, custom schemes → ignore
    }
    cur.origin() != tgt.origin()
}
```

**App-initiated navigation registry** (one expected URL slot per tab):

```rust
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct PendingNavs(pub Mutex<HashMap<u32, String>>); // tab_id -> expected target

/// Record that the APP is about to navigate `tab` to `url` on the user's behalf
/// (address bar, new tab, HTTPS-Only upgrade, Open-anyway, restore). Overwrites the
/// tab's slot (one-shot).
pub fn expect(app: &AppHandle, tab: u32, url: &str);

/// Consume a pending app-initiated nav for `tab` if `target` matches it
/// (origin+path+query, ignoring fragment / trailing-slash). Returns true if matched.
fn take_if_match(app: &AppHandle, tab: u32, target: &str) -> bool;
```

**Top-level evaluation** used by every desktop glue:

```rust
/// Decide whether to BLOCK this navigation. Returns true to cancel.
/// `is_redirect` = this is a redirect hop continuing an in-flight navigation.
pub fn evaluate(
    app: &AppHandle, tab: u32,
    current: &str, target: &str,
    scripted: bool, main_frame: bool, is_redirect: bool,
) -> bool {
    if is_redirect { return false; }                 // continuation of a vetted nav
    if take_if_match(app, tab, target) { return false; } // app-initiated
    should_block(current, target, scripted, main_frame)
}
```

On a `true` result the glue cancels and calls a shared
`redirect_guard::on_blocked(app, tab, from, to)` that emits the `redirect.blocked`
event.

### 5.2 Single navigation chokepoint: `nav::navigate_tab`

So app-initiated navigations are exempt, **every** programmatic content navigation
routes through one helper that registers the URL before navigating:

```rust
// src-tauri/src/nav.rs
pub fn navigate_tab(app: &AppHandle, tab: u32, url: &Url) {
    crate::redirect_guard::expect(app, tab, url.as_str());
    if let Some(w) = app.get_webview(&content_label(tab)) { let _ = w.navigate(url.clone()); }
}
```

Convert existing call sites that do `webview.navigate(...)` for the content webview:

- the `nav.navigate` IPC handler,
- the HTTPS-Only upgrade re-navigate in `on_navigation` (`nav.rs` ~line 204),
- tab spawn / restore initial load,
- the malware-interstitial "proceed anyway" path,
- the new "Open anyway" path.

(Android does **not** need the registry: `WebView.loadUrl()` does not trigger
`shouldOverrideUrlLoading`, so app-initiated loads bypass the hook entirely.)

### 5.3 Per-platform glue

| Platform                                  | Hook (where)                                                                                                                                                                                                                                                          | `scripted` source                                                      | `main_frame` source                                                                                   | `is_redirect`                       | cancel                                              |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------- |
| **Linux** WebKitGTK 2.0.2                 | new `connect_redirect_guard()` in `linux_layout.rs`, called per-tab from `nav::spawn_tab` (alongside the other `connect_*`); connects `connect_decide_policy` and casts the `PolicyDecision` to `NavigationPolicyDecision` for `PolicyDecisionType::NavigationAction` | `nav_action.navigation_type()==Other && !nav_action.is_user_gesture()` | **see §8 risk** (spike pins down reliable main-frame detection)                                       | `nav_action.is_redirect()` (v2_20+) | `decision.ignore()` (and return per spike findings) |
| **Windows** WebView2                      | new `add_NavigationStarting` in `adblock_win.rs` install path (same `with_webview` → `controller().CoreWebView2()`). `NavigationStarting` is **top-frame only** by definition (subframes fire `FrameNavigationStarting`, which we do **not** hook)                    | `!args.IsUserInitiated()`                                              | implicit `true` (event is top-frame)                                                                  | `args.IsRedirected()`               | `args.SetCancel(true)`                              |
| **macOS** WKWebView (objc2-web-kit 0.3.2) | new `WKNavigationDelegate.webView:decidePolicyForNavigationAction:decisionHandler:` via `objc2::define_class!` (pattern: existing `nav_url_mac.rs` `UrlObserver`)                                                                                                     | `navigationAction.navigationType == .other` (no public gesture API)    | `navigationAction.targetFrame?.isMainFrame == true` (nil targetFrame = new window → treat as non-top) | not available → `false`             | `decisionHandler(.cancel)`                          |
| **Android**                               | extend `makeContentClient`'s `shouldOverrideUrlLoading` in `MainActivity.kt`; compute inputs from `WebResourceRequest`, call `NativeRedirectGuard.shouldBlock(current, target, scripted, mainFrame)` JNI (single-sourced Rust)                                        | `!request.hasGesture()`                                                | `request.isForMainFrame`                                                                              | n/a (`loadUrl` bypass)              | `return true`                                       |

Notes:

- **Current top URL** per platform: Linux `webview.uri()`; Windows `CoreWebView2.Source`; macOS `webView.URL`; Android the already-tracked `pageUrls[id]`.
- **macOS** uses a looser heuristic (no gesture/redirect API) so it may over-block;
  acceptable because macOS is CI-only / not yet GUI-verified and Open-anyway covers
  it. Adding our `WKNavigationDelegate` may conflict with wry's — see §8.
- The pure `should_block` is reused by Linux/Windows/macOS directly in Rust and by
  Android via JNI; only the **input derivation** differs.

### 5.4 IPC & events

Per the one-IPC-chokepoint rule, add in three places (`shared/types.ts`,
`src-tauri/src/lib.rs` dispatcher, `src/lib/ipcClient.ts`):

- **Event (core → chrome):** `redirect.blocked` with payload
  `{ from: string; to: string; tabId: number }`.
  In `shared/types.ts`: `evtRedirectBlocked: 'redirect.blocked'` and a
  `RedirectBlocked` type. (Dotted name kept logical; `emit_event` in `lib.rs`
  translates `.`→`:`, `tauriInvoke.ts` translates back — do not emit a raw dotted
  name.)
- **Open anyway:** reuse the **existing open-URL-in-a-new-tab** flow rather than a new
  channel where possible. The new tab's initial load goes through
  `nav::navigate_tab`, so it registers app-initiated and is not re-blocked. (If no
  suitable existing channel exists, add `redirect.openAnyway { url }` which spawns a
  foreground tab via `navigate_tab`.)

### 5.5 Toast with an action (`src/lib/toast.ts` + `<Toaster>`)

The current `toast` API is message-only (`success`/`error`/`info`, ~4s
auto-dismiss). Extend it minimally with an optional action:

```ts
type ToastAction = { label: string; onClick: () => void };
toast.info(message: string, opts?: { action?: ToastAction; durationMs?: number }): void;
```

The `<Toaster>` renders the action as a button; clicking it runs `onClick` and
dismisses. The redirect-blocked toast uses `durationMs ≈ 6000` and
`action = { label: 'Open anyway', onClick: () => openInNewTab(to) }`.

A chrome-side listener subscribes to `redirect.blocked` and raises this toast.

## 6. Data flow (block + open-anyway)

1. Page script (no gesture) sets `location.href = "https://google.com/"`.
2. Platform hook fires for the top frame; glue derives
   `(current="https://streamex…", target="https://google.com/", scripted=true,
main_frame=true, is_redirect=false)`.
3. `evaluate`: not a redirect; no pending app nav matches `google.com`;
   `should_block` → cross-origin + scripted + main-frame → **true**.
4. Glue cancels the navigation and emits `redirect.blocked {from, to, tabId}`.
5. Chrome shows the toast. User clicks **Open anyway** → open
   `https://google.com/` in a new tab via `navigate_tab` (registered app-initiated)
   → loads normally.

Contrast — **not** blocked: user types `bit.ly/x` in the address bar →
`navigate_tab` registers `bit.ly/x` → hook sees target `bit.ly/x`, matches pending →
allow → `bit.ly` 302→`dest.com` arrives with `is_redirect=true` → allow.

## 7. Testing strategy

- **`redirect_guard` unit tests (Rust):** matrix over `should_block` — same-origin vs
  cross-origin; http/https vs about:/data:/blob:/javascript:; scripted vs not;
  main-frame vs not; unparseable inputs (fail open). Registry: `expect`+match
  consumes and allows; non-match blocks; fragment/trailing-slash-insensitive match;
  redirect hop allowed.
- **Toast action (vitest):** `toast.info` with an action renders a button; clicking
  it fires `onClick` and dismisses.
- **Linux (real HW):** reproduce the streamex redirect → confirm it's blocked + toast
  shows + Open-anyway works. Regression sanity: address-bar nav, link clicks,
  a cross-origin iframe embed (e.g. a YouTube embed), an OAuth login flow, and a URL
  shortener all still work.
- **Windows:** CI compile (`tauri build`) + cross-check `--target
x86_64-pc-windows-gnu`; runtime on a Windows desktop.
- **macOS:** CI compile only (objc2 needs a macOS toolchain — cannot build on Linux).
- **Android:** `cargo check --target aarch64-linux-android` + Kotlin
  `compileUniversalDebugKotlin` + device-verify on real phone.

## 8. Risks (flagged, to resolve during implementation — do not assume)

1. **Linux `decide-policy` coexistence (primary risk).** wry already connects a
   `decide-policy` handler (that's what powers `on_navigation`). Whether a _second_
   handler runs and can cancel depends on GObject's `g_signal_accumulator_true_handled`
   (emission stops at the first handler returning `TRUE`) and on what wry's handler
   returns. **Spike-first:** the first Linux task adds a logging-only `decide-policy`
   handler and empirically confirms (a) it runs, (b) it sees NavigationAction with
   gesture/type/target, (c) calling `ignore()` actually cancels, before any blocking
   logic is built. Fallbacks if it can't cancel as a second handler: connect with
   `connect_decide_policy` ordering tricks, disconnect+rechain wry's handler, or a
   wry-level change — evaluated only if the spike fails.
2. **Linux main-frame detection.** `NavigationAction` exposes gesture, type, and
   target URI but **no** main-frame flag. The spike also determines reliable
   discrimination: `frame_name()` empty-by-convention for the main frame (but unnamed
   iframes are also empty), vs. correlating with `ResponsePolicyDecision::
is_main_frame_main_resource()`, vs. comparing the navigation against the webview's
   top `uri()`. Pick the method the spike proves correct on (main frame, named iframe,
   unnamed iframe).
3. **macOS delegate ownership + heuristic.** wry owns the `WKNavigationDelegate`;
   installing ours may need to forward to wry's to avoid breaking wry's load/URL
   tracking. And without a gesture API, macOS relies on `navigationType==.other`
   (looser → possible over-block). Lower priority: macOS is CI-only and not yet
   GUI-verified; Open-anyway covers over-blocks. Documented, not blocking.
4. **Registry staleness.** A pending app-initiated URL that never navigates lingers in
   the tab's one-shot slot; a later page-script nav to that exact URL would be allowed.
   Extremely narrow; accepted. Mitigation if needed: clear the slot on top-frame
   load-committed.

## 9. Cross-platform parity checklist (definition of done)

Per the project rule ("always finish with all platforms on the same level"), the
feature is complete only when:

- [ ] Linux: blocks the streamex repro, toast + Open-anyway work, regressions pass (real HW).
- [ ] Windows: implemented, CI-green, runtime-verified on a Windows desktop.
- [ ] macOS: implemented, CI compile-green (runtime deferred — no GUI-verify available).
- [ ] Android: implemented, `cargo check` + Kotlin compile green, device-verified.
- [ ] `redirect_guard` pure-core + registry unit tests pass; toast-action vitest passes.
- [ ] `src-tauri/CLAUDE.md` (and `shared/CLAUDE.md` for the new IPC) updated in the
      same change.

## 10. Files touched (summary)

- **Create:** `src-tauri/src/redirect_guard.rs` (pure predicate + registry + JNI
  export for Android), `src-tauri/src/nav_policy_mac.rs` (WKNavigationDelegate).
- **Modify:** `src-tauri/src/nav.rs` (`navigate_tab` helper + route call sites),
  `src-tauri/src/linux_layout.rs` (`connect_redirect_guard`),
  `src-tauri/src/adblock_win.rs` (Windows `add_NavigationStarting`),
  `src-tauri/src/lib.rs` (register `PendingNavs` state, dispatch, mod decls),
  `src-tauri/gen/android/.../MainActivity.kt` (extend `shouldOverrideUrlLoading`) and
  the `NativeRedirectGuard` Kotlin/JNI binding,
  `shared/types.ts` (event + types), `src/lib/ipcClient.ts` (event wrapper),
  `src/lib/toast.ts` + `<Toaster>` (action support), a chrome listener that raises
  the toast, `src-tauri/CLAUDE.md` + `shared/CLAUDE.md` (docs).
