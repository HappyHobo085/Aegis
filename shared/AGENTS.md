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
from, to }`) — **DECLARED BUT NOT EMITTED ANYWHERE.** An earlier version of this doc
    claimed it was "emitted per-platform from the native nav-policy hook"; that was false and
    `ipcCatalog.drift.test.ts` now fails the build if a doc drifts that way again. The blocked-redirect
    behaviour really does ship, but through two mechanisms that bypass this event entirely:
    desktop opens the destination natively in `redirect_guard::on_blocked_redirect_to_new_tab`
    (→ `tabs::open_redirect_background`), and Android injects `window.__aegisOpenTab(...)` into
    the chrome from `MainActivity.kt`. The renderer's `aegis.redirect.onBlocked` callback
    (`App.tsx`) _also_ calls `tabs.create(r.to, true)`, so **emitting this event from Rust would
    open two background tabs per blocked redirect** — the missing producer is load-bearing, not
    an oversight. If you ever wire it up, delete one of the two open paths in the same change.
    `autopilot/channelDrift.test.ts` lists this channel in a `KNOWN_UNPRODUCED` inventory with
    this reasoning; adding a fourth unexplained orphan still fails the build.
  - `find.*` channels + `find.state` event:
    - `find.start` (payload `{ query, caseSensitive?, viewId? }`) — begin/update a
      find-in-page session on the active (or specified) tab.
    - `find.next` / `find.prev` (payload `{ viewId? }`) — advance to the next/previous
      match within the current session.
    - `find.close` (payload `{ viewId? }`) — end the session and clear all highlights.
    - `find.state` event (`evtFindState`, payload `FindState { viewId, query, matchCount, activeMatchIndex }`) — pushed by the Rust/Kotlin back-end whenever match counts change. On Android this is emitted via `window.__aegisFindState(...)`, matching the `pushNavState` / `__aegisNavState` bridge pattern.
  - **`sync.*` — the vault-sync opt-in** (see `src-tauri/src/sync_vault.rs` for the
    wire format, which is deliberately NOT a plain `sync.ns` — read that header first):
    - `Settings.syncVault?: boolean` — **defaults to `false`**, and is a _separate_
      opt-in from configuring `syncServerUrl`. Configuring a server must never silently
      start uploading credentials, so nothing is synced until the user turns this on
      explicitly (Settings → Sync → "Password vault").
    - The flag alone is not sufficient: it only takes effect once this device has
      **adopted the account's shared vault salt**. Adoption happens on the next
      `vault.unlock` (a re-seal, so it needs the master password) and only if the vault
      has no undecryptable records. Until then `VaultState.syncEnabled` is `false` and
      the Sync tab says so.
    - `sync.vaultQuarantined` event (`evtSyncVaultQuarantined`, payload
      `SyncVaultQuarantined { count, uuids }`) — a peer sent a record that failed
      authentication under the local vault key, so it was rejected and never written.
      This is an **event, not a sync error**: a rejected forgery is a security outcome
      and must not fail the namespaces that did merge. A peer holding the recovery
      phrase but NOT the master password cannot derive the vault key, so its writes land
      here.
    - `VaultState.syncEnabled` is true only when the opt-in is on **and** sync is enabled
      **and** the vault is unlocked **and** adoption happened. `VaultState.adoptionNote?`
      appears only on the `vault.unlock` response, and only when adoption was _refused_
      (e.g. undecryptable records present) — the unlock still succeeded; it is a warning,
      not a failure.
  - **`vault.*` channels** (Phase A — manage only, NO autofill; note `vault_inject.js` IS
    injected at document start but is inert because `withGlobalTauri` is not enabled, and
    no component subscribes to `vault:autofillResult` — see `src-tauri/AGENTS.md`):
    - `vault.getState` → `VaultState` — whether a vault exists, is unlocked, and how many
      records it holds. Safe to call at any time.
    - `vault.create(masterPassword)` → `VaultState` — initialize a new vault with the given
      master password; errors if one already exists.
    - `vault.unlock(masterPassword)` → `VaultState` — load + decrypt the vault; returns
      `VaultState` with `unlocked: true` on success or an error string on wrong password.
    - `vault.lock()` → `VaultState` — wipe the in-memory DEK and records (zeroize on drop).
    - `vault.list()` → `VaultRecord[]` — returns all decrypted records; errors if locked.
    - `vault.add(VaultRecordInput)` → `VaultRecord[]` — upsert + persist; returns the full
      updated list.
    - `vault.update(uuid, partial)` → `VaultRecord[]` — partial-update a record by uuid.
    - `vault.remove(uuid)` → `VaultRecord[]` — remove a record and persist.
    - `vault.search(q)` → `VaultRecord[]` — case-insensitive filter across site/username/notes.
    - `vault.state` event (`evtVaultState`, payload `VaultState`) — pushed after every
      create/unlock/lock/add/update/remove so the chrome stays in sync. Carries **no
      credential data** (`{exists, unlocked, count, undecryptable}` only).
  - **Vault data models:** - `VaultState { exists: boolean; unlocked: boolean; count: number; undecryptable: number }`
    — safe summary; no credentials. `undecryptable` = on-disk records that failed to decrypt
    on unlock (corrupt/truncated); they are PRESERVED on disk (re-written by `persist`, never
    dropped) and the UI warns rather than silently losing them. This is the ONLY vault data
    emitted as a Tauri event. - `VaultRecord { uuid: string; updatedAt: number; site: string; username: string;
password: string; notes: string }` — decrypted record; returned only by direct IPC
    commands (`list`/`add`/`update`/`remove`/`search`) to the chrome, never to the content
    webview. - `VaultRecordInput { site: string; username: string; password: string; notes?: string }` —
    input shape for `add`/`update`.
  - `AegisApi` — the typed shape of `window.aegis` (what `src/lib/ipcClient.ts`
    implements). Adding a feature means adding it here first.
- **`types.test.ts`, `types.update.test.ts`** — assert the contract's invariants
  (e.g. `IPC` channel naming, update-state shape).
- **`ipcCatalog.drift.test.ts`** — the drift guard, in **four** directions. It is a
  _source scan_ of `src-tauri/src/*.rs` + `src/**`, not a behavioural test, because
  `ipc()` takes a concrete wry `&AppHandle` and the renderer specs run against
  `testFixtures/aegisMock.ts` — so nothing else in the suite can see a channel that
  the Rust side does not implement.
  1. **catalog → Rust**: every `IPC` value is implemented somewhere in Rust. This is
     the direction that matters: it is the one that was blind. Renaming 4 channels to
     shape-preserving wrong values left all 1346 other tests green.
  2. **Rust → catalog**: every name Rust _acts on_ — `match channel` arms, `channel ==`
     guard clauses, `emit_event` args, `.listen` args — is in the catalog. Scoped to
     those four sites on purpose; a whole-file scan yields 45 false positives
     (store filenames, test hostnames).
  3. **catalog event → renderer**: every `evt*` key is referenced by a real `src/`
     file, so the core never emits into the void.
  4. **no raw emit**: no channel-shaped literal reaches a bare `app.emit`; Tauri 2
     rejects dotted event names, so that is a silent no-op, not a shortcut.
     Each direction carries an **inventory** of known-and-explained exceptions, asserted
     as an exact set in _both_ directions — a new orphan fails, and so does a stale
     inventory entry. Adding a key to silence a failure is the antipattern this file
     exists to prevent; fix the code or the contract instead.

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

`ipcCatalog.drift.test.ts` is the gate that ties the three together, and it is stricter
than the three-place rule: PLACE 2 with no PLACE 1 fails direction 1, PLACE 1 with no
PLACE 2 fails direction 1, a PLACE 2 arm for a name PLACE 1 never declares fails
direction 2, and an `evt*` key with no `on(…)` caller fails direction 3. Renaming a
channel to a _shape-preserving_ wrong value — `nav.back` → `nav.backk` — passes
`types.test.ts`'s naming regex and fails only here.

**Settings-field shortcut.** A new _settings field_ needs **no new channel** — add it
to `settings.rs defaults()` + the `Settings` interface here; `settings.set`
shallow-merges it. A Rust reader (mirror `https_only()`) exposes it to the core.

**Local-only settings (the exception to "settings are synced").** Not every settings
field may ride the sync projection. A field listed in `LOCAL_ONLY_KEYS`
(`src-tauri/src/settings.rs`) is persisted by `settings.set` but **never** recorded into
`settings-sync.json`, is skipped by the migration seed, and is ignored when a peer's
record claims it. Its current member is `syncAllowInsecure` — the waiver that lets the
sync server be plaintext `http://` — because `syncServerUrl` IS synced: a waiver that
travelled with it would let one poisoned record pair walk a device onto a plaintext
server, i.e. a remote settings write would become a silent transport downgrade. If you add
a settings field that weakens a _local_ security decision, add it to that list and extend
`settings::tests::sync_allow_insecure_is_local_only`-style coverage, rather than letting it
sync by default.

**Event-driven refetch.** A `*.changed` event must drive a **targeted per-store
refetch** (the precedent is `useHistory` subscribing `onChanged(() => list())`), never
a `window.location.reload()`.

## Tests

Run in the vitest **node** project (`include: shared/**/*.test.ts`). `npm test` from
the repo root runs them.
