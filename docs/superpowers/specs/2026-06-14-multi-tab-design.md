# Multi-tab support — design spec

- **Date:** 2026-06-14
- **Status:** Approved (brainstorming). Next: implementation plan.
- **Phase:** Tabs-first. A follow-up "mobile-friendly UI" spec builds the mobile
  tab switcher on top of this contract.

## 1. Goals

Give Aegis full, power-user multi-tab browsing on **desktop** (Linux/Windows/macOS):

- New tab, close tab, switch tab, per-tab title in a tab strip.
- Keyboard shortcuts: Ctrl+T, Ctrl+W, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1–9,
  Ctrl+Shift+T.
- Open-in-new-tab: Ctrl/middle-click, **and** `target=_blank` / `window.open`
  (which currently dead-link — see [[aegis-new-window-gap]]).
- Reopen-last-closed tab.
- Session restore across app restart.
- Drag-to-reorder tabs and pinned tabs.
- **Time-based** memory management: background tabs are discarded after an
  inactivity timeout and reloaded on return (bounded RAM without a tab-count cap).

## 2. Non-goals (this phase)

- **Mobile tab UI / Android multi-WebView** — the contract is built to serve it,
  but the native side and the mobile switcher land in the mobile-UI phase. On
  mobile the `tabs.*` surface compiles but spawn/layout are no-ops (today's
  `spawn_content` pattern).
- A rich "new tab page" — a new tab opens the configured home URL, same as the
  Home button.
- Favicons in the strip — a privacy browser should not call a favicon CDN; the
  strip uses a globe glyph + title. (Future: extract favicons locally.)
- Persisting each tab's full back/forward history — only the current URL per tab
  is persisted for session restore.
- A live-tab **count** cap — explicitly replaced by the time-based policy (§5).

## 3. Background — current architecture (verified)

Aegis runs a **chrome** webview (the React UI in `src/`) plus, on desktop, exactly
**one content** webview created in `nav.rs::spawn_content` under the label
`CONTENT_LABEL = "content"`. Key facts that shape this work:

- The IPC contract is **already per-view**: `NavState.viewId`, `useNav(viewId)`,
  `aegis.nav.onState` filters by `viewId`, and `PRIMARY_VIEW_ID = 1`. The wiring
  underneath simply never branched on more than one view — `nav.rs::emit_state`
  and `nav.getState` hardcode `viewId: 1`.
- `CONTENT_LABEL` is assumed-single across **seven** modules: `nav.rs`, `view.rs`,
  `linux_layout.rs`, `adblock_webkit.rs`, `permissions.rs`, `picker.rs`,
  `safety.rs`.
- `view.rs` positions the single content webview below a constant top inset
  (`DEFAULT_INSET_TOP = 96` = toolbar 56 + favbar 40); overlays hide it, the
  sidebar insets it from the right, fullscreen fills the window.
- **Linux** uses a `GtkFixed` reparenting workaround for tauri#10420
  (`linux_layout.rs`): wry packs every webview into the window's vertical `GtkBox`
  and ignores `set_bounds`, so the chrome + content widgets are reparented into a
  `GtkFixed` and positioned manually. `layout()` treats every non-content child as
  full-window chrome.
- **Mobile (Android)** is a single native Kotlin `WebView` bridged as
  `window.AegisAndroid`; `spawn_content` is a no-op there.

### Verified Tauri 2.11.2 APIs this design relies on

| Need | API (verified in the installed crate) |
|---|---|
| Discard a tab and free its memory | `Webview::close()` (`webview/mod.rs:1502`) |
| Create tabs on demand | `Window::add_child` (already used by `spawn_content`) |
| Show/hide, reposition, navigate, reload | `Webview::{hide,show,set_bounds,navigate,reload,eval}` |
| Open-in-new-tab / fix `target=_blank` | `WebviewBuilder::on_new_window(Fn(Url, NewWindowFeatures) -> NewWindowResponse)`; `NewWindowResponse::{Allow, Create{window}, Deny}` (`webview/mod.rs:585,239`) |
| App-level shortcuts (even when content is focused) | Menu accelerators + `on_menu_event` (`app.rs:808`); the app defines no menu today |

## 4. Requirements summary

Functional: §1. Quality: keep the existing test gate green and add coverage;
no regression to the single-tab UX (one tab behaves as today); cross-platform
(Linux verified on hardware; Windows/macOS compile + CI; mobile stubbed).

## 5. Architecture

### 5.1 Tab model & ownership

**Rust owns the tab registry** — it is the authority on webviews and must restore
them at startup; the chrome renders from it and sends commands. This mirrors the
existing `nav.state` flow (Rust emits, chrome reflects).

A new module `src-tauri/src/tabs.rs` holds:

```rust
struct Tab {
    id: ViewId,        // assigned by the registry; webview label = content:<id>
    url: String,       // last-known URL (for restore + respawn after discard)
    title: String,
    pinned: bool,
    live: bool,        // has a backing webview right now
    last_active: Instant, // monotonic; stamped when the tab stops being active
    // small nav-history index for real canGoBack/canGoForward (§5.8)
}

struct Registry {
    tabs: Vec<Tab>,    // order == tab-strip order (pinned sorted first)
    active_id: ViewId,
    closed_stack: Vec<ClosedTab>, // bounded; powers reopen-closed
    next_id: ViewId,
}
```

- Webview labels become `content:<id>` via a `content_label(id)` helper. The bare
  `CONTENT_LABEL` constant is replaced by `active_content_label(app)` (see §5.3).
- **Two events to the chrome:**
  - `tabs.state` (new): `{ tabs: [{ id, pinned, live }], activeId }` — structure
    and lifecycle only (order = array order).
  - `nav.state` (existing, already per-`viewId`): each tab's
    `url/title/isLoading/canGoBack/canGoForward`. The chrome keeps a
    `Map<viewId, NavState>` — the strip reads `map[id].title`/`isLoading` per tab;
    the toolbar/address bar read `map[activeId]`.

### 5.2 Webview lifecycle — time-based discard (the Hybrid model)

Bounded RAM by **inactivity time**, not a count cap.

- **`Settings.tabIdleTimeout`** (minutes; default **30**; `0` / "Never" disables
  auto-discard). The **active tab and pinned tabs are never discarded.**
- **Idle sweep:** a Rust background thread wakes every ~30–60 s and discards any
  live, non-active, non-pinned tab whose inactivity (`now - last_active`) exceeds
  the timeout. The sweep selects victims under the registry lock, then
  `run_on_main_thread`s the `Webview::close()` calls — webview ops must run on the
  main thread (the same pattern `nav.rs` uses for the HTTPS-Only re-navigate).
  `last_active` is a monotonic `Instant` (runtime-only, never serialized).
- **Create:** assign id, spawn a webview at the home URL, make it active. No
  eviction on create (that was the count-cap model — removed).
- **Activate:** if `live` → show it, hide the others; if discarded → `add_child`
  again, `navigate` to the stored URL, then show. Switching *away* stamps the
  now-background tab's `last_active`.
- **Close:** `close()` if live, remove from the registry, push
  `{ url, title, position, pinned }` onto `closed_stack`, activate a neighbor.
- The `live` flag in `tabs.state` lets the strip render **discarded tabs as
  "asleep"** (dimmed) — a cue that returning will reload them.

**Accepted trade-offs:** (1) without a count cap, opening many tabs *within* the
idle window keeps them all live — peak RAM scales with activity, by design.
(2) A backgrounded tab playing audio/video is still discarded at the timeout
(WebKit doesn't cheaply expose "audible"); audible-tab exemption is a future
refinement. (3) Returning to a discarded tab reloads it (loses scroll/form state);
snapshotting scroll position before discard is a future refinement.

### 5.3 Active-tab refactor

The one broad, mostly-mechanical change: the seven modules that look up
`CONTENT_LABEL` switch to the active tab's webview via
`active_content_label(app)` (or are passed an explicit `id`):

- `nav.rs` — `nav.*` dispatch acts on a target id (default: active); `emit_state`
  carries the real `viewId` instead of hardcoded `1`.
- `view.rs` — inset/overlay/sidebar/fullscreen geometry applies to the active
  webview; background webviews stay hidden.
- `linux_layout.rs` — §5.4.
- `adblock_webkit.rs` — Linux content filters installed **per spawned tab**.
- `permissions.rs`, `picker.rs`, `safety.rs` — operate on the active tab. (v1:
  a background tab that hits the malware guard has its navigation cancelled
  regardless; its interstitial surfaces if/when that tab becomes active.)

### 5.4 Linux multi-webview layout

`linux_layout::layout()` currently reparents the `GtkBox` children into a
`GtkFixed` and treats every non-content child as full-window chrome — which breaks
with N content webviews. Changes:

- Reparent **each newly `add_child`ed** tab webview into the existing `GtkFixed`
  (a tab spawned after startup is packed into the `GtkBox` again by wry).
- Position **only the active** content webview (inset); `set_visible(false)` on all
  other content webviews; keep the chrome full-window behind.
- `connect_title` and `connect_fullscreen_exit` are installed **per spawned tab**
  (each tab needs its own title→history signal and Esc-exits-fullscreen hook).

**This is the top implementation risk** — validate with an early spike (§11).

### 5.5 IPC contract (`shared/types.ts`)

Per the three-place rule (types.ts, Rust dispatcher, `ipcClient.ts`):

- New `IPC` channels: `tabs.create`, `tabs.close`, `tabs.activate`,
  `tabs.reorder`, `tabs.setPinned`, `tabs.reopenClosed`, `tabs.list`.
- New event: `tabs.state`.
- New types: `TabMeta { id: ViewId; pinned: boolean; live: boolean }`,
  `TabsState { tabs: TabMeta[]; activeId: ViewId }`.
- `Settings` gains `tabIdleTimeout: number` (minutes).
- `AegisApi` gains a `tabs` namespace:
  `create(url?) / close(id) / activate(id) / reorder(ids) / setPinned(id, pinned)
  / reopenClosed() / list()` plus `onState(cb)`.

### 5.6 Rust backend

- **`tabs.rs` (new):** the `Registry` behind a `Mutex` (Tauri state), the
  lifecycle logic (§5.2), the `tabs.*` dispatcher, the idle-sweep thread, and
  persistence (§5.7).
- **`nav.rs`:** `spawn_content` → `spawn_tab(id, url)` — same UA, ad-block inject
  script, download handler, and Windows WebView2 install as today, **plus** the
  `on_new_window` handler (§5.9). `nav.*` dispatch + `emit_state` take an id and
  drop the hardcoded `viewId: 1`.
- **`view.rs`:** layout applies to the active label.
- **`lib.rs`:** register the `Registry` state alongside `ContentInset`; build the
  shortcut menu (§5.10) and wire `on_menu_event`; on startup, **restore the
  session** (§5.7) instead of a single `spawn_content`.

### 5.7 Session restore & persistence

- Persist the registry to `tabs.json` via `jsonstore.rs` (per tab: `url`, `title`,
  `pinned`; plus order and `activeId`). Write debounced on change and on exit.
- **On launch:** if `tabs.json` is present and non-empty, recreate the tabs as
  **discarded** records and eagerly spawn only the active one (the rest lazy-spawn
  on activation — this dovetails with the time-based discard model). If absent,
  create one tab at the home URL (today's behavior).
- Per-tab full back/forward history is **not** persisted (URL only).

### 5.8 Back/forward per tab

Today nav uses `history.back()`/`forward()` via `eval` with `canGoBack:false`
hardcoded. Since every navigation is observed via `on_navigation`, each tab keeps a
small history index in the registry, yielding real `canGoBack`/`canGoForward` in
its `nav.state`. Movement still uses `eval`; only the index is tracked so the
buttons enable correctly.

### 5.9 Open-in-new-tab / new-window

Each tab's `on_new_window(url, _features)` returns `NewWindowResponse::Deny` (to
suppress the OS popup) and `run_on_main_thread`s a `tabs.create(url)` as a
**background** tab (browsers open `_blank`/`window.open` in the background by
default; `NewWindowFeatures` doesn't reliably carry the modifier). This fixes the
`target=_blank` / `window.open` dead-link gap ([[aegis-new-window-gap]]) as a side
effect. Ctrl/middle-click "open in new tab" uses the same path.

### 5.10 Keyboard shortcuts

React `keydown` only fires when the chrome/address bar is focused — when the user
is browsing, the **content** webview has focus, so shortcuts must be captured at
the native layer:

- **Windows/macOS:** a Tauri menu with accelerators; `on_menu_event` routes each
  to a tab action.
- **Linux:** extend the existing `connect_key_press_event` GTK hook on each content
  webview (already used for Esc) to capture Ctrl+T/W/Tab etc. — avoids forcing a
  visible menubar into the `GtkFixed` layout.
- Native captures route to the chrome via an emitted event; React `keydown` covers
  the chrome-focused case.

Bindings: Ctrl+T (new), Ctrl+W (close), Ctrl+Tab / Ctrl+Shift+Tab (cycle),
Ctrl+1–9 (jump to nth / last), Ctrl+Shift+T (reopen closed).

### 5.11 Renderer (`src/`)

Chrome layout, top to bottom: **`TabStrip` (top)** → `Toolbar` → `FavoritesBar`.

- **`TabStrip` (new component):** pinned tabs first (icon-only), then unpinned;
  active highlighted; per-tab close button; loading spinner from
  `map[id].isLoading`; a `+` new-tab button; discarded tabs dimmed ("asleep").
  Adds ~36 px, so the total top inset becomes ~132 px — one bump to
  `lib/layout.ts` + `DEFAULT_INSET_TOP` (the inset math is order-independent).
- **`useTabs` (new hook):** owns `tabs.state` + the `Map<viewId, NavState>` +
  `activeId`; exposes create/close/activate/reorder/setPinned/reopen. The
  toolbar/address bar bind to the active tab; `useNav` is generalized to take the
  active id.
- **Drag-reorder:** chrome-side reorder of the array → `tabs.reorder(ids)`
  (webviews untouched). **Pinned:** a button/context-menu toggles
  `tabs.setPinned`.
- New-tab page: opens the configured home URL.

## 6. Mobile (this phase)

`tabs.*` dispatch + the registry compile on mobile, but spawn/layout are no-ops;
Android keeps its single native WebView. The contract is shaped so the mobile-UI
phase implements only the native side + the mobile switcher.

## 7. Testing

- **Rust:** `tabs.rs` unit tests — lifecycle (create/activate/close), the idle
  sweep (discard + respawn), `closed_stack` reopen, session restore round-trip,
  pinned/active discard exemption.
- **Renderer (jsdom, mocked `aegis`):** `useTabs` (state reducer, active
  selection), `TabStrip` (render, active highlight, close, asleep dimming, drag
  ordering), keyboard-shortcut routing.
- **Shared:** contract tests for the new `tabs.*` channels/`TabsState` shape.
- Keep the existing ~413-test gate green; net-add coverage.

## 8. Risks & rollout

1. **Linux N-webview spike (do first).** Confirm `add_child`-after-startup +
   `GtkFixed` reparenting + per-tab title/Esc hooks behave with 3 tabs before
   building the strip. If wry misbehaves, fix it here.
2. **Time-based discard correctness.** The idle sweep must close webviews on the
   main thread and respawn cleanly on return; verify no leak / no double-free.
3. **Shortcut capture per OS.** Confirm the menu-accelerator (Win/macOS) and GTK
   key-hook (Linux) paths fire when the content webview is focused.

**Suggested build order:** spike → IPC contract + `tabs.rs` + lifecycle →
active-tab refactor → desktop `TabStrip` + activate/close → new-tab/new-window →
shortcuts → pinned + drag-reorder → session restore.

## 9. Future refinements (out of scope)

- Audible-tab exemption from idle discard.
- Scroll-position snapshot/restore across discard.
- Local favicon extraction.
- Persisting per-tab back/forward history across restart.
- A hard safety cap on live tabs (only if time-based RAM proves insufficient).
