# Changelog

All notable changes to Aegis are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Browsing history was never recorded on Android, so the mobile History sheet was
  permanently blank.** `history::record` had exactly one non-test caller: the
  `on_page_load` closure inside `nav::spawn_tab`. That is a **wry** callback, and
  Android's content area is a **native Kotlin `WebView`** (`MainActivity.createTabWebView`),
  so wry never observes a content load and nothing ever called `record` there. The mobile UI
  was fine — it was a dead store, not a dead panel. Kotlin now reports each
  `onPageFinished` through a new `NativeHistory.recordVisit` JNI export into
  `history::record_page_finished`, which resolves the tab's privateness from the registry
  itself (Kotlin passes a bare tab id and is never trusted with a privateness flag). This
  is the first `AppHandle`-backed native entry point, hence `ANDROID_APP` + `set_android_app`.
  Android also has a real `WebView.title` at page-finished, so **Android history now has
  titles while Windows/macOS do not** (they record `""`; only Linux has a title-changed
  signal). Device-verified on a Galaxy S22; the JNI seam itself still has no automated
  coverage — see gotcha 24 in `src-tauri/AGENTS.md`.

Nothing yet.

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
