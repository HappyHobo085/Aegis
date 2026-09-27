# Changelog

All notable changes to Aegis are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The element picker's confirmation toast never appeared, on any platform.** The
  toolbar picker awaits a `rule` off the return value of `picker.start`, but `start`
  only injects the picking overlay and returns — and none of its four platform arms ever
  populates a `rule`. The rule is delivered later, as the `picker.picked` event, once the
  user clicks an element; nothing was subscribed to it, so "Hiding rule added: …" was
  unreachable. It is now wired end to end (`aegis.picker.onPicked`), and the `rule?` that
  was mis-shaped onto `start()`'s return type is gone. The button is also no longer
  disabled while the pick is pending, since that part is asynchronous with the overlay.
- **A My Filters panel left open across a pick showed the pre-pick text** until the
  settings modal was reopened. The picker appends to the same store the panel reads, and
  `customfilters.rs` emits nothing of its own, so `picker.picked` is the only signal there
  is. It now triggers a targeted refetch.
- **A background filter-list refresh left the renderer's copy of the metadata stale
  forever.** `subs.add` and `subs.setEnabled` return the store _before_ their background
  fetch runs — a brand-new subscription comes back with no "last updated" time by design —
  and the core emits `subs.changed` when the fetch lands. Nothing was listening. This is
  the `[LOW]` finding from the long-deleted `docs/CODE_AUDIT.md`, recorded and never
  actioned. It had no visible symptom until now (`FilterListsTab` never displayed
  `lastUpdated`/`etag`/`hash`, and subscriptions do not sync between devices), so it was a
  trap for the next person to add a "last updated" column rather than a live bug.
- **The IPC drift guard's "known and explained" lists are now empty.** The two real
  entries in them are the two fixes above, and the guard fails if an excuse outlives the
  defect it describes. It also now rejects a new subscriber that forgets to unsubscribe,
  and the contract test's derived ratchet expects **every** catalogued event to have a
  real subscriber — previously one was allowed to be missing.

### Added

- **A test-coverage ratchet on both sides of the repo, wired into CI.** This is a gate, not
  a claim: neither the renderer nor the Rust core is at 100%, and the committed numbers say
  so honestly rather than quietly rounding up to a threshold nobody reads.
  - **Renderer** (`coverage-baseline.json`, 116 files): lines 85.72%, statements 84.27%,
    functions 82.22%, branches 77.71%. The gate fails if any metric drops below the
    baseline, if the baseline was _lowered_ in the same commit, or if a file the baseline
    names left the report — the last check is what stops an added `coverage.exclude` from
    buying a green build by shrinking the denominator. Raising the baseline is free.
  - **Rust core** (`src-tauri/coverage-baseline.json`, 43 files): lines 75.76%, statements
    76.45%, functions 72.13%, measured with `cargo llvm-cov --lib`. Branches are **not**
    gated: llvm branch coverage needs `-Z coverage-options=branch`, i.e. a nightly
    compiler, and the repo pins stable 1.98.0. The eight platform-gated modules
    (`linux_layout.rs` and the `*_win.rs` / `*_mac.rs` pair) are excluded with a
    committed per-file reason and their real numbers printed on every run, because on a
    Linux runner they are either 0% or not compiled at all — a threshold that silently
    depends on the machine is not a threshold.
  - **CI provisions a keyring** (`gnome-keyring-daemon` under `dbus-run-session`) for **both**
    cargo invocations in the Rust job — `cargo test` _and_ `cargo llvm-cov` — because three
    `sync_keystore` tests round-trip a real OS keyring and otherwise early-return, passing
    while covering nothing. They are separate processes and each CI step is a fresh shell,
    so the wrapper has to appear twice; wrapping only `cargo test` made the coverage step
    measure a different program than the one CI tests (11038/14750 covered lines against a
    11175/14750 baseline). A committed threshold that depends on whether a keyring happens
    to be present is not a threshold. The Rust ratchet also prints per-file covered-line
    deltas on failure, so "code stopped executing" is distinguishable from "code was
    deleted" in one run.
  - Both gates run in the `web` and `rust` jobs only, never in `msrv` or `cross-target`.
- **Three drift guards, replacing the ones lost with `src/autopilot/`.**
  - `shared/ipcCatalog.drift.test.ts` walks the IPC contract in **four directions**:
    a catalog entry with no Rust behind it, a Rust `match` arm / `emit` / `listen` /
    `channel ==` with no catalog entry, a declared `evt*` with no renderer subscriber, and
    a raw dotted event name passed to `emit`. A shape-preserving channel rename passes
    `shared/types.test.ts`'s naming regex and fails only here — proved by mutating four
    channel names, which turned **only** these tests red out of 1346 others.
  - `src/lib/ipcClient.contract.test.ts` (179 tests) pins **every** request channel's
    `invoke('ipc', {channel, payload})` shape and every event's colon spelling, plus the
    Android bridge dispatch. Every other spec replaces the whole `aegis` object with
    `testFixtures/aegisMock.ts`, so before this the channel strings themselves were never
    executed by any test.
- **Tests for the three `scripts/` gates that no test previously imported**
  (`check-bundle-size`, `check-npm-audit`, `check-android-versioncode` — 30 tests, spawned
  as subprocesses against a sandboxed copy of each script, because all three read their
  inputs at module load and `process.exit`). They still report **0%** in the coverage
  report: v8 only instruments the test worker's own V8 runtime, so a spawned subprocess
  earns no credit. That is now documented as "not measurable here", not "untested".

### Removed

- **Split view is gone** (`Ctrl+Shift+S`, drag-a-tab-onto-a-tab, the resize handles, and the
  toolbar pane-count badge). It was a **user-facing feature on Windows only**: the pane
  positioning existed solely in `view.rs`'s `#[cfg(target_os = "windows")]` branch, so on
  Linux and macOS entering a split updated the core state and left the content webviews
  **overlapping**, and Android had no implementation at all. On top of that the resize clamp
  was genuinely broken: `App.tsx` passed a **fraction** (`pixelDelta / window.innerWidth`)
  into `clampResizeDelta`, which compared it against **pixel** bounds, so any split with a
  pane under ~17% either did nothing (the handle silently died) or slammed to 0.05/0.95 on
  a 10px drag. The two bounds were also mutually unsatisfiable as written (a 200px minimum
  and an 80% maximum cannot both hold in a two-pane layout that sums to 1), so the fix was
  a design change rather than a one-liner. Rather than ship three platforms of a
  one-platform feature, it was removed. **Removed with it:** `src-tauri/src/split.rs` (473
  lines, 20 Rust tests), `useSplit`, `SplitIndicator`, `SplitResizeHandle`, the `split.*`
  pixel-geometry half of `contentLayout.ts`, five IPC channels plus the `split.state` event,
  the `split` namespace on `AegisApi`, the toolbar's split slot, the TabStrip drag-to-split
  branch (a drop now always reorders), and 103 lines of CSS. **Behaviour change to
  remember: shift-dropping a tab onto another tab now reorders instead of opening a split.**
- **The `src/autopilot/` renderer test harness is gone** (8,536 lines: the feature
  `CATALOG`, the `SCREENS` list, the interaction specs, and the drift guards). Removed at
  the repo owner's request, together with the production seams that existed only to serve
  it — the dev-only `installAutopilotControl` surface in `App.tsx`, the
  `VITE_AEGIS_AUTOPILOT` branch in `Onboarding`, and the direct-set seeding seams in
  `useAdblock` / `useDownloads` / `useHistory` / `usePermissions` / `useSaved` / `useVault`.
  **No user-facing feature changed.** The cost is real and worth stating: five build-gate
  drift guards went with it (a new IPC channel with no catalog entry, an overlay that does
  not lower the content webview, a mobile surface that drops a safe-area inset, a
  duplicate `IPC` constant, a control id with no spec). Channel/screen drift is no longer
  caught automatically.

### Fixed

- **`WorkspaceSwitcher`'s context-menu colour picker could never open.** The "Color" item
  set `showColorPicker` and cleared `ctxMenu` in the same handler, but the picker was
  rendered inside the `{ctxMenu && …}` block, so it unmounted in the commit that created
  it — `onSetColor` was unreachable from the UI. The picker is now a sibling of the menu.
- **Picking a colour for a NEW workspace was unreachable.** Clicking the create form's
  colour dot (or a swatch) blurred the name input, and the empty-name `onBlur` cancelled
  the whole form. Both now `preventDefault` on mousedown so the input keeps focus.

### Tests

- New coverage for the previously untested `url`, `syncBus`, `tauriInvoke`,
  `protectionSummary`, `useOmnibox`, `useMeasuredHeight`,
  `useNarrowViewport`, `useSafety`, `useDownloadToasts`, `useAutofillSave`,
  `NavControls`, `OmniboxDropdown`, `SkipLink`, `PrivacyDashboard` and
  `WorkspaceSwitcher`, plus the first tests for `customfilters.rs`
  (22, covering its single-record HLC last-writer-wins merge and tombstones).
- `tauriInvoke.on()`'s unsubscribe is now idempotent, so a double-invoked effect cleanup
  cannot release a backend listener twice.
- `url.originOf` now returns `null` for an opaque origin (`about:`, `data:`) instead of
  the literal string `"null"`, which had been silently defeating every
  `origin === null` guard in the app.

## [0.1.0] — unreleased

First pre-release. Treat the version number as provisional: the API surface, the
on-disk store formats, and the sync protocol may still change before a tagged
release.

### Security

- **The anti-malvertising redirect guard can no longer be spoofed by a web page.**
  `picker::on_picked` trusted any `document.title` starting with `AEGISPICK:`, and
  `document.title` is page-controlled — so any site could append rules to the
  persistent, synced custom-filter list and force a full ad-block engine rebuild,
  without the user ever opening the element picker. The sentinel now carries a
  per-session 128-bit nonce minted in `picker::start`, baked into the injected
  overlay's closure (never exposed on `window`) and single-use. The injected
  `document.title` channel is documented as untrusted.
- **The password vault is actually portable across paired devices, and can no longer be
  destroyed by a peer.** The vault key is `Argon2id(master_password, salt)`, and every
  device used to mint its _own_ random salt, so no record could ever cross devices. The
  account now publishes one salt in a `pwvault-meta` namespace and a joining device
  adopts it by re-sealing. Remote records are authenticated under the local vault key
  **before** they are allowed anywhere near the file; failures are quarantined and
  reported via a new `sync.vaultQuarantined` event instead of being merged. (The
  previous merge compared `updatedAt` without decrypting and rewrote the file
  preserving only salt/verifier/kdf, so a peer — or a corrupted blob — could overwrite a
  real credential with permanently unreadable ciphertext.)
- **Vault sync is a separate, opt-in, default-off decision** (`Settings.syncVault`).
  Configuring a sync server no longer implicitly uploads credentials. Records are
  sealed under both the sync root and the vault key, so the recovery phrase alone
  cannot read them.
- **`settings.set` validates every key.** It previously shallow-merged any key with any
  value, so one call could repoint `homeUrl` at a `file://` URL, join `downloadDir`
  anywhere, or disable `httpsOnly` / `webrtcPolicy` / anti-fingerprinting — and a
  poisoned `homeUrl` was then synced to every other device. It is now an explicit
  allow-list with per-key validators, applied before the merge.
- **`data.export` / `data.import` no longer accept a renderer-supplied path.** They
  could overwrite any user-writable file, and the export path (created without a mode,
  then renamed over the target) downgraded a `0600` file to `0644`.
- **Proxy configuration cannot inject Chromium command-line switches.** The proxy
  `host` was only `.trim()`ed and then interpolated into `--proxy-server=`, so a value
  like `127.0.0.1:1 --remote-debugging-port=9222` opened a CDP endpoint on every
  subsequently spawned content webview. Host and bypass entries are now validated
  against an explicit character set.
- **Store files are created `0600`.** `vault.json`, `sync-vault.json`,
  `sync-device-salt.json`, `settings.json`, `history.json` and the export bundle were
  all landing world-readable depending on the umask.
- **The sync server requires `https://`**, except on loopback. A per-device
  `Authorization` credential was previously sent over plain HTTP to whatever host the
  free-text setting named.
- **All nine JNI entry points are panic-guarded** via `crate::ffi_guard`. A panic
  unwinding through a JNI frame is undefined behaviour and aborted the process; seven of
  the nine were unguarded, including the two on the hot path of every intercepted
  request and every navigation.

### Correctness and reliability

- **`sync.disable` now actually stops an in-flight pass.** It cleared the root and set
  the status to `Disabled`, but the already-spawned pass kept pushing every namespace
  and then unconditionally overwrote the status with `Idle` — so the UI showed a
  disabled account as idle while the upload finished. Passes now carry a generation
  counter and re-check before the push.
- **`syncIntervalSec: 0` no longer free-runs.** It was documented as "disable" but
  `sleep(0)` returns immediately, so the app pulled/merged/pushed in a hot loop —
  reachable from an imported settings bundle, not just the settings UI.
- **A panic in the ad-block engine thread no longer disables ad-blocking silently, and
  permanently.** The `!Send` engine lives only on that thread, so a panic dropped the
  receiver and every later query failed _open_ — the user saw a working browser with no
  ad-blocking and no error. The loop now recovers per message, keeping the previous
  engine. Engine queries are also bounded, so a filter-list reload can no longer stall
  every in-flight `should_block` (including the GTK main thread) behind a full
  EasyList re-parse.
- **`vault.unlock` no longer freezes the window.** Repeated wrong passwords slept the
  calling thread — which is the GUI thread — for up to five minutes per attempt, with a
  streak that never decayed. The rate limit is now enforced by refusing the attempt
  early (so a refused attempt does not even pay for Argon2id) and telling the caller how
  long to wait; an idle streak decays.
- **Concurrent writes to a store no longer lose each other.** Read-modify-write had no
  lock, so a `favorites.add` racing a sync merge could be silently overwritten — and the
  successful save hid the loss. A per-store lock now guards the whole read-modify-write.
- **The accent-colour picker actually works.** It wrote two legacy CSS aliases while
  ~44 rules read the canonical tokens, so a third of the UI ignored the user's choice
  and the contrast guard was defeated (text stayed `#ffffff` regardless).

### Developer experience

- **The React Compiler is enabled — it was silently dead.** `@vitejs/plugin-react` v6
  removed the `babel` option, so the configured compiler plugin was ignored in dev, in
  production _and_ in tests. Both `vite.config.ts` and `vitest.config.ts` now share one
  plugin array, and the Vite configs are typechecked — which is how the dead option was
  found (`'babel' does not exist in type 'Options'`).
- **The typecheck gate covers test files and the IPC mock.** They were excluded, which
  hid real drift. The full `tsconfig.json` now typechecks clean, and the test IPC mock is
  annotated `satisfies AegisApi` so contract drift is a compile error.
- **`sync-server` is gated by CI** (fmt, clippy `-D warnings`, test, audit). It is the
  only internet-facing service and previously had none.
- **The supply-chain audit is no longer red.** It was failing on `main` with three
  high-severity advisories. Fixed with pinned `overrides` rather than by silencing the
  check, and the audit gate itself no longer reports success when `npm audit` could not
  run at all.
- All nine JNI exports, the picker, the settings validator, the proxy validators, the
  vault-sync merge, and the store lock are covered by tests. The suite grew from 330 to
  357 Rust tests and 1115 to 1135 renderer tests.

### Documentation

- README rewritten: it previously contained only release-build instructions, with no
  description of the project, its features, or its verification status.
- Documented honestly: macOS has no proxy tier, autofill is not implemented, the
  redirect guard has no macOS hook, and **no automated gate exercises the real Rust core
  or a real webview** — the suite runs against an IPC mock.
- The documented pre-push "live autopilot" gate did not exist. The docs now describe
  what actually runs.

### Licensing

- Aegis is now licensed under the **GNU Affero General Public License v3.0**. See
  [LICENSE](./LICENSE). Section 13 matters if you run a modified Aegis as a network
  service.

[Unreleased]: https://github.com/aegis-browser/aegis/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aegis-browser/aegis/releases/tag/v0.1.0
