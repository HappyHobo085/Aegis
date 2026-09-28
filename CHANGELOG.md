# Changelog

All notable changes to Aegis are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A closed tab's find-in-page term could reappear in the next tab that reused its
  id.** Windows' find API cannot hand back the term it was given, so the core keeps a
  per-tab copy for the change events to report. Closing a tab never cleared that copy,
  and tab ids are reused after a session restore, so a tab could open with a dead tab's
  search term already sitting in its find bar. Closing a tab now clears it along with
  the other per-tab tables.

- **HTTPS-Only could be walked around with a capital letter on Android.**
  `MainActivity.secureUrl()` compared the URL's scheme with exact equality while
  `android.net.Uri` does not normalise its case, so `HTTP://example.com` skipped
  the upgrade entirely — one character was enough to turn the setting off. The
  rewrite also sliced the URL with a hardcoded `http://` length, which happened to
  be the right width for `HTTP://` only by coincidence. The comparison is now
  case-insensitive and the slice uses the scheme's real length. Compile-verified
  only (there is no Kotlin test source set); the behaviour is pending on-device.

- **The home page setting was ignored on Android.** All three desktops resolve it in
  the core, and the phone showed it in Settings, but on a phone the Home button
  always went to `about:blank`: the core's `nav.home` drives a Tauri content
  webview, which the single-webview mobile shell does not have, so the renderer
  has to resolve it itself. It now uses the last settings it loaded, and refuses
  the same values the core refuses.

- **Find in page was unreachable on Android.** The mobile top bar is `position: fixed`,
  so it sits outside the document flow, and the find bar was laid out at the top of that
  flow — underneath the top bar's own band, behind its frosted background, unable to
  receive a tap. Its input focuses on open, so tapping **Find in page** also raised the
  soft keyboard onto a field nobody could see. The back gesture could not close it
  either: it dismissed sheets and fullscreen, but not the find bar, so a user who opened
  it had no way out from the hardware button.

- **First-run setup on Android could be seen or touched.** The mobile content WebView
  is a native view stacked on top of the chrome WebView, so a full-window surface is
  only usable once the shell tells the core to lower it. Surfaces that register through
  the chrome-surface registry — onboarding, the permission prompt, the command palette —
  were not lowering it, because the mobile shell mounted no provider and registration
  silently falls back to a no-op. On a fresh install the onboarding card rendered
  underneath the native view, leaving the one button that dismisses it untappable.

- **“Clear remembered data” for a site left most of that site’s history on disk.** The
  History panel and the padlock both hold only the most recent 200 rows (of up to 5000), so
  clearing a site you had visited more than 200 times removed only what happened to be
  loaded — while the confirmation toast said the site was cleared. Because the History
  search filters the whole store, you could search the supposedly-erased visits straight
  back up. Clearing is now one core operation over every row for that origin, and it
  reports how many it actually removed.
- **Un-checking “allow ads on this site” could not un-allow a subdomain, and made the
  allowlist grow instead.** The allowlist covers a whole site, so a single “allow ads”
  tick on `example.com` also stops the ads on `www.example.com`. The core stores what you
  toggle with an exact comparison, so asking to un-allow `www.example.com` while only
  `example.com` was listed read as “not on the list” and ADDED the address instead of
  removing anything: the tick snapped straight back on, and because allowlisted sites sync
  between your devices, the extra address spread to all of them. The tick is now disabled
  and says which entry is doing the allowing, and tells you to remove that one.
- **The ad-block shield said ad blocking was active on sites where it was not.** The
  allowlist covers a whole site, so allowing ads on `example.com` also stops the ads on
  `www.example.com`. The shield button in the toolbar did not know that: it only recognised
  the exact address you had allowed, so on any other address of the same site it drew a
  filled shield labelled "Ad blocking is active" — directly beside its own popover, which
  correctly said the site was allowlisted. Nothing was actually being blocked. The button now
  understands a site the way the rest of the app already did.
- **A save that failed could make a change from a paired device never arrive.** Settings and
  custom filter lists are each written to a file, and each keeps beside it a record of which
  changes from a paired device it has already applied. That record was updated even when the
  save itself had failed — a full disk, a read-only folder, a permissions problem — so the
  app marked a change as applied that was never written. A later change from the other device
  was then treated as already applied and skipped, and skipped for good. Restoring a backup
  that could not be written had the same effect, by stamping the values that were still on
  disk as newly applied. The record is now only updated after the save it describes
  succeeds, so the change arrives on the next pass instead of being lost without a word.
- **Two settings you changed at once could lose one of them.** The settings file and the
  record of what has been synced are each rewritten by a read-then-write, and nothing
  serialised those two steps. A save from a settings form, a restore of a backup, and a
  merge arriving from a paired device can all run at once, and whichever finished last
  simply rewrote the file without the others' change in it. Nothing was reported: both
  writers succeeded, and the setting you had just changed was quietly gone. Those
  read-then-write regions are now serialised per store, along with the equivalent ones for
  the ad-blocking allowlist and the filter-list subscriptions.
- **A pasted backup could make the app read and delete files outside the subscription
  cache.** Filter-list subscriptions are cached as one text file each, named after the
  list's id. Those ids normally come from a subscription URL, but the app also keeps them in
  its own data — and restoring a backup writes those rows as they were, checking only that
  they are shaped like rows. A row could therefore name a file anywhere on disk: a relative
  id walked out of the cache directory, and an absolute one replaced the directory entirely,
  with the app creating whatever parent directories the path needed before writing.
  Restoring a backup could then have an enabled subscription quietly pull in text from a
  file you never chose, and removing that subscription could delete it. Every subscription
  cache path must now be a single plain file name, checked in one place that all reads,
  writes and deletions go through; adding or enabling a subscription with an unusable id is
  refused with a reason, while removing one still always works, so a subscription carried in
  by a backup can always be cleaned up.
- **Turning on vault sync could never do anything.** Password-vault sync depends on a
  three-step handshake: a joining device adopts the account's shared key salt, and the very
  first device — the one nobody can adopt from — becomes the account's vault by publishing
  its _own_ salt. The third step required already being what it was trying to make you:
  publishing only ran for a vault that had already adopted, adopting only ran for a vault
  that had already adopted, and the only way to have an adopted salt was for one to have
  arrived in a published record that only an adopted vault could publish. A closed circle
  with no way in, so the toggle in settings did nothing at all on a fresh install, and no
  error was ever shown. A second, separate circle made joining unreachable in exactly the
  same way. The first device now publishes its salt when the account has none yet and you
  have opted in, and its vault is then marked as the account's without needing your master
  password — the salt did not change, so there is nothing to re-encrypt. Joining devices
  still re-key for real when you unlock, and still never publish over an account that
  already has a salt.
- **The vault panel could freeze the whole window the moment vault sync was working.**
  Reading vault state held the vault's in-memory lock to take a snapshot and then asked
  whether vault sync is enabled — a question whose answer comes from the very same lock. A
  standard mutex is not reentrant, so asking while holding it waits for itself. It is a
  self-deadlock, not a slow read, and because every renderer call is a synchronous IPC
  command it happens on the UI thread: the window stops responding, permanently, the next
  time the panel is opened on a device where vault sync is actually enabled and the vault is
  unlocked. Nothing warned you — it simply hung. It went unnoticed because each of the
  conditions that triggers it is off in a fresh test: the opt-in defaults to off, a test app
  has no sync engine running, and a new vault is the local-only version. The state read now
  finishes before the question is asked, and a test builds that exact configuration and
  fails if the read does not come back — on a timer, because a deadlock's only symptom is
  silence, and a hung test suite is a poor way to catch one.
- **A restored backup could be silently undone by a background history flush.**
  Browsing history and the downloads list are batched: their live rows live in memory and a
  timer rewrites the file from that cache every three seconds. `data.import` wrote the
  imported file first and dropped the in-memory cache _afterwards_, so the whole store loop
  was a window in which a flush tick wrote the pre-import rows straight back over the file the
  import had just written — and the import reported success. Restoring a backup could
  therefore leave you with your old history, with nothing on screen saying so. The caches are
  now dropped **before** any file is written (so a concurrent flush finds nothing to write)
  and again afterwards (discarding a visit captured in the meantime), and a test runs a real
  background flush from inside the import to keep it that way.
- **A restored backup could report "Import complete." with nothing restored.** Importing
  a bundle wrote each store's file and threw away whether the write had worked, then reported
  success unconditionally — the one store-writing path in the app that discarded its error.
  A backup whose entire history had been lost therefore looked exactly like a complete
  restore, and the per-store row counts, which were tallied from the bundle rather than from
  what landed, said otherwise. The import now names the stores it could not save, counts only
  the ones that landed, and keeps your pasted backup text on screen instead of clearing it —
  the draft is your only copy of what you were restoring.
- **The onboarding privacy preset was a security control nothing exercised.** Choosing
  "Strict" or "Balanced" on first run is the one moment a user is asked how much protection
  they want, and no test had ever picked a radio or pressed "Start fresh" — so the wiring
  between the two presets and `settings.set` was entirely unverified. The string literals are
  type-checked, but the **pairing** is semantic and unguarded: nothing stopped "Strict" being
  wired to the mild values while the UI promised it blocks WebRTC construction, and the
  failure is silent because the core simply rejects a bad value, so a user asking for maximum
  protection ends up with the defaults. Both presets are now driven through the real UI, and
  a test asserts they **differ**, so a copy-paste that sends one for both cannot pass.
- **The native tab shortcuts (Ctrl+T / Ctrl+W / Ctrl+Shift+T / Ctrl+Tab / Ctrl+1..9) had
  zero coverage.** These arrive from the core as a `tabs.shortcut` event and are mapped to tab
  actions in the chrome; the mapping — including the wrap at both ends of the list and the
  guard against a jump past the last tab — was untested. Six cases now cover it, each proved by
  removing the whole mapping and watching exactly those six fail; the two negative guards (a
  jump past the end, and no tabs open) pass in both states by design, since they assert that
  nothing happens.
- **`TabStrip`'s virtualization and drag-and-drop were both untested.** The windowed render
  had never been reached because no test opened more than the 50-tab threshold, and the
  whole drag block — drop-to-reorder, middle-click-close, right-click-pin — had no test at
  all. Both are now covered.
- **`SettingsModal`'s roving tabindex was untested**, so keyboard navigation of the settings
  rail was unverified: the arrow-key wrap, `Home`/`End`, the focus moving with the selection,
  and the filtered rail (which is a different list from the unfiltered one) are all now
  driven by real key events.
- **`Sidebar`'s pointer resize and the frame-coalesced width report were untested.** Dragging
  a panel edge had no test, and the `requestAnimationFrame` coalescing is only reachable
  _while a drag is in flight_, so the arrow-key and clamp tests never reached it.

- **Three of the app's shell `CustomEvent` listeners were never actually dispatched by any
  test.** `aegis:toggleSidebar`, `aegis:toggleFavoritesBar` and `aegis:openSettings` had a
  test that asserted only that they are _registered_, so the fix that un-broke both toggles
  and all fifteen "open settings..." palette entries shipped without ever being shown to
  work — emptying a handler's body left the whole suite green. Each is now exercised by
  dispatching the real event and asserting the UI moved, and each toggle test dispatches
  **twice**, because a handler wired straight to `true` satisfies "it opened" and fails the
  close.

- **The farbling shim's UA-CH brand normalisation was not tested at all.** The test guarded
  its real assertions behind `if (navigator.userAgentData)` and fell through to
  `expect(true).toBe(true)` otherwise, and jsdom has no `userAgentData` — so the branch that
  always ran asserted nothing. The shim is covered now by a test that installs a plausible
  pre-shim value, proves the host's own brands differ from the shim's, and checks the
  normalised set twice (a page could otherwise fingerprint the shim by reading the property
  two times). The fail-open half — an absent `userAgentData` must be left absent — became a
  test of its own.

- **Two race tests asserted nothing at all, and passed with their guards deleted.**
  `useOmnibox`'s test unmounted, released a pending history result, and carried only a
  comment saying it "would warn/throw if the guard were absent". It is now a real test of the
  guard's consequence — a result that lands after the omnibox effect is torn down must never
  reach state — proven non-vacuous by deleting the token invalidation and watching exactly
  that one test fail. `useSafety`'s equivalent **cannot** be made non-vacuous through the
  public surface: with its `active` guard removed, a `console.error` spy still records
  nothing, because React 18 removed the post-unmount setState warning outright. It is
  reframed to assert the one thing that is observable (the cleanup tore its subscription
  down) and its comment now says plainly that it is not a witness for the flag.

- **Two cross-boundary platform contracts had no enforcement at all.** A chrome popover that
  measures its own height must register it so the opaque content webview is lowered beneath
  it — `useChromePopover.tsx` says so in prose and even names the historical bug, but nothing
  checked that any popover did it, so a new one that forgot would render _behind the page_ and
  every test would still pass. Separately, the Android shell pushes the real system bar insets
  in as `--aegis-inset-{top,bottom,left,right}` and the stylesheet consumes them, but a
  surface that forgot to consume one renders under the status bar, and a rule consuming a var
  the native side never sets silently falls back to `env(safe-area-inset-*)`, which on an
  Android WebView is only the display cutout. Both are now derived guards: the expected list is
  computed from the code that defines it, so neither class can grow unnoticed.

- **A peer could try to write to your password vault and you would never be told.**
  `sync.vaultQuarantined` is emitted by the core when it refuses a peer-supplied vault
  record — a forgery, or simply a record sealed under a key this device does not hold. It is
  the **only** channel for that outcome (it is in no `state_json`, so there is no polling
  fallback), and both the core's own comment and the shared contract describe it as a
  security outcome worth surfacing, yet **nothing in the UI subscribed to it**. A rejected
  write was therefore completely silent. The Sync tab now shows it as its own alert:
  "A password record from another device failed its integrity check and was rejected.
  Nothing was changed… your existing passwords are unaffected." It is deliberately not shown
  as a sync error, because the sync pass really does succeed — a forged record is not a sync
  failure — and it clears itself once a later pass quarantines nothing, so it cannot become
  a permanent nag.

- **The IPC drift guard's "every event is subscribed" direction could not fail.** It
  searched the renderer sources for the literal `IPC.evt<Key>`, and `src/lib/ipcClient.ts`
  is one of those sources and _defines_ that exact literal for every event it wraps — so the
  transport was satisfying the search on its own behalf. Deleting a real subscription
  (`useNav`'s `aegis.nav.onState`) still left the guard green. It now derives each event's
  wrapper surface by parsing the transport, excludes the transport from the subscriber
  search, and looks for the actual `aegis.<ns>.on<Name>(…)` call. Four new anti-vacuity
  tests pin that, the decisive one asserting the transport cannot subscribe to itself. The
  first run of the repaired direction found three real defects — events with a wrapper and
  no caller — one of which is the vault-quarantine gap above.

- **A closed tab left its anti-malvertising chain behind, on three of four platforms.**
  `redirect_guard::Chains` is written by both the two-phase path (Linux) and the
  single-phase `block_at_start` (Windows/Android), but it was only ever cleared from the
  Linux top-frame Response handler. So a closed tab's entry survived — a small leak with
  one real consequence, because a hand-edited `tabs.json` or a restored backup can hand
  back a reused tab id, and the reusing tab then inherited a chain belonging to a tab that
  no longer exists. `tabs::forget_closed_tab` now drops both per-tab redirect-guard
  records on every platform, and the two `allow(dead_code)` attributes that were
  suppressing the cleanup on Android and Windows are gone.
- **A reusing tab id inherited the dead tab's block count, so the shield badge reported
  blocks for a page the user never visited.** `adblock::PAGE_BLOCKED` had no remover at
  all: unlike every other tab-keyed process-global table, nothing ever dropped an entry
  for a closed tab. It is now cleared on close, which also matters because id allocation
  only skips ids still in the registry, so a restored backup can legitimately reuse one.
- **A corrupt `webrtcPolicy` silently switched the WebRTC IP-leak defence OFF.** The
  setting reader defaulted only when the value was _absent_ and otherwise returned the
  stored string verbatim, and every consumer fails OPEN on an unrecognised value: the shim
  builder returns nothing at all, the Windows `--force-webrtc-ip-handling-policy` argument
  is omitted (leaving Chromium's default policy, which leaks local IPs), and the WebKitGTK
  backstop only enforces `disable`. A corrupt value could arrive through an imported
  bundle or a synced settings record. The reader now clamps anything unrecognised to
  `public-only` — the app's own default AND the protective tier — and shares one list with
  the validator so the two cannot drift. `default` stays a distinguishable opt-out.
- **HTTPS-Only was hardcoded ON on Android, breaking the plain-HTTP intranet hosts the
  setting exists to allow.** A user who turned `httpsOnly` off had their intranet host
  rewritten to `https://` on Android and the site simply stopped loading, with nothing in
  the UI saying Android was stricter — the Kotlin comment even read "matches the desktop
  default-on", as if the default were the policy. Android now reads the setting through a
  Rust mirror that is seeded at boot and refreshed on every settings write, and the
  getter fails TOWARDS upgrading if it cannot ask.
- **The shield badge said "Blocked here" for a number that is not requests we blocked.**
  On Linux the count is fed by a signal that fires only for requests the declarative
  content filter ALLOWED; the requests the filter stops outright are cancelled before
  that signal and are never counted, so the number is a lower bound. It is now "Ads
  caught here", the one word true on all three platforms, with the per-platform
  difference explained in the popover.
- **The farbling UI told the user a reload was unnecessary when a reload is exactly what
  is needed.** The anti-fingerprinting copy said the noise was "regenerated each
  session"; the seed is in fact baked in per tab, so a level change only reaches newly
  opened or reloaded tabs and an open tab keeps the seed it was born with. A user
  changing the level mid-session would conclude the setting was broken.
- **The privacy badges disagreed with the privacy machinery.** The shield badge reported
  the WebRTC policy but not the per-host exemption, so a site the user had exempted —
  exactly the site a script can read real local IPs from — showed "WebRTC IP protection:
  Public only" in green. Both badges also re-implemented the allowlist scope rule with an
  exact `Array.includes`, while the core treats a listed host as covering its subdomains,
  so allowlisting a domain reported its subdomains as fully protected. One
  `hostCovered` helper in `lib/url.ts` now mirrors `adblock::host_covered`, and the
  exemption is required rather than defaulted so a caller cannot forget it and silently
  report "not exempt".
- **A sync record could turn the WebRTC IP-leak defence off, on every device, silently.**
  The per-site WebRTC escape hatch reused the AD-BLOCK allowlist, and that list is in
  `sync_stores::SYNCABLE`. Every synced setting/store is writable by any device holding
  the account's data key — that is what the sync contract grants — so one record on one
  paired device permanently disabled WebRTC filtering for a host on every device the user
  owns, and no UI anywhere reported a sync event as the cause. WebRTC is now its own
  store, `webrtc-allowlist`, deliberately absent from `SYNCABLE`; it mirrors the existing
  `fp-allowlist` (separate store, separate IPC, separate UI list in Settings > Security >
  "Sites with WebRTC protection off"). The ad-block allowlist stays synced and keeps its
  own meaning. Match scope is still `adblock::host_covered`, so the two lists cannot drift
  in what they match. Known gap, left as a follow-up: the shield badge
  (`lib/protectionSummary.ts`) still reports the policy, not the per-host exemption.
- **`syncVault` was synced.** The opt-in that includes the password vault in E2E sync is
  now local-only, like `syncAllowInsecure`. Same mechanism, same reason: it is a switch
  whose flipped state moves data off this machine, and while it was synced one record on
  one paired device turned credential upload on everywhere. It was already not sufficient
  alone — a vault with its own per-device salt cannot sync until it adopts the account's
  shared salt — so this costs one tick per device.
- **A `file:` URL could reach `tabs.json` and persist across launches.** `on_tab_url` runs
  on every page load and wrote the URL with no scheme check, which made its sibling
  writer's own comment ("the last point at which a non-navigable scheme can be caught
  before it is written to tabs.json") false. The navigation policy itself had no scheme
  check at all, so a page-initiated `location = 'file:///…'` was never refused. Both
  halves now consult the single `is_navigable` definition.
- **A URL carrying userinfo was accepted** for `homeUrl`, `syncServerUrl` and
  `defaultSearchTemplate` — e.g. `https://bank.example@evil.example/`. Browsers strip
  userinfo from the address bar, so the displayed host is the real one and the disguised
  one is invisible; `homeUrl` re-loads every launch and `syncServerUrl` is a request the
  sync client makes, possibly in cleartext.
- **`Cred` and `UnlockedVault` derived `Debug`.** A `{:#?}` on either printed the vault key
  and every password in cleartext — and those are exactly the types a developer prints
  when a vault looks wrong. Both now have a hand-written redacting `Debug` that still
  distinguishes "empty" from "present but secret".
- **A serde error could echo decrypted plaintext into stderr.** Deserialising a synced
  credential into the typed `Cred` reports the offending value
  (`invalid type: string "…", expected i64`), and that string was written to the user's
  terminal, a CI log or a bug report by the quarantine log line. Errors over decrypted
  data are now reported as category + line + column.
- **Every export overwrote the previous one.** Exports are now named
  `aegis-export-<epoch-ms>.json`, so a user who exported twice has two bundles; the
  import-without-paste fallback resolves to the most recently written one. A backup tool
  that silently destroys the previous backup is worse than one that refuses.
- **The omnibox rejected every `host:port`.** RFC 3986 allows `.` and digits in a scheme
  name, so the scheme test matched `example.com:8080` and `new URL` parsed it with the
  protocol `example.com:`, which failed the http(s) allowlist. The result was
  "Aegis can only open web (http and https) addresses" for `localhost:8080`,
  `example.com:8080`, and every other letter-leading `host:port` — the single most
  common thing a developer types. `127.0.0.1:3000` was separately mangled into
  `https://127.0.0.1:3000` (a TLS handshake failure, not a page) and `[::1]:8080`
  became a search. A `host:port` pair is now recognised as a host before the scheme
  test: loopback names get `http://` (provably this machine, so no cleartext request
  can leak off-box) and everything else gets `https://`, so an intranet name is never
  silently downgraded. A dotless `wiki:8443` is still refused on purpose — it is
  shape-identical to `javascript:1`, and refusal is the fail-safe answer.
- **A failed tab spawn left a permanently dead tab.** `spawn()` swallowed the error while
  the registry row was already `live` and already persisted to `tabs.json`, and
  `activate` on a live tab is a no-op — so it could never be retried, and session restore
  re-spawned it and failed identically on every subsequent launch. Both spawn arms now
  roll the row back.
- **The "Stop" button reloaded the page.** The toolbar renders an X when `state.isLoading`
  and the core used to `reload()` unconditionally. The core now tracks per-tab loading
  (it produced the flag and discarded it) and abandons the load by navigating to
  `about:blank`, which cancels an in-flight load on all three engines. wry, Tauri and
  tauri-runtime-wry expose no `stop()` and no `is_loading()` at all, so this is the
  strongest stop the current dependency set allows.
- **On Windows, the FindBar wiped its own input.** WebView2's `ICoreWebView2Find` is a
  one-way API with no term getter, and both change handlers — installed once at spawn,
  before any query exists — emitted a hardcoded empty query ~120 ms after each keystroke.
  The renderer treats `find.state` as an authoritative snapshot, so "no query to report"
  was indistinguishable from "clear what the user is typing". The live query is now
  remembered per tab and carried in every emit.
- **`safety.proceed` had no scheme gate.** It navigated for any scheme, and for a hostless
  one recorded no exception — so the warning was dismissed while the block stayed armed.
  It now refuses anything but http/https before recording or navigating.
- **The navigation policy had no scheme check at all.** `decide_navigation` ended in
  `return true` after the overlay, malware, ad-block and HTTPS-Only checks — none of which
  had run — so a page-initiated `location = 'file:///…'` was not refused. It now consults
  the one existing `is_navigable` definition, before every destination-reasoning check.
- **A `file:` URL could reach `tabs.json` and persist across launches.** `on_tab_url` runs
  on every page load and wrote the url with no scheme check, which made its sibling
  writer's claim to be "the last point a non-navigable scheme can be caught" false — that
  file is what session restore re-spawns from.
- **Tab and workspace ids could collide at the `u32` ceiling.** Four allocation sites did
  `next_id += 1` / `max_id + 1`; a hand-edited `tabs.json` with id `4294967295` wraps to 0
  in release, after which `create` hands out ids already in use and closing a tab destroys
  a different tab's row. Allocation now skips occupied ids.
- **A tab switch in fullscreen clobbered the saved window size.** The renderer's effect is
  keyed on the active tab, so switching tabs in fullscreen re-sent "enter fullscreen" and
  captured the current fullscreen size — so leaving fullscreen restored a monitor-sized
  window, the exact bug the save slot exists to prevent.
- **`Workspace.tab_index` went out on the wire under the wrong name.** `shared/types.ts`
  declares `tabIndex`; the serialised struct had no rename, so the wire carried
  `tab_index`. No live symptom (the renderer only reads `id`/`name`/`color`, and
  reordering rides the array order), but the contract declaration was lying. The on-disk
  shape deliberately keeps `tab_index` — renaming it would need a read alias, and an
  unknown JSON field is silently ignored, so every existing workspace would come back at
  index 0.
- **Closing a tab from the UI left a stale suppression flag.** The programmatic close path
  cleared the content/loading sets and the `tabs.close` channel did not — and the channel
  is the one users press.
- **The 30-second redirect auto-close did webview work off the main thread** on every
  platform. On Linux the underlying WebKitGTK objects are not `Send` at all, so this was
  undefined behaviour rather than a warning. The close now hops to the main thread; the
  budget slot is released outside the hop so it comes back even during shutdown.
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

- **jsdom 25 → 28, which removed the last deprecation warning from `npm ci`.**
  `whatwg-encoding@3.1.1` is deprecated in favour of `@exodus/bytes`, and it is the newest
  version published, so there was no upgrade of _it_ to make — the module had to leave the
  tree. It came in through `jsdom` and `html-encoding-sniffer`, and **28 is the lowest jsdom
  that drops it**; it is also the highest whose `engines` still match this repo's declared
  Node floor (28: `^20.19.0 || ^22.12.0 || >=24.0.0`; 30 would have silently raised the
  effective floor to `^22.22.2`). The warning is gone: a real `npm ci` went from one
  `npm warn deprecated` line to none, confirmed by running it both ways. Two of the four
  documented jsdom gaps closed as a side effect — `PointerEvent` now exists and
  `fireEvent.pointerDown(el, { pointerId: 7 })` delivers its init again, and
  `fireEvent.scroll(el, { target: { scrollLeft } })` writes `scrollLeft` again. Worth
  recording _whose_ gap those were: `@testing-library/react` is 16.3.2 in both lockfiles and
  never changed — it was falling back to a plain `Event` because jsdom lacked the
  constructor. The pointer-**capture** trio is still missing and `fireEvent.auxClick` still
  does not exist. All 120 test files and 1697 tests pass unchanged, and the renderer
  coverage ratios are identical to the digit (88.17 / 86.73 / 85.07 / 81.2).
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
