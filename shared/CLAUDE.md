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
    `TabMeta`, `TabsState` (the ordered tab list + active id), etc.
  - `tabs.*` channels: `tabs.create` (optional `background` flag — opens without
    switching the active tab, for mobile `target=_blank`), `tabs.close`, `tabs.activate`,
    `tabs.reorder`, `tabs.setPinned`, `tabs.reopenClosed`, `tabs.list`, `tabs.setTitle`
    (chrome relays the content title into the registry; Android has no native title signal).
  - `tabs.state` event (emitted on every structural change) + `tabs.shortcut`
    event (Ctrl+T/W/Shift+T from native accelerator/GTK hook).
  - `AegisApi` — the typed shape of `window.aegis` (what `src/lib/ipcClient.ts`
    implements). Adding a feature means adding it here first.
- **`types.test.ts`, `types.update.test.ts`** — assert the contract's invariants
  (e.g. `IPC` channel naming, update-state shape).

## Adding a channel

1. Add the channel/event name to the `IPC` const here (and any new interface).
2. Add the method to `AegisApi` and implement it in `src/lib/ipcClient.ts`.
3. Handle the channel in the Rust dispatcher (`src-tauri/src/lib.rs` → owning module).

## Tests

Run in the vitest **node** project (`include: shared/**/*.test.ts`). `npm test` from
the repo root runs them.
