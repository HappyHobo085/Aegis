# src/ — React renderer (the browser "chrome")

The React 19 + TypeScript UI that Tauri renders in the **chrome webview**: toolbar,
address bar, favorites bar, right-side sidebar, settings, modals, overlays. Built by
Vite into `../dist`, which Tauri serves. This folder reaches the Rust core through
exactly one module — see `lib/ipcClient.ts`.

## Layout

```
src/
├── index.html        # <div id="root">; loads main.tsx; viewport-fit=cover (mobile notches)
├── main.tsx          # mounts <App/> inside <ErrorBoundary> + StrictMode; imports index.css
├── App.tsx           # root shell: orchestrates chrome, overlays, sidebar, fullscreen z-order
├── index.css         # global theme (dark default + light palette via `[data-theme]`, selected by `lib/theme.ts`) + chrome layout (desktop chrome + .aegis-mobile shell)
├── components/       # presentational components + Settings tabs (+ co-located *.test.tsx)
├── hooks/            # one hook per feature domain (useNav, useAdblock, …) (+ tests)
└── lib/              # IPC client, address parsing, theme, toast, layout consts (+ tests)
```

## The backend boundary (read this first)

- **`lib/ipcClient.ts`** exposes the `aegis` object (typed by `AegisApi` in
  `shared/types.ts`) — every feature the UI can call. Each method is a Tauri
  `invoke('ipc', {channel, payload})`; each `onX(cb)` subscribes to an event.
- **`lib/tauriInvoke.ts`** is the low-level transport: `call(channel, payload)` and
  `on(event, cb)`. `on()` translates the event name `.` → `:` because **Tauri 2
  forbids `.` in event names** (the Rust side emits with `:`). Don't bypass this.
- **Android path:** when `window.AegisAndroid` is present (native Kotlin bridge,
  no Tauri), `ipcClient` routes nav, content-visibility, find, zoom,
  update-restart and **`permissions.resolve`** to the bridge
  instead of `invoke`, and sets the `.aegis-mobile` class. `permissions.resolve`
  is the one that is not a reimplementation of a core arm: the JNI gateway is
  Kotlin→Rust only, so the verdict cannot come back through a channel at all — the
  request object is a WebView `PermissionRequest` that only Kotlin holds, while the
  remembered store stays in Rust. On mobile `App` renders
  **`MobileApp`** (a dedicated touch shell) instead of the desktop chrome — see the
  Mobile shell section below.
  **A bridge branch is a REIMPLEMENTATION, not a shortcut.** Android has no Tauri
  content webview, so any core arm that drives one is unreachable there — the
  renderer has to reproduce it. `nav.home` is the worked example: the core arm reads
  `settings::home_url` and then `require_navigable`, but on Android the bridge got a
  hardcoded `about:blank`, so a home page shown in `HomeTab` (and synced to the
  device) was never used. `ipcClient` now caches the last full `Settings` object it
  saw (`remember`, hung on `settings.get` AND `settings.set` — both return the whole
  object) and `homeTarget()` re-applies both gates: non-empty, parseable, and
  `http:`/`https:` only. **If you add a bridge branch, re-derive what the core arm
  does and check each of its gates individually** — a single hardcoded literal is
  exactly the shape of bug this bit.

Channel and event names, and all payload/return types, are defined once in
`shared/types.ts` (`IPC` const + interfaces). Treat it as the contract.

## Conventions & gotchas (verified in code)

- **Chrome overlay z-order (centralized compositor).** The content webview is opaque
  and on top, so full-window chrome must lower it. The decision is single-sourced:
  every content-hiding surface calls `useChromeSurface('<id>', active)`
  (`src/hooks/useChromeSurfaces.tsx`) to register itself while open; `App.tsx` derives
  `fullOverlayActive` from the registry and computes the content layout via
  `computeContentLayout` (`src/lib/contentLayout.ts`), mirrored on the Rust side by
  `view::content_visible`. **To add a new full-window overlay, call `useChromeSurface`
  in its component — there is no central union to update.** The sidebar is not a
  registry surface either — it insets from the right via `view.setLayout` and stays
  direct `App` state.
  A new overlay must call `useChromeSurface`, and a test should assert it lowers the
  content (that is what `useChromeSurface` + the `contentLayout` contract mean).
  `useChromeSurface` is a **silent no-op** outside a `ChromeSurfaceProvider`, so a
  surface can register and still leave the content view up; by contrast
  `useChromeSurfaceRegistry` throws outside a provider. **Both shells now mount the
  provider** (`App.tsx` wraps the desktop tree; `MobileApp` wraps `MobileShell`), so
  a surface that renders in either shell lowers the content in both. The mobile shell
  reads `useChromeSurfaceCount()` rather than composing its own `||` union, because a
  hand-maintained union is what let first-run onboarding render unseen and untappable
  on Android: on mobile the content is a NATIVE view stacked ON TOP of the chrome
  webview, so a registered surface that does not lower it is not merely clipped but
  covered. If you add a shell, mount the provider — a test that asserts a surface
  lowers the content is what catches its absence.
- **Sidebar is a right panel,** not an overlay: the one layout effect
  (`App.tsx`) folds sidebar+overlay into a single `view.setLayout({ overlay, sidebar,
width })` so the page insets from the right and stays visible. There is no
  sidebar-only channel — a partial update beside the overlay one reopens the
  two-layout-pass race `setLayout` exists to close. Width is remembered in
  localStorage.
- **Content inset** is the sum of the chrome's real heights: `hooks/useChromeHeights.ts`
  measures the chrome elements with `getBoundingClientRect` (falling back to the
  constants in `lib/layout.ts` before the first measurement) and
  `hooks/useContentInset.ts` forwards the resulting `topInset` to
  `view.setContentInset`. It is **not** purely deterministic — a chrome element that
  appears after mount changes the inset.
- **Chrome popovers (dropdowns/dialogs anchored below the chrome) are the OTHER half of
  the compositor** and must never use `useChromeSurface`. A popover has to leave the page
  visible, so it can't set `overlay: true` (Rust's `view::content_visible` would hide the
  webview and blank the window). Instead the popover **measures itself** and the tallest
  open popover's height is added to the content top inset — same `view.setContentInset`
  path the FindBar uses. To add one, call **both** hooks in the component:
  - `useMeasuredHeight<HTMLDivElement>(open)` (`hooks/useMeasuredHeight.ts`) → `[ref,
height]`. One measure on open, then a `ResizeObserver`; sets 0 the moment `open` goes
    false. An observer is safe here (unlike `useChromeHeights`, which avoids them) because
    the chrome webview fills the window and is never resized by the content inset.
  - `useChromePopoverInset('<id>', height)` (`hooks/useChromePopover.tsx`) → registers
    while open, unregisters on unmount. `App.tsx` reads `inset` = **max, not sum**, from
    the registry. `useChromePopoverInset` is a no-op outside `ChromePopoverProvider` (the
    mobile shell has no provider and hides content via `view.setChromeOverlay` instead);
    `useChromePopoverRegistry` throws outside one.
  - Because the inset follows the measured box, a popover's CSS `max-height` must be a
    **fixed px value, never `vh`** — a viewport-relative height would feed back into the
    layout on every measure.
  - Popover anchors need `position: relative` (`.address-bar__field` already is) and
    `z-index: 5100`, matching `.site-identity`.
  - `useDialog` returns a **stable** ref object, so a popover that must be observed has to
    merge the two refs in a `useCallback` (stable identity) — an inline merge function
    detaches and re-attaches the node every render and the observer would never fire.
- **One hook per domain** in `hooks/` (nav, adblock, history, saved, favorites,
  settings, subscriptions, customFilters, downloads, permissions, update, safety,
  **tabs**, **find**, **fingerprint**, **proxy**). Components stay presentational; state + IPC wiring
  lives in the hook.
- **`hooks/useTabs`** — owns `TabsState` (the ordered tab list), the active tab
  id, and per-tab nav-state + page titles. All chrome features (nav bar, adblock
  shield, overlays, inset sidebar) key on the active tab id.
- **Subscribe BEFORE you seed (`hooks/subscribeBeforeFetch.test.tsx` is the guard).** Every
  hook that seeds itself from a `getState`/`get`/`list` call AND subscribes to a live event
  must register the subscription **first**. `aegis.X.onY(cb)` reaches the core through an
  async `listen()`, but the backend listener only exists once the `listen` IPC is
  _processed_ — and both requests ride the same transport, so seeding first meant any event
  emitted in that window was lost with nothing to refetch it. It does **not** apply to a hook
  that subscribes only through the local `syncBus` (`onSyncChange` is a synchronous
  in-renderer pub/sub, so there is no window): `useSaved`, `useSettings`, `useFingerprint`,
  and `useAdblock`'s allowlist channel. **A hook can be in both camps** — `useCustomFilters`
  subscribes to the syncBus (position irrelevant) _and_ to `aegis.picker.onPicked`, which is
  a real async `listen()` and must be registered first. Judge each subscription, not each
  hook.
  **The list is DERIVED, not hand-maintained.** The guard scans `hooks/use[A-Z]*.ts` for
  files that read a seed (`aegis.*.getState|get|list`) _and_ register an async
  `aegis.*.on*` subscription, and fails if any of them has no case in its own table — so a
  new seeding hook cannot join the class silently. Two details make that scan sound: it
  **strips comments first** (otherwise `useDownloads`' own `// BUG(F2): subscribe BEFORE…`
  note reads as a seed preceding a correctly-ordered subscribe, and the guard
  false-positives), and the scan is a **superset trigger only** — the ordering assertion is
  behavioural, never textual. The second, uniform assertion per case
  (`` `useFoo — its first request on mount is a subscribe, not a fetch` ``) needs no
  per-hook observable, so it also covers hooks whose seed feeds a shape the file never reads.
  To prove the completeness guard is not vacuous, add a throwaway
  `hooks/useVacProbe.ts` that seeds and subscribes with no case: the guard must go red and
  **name** it. The regression test models the transport honestly (ordered dispatch, listener
  registered at process time, the transition emitted between the two) because
  `vitest.setup.ts` mocks `listen` as an already-resolved promise — a zero-width window that
  hides the whole class of bug.
- **`hooks/useChromeHeights`** — measures the chrome bands and derives `topInset`, which
  `App` reports to `view.setContentInset`. The measuring `useLayoutEffect` has **no
  dependency array**: it runs after every commit and bails unless the measured elements'
  _presence signature_ changed. It must stay that way. It used to be keyed on
  `[containerRef]`, which is a `useRef` created once in `App` and never reassigned — so the
  effect ran exactly once for the life of the app and the signature check was dead code. A
  single "Toggle favorites bar" then left a permanent 36 px gap above the content. The
  FindBar is measured here too, so `App` must NOT add `FIND_BAR_H` on top of `topInset`
  (that is how it got there in the first place, and it would now double-count to 80 px).
  The pre-measure `INITIAL.topInset` uses the same terms as the measured value, so the very
  first `setContentInset` is not off by the FindBar. The existing tests pass a FRESH
  `{ current: el }` object per render, which makes the dep unstable and masks the bug —
  `renderWithStableRef` is the shape that actually proves it (`App.tsx` uses a real `useRef`).
- **`components/SyncSettingsTab`** — the "Sync" tab. Two views (setup vs. running) plus a
  shared **`TransportSection`** rendered in _both_, so the unencrypted-HTTP waiver is
  reachable both before setup and while running (the running view is the only place it can
  be revoked). Local helpers `isInsecureRemoteUrl(url)` / `transportLabel(url)` classify the
  configured server — `URL` parsing, NOT string splitting, so `http://localhost.evil.com`
  is correctly treated as remote exactly as the Rust validator treats it. The panel is
  **props-driven** like the `syncVault` opt-in (`checked={…}` + `update({…})`), and prefers
  the CORE's `state.allowInsecure` over the local settings value so it reports the decision
  actually in force. **The recovery phrase is the one reveal that must be asked for:**
  `enableNew` returns the 24 words to the panel, which shows them with an "I've saved it"
  acknowledgement, and the running view's "Show recovery phrase" runs a `confirm()` before
  calling `useSync.getRecoveryPhrase(true)`. The hook used to hardcode `{ confirm: true }`,
  which turned the core's "gated on an explicit confirm" contract into a bypass; the flag now
  has to be the user's own answer, and the hook throws if it is not.
  Coverage: the `settings:sync` screen plus the
  `settings.sync.allowInsecure` interaction spec (vitest asserts the `settings.set` wiring;
  live asserts `sync.getState().allowInsecure` flips and restores it) and the
  `syncAllowInsecure` cases in `SyncSettingsTab.test.tsx`, which render the panel under a
  **stateful parent** because the vitest `aegis` mock does not feed `settings.set` back into
  React state.
- **`hooks/useVault`** — owns vault UI state (`VaultState`) and exposes the typed vault
  API to `VaultSettingsTab`. **Security note:** decrypted records are NEVER held in React
  state — `list`, `add`, `update`, `remove`, and `search` each call the IPC directly and
  return the list without storing it in the hook, so plaintext credentials are not resident
  in the React tree between operations. The hook only persists `VaultState` (the safe
  `{exists, unlocked, count, undecryptable}` summary — `undecryptable > 0` drives a warning
  banner in `VaultSettingsTab` for records preserved-but-not-decryptable) and the
  `_setRecordsRef` escape hatch used by `VaultSettingsTab` to sync its local records display
  with the optimistic-update flow.
- **`hooks/useFingerprint`** — owns anti-fingerprinting state (`FingerprintState`:
  `{ level, allowlistedHosts }`). Seeds from `aegis.fingerprint.getState()` on mount;
  exposes `setLevel(level)` (calls `settings.set` to persist and re-calls `getState`),
  `toggleHost(host)` (calls `fingerprint.toggleAllowlist`), and `clearAllowlist()`.
  Consumed exclusively by `SecuritySettingsTab` (the "Security" tab in Settings).
  The hook never holds raw credentials or sensitive data — only the string level and
  the host allowlist. Re-reads state after every mutation so the UI reflects the Rust
  source of truth. The fp-allowlist is honoured on Android too: `MainActivity` passes the
  tab's content host to `NativeFarble.farbleScript(host)` and the Rust getter checks it
  against the `ANDROID_FP_ALLOWLIST` process-global. (This doc previously described the
  Android side as a gap being addressed; the code had shipped it.) It has **no test-only
  state setter** — a `_setState` escape hatch outlived the dev-only seeding seams it
  served and had zero callers, so it is gone; drive state through the real IPC in tests.
- **A save the core REFUSES must say so (`lib/saveError.ts`).** `settings.set` and the
  custom-filter save go through `settings.rs::validate_setting`, which has ~20 rejection
  messages ("searchEngines may hold at most 32 entries", `homeUrl must be http(s), got "file"`).
  A component that `await`s one of those and then does nothing leaves the user
  staring at a button that appears dead — and, worse, the rejection escaping a floating
  `void (async () => …)()` becomes an **unhandled promise rejection** nobody sees. So
  `HomeTab`, `MyFiltersTab` and `SearchTab` each catch and surface it, and a form clears
  its draft only once the write is **accepted** (wiping on dispatch destroys typing the
  core rejected). `SearchTab` shows the reason in its existing inline `role="alert"`
  region because the draft is right there; the other two use `toast.error`.
  **`saveErrorText` reads the STRING case first, on purpose:** `lib/tauriInvoke.call` is a
  bare `invoke` and a Rust `Err(String)` rejects with that string, not an `Error` — so the
  usual `err instanceof Error ? err.message : …` is false for every real refusal and
  would silently discard the core's reason. A draft is never cleared by a refusal.
- **A resolved `{ ok: false }` is a REFUSAL, not a success (`DataTab`).** `data.export`
  has no save dialog — the core picks the path and writes the bundle itself, so a
  failure is a failed WRITE (no space, no permission, a missing directory) and it
  arrives as a **resolved** `{ ok: false, error }` rather than a rejection, which is
  why `handleImport`'s `catch` cannot catch it. `handleExport` had no `else` branch,
  so a failed export told the user nothing at all: no success either, and the user is
  left believing they hold a backup they do not have, to be discovered at restore
  time. The rule for this repo's `{ok}`-shaped replies: a caller must handle the
  negative arm, and its test must assert the message the user SEES — not merely that
  the success toast is absent. The old test (`does NOT toast success when export is
canceled`) passed because of the defect and named a "canceled" state the flow
  cannot reach.
- **A promise built from a ONE-SHOT event needs a second way to settle
  (`lib/updateResult.ts`).** `FilterListsTab`'s "Update all" disables itself and only
  re-enables in `.finally`, and the refresh result arrives as a single
  `lists.updateResult` event from a **detached core thread** whose last statement is the
  emit. A panic before that emit kills the thread, silently — the caller already got
  `Ok(Null)` — and the renderer then waits on an event that can never arrive, so the
  button stayed dead for the whole session. `awaitUpdateResult` therefore settles on
  whichever comes first: the event, a rejection of the kick-off call, or
  `UPDATE_RESULT_TIMEOUT_MS` (60 s — generous, because the bound is there to catch a pass
  that will NEVER report, not to police a slow one; the real pass is a concurrent fetch
  with a 25 s per-request timeout plus one engine reinstall). It releases the one-shot
  listener on **every** path and ignores a late result, so a refresh that finishes after
  the user gave up cannot re-settle the promise. The consumer needs a `.catch` for the
  same reason: `.finally` alone re-enables the button with no explanation.
  `onResult`/`kick` are injected so a test can supply a transport that never answers.
- **`hooks/useFind`** — owns find-in-page UI state for the active view. Subscribes to
  `aegis.find.onState` (filtering by `viewId`), debounces `find.start` calls ~120 ms,
  issues `find.close` on tab switch so highlights don't linger on background tabs.
  Returns `{ open, state, show, setQuery, next, prev, close }` consumed by `FindBar`.
- **`hooks/useHistory`** — the renderer's history list is a **PAGE, not the store**:
  `aegis.history.list()` is called with no options, so the core returns the newest 200
  rows of up to 5000. Anything that must touch "all of it" therefore has to be a core
  call, not a loop over `entries`. `removeForOrigin(origin)` is the model: the padlock
  menu's "Clear remembered data" (in `AddressBar`, driven from `App.tsx` and
  `MobileApp.tsx`) deletes every row for one origin and returns how many it removed.
  The permissions half of that same menu is deliberately STILL a renderer loop
  (`permissions.list` is uncapped), so the two halves differ on purpose.
- **`hooks/useZoom`** — owns page-zoom state for the active view. Seeds from
  `aegis.zoom.get(activeId)` on mount and on every tab switch; subscribes to
  `aegis.zoom.onChanged` (filtered by `viewId`). `zoomIn`/`zoomOut` step along the
  Chrome-style discrete ladder (via `lib/zoom.ts`'s `stepZoom`), apply optimistically,
  then confirm via `aegis.zoom.set`. `reset` restores 100% via `aegis.zoom.reset`, which
  is a RENDERER-side wrapper that sends `zoom.set` with a factor of 1.0 — there is no
  `zoom.reset` IPC channel (see the `zoom.rs` bullet in `src-tauri/AGENTS.md`).
  Returns `{ factor, percent, zoomIn, zoomOut, reset, setFactor }`.
- **`components/VaultSettingsTab`** — the "Passwords" tab inside the Settings modal (Phase
  A — manage only, no autofill). Renders three views depending on `VaultState`: a create
  form (new vault), an unlock form (existing vault), and the credential list (unlocked).
  UI security properties enforced in the component:
  - All master-password inputs are `type="password"` with `autoComplete="new-password"` /
    `"current-password"`.
  - The new-entry password field is `type="password"`.
  - Record passwords are **masked by default** (`type="password"`) and revealed only on
    explicit per-row "Reveal" click; each row tracks its own reveal state in
    `revealedUuids` (a `Set<string>` in local state, cleared on lock).
  - "Copy" copies the plaintext to the clipboard without ever showing it. The 60 s
    clear-timer handle lives in a ref: a second Copy cancels the first (otherwise the first
    timer wipes the secret the UI just promised would survive 60 s) and the timer is cleared
    on unmount (otherwise closing Settings blanks whatever the user copied since).
  - "Delete" removes the record from the vault (confirm on the row).
  - Records are NOT stored in `useVault` state — `VaultSettingsTab` calls
    `vault.list()` on unlock and holds the list locally; the hook never persists plaintext.
    Registers as a compositor surface via `useChromeSurface` (it opens inside Settings, which
    is already a registered overlay, so the content webview is already lowered — no
    additional compositor registration needed for the tab itself).
- **Password-vault autofill has NO UI surface, and the copy must not pretend otherwise.** The
  chrome-side chain `AutofillBadge` → `useVaultDomainSuggestions` → `useVaultAutofill`, plus
  `useLoginFormDetector` (whose only job was an unconditional 2 s `form.detectLoginForm`
  poll behind that badge), was deleted as dead, unmounted code. `vault.autofill` and
  `vault.autofillSuggestions` remain declared in `shared/types.ts` and **do** work in Rust —
  they are covered by `vault.rs`'s own unit tests (dispatch + search + suggestions).
  **`form.detectLoginForm` is different: it is declared but the core REFUSES it** (`Err`, not
  `Ok`). A content webview has no Tauri capability and `withGlobalTauri` is off, so the page
  cannot `emit` a detection result back, and there is no injected content→core callback to
  replace it — so the old implementation could only ever burn a 5 s main-thread timeout and
  return `hasLoginForm: false`, a value indistinguishable from a real negative. It now fails
  fast and names the missing transport; see the `form.rs` module header for what a real fix
  needs. The mock rejects to match and a test asserts the refusal — do **not** "fix" that
  assertion back to `expect(typeof result.hasLoginForm).toBe('boolean')`, which is exactly
  what let the broken version pass. `VaultSettingsTab`'s notice therefore says Aegis
  does **not** fill login forms yet (honest-UI-copy convention, same rule as the Proxy tab
  never saying "VPN"). `useAutofillSave` is likewise unmounted; its `form.willSubmit` producer
  (`vault_inject.rs`) is real, so it is the natural starting point if the feature is ever
  finished rather than a stub to delete.
- **`components/SecuritySettingsTab`** — the "Security" tab inside the Settings modal.
  Includes the anti-fingerprinting section (rendered via `useFingerprint`):
  - A level selector (`off` / `standard` / `strict`) with explanatory copy. The UI copy
    never claims engine-level or Brave-parity farbling — it says "add noise" and notes the
    opt-in / detectable nature. `standard` is described as perturbing canvas/audio/navigator;
    `strict` adds WebGL. **The copy states the PER-TAB seed, not "each session":** the seed
    is baked in when a tab is created, so a level change only reaches tabs opened or
    reloaded afterwards and an already-open tab keeps the seed it was given. This is not
    optional polish — `src-tauri/AGENTS.md` gotcha 21(c) says "document it in any UI that
    toggles these settings", and the copy previously said the opposite, so a user changing
    the level mid-session would conclude the setting was broken. A test asserts the
    per-tab wording is present and that "regenerated each session" is GONE.
  - A per-site allowlist manager (desktop only, rendered when `level !== 'off'`): add the
    current browsing host, remove individual hosts, clear all. Allowlisted hosts receive no
    farble shim — the fp-allowlist is separate from the ad-block allowlist.
  - A **"Sites with WebRTC protection off"** list, rendered right after the WebRTC policy
    `<select>` and before the anti-fingerprinting section. It is a SEPARATE list from the
    fingerprint allowlist above and from the ad-block allowlist, and it is never synced.
    The Add button guards against re-adding an already-listed host: the core channel is a
    TOGGLE, so a second Add would silently REMOVE the entry.
  - Coverage: `useFingerprint.test.tsx` covers the getState seed, every mutator, and the
    unmount path; `SecurityTab.test.tsx` drives the level select and the allowlist
    toggle/clear controls through the real UI, plus five tests for the WebRTC exemption
    list (lists exactly the core's hosts and NOT the ad-block ones, sends the typed host,
    refuses an empty host, does not re-add a listed host, and removes exactly the host
    whose button was pressed). The four `webrtc.*` channels are additionally pinned in
    `src/lib/ipcClient.contract.test.ts` — every request channel must have a row there
    pinning its exact channel and payload, and `UNPINNED_REQUEST` is only for channels the
    renderer never emits.
  - **The HTTPS-Only checkbox is DESKTOP-ONLY — honest tiering, not a hidden gap.**
    `gen/android/app/build.gradle.kts` sets
    `manifestPlaceholders["usesCleartextTraffic"]="false"` for RELEASE (`"true"` only for
    debug), so a release APK cannot load `http://` at all: the setting cannot be turned OFF
    there, and a checkbox that cannot act is a control that lies. `MainActivity.secureUrl`'s
    upgrade still runs, so the feature is not lost — it is unconditional. Flipping the manifest
    instead would re-enable cleartext for EVERY request, third-party ads and trackers included,
    a real privacy regression on the platform that most needs the protection. On Android the row
    is replaced by ONE sentence saying so, rather than vanishing silently: a user who un-checks
    the box on another platform has no idea why nothing changes here, and it is a real privacy
    control they may be relying on. The gate is `.aegis-mobile` — the repo's ONE Android marker,
    written in one place (`ipcClient.ts`, from the UA at module load) and read by `App.tsx` to
    pick the mobile shell and by `useNarrowViewport`; a second platform test is how the crate
    once ended up with two scheme lists — and it is read at RENDER time for the same reason
    `App.tsx`'s `getIsMobile()` is a function. `SecurityTab.test.tsx` pins BOTH directions: the
    row is absent (and the sentence present) with the class set, and the pre-existing
    `reflects httpsOnly and toggles it via update` uses `getByRole`, which THROWS when the
    checkbox is missing, so the desktop side cannot pass vacuously. Each side is proven
    non-vacuous by neutralising the gate in the one direction that should redden it.
- **`hooks/useSync`** — owns sync UI state. **`quarantined` is deliberately NOT part of
  `state`.** `state` is the core's own `sync.getState` view, so folding a peer-supplied,
  renderer-observed fact into it would make the core's reply look like it is missing a field
  the type promises. It sits beside `state` as its own `SyncVaultQuarantined | null`, and it
  is **cleared by an empty payload** — a security warning dismissible only by restarting the
  app is a warning users learn to ignore. The `sync.vaultQuarantined` subscription lives
  inside the existing mount effect, so the subscribe-before-seed rule above holds for it, and
  its unsubscribe is called in that effect's cleanup like the other two. A test that renders
  this hook must have `onVaultQuarantined` return a **function**, not `undefined` — the hook
  calls it, so a bare `vi.fn()` throws in the cleanup and takes every other test in the file
  with it. `SyncSettingsTab` renders the report as its own `role="alert"`
  (`sync-tab__error`) rather than folding it into `state.lastError`, because a rejected
  write is a security outcome while the sync pass itself still SUCCEEDS — folding it in would
  make a successful pass look failed. Its text is pluralised by count and keeps the
  reassuring half ("Nothing was changed… your existing passwords are unaffected"), since a
  security warning that does not say the vault is intact reads as "my vault is broken".

- **`hooks/useWebrtcExempt`** — owns the per-site **WebRTC IP-leak** exemption list
  (`WebrtcExemptState`: `{ exemptHosts: string[] }`). Deliberately NOT a second slice of
  the ad-block allowlist: that list is synced, and reading a privacy control off it meant
  one record on any device holding the data key turned WebRTC protection off for a host
  everywhere. Seeds from `aegis.webrtc.getExemptHosts()` on mount; exposes
  `toggleExempt(host)` / `removeExempt(host)` / `clearExempt()`. Re-reads state after every
  mutation. It has **no `syncBus` subscription**, unlike `useFingerprint` — and that
  absence IS the feature: a peer merge cannot change it, because the store is never
  synced. Consequently the Wave 4 subscribe-before-seed rule is satisfied trivially (there
  is no async subscription to order before the seed). Consumed by
  `SecuritySettingsTab`. Mocked SEPARATELY from `fingerprint` in `aegisMock.ts` **and** in
  `MobileApp.test.tsx` (which hand-rolls its own partial `ipcClient` mock — extending
  `aegisMock.ts` does not reach it), because a test that let one stand in for the other is
  exactly how the two lists came to be conflated in the first place.
- **`hooks/useProxy`** — owns proxy UI state (`ProxyState`: `{ mode, scheme, host, port,
bypassHosts, active, uri }`). Seeds from `aegis.proxy.getState()` on mount; subscribes
  to `aegis.proxy.onState`. Exposes `setConfig(cfg)` (calls `proxy.setConfig` + re-reads
  state), `clear()` (calls `proxy.clear`), and `testConnection(cfg)` (TCP-reachability
  probe, returns `{ ok, latencyMs?, error? }`). Re-reads state after every mutation so the
  UI reflects the Rust source of truth. Consumed exclusively by `ProxySettingsTab`.
- **`components/ProxySettingsTab`** — the "Proxy" tab inside the Settings modal (sub-project
  M). Renders a mode select (`off` / `proxy`), and — only when `mode === 'proxy'` — the
  scheme select (HTTP / SOCKS5), host/port inputs, a bypass-hosts list manager, and three
  action buttons: **Apply** (`proxy.setConfig`), **Turn off** (`proxy.clear`), and **Test
  connection** (`proxy.testConnection` → shows latency or error). **Honest UI copy:**
  - The tab header and all labels say "Proxy" — never "VPN".
  - A note informs the user that the proxy covers browsed pages only (not the OS or other
    apps) and that DNS/QUIC may still leak outside the proxy path.
  - On Windows: a note warns that proxy changes apply only to new or reloaded tabs
    (spawn-time limitation — see `src-tauri/AGENTS.md` gotcha 23).
    Coverage: `useProxy.test.ts` covers the getState seed, the live `proxy.state`
    subscription, and every mutator; `ProxySettingsTab.test.tsx` drives the mode select,
    host/port inputs, bypass add/remove, and the Apply/Turn-off/Test buttons through the
    real UI. The set→assert→restore round-trip is **not** automated, because mutating a
    live proxy config from a stateless mock proves nothing — `proxy.rs`'s unit tests
    cover the config validation instead.
- **`components/FindBar`** — Ctrl+F infobar (purely presentational): text input,
  match-count display, prev/next nav buttons, and a close button. Auto-focuses on mount.
  Rendered inside `DesktopApp` (and `MobileApp`) keyed on the active view id; shown only
  when `findOpen` is true.
- **`components/ZoomIndicator`** — toolbar zoom widget. Shows the current zoom percent as
  a clickable label; clicking opens a popover (role=`dialog`) with Zoom-out / percent /
  Zoom-in / Reset buttons. Purely presentational; receives `{ factor, zoomIn, zoomOut,
reset, onOpenChange }` from `useZoom`. It **self-registers with the compositor** via
  `useMeasuredHeight` + `useChromePopoverInset('zoom-indicator', …)` (it takes an optional
  `popoverRef` for the measured node), so the content webview insets below it while open.
  `onOpenChange` is now only consumed by the **mobile** shell (`view.setChromeOverlay`);
  the desktop compositor no longer needs it. `components/AdblockShield` follows the
  identical self-registration pattern with the id `adblock-shield`.
  On Android the `MobileMenuSheet` exposes the same zoom controls via the bridge; there is
  no separate `ZoomIndicator` in the mobile shell.
- **Omnibox (address-bar suggestions).** `AddressBar` is a **combobox**: with an
  `omnibox={{ favorites, saved, searchTemplate }}` prop it renders `OmniboxDropdown`
  (`role="listbox"`) below the field, ranked by the pure `buildOmniboxSuggestions`
  (`lib/omnibox.ts`) over history + favorites + saved pages + an optional "Go to …" row +
  a trailing "Search for “…”" row. `hooks/useOmnibox.ts` owns the debounced (90 ms)
  history query (a monotonic seq ref drops stale `history.search`/`history.list`
  responses) and the `activeIndex`; `useNav` exposes `searchTemplate` for the search row.
  Keyboard: ↑/↓ move, Enter picks the active row (otherwise the form submits the raw
  text), Escape dismisses **keeping the text and focus**, blur dismisses and reverts the
  field to the live URL. Picking uses `onMouseDown` + `preventDefault` so the input never
  loses focus. `AddressBar` stays dumb about the compositor: it measures the dropdown with
  `useMeasuredHeight` and registers `useChromePopoverInset('address-omnibox')`. Both
  desktop (`Toolbar` → `App`) and mobile (`MobileTopBar` → `MobileApp`, which folds it
  into `view.setChromeOverlay`) pass the stores; without the `omnibox` prop the dropdown
  never opens. Coverage: `useOmnibox.test.ts` (the debounce, the monotonic seq guard, the
  arrow-key cursor) + `OmniboxDropdown.test.tsx` (the rows, the highlight runs, the
  mousedown-to-pick contract) + `AddressBar.test.tsx` for the wiring.
- **`components/TabStrip`** — the top row of the chrome, rendered above the
  toolbar on desktop only (hidden on mobile via `.aegis-mobile`). Shows the tab
  list and drives `tabs.create`/`tabs.activate`/`tabs.close` etc. Private tabs
  receive the `tab--private` CSS class (visual treatment) and the strip has a
  dedicated **"New private tab"** button (`tabstrip__new--private`) that calls
  `tabs.create(undefined, false, true)` — the third arg is `isPrivate`. The same
  call is wired to `Ctrl+Shift+N` in `App.tsx`. Mobile: the `MobileTabSwitcher`
  also exposes a new-private-tab entry. `TabStrip.test.tsx` covers the button click and
  `App`-level tests cover the keyboard shortcut. The "a private navigation leaves no
  history row" assertion is **not** automated — it needs a real webview; `tabs.rs`'s unit
  tests cover the private-flag propagation and `history.rs`'s the private-tab skip.
- **`lib/layout.ts`** gained `TABSTRIP_H` (the pixel height reserved for the
  tab strip), used by `useContentInset` to keep the content webview positioned
  below it.
- **`lib/format.ts`** — the display formatters the list panels share, so they stay
  presentational: `formatHost(url)` (hostname minus `www.`, `''` for non-http or
  unparseable — callers omit the meta line when it's empty), `formatRelativeTime(ts,
now?)` (`just now` → `12 min ago` → `3 h ago` → `Yesterday, 14:32` → `Tue, 09:12` →
  `12 Mar` → `12 Mar 2024`; never a negative age for a future timestamp),
  `formatBytes(n)` (`1.5 KB`, `4.3 MB`; the decimal is dropped at 10 and above), and
  the day-bucket trio `dayBucket` / `dayBucketLabel` / `groupByDay`. **Every function
  takes an explicit `now` (defaulting to `Date.now()`)** so the tests pin the clock
  instead of depending on the day the suite runs. Use these in a new list panel rather
  than calling `toLocaleString()` inline.
- **`lib/addressParse.ts` — a `host:port` pair is a HOST, checked BEFORE the scheme
  test.** RFC 3986 allows `.` and digits in a scheme name, so `hasScheme('example.com:8080')`
  is _true_ and `new URL('example.com:8080')` parses with the protocol `example.com:`, which
  then fails the http(s) allowlist. Every letter-leading `host:port` was therefore rejected
  with "Aegis can only open web (http and https) addresses" — plainly false about a plainly
  web address, and the single most common thing a developer types. `looksLikeHostPort` now
  runs first (strict `PORT` = digits, 1–65535; host part needs a dot, `localhost`, or a
  bracketed IPv6 literal). **Loopback → `http://`** (`localhost`, `127.0.0.0/8`, `::1` are
  provably this machine, so no cleartext request can leak off-box, and a dev server speaks
  plain HTTP); **every other dotless `name:port` → `https://`**, matching the dotted case,
  because an intranet search-domain name DOES traverse the network and must not be silently
  downgraded. `hostPortUrl` is shared by `addressParse`, `normalizeSavedUrl` and
  `isUrlLikeInput` so the three cannot disagree. **One `host:port` shape stays refused and
  that is deliberate:** a dotless `wiki:8443` is shape-identical to `javascript:1` /
  `data:0` / `tel:911`, and there is no way to tell them apart without a registry of every
  registered scheme — so refusal is fail-safe and a test pins it.
- **`lib/url.ts` — `hostCovered(allowlist, host)` is the ONE place the renderer decides
  what an allowlist entry covers, and it mirrors `adblock::host_covered` row for row**
  (exact match, or the host ends with the entry preceded by a `.`; `notexample.com` is
  NOT covered by `example.com`, and `example.com.evil.test` is NOT covered by
  `example.com`). **This helper exists because three copies of that rule had already
  drifted**, all three of them EXACT-match `Array.includes`: the ad-block engine's
  `HashSet`, `protectionSummary`'s `fingerprintAllowed`, and `AdblockShield`'s own
  `state.allowlistedHosts.includes(host)` — the last of which sat 48 lines below a popover
  in the SAME file that had already been corrected, so the shield button and its own popover
  disagreed in one render: the core exempted `www.example.com` from every tier while the
  button's title said "Ad blocking is active". Both now call `hostCovered`, and
  `AdblockShield.test.tsx` covers a SUBDOMAIN host plus the two lookalikes
  (`notexample.com`, `example.com.evil.test`) that must stay un-exempted. The original
  drift was that allowlisting `a.com` exempted `www.a.com` in the core while the badges
  reported the page as fully protected — a privacy badge disagreeing with the privacy
  machinery. `url.test.ts` carries a deliberate scope table mirroring the Rust test case for
  case; **if the core's rule changes, change it here in the same commit and re-derive both
  tables.**
- **`hostCovered` is a READ rule; the core WRITES the allowlist with EXACT equality, and the
  two deliberately differ.** `adblock::dispatch`'s `toggleAllowlist` arm asks
  `load_allowlist_hosts(app).iter().any(|h| h == &host)` — "listed" means that exact string
  is present — while `hostCovered` means the host OR one of its parents is present. Reading
  with the wide rule and writing with the narrow one means un-checking a subdomain whose PARENT
  is what allows it **cannot work**: the core sees "not listed" and ADDS, the store then holds
  both entries, `hostCovered` is still true, and the checkbox snaps straight back on — and
  `allowlist` is in `sync_stores::SYNCABLE`, so the redundant entry spreads to every paired
  device. `AdblockShield` therefore **disables the control and names the covering entries**
  ("Ads are already allowed on www.example.com because example.com is in the allowlist.
  Remove it to block ads here again.") whenever the host is covered by anything other than
  its own exact entry — including the both-listed case a peer or a restored backup can
  produce, where removing the exact entry would still leave the parent covering the host.
  **Do NOT "fix" this by making the write use `host_covered`:** that removes the apex parent,
  which is a different and much broader action than the click asked for.
  `AdblockShield.test.tsx` drives the real UI for the refused case, for both still-allowed
  cases, and for the both-listed case. (The `farble.rs:370` / `SecurityTab.tsx:223` pair looks
  like the same bug and is **not** — it is exact on BOTH sides, so read and write agree.)
- **The badges must not overstate protection.** `protectionSummary` takes `webrtc:
WebrtcExemptState` as a **REQUIRED** option (an optional field with a default would fail
  OPEN to "not exempt" for any caller that forgot it — which is exactly the bug class
  being fixed; making it required broke 14 test call sites, and that churn is the point).
  `AdblockShield`'s WebRTC row checks the exemption FIRST and reads `Off here` / not-good,
  mirroring the fingerprint row's `Allowed here`. A badge is a claim about what the core
  did; when the core changes, the badge must change with it, and a test must say so.
- **Ad-blocking counts say "caught", never "blocked".** The per-platform semantics differ
  by design: on Windows and Android the number IS requests the tier stopped, but on Linux
  the count is fed by a signal that fires only for requests the declarative content filter
  ALLOWED — requests it stops outright are cancelled before that signal — so the Linux
  number is a **lower bound**. `AdblockShield` therefore says "Ads caught here" / "Ads
  caught this session" (all three strings: the two popover lines AND the `aria-label`) and
  explains the per-platform difference in a popover note. Four pre-existing tests asserted
  the old "blocked" wording, i.e. they encoded the lie; when a fix corrects a user-facing
  string, expect the tests to be asserting the old string and treat that as evidence about
  the test, not a reason to weaken the fix.
- **List-panel row anatomy (History / Saved / Downloads).** Each row is
  `title` + a **meta line** = `host` + a right-aligned timestamp, and the full URL is
  _never_ printed — it is long, redundant with the title, and eats the width the host
  needs. The shared classes are `.history-panel__meta`, `.saved-panel__meta`,
  `.downloads-panel__meta`, `__host` (shrinks + ellipsis) and `__time` / `__saved`
  (`margin-left: auto`, never shrinks). History additionally groups rows by day:
  `.history-panel__groups` → `<section aria-labelledby>` per bucket with a sticky
  `<h3>` header ("Today" / "Yesterday" / "Earlier this week" / "Earlier"), built by
  `groupByDay` so the group order is fixed rather than data-derived. A row's
  `aria-label` still carries the full URL, so nothing is lost to a screen reader.
  History and Downloads search/filter live-filter as you type; Downloads folds to
  `COLLAPSED_ROWS` (5) behind a "Show all N" button.
- **Theme tokens (`index.css` / `lib/theme.ts`).** `index.css` ships two palettes:
  `[data-theme="dark"]` (the original flat `:root` tokens, moved verbatim — dark look
  is unchanged) and `[data-theme="light"]` (a parallel white-surface palette). `<html
data-theme="dark">` in `index.html` plus a bare-`:root` dark seed prevent any
  first-paint flash. `lib/theme.ts` (`applyTheme`, `resolveTheme`, `watchSystemTheme`)
  reads `Settings.themeMode` (`'system' | 'dark' | 'light'`) and sets the attribute.
  **Fully tokenized (2026-06):** the desktop `TabStrip`, the entire Android `mobile-*`
  chrome, and the `SafetyInterstitial` now derive their colors from the theme tokens
  (previously hardcoded-dark), so light theme is consistent across all chrome. The
  malware interstitial keeps a danger accent via `--danger`/`color-mix`. The default
  accent is `#2563eb` (white-on-accent ≈ AA); muted text is `--fg-muted` lifted to
  meet AA on input surfaces. `index.css` also ships a `prefers-reduced-motion` block,
  an `.sr-only` utility, a `--font-size-*` type ramp, and a styled native `<select>`.
- **Solid panels, glass only over live content.** Every full-window overlay card
  (`.settings-modal__content`, `.confirm-dialog`, `.error-overlay__panel`,
  `.interstitial__panel`, `.downloads-modal`, `.favorites-manager`,
  `.permission-prompt`, `.command-palette`, `.onboarding__card`, `.toast`,
  `.autofill-save-prompt`, `.mobile-sheet`, `.sidebar__panel`) is **solid
  `var(--bg-elevated)` + a border + a shadow, with NO `backdrop-filter`**. A
  full-window overlay sets `overlay: true`, which _hides_ the content webview, so
  there is no page behind the card to blur — `--glass-3` (white @ 10% dark) just
  composited to a flat value nearly identical to its own backdrop. Translucency
  is reserved for surfaces that genuinely float over a **live** page:
  `.adblock-shield__popover`, `.zoom-indicator__popover`, `.site-identity`,
  `.find-bar`, `.ws-ctx-menu`. Don't "unify" these two groups.
- **`components/SettingsModal`** groups its tabs into labelled sections via `TAB_GROUPS`
  (the flattened group order IS `TAB_ORDER`) rendered as a vertical left rail with
  roving arrow-key navigation; on `.aegis-mobile`/`.aegis-narrow` the rail becomes a
  horizontal strip. Adding a settings tab still means: add to `SettingsTab`,
  `TAB_LABELS`, `TAB_GROUPS`, the `SettingsModalProps`/`panels` wiring, AND a case in
  `SettingsModal.test.tsx` that walks every tab.
- **`components/Onboarding`** is the first-run welcome modal (replaced the one-line
  `WelcomeHint`): surfaces the signature features + a default-search-engine picker,
  rendered by both shells. It is localStorage-gated (`ONBOARDING_STORAGE_KEY`) and
  defaulted to "completed" for vitest in `vitest.setup.ts` so the tours aren't blocked
  (its own test opts in via `forceOpen`).
- **Responsive desktop shell.** `hooks/useNarrowViewport` (matchMedia, `≤680px`) toggles
  `.aegis-narrow` on `<html>` and drives `Toolbar`'s overflow ("More tools") menu so a
  narrow desktop window keeps a usable address bar. The desktop never swaps to the Android
  `MobileApp` shell — that shell is wired to the native content bridge and can't drive the
  Tauri content webview; the narrow desktop layout adapts in place instead.
- **`useDialog(onClose, { initialFocus }, open = true)`** — optional `initialFocus` lands focus
  on a specific element (used to focus the SAFE button in confirm/permission dialogs). The
  `confirm(message, { destructive })` helper styles the affirmative button as dangerous.
  **Pass the third `open` argument when the component stays MOUNTED but renders `null` while
  closed** (e.g. `CommandPalette`, `Onboarding`, `SafetyInterstitial`). The hook's single
  effect installs the focus trap, the Escape handler and the focus-restore cleanup, and it
  bails when the node is absent — so a dialog that is always mounted and conditionally
  rendered would install all of that exactly once against no node, and silently have no
  focus trap, no Escape and no focus restore. Omit `open` for a dialog whose parent
  conditionally renders it (it then mounts fresh with a node and works unchanged).
  The hook returns a real `RefObject` (not a callback ref) because several call sites write
  `.current` from a stable ref callback to share the node with a measurement probe.
  The previously-focused element is captured **inside** the `open` effect, not at mount: a
  `useRef(document.activeElement)` initialised on the first render only ever held whatever
  was focused then, so for the always-mounted dialogs the third `open` argument exists for,
  every open after the first restored focus to a stale (or already-removed) element — i.e.
  `<body>`, which makes the next Tab restart from the document top.
- **Full-window z-order is the `--z-*` scale at the top of `index.css`.** Every band carries
  the value the rule already had — the sole exception is the command palette (11200 → 11150,
  see below) — so adopting it changed no rendering; what it buys is that the bands are named,
  that no two rules have to SHARE a number, and that one intended relationship is expressed
  rather than implied. `.confirm-dialog__scrim` and `.command-palette__scrim` were both
  `11200`, so their paint order was decided by DOM position in `App.tsx` (later wins), which
  nothing documented. `--z-confirm` (11200) is deliberately **above** `--z-palette` (11150),
  which is above `--z-prompt` (11100): a blocking modal raised by a palette action must not
  be occluded by the launcher. The scale is ascending except `--z-interstitial` (10100) over
  `--z-toast` (10020) — pre-existing and deliberate, preserved. Do not renumber to sort: each
  value is another rule's z-index. Adding a full-window surface means adding a band, not
  another magic number. NOT in the scale, on purpose: anchored popovers (5000/5100), the
  toolbar's own stacking (100/`--z-toolbar-menu`), the mobile shell (10/50) and in-container
  locals (1, 2).

## Mobile shell (`components/mobile/`, Android)

On Android (`isMobile`, read from the `.aegis-mobile` class) `App` renders **`MobileApp`**
instead of the desktop chrome; the desktop body is unchanged (just renamed `DesktopApp`).
`MobileApp` reuses the existing hooks + presentational panels inside a touch shell:

- **`MobileTopBar`** — slim address bar (reused `AddressBar`) + reload/stop + a 24dp
  favourites strip (`MobileFavourites`), plus a **bottom-bar toggle** (chevron) and an
  **Enter fullscreen** (Maximize) button.
- **`MobileBottomBar`** — Saved / History / **Tabs (live count)** / shield / menu
  (thumb-reachable). Saved + History open their sheets directly; Tabs opens the switcher.
- **`MobileMenuSheet` / `MobileSheet`** — the ☰ drawer (now Back / Forward / Home /
  Bookmark / Downloads / Settings — Back/Forward moved here off the bottom bar) and a
  generic full-screen sheet hosting History/Saved; Settings/Downloads reuse their modals.
- **`MobileTabSwitcher`** — a vertical-list tab switcher sheet (`'tabs'`): one row per
  tab (page title, or host fallback), tap to switch, X to close, **+ New tab**.
- **Tab titles after load.** `useTabTitleSync` (both chromes) sends `tabs.setTitle` when a
  `nav.state` carries a title the tab has not reported yet "''' + EM + '''" which is how a page
  that renames ITSELF (SPA route, unread count, video title) reaches the strip, since
  `tabs.recordNav` only runs at navigation. It is separate from `useNav` because `useNav` is
  mounted per view and filters to the ACTIVE tab (the address bar only tracks the active one),
  while the strip needs every tab. It skips an unchanged title, because `nav.state` also fires
  at page load and on progress and each send would be a write plus an `emit_and_persist`.
  Desktop and Android both feed it from the SAME `nav.state` event, so there is no platform
  branch in the hook.
- **Multi-tab wiring.** `MobileApp` uses `useTabs()` + `useNav(tabs.activeId)` (active-id
  keyed); **`useMobileTabSync`** diffs the registry's tabs state and drives the native
  per-tab bridge (`activateTab`/`closeTab`/`discardTab`) — it tracks the last-activated id
  (not an activeId diff) so the first tab still activates when `useTabs` resolves its
  EMPTY `{activeId:1}` seed into a real `activeId:1`. `window.__aegisOpenTab(url)` opens a
  **background** tab (`tabs.create(url, true)`) for native `target=_blank`/`window.open`.
  On Android the Rust core can't see the WebView title, so MobileApp relays the active
  tab's title into the registry via **`tabs.setTitle`** (guarded on the nav state's viewId)
  to keep the switcher labels accurate.
- **Sheets** (incl. the tab switcher) route through `view.setChromeOverlay` so the native
  content webview lowers. The native **Back** button precedence is: close an open sheet →
  exit fullscreen → **close the find bar** → page-back (`setBackInterceptActive` +
  `window.__aegisMobileBack`). All three of those inputs are in the effect's dependency
  array: without them the effect does not re-run when a full-window surface opens or
  closes, so BACK is armed at the wrong times — and arming it with nothing to dismiss
  swallows the gesture, which is worse than not intercepting.
- **`index.css`: on mobile the find bar is `position: fixed`, and it must be.** The
  `.mobile-topbar` is `position: fixed`, so it is out of flow, and `.find-bar` is
  `position: static` — the bar therefore laid out at y=0, _inside_ the topbar's own band,
  behind its opaque glass and its `backdrop-filter`, taking no pointer events. The find
  input autofocuses on mount, so the soft keyboard opened onto an invisible field. Desktop
  is unaffected (its topbar is in flow and the bar lands below it), which is why only a
  device check finds it. The rule is scoped `.aegis-mobile` and uses
  `z-index: 10` — the same value as the topbar and bottom bar, whose bands do not overlap
  it — while beating `.mobile-favourites` (9), which _does_ share this band and would
  otherwise paint over it as the later sibling. `top` is
  `calc(48px + var(--aegis-inset-top, env(safe-area-inset-top)))`, matching
  `.mobile-favourites`; 48px is `MOBILE_ADDRESS_H` spelled literally, as the sibling rules
  already do. **jsdom has no layout and vitest does not load `index.css`, so the visual
  result of this rule is PENDING on-device verification** — the tests pin the BACK
  behaviour only.
- **Chrome heights** live in `lib/layout.ts` (`MOBILE_ADDRESS_H` 48 / `MOBILE_FAV_H` 36 /
  `MOBILE_BOTTOMBAR_H` 56; top chrome = 84dp) and **must stay in sync with the
  content-WebView margins in `MainActivity.kt`**. (`MOBILE_FAV_H` was raised 24→36 so the
  favourites chips clear the ~36px touch-target floor.) The mobile `MobileSheet` dismiss is
  a Close (X) button (focus-trapped via `useDialog`), and touch targets in the mobile
  chrome are ≥44px. **There are no width media queries in `index.css`** (only
  `prefers-reduced-motion` and `pointer: coarse`) and `.mobile-topbar` has no `height` of
  its own — it is padding plus the safe-area inset — so these constants are the only
  source of mobile vertical geometry.
- **Touch targets vs. layout heights (the one place they conflict).** Most mobile controls
  are simply sized ≥44px: `.mobile-topbar__reload`/`__toggle` (44×44),
  `.mobile-bottombar__btn` (56), `.mobile-menu__item` (52), `.omnibox__row` (44). The
  favourites bar is the exception — its chips and add button are 28px because `MOBILE_FAV_H`
  is locked to the native WebView margins, and growing them would desync the layout. Under
  `@media (pointer: coarse)` they instead get an **overlay `::after` pseudo-element**
  (`position: absolute; left/right: 0; top: 50%; height: 44px; translateY(-50%)`) that
  enlarges the _hit_ area without contributing to layout, and deliberately keeps the
  element's own width so neighbouring chips' targets can't overlap. **If you add a control
  to a height-constrained mobile bar, grow it with that technique — don't raise the CSS
  height, and don't raise `lib/layout.ts` without also editing `MainActivity.kt`.**
- **Bottom-bar toggle** and **fullscreen** (hide all chrome — desktop parity) call
  `setBottomBarHidden` / `setFullscreen` on the bridge; the native side shrinks the
  content webview's margins so the page reclaims the space.
- **Safe-area insets (all four edges):** `env(safe-area-inset-*)` on Android WebView is
  only the display cutout, not the system bars, so `MainActivity` pushes the real
  `systemBars() ∪ displayCutout()` insets to the chrome as `--aegis-inset-top/bottom/left/right`
  CSS vars. Every full-window mobile surface pads itself with `var(--aegis-inset-*, env(...))`:
  `.mobile-topbar`, `.mobile-bottombar` (`box-sizing: content-box`), `.mobile-sheet`
  (History/Saved/Menu/Tabs), the reused `.settings-modal__content` / `.downloads-modal`
  (`.aegis-mobile`-scoped — this is what keeps Settings/Downloads off the status/nav bars),
  `.onboarding`, and `.toaster`. A test should assert each of these selectors still carries
  its inset var — dropping one silently puts the surface under the status/nav bars.

## Tests

`*.test.tsx` / `*.test.ts` are co-located. They run in the vitest **jsdom** project
(`include: src/**/*.test.{ts,tsx}`). Tests mock the `aegis` object — no real IPC.
Run the whole suite with `npm test` from the repo root.

### The seam the mock hides, and the test that covers it

`src/testFixtures/aegisMock.ts` replaces the **whole** `aegis` object. So every other
`src/` test exercises the React half of the renderer→core seam and **never touches
`ipcClient.ts`** — the channel string, the `private` vs `isPrivate` rename, the dot→colon
rewrite in `tauriInvoke.ts` and the whole Android bridge switch were, until
`src/lib/ipcClient.contract.test.ts`, unasserted by anything. That test mocks **only**
`@tauri-apps/api/core` + `/event`, so the real `aegis` runs, and it pins every request
channel in the catalog (127 rows, counted as one table entry per `channel:` field) plus
every event subscription (23 rows, counted the same way), with two
derived ratchets so the table cannot silently shrink or grow stale.

Together the two guards are complementary, not redundant, and each is non-vacuous:

- `shared/ipcCatalog.drift.test.ts` — catalog ↔ Rust ↔ renderer-subscriber (the **outer**
  hops). Catches a channel with no Rust arm, a Rust arm for an undeclared name, an `evt*`
  nobody subscribes to, and a raw dotted `emit`.
- `src/lib/ipcClient.contract.test.ts` — UI action → exact `invoke` payload (the **inner**
  hop). Catches a wrong channel string, a renamed payload field, a dropped `undefined` vs
  `{}` distinction.

Proven: adding `nav.bounce` to **both** the catalog and a Rust `match` arm leaves the drift
test green (the channel has a producer) and turns the contract test red. Neither subsumes
the other.

### `it.fails` — a convention, currently with no users

A test written as `it.fails('…')` **passes while the bug exists and goes red the moment
someone fixes it** — that is the point, and it is why such a test must assert _behaviour_
(`toBeCloseTo(…, 9)`), never float bits or an intermediate value.

It had exactly one user: the split-view resize clamp. `App.tsx` passed a **fraction** into
`clampResizeDelta`, which compared it against **pixel** bounds, so a split with a pane under
~17% either did nothing (the handle silently died) or slammed to 0.05/0.95 on a 10px drag.
The three `it.fails` tests made the bug _impossible to fix silently_ — when a coherent fix
was applied experimentally, exactly those three went red and the other 19 stayed green.
**Split view was then removed outright at the repo owner's direction rather than fixed**, so
the convention has no users today. The technique is recorded because it is what made the
defect visible and safe to delete: a 3-test measured matrix plus a fix-proof beats a prose
claim that something is broken.

### Cross-boundary platform contracts (`lib/platformContract.drift.test.ts`)

Two contracts that cross a language boundary, where nothing in the renderer suite enforced
them and a drift is invisible to every other test. Both derive the expected list FROM the
code that defines it, so a new surface cannot join either class silently. Each carries a
**mutation recipe** — the guard is proved by breaking the relation, not by reading it.

**A chrome popover that measures itself must reserve its height.** The content webview is
OPAQUE and on top, so a chrome popover that hangs below the chrome (omnibox, site info,
ad-block shield, zoom) must make the compositor lower the webview by its own measured height.
`useChromePopover.tsx:10-19` states the invariant in prose — and names the bug it exists to
prevent: _"A new popover that forgets to register renders behind the content, which is
exactly the bug the site-information popover shipped with."_ The registry is well covered
(`useChromePopover.test.tsx`, 6 tests); the **linkage** was not, so the prose was the only
enforcement. The guard is: every `src/components/*.tsx` that imports `useMeasuredHeight`
must also reference `useChromePopoverInset`. Mobile is deliberately out of scope —
`MobileApp.tsx:133` records that the Android shell is a single webview whose native content
view is lowered through `view.setChromeOverlay` instead, so a mobile surface has nothing to
reserve. **Recipe:** add a component that measures a popover without registering it; the
guard must go red and name the file.

**Every inset the Android shell pushes in must be consumed, and vice versa.**
`MainActivity.kt:806-809` pushes the REAL system status/nav bar insets in as
`--aegis-inset-{top,bottom,left,right}`; `index.css` consumes them as
`var(--aegis-inset-top, env(safe-area-inset-top))` in 9 distinct rules (30 `var()`
occurrences). Drift in **either** direction
is a real bug and neither was catchable. A surface that forgets to consume an inset renders
under the status bar. A rule consuming a var the native side never sets silently falls back
to `env(safe-area-inset-*)`, which `index.css:5181-5183` records as being only the DISPLAY
CUTOUT on an Android WebView — so it cannot clear the system bars at all. **Recipe:** rename
one of the four vars in `MainActivity.kt`; a single rename turns on BOTH directions at once
(the rule still consumes the old name, and nothing consumes the new one), which is the
cheapest possible demonstration that the guard sees the whole relation.

The failure messages deliberately **name the offending file / rule** rather than just the
variable, because "expected [] to equal []" tells a reader nothing about which of the nine
rules is wrong. Each guard also has an anti-vacuity test asserting the scan actually found
something (the three popovers; the four insets), so neither can pass by measuring nothing.

### Tests that could not fail (the vacuous-test inventory)

A test that passes no matter what the code does is worse than no test: it reads as coverage
in a coverage report and in a review, and it puts a **false claim** in the reader's head
about what is guarded. The worst form is the one whose **name is its assertion** — it reads
as documentation of the guarantee and proves nothing. Four were found and dealt with; the
verdicts differ per case, which is the point of writing them down.

**1. A conditional test whose real branch the host never takes.**
`lib/farbleShim.test.ts` read `if (navigator.userAgentData) { …assert the brands are
normalised… } else { expect(true).toBe(true) }`. jsdom has no `userAgentData`, so the `else`
was the branch that ran on every CI run and the shim's whole UA-CH brand normalisation was
untested. The comment inside it was **true about the shim** (its `try/catch` makes an absent
`userAgentData` a safe no-op) and **false about the test**. The fix installs a plausible
pre-shim `userAgentData` with `Object.defineProperty(…, { configurable: true })`, asserts a
precondition that the value is the one installed and does NOT already contain the target
brand, and restores jsdom's original absence in a `finally`. The fail-open half was split
into its own test (an absent `userAgentData` must be left absent) because that is what the
original comment was actually claiming. **A test's guard condition can be correct about the
code and still make the test vacuous — check which branch your host takes.**

**2. An assertion-free race test, in two shapes with two different verdicts.** Both
`hooks/useOmnibox.test.ts` and `hooks/useSafety.test.tsx` unmounted a hook, released a
pending promise, and carried only a comment saying it "would warn/throw … if the guard were
absent". **No spy, no `expect` — the suite stayed green with the guard deleted.** They are
not the same problem:

- `useOmnibox` was **fixable**, because its guard is a monotonic `seq` token
  (`useOmnibox.ts:57`, checked at `:62`/`:69`, invalidated in the cleanup at `:76`) rather
  than an `active` flag. The observable is the token's **consequence** — a result that lands
  after the effect is torn down must not reach state — and it is testable **without
  unmounting** by rerendering `active: false`, which runs the previous cleanup (bumping
  `seq`) before the new effect early-returns, and unlike unmount leaves the state readable.
  It carries a precondition `expect(historySearch).toHaveBeenCalled()` so the "not present"
  cannot be vacuously true because no request was ever issued. **Non-vacuity was proven by
  `cp`-ing the hook aside and deleting the cleanup's `seq` bump: exactly the one new test
  flipped.**
- `useSafety` was **not fixable, and is reported rather than dressed up.** With the
  `if (active)` guard **removed**, a `console.error` spy still recorded nothing
  (`9 passed (9)`). **React 18 removed the "can't perform a state update on an unmounted
  component" warning outright**, so any assertion on it cannot fail; and the effect's deps
  are `[]`, so there is no teardown-without-unmount path that would leave the state readable.
  The `active` flag therefore has **no observable from outside the process**, and the only
  thing that could witness it is a white-box refactor of a two-line guard. The test was
  renamed to what it does and given the one observable that does exist — `expect(off)` proves
  the cleanup tore the subscription down — and its comment now says explicitly that it is
  **not** a witness for the flag. **A `console.error` spy is a legitimate post-unmount
  assertion in this repo (see `hooks/useWebrtcExempt.test.ts`) and it is the right tool here
  — but only because that hook's `setState` also reaches a `console.error` path. Never carry
  it across on the strength of one case working.**

**3. Registered-but-never-dispatched listeners.** `App.tsx` registers four `aegis:*` shell
`CustomEvent` listeners in one effect; only `aegis:openSidebar` had a test that actually
dispatched one. The other three (`toggleSidebar`, `toggleFavoritesBar`, `openSettings`) were
covered by a test that asserted only that they are **registered** — so the fix that
`App.tsx:190-195` records as un-breaking both toggles and all fifteen "open settings…"
palette entries shipped without ever being shown to work, and emptying a handler body left
the suite green. **Asserting that a listener is wired is not asserting that it does
something: dispatch the event.** Non-vacuity was proven by emptying all three handler bodies
at once — exactly those three tests flipped and the other 33 passed. Each toggle test
dispatches **twice** (open, then close), because a handler wired straight to `true` satisfies
"it opened" and fails the second half. One precondition of mine was wrong and was re-derived
rather than relaxed: the bookmarks bar starts **open** (`useState(true)`), so the first
dispatch closes it.

**How to find these.** A python scan over every `src/**`, `shared/**` and `scripts/**` test
file for `it(`/`test(` blocks whose body contains no `expect(`, plus tautological
`expect(x).toBe(x)`, returned 4 hits and **zero** tautological pairs. Two of the four were
**detector artifacts** — `it.each([` puts the body on later lines, so the scanner must either
skip `it.each` or scan to the matching brace. The other two were the real defects above.
The scan is a _completeness trigger_, not an assertion; the assertion is always
`cp`-the-mechanism-first, neutralise it, and check that **exactly** the intended tests flip.

**Three audit findings that were wrong, recorded so they are not re-raised.** (a) "delete
`hooks/useFingerprint.test.tsx`" — it is **not** a duplicate of
`hooks/useWebrtcExempt.test.ts`: its `refetches when a synced fp-allowlist change is
published` drives `publishSyncChange` and asserts `getState` ran **twice**, and
`useWebrtcExempt` has **no** `syncBus` subscription **by design** (the store is never
synced — that absence is the feature). (b) "align the two shim runtime tests on indirect
eval" — they already do: `run` and `runStrict` both use `(0, eval)(…)`, and a plain
`grep 'eval('` returns nothing because of the `0,` de-reference. (c) The bare
`expect(true).toBe(true)` is at `farbleShim.test.ts:298`, not in a 287-300 range.

### The four biggest coverage gaps, and what closing them cost (2026-09-28)

Uncovered statements before and after, measured from `coverage/coverage-summary.json`:
`App.tsx` 145 → **123**, `TabStrip.tsx` 60 → **13**, `SettingsModal.tsx` 34 → **2**,
`Sidebar.tsx` 28 → **1**. Every one of these four files' own source files came out
**byte-identical to HEAD** — the whole change is tests, and each new test was proved
non-vacuous by neutralising the mechanism it covers and watching exactly the right tests
flip. Three of the four brief labels were wrong or imprecise, as usual:

- **`TabStrip` virtualization was real, but the drag-and-drop block was equally untested**
  and nobody had noticed, because the window was only unreachable _by accident_ — no test
  had ever opened more than `VIRTUALIZATION_THRESHOLD` (50) tabs. Both are covered now, plus
  the middle-click-close and right-click-pin handlers that sit in the same block.
- **The `Sidebar` label said "rAF" but `ArrowLeft`/`ArrowRight` and the clamp were already
  tested.** The rAF _coalescing_ was genuinely uncovered, and it is only reachable **while a
  pointer drag is in flight** — no test had ever dragged. The `Home`/`End` clamps and the
  localStorage-unavailable fallback were the other real gaps.
- **The `App.tsx` label said "keyboard shortcuts" and pointed at modal wiring.** The modal
  wiring is one-liner props; the real find was two blocks nobody had touched: the **onboarding
  privacy preset** (a security control whose whole pairing was unexercised) and the
  **`tabs.shortcut` native mapping** (Ctrl+T / Ctrl+W / Ctrl+Shift+T / Ctrl+Tab / Ctrl+1..9).
  The `aegis:*` window CustomEvents at `App.tsx:216-219` are a _different_ mechanism and were
  already covered by the vacuous-test inventory fix above.

**jsdom gaps, all silent, each found by a test that failed for a reason I had not predicted.**
None is a product bug; each makes a real browser behaviour unreachable in a test, so it will
bite again. **jsdom 25 → 28 (2026-09-28) closed two of the original four**, re-measured in
this tree. Note _whose_ gap they were: `@testing-library/react` is **16.3.2 in both
lockfiles**, so it never changed — it was silently falling back to a plain `Event` because
jsdom lacked the constructor it wanted. The old workarounds are still in the tests and are
harmless, so none were deleted, but **do not copy them into new tests** — items 3 and 4's
init half are fixed:

1. `fireEvent.auxClick` **does not exist** in this `@testing-library` build. **Still true**
   (`typeof fireEvent.auxClick === 'undefined'`), and it is testing-library's gap, not
   jsdom's. Dispatch the raw bubbling event instead:
   `fireEvent(el, new MouseEvent('auxclick', { bubbles: true, … }))`.
2. jsdom has **no layout**, so `clientWidth` is `0` — and `0 ?? 800` is `0`. **Still true**
   (re-measured: `clientWidth` 0, `scrollWidth` 0). A component's own viewport fallback
   therefore only fires on the _first_ render, when its ref is still null; after any re-render
   the viewport collapses and a windowed render goes empty.
   `Object.defineProperty(node, 'clientWidth', { value: 800 })`.
3. **CLOSED in jsdom 28.** `fireEvent.scroll(el, { target: { scrollLeft } })` used **not** to
   write jsdom's `Element.scrollLeft`. It now does: a listener fired by that exact call reads
   `120`. Set the property on the node first only if you must support jsdom 25.
4. **Half-closed in jsdom 28.** `PointerEvent` now **exists** and is constructible —
   `new PointerEvent('pointerdown', { pointerId: 7, button: 2 })` carries both fields, and
   `fireEvent.pointerDown(el, { pointerId: 7, button: 2 })` now delivers them (it used to
   drop the init silently, so React read `undefined`). **The pointer-CAPTURE trio is still
   missing**: `setPointerCapture`, `hasPointerCapture` and `releasePointerCapture` are all
   `undefined` on `Element.prototype`. So build the event normally — no `defineProperty` dance
   — and still stub the capture trio.

**What is left is honest, and part of it is not reachable at all.** `SettingsModal`'s two
remaining statements are the `visibleTabOrder.length === 0` early returns in the `Home`/`End`
cases: when the search matches nothing the rail renders no buttons, so no keydown can reach
the tablist handler — structurally unreachable, not untested. `Sidebar`'s single remaining
statement is `if (typeof window === 'undefined') return 900;`, an SSR guard jsdom can never
hit. `TabStrip`'s 13 are a **genuine** remaining gap, not an excuse: its own `focusTabAt`
keyboard navigation (the Enter/Space/Arrow/Home/End arms and the scroll-a-missed-tab-into-view
branch) is still untested. `App.tsx`'s remaining 123 are mostly the conditionally-rendered
modals and their callback props.

**Two method notes worth more than the code.** _A hand-derived index is a liability_ — three
times this session I computed an expected index or an off-by-one wrap by hand and was wrong
(once in each of the three files here); every time the fix was to restate the assertion as the
**property** ("the window moved, the first tab is gone, a later one is present, the count is
still under the total") rather than the arithmetic. _`getAllByRole` throws on an empty
match_, so `expect(queryAllByRole('tab')).toHaveLength(0)` is a precondition that can never
hold — and a test that renders `<App />` twice leaves two copies mounted, so every role query
then counts both. One render per test.

### Coverage of `src/`

`npm run test:coverage` measures every `src/` file except three, excluded by
`coverage.exclude` in `vitest.config.ts` because measuring them is meaningless:
`src/main.tsx` (the `createRoot` entry point), `src/vite-env.d.ts`, and
`src/testFixtures/**` (a mock). The measured totals, the ratchet and the full gap
decomposition live in the **root** `AGENTS.md`. The `src/`-only view, for when you want it
without opening the other file: `src/` is at **90.5%** statements (5711/6308, 597 uncovered)
and the debt is concentrated in `src/components/` (368) and the `App.tsx` root (123); the
hooks sit at 38 uncovered statements out of 1386, and `shared/` is at 0. Every figure here
is recomputed from `coverage/coverage-summary.json` when it is touched — the previous
revision of this paragraph said 88.0% / 736 uncovered / 479 / 152 / 42-of-1350, none of
which the report yields any more.
