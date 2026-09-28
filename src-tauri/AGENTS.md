# src-tauri/ — Rust core + native platform code

The Tauri 2 backend: window/webview management, the IPC dispatcher, data
persistence (JSON stores), the multi-platform ad-block + malware engines, and
native code for Linux (GTK/WebKit), Windows (WebView2 COM), and Android (JNI/Kotlin).

Crate: binary `app` (`src/main.rs` → `app_lib::run()`); library `app_lib` (`src/lib.rs`).

## Layout

```
src-tauri/
├── src/                # Rust source (modules below)
├── capabilities/       # Tauri permission grants (default.json)
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
  (`to_persisted`/`restore`). 56 unit tests.
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
  gate, `forget_closed_tab` (16 tests).
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
  then suppresses. **A failed `spawn_tab` rolls the tab back**
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
  **ONE scheme policy: `is_navigable` (http/https/`about:blank`).** `decide_navigation` now
  consults it as its FIRST check, before the overlay, malware, ad-block and HTTPS-Only
  checks — every one of which reads the destination as an ordinary web address. It
  previously ended in `return true` with no scheme test at all, so a page-initiated
  `location = 'file:///…'` was not refused by the navigation policy, which is what made
  the `tabs::on_tab_url` hole below reachable. `require_navigable`/`parse_navigable` are
  the fallible spellings (they name the refused scheme for the error toast) and the ONLY
  list — a second list is how `file:` reached `tabs.json` in the first place. Callers:
  `decide_navigation`, `tabs::on_tab_url`, the `tabs.recordNav` arm,
  `open_redirect_background`, `nav.home`, `tabs.create` and `safety.proceed`.
  **`nav.reloadOrStop` actually stops.** The toolbar renders an X with `aria-label="Stop"`
  when `state.isLoading`, and the core used to `reload()` unconditionally. `TABS_LOADING`
  (a `OnceLock<Mutex<HashSet<u32>>>` fed by `note_tab_loading` from `on_page_load` right
  after `emit_state`) is the only place loading state exists — the core produced it and
  discarded it. **wry 0.55.1, tauri 2.11.3 and tauri-runtime-wry 2.11.3 expose no `stop()`
  and no `is_loading()` at all** (grepped all three), so the stop is
  `navigate(about:blank)`, which cancels an in-flight load on all three engines and is
  already the app's blank-page target. `reload_or_stop<R: Runtime>` is generic over the
  runtime so a test can reach the branch with no content webview, and the **state half runs
  before the webview lookup on purpose** — `w.navigate` can fail, and waiting for a
  `Finished` load edge that will never arrive would leave a tab stuck "loading" forever.
  The `navigate` call itself is compile-verified only (no webview on the mock).
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
- **`data.rs`** — `data.export` / `data.import` (bundles all stores + settings).
  **Unit-tested via `test_support::with_tmp_app`:** export produces a v2 bundle
  with every store present; cross-app import round-trip (export → fresh app →
  import) restores favorites, saved, history, downloads, allowlist, settings, and
  customFilters; error cases (garbage input, partial bundle) (4 tests).
- **Data stores** — `jsonstore.rs` (tiny JSON-array helper, unit-tested via
  `test_support::with_tmp_app` in `test_support::tests`) backs:
  - `places.rs` (favorites + saved) — **unit-tested via `test_support::with_tmp_app`:**
    add/list/remove/update/reorder for favorites; add/dedup/remove/tag/union for
    saved (6 tests).
  - `history.rs` — **unit-tested via `test_support::with_tmp_app`:** record
    dedup, scheme filter, private-tab skip, list order + pagination, search,
    remove + clear, update_title, unknown-channel dispatch, and the Android
    `record_page_finished` path (12 tests).
    **Visits are recorded by the PLATFORM, not by the chrome** — see the Android
    history gotcha below before touching either side.
  - `downloads.rs` — **unit-tested via `test_support::with_tmp_app`:** private-tab
    skip, `on_requested` filename derivation + state, `on_finished` complete/
    interrupted, `remove` tombstone, `clear` keeps in-progress (6 tests).
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
    `abuse-tlds` is baked-only (no upstream URL). **Unit-tested via `test_support::with_tmp_app`:** `list_id_from_url`,
    `hash_text`, `url_of`, scheme rejection, add/list/remove, `set_enabled`, `enabled_text`,
    `ensure_default_rows` (seed/idempotent/tombstone-respecting/builtin-survives-toggle)
    (11 tests).
  - `customfilters.rs`, `settings.rs`.
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
    `getState` returns the active tab's `pageBlocked` so the chrome recovers the
    count on mount/tab-switch (live events emitted before the chrome subscribed —
    e.g. the restored boot page — are otherwise lost). Counting is wired on **all three
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
    `note_blocked` session/page counters, per-tab page count + reset, plus the pure
    `host_covered` scope table and the engine's subdomain veto (10 tests).
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
      test for it can run on a Linux host.
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
    desktop `compose` and by Android's `NativeInject.documentStartScript(host)` JNI getter
    alike. `block` = **enabled AND not allowlisted** — the two independent ways a user says
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
    `ICoreWebView2` via unsafe COM for full network interception.
- **Find-in-page** (`find.rs` + `find_{linux,win,mac}.rs`):
  - `find.rs` — dispatcher (PLACE 2 of the IPC three-place rule): matches the four
    `find.*` channels, resolves the target tab id (defaults to active), and routes to the
    per-platform module. Exports `emit_state(app, view_id, query, match_count, active)`
    — the single place that calls `crate::emit_event(app, "find.state", …)` so the
    `find.state` event always goes through the `.`→`:` rewrite. Also exports
    `is_find_channel(channel) -> bool` for unit tests.
    **Every `find.state` emit must carry the LIVE query.** `useFind`'s `onState` does a
    whole-state `setState(s)`, so `query` is a REPLACED field: emitting `""` does not mean
    "no query to report", it means "clear the text the user is typing". Hence
    `FIND_QUERIES` (`note_query` / `live_query` / `forget_query`, `#[cfg(any(windows, test))]`)
    — a per-tab store, and `find_win`'s only way to recover the term, because
    `ICoreWebView2Find` is ONE-WAY (`Stop`/`FindNext`/`MatchCount`/`ActiveMatchIndex` but
    **no term getter**). It lives in `find.rs`, not in the windows-only module, so a
    Linux/macOS CI runner can actually test it; `find_linux` reads `search_text()` off the
    WebKit controller and `find_mac` keeps its own owned query, so neither needs it.
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
    re-injects it idempotently (`if (window.__aegisFind) return`) so it survives
    in-tab navigation. `next`/`prev` reuse the last query + case-sensitivity, stored
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
  * `zoom.rs` — dispatcher (`zoom.*` IPC channels: `zoom.get` / `zoom.set` / `zoom.reset`),
    in-memory per-tab `ZoomStore` (`Mutex<HashMap<u32, f64>>`), `clamp(f)` (pure, unit-tested),
    `factor_of`, `apply_to_tab` (replays at spawn), and `apply_native` (per-platform fan-out).
    The `put` helper stores + applies + emits `zoom.changed`.
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
  `test_support::with_tmp_app`:** list/remove/clear, `origin_of` strip (4
  tests).
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
    iframe comparison); hence default-off + per-site escape hatch. On WebKit (Linux/macOS) the
    Chrome-148 UA already lies about the engine — engine-quirk detection defeats any shim.
    Seeding is per-frame-origin (weaker than Brave's per-top-eTLD+1 — a cross-origin iframe
    can't read `window.top.origin`). `strict`/WebGL is highest-risk and opt-in-within-opt-in.
    This is NOT engine-level farbling and the docs never claim parity with Brave's in-Blink tier.
  - **Runtime verify** — vitest `farbleShim.test.ts` (authoritative for shim behavior; passes).
    Live farble-a-real-page, Android device, Win/macOS GUI **PENDING** user.
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
  **HONEST GAP: `lib/protectionSummary.ts` was NOT updated**, so the shield badge can
  still report "WebRTC: public-only" for a host whose protection is actually off — a
  second control-that-lies instance, left as a follow-up rather than smuggled in here.
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
  - **The vault DOES sync**, but only under three conditions that must all hold — see
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
    brick the vault.** - **Integrity.** `vault::merge_remote` authenticates every incoming record with
    `open_record(&vk, r)` BEFORE it is allowed anywhere near the file. Failures are
    counted as quarantined, never written, and reported via the **`sync.vaultQuarantined`**
    event (`{count, uuids}`) — an _event_, not a sync error, because a rejected forgery
    is a security outcome and must not fail the namespaces that did merge. So a peer
    holding the recovery phrase but NOT the master password cannot derive the vault key
    (it lacks the Argon2id output) and cannot forge an authenticating record. - **Consent.** A separate persisted `syncVault` setting, **default `false`**, gates
    the whole thing — configuring a server must never silently start uploading
    credentials. `VaultState.syncEnabled` is `settings.syncVault && sync enabled &&
vault unlocked && adopted`; `adoptionNote?` appears only on the `vault.unlock`
    response when adoption was refused (e.g. undecryptable records block the re-seal),
    and the unlock itself still succeeds. - **Two seal layers, both required.** The wire record is sealed under the SYNC ROOT
    (`seal_wire(data_key(root,"pwvault"), "pwvault", rec)`), wrapping a record layer
    `{uuid,updatedAt,nonce,ct}` sealed under the VAULT key. Vault records carry
    `updatedAt` (i64 ms) rather than a real HLC, so the push side synthesises a stable
    `{"wall_ms":updatedAt,"counter":0,"node":"vault"}` into the transport's cleartext
    `hlc` AAD field, derived from the record's own timestamp so re-pushing an unchanged
    record reuses the same AAD instead of forking a new version. - **A locked vault does not sync at all** — it is neither uploaded nor merged, because
    you cannot merge records you cannot decrypt.
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
    update/remove persistence + reload, dispatch wrong-password, search. (~15 tests in
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
    managed at boot; seeded from `settings::proxy_config`; persisted into settings key
    `"proxy"` via `settings.set`. `proxy.state` event emitted on every config change.
  - Unit-tested in `proxy::tests`: `from_value` parse/validate, `default_uri` schemes,
    `is_active` guard, `test_connection` socket probe, serde `bypassHosts` round-trip
    (the canonical key lesson — see gotcha 21 below).
- **Misc** — `picker.rs` (element picker, **desktop-only**: Linux/Windows/macOS each inject
  the overlay natively; Android has no tier and `picker.start` answers `{ok:false}`),
  `update.rs` (tauri-plugin-updater state).

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
`content-blocking`), `tauri-plugin-updater`, `tauri-plugin-dialog`,
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
registers all 11 managed states that the real `lib.rs` builder + `setup()` install:

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
| `tabs::Tabs` (single-tab Registry, home `"about:blank"`)     | `setup()`          |
| `linux_layout::LayoutInsets` (`#[cfg(target_os = "linux")]`) | `setup()`          |

The mock never spawns real webviews, so dispatchers that call `spawn_tab` or
touch native webview handles skip or no-op silently in tests — that is expected
behavior (these are unit tests against a mock app, not GUI/runtime tests).

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

### Measured, 2026-09-28 (Linux, `cargo llvm-cov --lib --json`, stable 1.98.0)

**The committed floor, taken with NO keyring** (see the floor rule below — these are the
numbers in `src-tauri/coverage-baseline.json`, and a machine with a working keyring measures
strictly higher):

| Metric               | Measured (floor)     | Gap  |
| -------------------- | -------------------- | ---- |
| lines                | 13245/16954 = 78.12% | 3709 |
| statements (regions) | 23422/29928 = 78.26% | 6506 |
| functions            | 1618/2185 = 74.05%   | 567  |

The report holds 44 files. **7 of them are `cfg`-gated out of the build on
Linux** (`adblock_win`, `find_win`, `nav_policy_win`, `nav_url_win`, `nav_url_mac`,
`zoom_win`, `zoom_mac`), so 37 compile here, and a 38th — `linux_layout.rs` —
compiles but is excluded as unexecutable in a headless session. **36 files are
in the gate.** Before the exclusion list the no-keyring run reads 75.44% lines /
75.57% regions / 71.50% functions — the difference is entirely
`linux_layout.rs`. With a keyring those figures are ~1pp higher, which is exactly
why the floor is the committed number.

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

The gap is not spread evenly. Real, measurable debt concentrates in the modules
that wrap an `AppHandle`, a real webview, or the network — exactly the code a
`MockRuntime` cannot reach: `lib.rs` 16.46% (the `ipc()` dispatcher and `setup`),
`zoom.rs` 18.57%, `find_linux.rs` 20.79% (AT-SPI over a session bus),
`adblock_webkit.rs` 21.32%, `view.rs` 24.76%, `nav.rs` 32.4%, `update.rs` 45.74%,
`permissions.rs` 47.17%, `sync.rs` 52.9%, `tabs.rs` 54.63%, `redirect_guard.rs`
79.32%. The pure, already-covered end is `sync_envelope.rs` 98.82%, `tab_registry.rs`
98.05%, `data.rs` 97.75%, `customfilters.rs` 97.38%, `crypto.rs` 97.27%,
`jsonstore.rs` 96.73%, `places.rs` 96.55%.

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

That reproduces CI **exactly** — measured `sync.rs` 703, `sync_keystore.rs` 228,
13245 total lines, 1618 functions, every one identical to what run 36440444084
reported. Four `SKIP keychain tests` lines appear and all 517 tests still pass,
because the keychain tests early-return rather than fail. `dbus-run-session -- env
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
`NativeHistory.kt` (JNI into the Rust `libapp_lib.so`).
`AndroidManifest.xml` grants only `INTERNET`.

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

- The content area is inset by the chrome heights: `topMargin = 72dp`
  (`MOBILE_ADDRESS_H` 48 + `MOBILE_FAV_H` 24) + status inset, `bottomMargin = 56dp`
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
14. **Linux OWNS the `decide-policy` signal for the redirect guard.** wry connects its own
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
    platform-native: desktop auto-opens a background tab; **Android shows a Material
    `Snackbar`** (a chrome-layer bar can't paint over the native content WebView) with
    the same "Open anyway" → new-tab action (`MainActivity.showRedirectBlocked`).
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
        `wv.clearCache(true)` + `wv.clearHistory()` are called. **Honest limit:** Android's
        `CookieManager` / `WebStorage` are process-global — there is no per-WebView cookie
        partition in the released Android WebView API. First-party cookies set by a private tab
        LINGER in the shared cookie jar after the tab is closed. The app deliberately does NOT
        flush the global cookie jar on close (that would log the user out of normal-tab sites).
        This limit is documented in `MainActivity.kt` and is the accepted Android weakest tier.

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

21. **Proxy `bypassHosts` canonical-key lesson.** The `ProxyConfig` struct uses
    `#[serde(rename = "bypassHosts")]` so that `serde_json::to_value` writes
    `"bypassHosts"` (matching `settings.json`, `state_json`, and the TS
    `ProxyConfig` interface) and `from_value` reads the same key back. Without
    the rename, serde writes `"bypass_hosts"` but `from_value` expects
    `"bypassHosts"` — a four-way key mismatch (struct field / serde output /
    settings store / TypeScript) that silently drops all bypass hosts on every
    restart. The fix: one canonical `"bypassHosts"` string used everywhere;
    enforced by the `serde_roundtrip_preserves_bypass_hosts` unit test.

22. **Proxy: four very different apply mechanisms per platform.** Adding a
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

23. **Windows: content webviews need their OWN user-data-folder, keyed on their
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

24. **A visit is recorded by the PLATFORM that owns the page load — and on Android
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
    never as a cleanup.** (Generalised, with a full audit method, in gotcha 25 — which
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
          `https://example.com` produced `onPageFinished -> recordVisit -> app=SET

    is_private=false should_record=true -> store len=1`, and the mobile History sheet
    rendered "1 visit / Example Domain / example.com / just now". Only the JNI seam
    needed proving; the hook itself was always correct.

e. **Size the webviews via `size_allocate`, NOT `set_size_request` — or the window
can't shrink.** In a `GtkFixed`, `set_size_request(w, h)` sets each child's
_minimum_ size, which GTK propagates up as the **window's** minimum — so sizing
the chrome/content webviews to the window size pins the window's minimum to its
current size: it can grow but never shrink ("can't make the window smaller").
Fix: the webviews carry a `(0,0)` size request (no pin) and are sized via
`size_allocate` from `size_fixed_children`, connected `after=true` on the
canonical `GtkFixed`'s "size-allocate" so it runs _after_ GtkFixed clobbers
children to their 0×0 request (it reads each child's current x,y + the live Fixed
allocation, and never calls `move_`/`queue_resize`, so it can't loop). The
effective insets are published by `layout()` into managed `LayoutInsets`. A sane
floor is set via Tauri `set_min_size` (now effective — only because the webviews
no longer pin the minimum). Live-verified: the window resizes to 600×400 and
clamps at the 420×320 minimum.

25. **Most `#[allow(dead_code)]` in this crate hide LIVE code, not dead code — audit by
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

    **The inventory, and what each shape means.** 73 real attributes (plus the one prose
    mention): **54 `cfg_attr`-gated** + **19 unconditional**. Among the 19, **5 are
    module-level** `#![allow(dead_code)]` and 14 are per-item. A grep count will say 74 —
    that is the `proxy.rs` sentence. They are not interchangeable, and each class has a
    different verdict:

    | Class                | What the allow is hiding                                    | Verdict                                    |
    | -------------------- | ----------------------------------------------------------- | ------------------------------------------ |
    | live-but-untraceable | reached only via a literal-matched `ipc()`/`dispatch()` arm | necessary, and the large majority          |
    | test-only            | the only caller is `#[cfg(test)]`                           | necessary; the item is not production-live |
    | platform tiering     | live on a _different_ target                                | necessary; nearly all are honest           |
    | **truly dead**       | no caller and no test, on **any** target                    | **the allow is the bug**                   |
    | **parity gap**       | dead precisely where the feature is exposed                 | **the allow is the bug**                   |

    The two conventions in use, so a new one matches something:

    - **Per-item `#[cfg_attr(<plat>, allow(dead_code))]`** — 52, concentrated in
      `redirect_guard.rs` (22) and `nav.rs` (6), then `adblock.rs` 5, `downloads.rs` 4,
      `tabs.rs` 3, `adblock_inject.rs`/`safety.rs` 2, and 1 each in `adblock_engine`,
      `farble`, `find`, `history`, `lib`, `settings`, `tab_registry`, `zoom`.
      By platform: 42 name `android`, 11 `windows`, 3 `macos` (some name two, via `any(..)`).
      **Prefer this shape** — it keeps the lint on for every other platform, so the
      exemption is visible at the item.
    - **Module-level `#![allow(dead_code)]`** — 5 blanket: `adblock_convert`, `adblock_lists`,
      `adblock_webkit`, `sync_stores`, `sync_vault`. Two modules instead scope the blanket to
      a platform: `picker.rs` (`#![cfg_attr(target_os = "android", …)]`) and
      `redirect_guard.rs` (`… "macos"`, per the no-macOS-redirect-tier note in gotcha 14).
      Those two are the module-level half of the 54; the other 19 are 5 blanket + 14
      per-item unconditional.

    **Structural finding: a blanket module allow is usually a missing `#[cfg]` on the `mod`
    declaration.** `adblock_convert` and `adblock_webkit` are declared **unconditionally** in
    `lib.rs` (lines 13 and 61) but are Linux-only in practice — `to_content_blocker_chunks` is
    called from exactly one arm, `lib.rs:306`, under `#[cfg(target_os = "linux")]`. That
    unconditional compilation is _why_ the module needs a blanket allow, and the blanket is
    what hides it. `sync_stores`/`sync_vault` are also un-gated but genuinely span platforms,
    so for those two the blanket is the honest choice. (`adblock_lists` is a data module.)

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

    **One masked parity gap, and it is narrow.** `settings::https_only` is android-dead, and
    Android does not honour the setting: `MainActivity.secureUrl()` **hardcodes** the
    http→https upgrade (its own comment says it "matches the desktop default-on") and never
    reads the setting, while the only reader of the setting is a `#[cfg(desktop)]` arm in
    `nav.rs`. No user-visible bug _today_ — the mobile UI only ever writes `httpsOnly: true`
    and the only toggle is desktop-only — but settings **sync** propagates the key, so a user
    who turns `httpsOnly` off on desktop and syncs to a phone gets the upgrade anyway. The
    android allow is what makes this read as deliberate tiering instead of a gap.

    **Four hypotheses the audit raised and DISPROVED — recorded so they are not
    re-investigated.** Each looked exactly like gotcha 24's Android history bug (a Rust path
    that is a no-op on that platform), and each is fine:

    - **Find-in-page on Android is NOT broken.** `find::start/next/prev/close` have bodies only
      for linux/windows/macos, so on Android `find::dispatch` really is a silent no-op. But
      Kotlin implements find natively (`@JavascriptInterface find/findNext/findPrev/findClose`
      → `WebView.findAllAsync`/`findNext`), and the renderer's `aegis.find.*` routes to
      `androidBridge()` **first**, falling back to Tauri IPC. `find::emit_state`'s android allow
      is honest.
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

## Gotcha 26 — a privacy setting the platform IGNORES, and a counter that counts the wrong thing

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
  verified from Linux. (b) `navigator.plugins` seeded from `location.origin` **does not
  exist in this codebase** — neither string appears anywhere in `farble.rs`. (c)
  `hardwareConcurrency` IS a deliberate deterministic clamp to `{2,4,8}` in the JS artifacts
  (`src/farble.standard.js`, `src/farble.strict.js`), not noise; the genuine tell is that
  every OTHER perturbation is jittered per session while this one is byte-identical, which
  identifies the shim — but varying it changes behaviour, so it is the owner's call, not a
  silent fix. (d) **On Android the per-page ad count is never reset on navigation:**
  `adblock::reset_page` has exactly one caller, `nav.rs:556` on the desktop path, so
  Android's count accumulates for the tab's whole lifetime and is mislabelled "here" since
  the relabel above. The fix is a Kotlin→Rust call on top-frame navigation; this project has
  **no Kotlin test source set**, so a change there could not be proven with a failing test,
  which is a hard stop under the project's own rules.
