# Changelog

All notable changes to Aegis are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **"Update all" in Filter Lists could wedge for the rest of the session.** The button
  disabled itself and re-enabled only in `finally`, but the refresh result arrives as a
  single `lists.updateResult` event emitted as the **last statement of a detached core
  thread** — after the ad-block engine reinstall. A panic anywhere before that emit kills
  the thread silently (the caller had already been given `Ok(Null)`), and the renderer then
  waited on an event that could never arrive: no results, no message, no way to retry.
  `awaitUpdateResult` now settles on whichever comes first — the event, a failure of the
  kick-off call, or a 60 s bound that exists to catch a pass which will never report rather
  than to police a slow one. It releases the one-shot listener on every path and ignores a
  late result, and the tab now reports the failure instead of silently recovering.
- **A refused save looked exactly like a dead button.** `settings.set` and the
  custom-filter save are validated in Rust (~20 rejection messages), and `HomeTab`,
  `MyFiltersTab` and `SearchTab` each swallowed the rejection: no "Saved" (correct) but
  also no error, with the rejection escaping a floating async IIFE as an **unhandled
  promise rejection**. All three now surface the core's own reason, which is written for a
  human. `SearchTab` additionally clears its draft only once the write is **accepted** —
  it used to wipe the name and template on dispatch, so a refused engine destroyed the
  user's typing and the panel gave no hint why.
  The shared `saveErrorText` helper reads the **string** case first, because
  `tauriInvoke.call` is a bare `invoke` and a Rust `Err(String)` rejects with that string
  rather than an `Error` — the usual `instanceof Error` check would have discarded the
  reason for every real refusal.
- **A shell effect re-registered four window listeners on every render.** `openSettings`
  was a plain function and the sole dependency of the effect that registers the
  `aegis:toggleSidebar` / `aegis:toggleFavoritesBar` / `aegis:openSidebar` /
  `aegis:openSettings` CustomEvents, so its identity changed every render and the effect
  tore down and re-added all four listeners every time — and `App` re-renders on every nav
  state, tab state, zoom, ad-block count and settings change. It is `useCallback`-wrapped
  now, so the effect mounts once.
- **A production `console.log` on every launch.** The mount measurement printed
  `[aegis-perf] React mount: …ms` to the console in a shipped build. The
  `performance.mark`/`measure` stay — a named entry in the browser's own performance
  timeline is real instrumentation and costs nothing — but nothing prints it.
- **Removed a dead test-only escape hatch.** `useFingerprint`'s `_setState` had zero
  callers once the dev-only seeding seams it served were removed.

- **Seven hooks seeded themselves from the core BEFORE registering their live
  subscription**, so a state event emitted in that window was lost with nothing to
  refetch it. `aegis.X.onY(cb)` reaches the core through an async `listen()`, but the
  backend listener only exists once the `listen` IPC is _processed_, and both requests
  ride the same transport — so the seven dispatched the seed first and had a real,
  non-zero window in which an event was dropped. Each had a concrete user-visible
  loss: `useNav` left the address bar on the page the user had just left; `useSafety`
  could lose a malware interstitial entirely, so no warning page was ever shown;
  `useUpdate` never learned a download had finished, so the update prompt and its
  restart button could not appear; `useVault` lost a completing unlock, leaving the
  Passwords panel "locked" with no way in; `useCustomFilters` kept showing the
  pre-pick text in an already-open My Filters panel; `useSubscriptions` and
  `useHistory` dropped a subscription change and a recorded visit respectively. All
  seven now register the subscription first, with a `// BUG(F2):` note naming the
  loss next to the ordering.
  `useCustomFilters` was the subtle one: it subscribes to the _local synchronous_
  `syncBus`, where position is irrelevant, **and** to `aegis.picker.onPicked`, a real
  async `listen()` that was registered after the seed — so the rule is per
  subscription, not per hook.
- **The regression guard's hook list is now derived instead of hand-maintained.** It
  scans `hooks/` for files that read a seed and register an async `aegis.*.on*`
  subscription, and fails if any of them has no case — so a new seeding hook cannot
  join this class silently. The scan strips comments first (otherwise a hook's own
  explanatory note reads as a misplaced seed) and is used only as a completeness
  trigger; the ordering assertion itself is behavioural, driving a real mid-flight
  event through a transport that registers listeners at process time. Each case also
  asserts uniformly that the hook's _first_ request on mount is the subscription,
  which needs no per-hook observable. Proven non-vacuous: an added throwaway
  `useVacProbe.ts` with no case turns the guard red and it names the file.

- **A blocked-redirect loop could drive unbounded background tabs and quadratic
  `tabs.json` writes.** Every blocked redirect opened its destination natively, with no
  rate limit and no dedup, and each open re-serialised the entire tab registry with an
  fsync — so a page bouncing through the guard N times cost N tabs and N full writes,
  on a path the page itself drives. The origin tab and source URL were already being
  passed in and ignored. The policy now lives in a managed `RedirectBudget` with **two**
  independent refusals, because key dedup alone bounds nothing: a hard cap of 3 live
  redirect tabs (a count is the sound bound, since each holds its slot for at most the
  30 s auto-close, and a loop whose destinations all differ would slip past dedup
  alone), and a 120 s per-`(from, to)` dedup window deliberately **longer** than that
  auto-close, so a _slow_ loop is still refused on its second pass.

- **The server's cross-uuid HLC tie-break depended on `HashMap` iteration order**, so
  the same push body produced different `ord` stamps on different server processes and
  across restarts — two servers replaying one batch handed clients different orderings
  for identical content. The records are now sorted by `(wall, counter, node, uuid)`
  before the tie-break runs. The old `MAX_HLC_TIE_BREAKS` cap is gone: past it the
  ordering stopped being _total_, which is the one property the loop exists to provide,
  and a request may carry up to 1,000 records.

- **Tombstone retention was a count with no age bound.** A single bulk delete — "clear
  all history", or the vault bulk delete, which the push path's own comment calls
  "hundreds of tombstones in one request" — writes more than the 500-per-namespace
  window in one go, and the surplus was evicted **while it was seconds old**. Any device
  that was offline during the delete had therefore never been told, and resurrected the
  rows the user had just deleted on its next sync. Retention is now
  `max(newest-500, younger-than-90-days)`, the age floor chosen against the client's own
  30-day tombstone GC so the server outlives it and can still answer a device that has
  been away longer than the client-side window.

- **A pull in which no record could be decrypted was reported as a successful pull.**
  `open_wire` failures are per-record and non-fatal by design, but a namespace where
  _every_ served record failed returned an empty success — indistinguishable from
  "nothing changed" — so the namespace was marked synced and its dirty flag cleared.
  That is destructive rather than cosmetic, because the client pushes after the merge:
  it would go on to seal the local records up under the key it believed was right. A
  total failure is now an error, taken before the merge, and the message says the likely
  cause is a data-key mismatch (a re-key, a restored backup, or an account restored on a
  second device before its key arrived). A namespace that served **no** records is still
  a success, and a partial failure is still tolerated.

- **A `429` from the sync server was retried as fast as `syncIntervalSec` allowed, with
  no backoff of any kind** — as often as every second, against a server whose per-device
  nonce cap keeps refusing for up to the 5-minute token TTL. That is up to ~300 signed
  round trips, each an Ed25519 verification, to be told "wait", and the user saw a bare
  `HTTP 429` with no hint that waiting was the fix. The refusal is now tagged
  specifically, the backoff doubles from 30 s and is capped at the TTL (the server's
  limit is a sliding window, so a constant short delay keeps knocking inside a window
  that has not opened and a constant long one stalls sync after it would accept again),
  and a successful pass resets it. Disabling periodic sync still disables it.

- **A read request reaped tombstones from every namespace, not just the one it served.**
  `post_records` already reaps everything on every push, so reaping other namespaces from
  a pull was pure waste under the global store lock. A pull now scopes its reap to its
  own namespace. (The underlying scan of the store is still whole-store — bounding that
  needs a namespace index, which is a structural change not smuggled in beside a bug fix.)

- **A remote peer could walk the HLC counter off the end of `u32` and rewind this
  device's clock.** The increment sites did `local.1.max(remote.1) + 1` with no
  overflow check, and a peer only had to stamp `counter: 4294967295` on a wall inside
  the accepted 60 s skew window to reach it. In a release build the overflow **wraps**,
  so the clock went from `(now, u32::MAX)` to `(now, 0)` — backwards. Every later local
  edit then carried a stamp that lost last-writer-wins to the attacker's record, was
  silently reverted by the next merge, and could never be won back: the affected records
  became un-overwritable on every device, with no error anywhere. The counter now
  **carries into the wall** at its ceiling (one shared `bump`, used at all four sites).
  `saturating_add(1)` is the obvious one-liner and is wrong here: it makes the clock stop
  advancing, so every edit made while parked at the ceiling gets an identical stamp and
  the user's own records tie with the winner decided by map iteration order.

  The server now also **rejects** a pushed `counter` wider than `u32::MAX` instead of
  storing it. `hlc_key` reads the counter as `u64` so it can order anything, but the
  client's counter is a `u32` and `from_value` deserializes with serde, which _errors_
  on an out-of-range integer rather than truncating — so such a record was unopenable by
  every client and unrecoverable, since the counter lives inside the AEAD-bound `hlc` and
  the per-uuid LWW gate let the poison outrank any legitimate rewrite. One push would
  have bricked one uuid on every device, permanently.

- **The HLC clock restarted at zero on every launch, so a local edit could lose to a
  record that was already on disk.** `CLOCK` is initialised to `(0, 0)` and nothing
  persisted it, so the first stamp after a restart is `(now_ms, 0)` — correct only while
  `now_ms` exceeds every stamp the device holds, and it usually does not: a peer inside
  the accepted 60 s window can push this device's clock 60 s into the future and the
  records it observes on disk inherit that wall, and the user's own clock can jump ahead
  (NTP correction, a VM resuming from a suspended host). The next local edit was then
  stamped below the record it was trying to update, lost LWW, and was silently reverted
  by the following merge — and because the losing stamp is itself persisted, nothing the
  user did afterwards could win it back. The clock is now seeded from disk at boot,
  taking a **max** so it can only ever move forward.

- **The server could poison every pulled record's HLC through a field it authors rather
  than relays.** `hlc` is AEAD-bound, so the server must not rewrite it — when it breaks
  a cross-record HLC tie it records the bump in a separate `ord` field. But `ord` is
  therefore the one wire field the client cannot authenticate, and it was adopted as the
  record's HLC with no validation at all. With `syncAllowInsecure` on, a plain on-path
  attacker could set `ord.wall_ms = i64::MAX` and every pulled record would land beyond
  the reach of any real clock, after which the user could never again change a favorite
  or a history row on any device. Adoption now requires the value to deserialize as an
  `Hlc` and to sit inside the skew window; a refused value falls back to the
  AEAD-authenticated wire `hlc`, so the only cost is a lost tie-break.

- **A namespace larger than 5,000 records could never be pulled again.** `get_records`
  returned `413` the moment a namespace reached `MAX_RESPONSE_RECORDS`, but
  `MAX_RECORDS_PER_ACCOUNT` is 50,000 — so a namespace could legitimately grow past the
  response cap and then become **permanently unpullable** by any client, with nothing but
  an `HTTP 413` in the sync panel to show for it. The response is now paged
  (`?limit=&cursor=`, returning a `next` cursor), sorted by `uuid` so the cursor is
  meaningful against a `HashMap`-backed store, and the client follows it. The response is
  additive, so an older client that ignores `next` still gets a valid page and stops.

- **A concurrent pair of server persists could drop the last mutation from disk
  permanently.** The snapshot was taken under the store lock and the write happened under
  a _separate_ writer lock, so two persists could interleave as _A snapshots → B fully
  persists → A writes_, leaving the file holding the older snapshot. The file is the only
  thing that survives a restart, so if the lost mutation was the last one it was gone for
  good — the old comment's "the next persist re-writes current state" only holds if
  another mutation ever arrives, which is exactly what a quiet server does not do. The
  writer lock is now taken **before** the snapshot. Reads and other mutations are still
  never blocked by disk I/O.

- **A flaky test in the ad-block engine's own suite.** The first `should_block` call in a
  process pays the one-time ~20 MB EasyList parse on the engine thread, and that cost
  lands inside the caller's timeout, which fails **open** on expiry. Alphabetical test
  order made the engine's own blocking test the one that paid it, so adding tests
  anywhere else in the suite could tip it over: 1 failure in 20 full-suite runs, always on
  the same assertion, never in isolation. The test now warms the engine with a throwaway
  query before asserting. (0 failures in 25 runs afterwards.)

- **Anti-fingerprinting silently turned itself off on Android after a restart.** The
  `NativeFarble` document-start getter runs on a JNI thread with no `AppHandle`, so it
  reads the farble level from an `ANDROID_LEVEL` process-global that Rust pushes. That
  push happened on `settings.set` and on a synced-settings change — but never at boot, so
  the global kept its empty default, which the getter reports as `"off"`. The result was
  that farbling worked until the app was restarted and then did nothing for the rest of
  the session, even though the setting still read "strict" in the Security tab and was
  still on disk. `farble::seed_from_disk` — the boot hook that already mirrored the
  fp-allowlist — now also pushes the level, through the clamped reader so it cannot
  disagree with the synced path.

  Two `#[cfg(target_os = "android")]` unit tests in `farble.rs` (the `note_level` /
  `android_level` and `note_fp_allowlist` / `android_host_allowlisted` round-trips) had
  therefore never executed: CI builds and tests on Linux, where they were compiled out.
  They — and the new boot-seeding test — now run everywhere, via
  `#[cfg(any(target_os = "android", test))]` on the globals. The two revived tests also
  take `test_support::lock()` now, since they write process-global state.

- **The ad-block on/off toggle did nothing on the injected-JS tier.** The engine tier
  read the toggle and Linux's declarative filters were reinstalled/removed with it, but
  the document-start injection consulted only the allowlist — so switching ad-blocking
  off left the `fetch`/`XHR`/`sendBeacon` blocker, the cosmetic element-hiding CSS and
  the `window.open` pop-under stub live in every tab spawned afterwards. On Windows and
  macOS that injection is the _primary_ ad-block mechanism, so the toolbar toggle simply
  did nothing there: ads still did not load and pop-unders were still blocked with
  ad-blocking switched off. On Android it left the two tiers disagreeing with each other,
  since the network interceptor honoured the toggle while the script did not.
  The ad-block layer is now gated on the toggle as well as the allowlist — the two
  independent ways to say "show me this site's ads". The pop-under guard travels with the
  heavy body on purpose: it is the ad pop-under defence and there is no second control
  that would otherwise release it, so a user who turns ad-blocking off gets their
  pop-unders back. Android's document-start script is cached in Kotlin for the process
  lifetime, so the cache is now keyed on the toggle as well as the host (a host-only key
  would have masked a mid-session toggle change for the rest of the process); the toggle
  is read from native rather than a local field, so the cache cannot drift from what the
  interceptor believes.
- **The ad-block allowlist was accepted by the UI and then ignored by every tier that
  actually blocks something.** "Allowlist this site" — which also doubles as the per-site
  WebRTC escape hatch, i.e. "I trust this site" — filtered the site anyway on all four
  platforms, in three different ways. The injected-JS tier already _received_ the
  allowlist flag and used it only for the WebRTC shim, so an allowlisted page still had its
  beacons rejected, its ad slots hidden and its cross-origin `window.open` stubbed. The
  WebView2 tier passed an empty source page, which made the engine's per-page veto
  unreachable and made every request look first-party (so the privacy lists'
  `$third-party` rules never fired either). The declarative WebKit filters — the _only_
  tier that blocks a page's subresources on Linux — had nowhere to ask, so the allowlist
  was recorded in state and never applied to the filters, and toggling it did nothing at
  all there.
  Each tier now honours it by the mechanism it actually has: the engine vetoes per
  request; the WebKit filters carry `ignore-previous-rules` exceptions scoped by
  `if-domain`, compiled in and rebuilt on change; the injected JS omits the whole
  ad-block layer. Two consequences worth stating plainly: the engine's veto was an
  **exact** host match, so an allowlisted `example.com` never covered `www.example.com`
  even in principle (the UI said it did) — the scope test is now one shared, documented
  function; and the WebKit exception must be repeated in _every_ chunk, because
  `ignore-previous-rules` reaches only rules in the same content filter and each chunk is
  its own. A malformed allowlist host (the store is syncable, so it is remotely writable)
  is now dropped rather than handed to WebKit, which would discard the whole filter and
  turn ad-blocking off everywhere.
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
  - **The Rust coverage baseline is a FLOOR, measured with no OS keyring.** The three
    keychain round-trips in `sync_keystore.rs` share one keyring, so their covered-line
    footprint depends on credential state left by earlier runs — measured at 286, 289 and
    300 covered lines across three runs of the same tree, and 228 with no keyring at all.
    CI's `cargo llvm-cov` has never had a usable keyring (two runs, both exactly
    11038/14750). The committed number is therefore the _least-capable_ measurement, so
    every environment satisfies it: a machine with a keyring covers strictly more and
    passes, CI without one lands on the floor. A threshold that is not reproducible in every
    environment is not a threshold. The `cargo test` step still provisions a keyring (so
    those three tests run rather than skip — test quality, not the gate); the coverage step
    deliberately does not, and the Rust ratchet now prints per-file covered-line deltas on
    failure so "code stopped executing" is distinguishable from "code was deleted".
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
