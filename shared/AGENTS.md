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
  - **There is deliberately no `redirect.*` channel or event.** A scripted cross-origin
    top-frame redirect that the guard cancels is reported to the chrome by NO channel — the
    native guard opens the destination itself: `redirect_guard::on_blocked_redirect_to_new_tab`
    → `tabs::open_redirect_background` on desktop, and on Android the same native
    guard opens it (`NativeRedirectGuard.openBlockedRedirect` from
    `MainActivity.showRedirectBlocked`). A chrome-layer toast cannot paint over the
    native content WebView, so Android offers **no** affordance: when the budget
    refuses the open, `showRedirectBlocked` only logs, and the navigation stays
    refused. There is no Snackbar anywhere in the Kotlin, and no "Open anyway".
    An earlier version of this doc claimed a
    `redirect.blocked` event carried `{viewId, from, to}` to an `aegis.redirect.onBlocked`
    callback that then called `tabs.create(r.to, true)`. **That was never true, and the whole
    chain is now deleted** — no Rust ever emitted the event, and the renderer's own open path is
    precisely why ADDING the emit would have been the bug: both would open TWO background tabs
    per blocked redirect. If you ever want the chrome to learn about a block, wire ONE open path
    and delete the other in the same change. `ipcCatalog.drift.test.ts` is what catches the
    declared-but-unimplemented case, so an orphan cannot quietly reappear.
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
  3. **catalog event -> actually subscribed to**: every `evt*` key has a wrapper in
     PLACE 3 and a real `aegis.<ns>.on<Name>` **call** somewhere in `src/`.
     **This direction was blind until 2026-09-28, and the blindness was structural.**
     It searched for the literal `IPC.evt<Key>`, but `src/lib/ipcClient.ts` is one of
     the scanned files and _defines_ that literal for every event it wraps — so the
     transport satisfied the search for itself. Proof, not argument: neutralising the
     real `aegis.nav.onState` subscription in `useNav.ts:42` still left the guard at
     `12 passed (12)`. It now (a) derives the wrapper surface by parsing the one file
     where an `evt*` key and its wrapper name are bound together — the binding is NOT
     mechanically derivable (`evtNavState`→`nav.onState`, `evtPickerPicked`→
     `picker.onPicked`, `evtSubsChanged`→`subs.onChanged` are all irregular) — and
     (b) searches for the dotted **call** shape over comment-stripped sources, with
     `TRANSPORT_FILE` excluded. **Excluding the transport is the load-bearing part**;
     four `anti-vacuity` tests pin it, the decisive one asserting the transport cannot
     subscribe to itself. Turning it on immediately found three events with a wrapper
     and no caller — the same class as `subs.changed` and `picker.picked`. **A second,
     independent blind spot in the same direction was closed on 2026-09-29:** the parser
     that reads the wrapper surface keyed off `/^ {4}(\w+):/`, so the transport's two
     **method-shorthand** members (`form.detectLoginForm`, `form.onLoginFormDetected`,
     written `name(cb) {`) were invisible, `wrapper` stayed null, and `evtFormDetectResult`
     was EXEMPT from direction 3 without the guard ever having seen its wrapper. The rule
     is now a named `wrapperKeyOnLine(line)` that accepts `(` as well as `:` and requires
     an object-member terminator (`,`, `{`, `=>`) — the terminator set is ENUMERATED over
     the transport (104 lines end in `,`, 24 in `{`, 20 in `=>`; the only two ending in
     `;` are 4-space class statements), and an anti-vacuity test asserts the exact rejected
     set so a new non-member shape is a failure rather than a silent growth. Fixing it
     surfaced `evtFormDetectResult` as a genuine orphan, now recorded in
     `UNSUBSCRIBED_EVENTS` — and the first attempt at the terminator set, which omitted
     `=>`, misattributed the live `evtFormWillSubmit` to `onState` and reported it as an
     orphan. An event
     with **no wrapper at all** is not this direction's problem (the PLACE-3 contract
     test in `ipcClient.contract.test.ts` gates that, expecting `[]`), so direction 3
     does not blame itself for it.
  4. **no raw emit**: no channel-shaped literal reaches a bare `app.emit`; Tauri 2
     rejects dotted event names, so that is a silent no-op, not a shortcut.
     Each direction carries an **inventory** of known-and-explained exceptions, asserted
     as an exact set in _both_ directions — a new orphan fails, and so does a stale
     inventory entry. Adding a key to silence a failure is the antipattern this file
     exists to prevent; fix the code or the contract instead.

     **`UNSUBSCRIBED_EVENTS` currently holds THREE entries, and none is an excuse
     — they are open questions about the contract, recorded rather than guessed.**
     `vault.changed` (`vault.rs` `emit_changed`, six call sites) exists so "sync and
     other listeners know the vault data mutated", but `vault.state` is already
     subscribed and carries the same mutation. `form.state` (`form.rs`
     `emit_form_state`) is emitted, and the catalog also has a separate
     `form.detectionResult`. In both cases the open question is **which event is the
     contract**, not who should subscribe — deleting either on a hunch would remove a
     live contract. Resolving them needs a decision, not a guard change.
     The third is `form.detectionResult`: nothing emits it on ANY platform
     (`form.rs` describes the result but no arm sends it), and the login-form
     detector cannot work on any platform today — the content webview has no Tauri
     capability, so `window.__TAURI__` is undefined there and `form.detectLoginForm`
     now returns an `Err` instead of quietly reporting "no form". This file already
     names that event elsewhere as the reason the detector is inert, which is why the
     count here was the one number that had drifted out of step with the list below.
     **`sync.vaultQuarantined` was in this class and is now FIXED** (2026-09-28): the
     event is the _only_ channel for a rejected vault write (it is in no `state_json`,
     so there is no polling fallback), `shared/types.ts` calls it "a security outcome
     worth surfacing", and nothing subscribed — so a peer pushing a forged record was
     quarantined and the user was never told. It was never added to this inventory: once
     the caller existed it dropped off the unexplained list on its own, which is the
     inventory behaving as designed.

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
direction 2, and an `evt*` key with a wrapper but **no `aegis.<ns>.on<Name>` call
anywhere in `src/`** fails direction 3. Renaming a channel to a _shape-preserving_
wrong value — `nav.back` → `nav.backk` — passes `types.test.ts`'s naming regex and
fails only here.

**Settings-field shortcut.** A new _settings field_ needs **no new channel** — add it
to `settings.rs defaults()` + the `Settings` interface here; `settings.set`
shallow-merges it. A Rust reader (mirror `https_only()`) exposes it to the core.

**Local-only settings (the exception to "settings are synced").** Not every settings
field may ride the sync projection. A field listed in `LOCAL_ONLY_KEYS`
(`src-tauri/src/settings.rs`) is persisted by `settings.set` but **never** recorded into
`settings-sync.json`, is skipped by the migration seed, and is ignored when a peer's
record claims it. Its current members are `syncAllowInsecure` — the waiver that lets the
sync server be plaintext `http://` — and `syncVault`, the opt-in that includes the
password vault in sync. The shared reason is that **every synced setting is writable by
any device holding the account's data key**: `syncServerUrl` IS synced, so a waiver that
travelled with it would let one poisoned record pair walk a device onto a plaintext
server; and `syncVault` is the switch that makes credentials leave the machine, so one
record on one paired device would have turned that on for every device the user owns. If
you add a settings field that weakens a _local_ security decision, add it to that list and
extend `sync_allow_insecure_is_local_only` / `sync_vault_is_local_only`-style coverage,
rather than letting it sync by default.
`the_local_only_list_is_exactly_the_two_credential_and_transport_waivers` asserts the
list's exact membership, so a third key cannot land without a test.

**Event-driven refetch.** A `*.changed` event must drive a **targeted per-store
refetch** (the precedent is `useHistory` subscribing `onChanged(() => list())`), never
a `window.location.reload()`.

**An event with no subscriber is a defect, and the ones the drift test found are being
fixed (2026-09-27; see the inventory above for the two still open).**
`shared/ipcCatalog.drift.test.ts` direction 3 asserts that every catalogued event's
`aegis.<ns>.on<Name>()` wrapper is actually **called** somewhere in the renderer — not, as it
used to, merely that the `evt*` key is _referenced_, which the transport satisfied for
itself — and `src/lib/ipcClient.contract.test.ts` asserts the weaker runtime property with a
derived ratchet that expects the unaccounted set to be **`[]`**. Each carries a "no stale
entry" test, so fixing a defect obliges deleting its excuse. Three real ones were found
(the first two by the blind direction, the third once it worked):

- **`picker.picked`** was declared, emitted (`picker.rs:302`) and delivered to nobody.
  Worse, the UI that wanted it was wired to the RETURN value of `picker.start` — which
  no platform arm of `start` ever populates with a `rule` (all four return `{"ok": true}`
  at `picker.rs:332/352/385/391`) — so the "Hiding rule added: …" toast was unreachable
  everywhere. It **cannot** be a return value: `start` injects the picking overlay and
  returns, and the pick only happens later, when the user clicks an element. Now
  `aegis.picker.onPicked` exists and `PickerButton` subscribes.
  **Lesson worth keeping: a test that mocks the value production is missing has
  manufactured the bug, not found it.** The old `PickerButton` test resolved
  `{ ok: true, rule: 'example.com##.ad' }` from `start` and then asserted the toast —
  it could not fail, because nothing in the real core ever returns that shape.
- **`subs.changed`** was emitted after a background fetch (`subs.rs:196/291/292`) and had
  no subscriber. `subs.add` and `subs.setEnabled` return the store as it is _before_ their
  fetch runs, so a new row's reply has `lastUpdated: null` by design
  (`subs.rs:338-343`); the core rewrites it on a spawned thread and emits. Now
  `aegis.subs.onChanged` exists and `useSubscriptions` re-reads the list on it.
  Two corrections to the original audit finding, both from reading the code: it was **not**
  a visible-staleness bug (`FilterListsTab` renders only `enabled`/`listId`/`url`/`builtin`
  — never `lastUpdated`/`etag`/`hash`), and `subs` is **not** in
  `sync_stores::SYNCABLE`, so there was no second device to diverge from either. It was a
  trap for whoever next adds a "last updated" column.
- **`sync.vaultQuarantined`** was emitted (`sync.rs:562-568`) and delivered to nobody, and
  it is the **only** channel for it — a grep for `quarantin` across every `src-tauri/src/*.rs`
  shows it is in no `state_json`, so there is no polling fallback. Both the core's own
  comment and `shared/types.ts` call it a security outcome worth surfacing, and a forged or
  wrong-keyed peer write was being rejected in silence. `useSync` now carries it as
  `quarantined` and the Sync tab renders it as its own `role="alert"`. See `src/AGENTS.md`
  for why it is deliberately NOT folded into `state.lastError`.
- `useCustomFilters` also refetches on `picker.picked`, because the picker appends to the
  same store the My Filters panel reads and `customfilters.rs` emits **nothing** of its own
  (0 `emit_event` calls) — a My Filters panel left open across a pick used to show the
  pre-pick text until the modal was reopened.

## Tests

Run in the vitest **node** project (`include: shared/**/*.test.ts`). `npm test` from
the repo root runs them.
