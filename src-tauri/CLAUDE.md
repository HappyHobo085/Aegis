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
  (`to_persisted`/`restore`). 24 unit tests.
- **`tabs.rs`** — Tauri layer over the registry: `tabs.*` IPC dispatch, applies
  spawn/close decisions to child webviews, the idle-sweep background thread
  (`start_idle_sweep`), `tabs.json` session persistence, `open_background`
  (called from `on_new_window` to open target=\_blank links as background tabs —
  but `on_new_window` first drops the request if the ad-block engine flags the
  destination as an ad pop-under; see Ad-block below). **Unit-tested via
  `test_support::with_tmp_app`:** session round-trip, private-tab exclusion,
  title/pinned persistence, reorder, idempotent persist, `managed_registry`
  well-formedness, `is_private` (10 tests).
- **`nav.rs`** — content webview creation (`spawn_tab(id, url)`, replaces the
  old `spawn_content`), navigation callbacks (malware guard, HTTPS-Only upgrade,
  **ad-block: `on_navigation` cancels loads of blocked ad/tracker destinations** via
  `should_block` — catches pop-under redirect chains whose final ad domain `on_new_window`
  never saw, and ad iframes, on every desktop; Android does the equivalent in
  `shouldInterceptRequest`), emits `nav.state`/`nav.failed`. Active webview now accessed via
  `active_content_label()`/`active_webview()` (refactored from the old single
  `CONTENT_LABEL` constant).
- **`view.rs`** — content webview geometry: insets, sidebar, fullscreen, overlay.
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
    remove + clear, unknown-channel dispatch (6 tests).
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
    Also owns the **shield-badge counters**: `note_blocked`/`reset_page` keep a
    monotonic session total + per-tab page count and emit `adblock.blockedCount`;
    `getState` returns the active tab's `pageBlocked` so the chrome recovers the
    count on mount/tab-switch (live events emitted before the chrome subscribed —
    e.g. the restored boot page — are otherwise lost). Counting is wired on **all three
    tiers**: Linux (`linux_layout::connect_block_counter` / `resource-load-started`),
    Windows (the `adblock_win.rs` `WebResourceRequested` network tier → `note_blocked`),
    and Android (Kotlin `shouldInterceptRequest` ad-block branch → `__aegisBlockedCount`).
    Each tier's count reflects only what its own ad-block layer sees — Linux under-counts
    content-filter-blocked ads (cancelled before the signal fires); see gotcha 6.
    **Unit-tested via `test_support::with_tmp_app`:** default state, `set_enabled`,
    `toggle_allowlist` + subdomain coverage + persist, `clear_allowlist`,
    `note_blocked` session/page counters, per-tab page count + reset (8 tests).
  - `adblock_engine.rs` — Brave `adblock::Engine`. **`Engine` is `!Send`**, so it
    lives on one dedicated thread (OnceLock); queries cross via mpsc. Android JNI
    entry `should_block(...)`. Compiled on **all desktop + Android** (not just
    Win/Android): every desktop calls `should_block` from `nav::on_new_window` to
    **drop ad/tracker pop-unders** (`window.open`/`target=_blank` to an ad domain)
    instead of opening them as tabs; warmed off-thread at boot (`lib.rs`) so the
    first check doesn't parse the lists on the UI thread. Loads every
    `adblock_lists::ALL` list into the `FilterSet`. Android does the same in
    `MainActivity.onCreateWindow` via `NativeAdblock.shouldBlock`.
  - `adblock_webkit.rs` (Linux) — declarative WebKit content filters via
    `adblock_convert.rs` (Brave → Safari content-blocker JSON), chunked ~25k
    rules/filter (WebKit caps ~50k), disk-cached by hash. **Filters are per-webview
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
    **Anti-fingerprinting (farbling) — Task 6:** `script(app, host_allowlisted, host)` now
    also appends `farble::shim_for(level, fp_allowlisted)` after the popup guard (and after
    the non-Linux ad-block body) via `compose(webrtc, farble)`. The farble shim uses the
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
  - `find_mac.rs` — **`WKWebView::findString:withConfiguration:completionHandler:`**
    (objc2-web-kit, features `WKFindConfiguration` + `WKFindResult`). **Degraded:**
    `WKFindResult` exposes only `matchFound` (bool) — no match count, no highlight-all,
    no active index. The FindBar shows "1 match" when something is found and "0 matches"
    otherwise; real count + highlight-all would require a JS-shim tier (recorded
    follow-up). `next`/`prev` re-issue `findString:` with `backwards` toggled; the last
    query is stored per tab in `LAST_QUERY` (`OnceLock<Mutex<HashMap<u32, String>>>`).
    macOS objc2 code cannot be compiled from Linux — **CI-only verify** (macos-latest).
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
  records exception, `remove_exception`, list decisions (5 tests).
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
  passphrase-wrapped file is the fallback; remaining work = StrongBox preference, sub-project J). All record crypto is `crypto.rs`:
  **XChaCha20-Poly1305** seal/open (24-byte nonce), **HKDF-SHA256** per-namespace keys,
  **Argon2id** passphrase KDF, `zeroize`-on-drop. A self-hosted reference server is the
  standalone `sync-server/` crate. `sync.*` data channels flow on Android for free
  (they ride the normal `ipc` chokepoint, not the `AegisAndroid` nav bridge).
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
    `seed_from_disk` pre-warms it at boot. Desktop only in v1 — the Android JNI getter has
    no `AppHandle`, so `host_allowlisted` is always `false` on Android (parity gap, documented).
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
  Baked into the injection by `adblock_inject::script(app, host_allowlisted)`; the
  per-site escape hatch reuses the ad-block allowlist (`adblock::host_allowlisted`). Native
  backstops: Linux `set_enable_webrtc(false)` for `disable` only (`linux_layout`); Windows
  `--force-webrtc-ip-handling-policy` via `additional_browser_args` (which **replaces**
  wry's defaults, so it re-includes both `--disable-features=…` and
  `--autoplay-policy=no-user-gesture-required`). Android: the policy lives in a global
  (`note_policy`, seeded at boot + on `settings.set`), read by the `NativeWebrtc.shimScript`
  JNI getter and registered per-tab. **Residual matrix (honest):** the shim covers page +
  iframe frames but NOT Web Worker scopes. `disable` is worker-tight on Linux/Windows
  (native), shim-only (workers leak) on macOS/Android. `public-only` is native (worker-tight)
  on Windows, shim-only on Linux/macOS/Android. Per-site hatch is desktop-only in v1.
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
  - **No page bridge:** the `vault.state` event carries only `{exists, unlocked, count}`
    — no credential data. Plaintext credentials live only in `Inner.records` (in-process,
    while unlocked) and transiently in the serde_json `Zeroizing` buffer during seal/open.
    The content webview has no vault path: no `vault` reference in `adblock_inject.rs`,
    `nav.rs`, `webrtc_shim.rs`, or `MainActivity.kt` (grep-verified).
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
- **Misc** — `picker.rs` (element picker), `update.rs` (tauri-plugin-updater state).

## Dev-only autopilot commands (`src-tauri/src/autopilot.rs`)

The entire module is guarded by `#![cfg(debug_assertions)]`, so it compiles only in
debug builds and is **completely absent from release binaries**.

Four `#[tauri::command]` functions are registered:

| Command                  | What it does                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autopilot_screenshot`   | Calls `spectacle -b -n -a -o <dir>/shots/<name>.png` (best-effort; Linux/KDE).                                                                      |
| `autopilot_write_report` | Writes `report.json` + `report.html` to `$AEGIS_AUTOPILOT_OUT` (or a temp dir).                                                                     |
| `autopilot_done`         | Writes `done.sentinel` to the output dir — the launcher's watchdog polls for this.                                                                  |
| `autopilot_emit_event`   | Re-uses the production `emit_event()` (`.`→`:` rewrite) to synthesize events the live runner needs (e.g. `nav.failed`, `safety.interstitialShown`). |

**These commands are NOT in the `ipc()` dispatcher and NOT in `shared/types.ts`
`IPC` const.** They are a private side channel: the renderer calls them directly by
name via `devEmit.ts`, bypassing the single `ipc` chokepoint on purpose (they have no
production caller). Do not add them to the dispatcher.

`lib.rs` registers them through a cfg-split `invoke_handler`:

```rust
#[cfg(debug_assertions)]
let builder = builder.invoke_handler(tauri::generate_handler![
    ipc,
    autopilot::autopilot_screenshot,
    autopilot::autopilot_write_report,
    autopilot::autopilot_done,
    autopilot::autopilot_emit_event
]);
#[cfg(not(debug_assertions))]
let builder = builder.invoke_handler(tauri::generate_handler![ipc]);
```

`$AEGIS_AUTOPILOT_OUT` points to the timestamped `target/autopilot/<ts>/` dir created
by the launcher (`run-autopilot.sh`); in tests it defaults to a temp dir.

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

## Android (`gen/android/`)

Hand-written Kotlin under `app/src/main/java/com/aegis/browser/`:
`MainActivity.kt` (native content WebView; `shouldInterceptRequest` → ad-block +
malware; `window.AegisAndroid` JS bridge), `NativeAdblock.kt` + `NativeSafety.kt`
(JNI into the Rust `libapp_lib.so`). `AndroidManifest.xml` grants only `INTERNET`.

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
- **Safe-area insets:** `env(safe-area-inset-*)` in an Android WebView reports the
  display cutout, NOT the system bars, so the insets listener pushes the real status/nav
  insets to the chrome as `--aegis-inset-top/bottom` CSS vars (px ÷ density).
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
    downloads/new-windows keep WebKit's default handling. A block emits `redirect.blocked` →
    the chrome's `RedirectBar` (a notification bar that adds `REDIRECT_BAR_H` to the content
    inset; a floating toast can't paint over the opaque content webview). **That inset RESIZES the
    content, and a malicious page re-fires the blocked redirect on a TIMER + on that very resize —
    so `App.tsx` makes dismissal STICKY per destination (`dismissedRedirectsRef`, reset on tab
    switch); without it the bar is unclosable (re-blocked → re-shown forever).** Other platforms keep
    Tauri's `on_navigation` + their own native top-frame hooks (Windows `NavigationStarting`,
    macOS `WKNavigationDelegate`, Android `shouldOverrideUrlLoading`). The block notification is
    platform-native: desktop shows the `RedirectBar` infobar; **Android shows a Material
    `Snackbar`** (a chrome-layer bar can't paint over the native content WebView either) with
    the same "Open anyway" → new-tab action (`MainActivity.showRedirectBlocked`).

15. **Local Windows builds need NASM + CMake** (for `aws-lc-sys`, rustls' crypto C
    backend). The MSVC "Desktop development with C++" workload bundles CMake; install
    NASM separately (nasm.us) and add it to PATH. CI's `windows-latest` ships both, so
    this only bites local builds. Same-machine aside: behind a network that blocks the
    CA revocation endpoints (OCSP/CRL), cargo's schannel TLS fails every crates.io
    fetch with `CRYPT_E_NO_REVOCATION_CHECK` — set `http.check-revoke = false` in
    `~/.cargo/config.toml`.

16. **Windows child webviews need PHYSICAL bounds at fractional DPI.** wry's `add_child`
    / `set_bounds` called with `LogicalPosition`/`LogicalSize` mispositions the WebView2
    controller's INPUT/hit-test region at non-100% scaling (e.g. 125%): the content
    webview _renders_ below the chrome bars but _captures their clicks_, so the toolbar
    and favourites bar go dead (the tab strip, above the misplaced region, still works —
    that's the "can't add a tab / favourites don't click" symptom). `nav::spawn_tab` and
    `view::apply_inset` pass `PhysicalPosition`/`PhysicalSize` on Windows (logical×scale)
    so the controller's hit rect matches the host window. Only bites fractional DPI — 100%
    is unaffected, which is why CI / 100%-DPI testing missed it. (macOS keeps Logical.)

17. **Windows runtime tab creation must spawn the webview OFF the UI thread, and tabs
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

18. **Find-in-page per-platform capability matrix (honest):**
    - **Linux** (WebKitFindController): real match count via `found-text` signal, full
      highlight-all, **no active-index getter** (reports `1` when count > 0 else `0`).
      Live-verify pending user display session; cross-check clean.
    - **Windows** (`ICoreWebView2Find`): real count + real active index + highlight-all.
      **Requires a 2024+ WebView2 Runtime** — `cast::<ICoreWebView2_28>()` fails silently
      on older runtimes (browsing unaffected, find is a no-op). Compile-verified via gnu
      cross-check + CI; GUI runtime-verify pending user's Windows 11 device.
    - **macOS** (`WKWebView::findString:withConfiguration:completionHandler:`):
      **degraded** — `WKFindResult` exposes only `matchFound` (bool); no real count, no
      highlight-all, no active index. FindBar shows "1 match" / "0 matches". JS-shim tier
      for real count + highlight is a recorded follow-up. CI-compile-only; GUI requires a
      macOS desktop session.
    - **Android** (Kotlin `WebView.findAllAsync`): real count + active index (ordinal + 1)
      - highlight-all. **Case-insensitive only** — the `caseSensitive` flag is accepted but
        the Android WebView find API has no case-sensitive mode. Kotlin compile-verified; GUI
        runtime-verify pending device session.

19. **Private tabs use `WebviewBuilder::incognito(true)` on desktop — Android is a
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

20. **Anti-fingerprinting (farbling) hard-won lessons.** Four lessons from sub-project L:

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

    d. **Android has no fp-allowlist in v1 (documented parity gap).** The Android JNI
    getter (`NativeFarble.farbleScript`) has no `AppHandle` and therefore no access to the
    `FarbleState` managed-state; it hardcodes `host_allowlisted = false`. Closing the gap
    requires routing the allowlist to a global (mirroring `ANDROID_LEVEL`) or passing the
    host into `farbleScript(host)` from Kotlin. Tracked as a future improvement; not a
    blocker.

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
      without it. Any macOS proxy work requires a Mac + CI verify only.

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
    the autopilot can't exercise WebView2 env creation. **Fix (`nav::spawn_tab`):** house
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
