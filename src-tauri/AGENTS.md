# src-tauri/ — Rust core + native platform code

The Tauri 2 backend: window/webview management, the IPC dispatcher, data
persistence (JSON stores), the multi-platform ad-block + malware engines, and
native code for Linux (GTK/WebKit), Windows (WebView2 COM), and Android (JNI/Kotlin).

Crate: binary `app` (`src/main.rs` → `app_lib::run()`); library `app_lib` (`src/lib.rs`).

## Layout

```
src-tauri/
├── src/                # Rust source (modules below)
├── capabilities/       # Tauri permission grants (default.json) — the WHOLE surface
│                      #   (withGlobalTauri is off); see "What the chrome is allowed
│                      #   to call" below
├── gen/android/        # generated Android project + hand-written Kotlin bridge
├── icons/              # app icons (png/ico/icns)
├── resources/          # bundled filter lists (easylist.txt, easyprivacy.txt, peter-lowe.txt, abuse-tlds.txt, malware-hosts.txt)
├── target/             # cargo build output (gitignored)
├── Cargo.toml          # deps, incl. platform-gated blocks
├── tauri.conf.json     # app config, CSP, bundle targets, updater endpoint+pubkey
└── build.rs            # delegates to tauri_build::build()
```

## IPC dispatcher pattern

All renderer calls land in **one** `#[tauri::command] ipc(channel, payload)` in
`lib.rs`, which matches `channel` (names from `shared/types.ts`) and routes to the
owning module. Events go out via `emit_event()`, which **translates `.` → `:`**
(Tauri 2 forbids dots in event names; the JS side reverses it). Never emit a raw
dotted event name.

## Module map (`src/*.rs`)

- **`lib.rs`** — app setup + `ipc()` dispatcher + `emit_event()`. Installs the
  rustls aws-lc-rs crypto provider once; sets Linux env workarounds (see gotchas).
- **`main.rs`** — thin entry; calls `app_lib::run()`.
- **`tab_registry.rs`** — pure (Tauri-free, fully unit-tested) tab state machine:
  lifecycle (`create`/`activate`/`close`/`reopen_closed`), pinned/reorder,
  per-tab back/forward history (`record_nav`/`go_back`/`go_forward`),
  time-based idle sweep (`sweep_idle`), session (de)serialization
  (`to_persisted`/`restore`). 58 unit tests.
  **The per-tab back/forward stack is capped** at `MAX_NAV_HISTORY` (100 entries). It
  was the one long-lived collection in the crate with no bound - one `String` per
  navigation, per tab, for as long as the process lives - while `history.rs`
  (`MAX_ENTRIES` 5000), `downloads.rs` (`MAX_DOWNLOAD_ENTRIES` 1000) and `picker.rs`
  (`MAX_FILTER_BYTES`) all cap themselves. `trim_history` drops from the FRONT, because
  `record_nav` always leaves the current page as the LAST entry, and shifts
  `hist_index` by the same amount, so `go_back`/`go_forward` keep addressing the URLs
  they addressed before. A tab that has walked back to the clamped end reports
  `can_go_back == false`, which is the honest reading: the steps were discarded, not
  mis-addressed. `history` is in-memory only - `PersistedTab` has no such field - so
  the cap bounds one session's memory, not the on-disk `tabs.json`.
  **Id allocation can never collide.** `alloc_tab_id` (used by `create_private` and
  `reopen_closed`) and `alloc_workspace_id` skip occupied ids instead of trusting
  `next_id += 1` / `max_id + 1`. Four sites overflowed: a hand-edited `tabs.json` with a
  tab id of `4294967295` wraps to 0 in RELEASE (a debug build panics instead), and
  `create` then hands out ids already in use — and `idx(id)` returns the FIRST match, so
  closing tab 1 destroyed tab 3's row. `ws-4294967295` wrapped to `ws-0` the same way.
  The exhaustion path **panics on purpose** and must not be "fixed" into a silent
  fallback: a duplicate id silently destroys the wrong tab's row (unrecoverable), whereas
  a panic at ~4 billion tabs is visible. (Ruled out while auditing: `restore` does not
  panic on `"tabs": []` — it returns early at `session.tabs.is_empty()`.)
  **Two struct names for two boundaries, deliberately.** `Workspace` serialises
  `tab_index` as **`tabIndex`** (the `tabs.state` wire, per `shared/types.ts`); the
  on-disk `PersistedWorkspace` keeps **`tab_index`** and has a round-trip test. Renaming
  the persisted one would need a read alias, and because an unknown JSON field is silently
  IGNORED rather than a hard failure, every workspace in every existing `tabs.json` would
  come back at `tab_index: 0` — quietly losing the user's saved order.
- **`tabs.rs`** — Tauri layer over the registry: `tabs.*` IPC dispatch, applies
  spawn/close decisions to child webviews, the idle-sweep background thread
  (`start_idle_sweep`), `tabs.json` session persistence, `open_background`
  (called from `on_new_window` to open target=\_blank links as background tabs —
  but `on_new_window` first drops the request if the ad-block engine flags the
  destination as an ad pop-under; see Ad-block below). **Unit-tested via
  `test_support::with_tmp_app`:** session round-trip, private-tab exclusion,
  title/pinned persistence, reorder, idempotent persist, `managed_registry`
  well-formedness, `is_private`, spawn-failure rollback, the `on_tab_url` scheme
  gate, `forget_closed_tab` (19 tests).
  **`on_tab_url` enforces the same scheme policy as its sibling writer.** It runs on
  every `PageLoadEvent` and writes the url into the registry + `tabs.json`, and it had
  NO scheme check — so the `tabs.recordNav` arm's claim to be "the last point at which a
  non-navigable scheme can be caught before it is written to tabs.json" was false, since
  session restore re-spawns tabs FROM that file. It now refuses via `nav::parse_navigable`
  (log + return, no persist because nothing changed) rather than growing a second
  scheme list. **`forget_closed_tab(id)` is one definition for both close paths.** The
  programmatic `close_tab` and the `tabs.close` IPC arm used to disagree, and the arm is
  the one users press. It is not tidiness: `nav::tabs_with_content()` and `TABS_LOADING`
  are suppression sets, and `alloc_tab_id` only skips ids still in the registry, so a
  hand-edited `tabs.json` or a restored backup can hand back a free id that a stale flag
  then suppresses. It clears SIX process-global tab-keyed tables —
  `nav::forget_tab_content`, `nav::forget_tab_loading`,
  `redirect_guard::clear_tab_actions`, `redirect_guard::clear_chain`,
  `adblock::forget_page_blocked` and `find::forget_query_on_close` — the last being the
  only one that was missing, because the find-session store's own doc promised that a tab
  with no recorded session would report an empty query, and nothing tore the session down
  on close. The find half is split the same way as everything else here: the hook's BODY is
  `find::tests::the_tab_close_hook_removes_the_recorded_term` and the WIRING is this
  function's own test, so deleting the call turns the wiring test red and leaves the body
  test green. **A failed `spawn_tab` rolls the tab back**
  (`Registry::mark_spawn_failed` / `tabs::on_spawn_failed`, called from both spawn arms):
  `spawn()` used to swallow the error while the row was already `live` and already
  persisted, and `activate` on a live tab is a no-op — so the tab could never be retried
  and session restore re-spawned it and failed identically every launch.
- **`nav.rs`** — content webview creation (`spawn_tab(id, url)`, replaces the
  old `spawn_content`), navigation callbacks (malware guard, HTTPS-Only upgrade,
  **ad-block: `on_navigation` cancels loads of blocked ad/tracker destinations** via
  `should_block` — catches pop-under redirect chains whose final ad domain `on_new_window`
  never saw, and ad iframes, on every desktop; Android does the equivalent in
  `shouldInterceptRequest`), emits `nav.state`/`nav.failed`. Active webview now accessed via
  `active_content_label()`/`active_webview()` (refactored from the old single
  `CONTENT_LABEL` constant).
  **`nav.failed` must not report a load Aegis stopped itself.** `decide_navigation` cancels
  for a non-navigable scheme, an open full-window overlay, a malware host, an ad/tracker
  document and the HTTPS-Only upgrade, and WebKit turns each of those into a policy error
  `102` (`WEBKIT_POLICY_ERROR_FRAME_LOAD_INTERRUPTED_BY_POLICY_CHANGE`) on the in-flight
  load. `linux_layout::connect_load_failed` therefore consults
  `is_self_inflicted_load_interruption` and swallows only that code — the policy code space
  is 100/101/102/103/199 and the `WEBKIT_NETWORK_ERROR` family is 300-399, so 102 cannot
  be a real network fault, while every other code is still reported. Without this the
  error overlay told the user to "check the address and your network connection" for a
  navigation the address and the network were fine for.
  **ONE scheme policy, in TWO scopes: `is_navigable` (http/https/`about:blank`) records an
  address; `is_page_navigable` is that plus `about:srcdoc` and is the LOAD gate.**
  `decide_navigation` consults the latter as its FIRST check, before the overlay, malware,
  ad-block and HTTPS-Only checks — every one of which reads the destination as an ordinary
  web address. It previously ended in `return true` with no scheme test at all, so a
  page-initiated `location = 'file:///…'` was not refused by the navigation policy, which is
  what made the `tabs::on_tab_url` hole below reachable. `require_navigable`/`parse_navigable`
  are the fallible spellings of the RECORDING list (they name the refused scheme for the
  error toast), and a second list is how `file:` reached `tabs.json` in the first place.
  Recording callers: `tabs::on_tab_url`, the `tabs.recordNav` arm,
  `open_redirect_background`, `nav.home`, `tabs.create` and `safety.proceed`.
  **Why `about:srcdoc` is load-only, and why that is safe.** Cloudflare's Turnstile builds
  its widget inside a sandboxed iframe loaded via `about:srcdoc`, and WebKitGTK surfaces
  that as a `decide-policy` navigation — so the strict gate cancelled it and the challenge
  spun on `Just a moment...` forever (measured: the honest-UA build still hung, and allowing
  this one scheme made the SAME binary load the page in under 6 s). The widening grants
  **no capability**, which is the distinction that matters: the scheme that actually
  mattered here was `file:`, because it gave a page something new — a local filesystem read.
  `about:srcdoc` gives nothing, because its content comes from the frame's own `srcdoc`
  ATTRIBUTE, so identical markup was already renderable with no navigation at all; it cannot
  read the filesystem, and the content webview cannot reach the IPC chokepoint
  (`withGlobalTauri` off ⇒ `window.__TAURI__` undefined, which is why `vault_inject` is
  inert). **It is deliberately NOT in `is_navigable`,** so `tabs.recordNav` cannot persist
  one — a sandboxed `about:srcdoc` frame has no `src` and nothing can fetch the URL, so it
  would be a blank entry in `tabs.json` that session restore re-spawns every launch.
  **Android deliberately does NOT mirror the load widening** (`isLoadableUrl` stays strict,
  and `nav::tests` still pins it to `is_navigable`): WebView does not route an
  `about:srcdoc` iframe document through `shouldOverrideUrlLoading` at all, and Turnstile
  completes there today, so Android is simply the more restrictive of the two.
  `decide_navigation` has **no frame flag** (gotcha 13), so this cannot be narrowed to
  subframes — the only frame-aware hook fires after the request went out.
  Four tests hold the split (`a_page_may_load_about_srcdoc_but_it_is_never_recorded`,
  `about_srcdoc_is_the_only_thing_the_page_gate_widens`,
  `the_page_gate_admits_exactly_the_recorded_set_plus_a_bare_srcdoc`,
  `the_page_navigation_gate_is_the_one_decide_navigation_consults`), all mutation-verified:
  reverting the gate to `is_navigable` reds only the wiring pin; dropping the srcdoc arm
  or **widening `is_navigable` itself** each red the load/record pair; smuggling a SECOND
  widening (`data:`) into `is_page_navigable` reds only the "only thing" test. The wiring
  pin is a `rust_production_source` text pin because `decide_navigation` takes a concrete
  `&AppHandle` and no `MockRuntime` test can reach it.
  **Android now enforces that same list instead of a second one wearing a prefix
  test's clothes.** `makeContentClient(id)`'s `shouldOverrideUrlLoading` read
  `if (!raw.startsWith("http")) return false`, and in `WebViewClient` returning
  `false` means "let the WebView proceed" — so a page-initiated main-frame
  navigation to `data:`/`file:`/`content:`/`blob:` was ALLOWED, while the typed and
  programmatic paths (`Bridge.navigate` → `blockReason` → `showMalwareWarning`)
  refused the very same URL. It now consults `isLoadableUrl(raw)` and, on refusal,
  logs and shows the block page that path already used. `isLoadableUrl` also used to
  accept ANY `about:`; it now allows only `uri.path == "blank"`, matching
  `is_navigable` — two lists with two scopes is the same mistake as `file:` reaching
  `tabs.json`. **Both Kotlin bodies are pinned from the Rust suite** (`nav::tests`
  reads `gen/android/…/MainActivity.kt` as text through `CARGO_MANIFEST_DIR`): there
  is NO Kotlin test source set, so a source-text pin is the only thing that can catch
  a future Kotlin edit, and it fails the Rust suite on drift. A textual check can be
  satisfied by a comment, so both asserts read a COMMENT-STRIPPED copy of the body.
  **Handing a URL to another app is a third, DELIBERATELY narrower policy — and it is
  not the same decision.** `Bridge.openExternal` is a `@JavascriptInterface` method on the
  CHROME webview, so anything that can run script in the chrome document can call it, and it
  fires `ACTION_VIEW` on whatever string it is handed: an `intent:` URL is a fully specified
  action+component the caller chooses, and `file:`/`content:` are filesystem and
  content-provider reads in the receiving app's context. It now consults
  `isExternallyOpenableUrl`, which allows `http`/`https` and nothing else. `about:` is
  deliberately ABSENT even though `isLoadableUrl` allows `about:blank` — a page-in-tab
  navigation and a hand-to-another-app are different questions, so the list is separate rather
  than shared, and the refusal string is a separate constant
  (`EXTERNAL_SCHEME_REASON`, not `SCHEME_REASON`) so the two messages cannot drift into one
  another. The one non-test caller is a hardcoded https release URL, so nothing the app does
  loses. Pinned from `nav::tests` by the same Kotlin-text mechanism, and the pin asserts the
  CALLER (`openExternal` consults it and returns before `startActivity`), not just the helper —
  a helper nothing calls is exactly the kind of dead code that survives a widening like this.
  **A full-window chrome overlay now also cancels a page-initiated navigation on
  Android, as it already did on desktop.** `decide_navigation` refuses when
  `lay.overlay && !lay.sidebar` — its own comment says why: the user is not driving
  the page, and malvertising fires top-frame redirects on the resize/blur that
  opening Settings/Downloads/shield causes. Android's `overlayHidden` (set by
  `setContentHidden`, which is what `view.setChromeOverlay` calls there) was
  VISIBILITY-only, so the destination still reached `pageUrls[id]` and
  `NativeHistory.recordVisit` and the user got a history row for a page they never
  opened. The main-frame hook now refuses **before** the redirect guard, in the same
  order `decide_navigation` uses, and the refusal is deliberately SILENT — the page is
  covered, nothing is visible, and the user comes back to the page they were on.
  There is no sidebar tier on Android (`MobileApp.tsx` only ever calls
  `setChromeOverlay`), so `lay.overlay && !lay.sidebar` reduces to that one flag.
  `nav::tests` pins three halves from the Rust suite: the guard exists, its block
  actually `return true` (a log-only guard would be the same bug wearing a message),
  and it appears **before** `redirectBlocked(` — a guard in the wrong order lets the
  malvertising hop through the one path this exists to stop. It also pins that
  `setContentHidden` still assigns `overlayHidden`, because a rename would leave the
  guard permanently false and look exactly like the bug.
  **Kotlin's `documentStartScriptCache` is now BOUNDED — it was not, and one entry is
  ~1 MB.** The cache is keyed on `(adblock toggle, host)` and nothing ever evicted it,
  so a session visiting N distinct hosts (×2 toggle states) grew the process by N MB
  for the life of the process, and a user who left a tab open on an ad-heavy site paid
  for it on every later tab. It is now an **access-ordered `java.util.LinkedHashMap`**
  behind a `documentStartScriptLock`, with `MAX_DOCUMENT_START_CACHE_ENTRIES = 32` and
  an LRU eviction (`entries.iterator()`, `hasNext()`, `next()`, `remove()`) taken
  _before_ each store. Three details are load-bearing rather than cosmetic:
  **`LinkedHashMap`, not `ConcurrentHashMap`** — `ConcurrentHashMap` has no order, so an
  iterator over it cannot yield the least-recently-_used_ entry, and the eviction would
  be arbitrary; **`documentStartScriptLock`**, because `documentStartScript` is called
  from the UI thread when a tab is created _and_ from the boot warm-up worker, so the
  "concurrent" map was not in fact being mutated by one thread; and the bound is
  checked on the way **in**, so the cache never exceeds it. A JNI failure still returns
  `""` and is still deliberately NOT cached, so a later tab retries instead of pinning a
  failed layer. `nav::tests` pins the field's exact type, the bound's value (parsed as a
  plain integer and required to be in `2..=4096`, so `Int.MAX_VALUE` cannot pass as a
  bound), the presence of `eldest.remove()` and `eldest.hasNext()`, and the
  `synchronized(…)` — again read from the Rust suite because there is no Kotlin test
  source set.
  **`nav.reloadOrStop` actually stops.** The toolbar renders an X with `aria-label="Stop"`
  when `state.isLoading`, and the core used to `reload()` unconditionally. `TABS_LOADING`
  **A title the page sets itself is not a navigation.** `on_page_load` fires once per
  navigation, so a page that changes its own `document.title` afterwards — an SPA route
  change, a Gmail unread count, a video title — left the tab strip showing the title
  from page load, permanently. The wry builder registers **`.on_document_title_changed`**
  (note: the hook is `on_document_title_changed`, NOT `on_page_title` — grepping the
  wrong name finds nothing and looks like a missing feature) and re-emits `nav.state` through
  the existing `emit_state`, re-reading the URL from the webview rather than a spawn-time
  capture. Android gets the same event from `WebChromeClient.onReceivedTitle` in
  `MainActivity.kt`, which re-uses `pushNavState` — that payload already carried
  `title`. **wry's own Android title hook is dead code here**: the content WebView on Android
  is the app's native Kotlin one, because `spawn_tab` is `#[cfg(desktop)]` (its Android
  counterpart at the bottom of `nav.rs` is a no-op). The chrome-side handler is
  `useTabTitleSync`, which calls `tabs.setTitle` — the channel that sets a title
  WITHOUT pushing nav history or re-validating an unchanged URL, which `tabs.recordNav`
  would have to do. Both Rust halves are pinned by tests in `nav.rs` (there is no Kotlin
  test source set, so the Kotlin half is a source-text pin).

  discarded it. **wry 0.55.1, tauri 2.11.3 and tauri-runtime-wry 2.11.3 expose no `stop()`
  and no `is_loading()` at all** (grepped all three), so the stop is
  `navigate(about:blank)`, which cancels an in-flight load on all three engines and is
  already the app's blank-page target. `reload_or_stop<R: Runtime>` is generic over the
  runtime so a test can reach the branch with no content webview, and the **state half runs
  before the webview lookup on purpose** — `w.navigate` can fail, and waiting for a
  `Finished` load edge that will never arrive would leave a tab stuck "loading" forever.
  The `navigate` call itself is compile-verified only (no webview on the mock).
  **The `nav.*` dispatcher is generic over `R: Runtime` too, so the mock harness can
  drive it — and the arms that need a webview are reached through their STATE side
  effects instead.** `PendingNavs` (`nav.reloadOrStop`'s stop branch) and the per-tab
  history in the registry (`nav.back`/`nav.forward`) are both plain state, which is what
  makes the tab-id resolution observable: an explicit `viewId` acts on THAT tab, and a
  **stale** one (a tab that closed between the state the chrome read and the click) is a
  no-op rather than a fall-back to the active tab, which would navigate the tab the user
  is looking at. Two arms stay compile-verified only: the `navigate` calls themselves,
  and `nav.home`'s point-of-use `require_navigable` check, which sits INSIDE
  `if let Some(w) = content` and is therefore unreachable from the mock. `nav.navigate`'s
  scheme refusal IS reachable, because it is decided BEFORE the webview lookup — that
  ordering is the policy, not an accident, so a fix that moved it would be caught.
- **`view.rs`** — content webview geometry: insets, sidebar, fullscreen, overlay.
  **Desktop fullscreen now drives the OS window.** `view.setFullscreen` calls
  `Window::set_fullscreen(on)` (`#[cfg(desktop)]`) in addition to the content-webview
  relayout, so the window takes over the monitor (titlebar hidden). On Linux,
  `linux_layout::exit_fullscreen` (Esc / floating exit button) also calls
  `set_fullscreen(false)` directly. Backend call — no capability change. Android fullscreen
  is the immersive `setFullscreen` bridge (hides the system bars) instead.
  **The `SAVED` slot is captured exactly once, guarded twice.** `should_capture_saved(entering,
already_fullscreen, slot_empty)` is the whole policy, as a pure predicate so it is testable
  on any host. `App.tsx`'s effect is keyed on `[tabs.activeId, fullscreen]`, so **a tab
  switch while fullscreen re-sends `on: true`**; capturing on that re-send stored the
  CURRENT fullscreen inner size, so Esc restored a monitor-sized window — the exact bug
  the slot exists to prevent. Both guards are load-bearing: `already_fullscreen` (read from
  `Window::is_fullscreen()`) catches a re-send arriving after the WM applied fullscreen,
  `slot_empty` catches one arriving before it does; either alone leaves a hole. The capture
  is `#[cfg(desktop)]` and always has been, so the predicate is `#[cfg(any(desktop, test))]`
  — a cfg gate, because having no Android caller is the truth (Android has no OS window
  to take over). Honest limit: the policy is unit-tested; the real WM transition and a real
  tab switch are not (no window on the mock runtime).
  **All six `view.*` arms are now unit-tested, and that needed a widening.** `dispatch`
  (PLACE 2 of the three-place rule) took a concrete `&AppHandle`, so no `MockRuntime`
  test could reach it — and neither could the four helpers every arm ends in:
  `layout_of`, `apply_visibility`, `apply_inset` and `update`. All five are generic over
  `R: Runtime` now, and so are the six `linux_layout` helpers they reach:
  `set_content_visible_label` / `set_content_visible` (for `view.setContentVisible`),
  `layout`, `size_fixed_children`, `fs_exit_button` and `exit_fullscreen`. Every one of
  those bodies used only runtime-INDEPENDENT Tauri APIs (`try_state`, `get_webview`,
  `webviews`, `get_window`, `with_webview`) — `linux_layout::apply_proxy_label` was
  already generic on exactly that evidence — so this was a signature change with no body
  edit, and the only production caller (`lib.rs`'s `ipc()`) still infers `Wry`.
  **What the tests can and cannot see.** On a `MockRuntime` the native half is an
  honest no-op (there is no window and no content webview), so the observable is the
  managed `ContentInset` layout each arm leaves behind — which is precisely what
  `linux_layout::layout`, `nav::decide_navigation` and the resize handler read. The
  tests therefore pin the `unwrap_or` DEFAULTS, since a malformed or partial payload is
  what actually reaches an arm: a missing `inset.top` is `0.0` and NOT the built-in
  `DEFAULT_INSET_TOP` (164.0), a missing `active` is `false` and not "open", a missing
  `width` is `SIDEBAR_WIDTH`, a missing `visible` is `true`, and a missing `on` is an
  exit. They also pin that the right inset is the panel width only WHILE the panel is
  open (and only `setLayout` — `setSidebar` is a NEGATIVE pin, not a positive one:
  `view.rs`'s `view_dispatch_declines_every_channel_it_does_not_own` lists
  `"view.setSidebar "` WITH ITS TRAILING SPACE precisely so the router must DECLINE it,
  and the channel was removed in `20cd725`; a doc that reads the pair as two pinned
  channels is reading a negative pin as a positive one), that `setLayout` replaces the
  overlay and
  sidebar flags together in one `update` (the deliberate atomic update that removed a
  mid-transition race), and — through `content_visible`, the ONE predicate the
  consumers read — that a full-window overlay hides the page while a sidebar does not
  and fullscreen shows it again. The routing arm is pinned too: a foreign channel
  returns `None` AND leaves the layout byte-identical, so a `_` arm that still ran an
  `update` could not pass. `view.setContentVisible` is the one arm with no layout effect
  at all (it only talks to the webview), and its test asserts exactly that — it answers
  `Ok` and disturbs nothing.
- **`data.rs`** — `data.export` / `data.import` (bundles all stores + settings).
  **BOTH channels run on a DETACHED thread and answer in two hops.** They flush every
  store, walk `STORES` through `load_synced` (which can migrate rows), serialize the
  bundle with `to_string_pretty` and fsync — unbounded work, none of it bounded in
  time — and `ipc` is a **synchronous** `#[tauri::command]` that wry delivers on the UI
  thread, so doing that inline froze the window (toolbar, tab switch, input) for the
  whole pass, and nothing measured how long. `dispatch` therefore does almost nothing:
  it calls `bulk`, which spawns a `std::thread` and returns
  `{"ok": true, "pending": true, "channel": …}` — an **acknowledgement with no outcome**,
  so a caller that believed it would tell the user a backup was written before it was.
  The worker times itself with `Instant`, logs `[aegis] <channel> finished in <ms>ms`
  (the first honest measurement of this path), and emits `data.bulkDone` with
  `{channel, ms, result}` as its last statement. The real work moved verbatim into
  `export_blocking` / `import_blocking`, which the tests call directly, so a change to
  either is still covered.
  **`channel` is in the event because `subs`' precedent cannot carry two of them at
  once.** The bridge (`ipcClient`'s `awaitBulkData`, built on `lib/updateResult.ts`)
  settles on the FIRST event it is handed, so an export and a restore in flight
  together would otherwise resolve each other's promises — the export would report a
  written path for a finished RESTORE, which is a claim the user acts on. The poller
  filters on the channel; that is the only thing making the pair safe.
  **The hand-off, not the work, is what the gate tests.** `test_support::set_bulk_gate`
  hands back `(parked_rx, resume_tx)` for two **zero-capacity** channels, so the worker's
  own `bulk_gate_tick()` park IS the signal that it is parked — there is no window in
  which it could have finished first. A `static`, not a `thread_local`, because the
  worker is on another thread. `an_export_answers_before_the_work_has_been_done` and
  `an_import_answers_before_the_work_has_been_done` assert the ack's shape, assert the
  effect has NOT happened yet (no file / no favorites) while parked, then resume and
  assert the event carries the outcome. **Making `ipc` itself `async` was rejected**:
  it has zero tests anywhere, so it would move ~100 channels off the UI thread with no
  gate able to catch a regression.
  **A test in ANOTHER module that cares what a restore DID must call
  `data::run_blocking_for_test(channel, app, &payload)`**, which runs the same worker body
  synchronously (and panics on a channel that is not one of the two). Two tests were
  written against the old synchronous `dispatch` and had to be repointed:
  `downloads`' imported-`saveDir` test read a row that was not written yet, and `subs`'
  cache-traversal test was **vacuous** — it asserted `res.ok === true` (which the
  acknowledgement also satisfies) and its real claim held because the import never ran, so
  "an import that does nothing" satisfied it. That one now carries a **positive control**:
  a benign row in the SAME bundle with a real cache file, whose marker must appear in
  `enabled_text(app)`. Without it the negative assertion proves nothing. Do not add an
  import assertion without a control.
  **Unit-tested via `test_support::with_tmp_app`:** export produces a v2 bundle
  with every store present; cross-app import round-trip (export → fresh app →
  import) restores favorites, saved, history, downloads, allowlist, settings, and
  customFilters; error cases (garbage input, partial bundle), plus
   `no_backup_or_device_transfer_transport_is_left_to_a_platform_default` — the
   Android **platform-backup** rules, which are the other way this data can leave
   the device, and the only route that is NOT this app's own encrypted sync. It is a
   STRUCTURAL pin over the real `AndroidManifest.xml` and
   `res/xml/data_extraction_rules.xml`: the `dataExtractionRules` attribute on
   `<application>`, and an exclusion for all nine documented backup domains under
   all three documented transfer modes. Two things make it non-obvious and are
   spelled out in the test: an ABSENT mode is a fully ENABLED one, and there is no
   "exclude all" shorthand, so a missing domain line silently re-admits that whole
   domain (see the manifest section at the Android tree heading). Both XML files are
   read with their comments STRIPPED, because the manifest's comment quotes the
   attributes being asserted. The assertions are set EQUALITY per mode, so a typo'd
   domain the platform would ignore reds just as loudly as a missing one (19 tests).
  **A failed store write is REPORTED, and `counts` covers only the stores that
  landed.** The arm used to run `let _ = jsonstore::save(app, s, &migrated);` and
  then return `"ok": true` unconditionally, so a restore that silently lost a whole
  store was indistinguishable from a complete one — and it was the only
  store-writing path in the crate that dropped its error (`downloads::on_requested`,
  `history::record`, `places::*` and `sync_stores` all propagate it). The per-store
  results are now folded by the pure `aggregate_saves` into `ok: false` +
  `failed: [store…]`. The four parse/read refusals also carry `"failed": []`, so a
  caller can ask "did a write fail?" without first knowing whether the bundle
  parsed. The remaining import steps (settings, customFilters, adblock re-seed)
  still run on a partial import — abandoning the stores that DID land would be
  worse than the bug — and `ok: false` is what stops `ipcClient` reloading the
  chrome, which would wipe the toast naming the failures. The failure is provoked
  in tests with a **non-empty directory at the store's path**, because
  `write_atomic` renames a temp file over the target and a rename onto a directory
  fails for every user, whereas a `chmod 0500` "unwritable" file is a no-op under
  root and would make the test measure the success path.
  **The two BATCHED stores are invalidated BEFORE the loop writes them.**
  `history` and `downloads` hold their live rows in an in-memory cache that a
  timer flushes to disk every three seconds (`start_flush`), so writing the file
  and dropping the cache _afterwards_ left the entire store loop as a window: a
  flush tick landing in it wrote the pre-import rows straight back over the file
  the import had just written, and the import reported success. Restoring a
  backup could therefore leave the user with their old history and nothing on
  screen saying so. The arm now calls `history::invalidate` +
  `downloads::invalidate` before the loop (a concurrent flush finds nothing
  loaded and nothing dirty, so it cannot write anything) and again after it
  (discarding a visit captured from the file in between, which would otherwise
  leave a dirty cache and put the clobber back one flush later). Testing it
  needed a seam: a flush run AFTER the import returns is a no-op both before and
  after the fix, so `test_support::import_tick` — a `#[cfg(test)]` hook
  `data.import` calls after each store write — lets the test run the REAL
  `history::flush`/`downloads::flush` from inside the import and then assert on
  the files.
- **A failed `write_atomic` leaves NO temp file.** The write is temp→fsync→rename,
  and all THREE steps can fail (full disk, revoked permission, a device unplugged
  mid-write). Each `?` used to return with the temp still on disk, so a store that
  failed to save once leaked `<name>.<pid>.<nanos>.<seq>.tmp` on every subsequent
  failure. A `TempGuard` now removes it on every path out and is DISARMED immediately
  after the rename succeeds. The `.bak` recovery copy went through `let _ = fs::copy(
…)`, so a failure to write it vanished with no trace and it was never fsynced — so
  after a crash the very file meant to recover a corrupt store could be empty.
  `refresh_backup` copies then `sync_all`s, and its error is `eprintln!`ed rather
  than propagated, because bailing would make a store PERMANENTLY unwritable for
  anything that blocks the copy but not the write. Three tests: two for the temp
  leak (with and without a `.bak`) and one asserting the recovery-copy error is
  REPORTED while the write still lands. Both provoke failure with a **non-empty
  directory at the target path** (rule 36) — a `chmod 0500` is a no-op as root.
- **Data stores** — `jsonstore.rs` (tiny JSON-array helper, unit-tested via
  `test_support::with_tmp_app` in `test_support::tests`) backs:
  - `places.rs` (favorites + saved) — **unit-tested via `test_support::with_tmp_app`:**
    add/list/remove/update/reorder for favorites; add/dedup/remove/tag/union for
    saved (13 tests). **`favorites.add` dedups against LIVE rows by
    `sync_stores::normalize_url`, not by string equality** — see the sync bullet's
    near-duplicate sub-bullet for why the weaker rule was a data loss.
  - `history.rs` — **unit-tested via `test_support::with_tmp_app`:** record
    dedup, scheme filter, private-tab skip, list order + pagination, search,
    remove + clear, update_title, unknown-channel dispatch, and the Android
    `record_page_finished` path (16 tests).
    **Visits are recorded by the PLATFORM, not by the chrome** — see the Android
    history gotcha below before touching either side.
    `history.removeForOrigin` (added 2026-09-28) deletes EVERY row for one
    origin by filtering the full store, and is the ONLY way to clear a site's
    history: `list()` returns the newest 200 of up to 5000, so a renderer loop
    over those entries clears a page and calls it a clean slate — while
    `search` filters the whole store, so the user can search the "erased" rows
    straight back up. It returns the number removed and emits `history.changed`
    only when that is non-zero. Its `origin_of` is deliberately NOT
    `permissions::origin_of`: that one is `#[cfg(target_os = "linux")]` and falls
    back to the RAW URI string for opaque input, so a clear-this-site built on it
    would match rows the renderer never showed (and `data.import` really can
    plant `about:`/`data:` URLs in the store).  - `downloads.rs` — **unit-tested via `test_support::with_tmp_app`:** private-tab
    skip, `on_requested` filename derivation + state, `on_finished` complete/
    interrupted, `remove` tombstone, `clear` keeps in-progress, plus the four
    Android-recording tests below (19 tests).
    **Android records downloads too, through the SAME rows — this was the
    `#[cfg_attr(target_os = "android", allow(dead_code))]` tell (gotcha 26).**
    `should_record_download` and `on_finished` carried that attribute, i.e. the
    crate claimed the feature did not exist on Android while the mobile Downloads
    UI shipped and stayed permanently empty. Android's content area is a native
    `WebView`, so nothing in the core can ever see a `DownloadListener`; Kotlin is
    the only side that gets it, and Rust cannot up-call into Kotlin.
    `NativeDownloads.recordStart(url, destination, isPrivate)` →
    `record_download_start` pushes the `progressing` row; `recordFinish(url,
success)` → `on_finished`. **The destination must be PASSED IN, not derived**:
    `on_requested` (the desktop wry path) derives the filename from the URL and
    OVERWRITES the caller's destination, whereas Android's
    `DownloadListener.onDownloadStart` has no destination parameter at all, so the
    Kotlin listener chooses one under `getExternalFilesDir("downloads")` — a REAL
    path, because `open`/`showInFolder`/`trusted_download_path` need one and a
    `DownloadManager` `content://` URI is not one. So `on_requested`'s row-push body
    was extracted into `push_row` (returns whether it changed; the CALLER emits
    `downloads.changed`, so one row never yields two events) and
    `record_download_start` is the Android-only entry point.
    **The Kotlin download directory is the platform's, and only one name names it.**
    `downloadDir()` used to be `File(getExternalFilesDir("downloads"), "downloads")`,
    i.e. `<extFiles>/downloads/downloads`, while
    `DownloadManager.Request.setDestinationInExternalFilesDir(this, "downloads", name)`
    writes to `<extFiles>/downloads/<name>`: `getExternalFilesDir` ALREADY appends its
    dirType (`ContextImpl.getExternalFilesDirs` -> `Environment.buildPaths(dirs, type)`),
    and the platform's own `setDestinationInExternalFilesDir` is implemented as exactly
    `getExternalFilesDir(dirType)` + the file name (frameworks/base
    `core/java/android/app/DownloadManager.java`). So the recorded `savePath` was one
    directory below the file: `openFile`/`showInFolder` pointed at nothing, and
    `trusted_download_path`'s prefix check passed vacuously. The subdirectory is now the
    single `DOWNLOAD_SUBDIR` constant used by BOTH halves, `downloadDir()` returns
    `File?`, and the `?: filesDir` fallback is gone because
    `setDestinationInExternalFilesDir` THROWS when the directory is unavailable — a
    fallback path would be recorded and never written. The listener drops the download
    with a log line before `recordStart` instead. There is no Kotlin test source set, so
    `downloads::tests::the_kotlin_download_directory_is_the_one_the_platform_writes_into`
    pins the Kotlin TEXT; it is paired with the Gradle build, because a text pin can lock
    in a form the COMPILER rejects and the compiler only runs where the pin cannot.
    **`open`/`showInFolder` return a `Result`; they never lie.** The body used to be
    `let _ = Command::new(cmd).arg(target).spawn()` on desktop and `let _ = target` on
    mobile, and BOTH dispatch arms answered `Ok(Value::Null)` regardless — so on a
    phone the button did nothing and said it had, and on a desktop with no system
    handler the failure was discarded. `OPENER` is `None` off the three desktop
    targets, which is now an `Err`, and a spawn failure names the command and the
    path. `?` CANNOT be used in the arms: `dispatch` returns
    `Option<Result<Value, String>>`, so it would bind to the `Option` and report
    "channel unhandled" instead.
    **A downloads row records the `saveDir` it was written into.** `trusted_download_path`
    used to accept only paths under the LIVE `downloadDir` setting, but a row is a
    HISTORICAL record: change the setting and every earlier download stopped opening,
    and on Android EVERY row was refused, because Kotlin saves under
    `getExternalFilesDir("downloads")` (no storage permission) while `dir(app)`
    resolves to `/storage/emulated/0/Download`. `push_row` now records
    `saveDir` = the parent of the caller's own path, and the check accepts a canonical
    path under the row's recorded base OR under the current `dir(app)`
    (`within()` canonicalises BOTH sides, or a symlinked downloads dir never
    string-prefixes its own children). `data::import` **STRIPS `saveDir` from
    imported rows**: a bundle is the one path where a stranger's bytes reach the
    trust check, and `downloads` is not in `sync_stores::SYNCABLE`, so that strip is
    the entire new attack surface. Tests cover both halves — a download that stays
    openable after the folder setting moves, and an imported row that cannot name
    its own trusted folder.
    **The opener is a `cfg(test)` CLOSURE seam, never a command-name override.** With a
    name override the "control" assertion ran the HOST's real `xdg-open`, which then
    reported a `/tmp/aegis-test-…` path the test had just deleted — a GTK error
    WINDOW on the developer's desktop. `Opener = Arc<dyn Fn(&str) -> Result<(), String>>`
    (an `Arc`, because the override is CLONED per call and `Box<dyn Fn>` is not
    `Clone`; not `take()`, which would clear it mid-test) means only ONE test starts a
    process at all, and it execs a name that fails at `exec` with no process and no
    window.
    **The JNI exports take `isPrivate` from Kotlin but the Rust side still resolves
    privateness from the tab registry**, exactly as `record_page_finished` does for
    history — see `a_download_started_in_a_private_tab_records_nothing`.
    The shared app handle moved OUT of `history.rs` into `lib.rs`
    (`set_android_app` / `android_app()`) so a second native feature does not have
    to depend on the first. **There is NO Kotlin test source set, so the listener,
    the `DownloadManager` enqueue and the `ACTION_DOWNLOAD_COMPLETE` receiver are
    COMPILE-VERIFIED ONLY (Gradle) and the on-device behaviour is PENDING.**
  - `subs.rs` (filter subscriptions + fetch) — also **seeds the built-in default
    subscriptions** (EasyList, EasyPrivacy, Peter Lowe's) on first run via
    `seed_defaults` (called from `lib.rs` setup): idempotent + tombstone-aware
    (`ensure_default_rows` skips a `listId` that already exists, even tombstoned — so a
    removed default is never resurrected), seeded rows carry `builtin: true` + `enabled:
true`. **No boot fetch** (deliberate): the baked-in `adblock_lists` copies already
    provide the rules, and an immediate fetch would re-apply the WebKit content filters
    mid-launch (heavy + disrupts an in-flight find / the active page — the live autopilot
    caught exactly this). Defaults refresh on the user's "Update all" or an off→on toggle.
    The baked-in copies still block day-one/offline (and feed the Win/macOS injector,
    which isn't fed subs), so the defaults exist BOTH baked + as refreshable subscriptions;
    `abuse-tlds` is baked-only (no upstream URL). **Every cache read, write and unlink goes
    through ONE `cache_path`, and a `listId` is only a cache file name if `safe_list_id`
    accepts it as a SINGLE path component** — a `subs` row's `listId` is attacker-reachable
    because `data.import` writes `subs` rows verbatim, and `Path::join` on `../…` walks out
    of the cache dir while an absolute id REPLACES it (and `write_atomic_inner`
    `create_dir_all`s the parent first, so the write lands; `subs.remove` unlinked the same
    path). Containment is enforced on the ID, not the joined path: a lexical
    `Path::starts_with` guard never normalises `..`, and a write target need not exist yet.
    `subs.add`/`subs.setEnabled` REFUSE a bad id (they are the write paths, so a bad id can
    never work), while `subs.remove` still tombstones the row and only skips the unlink, so a
    row planted by an import always stays cleanable. **Unit-tested via `test_support::with_tmp_app`:** `list_id_from_url`,
    `hash_text`, `url_of`, scheme rejection, add/list/remove, `set_enabled`, `enabled_text`,
    `ensure_default_rows` (seed/idempotent/tombstone-respecting/builtin-survives-toggle),
    and the cache-path containment set — the id rule, the join-to-a-direct-child property,
    an imported `../outside` row NOT reading a planted file above the cache dir, a
    `../victim` removal NOT unlinking a planted file above it, `https://x.test/..` refused
    on add, and a `../escape` row refused on enable (30 tests).
  - `customfilters.rs`, `settings.rs` — **a failed write must NEVER advance the sync
    projection.** Each keeps a local record of "we have this peer's HLC" beside the file the
    value actually lands in, and that record is what makes the next merge skip a value it
    believes is already here. So the two writes are ORDERED and the second is CONDITIONAL:
    `write` returns `Result<(), String>`, and `save_sync_records` / `stamp_sync_record` run
    only after it returned `Ok`. Before, `write` only `eprintln!`d, so a write that never
    happened was recorded as a fresh, winning, local HLC — and since `merge_projection` only
    re-applies a record whose `rhlc > lh`, the peer's value could never win on that device
    again. In `customfilters` it was bidirectional: each side advertised text the other did
    not have. `settings::apply_synced` returns `bool` and `merge_remote` reports no
    `sync.changed` event when it is false, so a transient failure (full disk, read-only
    mount) heals on the NEXT pull instead of being lost for good. `apply_imported` returns
    `Result<Vec<String>, String>` for the same reason: it runs `rebuild_projection_from_current`
    AFTER the write, and that wipes and re-seeds the projection FROM THE CURRENT FILE — so
    after a failed write it would stamp the PRE-import values with fresh locally-invented
    HLCs, and a genuinely newer peer record would lose to a stamp the device invented inside
    its own failure path. `customFilters.set` reports the error rather than echoing text the
    file does not hold, `picker::on_picked` emits no `picker.picked` for a rule it could not
    save, and `data.import` adds `settings` / `customFilters` to the `failed` list above.
  - **`customfilters` text is size-capped on BOTH write paths, not only the local one.**
    `write` — the single path behind the `customFilters.set` dispatch, the element picker
    and `data::import` — runs `check_size` before the write and before the stamp, so a
    refused size cannot leave the record advertising text that is not on disk (the failure
    mode above). `merge_remote` is the path that needed its OWN check: it writes the `.txt`
    DIRECTLY through `jsonstore::write_atomic` and never calls `write`, so a peer's sync
    record — text this device never chose, arriving over the network — was unbounded. It
    checks AFTER `observe`, so the peer HLC is still recorded and the record is not
    re-fetched on every subsequent pull, and returns `false` so the next pull retries
    rather than leaving the device stuck on a value it refuses. The check sits after the
    `if deleted {""} else {…}` extraction, because a tombstone's large `text` field is
    irrelevant: a tombstone means “delete the rules” and must still clear them. The limit is
    `MAX_TEXT_BYTES = 512 * 1024`, matching `picker::MAX_FILTER_BYTES`.
    `Result` is `#[must_use]`, so every test call site of either writer needed an explicit
    `.expect("… fixture write")`; the production callers are only `apply_synced` and
    `apply_imported`.

  - **Per-store locking (every read-modify-write of a JSON store takes it).**
    `jsonstore::with_store_lock(name, f)` is a `parking_lot::Mutex` keyed by store name and is
    **NOT reentrant** — taking it twice on one thread deadlocks the whole suite. So the rule is
    that each region owns the lock at exactly ONE level, and the inner workers stay unlocked:
    the lock spans `load` -> mutate -> `save` and nothing nested inside it re-takes it.
    Locked regions and their unlocked inner workers:
    - `jsonstore::add_host` / `remove_host` / `clear_hosts` via `with_host_store_lock`
      (reach `fp-allowlist` and the WebRTC exempt store for free; `allowlist` IS in
      `SYNCABLE`, so the sync thread merges it locked while the UI toggles it).
    - `subs.rs`: `add`, `setEnabled`, `remove`, `ensure_default_rows`, `fetch_in_background`,
      `refresh_all`. `fetch_in_background` is spawned AFTER the lock is released; the cache
      unlink and `reinstall_adblock` in `remove` are outside it.
    - `settings.rs` via `with_settings_store_lock` (name `"settings"`, deliberately NOT a
      `SYNCABLE` name — the settings namespace is merged by its own closure in `sync.rs`, not
      by `sync_stores::merge_into`): `apply_local` (the `settings.set` region), `merge_remote`,
      `apply_imported`, and `sync_records` — the last looks like a reader but
      `ensure_sync_projection` PERSISTS `settings-sync.json` on first use. Unlocked inner
      workers: `ensure_sync_projection`, `record_change`, `apply_synced`,
      `rebuild_projection_from_current`, and `write` (the single low-level writer).
    - `places.rs` takes `store_lock` directly and holds it across the whole match.
      Because "one level only" is hand-maintained, `assert_holding_settings_lock` checks it: a
      `#[cfg(test)]` thread-local depth counter, a `debug_assert_eq!(0)` on re-entry into
      `with_settings_store_lock`, and a `debug_assert(>= 1)` inside each inner worker. A future
      caller reaching an inner worker directly would silently run an unprotected
      read-modify-write — which is exactly how this defect existed — so it now panics in CI
      instead. Note the counter lives on a `thread_local!` macro invocation, so its comment must
      be `//` not `///` (`///` there is `unused_doc_comments`, i.e. a `-D warnings` build failure).
      `settings.set` was extracted out of the `dispatch` arm into `pub(crate) fn apply_local`
      (generic over `Runtime`) precisely so this region is reachable from a `MockRuntime` test;
      nine test call sites had been hand-rolling the arm's body and now drive `apply_local` /
      `merge_remote` instead. **`dispatch` is generic over `Runtime` too** (Wave 7), so the
      ROUTING is covered as well: a channel that is not `settings.*` must be declined with
      `None` so `lib.rs`'s `ipc()` falls through to the next module, and a refused
      `settings.set` must be all-or-nothing on disk (`apply_local` validates every key of
      `partial` BEFORE the merge and the write, and returns the first error naming it).
- **Ad-block (layered, platform-gated):**
  - `adblock_lists.rs` — **single source of truth for the bundled filter lists**:
    EasyList (ads) **+ EasyPrivacy (trackers/analytics)** **+ Peter Lowe's** (ad+tracking
    hosts) **+ a curated abuse-TLD block** (`abuse-tlds.txt`: `||cfd^` etc.), mirroring
    uBlock Origin's default set plus rotating-domain defense. EasyList alone blocks ad
    servers but _not_ analytics (google-analytics, hotjar, scorecardresearch, …), so
    EasyPrivacy closes that gap; and piracy/streaming sites serve pop-under/banner ads
    from rotating random domains on throwaway TLDs (e.g. `limbycocking.cfd`) that no
    static domain list catches — `||tld^` blocks the whole abuse TLD (engine, converter,
    and the inject domain-set via suffix match all honor it). **Every tier below reads
    `adblock_lists::ALL`** (engine, the WebKit
    converter, the inject builder) so coverage is identical on Linux/Windows/macOS/Android
    — add a list here and all platforms widen at once. Custom rules + user subscriptions
    layer on top in the callers that support them.
  - `adblock.rs` — state machine (enabled + allowlist), `adblock.*` IPC.
    `sync_engine` mirrors the on/off + allowlist into `adblock_engine` on **all**
    targets (desktop + Android), so the pop-under check honors them everywhere.
    **`host_covered(allowlist, host)` is the ONE definition of the allowlist's scope**
    (exact host or a subdomain of it; `notexample.com` is not covered by
    `example.com`). Every tier that cannot ask the engine goes through it —
    `adblock_engine`'s per-request veto, `adblock_inject`'s compose decision, and
    `host_allowlisted` — because they had drifted: the engine's was an exact `HashSet`
    hit with no subdomain case, so an allowlisted site's subdomains stayed filtered
    there while the UI promised otherwise. It is allocation-free deliberately
    (`should_block` runs it per intercepted subresource).
    Also owns **`enabled(app)`** — the pure read of the on/off toggle for tiers that must
    not go through `dispatch` (`adblock_inject::script`). It defaults to `true` when the
    state is absent, matching `AdblockState::default()` and `state_json`'s no-state branch:
    a tier that cannot read the policy must never decide to stop blocking.
    Also owns the **shield-badge counters**: `note_blocked`/`reset_page` keep a
    monotonic session total + per-tab page count and emit `adblock.blockedCount`;
    `getState` returns the REQUESTED tab's `pageBlocked` so the chrome recovers the
    count on mount/tab-switch (live events emitted before the chrome subscribed —
    e.g. the restored boot page — are otherwise lost). **It answers for the view the
    payload names, via `target_view` (payload `viewId`, else `active_id()` — the same
    resolver `find::dispatch` uses), not unconditionally for the active tab.** That
    distinction is load-bearing: the registry's `active_id` and the renderer's view are
    updated by different round-trips, so during a tab switch they disagree — and the
    chrome's request was payload-less and deduped for 300 ms, which meant ONE cache key
    shared by every caller and a shield that showed the PREVIOUS tab's count for the rest
    of the session (the only other writer is a live `blockedCount` event, which a tab that
    blocks nothing never sends). The policy mutators (`setEnabled` / `toggleAllowlist` /
    `removeAllowlist` / `clearAllowlist`) still pass `None` — they are global and their
    `AdblockState` reply is read for `enabled`/`allowlistedHosts`, never for the count.
    Counting is wired on **all three
    tiers**: Linux (`linux_layout::connect_block_counter` / `resource-load-started`),
    Windows (the `adblock_win.rs` `WebResourceRequested` network tier → `note_blocked`),
    and Android (Kotlin `shouldInterceptRequest` ad-block branch → `__aegisBlockedCount`).
    **macOS has no counter** — WKWebView exposes no per-subresource-request callback, so
    `note_blocked`/`bump_blocked` are dead there (hence their
    `#[cfg_attr(any(target_os = "android", target_os = "macos"), allow(dead_code))]`) and
    the badge stays at 0; `reset_page` still runs on all desktop.
    Each tier's count reflects only what its own ad-block layer sees — Linux under-counts
    content-filter-blocked ads (cancelled before the signal fires); see gotcha 6.
    **Unit-tested via `test_support::with_tmp_app`:** default state, `set_enabled`,
    `toggle_allowlist` + subdomain coverage + persist, `clear_allowlist`,
    `get_state_reports_the_requested_views_page_count_not_the_active_tabs` (reads the
    registry's real `active_id` rather than assuming 1, then asserts the payload's view
    wins and a payload-less call still answers for the active tab),
    `note_blocked` session/page counters, per-tab page count + reset, plus the pure
    `host_covered` scope table and the engine's subdomain veto (14 tests).
    **The allowlist reaches every tier, each by a different mechanism** — this was the
    defect it did NOT do before (a "trusted site" was still filtered everywhere):
    - **engine** (`adblock_engine`): `set_policy` mirrors the hosts in; `should_block`
      vetoes on an allowlisted page host. Android's `shouldInterceptRequest` and the
      desktop pop-under check both go through it.
    - **declarative WebKit filters** (Linux — the only tier that blocks a page's
      subresources there): no per-request seam exists, so the allowlist is compiled
      INTO the rules as `ignore-previous-rules` exceptions scoped by `if-domain`
      (`adblock_convert::allowlist_exemptions`), and `after_allowlist_change` rebuilds
      - re-applies them via `install_adblock` (hash-cached on the lists **and** the
        allowlist). **The exception is appended to EVERY chunk**, not once at the end:
        `install_on` loads each chunk as its own content filter and WebKit's
        `ignore-previous-rules` reaches only rules in the SAME filter
        (webkit.org/blog/3476), so a single trailing copy would cancel only the last
        chunk's ~3k of ~78k rules and look perfectly correct while exempting nothing.
    - **injected JS** (`adblock_inject`): `script()` was already handed
      `host_allowlisted` but used it only for the WebRTC shim; `adblock_layer` now
      gates the pop-under guard + the fetch/XHR/cosmetic body on it. Farbling is NOT
      gated (separate `fp-allowlist`). Android's JNI getter takes the page host and
      calls the same seam via `adblock_engine::host_is_allowlisted`. The layer is gated
      on the on/off TOGGLE as well as the allowlist — see the ad-block toggle bug below.
    - **Windows WebView2** (`adblock_win`): `handle` passed an empty source page, so
      the allowlist veto was unreachable (`host_of("")` is `None`) and every request
      looked first-party. It now reads the real page URL from `ICoreWebView2::Source`.
      Compile-verified only — the module is `#[cfg(target_os = "windows")]`, so no
      test for it can run on a Linux host. **The request TYPE was wrong here too, and it
      was the bigger half:** `handle` passed the literal `"other"`, so every subresource
      was typed `Other` and no `$script`/`$image`/`$stylesheet`/`$xhr`/`$font`/`$media`/
      `$websocket` rule in EasyList/EasyPrivacy could ever match on Windows — the network
      tier acted only on host-anchored rules and the injected JS tier carried the rest. The
      mapping is now `adblock::win_resource_type`, a `const fn` over WebView2's
      `COREWEBVIEW2_WEB_RESOURCE_CONTEXT` (which is an **enum with sequential values, not
      a bitmask** — `args.ResourceContext()` is an out-parameter getter and a failed
      getter leaves `ALL` = 0 ⇒ `"other"`, the old behaviour). It is unit-tested on EVERY
      platform in `adblock.rs` because it is pure data, and `adblock_win`'s own
      `#[cfg(test)] mod tests` pins each of those integers to the real WebView2 constant so
      a renumbering cannot pass; that module RUNS on the Windows CI leg and is
      compile-verified here by the gnu cross-check. A `const _: () = …` compile-time proof
      of the same table is impossible — `&str` equality is not yet a const trait (E0658).
      The one line no test can reach is the `should_block` call site itself.
      A non-ASCII or otherwise malformed allowlist host is DROPPED, not passed to WebKit
      (`adblock_convert::usable_if_domain`): a filter WebKit cannot compile is discarded
      wholesale, which would disable ad-blocking for every site. The allowlist is a
      SYNCABLE store, so a remote device can put an arbitrary string in it.
  - `adblock_engine.rs` — Brave `adblock::Engine`. **`Engine` is `!Send`**, so it
    lives on one dedicated thread (OnceLock); queries cross via mpsc. Android JNI
    entry `should_block(...)`. Compiled on **all desktop + Android** (not just
    Win/Android): every desktop calls `should_block` from `nav::on_new_window` to
    **drop ad/tracker pop-unders** (`window.open`/`target=_blank` to an ad domain)
    instead of opening them as tabs; warmed off-thread at boot (`lib.rs`) so the
    first check doesn't parse the lists on the UI thread. Loads every
    `adblock_lists::ALL` list into the `FilterSet`. Android does the same in
    `MainActivity.onCreateWindow` via `NativeAdblock.shouldBlock`.
    Also exports **`enabled()`** (`#[cfg(any(target_os = "android", test))]`) — the same
    `ENABLED` global `should_block` reads, reached on Android through a
    `NativeAdblock.enabled()` JNI getter so the Kotlin document-start cache is keyed on the
    toggle, and under `test` through `adblock_inject::android_document_start_layer`. Gated
    rather than `allow(dead_code)`, because outside those two there is genuinely no caller.
    - **Four concurrency contracts in that file, all learned the hard way — read these
      before touching `should_block` or `reload_lists`.**
      - **Replies are `Verdict { seq, blocked }`, not a bare `bool`.** The one-engine-thread
        design reuses a single reply channel per calling thread, which is only sound while
        _nothing times out_. A query that waits out `QUERY_TIMEOUT` leaves its answer sitting
        in that channel, because the engine thread has not sent it yet at the instant the
        caller stops waiting. The next `should_block` on that thread then reads it and
        **answers a different request with the previous one's verdict**. The old
        "drain on timeout" could not prevent this: at timeout the channel is still empty, so
        `try_recv` drained nothing. The `seq` (a `Relaxed` global counter, unique enough
        because each thread has its own channel) makes the leftover harmless — it is
        received, recognised as not-ours, and dropped — and the deadline is on the whole
        wait, so skipping a stale reply does not extend it. This is reachable in
        production, not just in tests: `should_block` runs for every allowed subresource on
        the GTK main thread, so one timed-out query mis-answers the next subresource.
      - **`reload_lists` coalesces; do not make it queue again.** `Msg::Reload` is FIFO on
        the _same_ channel as `Msg::Query`, so N queued rebuilds put N full ~20 MB EasyList
        re-parses in front of every in-flight query — and a query that waits out
        `QUERY_TIMEOUT` behind one fails OPEN, i.e. a real under-block. A user who toggles a
        filter, edits a custom filter and updates a subscription in quick succession must
        cost ONE rebuild. The shape is a `PENDING_RELOAD` slot (last write wins) plus a
        `PENDING_QUEUED` flag; the engine thread **takes the texts and clears the flag
        before building**, so a reload arriving mid-build re-queues instead of being folded
        into the running one and lost. Measured: 201 queued requests went from stalling the
        engine thread for over 5 minutes to 1–2 rebuilds.
      - **`should_block` returns a bare `bool`, so it cannot say "no answer yet" — and a
        test built on it is either flaky or lying.** "The engine allows this" and "the engine
        never answered, failed open after `QUERY_TIMEOUT`" are the same value, and a *negative*
        assertion cannot tell them apart at all: a fail-open timeout looks exactly like the
        verdict it hoped for, so the test passes for the wrong reason. The fix is a test-only
        `thread_local! LAST_QUERY_UNANSWERED` flag that `should_block` raises in its three
        no-verdict arms (send failed / `Timeout` / `Disconnected`) and clears at the top —
        **thread-local because the verdict is per-thread** (`REPLY` is a thread-local channel;
        a global flag is cleared by any other test thread and the reading thread then
        concludes "answered" with a fail-open `false`). `verdict_of` in the test module asks
        for a *verdict*: retry only while that flag is set, sleep 20 ms, stop the instant one
        exists. A warm-up is a precondition, not a guarantee — a rebuild can land after it —
        so the assertions themselves must ask for a verdict. Panic-recovery `false` is
        deliberately NOT marked: that one IS a verdict.
      - **The engine thread memoises verdicts, and the ONE place that replaces the engine
        must clear that memo.** `VerdictCache` lives inside the engine thread — so it needs
        no lock, has exactly one writer, and can only be invalidated where the `!Send`
        `Engine` can be replaced. It keys on the exact `(url, source, request_type)` triple
        `should_block` was called with, because the engine answers a pure function of those
        three. Measured on this box: the match is ~284 us for a non-blocked URL and ~130 us
        for a blocked one, while the channel round-trip around it is ~5–9 us — the match
        is ~97% of the cost, so a hit is ~57x cheaper. It is deliberately NOT a caller-side
        memo: that would still pay the round-trip just to learn whether a reload happened.
        This is the subtlest of the four, because the memo is only correct if the single
        site that can change the answer clears it — and a stale entry is a SILENT wrong
        answer, not a stale one. The mutation probe proved the coupling: deleting the
        single `cache.clear()` in the `Msg::Reload` arm turns red not only
        `a_filter_reload_invalidates_every_memoised_verdict` but the pre-existing
        `blocks_ads_and_honors_toggle_and_allowlist`, **because the ad-block on/off toggle
        works by reloading the engine** — so without the clear, a user who switches
        ad-blocking off keeps being served pre-toggle verdicts and the toggle looks broken
        until restart. `VERDICT_CACHE_MAX` is a memory bound, not an eviction policy:
        reaching it drops the whole map, which costs one re-match per entry and needs no
        ordering bookkeeping.
  - `adblock_webkit.rs` (Linux) — declarative WebKit content filters via
    `adblock_convert.rs` (Brave → Safari content-blocker JSON), chunked ~25k
    rules/filter (WebKit caps ~50k), disk-cached by hash **over the lists AND the
    allowlist** (the allowlist is compiled into the rules, so it is part of the filter
    content). **Filters are per-webview
    (per-tab), not global** — `apply_filters` covers every content webview + caches
    the chunks; `nav::spawn_tab` calls `apply_to_new_tab` so tabs opened _after_
    boot get filters too (not just the boot-active tab); `remove_all` clears all.
  - `adblock_inject.rs` (Windows + macOS) — document-start JS blocking
    fetch/XHR/sendBeacon + cosmetic hiding. On Linux it skips the heavy injection (native
    filters cover it) but STILL injects the **pop-under guard** (`POPUP_GUARD`, shipped on
    EVERY platform): overrides `window.open` to drop CROSS-ORIGIN scripted popups before any
    window/tab opens — the "prevent it loading" layer for on-click pop-under ads, which open
    a new window to a rotating ad domain no list can track. Same-origin / `about:blank` opens
    pass through (native `on_new_window` vets those). Trade-off: legit cross-origin scripted
    popups (e.g. OAuth) are blocked too; real `<a target=_blank>` links still open.
    `adblock_layer(block)` is the single seam gating the guard + the heavy body, used by
    both composition paths — desktop `compose` and Android's
    `NativeInject.documentStartScript(host)` JNI getter — which now share ONE ordering rule
    in `compose_layers(gestures, webrtc, adblock, farble)`.
    **The link-gesture layer is composed FIRST and is NEVER gated on `block`** (see
    `link_gestures.rs`): it reads the page's native `window.open` at document-start, which
    it can only do before the guard replaces it, and a user affordance must not vanish
    because ad-blocking was switched off for the site. The consequence, which replaces an
    invariant this file previously held: **the document-start script is no longer EMPTY on
    any page on any platform** — an all-exempt page now carries exactly the gesture layer.
    So anything that decided "injection unavailable" by emptiness (`MainActivity`'s
    `script.isNotEmpty()`) no longer decides that for the gesture layer.
    `block` = **enabled AND not allowlisted** — the two independent ways a user says
    "show me this site's ads". The guard travels with the body deliberately: it is the ad
    pop-under defence, there is no second UI control that would release it, and a user who
    switches ad-blocking off has asked for their pop-unders back.
    **The on/off toggle did not reach this tier at all before (Wave 1(2)).** The engine
    tier read `ENABLED` and Linux's WebKit tier was reinstalled/removed on toggle, but
    `adblock_layer` consulted only the allowlist — so on Windows/macOS, where this
    injection is the PRIMARY ad-block mechanism, the toolbar toggle simply did nothing:
    fetch/XHR/beacons were still rejected, ad elements still hidden, `window.open` still
    stubbed. `adblock::enabled(app)` (new; defaults `true` when the state is absent, so a
    tier that cannot read policy never decides to stop blocking) supplies the desktop half;
    Android's has no `AppHandle` at document-start-registration time, so
    `android_document_start_layer(host)` reads the process-global `adblock_engine::enabled`
    — the SAME `ENABLED` the interceptor reads, so the two Android tiers cannot disagree.
    That seam was extracted out of the `#[no_mangle] extern "system"` JNI export
    specifically so a Linux test can reach it; asserting on a re-typed copy of the export's
    body would prove nothing about the body.
    Kotlin's `documentStartScriptCache` is a `ConcurrentHashMap` **keyed by (toggle, host)**,
    not a single value and not host alone — a process-wide one would hand the first tab's
    script to every later tab, and a host-only key would mask a mid-session toggle change
    for the rest of the process. The toggle is read from native via a new
    `NativeAdblock.enabled()` JNI getter (an `AtomicBool` load), not a local field, so the
    cache cannot drift from the interceptor's view; it defaults to `true` if native is
    unreachable, because a key that silently read "off" when it could not ask would pin the
    process to the wrong script. **There is no Kotlin test source set in this project, so
    the cache keying is compile-verified (Gradle) only** — the Rust half is unit-tested by
    `disabled_adblock_injects_no_js_layer` (desktop, via `with_tmp_app`) and
    `android_js_layer_follows_the_enabled_toggle` (the seam the JNI export actually calls),
    which is 9 tests in this module.
    **Anti-fingerprinting (farbling) — Task 6:** `script(app, host_allowlisted, host)` now
    also appends `farble::shim_for(level, fp_allowlisted)` after the popup guard (and after
    the non-Linux ad-block body) via `compose(webrtc, farble, adblock_block)`. `script` is
    generic over `R: Runtime` (all three of its callees already were) purely so the
    `MockRuntime` test harness can reach it — the only production caller, `nav::spawn_tab`,
    infers `R = Wry` exactly as before. The farble shim uses the
    SEPARATE `fp-allowlist` (`farble::host_allowlisted`), not the ad-block allowlist. `off`
    level or an fp-allowlisted host → `""` → no injection (fail-safe no-op). **Per-spawn
    limitation (same as WebRTC shim):** the shim is evaluated once at content-webview creation;
    toggling the farbling level or fp-allowlist applies to newly spawned/reloaded tabs only.
    An in-tab SPA navigation to a different host is not re-evaluated until respawn. **Honest
    detectability note:** like the WebRTC shim, a JS shim is detectable by a motivated site;
    on WebKit the UA already lies about the engine. This is the accepted trade-off for the
    farbling tier — it adds noise that stops passive fingerprinting without breaking pages.
  - `adblock_win.rs` (Windows) — hooks WebView2 `WebResourceRequested` on
    `ICoreWebView2` via unsafe COM for full network interception. Supplies the engine with
    the page URL **and** the request type (the latter via
    `adblock::win_resource_type` — see the `adblock_win` bullet under Ad-block for what the
    literal `"other"` used to cost).
- **Find-in-page** (`find.rs` + `find_{linux,win,mac}.rs`):
  - `find.rs` — dispatcher (PLACE 2 of the IPC three-place rule): matches the four
    `find.*` channels, resolves the target tab id (defaults to active), and routes to the
    per-platform module. Exports `emit_state(app, view_id, query, match_count, active)`
    — the single place that calls `crate::emit_event(app, "find.state", …)` so the
    `find.state` event always goes through the `.`→`:` rewrite. Also exports
    `is_find_channel(channel) -> bool` for unit tests. **`dispatch` and the chain under it are
    generic over `<R: Runtime`** — `emit_state`, the four private wrappers, and
    `find_{linux,win,mac}`'s `start`/`next`/`prev`/`close` (those four only; each `install`
    stays concrete, because its sole caller `nav::spawn_tab` is) — so a `MockRuntime` test can
    drive the router. The concrete `&AppHandle` it replaced is WHY the target-tab resolution
    had no test at all: an explicit `viewId` wins, its absence means the ACTIVE tab, and the
    dispatcher never fabricates a `find.state` of its own (a match count only ever comes from
    the platform's change signal). **The platform work is still unreachable from a test** — the
    mock has no content webview, so every module returns at its first `get_webview` — and the
    `find_win` / `find_mac` arms are compile-verified only, `find_mac` on the macos-latest CI leg
    alone (objc2 needs a macOS C toolchain).
    **Every `find.state` emit must carry the LIVE query.** `useFind`'s `onState` does a
    whole-state `setState(s)`, so `query` is a REPLACED field: emitting `""` does not mean
    "no query to report", it means "clear the text the user is typing". Hence
    `FIND_QUERIES` (`note_query` / `live_query` / `forget_query`, `#[cfg(any(windows, test))]`)
    — a per-tab store, and `find_win`'s only way to recover the term, because
    `ICoreWebView2Find` is ONE-WAY (`Stop`/`FindNext`/`MatchCount`/`ActiveMatchIndex` but
    **no term getter**). It lives in `find.rs`, not in the windows-only module, so a
    Linux/macOS CI runner can actually test it; `find_linux` reads `search_text()` off the
    WebKit controller and `find_mac` keeps its own owned query, so neither needs it.
    **`FIND_QUERIES` is torn down by `tabs::forget_closed_tab`, like the other five
    tab-keyed tables.** The store is a `Mutex<HashMap<u32, String>>` holding one live term
    per tab, and nothing deleted an entry on close — so a tab id reused after a session
    restore (a hand-edited `tabs.json`, a restored backup) inherited the dead tab's term,
    and `find_win`'s one-way `MatchCountChanged` handler reported it into the reusing tab's
    FindBar ~120 ms later via `useFind`'s whole-state `setState`, which is exactly the bug
    the store exists to prevent. `forget_query_on_close(id)` is the seam, and it is
    `#[cfg(any(windows, test))]` in its BODY — so a **Linux** test can observe the clear —
    while the CALL is unconditional, which is what keeps the seam alive on a Linux release
    where `forget_query` is compiled out.
  - `find_linux.rs` — **WebKitFindController** (webkit2gtk): `install(app, label)` wires
    `connect_found_text` + `connect_failed_to_find_text` signals once per tab at spawn
    (called from `nav::spawn_tab`). Real match count via `found-text`; full highlight;
    **no active-index getter** (reports `1` when at least one match exists, else `0`).
    `FindController` is not `Send`, so all calls are made _inside_ the `with_webview`
    closure — moving the controller out does not borrow-check. Options bits: always
    `WRAP_AROUND`; `CASE_INSENSITIVE` added when `!case_sensitive`.
  - `find_win.rs` — **`ICoreWebView2Find`** (webview2-com `ICoreWebView2_28::Find`):
    `install` wires `MatchCountChanged` + `ActiveMatchIndexChanged` event handlers.
    Real match count **and** active index; full highlight via
    `SetShouldHighlightAllMatches(true)`; native Find dialog suppressed via
    `SetSuppressDefaultFindDialog(true)`. **Runtime-floor:** `ICoreWebView2_28::Find`
    requires a 2024+ WebView2 Runtime — if `cast::<ICoreWebView2_28>()` fails on an
    older runtime, all find calls are **silent no-ops** (browsing unaffected). The
    minimum runtime build is not confirmable from Linux; device testing records it.
    Compile-verified via `cargo check --target x86_64-pc-windows-gnu`.
    **Both change handlers report the live query, via `handler_query(id)`.** They are
    installed ONCE at spawn, before any query exists, and `MatchCountChanged` fires
    ~120 ms after a keystroke (matching the FindBar's debounce) — so the handlers used to
    hardcode `""` and wipe the input the user was typing into, on Windows only. `start`
    calls `note_query` BEFORE handing off to the webview (a change event can fire the
    moment `Start()` is called); `close` and the empty-query path call `forget_query`.
    `handler_query` is a named fn precisely so `find_win`'s own `#[cfg(test)]` module can
    pin the expression the handlers pass; **that test only runs on the Windows CI leg**
    (this module does not compile elsewhere) and is compile-verified here via
    `cargo check --target x86_64-pc-windows-gnu --all-targets`.
  - `find_mac.rs` — a **JS shim** (`find_shim.js`, bundled with `include_str!`), _not_
    the native `findString:withConfiguration:completionHandler:`. That native API returns
    only `matchFound` (a bool) — no match count, no highlight-all, no active index — and
    macOS was the one platform still stuck on it, so the shim closes that parity gap.
    At tab spawn (`install`) it is injected via `evaluateJavaScript` and defines
    `window.__aegisFind(query, caseSensitive, direction, close)`: a `TreeWalker` over
    visible text nodes, highlighting every match with `Range` + overlay divs and
    tracking the active index, returning the result as the sentinel
    `AEGISFIND:{matchCount}:{activeMatchIndex}` (also set on `document.title` for a
    brief period, for any title observers). Every `start`/`next`/`prev`/`close`
    re-injects it idempotently so it survives in-tab navigation — and because
    `evaluateJavaScript` targets the **MAIN world**, that idempotence guard is an
    OWNERSHIP check, not an existence one: it returns early only for a
    `__aegisFind` carrying the shim's own `__aegis_owned__` marker, and OVERWRITES
    anything else. It used to be `if (window.__aegisFind) return`, which handed the
    whole feature to any page defining that global first — the page then received
    the user's search terms verbatim and could return any `AEGISFIND:` sentinel it
    liked, so the match count was whatever the page wanted. A `WKContentWorld`
    would be the better long-term answer but cannot be built or verified off macOS
    (see the compile note below). Pinned by `src/lib/findShim.test.ts`, which
    executes the SHIPPED bytes the way `farbleShim.test.ts` does. `next`/`prev` reuse the last query + case-sensitivity, stored
    per tab in `LAST_QUERY` (`OnceLock<Mutex<HashMap<u32, (String, bool)>>>`).
    WKWebView access mirrors `nav_url_mac::install`: `with_webview` →
    `pw.inner() as *mut WKWebView` → `Retained::retain(ptr)`, and the `with_webview`
    callback already runs on the main thread, so nothing is marshalled inside it.
    macOS objc2 code cannot be compiled from Linux — **CI-only verify**
    (`cargo check --target x86_64-apple-darwin` on the `cross-target` matrix; GUI
    behavior needs a macOS desktop session).
  - **Android** — `find` is handled entirely in Kotlin (`MainActivity.kt`). The
    `AegisAndroid` JS bridge exposes `find(query, caseSensitive)`, `findNext()`,
    `findPrev()`, and `findClose()`. `findAllAsync(query)` is called on the active tab's
    WebView; a `setFindListener` wired at tab creation calls `pushFindState(id, count,
ordinal+1)` → `window.__aegisFindState(…)` in the chrome (mirroring `pushNavState` /
    `__aegisNavState`). **Limit:** Android `findAllAsync` is **case-insensitive only** —
    the `caseSensitive` flag is accepted but ignored by the platform API. No Rust
    involvement for Android find.
- **Page zoom** (`zoom.rs` + `zoom_{win,mac}.rs` + `linux_layout::set_zoom_level_label`
  - Android `MainActivity.setZoom`):
  * `zoom.rs` — dispatcher (`zoom.*` IPC channels: `zoom.get` / `zoom.set` — there is
    deliberately **no** `zoom.reset` channel; see the drift guard below),
    in-memory per-tab `ZoomStore` (`Mutex<HashMap<u32, f64>>`), `clamp(f)` (pure, unit-tested),
    `factor_of`, `apply_to_tab` (replays at spawn), and `apply_native` (per-platform fan-out).
    The `put` helper stores + applies + emits `zoom.changed`. **`zoom.reset` is NOT a
    channel.** The renderer's `aegis.zoom.reset(viewId)` sends `zoom.set` with a factor of
    1.0, deliberately, so the clamp lives in exactly one place — which means a `zoom.reset`
    channel had no possible emitter. It was declared, dispatched, documented and covered by
    three unit tests anyway, and every test passed because the tests drove the dead arm
    directly. It has since been removed; `shared/ipcCatalog.drift.test.ts` direction 5 now
    fails on any REQUEST channel declared and never named by a renderer source, and
    `ipcClient.contract.test.ts`'s `UNPINNED_REQUEST` (now empty) could never be a substitute:
    an inventory entry that ACCURATELY describes "nothing emits this" is how the defect got
    filed as a decision.
    **`zoom.get` answers the ACTIVE tab unless the payload names a `viewId`.** The router
    resolves the target from `tabs::Tabs`'s `active_id` (falling back to tab 1 when the registry
    is not managed), and `zoom.set` acts on that same id, so one call never
    re-zooms the tab the user is no longer looking at. **The value is clamped BEFORE it is
    stored**, so the store, the `zoom.changed` payload and the `zoom.get` answer can never
    disagree about what the tab is actually zoomed to. `dispatch`, `put`, `factor_of`,
    `apply_to_tab` and `apply_native` are generic over `Runtime` (and so is
    `linux_layout::set_zoom_level_label`) purely so a `MockRuntime` test can reach them; the
    native half is unreachable there — no content webview exists on a mock — so what the tests
    pin is the STORE plus the `zoom.changed` event, never the applied WebKit/WebView2 factor.
    **`ZoomStore` is torn down when a tab closes** (`forget_zoom_on_close(app, id)`, called from
    `tabs::forget_closed_tab`, the ONE definition both close paths share). It is the SEVENTH
    process-global tab-keyed table and the second one with no remover, after
    `find::FIND_QUERIES` (fixed in the same audit). Its cost is VISIBLE rather than a slow
    leak: `apply_to_tab` REPLAYS the stored factor at `nav::spawn_tab`, and `alloc_tab_id` only
    skips ids still in the registry, so a hand-edited `tabs.json` or a restored backup that
    hands back a reused id opened that tab at the dead tab's zoom with nothing on screen saying
    why. Unlike `find::forget_query_on_close` the seam is NOT `cfg`-gated — `ZoomStore` is
    MANAGED state, so the remover has to read it through the `AppHandle`. The WIRING half is
    pinned by `tabs::tests::forgetting_a_closed_tab_clears_both_side_tables` (primed through the
    real `zoom.set` dispatch, observed through `zoom.get`) and the BODY's half by
    `zoom::tests::the_tab_close_hook_removes_the_recorded_zoom`; the split is deliberate, so
    deleting the call must leave the latter green and turn the former red.
    **Session-only** (not persisted, not per-origin): the core is the source of truth so a
    discarded→reloaded tab keeps its zoom (see `apply_to_tab` called from `nav::spawn_tab`).
    Per-origin persistence is a forward-compatible v2 that won't change this IPC surface.
  * `linux_layout::set_zoom_level_label` — looks up the content webview by label and calls
    webkit2gtk `WebViewExt::set_zoom_level(factor)`. All native — no JS injection.
  * `zoom_win.rs` — `SetZoomFactor` on the WebView2 `ICoreWebView2Controller` (reached via
    `PlatformWebview::controller()`). Compile-verified via `cargo check
--target x86_64-pc-windows-gnu` + CI MSVC; **GUI runtime-verify PENDING** on Windows device.
  * `zoom_mac.rs` — `WKWebView::setPageZoom(CGFloat)` (content zoom — NOT `setMagnification`,
    which is the pinch scale). Reached via `PlatformWebview::inner()`. **CI-compile-only**:
    objc2 cannot be built from Linux; runtime needs a macOS desktop (sub-project I).
  * **Android** — no Rust involvement: the chrome calls `window.AegisAndroid.setZoom(id,
percent)` → `MainActivity.setZoom()` → `WebSettings.textZoom = percent`
    `zoom.get` reads it back through `MainActivity.getZoom(id)` (`tabZoom[id] ?: 100`) rather than from a renderer-side cache: the native map is what outlives the chrome document, and `data.import` reloads that document on a successful restore, so a cached copy reported 100% for a page the WebView was still rendering zoomed. `tabZoom` is a `ConcurrentHashMap` because a `@JavascriptInterface` method runs on the JS-bridge thread, not the UI thread `setZoom` writes on.
    (where `percent` is `Math.round(factor * 100)`). **Limitation:** `textZoom` is text-size
    scaling, not true page zoom (images/layout stay fixed-size); a pixel-perfect page-zoom
    alternative requires Android 9+ `WebView.setDefaultZoom` workarounds. Kotlin compile-verified
    via `compileUniversalDebugKotlin`; **GUI runtime-verify PENDING** on device.
  * **Per-platform capability matrix (honest):**
    - **Linux** (webkit2gtk `set_zoom_level`): full page zoom, exact factor. Cross-check +
      tests green; **live GUI verify PENDING** user display session.
    - **Windows** (WebView2 `SetZoomFactor`): full page zoom, exact factor. Compile-verified;
      **GUI runtime-verify PENDING** user's Windows 11 device.
    - **macOS** (`WKWebView::setPageZoom`): full page zoom, exact factor. **CI-compile-only;
      GUI requires a macOS desktop** (sub-project I, hardware-gated).
    - **Android** (`WebSettings.textZoom`): text-only scaling (not true page zoom). Kotlin +
      cargo compile clean; **GUI runtime-verify PENDING** device session.
  * **Ctrl-wheel note:** the Ctrl-wheel handler in `App.tsx` fires on the chrome webview
    only (not the content webview, which may capture scroll events first). Keyboard shortcuts
    Ctrl+`+`/`-`/`=`/`0` are the **guaranteed cross-platform zoom path** and are always
    wired. Ctrl-wheel over the content page may or may not reach the chrome handler depending
    on the platform/engine — confirm on device.
- **Security** — `safety.rs` (URLhaus malware host set from `resources/`, JNI
  `isMalwareHost`) — **unit-tested via `test_support::with_tmp_app`:** bundle
  non-empty, `is_blocked` true/false, session exception unblock, `proceed`
  records exception, `remove_exception`, list decisions, the `safety.proceed`
  scheme gate (8 tests).
  **`safety.proceed` is scheme-gated BEFORE it records anything.** It used to
  `w.navigate(u)` for any scheme, and for a hostless one (`javascript:`) `host_str()` is
  `None`, so no exception was recorded and the block stayed armed **while the warning was
  dismissed** — a control that lies, in the opposite direction from the ad-block toggle. It
  now consults `nav::is_navigable` first, deliberately reusing that ONE definition instead
  of adding a second scheme list, and an unparseable url returns `Err` rather than
  silently doing nothing.
  `permissions.rs` (site permission prompts) — **unit-tested via
  `test_support::with_tmp_app`:** list/remove/clear, `origin_of` strip, `verdict`,
  `persist`-replaces, and three "the store refused the write" cases (17 tests).
  **This store's ONLY serialization is the store lock — take it, and propagate
  the `Result`.** `permissions` is deliberately outside `sync_stores::HLC_CARRIERS`
  (no `hlc` field, plain `load`/`save`), so unlike every synced store it has no
  vector-clock conflict resolution and therefore no implicit mutual exclusion
  either. `persist`, `permissions.remove` and `permissions.clear` all read, mutate,
  then `jsonstore::save`, and all three did it with **no `with_store_lock` at all**
  and with `let _ =` on the save. `remove` was the sharp edge: it answered
  `Some(Ok(json!(items)))` built from the **in-memory** list, so a refused write
  reported SUCCESS — the UI dropped the row, the file kept it, and a grant the
  user had just revoked **came back on the next start**. All three now save
  through the lock and propagate (`?`), so the refusal is reported and the file
  keeps the row. Note the shape: `dispatch` returns
  `Option<Result<Value, String>>`, so a `with_store_lock` closure's `Result` must
  be wrapped back in `Some(...)` or it is a type error. The Linux resolve path
  calls `persist` from inside `run_on_main_thread` with nowhere to return to, so
  it LOGS; the Android JNI shell matches `crate::ffi_guard(|| persist(…))` and
  treats `Some(Err(e))` as the logged-failure case.
  **On Linux the origin is the MAIN FRAME's, and that is a deliberate
  platform limit, not an oversight.** `connect_permission_request`'s callback
  receives a `WebView` handle, and `wv.uri()` is that webview's own address —
  the top-level document. A request raised by a **cross-origin iframe** is
  therefore attributed to the embedding page and inherits its remembered
  decision: allow the camera on `example.com` once, and any third-party frame
  embedded there can request one and be let through. The pinned `webkit2gtk`
  binding makes this **unfixable**: `PermissionRequestExt` exposes only
  `allow()`/`deny()` and no per-request URI getter, so there is nothing else to
  attribute a request to. Fixing it needs a binding that surfaces the requesting
  frame's URI, or upstream WebKitGTK adding it to `WebKitPermissionRequest`.
  **Do not "fix" it by trusting `wv.uri()` more than it already is** — the
  `let origin = …` line is the only signal available and re-labelling it changes
  nothing. Android's tier attributes per tab from `NativePermissions.normalizeOrigin`,
  which is a real per-request signal, so the limit is Linux-only. Documented in the
  function's own doc comment (where anyone editing that line must see it) and here.
  Bounded by `classify` refusing anything unrecognized and by the same stored
  decision being consulted on every platform.
  **The decision half is CROSS-PLATFORM; the RAISE side is per platform.**
  `origin_of` / `remembered` / `persist` / `verdict` used to be
  `#[cfg(target_os = "linux")]` because only the Linux handler raised a prompt;
  they are now `#[cfg(any(target_os = "linux", target_os = "android", test))]`
  (the `test` is what lets a LINUX test drive them, and the windows-gnu
  `--all-targets` check is what forces the gate: the permission handler does not
  exist on Windows, so these are genuinely dead there). `verdict` is gated
  NARROWER — `#[cfg(any(target_os = "android", test))]` — because on a Linux build
  the handler inlines the `remembered` match and `verdict`'s only production caller
  is the Android JNI shell, so `clippy -D warnings` reported it dead. That is
  exactly why the gate beats an `allow(dead_code)`: the attribute made the
  unreachability explicit, and narrowing it to the platform that really calls it
  was the fix. `verdict(app, origin, permission) -> "allow" | "deny" | ""`
  is the one function Kotlin asks, and the three JNI exports
  `NativePermissions_{normalizeOrigin, decision, remember}` are thin shells over
  `origin_of` / `verdict` / `persist`.
  **Why the verdict cannot come back through Rust:** the JNI gateway is
  Kotlin→Rust only (no up-calls), and the LIVE request object is a WebView
  `PermissionRequest` / geolocation `Callback` that only Kotlin holds — so
  `permissions.resolve` is a LINUX-ONLY resolution path (`run_on_main_thread` into
  the `PENDING` map) and its non-Linux arm only logs. On Android the renderer
  therefore calls `AegisAndroid.resolvePermission(requestId, decision)` instead of
  the `permissions.resolve` channel, and Kotlin answers the request it is holding
  and calls `NativePermissions.remember` for a decision that is not `allow-once`.
  `requestId`s are minted by whichever side raises the prompt (Rust's `NEXT_ID` on
  Linux, Kotlin's own counter on Android) — they only have to be unique among
  _pending_ requests, and the unknown/stale-id case is logged and ignored on both
  sides rather than swallowed.
  **What Android can and cannot reach:** the two Android callbacks are
  `onPermissionRequest` (camera/mic via `RESOURCE_VIDEO_CAPTURE` /
  `RESOURCE_AUDIO_CAPTURE`) and `onGeolocationPermissionsShowPrompt`, so the
  vocabulary is `geolocation` / `camera` / `microphone` / `camera-microphone`.
  `notifications` and `pointer-lock` have **no** Android WebView callback and are
  therefore never written from either side — a Windows/macOS-only tier, not a gap.
  Before the fix the WebView default was to deny every request SILENTLY (there was
  no `onPermissionRequest` override at all), while `MobileApp` rendered
  `SitePermissionsTab` and `PermissionPromptDialog` over a list that could never be
  populated. Geolocation is answered with `retain = false` deliberately: Aegis
  re-prompts per origin through its own store rather than letting WebView retain it.
  The `permissions` store still lives in Rust, so list/remove/clear keep using the
  IPC channels on every platform.
  **Two permission layers, and only one of them is ours.** Approving the web request
  does not grant the OS permission: `requestAndroidPermissionFor` asks for
  `CAMERA` / `RECORD_AUDIO` / `ACCESS_FINE_LOCATION` at that moment, so a user who
  approves the site and then declines the OS dialog still fails `getUserMedia` /
  geolocation. That matches how a real browser behaves (the site permission is
  remembered, the device grant is re-asked), and the three `uses-feature`s are
  declared `required="false"` so no device is filtered out.
  There is NO Kotlin test source set, so all of the Android half is
  COMPILE-VERIFIED ONLY and the on-device behaviour is PENDING. `permissions::tests`
  pins five things by reading the Kotlin and the manifest as TEXT through
  `crate::test_support::{kotlin_source, kotlin_fn_body}`: the
  `onPermissionRequest` override exists and routes through the shared handler, the
  geolocation override exists and uses the SAME prompt, `resolvePermission` consumes
  its queue entry (so a stale id can never answer a live request) and remembers
  every decision except `allow-once`, the three OS permissions are in the manifest
  and named in `requestAndroidPermissionFor`, and `NativePermissions.kt` declares
  the three calls the Kotlin side makes. Those pins neutralise the KOTLIN side, and
  the Rust-side pins (`verdict` answering `allow` for a stored deny, `persist`
  appending instead of replacing) cover the decision half.
- **E2E sync ("F2b") + crypto** — `sync.rs` (per-namespace pull→merge→push over
  `reqwest::blocking`, `GET/POST /v1/records`, a debounced periodic background pass),
  `sync_auth.rs` (per-device **Ed25519** signed access tokens — the server authorizes
  iff the signature verifies and the device pubkey is registered), `sync_stores.rs`
  (per-uuid **HLC last-writer-wins** merge with tombstones — the `sync.changed`
  targeted-refetch seam, never a full reload), `sync_envelope.rs` / `sync_identity.rs`
  (record sealing + identity), and `sync_keystore.rs` (root-secret-at-rest: desktop
  `keyring`, Android hardware-Keystore JNI path **wired + device-verified** (commit
  `03f0012`; `AegisKeystore.kt` performs a real `KeyGenParameterSpec` AES-GCM wrap;
  passphrase-wrapped file is the fallback; remaining work = StrongBox preference, sub-project J).
  **Four tests need a real OS keychain and are skipped (loudly) where there is none** —
  the three `sync_keystore::tests::keychain_*` round-trips plus
  `sync::tests::restart_restores_an_enabled_sync_state`, which asserts `store_root` lands
  in the keychain and is therefore meaningless without one. Rust has no runtime skip, so
  they early-return behind `sync_keystore::keyring_available()`, which probes with a
  **write** and `eprintln!`s the reason. This is a real, frequent skip: the `keyring`
  `linux-native-sync-persistent` backend prefers kernel keyctl and only falls back to
  D-Bus `org.freedesktop.secrets`, and a headless CI runner (or any `unshare -Ur`
  namespace) has neither. The skip is deliberately **not** silent — a silent pass would
  let the exact keychain regressions these tests exist to catch ship unnoticed.
  All record crypto is `crypto.rs`:
  **XChaCha20-Poly1305** seal/open (24-byte nonce), **HKDF-SHA256** per-namespace keys,
  **Argon2id** passphrase KDF, `zeroize`-on-drop. A self-hosted reference server is the
  standalone `sync-server/` crate. `sync.*` data channels flow on Android for free
  (they ride the normal `ipc` chokepoint, not the `AegisAndroid` nav bridge).
  - **The sync transport is HTTPS-only by default, with an explicit per-device waiver
    (`syncAllowInsecure`, default `false`).** `sync::validated_base(raw, allow_insecure)`
    accepts `https://` always and `http://` only for a genuine loopback host
    (`localhost` / any `127.0.0.0/8` literal / `::1`; userinfo stripped, a bracketed IPv6
    literal sliced by its own brackets, and both the `localhost.evil.com` suffix trick and
    the `[::ffff:127.0.0.1]` v4-mapped form rejected). With the waiver on, a plaintext
    REMOTE host is accepted — that is the whole point, for operators whose `sync-server` has
    no TLS terminator in front. It is read at the **point of use** via
    `validated_base_for(app, ..)`, so all six request paths honor it: the periodic pass,
    `syncNow`, `register_device`, `sync.listDevices`, `sync.removeDevice`, and the
    `/healthz` probe behind `sync.testConnection`. What the waiver does NOT do: stop record
    bodies being sealed end-to-end (they still are; a forged body still fails AEAD). What it
    gives up: the network path learns which server you talk to and when, can drop/delay/
    reorder records (so deletions and edits can be selectively withheld), and can capture +
    replay an `Authorization` header (the replay set is in-memory — a restart clears it, a
    live process does not). **Unit-tested** in `sync::tests`:
    `allow_insecure_waiver_opens_plaintext_remote` pins that the waiver relaxes _transport_
    only, so `ftp:` / scheme-less / empty are still rejected with it on.
  - **A failed CSPRNG REFUSES to enable sync; it never yields a shared identity.**
    `sync_keystore::fresh_salt` draws the per-install 16-byte salt that
    `crypto::device_signing_seed` mixes into `HKDF(root, "device-sign:" + salt)`. That salt is
    the entire reason `sync.removeDevice` can revoke ONE install: it is what makes every
    install's signing key distinct. The code used to be
    `let _ = getrandom::getrandom(&mut salt);` on an all-zero array — an RNG failure was
    DISCARDED and the zeros were **persisted**, so every install of every account would derive
    the same key, silently. There is no safe fallback: any constant has that property.
    `fresh_salt` retries once (a single EAGAIN under early-boot entropy pressure is the
    realistic case), then returns `Err`; `device_local_salt` is therefore
    `Result<Vec<u8>, String>`; and `sync::enable_with_root` matches the `Err` by setting
    `Status::Error` with the reason, leaving `enabled = false` and `device_seed = None`, and
    returning before any identity is derived or registered.
    The seam that makes this testable is a `#[cfg(test)] thread_local` `RNG_HOOK` +
    `set_rng_hook`/`RngHookGuard` in `sync_keystore.rs` itself — **not** in `test_support`,
    which is `#[cfg(test)]`-only and so does not exist in a release build (I put it there
    first and got `cannot find test_support in crate`). There is no way to make an OS CSPRNG
    fail from a test, so without the hook the contract is a comment nobody can hold up. A hook
    must not re-enter `rng_fill` (the `RefCell` borrow would panic). Tests:
    `an_unavailable_random_number_generator_never_yields_a_shared_salt` and
    `a_transient_random_failure_is_retried_rather_than_surfaced` (which pins exactly one
    retry, so the error path cannot become the happy path).
  - **`syncAllowInsecure` is LOCAL-ONLY and is never synced, by design** (see
    `LOCAL_ONLY_KEYS` in `settings.rs`). `syncServerUrl` IS an ordinary synced setting, so a
    peer that can write it can already redirect this device anywhere; a waiver that travelled
    with it would let one poisoned record pair (`syncServerUrl: "http://evil.example"` +
    `syncAllowInsecure: true`) turn a remote setting write into a silent transport downgrade.
    Enforced at three points: `record_change` (never recorded), the
    `ensure_sync_projection` migration seed, and `apply_synced` (inbound peer records
    ignored).
  - **`syncVault` is LOCAL-ONLY too, and by the same mechanism.** The shared rule is "a
    switch whose flipped state moves data OFF this machine or makes it less private."
    `syncVault` is the opt-in that includes the password vault in E2E sync, and **every
    synced setting is writable by any device holding the account's data key** — that is
    precisely what the sync contract grants. So while it was synced, one record on one
    paired device turned credential upload on for every device the user owns, with
    nothing on screen reporting a sync event as the cause. It was already not sufficient
    on its own (`shared/types.ts` documents that a vault with its own per-device salt
    cannot sync until it adopts the account's shared salt, and `VaultState.syncEnabled`
    is false until then), so making it per-device costs one tick per device and closes
    the remote-write path. Enforced by the same three points.
    `the_local_only_list_is_exactly_the_two_credential_and_transport_waivers` asserts the
    list's exact membership, so a third key cannot be added without a test. `sync::state_json` publishes `allowInsecure` so the Sync tab reports the
    decision the core is actually enforcing instead of echoing its own checkbox. Covered by
    `settings::tests::sync_allow_insecure_is_local_only`.
  - **The HLC clock is seeded from disk at boot** (`sync_envelope::seed_clock`, driven by
    `sync_stores::seed_hlc_clock` from the `setup()` boot block). `CLOCK` is a
    `OnceLock<Mutex<(i64, u32)>>` initialised to `(0, 0)`, so without this the first stamp after
    a restart is `(now_ms, 0)` — correct only while `now_ms` exceeds every stamp the device
    holds, and it usually does not: a peer inside the accepted `MAX_REMOTE_SKEW_MS` window can
    push this device's clock 60 s into the future and the records it observes on disk inherit
    that wall; the user's own wall clock can also jump ahead (NTP correction, a VM resuming).
    Either way the next local edit is stamped BELOW the record it is trying to update, LOSES
    LWW, and is silently reverted by the following merge — and since the losing stamp is itself
    persisted, nothing the user does afterwards can win it back. Seeding takes a **max**, never an
    assignment, so it can only move the clock forward. It scans `sync_stores::HLC_CARRIERS`
    (a deliberate **superset** of `SYNCABLE`: `history` and `downloads` carry HLCs but are not
    synced) plus the two sync projections that live outside the array stores —
    `settings::sync_records_readonly` and `customfilters::sync_record_readonly`. Both exist
    because the obvious readers have write side effects: `settings::sync_records()` calls
    `ensure_sync_projection`, which WRITES `settings-sync.json`, and `customfilters::sync_record`
    calls `sync_envelope::tick` when the sidecar is missing, so calling it during seeding would
    seed the clock from a stamp it had just invented.
  - **The counter carries into the wall at its ceiling; it never saturates.** `bump` is the one
    place a counter is incremented, for all four sites. `saturating_add(1)` is the tempting
    one-liner and it is wrong: the clock would stop advancing, so every local edit while parked
    at `u32::MAX` gets an _identical_ stamp, `Ord` falls through to `node` (same device), and two
    of the user's own records tie with LWW decided by map iteration order. An attacker can hold
    the wall at the `MAX_REMOTE_SKEW_MS` ceiling for the whole 60 s window, so that tie window is
    a minute wide, not sub-millisecond. Carrying costs 1 ms of wall, which the wall clamp makes
    self-healing. Previously `local.1.max(remote.1) + 1` was reachable remotely: in a RELEASE
    build the overflow **wraps**, regressing the clock, after which no later local edit can
    outrank the attacker's record.
  - **The server's `ord` is the one wire field it AUTHORS rather than relays, so it is
    bounds-checked before adoption** (`sync_envelope::ord_is_adoptable`, used by
    `sync::open_wire`). `hlc` is AEAD-bound, but `ord` is not, so with `syncAllowInsecure` on a
    plain on-path attacker can set `ord.wall_ms = i64::MAX` — and every pulled record would then
    land beyond the reach of any real clock, so the user could never again change a favorite or
    history row on any device. Adoption now requires the value to deserialize as an `Hlc` (so a
    malformed or over-wide counter is out) **and** `wall_ms <= now + MAX_REMOTE_SKEW_MS`.
    Refusal falls back to the AEAD-authenticated wire `hlc`, so the only cost is a lost
    tie-break. The **exact** window boundary is asserted against the pure function, not through
    `open_wire` — `open_wire` reads the wall clock itself, so a 1 ms-tight boundary there is
    decided by how long the test took to get there.
  - **A pull PAGE-LOOPS** (`sync::MAX_PULL_PAGES`, `pull_url`, `next_cursor`). The server caps
    one `GET /v1/records` response at `MAX_RESPONSE_RECORDS` and hands back a `next` cursor, so a
    namespace larger than that cap is only fully pullable by following it. This client issued
    exactly ONE un-paged GET; it is the mirror of `PUSH_CHUNK` / `push_batches`, which fixed the
    identical cliff on the POST side. `next_cursor` treats absent, `null`, **and empty string** as
    the last page — an echoed `""` would otherwise re-request page 1 forever, since the server's
    own retain is `uuid > cursor` and every uuid sorts after the empty string. The cursor is
    **server-supplied text** and is percent-encoded via `url::form_urlencoded`, because unlike
    `ns` (a fixed internal string) a raw `&`/`#`/`+` in it would re-parse the query string.
    `MAX_PULL_PAGES` (64) is what stops a server that always answers with a cursor from spinning
    the client; on exhaustion we keep what was pulled, because a partial pull beats none.
  - **A response BODY is capped, because the timeouts bound time and nothing about size**
    (`sync::MAX_RESPONSE_BYTES`, 32 MiB, applied in `read_body_capped`). `resp.text()`
    buffered whatever the server sent, so "whoever holds the DNS name or the address" for a
    self-hosted deployment could make this process allocate until it could not — and a
    timeout cannot help, because a peer streaming 8 GB slowly is well inside a 30 s budget.
    The cap is on the RESPONSE, not the request, so a user with a large local history is
    unaffected; `read_body_capped` takes a `&mut impl Read` **specifically so this is testable
    without a socket**, and reads `MAX + 1` bytes because that extra byte is what distinguishes
    "exactly at the cap" from "over it" — a truncated body would otherwise reach
    `serde_json::from_str` as "unexpected end of input", naming nothing about the real cause.
    It also replaced `String::from_utf8(..).unwrap_or_default()`, which turned a decode failure
    into an EMPTY body that then parsed as "no records". The check runs BEFORE the status
    branch, so an oversized **error** body is refused too. Tests:
    `a_response_body_is_refused_when_it_is_over_the_limit_and_accepted_when_it_is_not`,
    `a_read_failure_is_reported_rather_than_read_as_an_empty_body`,
    `an_empty_body_still_reads_as_empty` (the other end — a body-less 204 must not become an
    error, or `Ok(Value::Null)` would be dead).
  - **A pull in which NOTHING decrypts is now an `Err`, not an empty success** (`sync::pull_verdict`).
    `open_wire` failures are per-record and non-fatal by design — one corrupt or legacy-keyed
    record must not block a namespace, and its own `eprintln!` is the diagnostic. But a namespace
    where **every** served record failed was returning `Ok(vec![])`, indistinguishable from "nothing
    changed", so the engine reported the namespace synced and cleared its dirty flag. That is
    destructive rather than cosmetic, because `sync_ns` PUSHES after the merge: it would go on to
    seal the local records up under the key it believes is right. The verdict is taken **after the
    page loop and before the merge**, so a total failure never reaches the push. A namespace that
    served **zero** records is still a success, or every fresh namespace would error forever.
    The overwhelmingly likely cause is a data key that no longer matches the one the records were
    sealed under (a re-key, a restored backup, or an account restored on a second device before
    its key arrived), so the message says so.
  - **A `429` from the sync server is TAGGED and backs the periodic pass off**
    (`RATE_LIMIT_ERR_PREFIX`, `is_rate_limit_error`, `rate_limit_backoff`, `next_periodic_delay`).
    `http()` flattened every non-2xx into `HTTP {status}: {text}`, so a rate-limit refusal was
    indistinguishable from any other failure and the periodic thread retried at exactly
    `syncIntervalSec` with **no backoff of any kind** — as often as every **1 s**, against a
    server whose per-device nonce cap keeps refusing for up to the 5-minute token TTL, so up to
    ~300 signed round trips (each an Ed25519 verification) to be told "wait". The backoff doubles
    from 30 s and is **capped at the TTL**, because the server's limit is a sliding window that
    only clears as already-issued tokens expire: a constant short delay keeps knocking inside a
    window that has not opened, and a constant long one stalls sync after the server would accept
    again. `next_periodic_delay` only ever **lengthens** the wait, and an explicit `syncIntervalSec`
    of `0` (periodic sync disabled) is never overridden. `rate_limit_until_ms` and
    `consecutive_rate_limits` live on `sync::Inner` and are deliberately **not** in `state_json`, so
    the `shared/types.ts` IPC contract is unchanged; a successful pass resets both, so a later
    refusal restarts at the short end of the curve rather than inheriting a stale streak.
  - **A near-duplicate collapse requires a record that ARRIVED FROM A PEER.** `merge_into_locked`
    runs `duplicate_losers` over the merged array — grouping LIVE rows by `normalize_url` (no
    `#fragment`, no trailing slash; `host` for the allowlist store), tombstoning the losers and
    **pushing** those uuids so the deletion converges. It used to do that UNCONDITIONALLY on every
    pass, including one where the server returned nothing, while its own comment claimed
    "collapse _cross_device_ duplicates" — a condition the code did not have. `places.rs`'s
    `favorites.add` stored the url VERBATIM with no dedup (only `saved.add` checks
    `live_has_url`), so favoriting `https://x/p` from the address bar and
    `https://x/p#comments` from an in-page link produced two rows that normalize alike: the next
    periodic pass (300 s default) tombstoned one, the uuid went into `changed`, and the user's
    own bookmark vanished here **and on every paired device**. The gate is `peer_keys` — the
    normalized keys held by a row whose uuid `merge_records` actually landed this pass, captured
    BEFORE the dedup appends its own losers or the gate would be satisfied by the act it guards.
    Convergence is unchanged: a tombstone is still an ordinary record, so a device that does
    collapse a peer-learned duplicate still propagates the delete. `duplicate_losers` itself is
    left pure and order-independent so the existing tests still pin it. `favorites.add` now also
    REFUSES a url that normalizes onto a live one ("that page is already bookmarked"), which
    closes the local collision at the source and is what the renderer's `saveErrorText` path
    reports (see `FavoritesManager` / `MobileApp` in `src/AGENTS.md`). Two tests, one per half:
    `a_pass_that_learned_nothing_from_a_peer_leaves_a_local_near_duplicate_pair_alone` and
    `a_near_duplicate_that_arrived_from_a_peer_is_still_collapsed_and_pushed` — the second
    exists so the gate cannot be "fixed" into never collapsing.
  - **An idle namespace is NOT re-uploaded, and the evidence is the PULL — never a persisted
    "what I last pushed" note.** `sync_ns` used to seal and POST every local record on every pass,
    so a device that had changed nothing still uploaded its whole namespace once per
    `syncIntervalSec` (300 s by default). Measured: 200 `saved` records = **148,580 bytes** of wire
    JSON per pass = **42.8 MB/day per namespace per device**, for a push the server's own HLC-LWW
    would discard. The CPU is NOT the point — sealing all 200 costs **1.52 ms** (7.6 us/record), so
    this is a bandwidth and battery fix, not a speed one. `push_is_redundant` skips the push when,
    for every local record, **the server already holds that uuid at this record's stamp or newer**,
    and both halves are load-bearing in opposite directions: the uuid half alone would call a
    device's own unsynced edit "already uploaded" (the server holds the uuid at an OLDER stamp —
    that is what an edit looks like), and the stamp half alone would call a WIPED server idle.
    `Held` is the server's view, read off the wire records the pull returned, and it is indexed
    **only on the `open_wire` success arm** — that call is what authenticates a wire record's
    cleartext `hlc` as AEAD associated data, so an unopenable record's stamp is an unauthenticated
    claim and must not be able to talk the device out of an upload. **The choice of the pull over a
    cursor is the design, not an implementation detail:** a cursor cannot detect a wiped server, a
    restored server backup, a re-pointed `syncServerUrl` or a re-keyed account, and it fails by
    looking perfectly healthy — the note is still there, the comparison still succeeds, and the
    user's data simply stops reaching the account. A check derived from the pull cannot go stale,
    because the pull re-asks every pass. Two other deliberate edges: an **empty** namespace is
    never redundant (`push_batches` keeps its one empty POST on purpose — it is the device's
    liveness probe — and there is nothing to upload to save the request), and the tombstone GC
    still runs on the skipped path, which is sound because "the server holds every local record at
    this stamp or newer" is a strictly stronger claim than the one the GC's placement rests on.
    Policy is `pub(crate)` and pure (`all` over the local array, so one uncovered record pushes
    the namespace), and 11 pure tests pin each direction — including the two ways the check can
    be wrong, a server that lost its data and a local edit the server has not seen. The WIRING
    is a separate end-to-end test that runs the real `sync_ns` — real pull, real merge, real
    AEAD, real HTTP — against a loopback server that stores what it is POSTed and serves it
    back, asserting on the NUMBER of POSTs the server saw across three passes (upload, idle,
    local edit). Five mutations were confirmed red: always-push, drop-the-stamp-half, `all`→
    `any`, and the two wiring mutations — and the last two are caught ONLY by the end-to-end
    test, so the pure tests alone would not have held the wiring.
- **Anti-fingerprinting / farbling** — `farble.rs`: opt-in document-start JS shim
  that perturbs fingerprinting surfaces with per-frame-origin, per-session deterministic
  noise. Key design points:
  - **Three levels** (controlled by `antiFingerprint` setting, default `"off"`): `standard`
    patches canvas (`getImageData`/`toDataURL`/`toBlob`), audio (`getFloatFrequencyData`/
    `getChannelData`), navigator/UA-CH (`hardwareConcurrency`/`deviceMemory`/
    `userAgentData.brands`); `strict` adds WebGL (`getParameter` UNMASKED\_\*/`readPixels`/
    `getSupportedExtensions`/`getShaderPrecisionFormat`). The gradient between levels is
    real and tested by `farbleShim.test.ts`.
  - **Salt + seed** — `SESSION_SALT` is a `OnceLock<[u8;32]>` CSPRNG-filled once at boot
    (`init_session_salt`), NEVER persisted, NEVER written to any store. The page receives
    only `public_seed = HKDF-SHA256(salt, "aegis-farble-seed-v1")` (16 bytes, one-way).
    Per-origin sub-seeds are derived INSIDE the shim from `SHA-256(seed || origin)` — so
    the Rust core hands one token to the page and the shim fans out without another IPC
    call. `data.export` does NOT carry the salt (it can't — `OnceLock` is never in any store).
  - **Shim injection** — `shim_for(level, host_allowlisted)` returns the JS string with
    the `__AEGIS_FARBLE_SEED__` placeholder substituted by `seed_hex()`, which is then
    appended to the document-start script by `adblock_inject::script` (desktop) or returned
    by the `NativeFarble` JNI getter (Android). `off` or an fp-allowlisted host → `""` →
    no injection (fail-open).
  - **Per-site fp-allowlist** — a separate `fp-allowlist` syncable store (not the ad-block
    allowlist). Managed by `FarbleState` + `host_allowlisted`; dispatched via `fingerprint.*`
    IPC channels (`getState`/`toggleAllowlist`/`removeAllowlist`/`clearAllowlist`);
    `seed_from_disk` pre-warms it at boot. Shipped on Android too: the JNI getter has no
    `AppHandle`, so `FarbleState` is mirrored into the `ANDROID_FP_ALLOWLIST` process-global
    by `note_fp_allowlist` and read by `android_host_allowlisted`. Kotlin passes the tab's
    content host (`MainActivity.createTabWebView` → `NativeFarble.farbleScript(host)`), so
    an allowlisted host gets no shim — the same behaviour as desktop. (This doc previously
    described the global as an unimplemented parity gap; the code had shipped it.)
  - **Android boot seeds the level too** — `farble::seed_from_disk` pushes the CLAMPED
    `level(app)` into the `ANDROID_LEVEL` global, not just the allowlist. This is a
    separate obligation from the allowlist push because the level lives in settings, not in
    `FarbleState`, and `settings.rs` only re-pushes the global on a CHANGE. See gotcha
    item (d) below for the whole class.
  - **Per-spawn limitation** — like the WebRTC shim, the farble shim is evaluated once at
    content-webview creation. Toggling level or fp-allowlist applies only to newly
    spawned/reloaded tabs; in-tab SPA navigations to a different host are not re-evaluated.
  - **Honest limits** — a same-world JS shim is detectable (Proxy/toString probing, pristine
    iframe comparison); hence default-off + per-site escape hatch. On WebKit (Linux/macOS)
    the UA is now an HONEST Safari string rather than a Chrome claim (it claimed
    `Chrome/148` until 2026-10-03, which is what broke Cloudflare — see `nav::content_ua_for`
    for the measured four-arm table), so that one inconsistency is gone; the shim remains
    detectable by the engine quirks it does not touch.
    Seeding is per-frame-origin (weaker than Brave's per-top-eTLD+1 — a cross-origin iframe
    can't read `window.top.origin`). `strict`/WebGL is highest-risk and opt-in-within-opt-in.
    This is NOT engine-level farbling and the docs never claim parity with Brave's in-Blink tier.
  - **Runtime verify** — vitest `farbleShim.test.ts` (authoritative for shim behavior; passes).
    Live farble-a-real-page, Android device, Win/macOS GUI **PENDING** user.
- **Link gestures** — `link_gestures.rs` + `link_gestures.js`: **Ctrl/Cmd+click,
  middle-click and Shift+click on a link open it in a new BACKGROUND tab** instead of
  navigating the tab you are reading. A document-start layer (`include_str!`'d, run via
  `initialization_script_for_all_frames` on desktop and `addDocumentStartJavaScript` on
  Android), composed FIRST by `adblock_inject::compose_layers` — **ordering is
  correctness, not preference**: it reads the page's native `window.open` at document-start,
  which it can only do before `POPUP_GUARD` replaces it, and the guard refuses exactly the
  cross-origin open a Ctrl+click is. Injected on every frame, so an in-frame link honours it
  too (the `on_new_window` gate is per-request, so it still applies).
  **No IPC channel and no new bridge exist for this.** On a gesture it calls the native
  `window.open`, so the request lands on the same `nav::on_new_window` /
  `MainActivity.onCreateWindow` handler a `target=_blank` click already uses and inherits
  the identical gates (`is_unwanted_popup`, `is_navigable`). Shift+click maps to a tab
  because Aegis is single-window and has no window to create.
  **Never branch on `window.open`'s RETURN VALUE in this layer — it is null on SUCCESS,
  twice over.** (1) `noopener` in the features string makes the spec return null even when
  the window opened; (2) `nav::on_new_window` answers `NewWindowResponse::Deny` and opens
  the background tab ITSELF, so no `WindowProxy` is ever handed back. An early version read
  the return value and navigated this tab when it came back null, which meant EVERY
  modifier-click opened a new tab AND replaced the page behind it. `preventDefault()`
  already cancels the navigation, so a refusal must stay a no-op: refusing to open a link
  beats opening it twice. `link_gestures.rs::the_gesture_never_navigates_this_tab_itself`
  pins it, and the vitest stub's DEFAULT return value is `null` — modelling the convenient
  truthy object is exactly what hid the bug the first time.
  **`isTrusted` is the whole security argument**: the layer lives in the page's world, so
  page script could otherwise `dispatchEvent` its way to mint tabs; every branch requires
  `isTrusted`, which the engine sets for real input and leaves `false` for script. The layer
  never REASSIGNS `window.open` — only reads it — so the pop-under guard stays armed for
  scripted popups. Non-http(s) schemes (`mailto:`/`tel:`/`javascript:`) fall through to the
  engine. A refused popup falls back to navigating this tab, so a gesture is never a silent
  no-op. The native reference stays in the IIFE closure: the only thing published on `window`
  is a non-enumerable, non-writable idempotence marker (a top-level var would leak to the
  page's global and become a cross-site super-cookie handle — the `farble` rule).
  Authority for the JS is the vitest runtime test `src/lib/linkGestures.test.ts`, which
  executes these exact shipped bytes in true global scope. **Its limit, stated because it is
  the interesting part:** jsdom cannot produce a trusted event, so the test captures the
  handlers off the layer's real `addEventListener` calls and invokes them directly. That
  proves the wiring, the `isTrusted` BRANCH, href/scheme resolution and `preventDefault`; it
  CANNOT prove that page script cannot set `isTrusted` — that is a browser platform
  guarantee, not a jsdom one.
- **WebRTC IP-leak defense** — `webrtc_shim.rs`: the `webrtcPolicy` setting
  (`default`/`public-only`(default)/`disable`) as a document-start JS shim that wraps
  `RTCPeerConnection` to filter local/private ICE candidates (the `icecandidate` event,
  `createOffer`/`Answer` SDP, `localDescription` getters, **and `getStats()`**) while
  keeping TURN/relay so calls survive. The shipped JS is single-sourced in
  `webrtc_shim.public-only.js` / `webrtc_shim.disable.js` (`include_str!`'d) and executed
  by the vitest runtime test `src/lib/webrtcShim.test.ts` (authoritative); the Rust
  `is_local_address`/`keep_candidate`/`filter_sdp` are a parallel unit-tested reference.
  Baked into the injection by `adblock_inject::script(app, host_allowlisted, host)`, which
  now resolves the per-site escape hatch from its OWN list (`webrtc_exempt::host_exempt`),
  not from the ad-block allowlist — see the bullet below. Native
  backstops: Linux `set_enable_webrtc(false)` for `disable` only (`linux_layout`); Windows
  `--force-webrtc-ip-handling-policy` via `additional_browser_args` (which **replaces**
  wry's defaults, so it re-includes both `--disable-features=…` and
  `--autoplay-policy=no-user-gesture-required`). Android: the policy lives in a global
  (`note_policy`, seeded at boot + on `settings.set`), read by the `NativeWebrtc.shimScript`
  JNI getter and registered per-tab. **Residual matrix (honest):** the shim covers page +
  iframe frames but NOT Web Worker scopes — which is moot for the leak vector, since
  `RTCPeerConnection` is `[Exposed=Window]` per the WebRTC spec and is NOT constructible in a
  Worker on spec-compliant engines (WebKit/Chromium), so there's nothing to leak there. The
  native backstops (`disable` worker-tight on Linux/Windows; `public-only` native on Windows)
  remain belt-and-suspenders for engine-wide coverage; macOS/Android are shim-only and rely on
  the Window-only exposure holding.
- **Per-site WebRTC exemption is a SEPARATE, never-synced store** — `webrtc_exempt.rs`.
  It used to reuse the ad-block allowlist (`adblock::host_allowlisted`), which put a
  privacy control behind a preference list that **is** in `sync_stores::SYNCABLE`. Any
  device holding the account data key could then write one record that permanently turned
  IP-leak protection off for a host on every device the user owns, and no UI anywhere
  reported a sync event as the cause. `STORE = "webrtc-allowlist"` is deliberately absent
  from `SYNCABLE` — that absence IS the security property, and
  `the_exemption_store_is_not_reachable_from_sync` asserts it directly. It is included in
  `data.export`/`data.import`, because a host list that never syncs has exactly one other
  way to reach a new machine and silently dropping it would restore a backup with
  protection ON for sites the user had deliberately turned it off for.
  **It mirrors `fp-allowlist` exactly** (`jsonstore::live_hosts` + `add_host` /
  `remove_host` / `clear_hosts`; a `host_of` validator; an app-free `ANDROID_EXEMPT`
  global for the JNI getter; `seed_from_disk` at boot for the same reason farble's does),
  which is the point: WebRTC was the LAST privacy control still reading the ad-block
  allowlist, so decoupling it makes the code match its own stated design. Match scope is
  still `adblock::host_covered` — the ONE definition of "allowlisted" — so the two lists
  cannot drift in what they MATCH while remaining separate SETS. `dispatch` deliberately
  does NOT `sync::nudge`: there is nothing to sync. 10 tests, and the renderer surface
  (`webrtc.getExemptHosts`/`toggleExempt`/`removeExempt`/`clearExempt`, `useWebrtcExempt`,
  a "Sites with WebRTC protection off" list in `SecurityTab`) is pinned by
  `ipcClient.contract.test.ts` and `SecurityTab.test.tsx`.
  **This gap is CLOSED — `lib/protectionSummary.ts` WAS updated.** It reports
  `webrtcExempt: hostCovered(webrtc.exemptHosts, host)` as a REQUIRED field and
  `AdblockShield.tsx` consumes it, so a host whose WebRTC protection is off reports off
  instead of claiming "public-only". An earlier revision of this file listed it as a
  second control-that-lies instance; no follow-up is outstanding.
- **Linux** — `linux_layout.rs`: works around **tauri#10420** by reparenting
  webkit2gtk widgets GtkBox → GtkFixed; title-changed signal feeds history +
  routes the element-picker sentinel; Esc-exits-fullscreen; GTK key hook
  handles Ctrl+T/W/Shift+T tab shortcuts (accelerator menus used on Win/macOS).
  `connect_block_counter` counts ads for the badge via `resource-load-started`.
  **Correction (verified by the autopilot A/B trace):** the content filter blocks
  declaratively with no per-block callback, and `resource-load-started` does **NOT**
  fire for a request the filter blocks (the load is cancelled before the signal). So the
  counter only sees requests the _capped_ content filter ALLOWED, and counts the ones the
  _full_ engine flags (`should_block`) — i.e. ads that slip past the ~50k-rule filter cap
  but the engine still catches. **Consequence:** well-known hosts (top of EasyList) are
  always within the cap → filter-blocked pre-signal → blocked but **never counted on the
  badge** (real blocking, invisible count). This is why the autopilot proves blocking from
  the A/B trace (ad subresources fire with ad-block OFF, vanish with it ON) rather than
  from the shield count. (WebKit also negative-caches a blocked URL, a separate reason a
  page of _static_ ad URLs under-counts on reload — moot for real, per-request-unique ad
  URLs.)
- **Password vault** — `vault.rs`: Phase A encrypted-at-rest credential manager (NO
  autofill, NO page→core bridge — locked decision). Pure Rust core with **zero
  platform-gated code** (`#[cfg(target_os=…)]` appears only in the `#[cfg(test)]`
  block) → identical on Linux / Windows / macOS / Android. Key design points:
  - **Crypto:** master password → Argon2id (OWASP params, per-vault 32-byte random
    salt) → 32-byte DEK (`Zeroizing<[u8;32]>`). Records sealed individually with
    XChaCha20-Poly1305 via `crypto::seal`/`crypto::open`. AAD binds `ns|uuid|updatedAt`
    so record splicing fails authentication. Same crypto as `sync.rs` — no new cipher.
  - **File layout on disk:** `vault.json` holds `{v, kdf, salt, verifier{nonce,ct},
records[{uuid, updatedAt, nonce, ct}]}`. The only cleartext fields are the
    non-secret KDF salt and per-record routing (uuid, updatedAt). Written via
    `jsonstore::write_atomic` (temp→fsync→rename); `.bak` is kept on every write.
  - **In-memory state** (`VaultState` → `Mutex<Inner>`): locked (`key=None`, `records`
    empty) by default and at every boot — never auto-unlocked from a keychain in Phase A.
    On `vault.lock`, `Zeroizing` wipes the DEK on drop; `Cred` is `Zeroize+ZeroizeOnDrop`.
    Every read/mutate channel returns `Err("vault is locked")` when `key` is `None`.
    That `Mutex` is `std::sync::Mutex` and is **NOT reentrant**, and `ipc` is a
    synchronous Tauri command, so a nested `lock()` does not merely slow a vault read down —
    it wedges the GUI thread permanently. `state_json` is the trap: it wants a snapshot of
    `Inner` _and_ `sync_vault::is_sync_enabled`, and the latter ends in `unlocked_key`,
    which locks the same mutex. It therefore copies the four fields it owns out and
    **releases the guard before asking**. This was not theoretical: it froze
    `vault.getState` in the one configuration where vault sync works (created vault +
    opt-in + sync engine on + v2 + unlocked), which is exactly the state the tests never
    built, because every gate inside `is_sync_enabled` short-circuits before `unlocked_key`
    when `syncVault` is off, the engine is off, or the vault is v1. If you add a field to
    `state_json`, ask whether its value can be reached another way — `persist`, `read_file`
    and `adopt_resealed` are all safe to call under the guard; `unlocked_key`,
    `is_sync_enabled` and `state_json` are not.
  - **The vault DOES sync**, but only under four conditions that must all hold — see
    `sync_vault.rs` (its module header is the canonical design note) and `vault.rs`'s
    header. The old bridge was removed because it merged remote records by `updatedAt`
    _without decrypting them_, which let a peer overwrite a real credential with
    permanently unreadable ciphertext. What replaced it fixes both halves of that: - **Portability.** The cross-device failure was never "the Argon2id salt is secret" —
    a salt is public by design and is stored in plaintext in `vault.json`. It was that
    every device minted its _own_ random salt, so `Argon2id(password, salt)` differed
    per device. The KDF is therefore UNCHANGED: the account publishes one salt as a
    single record (`uuid:"meta"`) in a new synced namespace **`pwvault-meta`** (sealed
    under `crypto::data_key(root,"pwvault-meta")`), and a joining device **adopts** it
    via `reseal_with_salt` — pure re-encryption, no new derivation. The file's
    already-written-but-previously-unread `"v"` field is the KDF version:
    `KDF_V_LOCAL=1` (per-device salt, cannot sync) / `KDF_V_SYNCED=2` (adopted).
    The adopted salt is cached in `vault-sync.json` so the sync pass (has the root, no
    password) and `vault.unlock` (has the password, no root) can meet without either
    blocking; **unlock never touches the network, and removing the account can never
    brick the vault.** - **The handshake has THREE steps, and the third is the one that is easy to omit.**
    A joining device adopts, so for it the salt already exists. The FIRST device has nobody
    to adopt from: it becomes the account's vault by **publishing its own** salt, and
    publishing used to require already being the account's vault — `local_meta_record`
    demanded `is_synced`, `is_synced` demanded an adopted salt, and a salt could only ever
    arrive from a published record. A circle with no entry point, so the `syncVault` toggle
    could never take effect on a cold install. It now publishes a v1 vault's salt when the
    account has none yet **and** the user has opted in (`vault_sync_opted_in`, the two
    conditions knowable _before_ adoption — deliberately NOT `is_sync_enabled`, which
    demands the very thing being guarded), and the pass then stamps the file through
    `vault::stamp_shared_salt`. That stamp is password-free on purpose: the salt did not
    change, so the key in memory is already the account's key and a re-seal would be a
    cryptographic no-op — which is what lets the publisher reach a synced vault inside a sync
    pass, where no master password exists, instead of waiting for a lock/unlock cycle a user
    who just created the vault has no reason to perform. The same circularity made
    **adoption** unreachable: `try_adopt` guarded on `is_sync_enabled`, i.e. on adoption
    already having happened, so no device that had not adopted could. `try_adopt` is
    therefore guarded on `vault_sync_opted_in`. A joiner still adopts for real at unlock
    (`reseal_with_salt` under the account's salt) and still publishes nothing, so it cannot
    re-key the account out from under records already on it. - **Integrity.** `vault::merge_remote` authenticates every incoming record with
    `open_record(&vk, r)` BEFORE it is allowed anywhere near the file. Failures are
    counted as quarantined, never written, and reported via the **`sync.vaultQuarantined`**
    event (`{count, uuids}`) — an _event_, not a sync error, because a rejected forgery
    is a security outcome and must not fail the namespaces that did merge. So a peer
    holding the recovery phrase but NOT the master password cannot derive the vault key
    (it lacks the Argon2id output) and cannot forge an authenticating record. - **Consent.** A separate persisted `syncVault` setting, **default `false`**, gates
    the whole thing — configuring a server must never silently start uploading
    credentials. `VaultState.syncEnabled` is `settings.syncVault && sync enabled &&
adopted && vault unlocked` (four conditions; the first two are `vault_sync_opted_in`);
    `adoptionNote?` appears only on the `vault.unlock`
    response when adoption was refused (e.g. undecryptable records block the re-seal),
    and the unlock itself still succeeds. - **Two seal layers, both required.** The wire record is sealed under the SYNC ROOT
    (`seal_wire(data_key(root,"pwvault"), "pwvault", rec)`), wrapping a record layer
    `{uuid,updatedAt,nonce,ct}` sealed under the VAULT key. Vault records carry
    `updatedAt` (i64 ms) rather than a real HLC, so the push side synthesises a stable
    `{"wall_ms":updatedAt,"counter":0,"node":"vault"}` into the transport's cleartext
    `hlc` AAD field, derived from the record's own timestamp so re-pushing an unchanged
    record reuses the same AAD instead of forking a new version. - **A locked vault does not sync at all** — it is neither uploaded nor merged, because
    you cannot merge records you cannot decrypt. - **A peer's DELETE must be durable even
     when this device never held the record it deletes.** `merge_remote` receives a
     tombstone for a uuid, authenticates it, and (until this was fixed) pushed that uuid into
     `changed` **only if a local record was actually removed** — which is false on any device
     that was not holding that credential, i.e. the *normal* case for a third device. The
     in-memory marker was still inserted, but the persist step only writes when
     `!out.changed.is_empty()`, so the marker never reached disk. `vault.lock` clears
     `g.tombstones` in memory and `unlock_vault` rebuilds them from `vault.json`, so at the
     next lock the delete was simply gone — and the record itself came back on the following
     pass, because that marker was the only thing vetoing it. `upsert_tombstone` therefore
     returns whether it actually changed the list, and `merge_remote` carries a
     `tombstone_dirty` flag that forces the write even when nothing local changed.
     **The retain arm deliberately has no such flag, and that asymmetry is not an oversight:**
     a pass that reaches the retain path always puts the uuid into `changed` (it retained a
     record the peer no longer has), so a dirty flag there could never fire. A second
     "a marker and a record for one uuid" test was written and **deleted as unreachable** — a
     credential pass drops the uuid's marker and a tombstone pass drops its record, so no
     state the product can reach has both. Pinned by
     `a_delete_for_a_credential_this_device_never_held_survives_a_lock_and_unlock`.
  - **`vault.state` carries no credential data:** only `{exists, unlocked, count, undecryptable,
syncEnabled}` (`undecryptable` = on-disk records that failed to decrypt; preserved verbatim by
    `persist`/`Inner.orphans`, surfaced so the UI warns instead of silently dropping them).
    Plaintext credentials live only in `Inner.records` (in-process, while unlocked) and
    transiently in the serde_json `Zeroizing` buffer during seal/open.
  - **The content webview DOES get an autofill script** — this older claim ("no page bridge")
    was wrong. `adblock_inject.rs:103` appends `vault_inject::script()` (from
    `vault_inject.js`) to the document-start injection, and on Android
    `NativeFormDetect.formDetectionScript` returns the same script. It emits
    `form:formStateChanged` / `form:willSubmit` / `vault:requestFill` and listens for
    `vault:autofillResult` / `vault:autofillData` — but every one of those calls is gated on
    `window.__TAURI__`, which is **undefined in every webview because `withGlobalTauri` is not
    enabled**, so the whole path is inert. Do not read inert as safe: Tauri 2's `app.emit`
    broadcasts to every webview and this codebase has no `emit_to`, so enabling `withGlobalTauri`
    would deliver any credential to every open tab. Phase A ships no autofill.
  - **IPC dispatch** in `lib.rs` via the standard `vault::dispatch(&app, &channel,
&payload)` arm. Channels: `vault.getState`, `vault.create`, `vault.unlock`,
    `vault.lock`, `vault.list`, `vault.add`, `vault.update`, `vault.remove`,
    `vault.search`. Event: `vault.state` (via `emit_event` → `.`→`:` rewrite).
  - **Unit-tested via `test_support::with_tmp_app`**: init/unlock round-trip, wrong
    password rejection, lock zeroizes key + clears records, list-while-locked rejected,
    add/update/remove CRUD round-trips, at-rest ciphertext has no plaintext fields,
    update/remove persistence + reload, dispatch wrong-password, search. (42 tests in
    `vault::tests`.)
- **Content-webview Proxy** — `proxy.rs`: routes browsed pages through a user-configured
  HTTP or SOCKS5 proxy. **This is a Proxy, not a VPN** — content-webview-scoped only; leaky
  (DNS/QUIC/UDP outside the proxy path; WebRTC mitigated by the shipped WebRTC fix); does
  not cover the chrome's own updater/filter-list fetches. Per-platform apply mechanisms:
  - **Linux** — live setter: `WebsiteDataManagerExt::set_network_proxy_settings` with
    `NetworkProxyMode::Custom` + `NetworkProxySettings::new(uri, bypass)` per content
    webview. Called on every `proxy.setConfig` / `proxy.clear` via per-tab fan-out from
    `apply_to_tab`, and at spawn via `nav::spawn_tab` so new tabs inherit the proxy.
  - **Windows** — spawn-time args only: `--proxy-server=<uri>` and
    `--proxy-bypass-list=<hosts>` injected into `additional_browser_args` in
    `nav::spawn_tab`. WebView2 browser args are immutable after creation, so the
    `apply_to_tab` live setter is a deliberate no-op on Windows. Toggling the proxy
    applies only to new or reloaded tabs.
  - **Android** — process-global: `NativeProxy.kt` JNI down-call reads the serialized
    `ProxyConfig` from `proxy::proxy_config_json` (a global `OnceLock<Mutex<String>>`
    updated by `note_config` on every `proxy.setConfig` / `proxy.clear`). Kotlin calls
    `ProxyController.getInstance().setProxyOverride` / `clearProxyOverride`
    (feature-gated on `WebViewFeature.PROXY_OVERRIDE`). The proxy is process-global —
    it affects both the chrome and content WebViews; the chrome (`tauri.localhost`,
    `127.0.0.1`, `localhost`) is excluded via bypass rules. **Rust cannot JNI-up-call
    into Kotlin on Android** (see gotcha in Android JNI notes); the apply direction is
    always Kotlin DOWN to `proxy::note_config` for reading, not Rust UP.
  - **macOS** — NOT implemented. `apply_to_tab` is a `cfg(target_os="macos")` no-op.
    `WKWebsiteDataStore.proxyConfigurations` (macOS 14+) requires hand-rolled
    `nw_proxy_config_*` / Network.framework FFI bindings not present in `objc2-web-kit
0.3.2` and uncompilable from Linux. Deferred to sub-project I.
  - IPC: `proxy.getState` / `proxy.setConfig` / `proxy.clear` / `proxy.testConnection`
    (TCP-reachability probe, not egress verification). `ProxyState` (`Mutex<ProxyConfig>`)
    managed at boot; seeded from `settings::proxy_config`. Persisted into settings key
    `"proxy"` through **`settings::apply_local`** — the shared locked local-edit region — with
    `{"partial": {"proxy": <cfg>}}`. It used to do its own `settings::all` → mutate →
    `settings::write` instead, which (a) ended in a production
    `.expect("settings fixture write")` that **aborted the process** on any failed save (a
    Tauri command body has no `catch_unwind`) and (b) took no store lock and recorded no
    per-key sync projection entry, so a concurrent settings save / `merge_remote` /
    `data.import` could revert it and the config never left the device that set it. Going
    through `apply_local` fixes the lock, the validation, the projection and the panic at
    once. **Consequence: the proxy config syncs like any other non-local-only setting.**
    `proxy.state` event emitted on every config change.
  - Unit-tested in `proxy::tests`: `from_value` parse/validate, `default_uri` schemes,
    `is_active` guard, `test_connection` socket probe, serde `bypassHosts` round-trip
    (the canonical key lesson — see gotcha 22 below), plus four dispatch-level tests that pin
    the persistence route: `a_failed_settings_write_is_reported_rather_than_aborting_the_process`
    (the panic regression — forces the failure with a non-empty **directory** at
    `settings.json` via `test_support::block_store_file`, because `chmod 0500` is a no-op as
    root), `the_persisted_proxy_is_the_sanitised_config_not_the_callers_bytes` (the
    `--remote-debugging-port` injection host is blanked **on disk**, not just in memory),
    `a_proxy_change_becomes_a_sync_projection_record`, and
    `the_proxy_config_round_trips_through_the_store_and_clear_returns_to_off`.
- **Misc** — `picker.rs` (element picker, **desktop-only**: Linux/Windows/macOS each inject
  the overlay natively; Android has no tier and `picker.start` answers `{ok:false}`),
  `form.rs` (**a seam, not a mechanism — NEITHER detection mode works, and the module
  header says so**; `form.detectLoginForm` used to eval a script and block a
  SYNCHRONOUS `ipc` on a 5 s oneshot, answering a `{hasLoginForm:false}` the renderer
  could not tell from a real negative, and now answers `Err(DETECT_UNSUPPORTED)` from a
  function that takes no app handle and reads no state; `form.state` has no producer on
  any platform and the MutationObserver the header describes is not in the codebase).
  `dispatch`, `install_listener`, `emit_form_state` and `emit_will_submit` are all
  generic over `R: Runtime` purely so a `MockRuntime` test can reach the routing and the
  pending-request map; that is what `a_refused_detection_arms_no_pending_request` pins
  (the refusal must arm nothing, which is the direct observable of the removed blocking
  impl) and what `a_detection_result_answers_only_the_request_that_asked_for_it` pins
  (a lookup that ignored the `requestId` would bleed one tab's form state into another's
  pending answer). `emit_will_submit` is still a `TODO(M13)` stub with zero references
  while the renderer subscribes to `form.willSubmit` — see gotcha 26,
  `update.rs` (tauri-plugin-updater state). **`update.getState` answers the
  MANAGED `UpdateState`, not a freshly-minted default**, so a `set` that ran
  first is observable through the same channel; the `idle()` shape is the
  fallback for an app that has not registered the state at all, and it is what
  a fresh install renders.
  `dispatch` and `set` are generic over `R: Runtime` so a `MockRuntime` test can
  reach both, which is what pins that `set` writes the store **and** emits
  `update.state` — the two halves the chrome depends on separately, since a
  `set` that only stored would leave a live install's badge frozen.
  **The two spawn arms (`update.checkNow`, `update.restartToInstall`) are
  deliberately NOT asserted on.** `with_tmp_app` registers no tauri plugins, so
  `app.updater()` fails on a `MockRuntime` and the spawned task would `set` an
  `error` state — and waiting for an async `set` in a unit test is a race, which
  is worse than an honest gap. What IS asserted is the part that is a genuine
  contract: both answer `Value::Null` immediately, because answering a state
  would mean doing the network round-trip on the SYNCHRONOUS `ipc` command —
  the same defect class `form.detectLoginForm` had.

## There are no dev-only side channels

`lib.rs` has a single `generate_handler![ipc]` and `shared/types.ts`'s `IPC` const is the
only renderer→core surface. Earlier revisions of this file documented a
`src-tauri/src/autopilot.rs` module with four `#[tauri::command]` functions
(`autopilot_screenshot`, `autopilot_write_report`, `autopilot_done`,
`autopilot_emit_event`) registered through a cfg-split `invoke_handler`; that module
never existed and has since been removed along with the renderer-side harness.

Do not add such a side channel. Every renderer→core call goes through the one `ipc`
chokepoint (see the top of this file); a debug-only bypass would be a second, untested
path through the same boundary.

> **Reading the older "the autopilot caught X" notes below.** Several gotchas in this file
> record that a regression was found by the now-removed renderer harness (e.g. lines 92,
> 383, 787). Those are **historical provenance** — how a bug was caught at the time — not a
> claim that any gate catches it today. Each is marked with what covers it now.

## Key dependencies (`Cargo.toml`)

`tauri` (feature `unstable` for multi-webview), `adblock` (feature
`content-blocking`), `tauri-plugin-updater`,
There is deliberately **no `tauri-plugin-dialog`**. It was registered with no `dialog:*` grant, no JS package and no caller, so nothing could reach it — and the native save dialog it would have provided is separately rejected in `data.rs` for rendering in the OS light theme against a dark UI (a backup is written to a fixed location, and `DataTab` imports through the webview's own `<input type="file">`). `tests::no_dialog_plugin_is_registered_or_declared` fails if the dependency or the registration comes back.
`tauri-plugin-log`, `reqwest` (blocking), `rustls`. Platform-gated blocks:
Linux → `gtk`/`webkit2gtk`/`glib`/`gio`; Android → `jni`; Windows →
`webview2-com` (pinned) + `windows`.

## Unit-test harness (`src/test_support.rs`)

The crate's `#[cfg(test)]` harness lives in `src/test_support.rs` and is compiled
only into test binaries (never into the release artifact). It solves two problems
that the AppHandle-backed modules share:

**Problem 1 — path isolation.** Every data store resolves its path from
`app.path().app_data_dir()`, which on Linux reads `$XDG_DATA_HOME` (and similarly
`$XDG_CACHE_HOME` / `$XDG_CONFIG_HOME`). A `tauri::test::mock_app()` has an empty
bundle identifier, so `app_data_dir()` resolves directly to `$XDG_DATA_HOME`. The
harness redirects all three env vars to a fresh per-test temp dir before the mock
app is built, and removes the dir on exit — so test IO never touches real user data.

**Problem 2 — process-global serialization.** Env vars are process-global and
`cargo test` runs tests on many threads. A process-global `static Mutex<()>` (`LOCK`)
serializes every call to `with_tmp_app`, so two tests can't race on the env vars or
on process-global statics like `sync_identity::NODE_ID` and the adblock
session/page counters. A poisoned lock (from a panicking test) is recovered via
`into_inner()` so one failing test doesn't cascade-fail the rest.

**Reading the policy is also a write hazard.** `adblock_engine`'s `ENABLED` /
`ALLOWLIST` are written through `set_policy` from exactly two non-test places —
`adblock::sync_engine` and `adblock_refresh::refresh` — and every test that reaches
either one goes via `with_tmp_app`, so they are covered. What is _not_ covered by
default is a **non**-AppHandle test that only _reads_ the policy: it never touches
`LOCK`, so it ran concurrently with every writer. `adblock_engine`'s own tests were
exactly that case, and CI run 36280528312 flaked on it (the engine test's first
assertion failed while an `adblock` test held `enabled = false` across a dispatch
round-trip). Both engine tests now take `test_support::lock()` explicitly — the
existing lock, not a module-local one, which would not exclude the `with_tmp_app`
tests at all. When adding a test that calls `should_block` / `is_unwanted_popup`,
take that lock.

**Taking the lock is necessary but NOT sufficient — CI run 36447158645 flaked on
that same test anyway.** The old warm-up was a single throwaway `should_block`
call, justified as "if it times out, the engine is warm by the time the real
assertions run". That reasoning is **false**: a `recv_timeout` expiry leaves the
query still _queued_, so the engine is _busy_, not _warm_, and the very next query
queues behind the same backlog and fails open too. A probe (50 ms timeout, 4
queued reloads) gave `warmup=false real=false settled=false` — the warm-up bought
nothing, which is why "1 failure in 20 runs, always on this assertion" survived
the previous fix. The warm-up is now
`wait_until_engine_blocks(<the assertion's OWN query>)`: it retries until the
engine answers `true`, which can only come from a real verdict, and each attempt
also advances the FIFO. **That is only sound because replies carry a `seq`** —
before that fix a `true` could be a leftover from the previous attempt, and a
retry loop on top of the broken protocol reports a false "warm" and then
mis-answers every assertion after it (that is how the first version of this fix
failed on a _negative_ assertion instead of the flaky one). If you change either
the `seq` protocol or the retry helper, the other must move with it.

**The pattern — `with_tmp_app`:**

```rust
// In any test module:
use crate::test_support::with_tmp_app;

#[test]
fn my_test() {
    with_tmp_app(|app| {
        // `app` is an &AppHandle<MockRuntime>
        // all store IO lands in a temp dir; no real webview is spawned
    });
}
```

`with_tmp_app` constructs a `MockRuntime` app (via `tauri::test::mock_builder`) and
registers the 17 managed states that the real `lib.rs` builder + `setup()` install —
every one of the 18 `lib.rs` installs except `redirect_guard::RedirectBudget`, the
desktop redirect cap, which no mock-app test reads today:

| State                                                        | Source in `lib.rs` |
| ------------------------------------------------------------ | ------------------ |
| `view::ContentInset`                                         | builder            |
| `update::UpdateState`                                        | builder            |
| `adblock::AdblockState`                                      | builder            |
| `safety::SafetyState`                                        | builder            |
| `sync::SyncState`                                            | builder            |
| `redirect_guard::PendingNavs`                                | builder            |
| `redirect_guard::NavActions`                                 | builder            |
| `redirect_guard::Chains`                                     | builder            |
| `zoom::ZoomStore`                                            | builder            |
| `vault::VaultState` (locked by default — no auto-unlock)     | builder            |
| `farble::FarbleState`                                        | builder            |
| `proxy::ProxyState`                                          | builder            |
| `settings::SettingsCache`                                    | builder            |
| `history::HistoryStore`                                      | builder            |
| `downloads::DownloadsStore`                                  | builder            |
| `tabs::Tabs` (single-tab Registry, home `"about:blank"`)     | `setup()`          |
| `linux_layout::LayoutInsets` (`#[cfg(target_os = "linux")]`) | `setup()`          |

The mock never spawns real webviews, so dispatchers that call `spawn_tab` or
touch native webview handles skip or no-op silently in tests — that is expected
behavior (these are unit tests against a mock app, not GUI/runtime tests).

**Source-text pins read the file they live in, so scope them.** There is NO Kotlin test
source set, so every Android behaviour is pinned by reading `MainActivity.kt` as TEXT
(`test_support::kotlin_source`, plus `kotlin_fn_body` to take one function's brace-matched
body with `//` comment lines dropped — the Kotlin comments here QUOTE the code they
replaced, so a raw-text assert matches the documentation of a bug instead of the bug).
The Rust half has the mirror-image trap: `include_str!("nav.rs")` written _inside_
`nav.rs` also returns the test doing the including, so a whole-file `src.contains("…")`
is satisfied by the pin's OWN literal. `nav.rs`'s tab-title pin
(`the_content_webview_reports_a_title_the_page_changed_itself`) shipped exactly that:
deleting the `on_document_title_changed` hook from the wry builder — all three lines,
closure included — left it GREEN. `test_support::rust_production_source` now cuts the
source at `#[cfg(test)] mod tests` and drops comment lines, so a pin can only be
satisfied by production code, and a source with no test module PANICS instead of
silently passing the whole file through. Scope every source-text pin through it, and
prove the pin by neutralising the code it claims to pin — a pin never watched failing is
a comment.

**Convention for new AppHandle tests.** To add a test for a module whose
dispatcher takes `app: AppHandle<R>` (or any generic `<R: Runtime>`):

1. Add `#[cfg(test)] mod test_support;` to `lib.rs` (already done).
2. In the new module, add `#[cfg(test)] mod tests { ... }`.
3. Call `crate::test_support::with_tmp_app(|app| { ... })` in every test body.
4. If the dispatcher fn is not already generic over `<R: Runtime>`, make it so —
   `tauri::test::MockRuntime` implements `Runtime`, so a `fn foo<R: Runtime>(app:
&AppHandle<R>, …)` is callable with a `&AppHandle<MockRuntime>` without any
   test-only wiring. Keep platform-specific code (`#[cfg(target_os = "linux")]`
   etc.) in separate helper fns so the generic dispatcher compiles on all targets.
5. Do NOT assert absolute counter values — assert deltas (before → after) because
   the session-global counters persist across tests in one binary.
6. The `tauri` dev-dependency that enables `MockRuntime` is already declared in
   `Cargo.toml` (`[dev-dependencies] tauri … features = ["test"]`); no additional
   dep changes are needed.

## Test coverage — a ratchet, not a 100% claim

The Rust half of the coverage gate. Same promise as the TypeScript half
(`coverage-baseline.json` + `scripts/coverage-ratchet.mjs`): **coverage may rise,
never fall, and the baseline may never be lowered in the same commit that causes
the fall.** Both halves call the _same_ comparison logic (`compareToBaseline` and
`detectBaselineLowering` in `scripts/coverageCheck.mjs`), so "the ratchet" is one
rule with two front ends, not two rules that can drift apart.

```bash
export PATH="$HOME/.cargo/bin:$PATH"        # rustup/cargo are not on PATH by default
npm run coverage:rust:baseline              # regenerate src-tauri/coverage-baseline.json
npm run coverage:rust:ratchet               # the CI gate
```

Tooling: `cargo-llvm-cov` + the `llvm-tools-preview` component. Neither is a
`Cargo.toml` change, so adding them does not touch `Cargo.lock` and does not
trigger the ~4-minute full dependency rebuild a `rust-toolchain.toml` edit would.

### Measured, 2026-09-29 (Linux, `cargo llvm-cov --lib --json`, stable 1.98.0)

**The committed floor, taken with NO keyring** (see the floor rule below — these are the
numbers in `src-tauri/coverage-baseline.json`, and a machine with a working keyring measures
strictly higher):

| Metric               | Measured (floor)     | Gap  |
| -------------------- | -------------------- | ---- |
| lines                | 17636/20685 = 85.26% | 3049 |
| statements (regions) | 30641/36039 = 85.02% | 5398 |
| functions            | 2112/2638 = 80.06%   | 526  |

The report holds **45** files, all of which compile on Linux. **7 further modules are
`cfg`-gated out of a Linux build** and are listed in the baseline as inert here rather than
excluded from the report (`adblock_win`, `find_win`, `nav_policy_win`, `nav_url_win`,
`nav_url_mac`, `zoom_win`, `zoom_mac`). One report entry — `linux_layout.rs` — compiles
but is excluded as unexecutable in a headless session, so **44 files are in the gate**.
Before the exclusion list the same run reads 82.97% lines / 82.67% regions / 77.96%
functions — the difference is entirely `linux_layout.rs` (88/678 lines). With a keyring
those figures are ~1pp higher, which is exactly why the floor is the committed number.

**That floor is the MINIMUM of several runs, not one run — and the minimum is load-bearing.**
Stripping D-Bus makes the *keychain* tests skip deterministically (`sync_keystore.rs` reads
228 lines on every run, with or without a keyring it is 286), but it does **not** by itself
make the whole suite deterministic. Four `cargo llvm-cov` runs on one unchanged tree gave
lines 17630 / 17637 / 17637 / 17638, all with the same 2109 functions, and the entire spread
was two files: `sync.rs` 830–837 and `adblock_engine.rs` 310–311. A baseline generated from
one lucky run is a threshold the next run may miss, which is the same class of bug as the
keyring floor itself, one level down. **Regenerate from the lowest run, and re-run the
ratchet against several reports before committing a baseline.**

The two halves of that spread had **different causes, and both are now settled differently.**
`adblock_engine.rs` was the test-only warm-up helper *busy-looping* on a bare `bool` it could
not tell from a timeout, so its covered lines depended on timing; asking for a verdict
instead (see the `verdict_of` note above) made it deterministic, and three consecutive runs on
the fixed tree came back byte-identical (with `adblock_engine.rs` at 349 in all three).

`sync.rs` is the harder one, and the explanation is **not** "a sibling test left a root
behind". `restart_restores_an_enabled_sync_state` guards on
`sync_keystore::keyring_available()`, which probes with a *write*. Whether it returns true
depends on whether the box has a working **kernel** keyring, and stripping D-Bus does not
change that: keyring 3.6.3's `linux-native` backend tries the secret service first and then
falls back to the kernel keyring, which needs no session bus. A dev box (like this one) has
one, so the test proceeds and covers the opening of `sync_once`; a GitHub runner does not, so
it early-returns. That is a **39-line** gap — 836 against 797 — far wider than the 6-line
timing spread, and it is why CI run 36635754260 read `total lines 85.26% (17636/20685)` while
three local runs on the identical tree all read 85.45%.

**So the two unset `env -u`s reproduce the no-D-Bus condition, not the no-keyring one, and a
locally measured baseline is therefore NOT the floor CI enforces.** The committed numbers
here are CI's own, taken from run 36635754260 and carried into `src-tauri/coverage-baseline.json`
by hand, with each total asserted to equal the sum of the per-file records so the file stays
internally consistent. That is the one place in this repo where a committed threshold is a
measurement this machine could not take, and the reason is recorded here rather than left to
be rediscovered. **Regenerate the floor from a CI run, or from a box where `add_key` genuinely
fails — never from a dev box, and never from one run.**

**`statements` is llvm `regions`, not an istanbul statement.** A region is a code
span, not an expression. The label is a deliberate fiction that exists so the
shared comparison logic has a slot to read; the number is still a monotone
"how much of this file ran" measure, which is all a ratchet needs.

**`branches` is NOT gated, and the report's `0` is not a bug.** llvm's branch
coverage needs `-Z coverage-options=branch`, which is **nightly-only** — on
stable it fails with `error: the option 'Z' is only accepted on the nightly
compiler`. This repo pins stable 1.98.0 in `rust-toolchain.toml`, and measuring
branches would mean measuring a _different compiler_, which is not a ratchet.
`pctOf` returns `undefined` for a 0/0 metric, so the gate skips it instead of
comparing a fake 100%. The v8 TypeScript gate _does_ gate branches, because v8
gives them on the same run.

### The exclusion list — 8 files, each with a mandatory reason

`EXCLUSIONS` in `scripts/rustCoverageCheck.mjs`. Every entry is code that cannot
execute in a headless runner, so its 0% is structural and no test can move it.
Keeping it in the denominator would mean a fall anywhere else had to fight dead
bytes forever. Excluding it makes the gate's number a claim about code a test
_could_ have covered.

An entry without a sentence-length reason fails
(`assertExclusionsJustified`), and the reasons are copied into the committed
baseline so the file is self-describing. The list is printed with each file's
**real** numbers on every ratchet run, so a file can never quietly stop being
measured.

`expectOn` is the platform where the file is even **compiled** — a different claim
from "where it runs", and the one that decides whether the entry does any work.
MEASURED: on Linux exactly **one** of the eight reaches the llvm export
(`linux_layout.rs`, 0/604 lines); the other seven are `#[cfg]`-gated out of the
build. An entry expected here that matches nothing is a **hard failure** (the
file was renamed or deleted and the list is lying); an entry for another platform
is reported as inert.

| File                | Built on | Why it cannot be covered                                                |
| ------------------- | -------- | ----------------------------------------------------------------------- |
| `linux_layout.rs`   | linux    | WebKitGTK windowing — needs a live X/Wayland display and a real webview |
| `adblock_win.rs`    | windows  | WebView2 `WebResourceRequested` (COM)                                   |
| `find_win.rs`       | windows  | WebView2 `findString`/`findNext` (COM)                                  |
| `nav_policy_win.rs` | windows  | runs in the webview2 host process                                       |
| `nav_url_win.rs`    | windows  | `#[cfg(target_os = "windows")]` helpers                                 |
| `nav_url_mac.rs`    | macos    | objc2 / `msg_send!`                                                     |
| `zoom_win.rs`       | windows  | WebView2 `setZoomFactor` (COM)                                          |
| `zoom_mac.rs`       | macos    | WKWebView `pageZoom` (objc2)                                            |

`main.rs` (6 lines, calls `run()`) and the Android/Kotlin surface have **no
exclusion entry and no coverage at all** — they are not part of `--lib`, so they
are not in the report rather than being excluded from it.

### What the number does and does not measure

The gap is not spread evenly, and it is much narrower than it was. Real, measurable
debt now concentrates in one module and one dispatcher: `adblock_webkit.rs` 21.32%
(declarative WebKit content filters, no headless driver reaches them), `lib.rs` 36.83%
(what is left of the `ipc()` dispatcher and `setup`), `find_linux.rs` 37.62% (AT-SPI over a
session bus), `tabs.rs` 55.48%, `sync.rs` 59.61%, `sync_keystore.rs` 63.87% (the floor's
no-keyring figure — 228 of 357), `nav.rs` 66.57%, `permissions.rs` 76.30%,
`redirect_guard.rs` 79.14%, `update.rs` 81.43%, `subs.rs` 82.51%. The covered end is
`vault_inject.rs` 100%, `sync_auth.rs` 98.92%, `sync_envelope.rs` 98.82%, `tab_registry.rs`
98.14%, `data.rs` 98.06%, `customfilters.rs` 97.70%, `crypto.rs` 97.27%, `find.rs` 97.02%,
`jsonstore.rs` 97.13%, `zoom.rs` 93.56%, `form.rs` 91.98%, `view.rs` 87.39%. `sync.rs` is
quoted at its FLOOR value (797 of 1337), so a run that measures higher reads better than the
table, never worse.

The table is the floor, so a file can also sit below it, and one does. Measured on the
current tree: `nav.rs` 700/1043, `tabs.rs` 513/904, `zoom.rs` 229/244 and
`redirect_guard.rs` 624/663 are all above their floor entries, while `lib.rs` measures
**194 of 543** against the floor's 200 — and CI's runner measured that same 194, so it
is not a dev-box artefact. It is a stale entry: `a810267`, the commit that set this
floor, hand-edited exactly the three totals and `sync.rs`'s three covered counts and left
`lib.rs` alone, and `0bf98f8` — the only `lib.rs` change since, `+15/−5` of doc comments
and one string literal — cannot move a covered count, because the module's counted line
total is 543 in both. Per-file entries do not gate: the ratchet compares totals and
prints these deltas as diagnostics. So nothing depends on that number being right, and
the generated baseline is left alone rather than hand-edited.

`adblock_engine.rs` reads 91.84% (349 of 380) and is the one place where a **lower ratio is
the better news**: the engine's test suite gained the answered-verdict plumbing and its own
test, which added 51 total lines of which 39 are covered, so the percentage fell from 94.22%
while the covered count rose from 310. The uncovered remainder is the three "no verdict"
arms (`send` failed, `Timeout`, `Disconnected`) and the retry path, which cannot be reached
without stalling the engine for more than `QUERY_TIMEOUT` — not fast-testable, and the flag
contract is covered directly instead.

**Read the direction of travel before reading the ratio.** `zoom.rs` went 18.57% → 93.56%
and `lib.rs` 16.46% → 36.83% because the dispatchers were driven under `MockRuntime`;
neither number moved by deleting anything.

**A percentage can rise while the codebase gets worse**, exactly as on the
TypeScript side: deleting 0%-covered code moves the ratio and not one test.
The absolute `covered` column above is the honest companion number.

### The Rust coverage baseline is a FLOOR, measured without a keyring

`src-tauri/coverage-baseline.json` is generated with **no OS keyring available**, and it has
to be. The three keychain round-trips in `sync_keystore.rs` share one keyring, so their
covered-line footprint depends on credential state left behind by earlier runs. Measured
across four runs of the same tree and toolchain: `sync_keystore.rs` covered **286, 289, 300**
lines with a keyring, and **228** without one; `sync.rs` moves 574 vs 498. CI's
`cargo llvm-cov` has never had a usable keyring — runs 36325245069 and 36326730887 both
reported exactly 11038/14750, twice. (Those four runs are the pre-2026-09-28 tree; the
current tree moves `sync.rs` 785 vs 703 and `sync_keystore.rs` 286 vs 228.)

**On the current tree the same command is bistable, which is the whole reason the floor
is a minimum across runs and not one reading.** Four keyring-free runs of `4d30ede` — two
of them the same tree, same toolchain — measured `sync.rs` covered lines **830, 797, 830,
830** and covered functions **78, 74, 78, 78**, with `sync_keystore.rs` 228 and
`adblock_engine.rs` 349 in all four. The entire spread is one file: 33 lines and 4
functions. The 797 reading is the floor's own value, so one dev-box reading is not
evidence of what CI will measure. The attribution is exact rather than inferred: on
`beea9eb` this box reproduces every per-file delta CI printed — lib.rs −6,
test_support +10, zoom +11, nav +29, downloads +37, tabs +37 — and differs on exactly
one file, `sync.rs`, by +33 lines and +4 functions, which is 17787 − 33 = 17754 (CI's
total) and 2125 − 4 = 2121 (CI's function count).

**This bit the tree a second time on 2026-09-28, so the rule has an operational
half as well as a moral one.** Run 36440444084 failed the ratchet on two per-file
deltas — `sync.rs` −82 and `sync_keystore.rs` −58 lines — because a bulk
`rust-coverage-baseline` regeneration had been done on a dev box **with** a
working keyring, writing 286 and 785 into the baseline. The totals dipped too
(78.27% → 78.12% lines) purely because the committed target had been raised past
what CI can measure. Coverage did not fall; the threshold was wrong. Fixing it
meant deliberately **lowering** the committed baseline, which the ratchet
otherwise forbids — via `COVERAGE_ALLOW_BASELINE_LOWER=1`, the escape hatch that
exists for exactly this case, with the reason written into the commit message.

The second lesson is about _how_ a dev box ends up with a keyring when you think
it has none: `gnome-keyring-daemon` may be absent entirely and the keyring still
works, because `keyring`'s `linux-native-sync-persistent` feature enables the
D-Bus secret service too, and any ordinary desktop session bus provides it.
Unsetting `DBUS_SESSION_BUS_ADDRESS` alone is **not** enough — the `dbus` crate
falls back to `$XDG_RUNTIME_DIR/bus`, the same socket. Strip both:

```bash
env -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR \
  cargo llvm-cov --manifest-path src-tauri/Cargo.toml --lib --json > cov.json
```

That reproduces CI **exactly** — for THAT run. Its figures were `sync.rs` 703,
`sync_keystore.rs` 228, 13245 total lines, 1618 functions, every one identical to what
run 36440444084 reported; **none of them is the current tree's**, and `:1964` above
already records that the same command now moves `sync.rs` 785 vs 703. Four `SKIP
keychain tests` lines appear and all 517 tests still pass
(517 is the count in that run; the suite has grown since, and the live number is
the one `cargo test --lib` prints), because the keyring tests early-return rather
than fail. `dbus-run-session -- env
-u XDG_RUNTIME_DIR …` works as a wrapper if you need the D-Bus variable itself
defined; `unshare -U -r` does **not** isolate the keyring, and neither does an
`LD_PRELOAD` shim over `add_key`/`keyctl` — the binary issues no such calls, since
the `keyring` crate takes the D-Bus path and `linux-keyutils` uses raw
`libc::syscall(SYS_add_key, …)` regardless.

**So: never regenerate this baseline on a box you have not first proven keyring-free
by the command above.** `rust-coverage-baseline.mjs` takes an existing
`cargo llvm-cov --json` file as its argument, so the measuring run and the
generating run can be the same one.

So the committed number is the **least-capable** measurement, and every environment satisfies
it: a machine with a working keyring covers strictly more and passes, CI without one lands
exactly on the floor. **A threshold has to be reproducible in every environment or it is not a
threshold.** A baseline captured on a dev box is a _target_; a baseline captured in the weakest
environment is a _floor_, and only the floor can gate CI.

Consequences worth knowing before "fixing" this:

- The `rust` job's `cargo test` step IS wrapped in `dbus-run-session` +
  `gnome-keyring-daemon`, and the `cargo llvm-cov` step deliberately is **not**. The asymmetry
  is intentional and the comment in `ci.yml` says so. The keyring decides whether those three
  tests RUN or SKIP — that is test quality. It is deliberately not allowed to decide the
  coverage number.
- Wrapping the coverage step to match `cargo test` was tried and **reverted**: it did not make
  the keyring usable for the test run (the daemon reports `couldn't access control socket` in
  both steps, and libtest swallows a passing test's `eprintln!`, so the `SKIP keychain tests`
  line is invisible either way — the _coverage_ was the only honest signal).
- Two dead ends that cost real time, both measured rather than assumed:
  - Splitting the step into `cargo llvm-cov --no-run` then `--no-clean` to keep the daemon
    fresh. `--no-run` does build the instrumented binaries and a plain second run then reuses
    them in ~19s, so the shape works — but `--no-clean` **merges stale `.profraw` from earlier
    runs**, inflating the total to 11188 (13 lines of phantom coverage). In CI a cached
    `target/` could carry `.profraw` too, so `--no-clean` is unsound for a committed number.
  - Reading `keyring_available()`'s `eprintln!` to decide whether the tests skipped. Useless:
    libtest captures output from passing tests, so the line never reaches the log in any run.
- `rust-coverage-ratchet.mjs` prints **per-file covered-line deltas** on failure
  (`perFileDeltas` / `formatDeltas` in `rustCoverageCheck.mjs`). An **unchanged denominator
  with a falling numerator** means code stopped EXECUTING, not that it was deleted;
  `totalDelta` separates the two.

## Android (`gen/android/`)

Hand-written Kotlin under `app/src/main/java/com/aegis/browser/`:
`MainActivity.kt` (native content WebView; `shouldInterceptRequest` → ad-block +
malware; `window.AegisAndroid` JS bridge), `NativeAdblock.kt` + `NativeSafety.kt` +
`NativeHistory.kt` (JNI into the Rust `libapp_lib.so`), `NativeDownloads.kt`
(added 2026-09-29 — the Android `DownloadListener`; see the `downloads.rs` bullet
for why the destination has to be passed in rather than derived), and
`NativePermissions.kt` (added 2026-09-29 — the Android site-permission store
half; see the `permissions.rs` bullet for why the verdict cannot come back through
Rust).
`AndroidManifest.xml` grants `INTERNET` plus `CAMERA`, `RECORD_AUDIO` and
`ACCESS_FINE_LOCATION` — the last three ONLY because a granted web permission
request cannot capture anything without them (see the `permissions.rs` bullet).

**Backup is opted out of by TWO mechanisms, because no single one covers both
transports.** `android:allowBackup="false"` covers the pre-31 CLOUD path. It is
deliberately NOT the whole answer: Google documents that "for apps targeting
Android 12 (API level 31) or higher, this behavior varies. On devices from some
device manufacturers, specifying android:allowBackup="false" disables cloud-based
backup and restore (such as Google Drive backups) but doesn't disable
device-to-device transfers for the app" — `targetSdk` is 36, so on part of the fleet
D2D stayed live while the manifest claimed both transports were off. The
manifest's own comment used to make exactly that claim and was wrong.
`android:dataExtractionRules="@xml/data_extraction_rules"` (added 2026-10-01) is
the manufacturer-independent mechanism: it governs BOTH cloud backup and D2D on
API 31+, and the file excludes every documented domain under `<cloud-backup>`,
`<device-transfer>` and `<cross-platform-transfer>` (the last is Android 16 QPR2 /
API 36.1). **Two facts make that file's shape non-obvious:** there is no "exclude
all" shorthand and no wildcard, so all NINE domains (`root`, `file`, `database`,
`sharedpref`, `external`, `device_root`, `device_file`, `device_database`,
`device_sharedpref`) must each be listed with `path="."`; and an ABSENT section is
a fully ENABLED one ("if there are no rules for a particular backup mode … that
mode is fully enabled for all content except for no-backup and cache
directories") — which is why all three sections are spelled out rather than relying
on the two obvious ones. There is deliberately NO `android:fullBackupContent`: that
older format is what Android 11 and lower read, where `allowBackup="false"` already
covers it, and it has no effect on D2D on API 31+ — a file that looks protective
while governing nothing is worse than none. **Nothing here is tested: there is no
Kotlin or XML test source set, so the gate is Gradle compiling and linking the
attribute + resource, and whether a given OEM still honours it is only knowable on
that OEM's device — PENDING hardware.**

**⚠ A `--debug` build is a DIFFERENT APP, not an upgrade — and `adb install` will not
tell you.** `tauri android build --debug` gets Gradle's standard `applicationIdSuffix`,
so it installs as **`com.aegis.browser.debug`** SIDE-BY-SIDE with the release
`com.aegis.browser`. `adb install -r <debug.apk>` prints `Success` and leaves the
release app's `lastUpdateTime` **unchanged** — so a debug APK can install perfectly
while you go on testing the _release_ binary, see none of your new code, and conclude
your fix is broken. This cost a long false-negative investigation. Rules:

- launch `com.aegis.browser.debug` (not `com.aegis.browser`) to test a debug build;
- confirm `dumpsys package <pkg> | grep lastUpdateTime` actually moved;
- `run-as` does **not** work on either variant (`flags=0x0`, no `DEBUGGABLE`), so the
  device store cannot be read directly — use logcat or the UI as the positive signal;
- the debug universal APK is ~280 MB (unstripped) vs ~20 MB release, which is a handy
  tell for which one a device is actually running.

**Mobile chrome (`MainActivity.kt`), kept in sync with the `MobileApp` shell in `src/`:**

- The content area is inset by the chrome heights: `topMargin = 84dp`
  (`MOBILE_ADDRESS_H` 48 + `MOBILE_FAV_H` 36) + status inset, `bottomMargin = 56dp`
  (`MOBILE_BOTTOMBAR_H`) + nav inset. **`applyContentMargins()`** is the single place
  that computes them from the `fullscreen` / `bottomBarHidden` flags + cached chrome
  heights + captured system insets; the insets listener and the bridges all call it.
  It sets the margins on the **`GestureContainer`** that wraps the tab WebViews (see
  Touch gestures below), which carries the insets so each tab WebView just fills it.
- The `AegisAndroid` bridge adds `setBackInterceptActive` (Back closes an open sheet),
  `setBottomBarHidden` (the top-bar chevron — content reclaims the bar's gap), and
  `setFullscreen` (desktop-parity hide-all-chrome — content fills the safe area, Back
  exits). The chrome installs `window.__aegisMobileBack` for native Back to call.
  `setFullscreen` (desktop-parity hide-all-chrome) now ALSO goes immersive —
  `WindowInsetsControllerCompat.hide(systemBars())` on enter / `show(...)` on exit, with
  `BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` — so the page truly owns the whole screen (status
  - nav bars hidden), matching the HTML5-video `onShowCustomView` path. Back exits.
- **Back is dispatched by AndroidX, not by the deprecated `onBackPressed()` override.**
  `targetSdk = 36` and no `android:enableOnBackInvokedCallback` anywhere, so on API 33+ the
  system hands Back to `onBackPressedDispatcher`: `ComponentActivity` registers an
  `OnBackInvokedDispatcher` observer on `ON_CREATE`, and with no ENABLED
  `OnBackPressedCallback` on the dispatcher its fallback runnable calls
  `androidx.core.app.ComponentActivity.onBackPressed()` **non-virtually** (verified with
  `javap` against androidx.activity 1.10.1) — the superclass, never `MainActivity`'s
  override. So the three-tier precedence above (close a chrome sheet → page-back → exit)
  never ran and Back just exited the app. `TauriActivity` pins `handleBackNavigation =
  false`, so `WryActivity.setWebView` registers no callback of its own either.
  `installBackCallback()` (last statement of `onCreate`) registers a real
  `OnBackPressedCallback`, and the precedence lives ONCE in `handleBackPress(): Boolean`,
  which the `@Deprecated` override also calls — so an OEM that still routes Back the legacy
  way behaves identically. **Tier (c) must disable the callback before re-dispatching**: its
  `super.onBackPressed()` resolves to `androidx.activity.ComponentActivity.onBackPressed()`,
  which *is* `getOnBackPressedDispatcher().onBackPressed()`, so it would re-enter our own
  callback and leave the app un-exitable. Pinned from `nav::tests`
  (`android_back_press_runs_the_three_tier_precedence_from_the_dispatcher`); with no Kotlin
  test source set the Kotlin half is COMPILE-VERIFIED ONLY (`:app:compileArmReleaseKotlin`)
  and on-device behaviour is **PENDING**.
- **Safe-area insets (all four edges):** the insets listener reads
  `systemBars() ∪ displayCutout()` and pushes the real status/nav/side insets to the chrome
  as `--aegis-inset-top/bottom/left/right` CSS vars (px ÷ density); `onCreate` sets
  `layoutInDisplayCutoutMode = ALWAYS` (API ≥ 30; `SHORT_EDGES` on 28–29) so cutouts are
  reported as insets. `applyContentMargins()` also applies `leftMargin`/`rightMargin`
  (= side insets, 0 in fullscreen) so the page clears side bars/cutouts in landscape.
- A **`WebChromeClient`** (`onShowCustomView`/`onHideCustomView` + immersive bars) gives
  pages HTML5 fullscreen (video, etc.) — distinct from the chrome-hiding `setFullscreen`.
- **Multi-tab (live tabs).** `MainActivity` keeps a `tabId → WebView` map; the active
  tab's WebView is mirrored into `contentWebView` so all existing active-tab logic
  (margins/overlay/nav/back) is unchanged. The chrome drives it via
  `AegisAndroid.activateTab(id,url)` / `closeTab(id)` / `discardTab(id)` (Rust can't touch
  native Android views — the chrome coordinates). WebViews are created **lazily** by
  `activateTab` (not eagerly in `onWebViewCreate`). Each tab has its own `WebViewClient`
  (`makeContentClient(id)`) with a per-tab `pageUrls[id]` first-party context for ad-block,
  and `pushNavState(id,…)` carries the tab id as `viewId` so the chrome's
  `useNav(activeId)` tracks the active tab. **`activateTab` re-pushes the tab's nav state**
  (switching to an already-live tab fires no page-load event, so without this the address
  bar would blank). The tab title is NOT observed natively (no WebKit signal) — the chrome
  relays it via `tabs.setTitle`. `makeChromeClient().onCreateWindow` routes
  `target=_blank`/`window.open` to `window.__aegisOpenTab` → a background tab.
  **It refuses a popup that had NO user gesture, before it builds anything.**
  `onCreateWindow(view, isDialog, isUserGesture, resultMsg)` used to receive the flag and
  ignore it, which meant any page could call `window.open()` and get a real, ad-block-
  contexted BACKGROUND tab — the shape an ad network uses to bury the page you asked for
  (open a background tab, then navigate it to the tracking pixel). Every desktop browser
  blocks that by default. The guard is `if (!isUserGesture) return false`, placed
  immediately after the `transport` unwrap and **before** `WebView(this@MainActivity)`,
  because refusing afterwards would still construct the capture WebView and still leave its
  navigation to `__aegisOpenTab`; returning `false` also makes it the cheapest outcome (no
  capture WebView, no TTL timer, no `popupTemps` entry). A real tap is the case the handler
  exists for, so a genuine `<a target=_blank>` click is unaffected.
  **There is deliberately NO tab cap anywhere in the product** (verified: nothing in
  `useTabs.ts` or `tabs.rs` bounds the count), and none was added here — with the gesture
  guard there is no gesture-free route to abuse, and inventing a cap would be a policy
  change nobody asked for. If a cap is wanted it belongs in the tab registry, for every
  source of tabs, not on this one route.
  Pinned from `cargo test` by `nav::tests::the_android_popup_needs_a_user_gesture_and_a_find_session_dies_with_its_tab`,
  which asserts the guard's presence AND that it precedes `WebView(this@MainActivity)`.
- **`currentFindQuery` is Activity-wide, so `teardownTab` has to clear it.** Android's
  `FindListener` never reports the query back, so the query lives in one `@Volatile` rather
  than per tab — and `findAllAsync` is ASYNCHRONOUS. Closing a tab mid-search therefore left
  the query set, and the late callback pushed a `__aegisFindState` naming a tab that no longer
  existed, carrying a match count for highlights that had just been destroyed.
  `teardownTab` clears it with `if (activeTabId == id) currentFindQuery = ""` — guarded by
  `activeTabId == id` because a find always runs against `contentWebView`, so that is the
  only case where the two can disagree. Pinned by the same test (the `teardownTab` half).
  Both halves are read through `test_support::kotlin_fn_body`, which strips `//` comment
  lines; that is load-bearing here, not hygiene, because the gesture guard's own comment
  QUOTES the line a naive `contains` would match.
  **The capture WebView's `WebViewClient` overrides only `shouldOverrideUrlLoading`, NOT
  `shouldInterceptRequest`** — so `NativeAdblock.shouldBlock` / `NativeSafety.isMalwareHost`
  run for a TAB's subresources but never for a popup's. Left as-is deliberately, and the
  reasoning is a mix of bound and open design:
  - **Bounded today.** The capture WebView is un-parented (never added to any layout),
    `hardenContentWebView(temp.settings)` runs on it (no `file://`/`content://`, no cleartext
    subresources), JS is off by default, and `POPUP_TEMP_TTL_MS` destroys it in 10 s. With
    the gesture guard above, a page cannot even REACH this path without a real tap, so the
    "ad network opens a pop-under to bury the page" vector that motivates the handler is
    already closed.
  - **Genuinely open, and not a one-liner.** The main-tier `shouldInterceptRequest` decides
    against `pageUrls[activeTabId]` — the OPENING tab's first-party ad-block context. A popup
    is deliberately un-parented and has **no tab id**, so there is no correct context to ask
    the engine with. Reusing the active tab's would attribute the popup to whichever tab the
    user happened to be looking at — the same class of misattribution as the permission-URI
    limit above. The real fix is giving the popup its own id and putting it in `pageUrls`,
    and that is a design decision (what IS a popup's first-party context?), not a missing
    line. **Do not "fix" this by copying the active tab's url in.**
  There is **no Kotlin test source set**, so any such change would be compile-verified only;
  that is a further reason to land it deliberately rather than inside a security sweep.
- **Touch gestures (`GestureContainer.kt`).** A custom `FrameLayout` wraps the tab
  WebViews (so the chrome-bar margins live on it, not per-tab). It uses the
  watch-then-steal model — `onInterceptTouchEvent` lets the active WebView handle
  touches until it positively recognizes one of two gestures, then steals the stream
  (the WebView gets `ACTION_CANCEL`): **edge-swipe back/forward** (a horizontal drag
  from a ~20dp left/right edge strip — left=back, right=forward, with a ◀/▶ arrow that
  follows the finger; navigates on release past ~¼-width) and **pull-to-refresh** (a
  downward drag while the active WebView is at `scrollY==0`, with a spinner; reloads on
  release past threshold). It acts on the active tab through a `GestureHost` interface
  the activity implements (`gestureBack/Forward/Reload/CanGoBack/CanGoForward/AtTop` →
  `contentWebView`). `setSystemGestureExclusionRects` (API 29+) claims the edge strips
  from Android's own back gesture; `stopRefresh()` is called from the active tab's
  `onPageFinished` to hide the spinner. The indicator is drawn in **`dispatchDraw()`
  after `super` (NOT `onDraw`)** so it paints over the opaque content WebView (gotcha
  11). Nav reuses the existing `pushNavState` pipeline, so the address bar +
  back/forward state update with **no renderer/IPC changes**. Tuning constants
  (`edgePx`, `hDistance()`, `pullThreshold()`, pull damping) are all in `GestureContainer`.

## Build

```bash
npm run tauri:dev                              # dev
npm run tauri:build                            # desktop installers
cargo check                                    # quick type-check
cargo check --target x86_64-pc-windows-gnu     # cross-check Windows from Linux (needs mingw)
npm run android:build                          # debug APK (NEEDS JDK 21 — see gotcha 8)
npm run android:build -- --target aarch64      # arm64-only APK (smaller; for a phone)
```

## Gotchas

1.  **tauri#10420** — Linux multi-webview won't position; fixed by GtkFixed
    reparenting in `linux_layout.rs`.
2.  **DMABUF white-screen** — `lib.rs` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
3.  **NVIDIA + Wayland** — force XWayland (`GDK_BACKEND=x11`) in `lib.rs`.
4.  **`Engine` is `!Send`** — keep it on its one thread; only `String`/`bool` cross.
5.  **Event names** — always go through `emit_event()` (`.`→`:`).
6.  **WebView2 COM** in `adblock_win.rs` is unsafe; CI compiles/links but doesn't
    launch the GUI. **Runtime-verified on real Windows 11 (2026-06):** it installs
    without panicking and the network ad-block tier blocks (DoubleClick `gpt.js`
    served an empty 204; a non-ad control script still loaded). `nav_url_win.rs`'s
    `SourceChanged` handler installs cleanly too, though its same-document URL
    tracking wasn't exercised yet. The shield block-counter is **now wired on
    Windows** (`adblock_win.rs`'s `WebResourceRequested` block path calls
    `note_blocked`) **and Android** (Kotlin `shouldInterceptRequest` counts each
    ad-block tier block → `__aegisBlockedCount` → `adblock.blockedCount`). Honest
    per-platform caveat: Linux counts only requests that pass the content-filter cap
    and are then flagged by `should_block` (content-filter-blocked requests are
    cancelled before `resource-load-started` fires, so they are never counted — real
    blocking, invisible count); Windows counts every `WebResourceRequested` block in
    the network tier (the injected JS tier does not call `note_blocked`); Android
    counts every `shouldInterceptRequest` ad-block branch hit. Each platform's badge
    means "requests this tier blocked on this page / this session", not "all ads truly
    blocked". Blocking itself is proven by the A/B trace, not the count.
7.  **TLS** — a crypto provider must be installed once (done in `lib.rs`) or every
    reqwest/updater HTTPS call panics.
8.  **Android needs JDK 21.** Gradle 8.14.3 / AGP 8.11.0 can't run under JDK 25 (the
    `:buildSrc` configuration fails with a bare `> 25.0.3`). Build with the Android
    Studio JBR: `JAVA_HOME=~/development/android-studio/jbr npm run android:build`.
9.  **16 KB page alignment (Android 15+).** `build.rs` passes
    `-Wl,-z,max-page-size=16384` for android targets so `libapp_lib.so`'s LOAD segments
    are 16 KB-aligned; without it the lib fails to load ("LOAD segment not aligned").
10. **Desktop-only Tauri APIs must be `#[cfg(desktop)]`-gated** — the Rust lib has to
    compile for android too. `Webview::close()`, `Builder::on_menu_event`, etc. are
    desktop-only (see `tabs.rs::close_webview`, the `lib.rs` builder). Only an android
    build / `cargo check --target aarch64-linux-android` catches these; desktop and the
    Windows cross-check do not.
11. **Draw over a ViewGroup's children with `dispatchDraw`, not `onDraw`.** A
    `ViewGroup`'s `onDraw()` paints _behind_ its children, so an indicator drawn there is
    occluded by an opaque `MATCH_PARENT` child (the content WebView). `GestureContainer`
    draws its swipe arrow / refresh spinner in `dispatchDraw()` after `super.dispatchDraw()`,
    which renders on top. (Same class of bug as the earlier "chrome overlay rendered behind
    the native content view.")
12. **AppImage HTML5 video — GStreamer plugin path.** WebKitGTK decodes `<video>`/`<audio>`
    via GStreamer, which `dlopen`s its plugins (incl. `appsink`, how WebKit pulls frames)
    from `GST_PLUGIN_SYSTEM_PATH_1_0`. linuxdeploy bundles `libgstreamer` (a _linked_ dep)
    but NOT the `dlopen`-ed plugin modules, and `AppRun` points that env var at the bundled
    (empty) dir — so all media fails with "GStreamer element appsink not found": permanent
    spinner, no playback (the streamex.sh symptom). `lib.rs` appends the host's plugin
    dir(s) (`/usr/lib64/gstreamer-1.0`, …) to the path; the bundled libgstreamer is copied
    from the build host so it version-matches and loads them. Harmless for the `.deb`/dev
    (those dirs are already default). Fedora multilib note: `/usr/lib/gstreamer-1.0` is the
    _i686_ dir, so it's only used as a fallback when no arch-specific dir exists.
13. **`on_navigation` fires for subframes; don't drive the URL bar from it.** wry wires
    Tauri's `on_navigation` to WebKitGTK `decide-policy` (NavigationAction) with NO
    main-frame filter, so cross-site iframe/embedded-player loads call it too — and it
    only hands you a `&Url` (no frame info), so you can't tell them apart. Emitting
    `nav.state` there made the address bar flicker to embedded ad/player URLs mid-load.
    Keep safety/HTTPS-Only checks in `on_navigation` (they should cover subframes), but
    drive the URL bar from two main-frame-only sources instead: `on_page_load` (wired to
    `load-changed`) for the loading state on full loads, and **`notify::uri`**
    (`linux_layout::connect_url_tracker`) for the URL — the latter also catches
    same-document History-API (`pushState`/`replaceState`) + hash navigations that
    `load-changed` does NOT fire for (SPAs like streamex switch `?server=` that way), so
    the bar stays correct without ever showing a subframe URL. (Android is unaffected — it
    reports via `onPageStarted`/`doUpdateVisitedHistory`, already main-frame-only. Set
    `AEGIS_NAV_DEBUG=1` to trace what reaches the bar.) The same-document URL tracking is
    wired on every desktop: **Windows** `nav_url_win.rs` (WebView2 `SourceChanged`,
    compile-verified via the gnu cross-check + CI) and **macOS** `nav_url_mac.rs`
    (WKWebView `URL` KVO, mirroring wry's own `DocumentTitleChangedObserver`). NOTE: the
    macOS objc2 code can't be compiled from Linux at all — `objc2`'s build script needs a
    macOS C toolchain — so it is **CI-verified only** (macos-latest), not locally.
    **HTTPS-Only is the ONE check in that list this constraint actually bites** (investigated
    2026-09-30; left unfixed on purpose, see the note at the top of `nav::decide_navigation`).
    Its arm cancels an `http://` navigation and re-navigates the TAB's content webview to the
    `https://` form, and it cannot tell a top-level navigation from a subframe one — so an
    `http://` iframe (ad slot, comment widget, embedded map) replaces the page the user was
    reading with the iframe's URL. `httpsOnly` defaults to `true`, so this is the default path.
    There is no frame-aware alternative with the current stack: `on_navigation` is
    `Fn(&Url) -> bool`, wry discards the richer signal on every backend, and the one
    frame-aware hook the crate owns — `ResponsePolicyDecision::is_main_frame_main_resource()`,
    which the redirect guard uses — fires AFTER the request went out, so enforcing
    HTTPS-Only there would newly send the plaintext `http://` request the feature exists to
    prevent. A fix needs wry/Tauri to pass the frame flag (upstream) or per-platform native
    plumbing. **Android's exposure is UNVERIFIED here:** its own `secureUrl` policy rewrites
    the same way from `shouldOverrideUrlLoading` (which does receive `request.isForMainFrame`),
    but whether WebView invokes that callback for subframe loads at all is device behaviour no
    gate here exercises.
14. **Linux OWINS the `decide-policy` signal for the redirect guard.** wry connects its own
    `decide-policy` handler (powering `on_navigation`) and CLAIMS the signal (`return true`),
    so a second handler never fires — and Tauri ALWAYS installs a `navigation_handler` (to run
    plugin hooks), so you can't free it by skipping `.on_navigation`. To get the gesture/frame
    info `on_navigation` lacks (gotcha 13), `linux_layout::install_nav_policy` DISCONNECTS
    wry's handler (`g_signal_handlers_disconnect_matched` by signal id) at tab spawn and
    installs ours: it runs the shared `nav::decide_navigation` (ad-block/malware/HTTPS/overlay)
    for NavigationAction AND the scripted-cross-origin-**top-frame redirect guard**. Reliable
    main-frame detection is NOT on `NavigationAction` (only gesture/type are), so the guard is
    TWO-PHASE: at `NavigationAction`, `redirect_guard::note_nav` records the **chain** this hop
    belongs to per-URL (begin a fresh `ChainStart{from, origin_target, scripted}` on a non-redirect
    hop, or inherit the in-flight chain's origin on a redirect hop) — but does NOT consume the
    app-initiated PendingNavs match, because WebKit fires `NavigationAction` REPEATEDLY (and for
    subframes) for one navigation. Then at `ResponsePolicyDecision` (where `is_main_frame_main_resource()`,
    webkit2gtk **`v2_40`** — see Cargo.toml — is reliable AND the response is displayable, so embeds +
    downloads are skipped) `decide_at_response` makes the call: it consumes the PendingNavs match ONCE,
    against the chain's ORIGIN target, and cancels iff scripted + cross-origin + not-app-initiated.
    **Judge a redirect by who STARTED its chain, not the hop:** a scripted cross-origin nav is blocked
    however many redirect hops it took (e.g. malvertising bounces the top frame to `google.com`, which
    301s to `www.google.com` — the destination hop carries `is_redirect=true`; an `if is_redirect { allow }`
    short-circuit, the OLD behavior, waved it through). User-gesture and app-initiated (PendingNavs-matched
    on the origin target) chains pass. **WHY decide at the Response, not the NavigationAction:** doing the
    one-shot pending match per-NavigationAction falsely blocked legit app navs — WebKit re-fires
    NavigationAction, the first consumed pending, the repeats saw none → "scripted" → blocked (the
    autopilot caught this regression: app-initiated `example.com` blocked from `about:blank`). **Live-verified:**
    real streamex.sh direct case (`BLOCK https://www.google.com/ (from https://streamex.sh/)`, page stays on
    streamex) AND a synthetic redirect _chain_ (`BLOCK …/final (from …/8800)` across a 301), with the
    full autopilot green (92/0/1, no false blocks). Windows uses `block_at_start` via `NavigationStarting`
    (top-frame only, fires once per hop → resolves app-initiated at the hop and stores it for redirect
    hops to inherit). Allowed navs call `use_()`; non-Response / non-blocked fall through (`false`) so
    downloads/new-windows keep WebKit's default handling. A block is reported to the chrome by
    NO event: an earlier version of this gotcha claimed it emitted `redirect.blocked`, which the
    chrome handled by calling `tabs.create(url, true)` behind a 1.5 s grace period for
    chrome-initiated navigations. **None of that existed** — no Rust ever emitted the event, and
    the declaration, the `ipcClient` wrapper, the `App.tsx` subscription and the Android
    `window` bridge are all deleted. The destination is opened NATIVELY, by
    `redirect_guard::on_blocked_redirect_to_new_tab` → `tabs::open_redirect_background`
    (`linux_layout.rs:434`, `nav_policy_win.rs:74`), so there is no event to emit, no grace
    period, and no second open path to double-open. Other platforms keep
    Tauri's `on_navigation` + their own native top-frame hooks (Windows `NavigationStarting`,
    macOS `WKNavigationDelegate`, Android `shouldOverrideUrlLoading`). **The scripted-redirect
    GUARD specifically has no macOS tier** — there is no `nav_policy_mac.rs`, so nothing on
    macOS calls `note_nav`/`decide_at_response`/`block_at_start` and only `redirect_guard::expect`
    (from `nav.rs`) is reachable there. That is why `redirect_guard.rs` carries a macOS-scoped
    `#![cfg_attr(target_os = "macos", allow(dead_code))]`; Windows keeps the lint on and annotates
    only the Linux-only items. The block notification is
    platform-native: desktop auto-opens a background tab, and **Android now goes through the
    same `RedirectBudget`** (gotcha 15) rather than a second, unbudgeted route — see
    `showRedirectBlocked` below. (This document previously claimed Android showed a Material
    `Snackbar` with an "Open anyway" → new-tab action. There is no Snackbar and no such step,
    and there never was: the open was an unconditional `window.__aegisOpenTab` into the chrome
    webview. `com.google.android.material:material` IS a dependency (`build.gradle.kts:86`), so a
    Snackbar was buildable and simply was not there.)
    On Android the open is made by RUST, not by the chrome webview. `showRedirectBlocked` used
    to evaluate `window.__aegisOpenTab(url)`, which reaches `MobileApp` →
    `tabs.create(url, true)` — the same registry-create + `emit_and_persist` that
    `tabs::open_redirect_background`
    performs on desktop, so Android was missing EXACTLY the two things desktop also has: the
    `admit` budget and the 30 s auto-close. A malverting page could therefore accumulate
    unbounded background tabs on a phone while the desktop build refused to, and nothing in the
    Kotlin path could report whether a tab had been opened at all. It now calls
    `NativeRedirectGuard.openBlockedRedirect(from, to)`, whose JNI export
    `Java_com_aegis_browser_NativeRedirectGuard_openBlockedRedirect` calls
    `on_blocked_redirect_to_new_tab` and returns whether a tab was really opened.
    `on_blocked_redirect_to_new_tab` therefore returns `bool` (the two desktop callers, the
    pop-under path, have no affordance to suppress and ignore it), and its
    `#[cfg_attr(target_os = "android", allow(dead_code))]` is gone — the tell closed itself.
    **BOTH urls are required**: the dedup key is the `(from, to)` PAIR, so half a pair is not a
    redirect and the export refuses it. The export also fails CLOSED (nothing opened) where
    `shouldBlock` fails OPEN, because a dropped permission request is a navigation the user
    asked for while a double-opened redirect tab is a resource the page chose to spend. The
    caller must NOT fall back to opening the URL itself: that is the unbudgeted route this
    replaced, and doing both would open two tabs per block.
15. **A blocked-redirect loop is BUDGETED — it cannot drive unbounded background tabs.**
    `on_blocked_redirect_to_new_tab` opens the destination natively on every block, with no
    rate limit and no dedup, so a page that bounces through the guard N times cost N tabs **and**
    N full serialisations of the whole tab registry with an fsync each (`open_redirect_background`
    → `emit_and_persist` → `tabs::persist`) — quadratic, on a path a page can drive. It already
    received the origin tab and the source URL as parameters, so everything a dedup key needs was
    on hand. The policy now lives in the managed `RedirectBudget` (`Arc<Mutex<_>>`, so the
    `'static` 30 s timer thread can hold a clone — a `tauri::State<'r, T>` clone keeps the `'r`
    borrow and will not compile into a `'static` closure). **Two** independent refusals, because
    key dedup alone bounds nothing:
    - `MAX_LIVE_REDIRECT_TABS = 3` — a **count** is the sound bound here rather than a rate, since
      each tab holds its slot for at most the 30 s auto-close. Key-only dedup would not stop a
      loop whose destinations all differ, and a rate alone would not stop a fast one.
    - `REDIRECT_DEDUP_WINDOW = 120 s` — deliberately **longer** than the 30 s auto-close, so a
      _slow_ loop is still refused on its second pass rather than slipping through as slots free up.

    The check and the record happen under one lock, so a concurrent repeat cannot let both through.
    `release` is called **unconditionally** on the timer thread, not only when the tab is still a
    background tab, so a user who closes one by hand does not ratchet the budget shut. Two honest
    limits: the untested surface is the one-line `if !budget.admit(from, to) { return; }` wiring
    (same class as the other `setup()` call sites), and `admit` claims a slot only once the tab id
    exists, so N _truly simultaneous_ distinct-key hops can transiently exceed the cap by N-1 —
    bounded by thread count, not by anything the page controls.

    The 30-second auto-close timer is a **`std::thread`**, and it used to call
    `tabs::close_tab` directly off the main thread. `close_tab` reaches `Webview::close()`,
    `linux_layout::remove_webview_label` (which touches the native `GtkOverlay`) and
    `view::apply_inset` — main-thread-only on EVERY platform, and on Linux the WebKitGTK
    objects behind them are not `Send` at all, so it was undefined behaviour rather than a
    warning (WebView2 is STA and WKWebView is main-thread-only for the same reason). Only
    the close now hops via `app.run_on_main_thread`; the registry read
    (`is_background_tab`/`active_id`) deliberately STAYS on the timer thread, because it is
    lock-protected plain state and the decision should still be made at wake time.
    `budget.release(new_id)` stays OUTSIDE the hop so the slot comes back even when the
    event loop is already gone during shutdown. `decide_navigation`'s pop-under auto-close
    already did this, so the precedent was in the file. Compile-verified only — there is no
    real webview reachable from a Linux test.
    **The budget is CROSS-PLATFORM as of 2026-09-29: Android is inside it too.** It was not
    before, and the gap was structural rather than an omission in the guard: Android has no wry
    webview, so nothing in the core could see a `WebViewClient.shouldOverrideUrlLoading` redirect,
    and the open had to be driven from the chrome side — where it bypassed `admit` entirely. The
    fix routes it through the SAME function (gotcha 14), so the cap cannot be bypassed by
    arriving from the phone. `nav::tests` pins that wiring by reading the Kotlin source as TEXT
    (there is no Kotlin test source set, and the Rust JNI export cannot be reached from a Linux
    test), using the general `kotlin_fn_body` helper: the `showRedirectBlocked` body must call
    `NativeRedirectGuard.openBlockedRedirect(from, to)`, must NOT mention `__aegisOpenTab` any
    more, must take the `(from, to)` pair, the main-frame hook must pass `current` as well as
    `raw`, and `NativeRedirectGuard.kt` must declare the same pair returning `Boolean`.

16. **Local Windows builds need NASM + CMake** (for `aws-lc-sys`, rustls' crypto C
    backend). The MSVC "Desktop development with C++" workload bundles CMake; install
    NASM separately (nasm.us) and add it to PATH. CI's `windows-latest` ships both, so
    this only bites local builds. Same-machine aside: behind a network that blocks the
    CA revocation endpoints (OCSP/CRL), cargo's schannel TLS fails every crates.io
    fetch with `CRYPT_E_NO_REVOCATION_CHECK` — set `http.check-revoke = false` in
    `~/.cargo/config.toml`.

17. **Windows child webviews need PHYSICAL bounds at fractional DPI.** wry's `add_child`
    / `set_bounds` called with `LogicalPosition`/`LogicalSize` mispositions the WebView2
    controller's INPUT/hit-test region at non-100% scaling (e.g. 125%): the content
    webview _renders_ below the chrome bars but _captures their clicks_, so the toolbar
    and favourites bar go dead (the tab strip, above the misplaced region, still works —
    that's the "can't add a tab / favourites don't click" symptom). `nav::spawn_tab` and
    `view::apply_inset` pass `PhysicalPosition`/`PhysicalSize` on Windows (logical×scale)
    so the controller's hit rect matches the host window. Only bites fractional DPI — 100%
    is unaffected, which is why CI / 100%-DPI testing missed it. (macOS keeps Logical.)

18. **Windows runtime tab creation must spawn the webview OFF the UI thread, and tabs
    need explicit show/hide.** Two pre-existing Windows multi-tab bugs:
    (a) `window.add_child` **deadlocks the UI thread** when called synchronously from the
    `ipc` command — WebView2's async `CreateCoreWebView2Controller` can't complete while
    the event loop is blocked waiting on it (Tauri `WebviewBuilder` docs / wry#583). So
    `tabs::spawn` creates the webview on a `std::thread::spawn` worker on Windows, then
    re-applies layout via `run_on_main_thread`. Without it, the **+** button / Ctrl+T
    froze the whole app. (b) Per-tab content webviews all sit at the inset and **overlap**;
    z-order doesn't follow the active tab, so `view::apply_inset` shows the active tab's
    webview and hides every other tab's each layout pass (Linux does this in
    `linux_layout::layout`). Without it, switching tabs left the previous page on top.

    **Investigated 2026-09-26: could `ipc` just be made async instead?** No — not as a
    one-liner, and the reasoning is worth keeping. The deadlock is caused by the main thread
    being **BLOCKED**, not by being the main thread: `ipc` is synchronous, so the loop cannot
    pump and WebView2's async `CreateCoreWebView2Controller` never completes. Moving the body
    to a worker (`#[tauri::command(async)]`) would _unblock_ the loop and so **fix** the
    Windows bug rather than cause it. But it relocates the hazard: `tabs::spawn` only wraps
    `nav::spawn_tab` in `thread::spawn` **on Windows** — on Linux/macOS it calls
    `nav::spawn_tab(app, …)` inline, and `window.add_child` inside `spawn_tab` (plus
    `window.scale_factor()`/`inner_size()` and, on Linux, the `linux_layout::connect_*` signal
    wiring) has **no `run_on_main_thread` marshalling at all**. So an async `ipc` would move
    GTK/WebKitGTK — not thread-safe — onto a worker thread. A correct fix therefore has to add
    main-thread marshalling to the non-Windows creation path, which needs a real GUI run on
    Linux, macOS and Windows to validate. Untested on this host, so not applied.

19. **Find-in-page per-platform capability matrix (honest):**
    - **Linux** (WebKitFindController): real match count via `found-text` signal, full
      highlight-all, **no active-index getter** (reports `1` when count > 0 else `0`).
      Live-verify pending user display session; cross-check clean.
    - **Windows** (`ICoreWebView2Find`): real count + real active index + highlight-all.
      **Requires a 2024+ WebView2 Runtime** — `cast::<ICoreWebView2_28>()` fails silently
      on older runtimes (browsing unaffected, find is a no-op). Compile-verified via gnu
      cross-check + CI; GUI runtime-verify pending user's Windows 11 device.
    - **macOS** (JS shim in `find_mac.rs`, `find_shim.js`): real match count + real active
      index + highlight-all, via a `TreeWalker` over visible text nodes — the shim exists
      precisely because the native `findString:withConfiguration:completionHandler:` returns
      only `matchFound` (bool). Reads back through the `AEGISFIND:{count}:{index}` sentinel.
      CI-compile-only; GUI requires a macOS desktop session.
    - **Android** (Kotlin `WebView.findAllAsync`): real count + active index (ordinal + 1)
      - highlight-all. **Case-insensitive only** — the `caseSensitive` flag is accepted but
        the Android WebView find API has no case-sensitive mode. Kotlin compile-verified; GUI
        runtime-verify pending device session.

20. **Private tabs use `WebviewBuilder::incognito(true)` on desktop — Android is a
    best-effort weaker tier with a documented, accepted limit.**

        **Desktop (Linux / Windows / macOS):** `nav::spawn_tab(…, private: bool)` calls
        `.incognito(private)` on the `WebviewBuilder`, which maps to the engine-native
        ephemeral partition:
        - Linux → `WebContext::new_ephemeral()` (in-memory `WebsiteDataManager`; no
          cookies/localStorage/IndexedDB/cache written to disk)
        - Windows → `SetIsInPrivateModeEnabled(true)` on the WebView2 controller (requires
          WebView2 Runtime ≥ 101.0.1210.39; no-op on older runtimes)
        - macOS → `WKWebsiteDataStore.nonPersistentDataStore`

        All on-disk persistence write-paths are guarded: `history::record` / `update_title`
        early-return on `is_private`; `downloads::on_requested` skips the downloads-list
        entry (the downloaded FILE still lands on disk — matches Chrome/Firefox incognito);
        `tab_registry::to_persisted` filters out private tabs (so they are never written to
        `tabs.json`). Private tabs are also **exempt from the idle sweep** — closing and
        respawning an ephemeral webview would destroy the session data, so only the user
        closing the tab ends it. A closed private tab is **NOT reopenable** (`reopen_closed`
        creates non-private tabs). A tab opened from a private tab **inherits privateness**
        (`on_new_window` reads `is_private(opener_id)` and passes it to `open_background`).

        **Android:** wry marks `incognito` as Unsupported on Android (`wry/src/lib.rs:748`).
        The native path in `MainActivity.kt` is a best-effort tier: `privateTabs` (`HashSet`)
        tracks private tab ids; at creation, `wv.settings.cacheMode = LOAD_NO_CACHE` (memory-
        only HTTP cache) and 3rd-party cookies are refused for that WebView. On close,
        `wv.clearCache(true)` + `wv.clearHistory()` are called. Because `CookieManager` is
        process-global, the first-party cookie gate is too: `syncCookieAcceptance()` is the ONLY
        writer of `setAcceptCookie`, and it refuses cookies while `privateTabs` is non-empty —
        i.e. while any private tab is ALIVE, not merely while one is the ACTIVE tab. (It used to
        be keyed on the active tab, so switching to a normal tab re-enabled cookies
        process-wide while a private WebView was still running. That is a different weakness
        from the honest limit below: the tab was LIVE, not closed.) The cost of the strict
        invariant is real and is not hidden: a normal tab in the background stops receiving
        cookies for as long as any private tab is open. Every site that mutates `privateTabs`
        (`onDestroy`, `teardownTab`, `activateTab`) re-syncs after the mutation, and
        `activateTab` does it BEFORE the private WebView is created, so a private tab is never
        live with cookies accepted. A `tabs::tests` source-text pin covers all of that over the
        Kotlin source, since there is no Kotlin test source set.

        **Honest limit:** Android's
        `CookieManager` / `WebStorage` are process-global — there is no per-WebView cookie
        partition in the released Android WebView API. First-party cookies set by NORMAL tabs
        before a private tab was opened LINGER in the shared cookie jar after the private tab is
        closed (a private tab's own WebView is created with the gate already refused, so it
        stores nothing new). The app deliberately does NOT flush the global cookie jar on close
        (that would log the user out of normal-tab sites). This limit is documented in
        `MainActivity.kt` and is the accepted Android weakest tier.

        **Parity matrix (honest):**
        - **Linux**: ephemeral WebKit partition — compile-verified; **live GUI verify PENDING**
          user display session.
        - **Windows**: WebView2 in-private controller — compile-verified
          (`cargo check --target x86_64-pc-windows-gnu` + CI MSVC); **GUI runtime-verify
          PENDING** device.
        - **macOS**: `nonPersistentDataStore` — **CI-compile-only** (objc2 needs macOS
          toolchain); GUI runtime is sub-project I.
        - **Android**: best-effort `LOAD_NO_CACHE` + 3rd-party-cookie refusal + per-tab
          cache/history clear on close — Kotlin compile-verified; **device verify PENDING**;
          first-party-cookie persistence after close is a documented, accepted limit (not
          fixable without a wry or Android per-profile API).

21. **Anti-fingerprinting (farbling) hard-won lessons.** Four lessons from sub-project L:

    a. **Bake the seed INSIDE the IIFE closure, NEVER as a top-level `var` or `window.*`
    assignment.** A top-level `var __aegisFarbleSeed = '...'` leaks to `window` — any
    cross-origin script in a subsequent navigation in the same frame can read
    `window.__aegisFarbleSeed` and reconstruct the per-origin noise, turning the seed into
    a cross-site super-cookie. The correct form is `(function(seed){ /* shim */ })('<hex>');`
    — the seed is a closure parameter, invisible outside the IIFE. `farble.rs`'s `shim_for`
    enforces this by substituting the placeholder inside the IIFE call argument.

    b. **Runtime shim tests MUST run in TRUE global scope via indirect eval — NOT
    `new Function`.** `new Function('code')()` creates a new function scope, so a
    `var` declared at the top of `code` does NOT go onto the global `window` object —
    the leak test always passes (false negative). `(0, eval)('var x = 1'); x` runs in
    the true global scope and WILL assign to `window`, catching the super-cookie pattern.
    `farbleShim.test.ts` uses indirect eval for exactly this reason.

    c. **Per-spawn applies to level AND allowlist.** The farble shim is baked into the
    document-start JS at content-webview creation. Toggling `antiFingerprint` or the
    fp-allowlist takes effect only on NEWLY spawned/reloaded tabs — existing open tabs
    keep the shim (or absence of one) they were born with. This is the same model as the
    WebRTC shim; document it in any UI that toggles these settings.

    d. **An app-free JNI global is a THIRD thing that must be seeded at boot.** The Android
    JNI getters (`NativeFarble.farbleScript`, `NativeWebrtc.shimScript`,
    `NativeAdblock.shouldBlock`) run on a JNI thread with no `AppHandle`, so they cannot call
    `settings::` readers. Each therefore reads a process-global that Rust pushes:
    `ANDROID_POLICY` (`webrtc_shim::note_policy`, seeded at `lib.rs` boot),
    `ANDROID_LEVEL` (`farble::note_level`) and `ANDROID_FP_ALLOWLIST`
    (`farble::note_fp_allowlist`) — the latter two both pushed by `farble::seed_from_disk`.
    `settings.rs` re-pushes them on `settings.set` and `apply_synced`, but those only fire on
    a CHANGE. `ANDROID_LEVEL` used to have no boot push at all, so farbling worked until the
    app was restarted and then silently read "off" for the rest of the session despite the
    setting still being "strict" on disk; `farble::seed_from_disk` now pushes it through the
    CLAMPED reader (`level`). When you add a JNI getter that needs settings, add the global
    AND its boot push in the same change. Gate a new global on
    `#[cfg(any(target_os = "android", test))]` rather than `#[cfg(target_os = "android")]`,
    so a Linux test can read it: an android-only test never runs on the CI runner, which is
    how the two farble round-trip tests stayed dead for as long as they did.

### Multi-webview Linux layout (hard-won facts)

These apply when there is more than one content webview (i.e. multiple tabs):

a. **One canonical GtkFixed.** Every content webview must live in the same
`GtkFixed` container. New `add_child`-ed tabs land in the `GtkBox` and must
be re-parented into the `GtkFixed` each layout pass; leaving them in a nested
`GtkFixed` breaks the hide-others logic.

b. **Classify by GTK widget name, not pointer.** Content webviews are identified
in `layout()` by a GTK widget name set via `mark_content_label`
(constant `CONTENT_WIDGET_NAME`). Do NOT collect pointers via `with_webview`
— that closure runs off the main thread and races with layout.

c. **Hide the active content by parking it OFFSCREEN, never `set_visible(false)`.**
A full-window chrome overlay (settings/downloads/sidebar-less) should cover the
page: `content_visible = fullscreen || sidebar || !overlay` (also treat
`about:`/home as not-covering). But on this stack `set_visible(false)` on the
active content is wrong twice over: (1) it _backgrounds_ the page — rAF stalls,
which malvertising weaponizes to fire a redirect — and (2) it doesn't even
reliably hide it: the WebKit native window stays stacked on top, so a full
overlay renders BEHIND the page (confirmed via layout logging — the flags were
correct, content stayed on top regardless; see gotcha (d)). So `layout()` keeps
the active content `set_visible(true)` ALWAYS and, when it shouldn't cover the
screen, moves it OFFSCREEN (`fixed.move_(&child, -10000, -10000)`) — the same
mechanism that reliably hides background tabs. Visible+offscreen = not
backgrounded and not covering the chrome. Z-order: raise the content only when
it's shown; otherwise raise the chrome — never `raise()` the content while it's
parked, or it re-covers the overlay.

d. **Fullscreen exit button must be the topmost GtkFixed child.** In fullscreen
mode the exit button must be re-added as the last (topmost z-order) child of
the `GtkFixed` each layout pass — `raise()` alone is not enough to lift a GTK
widget above native WebKit windows.

22. **Proxy `bypassHosts` canonical-key lesson.** The `ProxyConfig` struct uses
    `#[serde(rename = "bypassHosts")]` so that `serde_json::to_value` writes
    `"bypassHosts"` (matching `settings.json`, `state_json`, and the TS
    `ProxyConfig` interface) and `from_value` reads the same key back. Without
    the rename, serde writes `"bypass_hosts"` but `from_value` expects
    `"bypassHosts"` — a four-way key mismatch (struct field / serde output /
    settings store / TypeScript) that silently drops all bypass hosts on every
    restart. The fix: one canonical `"bypassHosts"` string used everywhere;
    enforced by the `serde_roundtrip_preserves_bypass_hosts` unit test.

23. **Proxy: four very different apply mechanisms per platform.** Adding a
    new proxy feature must account for each tier independently:
    - **Linux**: live per-webview `set_network_proxy_settings` — changes take
      effect immediately on all existing tabs.
    - **Windows**: spawn-time `--proxy-server` arg — changes only apply to
      tabs created or reloaded AFTER `proxy.setConfig`; already-open tabs keep
      their old proxy until reload. UI copy should say "reload the tab to apply."
    - **Android**: process-global `ProxyController` via a Kotlin down-call —
      covers ALL WebViews in the process; the chrome is excluded via bypass rules.
      Rust cannot up-call into Kotlin; the bridge is read-only from Kotlin's side
      (Kotlin pulls the config from `proxy_config_json`, Rust never pushes).
    - **macOS**: no-op — proxy is not implemented; macOS builds and browses
      without it. The implementation guide for this was deleted in commit 58d2c4b and is
      NOT recoverable, so the macOS tier has to be re-derived from scratch (raw `msg_send!`
      / `nw_proxy_config_*` Network.framework bindings, uncompilable from Linux).

24. **Windows: content webviews need their OWN user-data-folder, keyed on their
    browser args (the `additional_browser_args` blank-page regression).** WebView2
    refuses to create a webview whose `AdditionalBrowserArguments` differ from
    another webview already using the **same user-data-folder** —
    `CreateCoreWebView2EnvironmentWithOptions` fails and the content webview comes up
    with **no engine** (blank page, no panic, `spawn_tab` returns `Ok`). The chrome
    window is created with wry's DEFAULT args; a content webview that appends the
    WebRTC (`--force-webrtc-ip-handling-policy`) or proxy (`--proxy-server`) flag
    therefore clashes with the chrome on the shared default folder. Because
    `webrtcPolicy` defaults to `public-only`, EVERY content tab got the override and
    **every page was blank by default** on Windows — a total browsing break introduced
    by `196d4a3` (WebRTC backstop), unnoticed because the last hand-verified Windows
    build (`Aegis_x64_portable.exe`, 2026-06-17 18:00) predated that commit (20:13) and
    no test harness can exercise WebView2 env creation. **Fix (`nav::spawn_tab`):** house
    each content webview in its own folder `EBWebView-content-<hash(args)>` (sibling of
    the chrome's `EBWebView`), keyed on the exact arg string (`"default"` when no
    override). So (a) content never clashes with the chrome and (b) only tabs with
    IDENTICAL args share a folder — they share cookies/logins; a different WebRTC policy,
    proxy, or per-site allowlist status gets its own profile. Applies to private tabs too
    (incognito keeps them ephemeral but they must still avoid the chrome's folder).
    Runtime-verified on real Windows 11 (2026-06-24): default `public-only` renders +
    ad-blocks, private tab renders, and proxy egress confirmed (real `CONNECT` traffic
    logged through a local proxy). Side effect: toggling WebRTC/proxy/allowlist starts a
    fresh cookie jar for new tabs in the new profile — acceptable (a different
    network/privacy context). **Lesson:** never give one webview different browser args
    than its same-profile siblings; isolate the profile if the args must differ.

25. **A visit is recorded by the PLATFORM that owns the page load — and on Android
    that is Kotlin, so `on_page_load` silently records NOTHING there.** `history::record`
    had exactly one non-test caller: the `on_page_load` closure inside
    `nav::spawn_tab`. That is a **wry** callback, and Android's content area is a
    **native Kotlin `WebView`** (`MainActivity.createTabWebView`), so wry never sees a
    content load and nothing ever called `record` on Android. Result: the store stayed
    empty and the mobile History sheet was permanently blank — while the panel, the
    `useHistory` hook, the `history.*` channels and 12 Rust unit tests were all fine.
    **The tell was in the source:** `record`, `should_record_visit`, `apply_visit` and
    `MAX_ENTRIES` each carried `#[cfg_attr(target_os = "android", allow(dead_code))]`.
    That attribute was not a harmless lint exemption — it was the bug, suppressed.
    **Lesson: a `cfg`-scoped `allow(dead_code)` on a FEATURE is a claim that the
    feature does not exist on that platform. Read it as a parity gap and go verify,
    never as a cleanup.** (Generalised, with a full audit method, in gotcha 26 — which
    also records that most `allow(dead_code)` in this crate hide _live_ code, so "remove
    it and see if it warns" is only sound when you check EVERY target.) Fix:
    `NativeHistory.recordVisit(tabId, url, title)` (Kotlin
    `object`, called from `makeContentClient(id).onPageFinished`) → JNI export
    `Java_com_aegis_browser_NativeHistory_recordVisit` → `record_page_finished`.
    Three things that path has to get right:

        - **Kotlin is the ONLY side that sees the load**, and Kotlin→Rust is also the only
          usable direction (Rust cannot up-call into Kotlin). So the core cannot own this
          step on Android; the dependency is structural, not an oversight.
        - **Kotlin passes the tab id and NEVER a privateness flag.** `record_page_finished`
          resolves `is_private` from the registry itself, exactly as `nav.rs` does. A
          caller-supplied flag is a private-visit leak, and it is covered by
          `record_page_finished_skips_private_tabs_and_keeps_the_title` (verified
          non-vacuous: reintroducing `false` fails it).
        - **It needs an `AppHandle`**, which no other JNI entry point does — they are all
          pure functions over their arguments. Hence `ANDROID_APP: OnceLock<AppHandle>` +
          `set_android_app` from `lib.rs` setup. This is the first `AppHandle`-backed
          native entry point; expect the next native feature to want one too.
          Also note the asymmetry this exposes: Android records a real `WebView.title`
          inline, so **Android history has titles while Windows/macOS do not** (they record
          `""` and only Linux has a title-changed signal — `update_title` is Linux-only).
          The JNI boundary itself (symbol name, arity, the `onPageFinished` call site) has no
          automated coverage: `cargo check --target aarch64-linux-android` proves the Rust side
          and `compileUniversalDebugKotlin` the Kotlin side, but only a real device proves the
          two agree. **Device-VERIFIED on a Galaxy S22 (2026-09-27):** navigating to
          `https://example.com` produced
          `onPageFinished -> recordVisit -> app=SET`, `is_private=false`, `should_record=true`,
          `store len=1`, and the mobile History sheet rendered "1 visit / Example Domain /
          example.com / just now". Only the JNI seam needed proving; the hook itself was
          always correct.

e. **A webview's size request must stay (0,0), and that is load-bearing in BOTH directions — the
window cannot shrink otherwise, and a GtkFixed collapses a (0,0) child to 1×1.** The two facts
are in tension and the tie was broken by measurement, not taste.

- **A window's minimum comes from its children's requests.** In a `GtkFixed`,
`set_size_request(w, h)` sets each child's _minimum_ size, which GTK propagates up as the
**window's** minimum — so sizing the webviews to the window pins it to its current size: it
grows, never shrinks. The webviews therefore carry a `(0,0)` request and are sized with
`size_allocate` from `size_fixed_children`, connected `after=true` on the canonical `GtkFixed`'s
"size-allocate". The effective insets come from managed `LayoutInsets`; the floor comes from
Tauri `set_min_size`.

- **`GtkFixed` allocates every child to that child's size REQUEST, and a WebKit webview's request
is GTK's default 1×1** (`webview size_request (min) : 1x1`, MEASURED). With the (0,0) request,
every "size-allocate" collapses both webviews to 1×1 and `size_fixed_children` re-expands them:
two full-page re-layouts of the content per pass. Measured on 10 WM driven resizes:
`fixed_passes=10 collapsed1x1=20/20`, `pre = [("chrome",1,1),("content",1,1)]`.

- **★ The collapse CANNOT be fixed by writing the webviews' real geometry into their requests.
Tried, measured, shipped, reverted.** It does work — a probe against real GTK went from
`collapsed1x1=20/20` to `0`, with a steady-state pass doing nothing (`passes=0 reallocs=0`) — and
it made the window completely unshrinkable, which the owner reported and no test could catch. A
four-arm probe (`examples/winmin.rs`, deleted) measured it against real GTK:

| arm | GtkFixed's minimum | `resize(320,240)` |
| --- | ------------------ | ---------------- |
| webviews at `(0,0)` — the shipped code | `(1, 1)` | **SHRANK ok** |
| webviews at their real size | `(900, 900)` | **BLOCKED** |
| … plus `fixed.set_size_request(0, 0)` | `(900, 900)` | **BLOCKED** |
| … plus the same on the toplevel / on the Box | `(900, 900)` | **BLOCKED** |

The last two arms are the whole point: **GTK3 will not let a `set_size_request` LOWER a
container's minimum below what its children demand.** The override is genuinely stored
(`fixed.size_request()` reads `(1, 1)`) and clearing it on the Fixed, the Box or the toplevel
does nothing; re-asserting it on every sizing pass does nothing either. So the webviews' OWN
minimum is the only thing that can be kept small. Pinned by
`linux_layout::tests::the_webviews_keep_a_zero_size_request_so_the_window_can_still_shrink`,
mutation-verified (re-adding `child.set_size_request(w, h)` to `size_fixed_children` reds it).

- **So the RESIZE flicker is still open by necessity, and the honest next step is a container
that sizes children to the CONTAINER's allocation rather than to their requests.** `GtkOverlay`
does exactly that — its children always get the overlay's allocation, so neither webview needs a
size request and the window stays shrinkable — but it has no arbitrary x/y, so it cannot express
this file's two use of position: parking a background tab at (-10000, -10000) (which must keep
the webview VISIBLE, because `set_visible(false)` backgrounds the page) and pinning the
fullscreen-exit button to the top-right corner. A custom `Container` subclass, or `GtkOverlay`
wrapping a positioned child, is the real fix. Do not attempt it without re-measuring shrink and
collapse together in one probe.

f. **tao emits `WindowEvent::Resized` for EVERY ConfigureNotify — with no comparison against the
previous size — so a window DRAG re-ran the whole GTK layout once per frame.** `tao-0.35.3/src/
platform_impl/linux/event_loop.rs`, `connect_configure_event`: it reads `event.size()` and sends
`Resized` unconditionally, alongside `Moved`. A drag is a stream of ConfigureNotify whose
position changes and whose size does not, so `Resized => view::apply_inset` fired once per drag
frame. `lib.rs`'s handler now calls `view::on_window_resized`, which remembers the last physical
size it laid out for and skips an unchanged one, so a drag does no layout work at all. That is
the shipped fix for the reported move flicker, and it is why the 1×1 collapse above does not fire
while dragging. **The GTK layer alone cannot see this** — a `GtkFixed` "size-allocate" fires ZERO
times on a pure move (measured in all three probe runs), so probing only GTK "refutes" the layout
path and sends you into the wrong layer. Read the EVENT layer, not the signal layer, for anything
driven by a window event.

26. **Most `#[allow(dead_code)]` in this crate hide LIVE code, not dead code — audit by
    STRIPPING and re-compiling, never by reading the comment.** (Full audit,
    2026-09-27: every occurrence, three targets.)

    **Why so many exist at all.** `lib.rs`'s `ipc()` and every `dispatch()` match on
    **string literals** (`"nav.navigate" => …`), so a `pub fn` sitting behind a channel has
    **no call edge for rustc to follow**. Deleting its allow does not expose dead code — it
    exposes a working feature. A grep-based audit concludes the exact opposite of the truth
    here: `navigate_tab`, `is_find_channel`, `sync_auth::verify` and `emit_will_submit` have
    **zero** hits in `shared/types.ts` and no renderer caller either, yet the channels that
    reach them are string-matched. So the comment is not a substitute for the compiler; at
    best it tells you what the author _believed_.

    **The audit method that is actually sound** (comments lie, in both directions):

        1. Delete every `allow(dead_code)` attribute line under `src-tauri/src`. All of them
           are standalone single-attribute lines, so a line-delete is a faithful strip — with
           **one trap: `proxy.rs:5` mentions the attribute in PROSE inside a comment.** Match
           on `^\s*#\[` rather than the substring, or you will corrupt a comment and then
           "fix" it by restoring a broken sentence.
        2. Run `cargo check --locked` **without** `-D warnings`, per target. Deliberately not
           `-D warnings`, for two reasons: you get the whole warning set instead of the
           first hard error (remember the one-wave rule), and plain `check` **excludes
           `#[cfg(test)]`**, so a test-only fn still warns — a strict **superset** of what
           CI's `--all-targets` run could flag.
        3. `git checkout -- src-tauri/src` to restore.
        4. For each newly-warned symbol, collect the **nearest enclosing `#[cfg]` of every
           reference**. That one fact is what separates an honest exemption from a bug.

        **Zero warnings on a target ⇒ every allow on it suppresses nothing ⇒ provably
        removable.** Re-verify with a plain `cargo check` again: 0 warnings ⟹ the
        `-D warnings` CI gate passes, and it reuses the warm cache. Do **not** "re-verify" by
        flipping `RUSTFLAGS` — that forces the ~4-minute full dependency rebuild noted in
        the coverage section, on every target.

    **The inventory, and what each shape means.** 67 real attributes: **52 `cfg_attr`-gated**
    (50 per-item plus the 2 module-level ones below) + **15 unconditional, all per-item — there
    is no blanket module allow left in the crate.** A raw `grep -rn 'allow(dead_code)'
    src-tauri/src` says 89, and the other 22 are not attributes: 17 are prose inside `//` and
    `///` comments and 5 are the sample source lines inside
    `the_blanket_allow_scan_separates_module_allows_from_scoped_and_commented_ones`, which is
    exactly the trap step 1 of the method below warns about. They are not interchangeable, and
    each class has a different verdict:

    | Class                | What the allow is hiding                                    | Verdict                                    |
    | -------------------- | ----------------------------------------------------------- | ------------------------------------------ |
    | live-but-untraceable | reached only via a literal-matched `ipc()`/`dispatch()` arm | necessary, and the large majority          |
    | test-only            | the only caller is `#[cfg(test)]`                           | necessary; the item is not production-live |
    | platform tiering     | live on a _different_ target                                | necessary; nearly all are honest           |
    | **truly dead**       | no caller and no test, on **any** target                    | **the allow is the bug**                   |
    | **parity gap**       | dead precisely where the feature is exposed                 | **the allow is the bug**                   |

    The two conventions in use, so a new one matches something:

    - **Per-item `#[cfg_attr(<plat>, allow(dead_code))]`** — 50, concentrated in
      `redirect_guard.rs` (19) and `nav.rs` (8), then `adblock.rs` 5, `downloads.rs` 3,
      `tabs.rs` 3, `adblock_inject.rs`/`safety.rs` 2, and 1 each in `adblock_engine`,
      `farble`, `find`, `history`, `lib`, `tab_registry`, `zoom` (`settings.rs` no longer has
      any — its last went with the false "consumed by the F2b sync merge" claim below). By
      platform: 40 name `android`, 10 `windows`, 3 `macos` (some name two, via `any(..)`).
      **Prefer this shape** — it keeps the lint on for every other platform, so the
      exemption is visible at the item.
    - **Module-level `#![allow(dead_code)]`** — **none.** Two modules scope a module-level allow
      to a platform instead: `picker.rs` (`#![cfg_attr(target_os = "android", …)]`) and
      `redirect_guard.rs` (`… "macos"`, per the no-macOS-redirect-tier note in gotcha 14).
      Those two are the module-level half of the 52 `cfg_attr`-gated attributes. The three
      blanket allows that used to sit here — `adblock_lists`, `sync_stores`, `sync_vault` — are
      gone, and **not** for the reason the structural finding below gives: all three are
      declared with a PRIVATE `mod X;` in `lib.rs`, so nothing inside them is exported and
      rustc applies the same dead-code cap to a `staticlib`, a `cdylib` and an `rlib` alike. A
      blanket is therefore never the right spelling for a private module, whatever platform it
      is compiled for. `no_module_carries_a_blanket_dead_code_allow` in `lib.rs`'s tests now
      asserts the empty set (it used to pin those three by name), so a new blanket fails
      `cargo test` instead of hiding a diagnostic.

    **Structural finding: a blanket module allow is usually a missing `#[cfg]` on the `mod`
    declaration — and the two cases this audit found are now fixed exactly that way.**
    `adblock_convert` WAS declared **unconditionally** in `lib.rs` and is Linux-only in practice:
    `to_content_blocker_chunks` is called from exactly one arm, inside `install_adblock`, which
    is `#[cfg(target_os = "linux")]`. That unconditional compilation was _why_ the module needed
    a blanket allow, and the blanket was what hid it. It is now declared
    `#[cfg(any(target_os = "linux", test))]` — the `test` arm keeps its 8 conversion unit tests
    running on every platform, the same shape `redirect_guard` already used — and the blanket is
    gone. Measured, not assumed: with the gate deleted, `cargo clippy --locked --all-targets
    --target x86_64-pc-windows-gnu` fails with exactly three `is never used` errors
    (`to_content_blocker_chunks`, `allowlist_exemptions`, `usable_if_domain`); with the gate,
    that target and the host are both clean under `-D warnings`. (This paragraph also used to
    call `adblock_webkit` unconditionally declared. That was half wrong: it has always been
    `#[cfg(target_os = "linux")]` in `lib.rs`, so nothing in it is dead on the single platform
    that compiles it and its blanket was pure dead weight — simply deleted.) `sync_stores` /
    `sync_vault` are still un-gated and genuinely span platforms, which used to be read as
    "so the blanket is the honest choice". It is not: they are PRIVATE modules, so the cap
    that makes `pub` items in a `pub mod` warn on a `cdylib` does not apply to them at all, and
    the three blanket allows are gone with no lint change on any target. (`adblock_lists` is a
    data module — its named consts feed `ALL`, which is the only member the rest of the crate
    reads.)

    **What the audit removed.** 7 attributes whose comments claimed to be _"dead on the
    Android cdylib until F2b"_ / _"consumed by the F2b sync merge"_. F2b is done and the merge
    now calls them, so all 7 suppressed nothing (zero hits in all three probe logs):
    `Hlc::zero`, `Hlc::bytes`, `from_value`, `next_observe`, `observe` in `sync_envelope.rs`,
    and `sync_records`, `apply_synced` in `settings.rs`. Verified: 0 warnings on linux, android
    and windows, `cargo fmt --check` clean, `cargo test --lib` 425 passed. **The lesson is the
    part worth keeping — an allow's justification is a dated claim about the code around it, so
    it goes stale silently and passes review forever. Re-strip and re-check instead of
    re-reading it.**

    **What is still dead, each with a doc comment asserting a caller which does not exist.**
    Left in place deliberately: deleting them is a judgement call, and the false comments are
    half the bug.

    - `nav::navigate_tab` — its doc claims _"Every programmatic content navigation must go
      through here."_ **Nothing calls it.** The `nav.navigate` dispatch arm inlines the
      identical two lines, and 6 other sites call `redirect_guard::expect` directly. Either
      delete it or rewire those sites through it, as the doc intends.
    - `find::is_find_channel` — the comment says _"called from platform find modules"_; the
      only references are `#[cfg(test)]` asserts. `lib.rs` calls `find::dispatch`, which
      matches channels itself and returns `None` otherwise.
    - `sync_auth::verify` — test-only, no production caller, no IPC channel. (`sync-server`
      has its own, separate `verify_auth`.)
    - `form::emit_will_submit` — **zero references anywhere**, even tests. This one is
      honestly labelled `TODO(M13)`, so it is a deliberate stub, and the renderer _does_
      subscribe to `form.willSubmit` — a declared-but-unproduced event, not an oversight.

    **One masked parity gap, and it is narrow.** `settings::https_only` is android-dead
    (`#[cfg(desktop)]`-only reader in `nav.rs`), and `MainActivity.secureUrl()` is the only
    Android consumer — it reads the setting through
    `NativeSettings.httpsOnlyOrDefault()`. An earlier revision of this bullet claimed
    `secureUrl` HARDCODED the upgrade and never read the setting; that stopped being true
    when Wave 8 added the `ANDROID_HTTPS_ONLY` JNI global (see gotcha 27), and it was left
    to rot here. What is still true, and is the real gap: `secureUrl` only ever **upgrades**
    a URL, so on a **release** APK the setting cannot be honoured in the other direction —
    `build.gradle.kts` sets `manifestPlaceholders["usesCleartextTraffic"]="false"` for release
    (`true` for debug), so un-checking `httpsOnly` and loading `http://…` is refused by the
    platform's network security policy with nothing reporting why. A **debug** session cannot
    exercise it. The `httpsOnly` checkbox in `SecurityTab.tsx` has no platform gate, so the
    control is live where it cannot work. Owner decision pending: hide the control on
    Android, or align the release manifest.

    **Four hypotheses the audit raised and DISPROVED — recorded so they are not
    re-investigated.** Each looked exactly like gotcha 25's Android history bug (a Rust path
    that is a no-op on that platform), and each is fine:

    - ~~**Find-in-page on Android is NOT broken.**~~ **The `Ok` was the bug; the silent no-op
      is now an honest `Err`.** Kotlin implements find natively (`@JavascriptInterface
find/findNext/findPrev/findClose` → `WebView.findAllAsync`/`findNext`) and the
      renderer's `aegis.find.*` routes to `androidBridge()` **first** — so the Kotlin path
      is the normal one and `find::emit_state`'s android allow was honest. What this
      hypothesis missed is that `ipcClient` attaches the bridge _slightly AFTER module
      load_ (its own comment at `ipcClient.ts:366` says so), and `useFind.ts` calls
      `aegis.find.start/next/prev/close` with NO platform branch. A query typed in
      that window therefore falls through to `find::dispatch` on a phone, which
      answered "done" for a session it never started — no highlight, no error. All four
      channels now end in `refuse_without_native(native_find())`, whose message reaches
      the user as the same on-screen error as any other `AegisIpcError`
      (`main.tsx:28`). The reachability is pinned by a renderer test that drives the
      four channels with no bridge installed.
    - **Android's block counter is NOT missing.** `MainActivity.noteBlocked(id)` is the Android
      mirror of `adblock::note_blocked`, called from the `shouldInterceptRequest` path; the JNI
      `shouldBlock` entry deliberately only calls `should_block`.
    - **`picker` / `zoom` / `downloads` android allows are honest tiering.** The mobile UI is
      `src/components/mobile/` (7 non-test files) and none of them reference those three. Note
      the check itself: probing `src/mobile/` finds nothing because that path does not exist,
      which is a **vacuous pass**, not a clean bill of health.
    - **`safety::is_blocked`/`raise` android-dead is honest** — Kotlin renders its own block
      page.

    **Limits of this audit.** Linux, android and windows only. **macOS is CI-verified only**
    (`objc2` needs a macOS C toolchain), so the 3 macOS-scoped attributes are the only ones
    whose justification no local run re-confirmed. The question a `cfg_attr` always raises is
    "does _that_ target's tier call it?", and for macOS nobody has run the probe. Re-run the

## Gotcha 27 — a privacy setting the platform IGNORES, and a counter that counts the wrong thing

Wave 8's findings, and the shape they share: **a control that is present in the
contract and absent from the code, or present in the code and wrong in the label.**

- **`httpsOnly` was hardcoded ON on Android.** `settings::https_only` carried
  `#[cfg_attr(target_os = "android", allow(dead_code))]` — an ACCURATE claim — while
  `MainActivity.kt`'s `secureUrl` upgraded `http`→`https` UNCONDITIONALLY, with a comment
  that hardcoded the setting's _default_ as if it were the _policy_. A user who turned
  HTTPS-Only OFF (because they have a plain-HTTP intranet host, which is the whole reason
  the setting exists) had that host rewritten to `https` on Android and the site simply
  broke, with nothing reporting that Android was stricter. Fixed with
  `settings::ANDROID_HTTPS_ONLY: AtomicBool` (`note_https_only` / `android_https_only`),
  pushed from `settings::write` — the single low-level writer every path funnels through —
  and at boot in `lib.rs` beside the other app-free JNI globals, and read by a new
  `NativeSettings.httpsOnlyOrDefault()`. **The default is `true`
  (`HTTPS_ONLY_FAIL_SAFE`) and the JNI failure path returns it**, because a getter that
  cannot ask must fail TOWARDS the protective value here — the _opposite_ of the ad-block
  JNI getters, which fail open because not blocking is protective over there.
  `https_only` itself is now generic over `R: Runtime` (it was concrete-`&AppHandle`, which
  is why the mirror inside the generic `write` could not call it) and its `allow(dead_code)`
  is gone.

- **`webrtcPolicy` failed OPEN through THREE consumers, not one.** `settings::webrtc_policy`
  defaulted only when ABSENT and returned any stored string verbatim, so a corrupt value
  meant: `webrtc_shim::shim_for_inner` returned `""` (no shim at all); `nav.rs`'s
  `webrtc_arg` match hit `_ => None` (no Chromium `--force-webrtc-ip-handling-policy`, so
  the default policy leaked real local IPs); and `linux_layout::apply_webrtc_policy_label`
  enforces only `disable`, leaving WebKit's own WebRTC on. Reachable through an imported
  `data.import` bundle or a **synced** settings record — any device holding the account data
  key can write one. Fixed by clamping in the reader against ONE new
  `pub const WEBRTC_POLICIES: &[&str] = &["default", "public-only", "disable"]`, which the
  validator also uses, so the two cannot drift. The clamp target is `"public-only"` (both
  the default and the protective tier); `"default"` stays a distinguishable deliberate
  opt-out. **The tell that this was an oversight rather than a choice:** the very next
  function, `anti_fingerprint`, is documented "Raw read — callers (e.g. `farble::level`)
  validate/clamp the value", and `farble::level` does clamp.

- **A closed tab's redirect chain survived on three of four platforms.** `Chains` is
  written by BOTH guard paths (`block_at_start` for the single-phase Windows/Android path,
  `note_nav` for the two-phase Linux path) but cleared only on Linux, from
  `linux_layout.rs`. `NavActions` is Linux-only (`note_nav` is its only writer), so its
  `allow(dead_code)` attributes are ACCURATE — it was `Chains` that leaked. Both clears are
  now `pub(crate) fn …<R: Runtime>` and are called from `tabs::forget_closed_tab`, which
  both close paths already share. Not unbounded growth (one entry per tab id, overwritten,
  ids monotonic within a session) but a real correctness edge: a hand-edited `tabs.json` or
  a restored backup can hand back a reused id, and a stale `ChainStart` then answers for a
  tab that no longer exists. **`note_nav`/`block_at_start`/`chain_origin`/`record_action`
  became generic as a side effect, which is what made the two-phase and single-phase paths
  testable at all — and it was cheap because they only use `try_state`.**
  `decide_at_response` and `take_action` were the two this left behind, and they are the two
  the widening mattered MOST for: they are the Response-phase decision itself, so while they
  took a concrete `&AppHandle` the whole of Linux's anti-malvertising path had no test at
  all (only the pure `should_block_pred` did) — the chain store, the per-tab keying, the
  subframe refusal and the app-initiated match were all untested production code. Both are
  generic now, with no body edit and no call-site edit (`linux_layout.rs` infers `Wry`).
  What still cannot be reached is `on_blocked_redirect_to_new_tab`, which takes a concrete
  `&AppHandle` because it opens a real window from a spawned thread; that is the deliberate
  limit, not an oversight.

- **`NavActions` could grow without bound inside a single tab** — the leak the entry above
  did NOT find, because there `Chains` (one entry per tab id, overwritten) was the whole
  story. `record_action` writes one entry per Linux `NavigationAction`, and the only
  in-lifetime consumer is `clear_tab_actions` on a **top-frame main-resource Response**,
  which drops the WHOLE tab. So the shape that grew forever was **one long-lived top-level
  document that keeps loading subframes**: each records an action, and none of them ever has
  a main-frame Response to consume it. A page under an ad-heavy third-party embed drives
  hundreds of those between two top-frame loads, and each entry held a `ChainStart` (two
  `String`s), for as long as the tab stayed open.
  The fix is `MAX_ACTIONS_PER_TAB` (32) with **oldest-first** eviction in `record_action`.
  Three design points, each of which was a decision rather than the obvious implementation:
  - **The value carries a `u64` stamp** (`(ChainStart, bool, u64)`, from a process-global
    `ACTION_SEQ: AtomicU64`), because "oldest" needs insertion order and a `HashMap` has
    none. Re-recording an existing key REPLACES the stamp, so the freshest decision is also
    the last to be evicted — the same preference `insert` already gave it.
  - **The cap is PER TAB, not global.** `clear_tab_actions` already removes a tab wholesale,
    so a global cap would let one noisy tab evict another tab's in-flight decisions. The
    count is a full scan of the map, which is acceptable only because the map is now bounded
    at (tabs × 32).
  - **An evicted navigation FAILS OPEN, deliberately.** It finds no entry, so
    `take_action` returns `None`, so `decide_at_response` returns `None` and that ONE
    navigation is allowed. That is the honest trade, and it is recorded in the const's doc:
    an unbounded map is a leak that lasts as long as the tab, and a stale entry is worse
    than no entry anyway — a decision stamped many navigations ago describes a navigation
    that has already finished. **Deciding at RECORD time instead was rejected:** it would
    cancel SUBFRAME navigations, which is exactly what `record_action`'s own doc forbids.
  - **`linux_layout.rs`'s hardcoded `true` for `main_frame` is untouched and correct.** It is
    a deliberate fail-safe with a comment explaining that WebKitGTK's `NavigationAction`
    carries NO frame flag (only `ResponsePolicyDecision` does, via
    `is_main_frame_main_resource()`). Because every Linux entry is therefore `main_frame ==
    true`, `record_action`'s "a subframe must not clobber a main-frame entry" early-return
    is **unreachable on Linux** — it fires safe, and its comment overclaims. Do not "fix"
    the hardcoded `true`; there is no signal to fix it with.
  Pinned by `a_long_lived_top_level_document_cannot_grow_the_action_map_without_bound`
  (drives the PRODUCTION writer `note_nav` with `drive = 4 * MAX_ACTIONS_PER_TAB` DISTINCT
  normalized urls — re-recording one key keeps the map the same size, so a count-only test
  would never notice the absence of a bound — then asserts the survivors are **exactly** the
  tail of the drive, which is what states "oldest-first"; my first version tried to say that
  with stamp arithmetic, `ACTION_SEQ - oldest`, and that quantity is the size of the
  SURVIVING window, not the number of stamps issued before it) and by
  `evicting_one_tabs_oldest_action_does_not_touch_another_tabs` for the per-tab half.

- **`adblock::PAGE_BLOCKED` had no remover at all** — the only genuinely unbounded
  tab-keyed table left (`nav::TABS_WITH_CONTENT` and `nav::TABS_LOADING` are cleaned, and
  the two `find` query stores are cleared on `find.close`). `forget_page_blocked(id)` is now
  called from `forget_closed_tab`, so a tab that comes back with a reused id starts its
  shield badge at zero instead of inheriting a dead tab's count. **Note the distinction:**
  `zero_page`/`reset_page` is a per-tab RESET for a tab that navigated again;
  `forget_page_blocked` is a REMOVAL for a tab that is gone.

- **The shield badge said "Blocked", and on Linux the requests it counted were ALLOWED.**
  `linux_layout::block_counter_tx` is fed by `resource-load-started`, which fires only for
  requests the capped declarative filter let through; the thread then asks the full engine
  and counts the ones it flags. Content-filter-blocked requests are cancelled BEFORE that
  signal and never counted, so the number is a **lower bound** on Linux — while on Windows
  (`adblock_win`) and Android (`shouldInterceptRequest`) it genuinely is "requests we
  stopped". The core has always documented this honestly; the renderer said "Blocked here"
  and "N blocked on this page", which is false on one platform. Both visible strings and
  the `aria-label` now say "caught", and the popover states the per-platform difference.
  **Four pre-existing tests asserted the old lying strings, so they had encoded the bug.**

- **Reported, not fixed, each for a stated reason.** (a) There is **no macOS
  anti-malvertising guard** — no `nav_policy_mac.rs` — but `redirect_guard.rs`'s module doc
  already names that in plain words, so it was never hidden by the `cfg_attr`; closing it
  needs WKWebView `decidePolicyForNavigationAction:` via objc2, which cannot be compiled or
  verified from Linux. (b) **CLOSED — `navigator.plugins` IS faked, in JS.**
  `src-tauri/src/farble.standard.js` installs a configurable own-property getter returning
  `{ length, item() { null }, namedItem() { null } }` with every index `null`, where
  `length = ((seedNum ^ originHash) & 0xFF) % 7 + 1`, `seedNum` is the first four bytes of
  `SEEDHEX` and `originHash` hashes `location.href`. "Does not exist in this codebase" was
  true of `farble.rs` only — the farbling is injected as a JS artifact, so grepping the
  Rust file finds nothing (and the artifact paths are `src-tauri/src/farble.standard.js`
  and `src-tauri/src/farble.strict.js`, not bare `src/`). (c)
  `hardwareConcurrency` IS a deliberate deterministic clamp to `{2,4,8}` in the JS
  artifacts (`src-tauri/src/farble.standard.js`, `src-tauri/src/farble.strict.js`), not
  noise; the genuine tell is that every OTHER perturbation is jittered per session while
  this one is byte-identical, which identifies the shim — but varying it changes behaviour,
  so it is the owner's call, not a silent fix. (d) **CLOSED — the Android per-page ad count
  IS reset on navigation.** `MainActivity.kt`'s `onPageStarted` calls `resetPageBlocked(id)`,
  the Android mirror of `adblock::reset_page`, so the count covers one page load instead of
  the tab's whole lifetime. `nav.rs:556` is the DESKTOP caller; the Kotlin→Rust call that
  this paragraph called a hard stop was never needed.
