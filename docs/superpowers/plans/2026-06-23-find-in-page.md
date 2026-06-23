# Find-in-Page (Ctrl+F) — Sub-project D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to execute this plan. Each task below is a self-contained TDD unit (write the failing
> test first, then the minimum code to pass). Dispatch one subagent per task, in order;
> review each task's diff against its acceptance before starting the next. Do NOT batch
> tasks — the per-task gates (`npm test`, the relevant `cargo check --target …`) are the
> review checkpoints.

## Goal

Add a Ctrl+F **find bar** to the Aegis chrome that searches the _content_ webview for a
term, shows a **match count**, cycles **next/prev**, **highlights** matches, and closes on
**Esc**. Wire it through new `find.*` IPC channels to a **real per-engine find** on all four
platforms — WebKitGTK (`WebKitFindController`), WebView2 (`ICoreWebView2Find`), WKWebView
(`findString:withConfiguration:`), and Android (`WebView.findAllAsync` + `setFindListener`).
Register autopilot catalog/screen/interaction entries **in the same commits** (drift guard).

Per §4 (verification reality): Linux + Android are live-verifiable on this host; Windows +
macOS get a `cargo check --target …` compile gate here plus a documented manual device step.

## Architecture

```
  Ctrl+F (chrome keydown)            find.state event (matchCount, activeIndex)
         │                                          ▲
         ▼                                          │
  FindBar.tsx ──aegis.find.*──► ipcClient ──invoke('ipc',{channel:'find.*'})──► lib.rs ipc()
                                                                                    │
                                                              find::dispatch(app, channel, payload)
                                                                                    │
        ┌───────────────────────────────┬───────────────────┬───────────────────┐
        ▼ (Linux)                        ▼ (Windows)          ▼ (macOS)           ▼ (Android)
  find_linux.rs                    find_win.rs          find_mac.rs         (no Rust dispatch;
  WebKitFindController             ICoreWebView2Find    WKWebView           Kotlin Bridge.find*
  .search / .search_next /         .Start/.FindNext/    findString:with-    → findAllAsync /
  .search_previous /.search_finish .FindPrevious/.Stop  Configuration:      setFindListener /
  + connect_found_text(count)      + add_MatchCount-    (matchFound only)   findNext / clearMatches
                                     Changed (count)                         → window.__aegisFind* push
```

- The find UI lives entirely in the **chrome** webview (like `RedirectBar` — an infobar
  that adds to the content inset), because the content webview is opaque and on top.
- The **active tab** is the find target everywhere — keyed on `tabs.activeId` (desktop) /
  `activeTabId` (Android), mirroring how `nav`/`adblock` already key on the active view.
- A `find.state` **event** (Rust→chrome `emit_event`, dotted→colon at the boundary; Android
  pushes via a `window.__aegisFindState` global, mirroring `__aegisNavState`) carries the
  live `matchCount`/`activeMatchIndex` back to `FindBar`, because the native count arrives
  asynchronously (a signal/callback), not as a return value.

## Tech Stack

- **Chrome:** React 19 + TypeScript; `FindBar.tsx` mirrors `RedirectBar.tsx`/`AddressBar.tsx`
  (lucide-react icons, `aria-label`s, controlled input). Hook `useFind(activeViewId)`.
- **IPC contract:** `shared/types.ts` `IPC` const + `FindState` interface + `AegisApi.find`.
- **Rust:** new `find.rs` dispatcher + per-platform modules `find_linux.rs` /`find_win.rs` /
  `find_mac.rs`, each reached through the **same** `Webview::with_webview → PlatformWebview`
  pattern `nav_url_win.rs` / `nav_url_mac.rs` / `linux_layout.rs` already use.
- **Native APIs (verified against the installed crates — see Appendix A):**
  - Linux: `webkit2gtk 2.0.2` `WebViewExt::find_controller()`, `FindControllerExt`,
    `FindOptions` (feature `v2_40`, already on).
  - Windows: `webview2-com 0.38.2` `ICoreWebView2_28::Find()`, `ICoreWebView2Find`,
    `ICoreWebView2Environment15::CreateFindOptions()`, `ICoreWebView2FindOptions`,
    `webview2_com::{FindStartCompletedHandler, FindMatchCountChangedEventHandler}`.
  - macOS: `objc2-web-kit 0.3.2` `WKWebView::findString_withConfiguration_completionHandler`,
    `WKFindConfiguration`, `WKFindResult` (**features must be enabled — see Task 8**).
  - Android: `WebView.findAllAsync(String)`, `WebView.setFindListener(FindListener)`,
    `WebView.findNext(boolean)`, `WebView.clearMatches()` (standard Android SDK, API 16+).
- **Autopilot:** `catalog.ts` (+`verify`), `screens.ts` (+`reach.ts`), `interactions/find.ts`
  (+`controls.ts`), in the same commit as each surface (drift-guarded by
  `coverage.test.ts` / `interactions.coverage.test.ts`).

## Global Constraints (copied from spec §6 — apply to EVERY task)

1. **IPC in three places.** A new channel goes in **(1)** `shared/types.ts` (`IPC` const +
   the `FindState` payload interface + the `AegisApi.find` namespace), **(2)** the Rust
   `ipc()` dispatcher in `src-tauri/src/lib.rs` (a `mod find;` + a `find::dispatch(...)` arm
   before the fallthrough; `find::dispatch` returns `None` for non-`find.*` channels), and
   **(3)** `src/lib/ipcClient.ts` (`call<T>(IPC.x, payload)` for commands; `on<T>(IPC.evtX,
cb)` for the event). The `shared/types.ts` `types.test.ts` invariant rejects a
   malformed/duplicate channel name.
2. **Event names: dotted logically, `.`→`:` at the boundary.** The `find.state` event is
   declared dotted (`evtFindState: 'find.state'`). Rust emits it **only** via
   `crate::emit_event(app, "find.state", payload)` (which rewrites `.`→`:`); never
   `app.emit` a raw dotted name. The JS side reverses `:`→`.` in `tauriInvoke.ts on()`.
   Tauri 2 forbids `.` in event names — this is non-negotiable.
3. **Autopilot coverage in the SAME commit (drift-guarded).** New channel → a `catalog.ts`
   entry (`channels` listing every `IPC.find*` it exercises + an `exercise(api)`; plus a
   `verify(api)` round-trip since find mutates webview search state). New UI surface (the
   find bar / its screen) → a `screens.ts` entry + `reach.ts` wiring. New interactive
   controls (the find input, next, prev, close, Ctrl+F open) → `interactions/find.ts`
   specs + ids added to `controls.ts` `INTERACTIVE_CONTROLS`. `coverage.test.ts` and
   `interactions.coverage.test.ts` fail the build if any of these is missing.
4. **Per-platform gate (parity before "done").** Bring Linux/Windows/macOS/Android to the
   same level (§4 reality):
   - **Linux:** `npm test` green **and** live autopilot `RESULT: … 0 failed` **and**
     `ad-block blocking (trace): PASS` (run `bash scripts/autopilot/run-autopilot.sh`).
   - **Android:** `cargo check --target aarch64-linux-android` + the Kotlin gate
     (`JAVA_HOME=~/development/android-studio/jbr` … `compileUniversalDebugKotlin`) green,
     then a device run (find a term, count shows, next/prev cycle, Esc closes).
   - **Windows:** `cargo check --target x86_64-pc-windows-gnu` green + a **documented manual
     device-verify step** (the owner's Windows session): Ctrl+F, type, count + highlight,
     next/prev, Esc.
   - **macOS:** `cargo check` is impossible from this Linux box (objc2 needs a Mac C
     toolchain — see [[aegis-macos-crosscompile]]); the gate is **CI build green**
     (`tauri-build-check.yml` on macos-latest) + a **documented manual device step**
     (sub-project I, hardware-gated). The plan still writes the real objc2 code.

A push that adds the find capability without its autopilot coverage is INCOMPLETE.

## File Structure

```
shared/
  types.ts                         (MOD: IPC.find*, FindState, AegisApi.find)
src/
  lib/ipcClient.ts                 (MOD: aegis.find namespace; Android __aegisFindState push)
  hooks/useFind.ts                 (NEW: find state hook, keyed on activeViewId)
  hooks/useFind.test.ts            (NEW)
  components/FindBar.tsx           (NEW: the infobar UI)
  components/FindBar.test.tsx      (NEW)
  lib/layout.ts                    (MOD: FIND_BAR_H constant)
  App.tsx                          (MOD: Ctrl+F state + <FindBar/> wiring + inset)
  index.css                        (MOD: .find-bar styles)
  autopilot/catalog.ts             (MOD: find catalog entry + verify)
  autopilot/screens.ts             (MOD: 'findBar' screen)
  autopilot/reach.ts               (MOD: reach/leave findBar)
  autopilot/interactions/find.ts   (NEW: interaction specs)
  autopilot/interactions/index.ts  (MOD: spread FIND_INTERACTIONS)
  autopilot/interactions/controls.ts (MOD: find.* control ids)
src-tauri/
  src/find.rs                      (NEW: find.* dispatcher + per-platform glue calls)
  src/find_linux.rs                (NEW, #[cfg(linux)]: WebKitFindController)
  src/find_win.rs                  (NEW, #[cfg(windows)]: ICoreWebView2Find)
  src/find_mac.rs                  (NEW, #[cfg(macos)]: WKWebView findString)
  src/lib.rs                       (MOD: mod find{,_linux,_win,_mac}; find::dispatch arm; install hooks in spawn_tab)
  src/nav.rs                       (MOD: per-tab find install in spawn_tab, like nav_url_*)
  Cargo.toml                       (MOD: objc2-web-kit features for WKFind*)
  gen/android/app/src/main/java/com/aegis/browser/
    MainActivity.kt                (MOD: Bridge.find/findNext/findPrev/findClose + FindListener + __aegisFindState push)
docs/
  superpowers/plans/2026-06-23-find-in-page.md   (this file)
```

---

## Task 1 — IPC contract: `find.*` channels + `FindState` + `AegisApi.find`

Define the contract first so every later task compiles against it. NO behavior yet.

**Files:** `shared/types.ts`, `shared/types.test.ts` (drift invariant already enforces shape).

**Interfaces (exact):**

```ts
// IPC const additions:
findStart: 'find.start',       // begin/refine a search for a term on the active view
findNext: 'find.next',         // move to the next match
findPrev: 'find.prev',         // move to the previous match
findClose: 'find.close',       // end the search + clear highlights
evtFindState: 'find.state',    // main -> chrome: live match count / active index

// payload interface:
export interface FindState {
  viewId: ViewId;
  query: string;
  matchCount: number;     // total matches (0 when none / not searching)
  activeMatchIndex: number; // 1-based index of the focused match, 0 when none/unknown
}

// AegisApi.find namespace:
find: {
  start(viewId: ViewId, query: string, caseSensitive?: boolean): Promise<void>;
  next(viewId: ViewId): Promise<void>;
  prev(viewId: ViewId): Promise<void>;
  close(viewId: ViewId): Promise<void>;
  onState(cb: (s: FindState) => void): () => void;
};
```

**Steps (one action each):**

1. Write a test in `shared/types.test.ts` asserting `IPC.findStart === 'find.start'` and
   the four other names exist and are dot-separated (the existing uniqueness invariant
   already covers collisions). Run `npm test` — RED (names absent).
2. Add the five names to the `IPC` const, the `FindState` interface, and the `find`
   namespace to `AegisApi`. Run `npm test` — GREEN.

**Note:** `activeMatchIndex` is best-effort. WebKitGTK's `found-text` signal gives the
_count_ but not the active index; Windows `ICoreWebView2Find` gives BOTH (`ActiveMatchIndex`

- `add_ActiveMatchIndexChanged`); Android's `FindListener` gives both
  (`activeMatchOrdinal` + `numberOfMatches`); macOS gives NEITHER reliably (see Task 8). So
  `activeMatchIndex: 0` is a legal "unknown" everywhere.

---

## Task 2 — `ipcClient.ts`: `aegis.find` (PLACE 3) + Android push wiring

**Files:** `src/lib/ipcClient.ts`, `src/lib/ipcClient.test.ts` (if present; else assert via
`useFind.test.ts` in Task 4).

**Interfaces:** implement the `find` namespace. Desktop → `call`/`on`. Android (`AegisAndroid`
bridge) → call the bridge methods + subscribe to a `window.__aegisFindState` global pushed by
Kotlin (mirroring `nav.onState`'s `__aegisNavState` multi-subscriber pattern exactly).

```ts
// AndroidBridge interface additions (Task 11 implements them in Kotlin):
find(query: string, caseSensitive: boolean): void;
findNext(): void;
findPrev(): void;
findClose(): void;
```

**Steps:**

1. Write a test that `aegis.find.start(1, 'foo')` calls `call(IPC.findStart, {viewId:1,
query:'foo', caseSensitive:false})` (mock `call`). RED.
2. Implement the desktop branch:
   ```ts
   find: {
     start: (viewId, query, caseSensitive = false) => {
       const a = androidBridge();
       if (a) { a.find(query, caseSensitive); return Promise.resolve(); }
       return call(IPC.findStart, { viewId, query, caseSensitive });
     },
     next: (viewId) => {
       const a = androidBridge();
       if (a) { a.findNext(); return Promise.resolve(); }
       return call(IPC.findNext, { viewId });
     },
     prev: (viewId) => {
       const a = androidBridge();
       if (a) { a.findPrev(); return Promise.resolve(); }
       return call(IPC.findPrev, { viewId });
     },
     close: (viewId) => {
       const a = androidBridge();
       if (a) { a.findClose(); return Promise.resolve(); }
       return call(IPC.findClose, { viewId });
     },
     onState: (cb) => {
       if (androidBridge()) {
         const w = window as unknown as {
           __aegisFindStateCbs?: Set<(s: FindState) => void>;
           __aegisFindState?: (s: FindState) => void;
         };
         const cbs = (w.__aegisFindStateCbs ??= new Set());
         cbs.add(cb);
         w.__aegisFindState = (s) => cbs.forEach((f) => f(s));
         return () => { cbs.delete(cb); };
       }
       return on<FindState>(IPC.evtFindState, cb);
     },
   },
   ```
   Import `FindState` from `../../shared/types`. Run `npm test` — GREEN.

---

## Task 3 — `FindBar.tsx` component (the infobar UI) + test

**Files:** `src/components/FindBar.tsx` (NEW), `src/components/FindBar.test.tsx` (NEW),
`src/lib/layout.ts` (add `FIND_BAR_H`), `src/index.css` (`.find-bar` styles).

**Interface:**

```ts
export function FindBar(props: {
  state: FindState;
  onQueryChange(q: string): void; // debounced 'find.start' caller in App
  onNext(): void;
  onPrev(): void;
  onClose(): void; // also bound to Esc
}): React.JSX.Element;
```

Mirror `RedirectBar.tsx` structure. Controls (each with an `aria-label` the autopilot keys
on): a text input `aria-label="Find in page"`, a `"<count> / <total>"` status span
(`role="status"`), buttons `aria-label="Find previous"` / `"Find next"` (disabled when
`matchCount === 0`), and `aria-label="Close find"` (X). The input `onKeyDown`: `Enter` →
`onNext()`, `Shift+Enter` → `onPrev()`, `Escape` → `onClose()`. Auto-focus the input on
mount (`useRef` + `useEffect(() => ref.current?.focus(), [])`), like a real browser.

**Steps:**

1. Add `export const FIND_BAR_H = 40;` to `lib/layout.ts` with a doc comment mirroring
   `REDIRECT_BAR_H`.
2. Write `FindBar.test.tsx` (jsdom + `@testing-library/react`):
   - renders the input with `aria-label="Find in page"`; typing fires `onQueryChange`.
   - `state={{matchCount:3, activeMatchIndex:2,…}}` renders status text containing `2/3`.
   - clicking "Find next"/"Find previous" fires `onNext`/`onPrev`.
   - pressing `Escape` in the input fires `onClose`.
   - `matchCount:0` → next/prev buttons are `disabled` and status shows `0/0` (or
     "No results"). RED.
3. Implement `FindBar.tsx` to pass. Add `.find-bar` CSS (copy `.redirect-bar` layout; it
   sits in the same chrome strip). Run `npm test` — GREEN.

---

## Task 4 — `useFind` hook + Ctrl+F wiring in `App.tsx`

**Files:** `src/hooks/useFind.ts` (NEW), `src/hooks/useFind.test.ts` (NEW), `src/App.tsx`
(MOD), `src/components/FindBar.tsx` already done.

**Interface:**

```ts
export function useFind(activeViewId: ViewId): {
  open: boolean;
  state: FindState;
  show(): void; // open the bar
  close(): void; // close + aegis.find.close
  setQuery(q: string): void; // debounced aegis.find.start
  next(): void; // aegis.find.next
  prev(): void; // aegis.find.prev
};
```

Subscribe to `aegis.find.onState`, filtering on `s.viewId === activeViewId` (exactly like
`useNav`/`App`'s `onFailed` viewId guard). On tab switch (`activeViewId` change) reset the
state to empty and call `aegis.find.close` for the old view (so highlights don't linger on a
background tab). Debounce `setQuery` ~120 ms before calling `aegis.find.start` so each
keystroke doesn't restart the native search.

**App.tsx wiring (mirror the `RedirectBar` block + the existing keydown effects):**

- A `window` `keydown` effect: `if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='f')
{ e.preventDefault(); find.show(); }`. (Guard against the Windows tab-shortcut effect —
  `f` is not used there, no conflict.)
- Render `{find.open && <FindBar state={find.state} onQueryChange={find.setQuery}
onNext={find.next} onPrev={find.prev} onClose={find.close} />}` right after the
  `{blockedRedirect && <RedirectBar/>}` block.
- Add the bar's height to the content inset when open, mirroring the redirect bar:
  `useContentInset(tabs.activeId, !isMobile, (blockedRedirect ? REDIRECT_BAR_H : 0) +
(find.open ? FIND_BAR_H : 0));`

**Steps:**

1. `useFind.test.ts`: mount the hook with a mocked `aegis`; assert `setQuery('x')` →
   (after debounce/`act`) `aegis.find.start` called with the active viewId + `'x'`; assert
   an `onState` event with a non-matching `viewId` is ignored; assert tab switch resets +
   calls `find.close`. RED → implement → GREEN.
2. Add an `App.tsx` interaction test later in Task 9 (autopilot). For now wire App and run
   the existing `tour.test.tsx` to confirm no crash. Run `npm test` — GREEN.

---

## Task 5 — Rust `find.rs` dispatcher (PLACE 2) + lib.rs registration

The dispatcher routes `find.*` to per-platform glue. On non-find channels it returns `None`.
The actual native call is delegated to `find_{linux,win,mac}` (Tasks 6–8); Android does NOT
route through here (its find is driven in Kotlin — Task 11). This task adds the dispatcher
with **platform-gated calls that are no-ops until the per-platform tasks land**, so the build
stays green incrementally.

**Files:** `src-tauri/src/find.rs` (NEW), `src-tauri/src/lib.rs` (MOD).

**Interface (exact Rust signatures):**

```rust
// find.rs
use serde_json::Value;
use tauri::AppHandle;

/// Handle `find.*` channels. Returns `None` if `channel` is not a find channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    // resolve the target tab id (default = active), like nav::dispatch
    let id = payload.get("viewId").and_then(Value::as_u64).map(|n| n as u32)
        .unwrap_or_else(|| crate::tabs_active_id(app)); // helper mirrors nav::active id read
    let res: Result<Value, String> = match channel {
        "find.start" => {
            let q = payload.get("query").and_then(Value::as_str).unwrap_or("").to_string();
            let cs = payload.get("caseSensitive").and_then(Value::as_bool).unwrap_or(false);
            start(app, id, &q, cs);
            Ok(Value::Null)
        }
        "find.next"  => { next(app, id);  Ok(Value::Null) }
        "find.prev"  => { prev(app, id);  Ok(Value::Null) }
        "find.close" => { close(app, id); Ok(Value::Null) }
        _ => return None,
    };
    Some(res)
}

/// Emit a find.state snapshot to the chrome (dotted name; emit_event rewrites .→:).
pub(crate) fn emit_state(app: &AppHandle, view_id: u32, query: &str, match_count: u32, active: u32) {
    let _ = crate::emit_event(app, "find.state", serde_json::json!({
        "viewId": view_id, "query": query,
        "matchCount": match_count, "activeMatchIndex": active,
    }));
}

// Platform dispatch: each is a thin cfg-routed call into the per-platform module.
fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    #[cfg(target_os = "linux")]   crate::find_linux::start(app, id, query, case_sensitive);
    #[cfg(target_os = "windows")] crate::find_win::start(app, id, query, case_sensitive);
    #[cfg(target_os = "macos")]   crate::find_mac::start(app, id, query, case_sensitive);
}
fn next(app: &AppHandle, id: u32)  { /* cfg-routed like start */ }
fn prev(app: &AppHandle, id: u32)  { /* cfg-routed like start */ }
fn close(app: &AppHandle, id: u32) { /* cfg-routed like start */ }
```

For the **active-id helper**, do NOT invent a new `crate::tabs_active_id`; reuse the existing
read used across the codebase: `app.try_state::<crate::tabs::Tabs>().map(|s|
s.reg.lock().unwrap().active_id()).unwrap_or(1)`. Inline it (it's the same expression
`nav::dispatch` uses). The `start/next/prev/close` bodies for not-yet-implemented platforms
should be empty `fn`s (the `#[cfg]` calls simply don't expand) — the module still compiles on
every target.

**lib.rs additions:**

```rust
mod find;
#[cfg(target_os = "linux")]   mod find_linux;
#[cfg(target_os = "windows")] mod find_win;
#[cfg(target_os = "macos")]   mod find_mac;
```

and in `ipc()`, add **before** the fallthrough match (after `nav::dispatch`, grouped with the
other view-ish dispatchers):

```rust
if let Some(result) = find::dispatch(&app, &channel, &payload) { return result; }
```

**Steps:**

1. Add a `find.rs` unit test asserting `dispatch(app, "settings.get", &json!({}))` is `None`
   and `dispatch` returns `Some(Ok(Null))` for `find.close` (a no-op path needs no webview).
   _(If an AppHandle is awkward in a unit test, test the pure helper: factor the
   "is this a find channel" match into a `pub fn is_find_channel(&str) -> bool` and unit-test
   THAT instead — mirror how other modules keep AppHandle-free testable cores.)_ RED.
2. Implement `find.rs` + the `lib.rs` `mod` lines + the dispatch arm. Run
   `cargo test` (locally) — the find module test GREEN; `cargo check` GREEN (no-op platform
   bodies). Run `npm test` — unaffected, GREEN.

---

## Task 6 — Linux: `find_linux.rs` via `WebKitFindController` (LIVE-VERIFIABLE)

**Files:** `src-tauri/src/find_linux.rs` (NEW), `src-tauri/src/nav.rs` (MOD: install the
found-text counter hook per tab in `spawn_tab`'s `#[cfg(target_os="linux")]` block).

**Verified API (Appendix A.1):** `webkit2gtk::WebViewExt::find_controller() ->
Option<FindController>`; `FindControllerExt::{search(text, options:u32, max:u32),
search_next(), search_previous(), search_finish(), connect_found_text(Fn(&Self, u32)),
connect_failed_to_find_text(Fn(&Self))}`; `FindOptions::{CASE_INSENSITIVE, WRAP_AROUND,
BACKWARDS}` (a `bitflags` u32). `search`/`count_matches` take the raw `u32`
(`options.bits()`).

**Interface (exact):**

```rust
// find_linux.rs
use gtk::prelude::*;
use tauri::{AppHandle, Manager};
use webkit2gtk::{FindController, FindControllerExt, FindOptions, WebViewExt};

/// Install (once per tab, at spawn) the found-text/failed signal handlers on this tab's
/// WebKitFindController so a search pushes the live match count to the chrome. Called from
/// nav::spawn_tab's Linux block, like connect_block_counter/connect_url_tracker.
pub fn install(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else { return };
    let Some(id) = label.strip_prefix("content:").and_then(|s| s.parse::<u32>().ok()) else { return };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        if let Some(fc) = pw.inner().find_controller() {
            let app_found = app.clone();
            fc.connect_found_text(move |c, count| {
                let q = c.search_text().map(|s| s.to_string()).unwrap_or_default();
                // WebKitGTK has no active-index getter; report 1 when there's at least one
                // match (the controller focuses the first), else 0.
                crate::find::emit_state(&app_found, id, &q, count, if count > 0 { 1 } else { 0 });
            });
            let app_fail = app.clone();
            fc.connect_failed_to_find_text(move |c| {
                let q = c.search_text().map(|s| s.to_string()).unwrap_or_default();
                crate::find::emit_state(&app_fail, id, &q, 0, 0);
            });
        }
    });
}

const MAX_MATCHES: u32 = 1000;

fn controller(app: &AppHandle, id: u32) -> Option<FindController> {
    let w = app.get_webview(&crate::nav::content_label(id))?;
    // with_webview runs the closure on the GTK thread; return the controller out of it.
    // (FindController is a glib object; cloning it is a refcount bump — safe to move out.)
    let mut out = None;
    let _ = w.with_webview(|pw| { out = pw.inner().find_controller(); });
    out
}

pub fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    if let Some(fc) = controller(app, id) {
        let mut opts = FindOptions::WRAP_AROUND;
        if !case_sensitive { opts |= FindOptions::CASE_INSENSITIVE; }
        if query.is_empty() {
            fc.search_finish();
            crate::find::emit_state(app, id, "", 0, 0);
            return;
        }
        // search() both highlights+selects the first match AND, by emitting found-text,
        // gives the count via the connected handler. Use search() (not count_matches) so
        // the page actually highlights.
        fc.search(query, opts.bits(), MAX_MATCHES);
    }
}
pub fn next(app: &AppHandle, id: u32)  { if let Some(fc) = controller(app, id) { fc.search_next(); } }
pub fn prev(app: &AppHandle, id: u32)  { if let Some(fc) = controller(app, id) { fc.search_previous(); } }
pub fn close(app: &AppHandle, id: u32) {
    if let Some(fc) = controller(app, id) { fc.search_finish(); }
    crate::find::emit_state(app, id, "", 0, 0);
}
```

> **VERIFY-FIRST caveat for the implementing agent (do NOT skip):** `with_webview`'s closure
> signature is `FnMut(PlatformWebview) + Send + 'static`. The `controller()` helper above
> writes into a captured `out` from inside the closure — confirm by reading
> `linux_layout.rs` (it uses the same `with_webview(move |pw| …)` form) that this compiles;
> if the borrow checker rejects moving the `FindController` out of the closure (it runs
> async on the GTK loop), **fall back** to the pattern `linux_layout::set_content_visible_label`
> uses: do the whole `search/next/prev` INSIDE the `with_webview` closure (look the
> controller up there each call) rather than returning it. Both are valid; pick the one that
> compiles. Either way the `found-text` signal (installed once in `install`) is what carries
> the count back — do not try to read the count synchronously.

**nav.rs (spawn_tab Linux block) — add one line** next to `connect_block_counter`:

```rust
crate::find_linux::install(app, &label);
```

**Steps:**

1. Unit-test the pure bit math: a `pub fn options_bits(case_sensitive: bool) -> u32` that
   returns `WRAP_AROUND | CASE_INSENSITIVE` when insensitive, `WRAP_AROUND` when sensitive;
   assert the two distinct values. (The signal/IPC path is covered live, not in `cargo
test`.) RED → implement → GREEN (`cargo test`).
2. Implement `find_linux.rs` + the `spawn_tab` install line. `cargo check` GREEN.
3. **LIVE:** `bash scripts/autopilot/run-autopilot.sh`. After the autopilot lands its find
   interaction (Task 9), confirm `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`.
   Also do a manual live check (`npm run tauri:dev`, navigate to a content-rich page, Ctrl+F,
   type a word, confirm the count shows + matches highlight + next/prev cycle + Esc closes) —
   capture with `spectacle` per [[aegis-live-testing-setup]].

---

## Task 7 — Windows: `find_win.rs` via `ICoreWebView2Find` (CI + manual device)

**Files:** `src-tauri/src/find_win.rs` (NEW), `src-tauri/src/nav.rs` (MOD: install in the
existing Windows `with_webview` block in `spawn_tab`, alongside `adblock_win::install` /
`nav_url_win::install`).

**Verified API (Appendix A.2):**

- Get the find object: `core.cast::<ICoreWebView2_28>()?.Find()? -> ICoreWebView2Find`.
- `ICoreWebView2Find::{Start(options: ICoreWebView2FindOptions, handler:
ICoreWebView2FindStartCompletedHandler), FindNext(), FindPrevious(), Stop(),
MatchCount(*mut i32), ActiveMatchIndex(*mut i32), add_MatchCountChanged(handler, *mut i64),
add_ActiveMatchIndexChanged(handler, *mut i64)}`.
- Options factory: `environment.cast::<ICoreWebView2Environment15>()?.CreateFindOptions()?
-> ICoreWebView2FindOptions`; setters `SetFindTerm(PCWSTR/HSTRING)`,
  `SetIsCaseSensitive(bool)`, `SetShouldHighlightAllMatches(bool)`,
  `SetSuppressDefaultFindDialog(bool)`.
- High-level callback wrappers (in `webview2-com`): `FindStartCompletedHandler::new(closure)`
  and `FindMatchCountChangedEventHandler::new(closure)` / `FindActiveMatchIndexChangedEventHandler`.
  Follow the EXACT construction pattern `adblock_win.rs`/`nav_url_win.rs` use for
  `WebResourceRequestedEventHandler::create` / `SourceChangedEventHandler::create`; check
  whether the Find handlers use `::create(Box::new(...))` (event_callback macro) — read
  `webview2-com-0.38.2/src/callback.rs` lines 655–680 before writing the closure.

**Interface (exact shape — mirror `adblock_win.rs::install` signature):**

```rust
// find_win.rs
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_28, ICoreWebView2Environment15, ICoreWebView2Find, ICoreWebView2FindOptions,
};
use webview2_com::{FindMatchCountChangedEventHandler, FindStartCompletedHandler};
use windows::core::{Interface, HSTRING};
use tauri::AppHandle;

/// Install the MatchCount listener on this tab's Find object so a search pushes the live
/// count to the chrome. Call inside content.with_webview(|pw| find_win::install(&pw, app, id)).
pub fn install(pw: &tauri::webview::PlatformWebview, app: AppHandle, id: u32) {
    unsafe {
        let core = match pw.controller().CoreWebView2() { Ok(c) => c, Err(_) => return };
        let find = match core.cast::<ICoreWebView2_28>().and_then(|c| c.Find()) {
            Ok(f) => f, Err(_) => return, // runtime too old → no find; browsing unaffected
        };
        let find_for_handler = find.clone();
        let handler = FindMatchCountChangedEventHandler::create(Box::new(move |sender, _args| {
            // sender is the ICoreWebView2Find; read MatchCount + ActiveMatchIndex out params.
            if let Some(f) = sender {
                let mut count: i32 = 0; let _ = f.MatchCount(&mut count);
                let mut active: i32 = 0; let _ = f.ActiveMatchIndex(&mut active);
                crate::find::emit_state(&app, id, "", count.max(0) as u32, active.max(0) as u32);
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        let _ = find.add_MatchCountChanged(&handler, &mut token);
        // (optional) also add_ActiveMatchIndexChanged to refresh the active index on next/prev.
        let _ = find_for_handler; // keep the clone alive if the wrapper requires it
    }
}
```

> **VERIFY-FIRST (the implementing agent MUST do this before writing the body):** confirm the
> EXACT constructor for `FindMatchCountChangedEventHandler` (is it `::create(Box::new(...))`
> like the `#[event_callback]` handlers in `callback.rs`, and what are the closure's two
> args?) by reading `webview2-com-0.38.2/src/callback.rs`. The args for an
> `#[event_callback]` are `(Option<&ICoreWebView2Find>, Option<&IUnknown>)`. If the macro
> exposes `Output`/owned types instead, adapt. **Do not invent the closure shape.**

```rust
pub fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    let Some(content) = app.get_webview(&crate::nav::content_label(id)) else { return };
    let (q, cs) = (query.to_string(), case_sensitive);
    let _ = content.with_webview(move |pw| unsafe {
        let env = match pw.environment().cast::<ICoreWebView2Environment15>() { Ok(e)=>e, Err(_)=>return };
        let core = match pw.controller().CoreWebView2() { Ok(c)=>c, Err(_)=>return };
        let find = match core.cast::<ICoreWebView2_28>().and_then(|c| c.Find()) { Ok(f)=>f, Err(_)=>return };
        if q.is_empty() { let _ = find.Stop(); return; }
        let opts: ICoreWebView2FindOptions = match env.CreateFindOptions() { Ok(o)=>o, Err(_)=>return };
        let _ = opts.SetFindTerm(&HSTRING::from(q.as_str()));
        let _ = opts.SetIsCaseSensitive(cs);
        let _ = opts.SetShouldHighlightAllMatches(true);
        let _ = opts.SetSuppressDefaultFindDialog(true); // we draw our own bar
        let completed = FindStartCompletedHandler::create(Box::new(|_hr| Ok(())));
        let _ = find.Start(&opts, &completed);
    });
}
pub fn next(app: &AppHandle, id: u32) { with_find(app, id, |f| unsafe { let _ = f.FindNext(); }); }
pub fn prev(app: &AppHandle, id: u32) { with_find(app, id, |f| unsafe { let _ = f.FindPrevious(); }); }
pub fn close(app: &AppHandle, id: u32) { with_find(app, id, |f| unsafe { let _ = f.Stop(); }); crate::find::emit_state(app, id, "", 0, 0); }

// helper that re-acquires the Find object inside with_webview and runs `g`
fn with_find(app: &AppHandle, id: u32, g: impl FnOnce(&ICoreWebView2Find) + Send + 'static) { /* mirror start() acquisition */ }
```

**nav.rs (spawn_tab Windows `with_webview` block) — add one line:**

```rust
crate::find_win::install(&pw, app_find, id); // app_find = app.clone() above
```

**Steps:**

1. `cargo check --target x86_64-pc-windows-gnu` (needs mingw, see [[aegis-build-gates...]]).
   Fix any binding mismatch revealed (HSTRING vs PCWSTR for `SetFindTerm`; the `cast` import
   path; the handler constructor). RED→GREEN.
2. Confirm CI msvc green (`tauri-build-check.yml` windows-latest) when pushed.
3. **MANUAL DEVICE STEP (owner's Windows 11 session), document in the PR:**
   Launch the portable exe → open a content page → Ctrl+F → type a word → confirm the count
   appears, matches highlight, Find next/prev cycle, Esc closes. Note that
   `ICoreWebView2_28::Find` requires a recent **WebView2 Runtime** (the Find API is a 2024+
   addition); if `core.cast::<ICoreWebView2_28>()` errors on an older runtime, find is a
   silent no-op (browsing unaffected) — record the runtime version tested. **(Flagged
   uncertainty: the minimum runtime build that ships `ICoreWebView2_28::Find` is not
   confirmable from this Linux box — verify on-device.)**

---

## Task 8 — macOS: `find_mac.rs` via `WKWebView findString:` (CI build + manual device)

**Files:** `src-tauri/src/find_mac.rs` (NEW), `src-tauri/Cargo.toml` (MOD: enable the
`objc2-web-kit` Find features), `src-tauri/src/nav.rs` (MOD: install in the macOS
`with_webview` block, like `nav_url_mac::install`).

**Verified API + HONEST LIMITATION (Appendix A.3):**
`WKWebView::findString_withConfiguration_completionHandler(&self, string: &NSString,
configuration: Option<&WKFindConfiguration>, completion_handler: &block2::DynBlock<dyn
Fn(NonNull<WKFindResult>)>)`. `WKFindConfiguration::{setBackwards, setCaseSensitive,
setWraps}`. `WKFindResult::matchFound() -> bool`.
**`WKFindResult` exposes ONLY `matchFound` (a bool) — NO match count, and `findString:` does
NOT highlight all matches** (it selects/scrolls to one result). So on macOS via this API:

- `start` selects the first match; `next`/`prev` re-issue `findString:` with
  `setBackwards(true/false)`; the bar shows `matchCount = matchFound ? 1 : 0`, `active = 0`
  ("unknown count"). This is an honest, working-but-degraded find.
- **To get a real count + highlight on macOS** you'd inject a JS find shim (like the desktop
  inject tier). That is OUT of this task's minimum scope; record it as a documented
  follow-up. The contract already allows `matchCount` to be approximate and `activeMatchIndex
= 0`.

**Cargo.toml change (REQUIRED — features are off by default in `objc2-web-kit = "0.3"`):**

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2-web-kit = { version = "0.3", features = ["WKWebView", "WKFindConfiguration", "WKFindResult"] }
```

> VERIFY: `nav_url_mac.rs` already uses `WKWebView` from this crate, so the `WKWebView`
> feature is implicitly available today; adding it explicitly + the two `WKFind*` features is
> additive. Confirm the feature NAMES against `objc2-web-kit-0.3.2/Cargo.toml` (`grep
'^WKFind' Cargo.toml`) before committing — if a feature is named differently, use the real
> name. (Flagged: exact feature-flag names not re-verified in this plan — the agent checks.)

**Interface (exact, mirroring `nav_url_mac.rs::install`'s retain pattern):**

```rust
// find_mac.rs
use objc2::rc::Retained;
use objc2_foundation::NSString;
use objc2_web_kit::{WKFindConfiguration, WKFindResult, WKWebView};
use block2::RcBlock;
use tauri::AppHandle;
use std::ptr::NonNull;

fn webview(app: &AppHandle, id: u32) -> Option<Retained<WKWebView>> {
    let content = app.get_webview(&crate::nav::content_label(id))?;
    let mut out = None;
    let _ = content.with_webview(|pw| {
        let ptr = pw.inner() as *mut WKWebView;
        if !ptr.is_null() { out = unsafe { Retained::retain(ptr) }; }
    });
    out
}

fn run(app: &AppHandle, id: u32, query: &str, case_sensitive: bool, backwards: bool) {
    let Some(wv) = webview(app, id) else { return };
    let app = app.clone(); let q = query.to_string(); let id2 = id;
    unsafe {
        let cfg = WKFindConfiguration::new(/* MainThreadMarker — acquire via objc2 */);
        cfg.setBackwards(backwards);
        cfg.setCaseSensitive(case_sensitive);
        cfg.setWraps(true);
        let q_ns = NSString::from_str(&q);
        let block = RcBlock::new(move |res: NonNull<WKFindResult>| {
            let found = res.as_ref().matchFound();
            crate::find::emit_state(&app, id2, &q, if found {1} else {0}, 0);
        });
        wv.findString_withConfiguration_completionHandler(&q_ns, Some(&cfg), &block);
    }
}

pub fn install(_pw: &tauri::webview::PlatformWebview, _app: AppHandle, _id: u32) {
    // No persistent listener needed: the completion block carries the result per call.
}
pub fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    if query.is_empty() { crate::find::emit_state(app, id, "", 0, 0); return; }
    run(app, id, query, case_sensitive, false);
}
pub fn next(app: &AppHandle, id: u32) { /* re-run last query forward — store last term per tab */ }
pub fn prev(app: &AppHandle, id: u32) { /* re-run last query backward */ }
pub fn close(app: &AppHandle, id: u32) { crate::find::emit_state(app, id, "", 0, 0); }
```

> VERIFY-FIRST: (a) the `MainThreadMarker` acquisition for `WKFindConfiguration::new(mtm)` —
> `nav_url_mac.rs` shows the objc2 0.6 idioms in use; check how a `MainThreadMarker` is
> obtained there or via `MainThreadMarker::new_unchecked()` inside a `with_webview` (already
> on the main thread). (b) `block2` crate availability — wry pulls it in transitively; if
> `block2` is not a direct dep, add `block2 = "0.6"` to the macOS deps. (c) `next`/`prev`
> need the last query — store `last_query: Mutex<HashMap<u32,String>>` in a module
> `OnceLock`, set on `start`. These are flagged as agent-resolves-on-Mac/CI items.

**Steps:**

1. Add the Cargo feature flags + `find_mac.rs`. There is NO local `cargo check` for macOS
   ([[aegis-macos-crosscompile]]) — gate is **CI build green** on macos-latest.
2. Push → confirm `tauri-build-check.yml` macos-latest passes (compiles + bundles the .app).
3. **MANUAL DEVICE STEP = sub-project I (hardware-gated):** on a Mac, Ctrl+F, type, confirm a
   match is selected/scrolled-to + next/prev move + Esc closes. Document that count/highlight
   are degraded pending the JS-shim follow-up. Stays "CI-build-verified, GUI-pending" until I.

---

## Task 9 — Autopilot: catalog entry + verify, screen, reach, interaction specs (SAME-COMMIT)

This task is **required in the same commit as Tasks 1–4** in practice; it is listed
separately only for plan clarity. The drift guards (`coverage.test.ts`,
`interactions.coverage.test.ts`) FAIL the build until every new channel/control/screen is
registered, so do this in lockstep with the UI/IPC.

**Files:** `src/autopilot/catalog.ts`, `src/autopilot/screens.ts`, `src/autopilot/reach.ts`,
`src/autopilot/interactions/find.ts` (NEW), `src/autopilot/interactions/index.ts`,
`src/autopilot/interactions/controls.ts`.

**(a) catalog.ts — one `FeatureCheck` covering all five channels:**

```ts
{ id: 'find.search', domain: 'find', title: 'Find in page',
  channels: [IPC.findStart, IPC.findNext, IPC.findPrev, IPC.findClose],
  exercise: async (a) => {
    await a.find.start(V, 'example'); await a.find.next(V);
    await a.find.prev(V); await a.find.close(V);
  },
  // find mutates webview search state; the live round-trip drives a real search on a
  // navigated page and asserts a find.state event arrives, then closes.
  verify: async (a) => {
    // Navigate to a page with known text, then search for a guaranteed-present word.
    await a.nav.navigate(V, 'https://example.com/');
    // example.com contains the word "Example" / "Domain". Subscribe BEFORE searching.
    let got: { matchCount: number } | null = null;
    const off = a.find.onState((s) => { if (s.viewId === V) got = s; });
    const deadline = Date.now() + 8000;
    await a.find.start(V, 'Example');
    while (Date.now() < deadline && (got === null)) await new Promise((r)=>setTimeout(r,300));
    off(); await a.find.close(V);
    if (got === null) throw new Error('find: no find.state event after start');
    return `find start→state(matchCount=${(got as {matchCount:number}).matchCount})→close ok`;
  } },
```

> Note: `IPC.evtFindState` is an **event**, not a command channel; the IPC drift guard
> (`coverage.test.ts`) only requires _command_ channels to appear in `channels[]`. Mirror how
> existing event-only channels (`evtNavState`, `evtAdblockBlockedCount`) are handled — they
> are NOT listed in any `channels[]`. Confirm the guard's exact rule in `coverage.test.ts`
> before relying on this; if it DOES require events, add `IPC.evtFindState` to `channels`.

**(b) screens.ts — add `'findBar'` to `OverlayScreenId` + a `SCREENS` entry:**

```ts
{ id: 'findBar', label: 'Find-in-page bar', via: 'overlay' },
```

**(c) reach.ts — open/close it through the autopilot control.** The find bar opens via Ctrl+F,
which is App-internal state. Add `openFind`/`closeFind` to `AutopilotControl` (in `control.ts`)
and wire them in `App.tsx`'s `installAutopilotControl` block (mirroring `openDownloads`), then
in `reach.ts`:

```ts
// in reachScreen 'overlay':
else if (screen.id === 'findBar') control.openFind();
// in leaveScreen:
else if (screen.id === 'findBar') control.closeFind();
```

> This is the SAME mechanism `downloads`/`favoritesManager` use — a control method calling the
> real setState. Add the two methods to the `AutopilotControl` interface + its mock in
> `control.test.ts`.

**(d) interactions/find.ts — real-gesture specs (vitest; desktop):**

```ts
export const FIND_INTERACTIONS: InteractionSpec[] = [
  {
    id: 'find.open',
    domain: 'find',
    description: 'Ctrl+F opens the find bar',
    screen: 'home',
    layers: ['vitest'],
    run: async (ctx) => {
      await ctx.press('Control>{f}'); /* or fire a keydown with ctrlKey */
    },
    assert: async (ctx) => {
      if (!ctx.bySelector('input[aria-label="Find in page"]'))
        throw new Error('find bar not shown');
      return 'Ctrl+F → find bar visible';
    },
  },
  {
    id: 'find.type',
    domain: 'find',
    description: 'Typing a term calls find.start',
    screen: 'findBar',
    layers: ['vitest'],
    run: async (ctx) => {
      const input = ctx.bySelector('input[aria-label="Find in page"]')!;
      await ctx.type(input, 'lorem');
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('find.start', (a) => String(a[1]).includes('lorem')))
        throw new Error('find.start not called with lorem');
      return 'type → find.start(lorem)';
    },
  },
  {
    id: 'find.next',
    domain: 'find',
    description: 'Find-next button calls find.next',
    screen: 'findBar',
    layers: ['vitest'],
    run: async (ctx) => {
      await ctx.click(ctx.byRole('button', /Find next/)!);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('find.next')) throw new Error('find.next not called');
      return 'next → find.next';
    },
  },
  {
    id: 'find.prev',
    domain: 'find',
    description: 'Find-previous button calls find.prev',
    screen: 'findBar',
    layers: ['vitest'],
    run: async (ctx) => {
      await ctx.click(ctx.byRole('button', /Find previous/)!);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('find.prev')) throw new Error('find.prev not called');
      return 'prev → find.prev';
    },
  },
  {
    id: 'find.close',
    domain: 'find',
    description: 'Esc closes the find bar + calls find.close',
    screen: 'findBar',
    layers: ['vitest'],
    run: async (ctx) => {
      const input = ctx.bySelector('input[aria-label="Find in page"]')!;
      await ctx.press('{Escape}'); // dispatched on the focused find input
    },
    assert: async (ctx) => {
      if (ctx.bySelector('input[aria-label="Find in page"]'))
        throw new Error('find bar still shown');
      if (!ctx.calls.called('find.close')) throw new Error('find.close not called');
      return 'Esc → bar closed + find.close';
    },
  },
];
```

> VERIFY-FIRST: the exact `ctx.press`/keyboard helper for a Ctrl+F chord — read
> `interactionCtx.ts` + an existing keyboard spec in `interactions/tabs.ts` (`keyboard.newTab`)
> to copy the real chord-firing form (it may dispatch a `KeyboardEvent` with `ctrlKey:true`
> rather than userEvent `press`). Use whatever those specs use; don't invent a helper.

**(e) controls.ts — add the ids (same commit):**

```ts
'find.open', 'find.type', 'find.next', 'find.prev', 'find.close',
```

(The drift guard maps each `INTERACTIVE_CONTROLS` id to a spec whose `id` _starts with_ that
string, so these line up 1:1 with the spec ids above.)

**(f) index.ts — spread it:** add `...FIND_INTERACTIONS` to the `INTERACTIONS` concat + import.

**Steps:**

1. Add the catalog entry → run `npm test` → `coverage.test.ts` now GREEN for the 4 command
   channels (RED before).
2. Add the screen + reach + control methods → `tour.test.tsx` walks `findBar` without crash.
3. Add `interactions/find.ts` + controls ids + index spread →
   `interactions.coverage.test.ts` GREEN; `interactions.test.tsx` runs the 5 specs GREEN.
4. Full `npm test` GREEN.

---

## Task 10 — Android: Kotlin `Bridge.find*` + `FindListener` + `__aegisFindState` push (LIVE-VERIFIABLE)

Android has **no Rust find dispatch** (the native WebView is Kotlin-owned; Rust can't touch
it — same reason nav/overlay are bridged). The chrome's `aegis.find.*` already routes to the
`AegisAndroid` bridge (Task 2). This task implements those bridge methods + pushes state back
via `window.__aegisFindState`.

**Files:** `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt` (MOD).

**Verified API (standard Android SDK):** `WebView.findAllAsync(String find)`,
`WebView.setFindListener(WebView.FindListener)` where `FindListener.onFindResultReceived(int
activeMatchOrdinal, int numberOfMatches, boolean isDoneCounting)`, `WebView.findNext(boolean
forward)`, `WebView.clearMatches()`. (These are documented, stable since API 16; no crate
verification needed.)

**Implementation (mirror the existing `pushNavState` / `Bridge.navigate` patterns):**

1. In `createTabWebView(id, url)`, after setting the clients, register a find listener that
   pushes results to the chrome (only when this tab is active — like `pushNavState`):

   ```kotlin
   wv.setFindListener { activeOrdinal, numberOfMatches, isDoneCounting ->
     if (isDoneCounting && id == activeTabId) pushFindState(id, numberOfMatches, activeOrdinal + 1)
   }
   ```

   (`activeMatchOrdinal` is 0-based; the chrome shows 1-based, so `+1` when matches > 0.)

2. Add a `pushFindState` helper next to `pushNavState`:

   ```kotlin
   private fun pushFindState(id: Int, matchCount: Int, activeIndex: Int) {
     val obj = JSONObject()
       .put("viewId", id).put("query", "")
       .put("matchCount", matchCount)
       .put("activeMatchIndex", if (matchCount > 0) activeIndex else 0)
     val js = "window.__aegisFindState && window.__aegisFindState($obj)"
     chromeWebView?.post { chromeWebView?.evaluateJavascript(js, null) }
   }
   ```

3. Add the four `@JavascriptInterface` bridge methods to the `Bridge` inner class
   (all hop to the UI thread via `runOnUiThread`, like the others):
   ```kotlin
   @JavascriptInterface
   fun find(query: String, caseSensitive: Boolean) = runOnUiThread {
     val c = contentWebView ?: return@runOnUiThread
     if (query.isEmpty()) { c.clearMatches(); pushFindState(activeTabId, 0, 0) }
     else c.findAllAsync(query) // Android find is case-insensitive only; caseSensitive ignored (documented limit)
   }
   @JavascriptInterface
   fun findNext() = runOnUiThread { contentWebView?.findNext(true) }
   @JavascriptInterface
   fun findPrev() = runOnUiThread { contentWebView?.findNext(false) }
   @JavascriptInterface
   fun findClose() = runOnUiThread { contentWebView?.clearMatches(); pushFindState(activeTabId, 0, 0) }
   ```
   > Honest limit (document it): `WebView.findAllAsync` is **case-insensitive only** — there's
   > no case-sensitive Android WebView find — so the `caseSensitive` flag is ignored on
   > Android. Note it in the bridge comment + the parity table. `findNext(false)` after the
   > listener has counted moves backward through highlighted matches (it does NOT re-issue the
   > search), matching the desktop next/prev semantics.

**Steps:**

1. Kotlin gate: `JAVA_HOME=~/development/android-studio/jbr ./gradlew compileUniversalDebugKotlin`
   (or the project's android build), green. Also `cargo check --target aarch64-linux-android`
   green (no Rust change here, but confirm nothing else broke — gotcha 10).
2. **LIVE DEVICE:** install the APK on the emulator/phone, open a content page, Ctrl+F is
   desktop-only so trigger find from the mobile chrome's find affordance — **wire a find entry
   point in the mobile shell** (see Task 12) — type a term, confirm the count shows in the
   mobile find bar, next/prev cycle through highlighted matches, close clears them. Capture via
   logcat if needed.

---

## Task 11 — Mobile shell: find affordance + `<FindBar>` in `MobileApp` (parity)

Desktop opens find with Ctrl+F; mobile has no Ctrl key, so the mobile shell needs a tap target.

**Files:** `src/components/mobile/MobileApp.tsx`, `MobileMenuSheet.tsx` (add a "Find in page"
menu row), and reuse `FindBar.tsx` (it already renders fine in the mobile chrome strip; it's
just an infobar).

**Steps:**

1. Add a "Find in page" row to `MobileMenuSheet` (Search/MagnifyingGlass lucide icon) that
   calls a `useFind(activeId).show()` passed down from `MobileApp`.
2. In `MobileApp`, instantiate `useFind(tabs.activeId)` and render `{find.open && <FindBar
…/>}` in the top chrome (above the content; the native WebView is below the chrome margins,
   so the bar paints in the chrome layer fine — no overlay routing needed since the bar doesn't
   cover the content). Close via the bar's X / Esc.
3. The mobile interaction tour: add a `mobile.menu.find` control + a `['vitest'], mobile:true`
   spec in `interactions/mobile.ts` (open menu → tap Find → assert the find input appears),
   and add `'mobile.menu.find'` to `controls.ts`. (Same drift-guard discipline.)
4. `npm test` GREEN (desktop + mobile tours). Device-verify per Task 10.

> Parity note: this closes the §6.4 gap — find is reachable + functional on all four
> platforms, not "desktop-only with mobile as a follow-up".

---

## Task 12 — Docs + parity sign-off (living docs, same commit)

**Files:** `src-tauri/CLAUDE.md`, `src/CLAUDE.md`, `shared/CLAUDE.md`.

1. `shared/CLAUDE.md`: add `find.*` to the channel inventory + the `find.state` event note.
2. `src/CLAUDE.md`: add `useFind` to the "one hook per domain" list + `FindBar` to components.
3. `src-tauri/CLAUDE.md`: add `find.rs` + `find_{linux,win,mac}.rs` to the module map; add a
   gotcha documenting the per-engine count/highlight reality matrix:
   - Linux (WebKitFindController): real count via `found-text`, highlights, no active index.
   - Windows (ICoreWebView2Find): real count + active index + highlight (runtime-gated to a
     recent WebView2 Runtime; older → silent no-op).
   - macOS (findString:): single-result select, **no count / no highlight** (degraded; JS-shim
     follow-up recorded).
   - Android (findAllAsync): real count + active index + highlight, **case-insensitive only**.
4. Update the §1.1/§ status framing if this plan's sub-project completes (leave the
   master-spec edit to sub-project B per its scope; just note find is done in the CLAUDE.md
   status lines).

---

## Self-Review

- **Single plan, required header present?** Yes — title, agentic-worker sub-skill line, Goal,
  Architecture, Tech Stack, Global Constraints (copied from §6 incl. the IPC-3-places rule,
  the event-name `.`→`:` rule, the autopilot-same-commit rule, and the per-platform gate),
  File Structure map, then bite-sized TDD tasks with exact Files/Interfaces/one-action steps,
  ending here.
- **IPC three places covered?** Task 1 (`shared/types.ts`), Task 5 (Rust dispatcher +
  `lib.rs` `mod`+arm), Task 2 (`ipcClient.ts`). The event uses `emit_event` (Task 5) →
  `tauriInvoke.on()` reversal — never a raw dotted emit. ✔
- **All four engines implemented, not Linux-only?** Linux (Task 6, live), Windows (Task 7, CI
  - device), macOS (Task 8, CI + device), Android (Task 10/11, live). Mobile parity is its own
    task. ✔ — matches §4.
- **Native APIs verified, not invented?** Linux `WebKitFindController` (read
  webkit2gtk-2.0.2/src/auto/find_controller.rs + flags.rs + web_view.rs — exact method &
  flag names quoted). Windows `ICoreWebView2Find`/`ICoreWebView2_28::Find`/
  `ICoreWebView2Environment15::CreateFindOptions`/`ICoreWebView2FindOptions` setters (read
  webview2-com-sys-0.38.2/src/bindings.rs — exact lines). macOS
  `findString_withConfiguration_completionHandler` + `WKFindConfiguration`/`WKFindResult`
  (read objc2-web-kit-0.3.2 generated files). Android `findAllAsync`/`setFindListener`/
  `findNext`/`clearMatches` (standard SDK). ✔
- **Flagged uncertainties (explicit, not papered over):**
  1. **Windows runtime floor** for `ICoreWebView2_28::Find` — the minimum WebView2 Runtime
     build that ships the Find API is NOT confirmable from this Linux box; Task 7 makes the
     `cast` failure a silent no-op and the device step records the runtime version. **FOLLOW-UP.**
  2. **macOS count + highlight** are NOT available via `WKFindResult` (only `matchFound`
     bool); Task 8 ships a working-but-degraded find and records a JS-shim follow-up for real
     count/highlight. **FOLLOW-UP (and gated behind sub-project I for any GUI verify).**
  3. **`objc2-web-kit` feature flag names** (`WKFindConfiguration`/`WKFindResult`) — Task 8
     tells the agent to confirm the exact names against the crate's `Cargo.toml` before
     committing. **AGENT-RESOLVES.**
  4. **webview2-com Find handler constructor shape** (`::create(Box::new(...))` vs owned) —
     Task 7 tells the agent to read `callback.rs` lines 655–680 first. **AGENT-RESOLVES.**
  5. **Linux `with_webview` move-out of `FindController`** — Task 6 gives a verified fallback
     (do the call inside the closure) if returning the controller doesn't borrow-check.
     **AGENT-RESOLVES, both paths valid.**
  6. **Android `caseSensitive` is ignored** (WebView find is case-insensitive only) — a real
     platform limit, documented, not a bug. **DOCUMENTED LIMIT.**
- **Autopilot same-commit?** Task 9 adds catalog(+verify)/screen/reach/interaction/controls
  in lockstep; the two drift guards (`coverage.test.ts`, `interactions.coverage.test.ts`)
  enforce it. Event channel handling (whether `evtFindState` must be in `channels[]`) is
  flagged for the agent to confirm against the guard's real rule. ✔
- **Test-first?** Each task writes the failing test before code: vitest for `FindBar`,
  `useFind`, `ipcClient`; the interaction tour; a Rust unit test for the find-dispatch
  matcher + the Linux options-bits helper; `cargo check --target …` for Win; CI build for
  macOS; live autopilot + device runs for Linux/Android. ✔
- **Risks not yet closed:** (a) macOS GUI verify is hardware-gated (sub-project I) — honest
  per §4. (b) Windows GUI verify needs the owner's session — honest per §4. (c) the macOS
  count/highlight degradation is the one place the feature is not at full parity on day one;
  it's an explicit, recorded follow-up rather than a hidden gap.

---

## Appendix A — Verified native API references (read directly from installed crates)

**A.1 Linux — webkit2gtk 2.0.2** (`~/.cargo/.../webkit2gtk-2.0.2/src/auto/`)

- `web_view.rs`: `WebViewExt::find_controller(&self) -> Option<FindController>`.
- `find_controller.rs` `FindControllerExt`: `search(&self, search_text:&str,
find_options:u32, max_match_count:u32)`, `search_next(&self)`, `search_previous(&self)`,
  `search_finish(&self)`, `count_matches(&self, &str, u32, u32)`, `search_text(&self) ->
Option<GString>`, `connect_found_text<F: Fn(&Self, u32)>(&self, F)`,
  `connect_failed_to_find_text<F: Fn(&Self)>(&self, F)`,
  `connect_counted_matches<F: Fn(&Self, u32)>(&self, F)`.
- `flags.rs`: `FindOptions: u32` bitflags — `CASE_INSENSITIVE`, `BACKWARDS`, `WRAP_AROUND`
  (use `.bits()` for the `u32` arg). Requires feature `v2_40` (already enabled in Cargo.toml).

**A.2 Windows — webview2-com 0.38.2 / -sys 0.38.2** (`src/bindings.rs`)

- `ICoreWebView2_28::Find(&self) -> Result<ICoreWebView2Find>` (line 42531).
- `ICoreWebView2Find`: `Start(options, handler)`, `FindNext()`, `FindPrevious()`, `Stop()`,
  `MatchCount(*mut i32)`, `ActiveMatchIndex(*mut i32)`,
  `add_MatchCountChanged(handler, *mut i64)`, `add_ActiveMatchIndexChanged(handler, *mut i64)`.
- `ICoreWebView2Environment15::CreateFindOptions(&self) -> Result<ICoreWebView2FindOptions>`
  (line 15013).
- `ICoreWebView2FindOptions`: `SetFindTerm`, `SetIsCaseSensitive(bool)`,
  `SetShouldHighlightAllMatches(bool)`, `SetShouldMatchWord(bool)`,
  `SetSuppressDefaultFindDialog(bool)` (lines 18252–18339).
- `webview2-com/src/callback.rs` (655–680): `FindStartCompletedHandler` (`#[completed_callback]`),
  `FindMatchCountChangedEventHandler` + `FindActiveMatchIndexChangedEventHandler`
  (`#[event_callback]`, closure args `(Option<&ICoreWebView2Find>, Option<&IUnknown>)`).
- Reached via `pw.controller().CoreWebView2()` + `pw.environment()` then `.cast::<…>()`
  (`windows_core::Interface::cast`) — same `with_webview → PlatformWebview` path as
  `adblock_win.rs`/`nav_url_win.rs`.

**A.3 macOS — objc2-web-kit 0.3.2** (`src/generated/`)

- `WKWebView.rs` (814–824): `findString_withConfiguration_completionHandler(&self, string:
&NSString, configuration: Option<&WKFindConfiguration>, completion_handler:
&block2::DynBlock<dyn Fn(NonNull<WKFindResult>)>)`. Gated on features `WKFindConfiguration`
  - `WKFindResult` (NOT enabled in Aegis's Cargo.toml today — Task 8 adds them).
- `WKFindConfiguration.rs`: `setBackwards(bool)`, `setCaseSensitive(bool)`, `setWraps(bool)`,
  `new(MainThreadMarker)`.
- `WKFindResult.rs`: `matchFound(&self) -> bool` — **the ONLY accessor; no count**.
- Reached via `pw.inner() as *mut WKWebView` + `Retained::retain`, exactly like
  `nav_url_mac.rs`.

**A.4 Android — platform SDK** (`MainActivity.kt` is the host)

- `WebView.findAllAsync(String)`, `WebView.setFindListener(WebView.FindListener)` →
  `onFindResultReceived(int activeMatchOrdinal, int numberOfMatches, boolean isDoneCounting)`,
  `WebView.findNext(boolean forward)`, `WebView.clearMatches()`. Case-insensitive only.
- Bridged via `@JavascriptInterface` + `chromeWebView.evaluateJavascript("window.__aegisFindState(…)")`,
  exactly like `pushNavState`/`__aegisNavState`.
