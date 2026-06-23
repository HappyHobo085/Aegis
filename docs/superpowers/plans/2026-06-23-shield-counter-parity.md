# Shield Block-Counter Parity (Windows + Android) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL — `superpowers:executing-plans`. Execute tasks
> in order; stop at each checkpoint and request review. Do not batch tasks. This is
> sub-project **G** of the Aegis Improvements Program
> (`docs/superpowers/specs/2026-06-23-improvements-program-design.md`, §3 G, §4, §6).

**Goal**

Make the ad-block shield badge increment on **Windows** and **Android** for the ad/tracker
requests those platforms actually block, emitting the *same* `adblock.blockedCount` event
the Linux path already uses. Linux is unchanged. The autopilot ad-block A/B trace must still
PASS.

**Non-goal / honesty constraint (read first):** The badge does **NOT** equal "true blocks"
on any platform. On Linux the WebKit content filter cancels well-known hosts *before* the
counting signal fires, so the count is known-incomplete; the autopilot proves blocking by an
OFF/ON A/B trace, not by the count (`src-tauri/CLAUDE.md` → Linux section + gotcha 6). This
plan brings Windows and Android to the **same semantics**: count the blocks each platform's
request path *sees and blocks*, no more. We never claim badge == real blocks.

**Architecture**

The counter state already lives in `adblock.rs`:

- `SESSION_BLOCKED: AtomicU32` — monotonic session total.
- `PAGE_BLOCKED: HashMap<u32 /*tab id*/, u32>` — per-tab current-page count.
- `note_blocked(app, id)` — bump both, emit `adblock.blockedCount { viewId, page, session }`.
- `reset_page(app, id)` — zero a tab's page count on a new top-frame nav, re-emit.
- `getState` returns the active tab's `pageBlocked` so the chrome recovers the count on
  mount/tab-switch.

Today `note_blocked`/`reset_page` are `#[allow(dead_code)]` and called **only** from the
Linux `resource-load-started` hook (`linux_layout::connect_block_counter`) +
`nav.rs:253 reset_page` (Linux-gated). Windows and Android never call them, so the badge
shows 0 there.

**Two platform shapes, one event:**

1. **Windows** — `adblock_win.rs`'s `WebResourceRequested` handler already runs
   `should_block` and substitutes a 204 on a match. We thread the `AppHandle` + tab `id`
   into `install` (exactly like the sibling `nav_url_win::install(&pw, app, id)` already
   does) and call `adblock::note_blocked(&app, id)` inside the block branch. `reset_page`
   is already wired on the desktop nav path — but it is currently `#[cfg(target_os =
   "linux")]`-gated in `nav.rs`; we widen that gate to all desktop so Windows zeroes the
   page count on each top-frame load.

2. **Android** — the JNI `should_block` runs with **no `AppHandle`**, and Android has **no
   Tauri event bus on the content side** (it uses the `window.__aegis*` `evaluateJavascript`
   bridge pattern — see `__aegisNavState`, `__aegisRedirectBlocked`). So Android counting
   stays **entirely in Kotlin**: `MainActivity.shouldInterceptRequest` already decides the
   block; when it blocks an ad/tracker request it calls a new private `noteBlocked(id)` that
   keeps the same session/page counters in Kotlin and pushes
   `window.__aegisBlockedCount({ viewId, page, session })` to the chrome webview — the exact
   mirror of `showRedirectBlocked`/`pushNavState`. `reset_page` semantics are reproduced in
   Kotlin: zero the tab's page count in `onPageStarted` and push.

   The renderer side (`ipcClient.ts onBlockedCount`) gets the same Android branch the other
   events have: install a `window.__aegisBlockedCount` callback set when `androidBridge()`
   is present, instead of subscribing to the Tauri event.

**Tech Stack**

- Rust (Tauri 2 core; `adblock.rs`, `adblock_win.rs`, `nav.rs`). Windows WebView2 path is
  `unsafe` COM, compile-checkable from Linux via the `x86_64-pc-windows-gnu` cross target.
- Kotlin (Android `MainActivity.kt`) + the `window.__aegisBlockedCount` JS bridge.
- TypeScript renderer (`ipcClient.ts`) — Android branch for `onBlockedCount`.
- Shared contract: `shared/types.ts` (`BlockedCount` already exists; no schema change).
- Tests: Rust `#[test]` in `adblock.rs` (counter accumulation, pure); vitest for the
  `ipcClient` Android branch + the autopilot interaction/catalog drift guards.

## Global Constraints (from spec §6)

1. **IPC in three places — N/A here, no new channel.** `adblock.blockedCount` /
   `BlockedCount` already exist in all three places (`shared/types.ts` `evtAdblockBlockedCount`
   + `BlockedCount`; Rust emits via `emit_event`; `ipcClient.ts onBlockedCount`). We add an
   **Android transport branch** to the existing `onBlockedCount`, not a new channel. **Do not
   add a channel; do not rename the event or change the payload shape.**
2. **Autopilot coverage in the same commit (drift-guarded).** No new IPC channel and no new
   UI screen → the IPC drift guard (`coverage.test.ts`) and screen catalog are already
   satisfied (the `adblock` catalog entry already lists `IPC.evtAdblockBlockedCount` via its
   channels, and `screens.ts` already has `shieldPopover`). The **interaction** that this
   sub-project makes newly-meaningful (the badge showing a non-zero count) is covered by an
   added/strengthened interaction spec asserting the shield badge reflects an
   `onBlockedCount` event on the active view (Task 6). Verify the drift guards still pass.
3. **Gate per sub-project.** `npm test` green. For the runtime-touching change, the Linux
   live autopilot must still show `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`
   (Linux behavior is unchanged, but we run it to prove no regression). Windows/Android are
   compile-gated here + manual device-verify steps (per §4 verification reality).
4. **Parity before "done".** Linux already counts; this closes Windows + Android. macOS uses
   the injected JS tier only (no native request interception) and has no per-block native
   callback — documented below as the honest ceiling, matching how the spec scopes G to
   "Windows + Android". iOS out of program scope.

---

## File Structure map

```
src-tauri/src/
├── adblock.rs          # EDIT: drop #[allow(dead_code)] on note_blocked/reset_page; add #[test] accumulation tests
├── adblock_win.rs      # EDIT: install(pw, app, id) signature; count in the block branch
├── nav.rs              # EDIT: widen reset_page gate linux→desktop; pass app+id to adblock_win::install
gen/android/app/src/main/java/com/aegis/browser/
└── MainActivity.kt     # EDIT: Kotlin session/page counters + noteBlocked(id) + reset on onPageStarted; push window.__aegisBlockedCount
src/lib/
└── ipcClient.ts        # EDIT: Android branch in adblock.onBlockedCount (window.__aegisBlockedCount)
src/autopilot/interactions/
└── toolbar.ts          # EDIT: interaction spec — shield badge reflects an onBlockedCount event
shared/types.ts         # NO CHANGE (BlockedCount + evtAdblockBlockedCount already present) — verify only
```

---

## Tasks

### Task 1 — Un-gate the counter fns + add accumulation tests (Rust, pure, testable)

**Files:** `src-tauri/src/adblock.rs`

**Why:** `note_blocked`/`reset_page` are `#[allow(dead_code)]` with a comment that Win/Android
is "a follow-up". After this sub-project they have real callers on every desktop + (in spirit,
via the Kotlin mirror) Android, so the allow attribute is no longer accurate. Adding a unit
test for the page/session accumulation logic is the testable core of G.

The accumulation math currently lives *inside* `note_blocked`/`reset_page`, which take an
`AppHandle` and emit — not unit-testable in isolation. **Step 1a** extracts the pure
counter mutation into a free function so a `#[test]` can assert it without Tauri.

**Step 1a — extract the pure counter update.** Add, above `note_blocked`:

```rust
/// Pure counter update for one blocked subresource on tab `id`: bumps the monotonic
/// session total and the tab's per-page count, returning `(session, page)`. Split out
/// from `note_blocked` so the accumulation logic is unit-testable without a Tauri
/// `AppHandle` (the emit half needs the app; this half does not).
fn bump_blocked(id: u32) -> (u32, u32) {
    let session = SESSION_BLOCKED.fetch_add(1, Ordering::Relaxed) + 1;
    let page = {
        let mut m = page_map().lock().unwrap();
        let c = m.entry(id).or_insert(0);
        *c += 1;
        *c
    };
    (session, page)
}

/// Pure per-page reset for tab `id` (zero its page count), returning the unchanged
/// session total. Split out from `reset_page` for the same testability reason.
fn zero_page(id: u32) -> u32 {
    page_map().lock().unwrap().insert(id, 0);
    session_blocked()
}
```

**Step 1b — make `note_blocked`/`reset_page` use them + drop the stale `#[allow]`.** Replace
the two functions:

```rust
/// Count one blocked subresource on tab `id` and push the running totals to the chrome
/// badge via `adblock.blockedCount`. Called from each platform's request path: Linux's
/// `resource-load-started` hook (`linux_layout::connect_block_counter`) and Windows'
/// WebView2 `WebResourceRequested` handler (`adblock_win`). (Android keeps an equivalent
/// counter in Kotlin — it has no `AppHandle` and no Tauri event bus on the content side —
/// and pushes `window.__aegisBlockedCount` directly; see `MainActivity.kt`.)
pub fn note_blocked(app: &AppHandle, id: u32) {
    let (session, page) = bump_blocked(id);
    crate::emit_event(
        app,
        "adblock.blockedCount",
        json!({ "viewId": id, "page": page, "session": session }),
    );
}

/// Reset a tab's per-page blocked count on a new top-frame navigation, and refresh the
/// badge (page → 0, session unchanged). Called from the desktop nav path (`nav.rs`).
pub fn reset_page(app: &AppHandle, id: u32) {
    let session = zero_page(id);
    crate::emit_event(
        app,
        "adblock.blockedCount",
        json!({ "viewId": id, "page": 0, "session": session }),
    );
}
```

Note: the `#[allow(dead_code)]` lines (`adblock.rs:43` and `:61`) are **deleted** — both
functions now have non-Linux callers.

**Step 1c — add the accumulation `#[test]`s.** The existing `adblock.rs` has no `#[cfg(test)]`
module; add one at the end of the file:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

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
        assert_eq!(page_map().lock().unwrap().get(&id).copied(), Some(0));
        // zero_page returns the *session* total, which is monotonic and unaffected.
        let (s_after, p_after) = bump_blocked(id);
        assert_eq!(p_after, 1, "page count restarts at 1 after a reset");
        assert!(s_after >= s, "session total is monotonic across a page reset");
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
        assert_eq!(sa, before + 1);
        assert_eq!(sb, before + 2);
    }
}
```

**Verify:** `cargo test -p app --lib adblock::tests` (Linux host; pure, no Tauri). Expect the
two new tests green. (Cannot run cargo per the plan's authoring constraints — the executor
runs it.)

**Checkpoint 1.** Request review before Task 2.

---

### Task 2 — Thread `AppHandle` + tab id into the Windows interceptor

**Files:** `src-tauri/src/adblock_win.rs`, `src-tauri/src/nav.rs`

**Step 2a — change `install`'s signature to carry the app + id**, mirroring the sibling
`nav_url_win::install(&pw, app, id)` (`nav_url_win.rs:22`) and
`nav_policy_win::install(&pw, app, id)` already called right beside it in `nav.rs`.

In `adblock_win.rs`, replace the top of `install`:

```rust
/// Install the ad-block request interceptor on the content webview. Call inside
/// `content_webview.with_webview(|pw| adblock_win::install(&pw, app, id))`. `app`+`id`
/// let the block branch bump the shield badge (`adblock::note_blocked`). Fails silently
/// if the WebView2 isn't ready — ad-block just won't be active, browsing is unaffected.
pub fn install(pw: &tauri::webview::PlatformWebview, app: tauri::AppHandle, id: u32) {
    let controller = pw.controller();
    let environment = pw.environment();
    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(_) => return,
        };
        if core
            .AddWebResourceRequestedFilter(&HSTRING::from("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
            .is_err()
        {
            return;
        }
        let env = environment.clone();
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_core, args| {
            if let Some(args) = args {
                // Fail open: never break a page if our check errors. The handler returns
                // whether it blocked, so we can count it on the badge.
                if handle(&env, &args).unwrap_or(false) {
                    crate::adblock::note_blocked(&app, id);
                }
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        let _ = core.add_WebResourceRequested(&handler, &mut token);
    }
}
```

**Step 2b — make `handle` report whether it blocked.** Change its return to `Result<bool>`:

```rust
/// Block a single request if the adblock engine matches it. Returns `Ok(true)` when the
/// request was blocked (so the caller can count it on the shield badge), `Ok(false)`
/// when it was allowed.
unsafe fn handle(
    env: &ICoreWebView2Environment,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
) -> Result<bool> {
    let request = args.Request()?;
    let mut uri = PWSTR::null();
    request.Uri(&mut uri)?;
    if uri.is_null() {
        return Ok(false);
    }
    let url = uri.to_string().unwrap_or_default();
    if !url.starts_with("http") {
        return Ok(false);
    }
    if crate::adblock_engine::should_block(&url, "", "other") {
        let response = env.CreateWebResourceResponse(
            None,
            204,
            &HSTRING::from("Blocked by Aegis"),
            &HSTRING::from(""),
        )?;
        args.SetResponse(&response)?;
        return Ok(true);
    }
    Ok(false)
}
```

**Step 2c — pass `app` + `id` at the call site** in `nav.rs` (the `#[cfg(target_os =
"windows")]` `with_webview` block at `nav.rs:398-406`). `id` is in scope as the tab id used
two lines below by `nav_url_win::install`; `app` is the function's `AppHandle`. Add a clone
and pass it:

```rust
    #[cfg(target_os = "windows")]
    if let Some(content) = app.get_webview(&label) {
        let app_ab = app.clone();
        let app_url = app.clone();
        let app_rg = app.clone();
        let _ = content.with_webview(move |pw| {
            crate::adblock_win::install(&pw, app_ab, id);
            crate::nav_url_win::install(&pw, app_url, id);
            crate::nav_policy_win::install(&pw, app_rg, id);
        });
    }
```

**Interfaces (Windows):** the handler emits the **existing** event, unchanged —
- event name: `adblock.blockedCount` (rewritten to `adblock:blockedCount` by `emit_event`)
- payload: `{ "viewId": id, "page": page, "session": session }` (matches `BlockedCount`).

**Verify (compile-only from Linux):**
`cargo check --target x86_64-pc-windows-gnu -p app`
Expect clean (needs `mingw64-gcc` + NASM/CMake per `src-tauri/CLAUDE.md` gotcha 14; this host
has mingw per memory). This proves the WebView2 COM + the new signature link on the Windows
toolchain.

**Manual device-verify (owner's Windows session, per §4):** Launch the portable exe, browse a
known ad-heavy page (e.g. the autopilot fixture or a real site), open the shield popover, and
confirm "Blocked here" / the badge rise above 0 and reset on a fresh top-frame navigation.
Record the result in the sub-project's verification note ("CI-built + device-verified by
owner").

**Checkpoint 2.** Request review before Task 3.

---

### Task 3 — Widen the desktop `reset_page` gate (Rust)

**Files:** `src-tauri/src/nav.rs`

The page-count reset on a new top-frame load is currently Linux-only (`nav.rs:251-254`):

```rust
            // New top-frame navigation → reset this tab's per-page blocked count (badge).
            #[cfg(target_os = "linux")]
            if loading {
                crate::adblock::reset_page(&app_load, load_id);
            }
```

Windows now counts, so it must also reset. Widen the gate to all desktop (macOS has no native
per-block count but a `reset_page` there is a harmless no-op-on-the-badge — it emits page 0 /
the unchanged session total, which is correct):

```rust
            // New top-frame navigation → reset this tab's per-page blocked count (badge).
            // Desktop-wide: Linux counts via resource-load-started, Windows via the WebView2
            // interceptor (adblock_win); macOS emits 0 (no native per-block callback there).
            #[cfg(desktop)]
            if loading {
                crate::adblock::reset_page(&app_load, load_id);
            }
```

**Interfaces:** same event/payload as Task 2.

**Verify:** `cargo check -p app` (Linux desktop) + `cargo check --target
x86_64-pc-windows-gnu -p app`. Both clean.

**Linux regression note:** `reset_page` already ran on Linux; widening to `desktop` is a
superset, so Linux behavior is byte-for-byte unchanged. (The `desktop` cfg includes linux.)

**Checkpoint 3.** Request review before Task 4.

---

### Task 4 — Android Kotlin counter + `window.__aegisBlockedCount` push

**Files:** `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

Android's JNI `should_block` has **no `AppHandle`** and Android has **no Tauri event bus** on
the content side, so counting lives in Kotlin and pushes to the chrome via
`evaluateJavascript`, exactly like `pushNavState` / `showRedirectBlocked`.

**Step 4a — add the counter state.** Near the other `@Volatile` fields (around the
`pageUrls`/`backInterceptActive` block, ~line 48-62), add:

```kotlin
  // Shield badge counters (the Android analog of the Rust adblock.rs counters; there's no
  // AppHandle in the JNI block path and no Tauri event bus on the content side, so they
  // live here and push window.__aegisBlockedCount to the chrome). sessionBlocked is the
  // monotonic session total; pageBlocked is per-tab and reset on each top-frame load.
  // Touched only from shouldInterceptRequest (a WebView network thread) and onPageStarted
  // (UI thread), so use thread-safe primitives.
  private val sessionBlocked = java.util.concurrent.atomic.AtomicInteger(0)
  private val pageBlocked = java.util.concurrent.ConcurrentHashMap<Int, Int>()
```

**Step 4b — add `noteBlocked(id)` + `resetPageBlocked(id)`.** Place near `pushNavState`:

```kotlin
  /** Count one blocked ad/tracker subresource on tab [id] and push the running totals to
   *  the chrome's shield badge via window.__aegisBlockedCount (the Android mirror of the
   *  Rust adblock::note_blocked → adblock.blockedCount event). Runs on a WebView network
   *  thread; the JS hop is posted to the chrome webview. */
  private fun noteBlocked(id: Int) {
    val session = sessionBlocked.incrementAndGet()
    val page = pageBlocked.merge(id, 1, Integer::sum) ?: 1
    pushBlockedCount(id, page, session)
  }

  /** Reset tab [id]'s per-page count on a new top-frame navigation (badge page → 0,
   *  session unchanged) and push it — the Android mirror of adblock::reset_page. */
  private fun resetPageBlocked(id: Int) {
    pageBlocked[id] = 0
    pushBlockedCount(id, 0, sessionBlocked.get())
  }

  /** Push a BlockedCount { viewId, page, session } to the chrome webview's
   *  window.__aegisBlockedCount (installed by ipcClient.ts on Android). */
  private fun pushBlockedCount(id: Int, page: Int, session: Int) {
    val obj = JSONObject()
      .put("viewId", id)
      .put("page", page)
      .put("session", session)
    val js = "window.__aegisBlockedCount && window.__aegisBlockedCount($obj)"
    chromeWebView?.post { chromeWebView?.evaluateJavascript(js, null) }
  }
```

**Step 4c — count inside `shouldInterceptRequest`'s ad-block branch.** In `makeContentClient`'s
`shouldInterceptRequest` (~line 152), the ad/tracker block branch currently logs + returns the
blocked response. Add the count there (NOT the malware branch — the badge counts ad/tracker
blocks, matching Linux/Windows, where malware is a separate guard):

```kotlin
          NativeAdblock.shouldBlock(url, firstParty, requestType(url, request)) -> {
            Log.i("AegisAdblock", "BLOCK $url")
            noteBlocked(id)
            blockedResponse()
          }
```

**Step 4d — reset the page count on each new top-frame load.** In the same per-tab
`WebViewClient`, `onPageStarted` (~line 119) fires once per top-frame navigation (main frame;
Android's `onPageStarted` is main-frame only — `src-tauri/CLAUDE.md` gotcha 13). Add the reset
there:

```kotlin
    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      pageUrls[id] = url
      resetPageBlocked(id)
      pushNavState(id, url, true, view)
    }
```

**Step 4e — clean up the counter when a tab closes/discards.** In `Bridge.closeTab` and
`Bridge.discardTab` (~lines 514, 527), after `pageUrls.remove(id)`, also drop the page entry so
the map doesn't grow unbounded (the session total stays — it's monotonic, like Rust):

```kotlin
      pageUrls.remove(id)
      pageBlocked.remove(id)
```

(Apply to both `closeTab` and `discardTab`. On `discardTab`, dropping the page count is correct:
re-activating reloads the tab, and the chrome recovers the count from `getState`'s `pageBlocked`
— except on Android `getState` runs through the Rust core which doesn't know the Kotlin count.
That's an accepted, documented limitation: a discarded-then-reactivated Android tab's badge
restarts from 0 until it blocks again, identical to a fresh load. Note it in the verification.)

**Interfaces (Android):**
- JS global the chrome installs: `window.__aegisBlockedCount(c)` where
  `c = { viewId: number, page: number, session: number }` (the `BlockedCount` shape).
- No Tauri event, no IPC channel — the established Android bridge pattern.

**Verify (compile-only from Linux):**
`JAVA_HOME=~/development/android-studio/jbr cargo check --target aarch64-linux-android -p app`
for the Rust side (unchanged by Task 4, but Task 1's edits must still compile for android), and
the Kotlin compile gate:
`JAVA_HOME=~/development/android-studio/jbr npm run android:build -- --target aarch64`
(the `compileUniversalDebugKotlin` task — per the "Android build gates runnable locally" memory,
both gates run on this Linux host with NDK 27 + JBR 21; needs JDK 21, NOT the machine default —
`src-tauri/CLAUDE.md` gotcha 8).

**Manual device-verify (emulator/device, per §4):** Install the debug APK, browse an ad-heavy
page, open the shield sheet, confirm "Blocked here"/badge rise > 0, navigate to a new page and
confirm the page count resets while "this session" keeps climbing.

**Checkpoint 4.** Request review before Task 5.

---

### Task 5 — Renderer: Android transport branch for `onBlockedCount`

**Files:** `src/lib/ipcClient.ts`

Today `adblock.onBlockedCount` (line 200) is Tauri-only:

```ts
    onBlockedCount: (cb) => on<BlockedCount>(IPC.evtAdblockBlockedCount, cb),
```

Add the Android branch, mirroring `nav.onState` (line 115) and `redirect.onBlocked` (line 203)
— install a `window.__aegisBlockedCount` callback set when the native bridge is present:

```ts
    onBlockedCount: (cb) => {
      // Android has no Tauri event bus on the content side; MainActivity pushes
      // BlockedCount via window.__aegisBlockedCount (set up here), mirroring nav state /
      // redirect.onBlocked. The desktop path uses the Tauri event.
      if (androidBridge()) {
        const w = window as unknown as {
          __aegisBlockedCountCbs?: Set<(c: BlockedCount) => void>;
          __aegisBlockedCount?: (c: BlockedCount) => void;
        };
        const cbs = (w.__aegisBlockedCountCbs ??= new Set());
        cbs.add(cb);
        w.__aegisBlockedCount = (c) => cbs.forEach((f) => f(c));
        return () => {
          cbs.delete(cb);
        };
      }
      return on<BlockedCount>(IPC.evtAdblockBlockedCount, cb);
    },
```

(`BlockedCount` is already imported in this file — it's the generic on `on<BlockedCount>`. If
the import is missing the executor adds it to the existing `shared/types` import.)

**Interfaces:** consumes `window.__aegisBlockedCount({ viewId, page, session })` from Kotlin
(Task 4) and the `adblock.blockedCount` Tauri event from desktop (Tasks 2-3). Both deliver the
`BlockedCount` shape to `useAdblock`'s `onBlockedCount` callback unchanged.

**Verify:** vitest. The existing `useAdblock.test.tsx` mocks `aegis.adblock.onBlockedCount`
directly, so it's unaffected. Add a focused `ipcClient` test (or extend the existing Android
bridge test if one exists) that, with a stubbed `window.AegisAndroid`, asserts
`aegis.adblock.onBlockedCount(cb)` installs `window.__aegisBlockedCount` and that calling it
invokes `cb` with the payload, and that the returned unsubscribe removes the callback. Pattern:
copy the `redirect.onBlocked` Android test if one exists; otherwise model it on the
`nav.onState` Android path test.

**Checkpoint 5.** Request review before Task 6.

---

### Task 6 — Autopilot: interaction coverage for the live badge (drift-guarded)

**Files:** `src/autopilot/interactions/toolbar.ts`

No new IPC channel and no new screen, so the IPC drift guard (`coverage.test.ts`) and
`screens.ts` are already satisfied (the `adblock` catalog entry already lists
`IPC.evtAdblockBlockedCount`; `shieldPopover` already exists in `screens.ts`). What's newly
real is **the badge reflecting an `onBlockedCount` event** on the active view — add/strengthen
an interaction spec so a user-visible regression (badge not updating) fails the build.

Add an `InteractionSpec` to `toolbar.ts` (the shieldPopover domain) along these lines:

```ts
  {
    id: 'toolbar.shieldPopover.badgeReflectsBlockedCount',
    domain: 'toolbar.shieldPopover',
    description:
      'An adblock.blockedCount event for the active view raises the shield badge + popover count',
    screen: 'home',
    layers: ['vitest'],
    mobile: true, // the badge + onBlockedCount path is shared with the mobile shield
    run: async (ctx) => {
      // Emit a BlockedCount for the active view through the mocked onBlockedCount callback,
      // then open the shield popover to read the figures.
      ctx.emitBlockedCount?.({ viewId: BASE_NAV.viewId, page: 3, session: 7 });
      const shield = ctx.byRole('button', 'Ad blocking');
      if (shield) await ctx.click(shield);
    },
    assert: async (ctx) => {
      const badge = ctx.container.querySelector('.adblock-shield__badge');
      if (badge?.textContent !== '3') throw new Error(`badge=${badge?.textContent}, want 3`);
      return 'shield badge shows the blocked-count page total';
    },
  },
```

This requires a small ctx helper `emitBlockedCount` in `interactionCtx.ts` mirroring the
existing `emitNavState`/`emitTabsState` (capture the callback from
`aegis.adblock.onBlockedCount.mock.calls[0][0]` and fire it inside `flushSync`/`act`). Add it
the same way those were added; if the existing harness already exposes a generic event-emit,
reuse it instead.

Register the new control id (`toolbar.shieldPopover.badgeReflectsBlockedCount`'s control
prefix, e.g. `toolbar.shieldPopover`) in `INTERACTIVE_CONTROLS` if it isn't already present
(the existing shield-popover specs likely already register `toolbar.shieldPopover`; if so, no
new control id is needed — the coverage guard only requires each control have ≥1 spec).

**Verify:** `npm test` — the desktop + mobile interaction tours run the new spec; the
`interactions.coverage.test.ts` drift guard stays green (unique id, valid screen, control has a
spec).

**Live autopilot note:** the live A/B ad-block trace is **unchanged** — Linux behavior is
untouched (Tasks 2-5 are Windows/Android/renderer-only; Task 1/3 are supersets on Linux). The
live run must still report `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`. Do NOT
add a live-layer assertion on the count (the Linux count is known-incomplete per gotcha 6 — a
live assert that the badge rises would be flaky exactly as the existing ad-block-induction step
documents, which is why it's an honest skip).

**Checkpoint 6.** Request review before final gate.

---

### Final gate (spec §6.3 + §4)

1. `npm test` → green (Rust adblock tests via the node-or-cargo path the suite uses for Rust;
   vitest renderer + autopilot drift guards). If `npm test` does not run cargo, also run
   `cargo test -p app --lib` and report its output.
2. `cargo check -p app` (Linux) + `cargo check --target x86_64-pc-windows-gnu -p app`
   (Windows cross) + `cargo check --target aarch64-linux-android -p app` (Android) — all clean.
3. Kotlin gate: `JAVA_HOME=~/development/android-studio/jbr npm run android:build -- --target
   aarch64` → `compileUniversalDebugKotlin` green.
4. Linux live autopilot: `bash scripts/autopilot/run-autopilot.sh` → `RESULT: … 0 failed` and
   `ad-block blocking (trace): PASS` (proves no Linux regression).
5. Manual device-verify entries recorded for Windows (owner session) and Android
   (emulator/device): badge rises on a block, page count resets on a new top-frame load,
   session total stays monotonic.
6. Update the status docs in the **same commit** (living-docs rule): `src-tauri/CLAUDE.md`
   — change the "Counting is wired on **Linux** only so far … Win/Android is a follow-up" line
   (adblock.rs section + gotcha 6) to record Windows + Android now count; and the top-level
   `CLAUDE.md` Status note "(The shield block-*counter* is still Linux-only …)".

---

## Double-counting concern (vs Linux semantics) — explicit analysis

The spec flags this; here is the honest assessment per platform:

- **Linux (unchanged).** Counts only what `resource-load-started` sees AND `should_block`
  flags — a subset of real blocks (content-filter-cancelled requests never fire the signal).
  We touch nothing here.
- **Windows.** The `WebResourceRequested` handler fires **once per request** and we count
  **only the branch that actually substitutes the 204** (`handle` returns `true`). There is no
  second Windows interception tier that would also count: the injected JS tier
  (`adblock_inject.rs`) blocks `fetch`/`XHR` in the page and does **not** call `note_blocked`,
  and the `on_new_window` pop-under drop is a separate window-open path, not a subresource.
  So a given blocked subresource is counted at most once. Risk: a request the engine blocks
  that the page then *retries* (different request → counted again) — this matches Linux/real
  browser-extension semantics (each blocked request is an event) and is acceptable; the badge
  is "ads blocked", not "distinct ad URLs".
- **Android.** Counted exactly once, in `shouldInterceptRequest`'s ad-block branch. The
  malware branch is deliberately **not** counted (parity: Linux/Windows count ad/tracker
  blocks, not malware). The `onCreateWindow` pop-under drop is a window-open path, not a
  subresource, and is not counted — same as Windows. `should_block` is also called from
  `onCreateWindow`, but that call does not invoke `noteBlocked`, so no double-count.
- **Cross-platform.** Each platform owns its own counter; there is no shared counter that two
  platforms could both bump. The event payload shape is identical, so the chrome's `useAdblock`
  treats all three the same.

**Net:** no double-counting introduced relative to Linux semantics; each platform counts its
own one-per-blocked-subresource events, and the badge's meaning ("requests this tier blocked,
this page / this session") is consistent — and, as on Linux, explicitly **not** a claim of true
total blocks.

---

## Self-Review

- **Spec alignment (§3 G):** Windows counts in `adblock_win.rs`'s block path ✔; Android counts
  in the `shouldInterceptRequest` JNI/Kotlin path ✔; both deliver the same
  `adblock.blockedCount` / `BlockedCount` the Linux path uses ✔ (desktop via the Tauri event;
  Android via the established `window.__aegis*` bridge because there is no Tauri event bus on
  the Android content side — verified against `nav.onState`/`redirect.onBlocked`). Linux
  unchanged ✔ (Tasks 2/4/5 don't touch Linux; Tasks 1/3 are supersets — `desktop` ⊇ `linux`,
  and the extracted pure fns preserve byte-for-byte behavior). Autopilot ad-block trace still
  PASS ✔ (no Linux runtime change).
- **No invented APIs.** `note_blocked`/`reset_page`/`bump`-style counters, `emit_event`,
  `should_block`, `WebResourceRequestedEventHandler`/`handle`, `PlatformWebview`,
  `with_webview`, `nav_url_win::install(&pw, app, id)` signature precedent, `pushNavState`/
  `evaluateJavascript`/`chromeWebView?.post`, `window.__aegisNavState`/`__aegisRedirectBlocked`
  bridge pattern, `androidBridge()`, `AtomicInteger`/`ConcurrentHashMap`,
  `WebViewClient.onPageStarted` (main-frame), `BlockedCount` type — **all read directly from
  the codebase**, not assumed. The one new global, `window.__aegisBlockedCount`, follows the
  exact shape of the two existing ones.
- **Honesty constraint honored.** The plan never claims badge == true blocks; it explicitly
  reproduces Linux's "count what this tier sees" semantics and keeps the autopilot's proof of
  blocking on the A/B trace, not the count. The Android discard→reactivate count-restart and
  the macOS "no native per-block callback" ceiling are documented, not hidden.
- **Three-places rule:** correctly identified as **N/A** — `adblock.blockedCount`/`BlockedCount`
  already exist in all three places; the change is an Android *transport branch* on the
  existing `onBlockedCount`, not a new channel. Drift guards remain satisfied; Task 6 adds the
  interaction coverage the living-docs/coverage rules require.
- **Testability:** the pure accumulation logic is unit-tested via the extracted
  `bump_blocked`/`zero_page` `#[test]`s (the testable core); the event/payload shape is
  asserted by the renderer test (Task 5) + the interaction spec (Task 6). Windows/Android
  runtime is compile-gated (cross + Kotlin compile, both runnable on this Linux host per memory)
  + manual device-verify, exactly as §4's verification reality prescribes.
- **Parity:** Linux ✔ (already) / Windows ✔ / Android ✔ / macOS documented ceiling (injected JS
  tier has no native per-block callback) / iOS out of scope. Matches the spec scoping G to
  "Windows + Android".
- **Residual risks flagged:** (1) Windows runtime not verifiable from here → owner device step;
  (2) Android discarded-tab count restarts at 0 on reactivation (Rust `getState` can't see the
  Kotlin count) — documented as accepted; (3) the new `bump_blocked`/`zero_page` `#[test]`s use
  process-global atomics with disjoint tab ids and delta assertions to avoid cross-test
  interference (noted in the test comment).

**Self-review result: PASS** — plan is concrete, grounded in verified code, honors the
honesty + parity + three-places constraints, makes the testable core actually tested, and gives
real compile/device verification steps for the non-Linux runtimes. No placeholders, no invented
APIs.
