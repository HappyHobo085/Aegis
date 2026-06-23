# shared/ — the IPC contract

A single source of truth shared by the React renderer (`src/`) and consumed by both
sides of the IPC boundary. **Changing `types.ts` is changing the contract** between
the frontend and the Rust core — keep all three in sync (this file, the Rust
dispatcher in `src-tauri/src/lib.rs`, and `src/lib/ipcClient.ts`).

## Files

- **`types.ts`** — the contract:
  - `IPC` const — every channel name (e.g. `nav.navigate`, `adblock.getState`) and
    every event name (e.g. `nav.state`, `adblock.blockedCount`). The renderer calls
    `invoke('ipc', {channel, payload})` with these; the Rust `ipc()` command
    dispatches on them. **Logical names are dotted here**; the Rust/JS transport
    rewrites event `.` → `:` because Tauri 2 forbids dots in event names.
  - Data models — `NavState`, `Favorite`, `HistoryEntry`, `SavedItem`,
    `DownloadEntry`, `SitePermission`, `Settings` (incl. `tabIdleTimeout`),
    `AdblockState`, `UpdateState`, `SafetyInterstitialPayload`, `Subscription`,
    `TabMeta`, `TabsState` (the ordered tab list + active id), `RedirectBlocked`, etc.
  - `tabs.*` channels: `tabs.create` (optional `background` flag — opens without
    switching the active tab, for mobile `target=_blank`), `tabs.close`, `tabs.activate`,
    `tabs.reorder`, `tabs.setPinned`, `tabs.reopenClosed`, `tabs.list`, `tabs.setTitle`
    (chrome relays the content title into the registry; Android has no native title signal).
  - `tabs.state` event (emitted on every structural change) + `tabs.shortcut`
    event (Ctrl+T/W/Shift+T from native accelerator/GTK hook).
  - `redirect.blocked` event (`evtRedirectBlocked`, payload `RedirectBlocked { viewId,
from, to }`) — the native redirect guard cancelled a scripted cross-origin top-frame
    redirect. The chrome surfaces it (desktop `RedirectBar` infobar / Android Material
    Snackbar) with "Open anyway" → opens `to` in a new tab (`tabs.create` desktop /
    `__aegisOpenTab` Android). Emitted per-platform from the native nav-policy hook; see
    `src-tauri/CLAUDE.md` gotcha 14.
  - `find.*` channels + `find.state` event: - `find.start` (payload `{ query, caseSensitive?, viewId? }`) — begin/update a
    find-in-page session on the active (or specified) tab. - `find.next` / `find.prev` (payload `{ viewId? }`) — advance to the next/previous
    match within the current session. - `find.close` (payload `{ viewId? }`) — end the session and clear all highlights. - `find.state` event (`evtFindState`, payload `FindState { viewId, query, matchCount,
activeMatchIndex }`) — pushed by the Rust/Kotlin back-end whenever match counts
    change. On Android this is emitted via `window.__aegisFindState(...)`, matching the
    `pushNavState` / `__aegisNavState` bridge pattern.
  - `AegisApi` — the typed shape of `window.aegis` (what `src/lib/ipcClient.ts`
    implements). Adding a feature means adding it here first.
- **`types.test.ts`, `types.update.test.ts`** — assert the contract's invariants
  (e.g. `IPC` channel naming, update-state shape).

## Adding a channel

Three places, always (the `types.test.ts` invariant enforces every `IPC` value is
dot-separated and unique, so a malformed/colliding name fails the test):

1. **PLACE 1 — `types.ts`:** add the channel/event name to the `IPC` const, any new
   payload interface, and the typed method/namespace to `AegisApi`.
2. **PLACE 2 — `src-tauri/src/lib.rs`:** `mod foo;` + an
   `if let Some(result) = foo::dispatch(&app, &channel, &payload) { return result; }`
   arm in `ipc()` before the fallthrough. The module's
   `dispatch(app, channel, payload) -> Option<Result<Value, String>>` matches its
   channels and returns `None` otherwise (see `settings.rs`). For an **event**, emit
   only via `crate::emit_event(app, "foo.bar", payload)` — it does the `.`→`:`
   rewrite; never `app.emit` a raw dotted name.
3. **PLACE 3 — `src/lib/ipcClient.ts`:** `call<T>(IPC.x, payload)` for commands;
   `on<T>(IPC.evtX, cb)` for events (tauriInvoke.ts reverses `:`→`.`).

**Settings-field shortcut.** A new _settings field_ needs **no new channel** — add it
to `settings.rs defaults()` + the `Settings` interface here; `settings.set`
shallow-merges it. A Rust reader (mirror `https_only()`) exposes it to the core.

**Event-driven refetch.** A `*.changed` event must drive a **targeted per-store
refetch** (the precedent is `useHistory` subscribing `onChanged(() => list())`), never
a `window.location.reload()`.

## Tests

Run in the vitest **node** project (`include: shared/**/*.test.ts`). `npm test` from
the repo root runs them.
