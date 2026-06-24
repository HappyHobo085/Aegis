# Aegis Privacy & Sync Roadmap

> Five features, designed and then adversarially feasibility-checked against the real Aegis code and the four engines (WebKitGTK / WebView2 / WKWebView / Android System WebView). This roadmap reflects the _corrected_ reality after critique — where a design claim was wrong or optimistic, the corrected fact is what's written here, not the original.
>
> The one constant: **Aegis is a shell, not an engine fork.** It cannot do what Brave does inside Blink/V8. The honest question per feature is "how close can a JS shim / native webview setting / app-level feature get, and how detectable/weaker is it." Effort scale matches the critics' _revised_ numbers.

> **⚠️ Status note (2026-06-23 — read this first).** Large parts of this roadmap are **already shipped**; the section bodies below are kept as the _design basis_ and now carry an inline **STATUS** line where reality has moved past them. Verified current state (see `docs/superpowers/specs/2026-06-23-improvements-program-design.md` §1.1 for the evidence trail):
>
> | Roadmap item                              | State            | Where it lives in the code                                                                                                                                                                                                                                                                                                                                                                                                                                    |
> | ----------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | **E2E sync (F2b)**                        | ✅ **DONE**      | `src-tauri/src/sync.rs` (pull→merge→push, `GET/POST /v1/records`, background loop), `sync_auth.rs` (Ed25519 signed device tokens), `sync_stores.rs` (per-uuid HLC LWW merge)                                                                                                                                                                                                                                                                                  |
> | **WebRTC IP-leak defense (§3.1)**         | ✅ **DONE**      | `webrtc_shim.rs` + `webrtc_shim.{public-only,disable}.js`; `webrtcPolicy` setting (`shared/types.ts`); native Linux/Windows backstops                                                                                                                                                                                                                                                                                                                         |
> | **S1 atomic store writes**                | ✅ **DONE**      | `jsonstore::write_atomic` (temp→fsync→rename→dir-fsync + `.bak`); `settings.rs`, `customfilters.rs`, `data.rs`, `subs.rs` route through it                                                                                                                                                                                                                                                                                                                    |
> | **S2 shared crypto**                      | ✅ **DONE**      | `crypto.rs`: XChaCha20-Poly1305 + HKDF-SHA256 + Argon2id (via `sync_keystore`) + `zeroize`                                                                                                                                                                                                                                                                                                                                                                    |
> | **S4 Android document-start injection**   | ✅ **DONE**      | `MainActivity.kt` `WebViewCompat.addDocumentStartJavaScript(...)` per tab (ad-block popup guard + WebRTC shim)                                                                                                                                                                                                                                                                                                                                                |
> | **Private / ephemeral mode**              | ✅ **DONE**      | `tab_registry.rs` `private` flag; `nav.rs` `spawn_tab` `.incognito(true)`; `history.rs`/`downloads.rs` skip private tabs; `tabs.rs` `to_persisted` excludes them; Android best-effort tier in `MainActivity.kt` (`privateTabs`, `LOAD_NO_CACHE`, 3rd-party-cookie refusal, close-time flush). Affordance: TabStrip "New private tab" button + Ctrl+Shift+N + mobile switcher. Runtime verify: Linux/Win/macOS GUI + Android device **PENDING** user sessions. |
> | **S3 OS keychain**                        | 🟡 **PARTIAL**   | Desktop `keyring` done (`sync_keystore.rs`); **Android hardware-Keystore JNI path wired + device-verified** (commit `03f0012`; `AegisKeystore.kt` real `KeyGenParameterSpec` AES-GCM wrap; passphrase-wrapped file is the fallback) — remaining sub-project **J** = StrongBox preference                                                                                                                                                                      |
> | **Password vault (§3.4 Phase A)**         | ⬜ **REMAINING** | No `vault.rs` yet — sub-project **K**                                                                                                                                                                                                                                                                                                                                                                                                                         |
> | **Anti-fingerprinting / farbling (§3.2)** | ⬜ **REMAINING** | No `farble.rs` yet — sub-project **L**                                                                                                                                                                                                                                                                                                                                                                                                                        |
> | **Proxy ("VPN" Tier-1, §3.5)**            | ⬜ **REMAINING** | No proxy module yet — sub-project **M**                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 1. TL;DR

Ordered most shell-shaped / highest leverage → least.

| Feature                            | Realistic feasibility in a shell                                                                                              | Effort (revised)                                  | How close to Brave it gets                                                                                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **E2E-encrypted sync**             | **High** — engine-independent app/data work; the shell model is irrelevant here. Only feature that can reach near-parity.     | **XL** (design said L; critic corrected)          | **Near-parity on confidentiality**; weaker on synced-data breadth, ops maturity, and server auth (Brave's per-device signed-token tier was dropped in the design).                                                                         |
| **WebRTC IP-leak defense**         | **Mostly sound** — native toggle on Linux/Windows (below JS), JS shim everywhere else.                                        | **L**                                             | **~70–80% of user-visible result.** Strong & unbypassable only for `disable` on Linux (and only if WebRTC was even on). JS `public-only` is casual-fingerprinter defense only — Worker bypass is a real hole.                              |
| **Anti-fingerprinting (farbling)** | **Partial** — JS shim is the only lever on all 4 engines; detectable and risks being a fingerprint itself.                    | **XL** (design said L; critic corrected)          | **Meaningful but clearly weaker.** Can match the per-eTLD+1/per-session model + canvas/audio/navigator noise; can't match in-engine invisibility, and on WebKit (Linux/macOS) the UA already lies about the engine.                        |
| **Password manager**               | **Vault: full / Autofill: partial.** Vault is engine-independent. Autofill _deliberately pierces_ the no-page→core invariant. | **XL** (vault alone is L; design said L for both) | **Vault ≈ parity** (Argon2id + AEAD + keychain). **Autofill permanently weaker** — heuristic detection, in-page affordance is clickjackable, no renderer-committed origin, and the page→core signal has no clean cross-platform primitive. |
| **VPN**                            | **Least shell-shaped.** A true OS VPN is non-browser, privileged, needs a server fleet. Only Tier-1 _proxy_ is shell-native.  | **L** (design said M; critic corrected)           | **Nowhere near.** A content-webview proxy ≠ Brave's whole-device WireGuard tunnel. Must be labeled "Proxy," not "VPN," and is hollow without the WebRTC fix.                                                                               |

---

## 2. Shared infrastructure to build first

Multiple features depend on the same handful of plumbing pieces. Build these _before_ the features that need them, in this order:

### S1 — Atomic store writes (prerequisite for sync **and** the vault)

> **STATUS: ✅ DONE.** Shipped as `jsonstore::write_atomic` / `write_atomic_no_backup` (temp file → `sync_all` → atomic `rename` → parent-dir fsync, plus a `.bak` recovery copy). All store writers route through it: `settings.rs`, `customfilters.rs`, `data.rs`, `subs.rs`. The "Confirmed bug" text below is the original problem statement, retained for rationale; the line numbers it cites are pre-fix.

**Confirmed bug:** `jsonstore::save` (`jsonstore.rs:34`), `settings::write` (`settings.rs:42`), `customfilters::write` (`customfilters.rs:29`), plus bare writes in `data.rs:42` and `subs.rs` all use `std::fs::write` = truncate-then-write, no fsync, no rename. A crash mid-flush truncates the store to empty.
**Fix:** write to a temp file → fsync file **and** parent dir (Linux ext4/btrfs need both) → atomic `std::fs::rename` (atomic intra-filesystem on all four targets). Small effort, benefits all existing data. **Load-bearing for the vault** (a half-written AEAD blob = total credential loss — also keep a versioned backup-on-write copy since a corrupt AEAD blob is unrecoverable). **Load-bearing for sync** (a crash during merge corrupts a store).
**Effort: S.**

### S2 — Shared crypto + key-derivation layer (sync **and** vault)

> **STATUS: ✅ DONE.** Shipped as `src-tauri/src/crypto.rs`: XChaCha20-Poly1305 seal/open (24-byte random nonce), HKDF-SHA256 per-namespace key derivation, `zeroize` on drop, with Argon2id passphrase wrapping in `sync_keystore.rs`. The crates below (`chacha20poly1305`/`hkdf`/`argon2`/`zeroize`) are in `Cargo.toml`. The vault (sub-project K) will reuse this module unchanged.

Both features need the same RustCrypto stack. Build it once as a small internal crypto module.

- New direct crates (all MIT/Apache, pure-Rust RustCrypto): `chacha20poly1305` (XChaCha20-Poly1305, 24-byte random nonce — the design's nonce-reuse reasoning is sound), `hkdf` (sync key derivation), `argon2` (Argon2id — vault master-password KDF; sync's optional passphrase mode), `zeroize` (wipe DEK/seed on lock).
- **Already in `Cargo.lock`, no new top-level tree:** `sha2 0.10.9`, `getrandom`, `rand`, `rand_core`, `uuid 1.23.3`. (The sync design's "adds almost nothing" framing under-states the four genuinely-new crates above; it also _missed_ that `uuid` is already present, so record-identity needs no new dep.)
- **Supply-chain note:** the repo's npm-audit / Dependabot CI gates cover **JS only**. This new cargo crypto surface (and `keyring`'s zbus/D-Bus tree on Linux, see S3) is **un-audited by CI** — vet it manually and consider a cargo-audit gate.
  **Effort: S** (assembly, not invention).

### S3 — OS-keychain abstraction (sync seed-at-rest, vault DEK anchoring, proxy/VPN secrets)

> **STATUS: 🟡 PARTIAL.** Desktop is done — `sync_keystore.rs` anchors the sync root in the OS keychain via the `keyring` crate (service `com.aegis.browser`), degrading to a passphrase-wrapped file when no Secret Service / Credential Manager / Keychain is available. **Android hardware-Keystore JNI path is wired + device-verified** (commit `03f0012`; `AegisKeystore.kt` performs a real `KeyGenParameterSpec` AES-GCM wrap called from `sync.rs`; passphrase-wrapped file is the fallback when no keychain is available). **Remaining (sub-project J):** prefer **StrongBox** — a hardening step, not the initial connection.

- `keyring` v4 (confirmed: feature-gated backends for Linux Secret Service / keyutils, Windows Credential Manager, macOS Keychain, Android, iOS — one crate covers the desktop trio's anchor). On Linux it transitively pulls zbus/D-Bus and **needs a running Secret Service daemon at runtime** — must **degrade gracefully to master-password-only** when absent, never crash.
- **Android caveat (corrected):** `keyring`'s Android backend is a _software_ Keystore wrapper, **not** hardware-backed. For the vault, do the hardware-backed/StrongBox wrap in Kotlin via `KeyGenParameterSpec` through the existing JNI bridge (the `NativeAdblock`/`NativeSafety` pattern) — **not** `keyring`, and **not** the deprecated `EncryptedSharedPreferences`.
- Honest stance: this is the **shakiest cross-platform piece**; treat full keychain integration as a follow-up tier and ship master-password-only first.
  **Effort: M** (Android JNI path is the cost).

### S4 — A unified document-start injection framework across all 4 platforms — **including finishing Android**

This is the single biggest piece of shared leverage: WebRTC defense, farbling, and autofill _detection_ all ride document-start injection into the **content** webview.

> **STATUS: ✅ DONE.** The desktop path always existed; the Android content-tab path is now **built** — `MainActivity.kt` calls `WebViewCompat.addDocumentStartJavaScript(wv, documentStartScript, setOf("*"))` per tab (the ad-block popup guard + the WebRTC shim ride it). The Android bullet below saying "must be BUILT — it does not exist" is **superseded** and kept only for the original analysis.

- **Desktop (Linux/Windows/macOS): already exists.** `nav.rs:123` `spawn_tab` calls `.initialization_script_for_all_frames(crate::adblock_inject::script())` (verified API: `tauri 2.11.2 webview/mod.rs:927`, `for_main_frame_only:false`, flows through wry to all engines incl. cross-origin iframes). `adblock_inject::script()` returns `POPUP_GUARD` on Linux and `POPUP_GUARD + build()` on non-Linux (`adblock_inject.rs:53-60`).
- **Refactor required:** `script()` currently returns `&'static str` via a `OnceLock`. WebRTC and farbling need a per-session salt/policy baked in as literals, so the script is no longer a compile-time constant. `script()` (or new `webrtc_inject::script(policy)` / `farble.rs::script(salt, level)`) must return an owned `String` and the `OnceLock` cache reworked. The farbling design half-acknowledged this; it is a non-trivial change to the existing static-return contract.
- **Android: ✅ NOW BUILT (was: "must be BUILT — it does not exist").** `createTabWebView` (`MainActivity.kt:263-283`) builds a plain `WebView`, sets UA/settings/clients, and — as shipped — now ALSO attaches the document-start script via `WebViewCompat.addDocumentStartJavaScript`. (Original analysis follows, retained for context: Content tabs are _not_ `RustWebView` (which has the document-start path at `RustWebView.kt:30-34`) — they are hand-rolled. So **the popup guard, the WebRTC shim, farbling, and autofill detection would all be the first document-start script Android content tabs ever run.** Use `WebViewCompat.addDocumentStartJavaScript(wv, script, setOf("*"))` gated on `WebViewFeature.isFeatureSupported(DOCUMENT_START_SCRIPT)` (the `androidx.webkit:webkit:1.14.0` dep is **already on the classpath** — `build.gradle.kts:83`). Fallback: `evaluateJavascript` in `onPageStarted` (`MainActivity.kt:116-119`), which is **racy** (a fast inline page script can win) and loses sub-frame coverage (per wry's own doc). The salt/script must cross Rust→Kotlin via a new JNI getter or the bridge.)
- **Build the popup guard into Android here too** — it's the same plumbing and is currently missing on Android, so do it once.
  **Effort: M** (the Android path is genuinely new multi-file JNI+Kotlin work).

### S5 — Settings + IPC plumbing (all features)

- New string/object settings ride the **existing** `settings.get`/`settings.set` surface — verified wired in all 3 places (`shared/types.ts` IPC const + `Settings` interface ~line 256; `settings.rs` `defaults()` 14-29 + dispatch ~104-129; `ipcClient.ts:185-187`). `settings.set` shallow-merges arbitrary keys, so a new field needs **no new channel** and **no Rust dispatch change**. `data.rs` export/import already serializes settings.
- Features needing real verbs (sync, vault, vpn) add a new module dispatch arm to the `ipc()` chain (`lib.rs:64-109`, the established `if let Some(result) = module::dispatch(...)` pattern) and new dotted event names via `emit_event` (`lib.rs:54-56`, `.`→`:`; reversed in `tauriInvoke.ts`).
- **Android works for data IPC for free:** `tauriInvoke.ts:12` calls `invoke('ipc',...)` unconditionally; the `AegisAndroid` bridge is only for content-webview nav/tab/fullscreen actions. So `sync.*` / `vault.*` data channels flow identically on Android.
  **Effort: S** (per feature).

**Sequence:** S1 → S2 → S3 → S4 → S5. S1/S2 are quick and unblock everything. S4 (esp. Android) is the long pole shared by three features.

---

## 3. Per-feature plans

### 3.1 WebRTC IP-leak defense

> **STATUS: ✅ DONE.** Shipped as `webrtc_shim.rs` (+ single-sourced `webrtc_shim.public-only.js` / `webrtc_shim.disable.js`) driven by the `webrtcPolicy` setting (`'default' | 'public-only' | 'disable'`, `shared/types.ts`). The shim wraps `RTCPeerConnection` to filter local/private ICE candidates, SDP, and `getStats()`; native backstops are wired (Linux `set_enable_webrtc(false)` for `disable`; Windows `--force-webrtc-ip-handling-policy`); Android registers it per tab via the document-start path (S4). **The Worker-bypass limit below is honored as a documented known gap, not a bug** (see the residual matrix in `src-tauri/CLAUDE.md`). The approach text below matches what shipped.

**Approach per platform (corrected):**

- **Linux — `full`.** Native `WebKitSettings::set_enable_webrtc(false)` for the `disable` policy. **Correction:** it lives on `SettingsExt`, _not_ `WebViewExt`; `linux_layout.rs:11` imports only `WebViewExt`, so add `use webkit2gtk::SettingsExt;`. Reach it via `content.with_webview(|pw| pw.inner().settings()...)` (`settings()` returns `Option<Settings>`), same `with_webview`/`pw.inner()` pattern as `permissions.rs`. **`v2_38` is already on transitively** (wry enables `webkit2gtk/v2_40`, which includes v2*38; cargo unifies) — **no `Cargo.toml` change needed.** **Establish the baseline first:** WebKitGTK often ships `enable-webrtc=false` by default, so on the one hardware-verified platform there may be \_no leak to fix*, making the native path moot there. The native toggle is whole-webview on/off — it **cannot** do `public-only`.
- **Windows — `partial`.** `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` via `additional_browser_args` on the `WebviewBuilder`. **Corrections:** the method is **not** cfg-gated to Windows (it compiles everywhere, no-ops off-Windows) — **drop the `#[cfg(target_os="windows")]` arm**, it's unnecessary. You **must** re-include wry's default `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` (confirmed by Tauri's doc comment). The flag is set at **webview-creation time, immutable after** — runtime policy change requires recreating the webview. Microsoft warns these switches "might be removed or altered at any time" and there's no `ICoreWebView2Settings` WebRTC property (#2078) — so **lean on the JS shim as the dependable layer**, treat the native flag as best-effort. Not GUI-runtime-verified.
- **macOS — `degraded`, JS-shim only.** No developer-exposed WKWebView/WKPreferences WebRTC knob (Apple does mDNS internally for _host_ candidates; the residual public/srflx IP is what the shim must cover). objc2 can't compile from Linux anyway.
- **Android — `degraded`, JS-shim only.** No `WebSettings` WebRTC toggle. **Requires S4's Android injection path.** Confirmed: System WebView leaks local+public IP via ICE with no permission prompt.

**Hook points:** native toggles at `nav.rs` `spawn_tab` `#[cfg(target_os="linux")]` / `#[cfg(windows)]` arms; JS shim prepended to the S4 injected script. The shim wraps `RTCPeerConnection`/`webkitRTCPeerConnection`, filters `icecandidate` events **and** rewrites SDP (`a=candidate:`, `c=`/`o=` host IPs) to strip host/srflx/RFC1918/`.local`, keeping relay/TURN so calls still work.

**Data model / IPC:** `webrtcPolicy: 'default' | 'public-only' | 'disable'` (default `'public-only'`) on `Settings`; default + reader in `settings.rs`. **No new channel** — rides `settings.get/set`. Policy is **baked into the injected script** (no page→core bridge), so a policy change requires a content-webview reload. Defer any "leaks blocked" counter (the page→core direction is deliberately blocked, so a count isn't natively available).

**Key security consideration:** Reduces attack surface; **adds no new trust boundary** — preserves the no-page→core invariant. The shim runs in the page's own JS world: **best-effort, never unbypassable.** SDP-rewrite is the most dangerous part — a missed candidate format **fails open (leaks)**, a too-aggressive rewrite breaks the call. Fuzz it against real offer/answer SDP.

**Critic-flagged limits to honor:**

- **The Worker bypass is the load-bearing hole.** `RTCPeerConnection` is reachable in Worker global scope, and **neither** `initialization_script_for_all_frames` (its flag governs frames, not workers — confirmed) **nor** Android's `addDocumentStartJavaScript` is documented to inject into Worker scopes. A page gathering ICE in a Worker, or reading `pc.localDescription.sdp` directly, defeats `public-only` on the two JS-only platforms. **Scope-test this explicitly before claiming it works; if Workers aren't covered, document it as a known gap.**
- Per-site escape hatch (reuse the adblock allowlist pattern) for sites `public-only`/`disable` breaks.

**Effort: L.** Bulk = the brand-new Android injection path (shared with S4) + a robust fuzzed SDP/candidate filter across four engines with no shared runtime.

**Brave-parity verdict:** ~70–80% of the user-visible result (leak-test shows no local IP; relayed calls still work). Strictly weaker: Brave filters in Blink (below all page JS, non-detectable, non-bypassable); Aegis's main lever on macOS/Android is a same-world JS shim that's detectable (prototype/`toString` probing) and Worker-bypassable. Only Linux `disable` is a genuinely strong guarantee — and only if WebRTC was on to begin with.

---

### 3.2 Anti-fingerprinting (farbling-style)

**Approach per platform:** JS-shim on **all four** engines — no native fingerprint knob exists anywhere. Linux/Windows `full`, macOS `partial`, Android `degraded` (needs S4). One document-start script: per-eTLD+1, per-session seed (`hash(salt, eTLD+1)` → deterministic PRNG) farbling canvas/audio/WebGL/`navigator`/`screen`/fonts/Intl/UA-CH, plus `Function.prototype.toString` patching to report `[native code]`. Salt = a `getrandom` CSPRNG `u64` in a `OnceLock`, generated at boot near `lib.rs:334`, **not persisted** (resets per session, like Brave).

**Hook points:** append the farble block to the S4 script (alongside `POPUP_GUARD` in `adblock_inject::script()` desktop, handed to Kotlin on Android). Must stay consistent with `CONTENT_UA` (Chrome 148 — `nav.rs:62/64/66`).

**Data model / IPC:** `antiFingerprint: 'off' | 'standard' | 'strict'` on `Settings`, **default `'off'`** (opt-in given breakage risk). Rides `settings.get/set`, no new channel. Session salt is core-only state in a new `farble.rs`. Likely needs a per-site allowlist escape hatch (`fingerprint.toggleAllowlist`, mirroring `adblock.rs` dispatch).

**Key security consideration:** No new trust boundary (one-way injected string + numeric salt; content tabs have no `addJavascriptInterface` — verified). **Corrected security claim:** a CSPRNG salt fed through a _non-crypto_ JS hash (fnv/xorshift, as proposed) is **still potentially invertible** — a site could brute-force a 64-bit salt offline from observed farbled values and predict other sites' values. **Do not claim "the salt is not a super-cookie" without a one-way derivation.** Scope patches narrowly to avoid breaking WebAuthn/payment/DRM.

**Critic-flagged limits to honor:**

- **The headline risk: a more-identifying fingerprint than doing nothing.** One hand-written shim must emit self-consistent values on a **WebKit baseline** (Linux/macOS) **and** a **Chromium baseline** (Win/Android), while matching a Chrome-148 UA that is _already a lie on WebKit_. Any mismatch (Chrome UA + WebKit-only quirk + farbled-Chrome-shaped WebGL) creates a unique, stable Aegis signature — amplified by a tiny user population.
- **Cross-origin iframe seeding (corrected):** the all-frames script _does_ run in cross-origin iframes (verified through wry to all engines), but a cross-origin child **cannot read `window.top`'s origin** in JS — so Brave's "seed by top eTLD+1" is **largely unreachable**. Document the actual, weaker **per-frame-origin** behavior; don't present it as a config toggle.
- Web-compat: canvas/audio noise is actively flagged by anti-bot/CAPTCHA vendors and can get users _challenged more, not less_. Default-off + per-site disable.
- UA-CH `navigator.userAgentData` brands must be bumped in lockstep with `CONTENT_UA` or they go stale and become a tell.

**Effort: XL** (corrected from L). Drivers: the `&'static str`→owned-`String` refactor; the entire two-engine-consistent shim (the hard part); the brand-new Android JNI+Kotlin document-start path; `getrandom` direct dep; settings UI + per-site allowlist. The all-platforms-parity rule forbids shipping Linux-only.

**Brave-parity verdict:** Meaningful but clearly weaker. Can match the seed model + canvas/audio/WebGL/navigator/UA-CH surfaces conceptually; can't match in-engine invisibility (Brave's patched fns are genuinely native, survive cross-realm/iframe comparison), can't touch network-layer/font-rasterization/GPU surfaces, and on WebKit can still be outed as not-Chrome. Most defensible win: the navigator/UA-CH consistency cleanup + canvas/audio noise at `standard`, shipped opt-in.

---

### 3.3 End-to-end-encrypted cross-platform sync

> **STATUS: ✅ DONE (this is "F2b").** Shipped as `sync.rs` (per-namespace pull→merge→push over `reqwest::blocking`, `GET/POST /v1/records`, a debounced periodic background pass), `sync_auth.rs` (the **restored auth tier** — short-lived per-device **Ed25519** signed tokens, addressing the "server has no authentication" gap flagged below), and `sync_stores.rs` (per-uuid **HLC last-writer-wins** merge with tombstones). A self-hosted reference server lives in `sync-server/`. The uuid/hlc/tombstone retrofit, per-key settings split, and targeted-refetch described below were all implemented. Local-at-rest still depends on S3 (PARTIAL on Android) as the design notes.

**Approach (all platforms `full`, engine-independent):** Brave-style zero-knowledge sync. 32-byte `getrandom` seed → 24-word BIP39 phrase (root secret) → HKDF-SHA256 per-namespace keys + a non-reversible `accountId = HKDF(seed,"server-account-id")`. Each record `{id(uuid), namespace, hlc, deleted, nonce, ciphertext}` is XChaCha20-Poly1305-sealed with `AAD = namespace||id||hlc`. Pull→merge→push over the existing `reqwest::blocking`-on-a-thread pattern (`subs.rs::fetch_text:44-66`) under the already-installed aws-lc-rs provider (`lib.rs:334`). Conflict resolution = per-record LWW by HLC + tombstones; **settings split into per-key records**; `customFilters` stays whole-blob LWW (surfaced, not hidden). No CRDT.

**Hook points:** new `sync.rs` with `sync::dispatch` added to the `ipc()` chain (`lib.rs:64-109`). Reads/writes go through existing helpers (`jsonstore::load/save` 18/26, `settings::all/write` 32/37, `customfilters::load/write` 17/24). Extend `data.rs` `STORES` (currently `[favorites, saved, history, downloads]`) for the syncable set. **After pulling subs/customFilters/allowlist, refresh the engine.**

**Data model changes (the real work):**

- **Record identity:** the per-store `next_id = max+1` (`jsonstore.rs:38`) collides across devices — add a stable `uuid` (already in `Cargo.lock`, no new dep) to each item on creation, keep the int for in-app ordering.
- **Tombstones + HLC:** **confirmed zero** `uuid`/`hlc`/`deleted`/`tombstone` infrastructure exists today. `favorites.remove`/`saved.remove`/`history.remove`/`subs.remove` all hard-drop via `items.retain(...)`. **Every mutating arm** across `places.rs`/`history.rs`/`subs.rs`/`customfilters.rs`/`settings.rs` must stamp uuid+hlc and write a tombstone on delete. **Miss one delete path and deletions silently don't propagate** — the classic sync bug. This is the bulk of the effort and the highest regression risk against well-tested store behavior.
- **Settings per-key split:** beware the **defaults-resurrection trap** — `settings.rs` `load()` overlays `defaults()`, so a key a user intentionally cleared would be resurrected unless per-key tombstones distinguish "cleared" from "never set."
- **Allowlist (corrected):** it lives in `adblock.rs` state, _not_ a flat jsonstore — syncing it needs a dedicated projection through `sync_engine`, more than "extend STORES."

**New IPC / events:** `sync.getState`, `sync.enableNew` (returns the phrase once), `sync.enableFromPhrase`, `sync.disable`, `sync.syncNow`, `sync.getRecoveryPhrase` (gated — reveals the root secret), `sync.listDevices`/`sync.removeDevice`. Events `sync.state` (mirrors `update.state`) and `sync.changed`. **Correction:** `sync.changed` must drive **targeted refetch**, **not** copy the `ipcClient.ts:241` `window.location.reload()` import trick — a full-UI reload per pulled record is unacceptable UX.

**Key security consideration (corrected):**

- Zero-knowledge confidentiality is genuinely comparable to Brave (server sees only opaque ciphertext + metadata).
- **Un-flagged gap the critic caught:** the design swapped Brave's per-device **Ed25519 signed-token auth** for a bare non-reversible `accountId` → **the server has no authentication.** Confidentiality holds, but anyone who learns an `accountId` can **withhold, roll back, or overwrite** that account's blobs. **Restore an auth tier (signed access tokens)** before claiming "matches Brave closely."
- **Seed-at-rest** widens the blast radius of a single device compromise to all devices. Use the S3 keychain anchor; the honest fallback is parity with today's plaintext stores, documented.
- Exclude the seed/key material from `data.export`.

**Effort: XL** (corrected from L). L is defensible only for the client crypto+protocol slice against a throwaway mock server. Full scope = the 5-module identity/tombstone retrofit + S1 atomic writes + per-key settings + a **real deployable backend** (with an auth tier) + four-platform engine-refresh-after-pull parity + the keychain follow-up.

**Brave-parity verdict:** The **one feature where Aegis can get genuinely close** — it's app/data work, the shell model is a non-issue. Crypto model matches Brave's design. Stays weaker on: **breadth** (Brave syncs engine-coupled state Aegis doesn't possess — per-site Shields, site-engagement, open-tabs), **ops maturity** (Brave runs a hardened global service; Aegis ships a minimal blob store), **server auth** (needs the dropped signing tier restored), and **local-at-rest** (plaintext stores unless keychain-anchored).

---

### 3.4 Password manager (encrypted vault + autofill)

Two phases, very different risk profiles.

**Phase A — vault (full, all platforms, ship first):** New `vault.rs` storing entries as one AEAD ciphertext blob (XChaCha20-Poly1305) via the S1 atomic write path. DEK = master password → Argon2id (OWASP params, per-vault salt) → 32-byte key, held in memory while unlocked, `zeroize`d on lock + idle auto-lock. Optional S3 keychain anchoring (Android = hardware-backed `KeyGenParameterSpec` in Kotlin, **not** the software `keyring` backend). Vault lives entirely chrome-side, never exposed to page JS.

**Phase B — autofill (partial, deliberately conservative):** Document-start detector (rides S4) finds login forms and draws an Aegis affordance; on explicit user click it signals the chrome (origin only, **never the credential list**); the **core** re-verifies `stored origin == live top-frame origin` and pushes one chosen credential into two specific top-frame fields via a one-shot, nonce-guarded `eval`.

**Hook points (corrected — Phase B is mostly greenfield off Linux):**

- **Vault:** `vault.rs` in the `lib.rs` mod list + `ipc()` dispatch chain.
- **Fill delivery (core→content JS execution):** **exists and is verified only on Linux** — `picker.rs:126-128` does exactly this via `with_webview` + `evaluate_javascript` (main-frame by default; the element picker is the precedent). **Correction:** the cited `adblock_win::install` / `nav_url_mac::install` `with_webview` uses only **install event handlers — none execute a script.** The picker is **`#[cfg(target_os="linux")]`-only** (`picker.rs:132-136`). So fill delivery on **Windows (`ExecuteScript`) and macOS (`evaluateJavaScript`) is greenfield**, macOS being CI-verify-only. Both APIs target the top document by default — good for the top-frame-only rule.
- **Page→core "user clicked fill" signal (corrected — no clean cross-platform primitive):** `picker.rs` proves a WebKit script-message handler **collides with wry's catch-all IPC**, which is why the picker uses a **`document.title` sentinel** caught by a GTK title-changed signal — **Linux-specific.** On Windows/macOS **no equivalent is wired**; Phase B needs a new per-platform side-channel (custom-scheme nav caught by `on_navigation`, or a title/console hack). On **Android**, the natural primitive is a **new `@JavascriptInterface` on the content WebView** — which is _exactly_ the audited dangerous step (today only the chrome webview has `addJavascriptInterface(Bridge(),"AegisAndroid")` at `MainActivity.kt:328`; content tabs have none).
- **Origin truth:** the core's main-frame URL trackers (`connect_url_tracker` `nav.rs:282`, WebView2 `SourceChanged`, WKWebView KVO, Android `onPageStarted`) give a navigated-URL truth — but it's the **browser-tracked URL, not a renderer-committed origin** (can lag on redirects/SPA), gives no clean origin for srcdoc/blob/sandboxed frames (refuse those), and **tells you nothing about which frame the request came from**. Top-frame-only relies on the eval API defaulting to main frame, not on core frame verification.

**Data model / IPC:** `vault.json` (single AEAD blob + KDF salt + nonce + version header — **not** a plaintext array). Channels: `vault.status/create/unlock/lock/list/add/update/remove/matchOrigin` and the security-critical `vault.fill`. Events `vault.locked`, `vault.fillAvailable`. **Phase A ships everything except `vault.fill`/`fillAvailable` (copy-to-clipboard only).** **Confirmed:** `vault.json` is excluded from `data.rs` `STORES` by default (so it won't leak into the plaintext `data.export` bundle) — the risk is a future maintainer adding it; keep it out or re-encrypt.

**Key security consideration:** Phase A is genuinely low-risk. **Phase B intentionally pierces the single strongest property the audit found — no page→core path from the untrusted content webview.** Hard rules: never expose the vault list/any password to page JS; core decides what to fill; fill only when stored origin **exactly** equals the live top-frame origin; **top frame only, never iframes** (defeats iframe credential harvesting); require a recent explicit gesture; one-shot nonce; refuse `http`/HTTPS-downgraded origins; never auto-submit. On Android the new `@JavascriptInterface` must be **request-signal-only** (no vault read; fill pushed by the trusted activity) — get it wrong and you recreate the classic `addJavascriptInterface` exfil surface.

**Effort: XL** (Phase A alone is L). Phase B is L-to-XL: heuristic form detection, a new per-platform page→core signal that doesn't exist off Linux, first-ever core→content JS execution on Win/macOS (macOS CI-only), the new Android content-WebView bridge, and a full security review of a deliberate trust-boundary breach.

**Brave-parity verdict:** **Vault ≈ parity** on storage (Argon2id + AEAD + keychain; Android hardware-Keystore can match/exceed a desktop keychain). **Autofill permanently weaker:** Brave's runs in the renderer with the browser-process's authoritative committed origin, Chrome's shared heuristics, per-site process isolation, and a trusted dropdown the page can't read/overlay. Aegis's is chrome-mediated JS over an unmodifiable webview: heuristic/lossier detection, in-page affordance is clickjackable, origin leans on a navigated URL (not a committed origin), conservatively refuses iframes/odd frame types, and is fingerprintable. Lead with copy-only.

---

### 3.5 VPN

**Honest framing (the load-bearing judgment — confirmed sound):** Brave's "VPN" is **not a browser feature** — it resells Guardian's paid OS-level WireGuard service (a system tun routing _all_ device traffic). A shell has **no tun/utun primitive, no privileged daemon, no server fleet** anywhere in `src-tauri`, and adding any is **not browser work**. **Do not promise a system VPN.** Ship tiers:

- **Tier 1 (the only shell-native option) — a browser-scoped proxy** applied per content webview via each platform's native proxy hook. Routes **only browsed pages**, not the OS, not other apps, **not** the chrome's own updater/filter-list fetches.
- **Tier 2 (optional, later) — partner handoff:** store a commercial provider's WireGuard creds (reuse `data.rs`/`jsonstore` + S3 keychain) and defer the actual tunnel to _their_ privileged client; Aegis shows status only. A business/integration decision, not shippable code.
- **Self-bundled WireGuard tun (boringtun + per-OS tun/NetworkExtension/VpnService + server fleet): XL, mostly non-browser — scoped out.**

**Tier-1 approach per platform (corrected):**

- **Linux — `full`.** `webkit2gtk` `WebsiteDataManagerExt::set_network_proxy_settings` with `WEBKIT_NETWORK_PROXY_MODE_CUSTOM` + `NetworkProxySettings::new(default_uri, ignore_hosts)` (+ `add_proxy_for_scheme` for SOCKS) via `with_webview` → `pw.inner().website_data_manager()`. **Verified:** both the WebContext-level (`v2_16`) and the recommended WebsiteDataManager-level (`v2_32`) setters are bound and **compile under wry's `v2_40`** feature; SOCKS-via-URI and bypass-hosts are expressible. Per-webview, **live-switchable**. Best tier.
- **Windows — `partial`.** `--proxy-server` via `additional_browser_args`/`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, set in `lib.rs run()` **before** `tauri::Builder` (the runtime COM path `adblock_win::install` reaches the _already-created_ webview and **cannot** set a launch arg). Confirmed: EnvironmentOptions are **immutable after init** → no live switching without relaunch/webview-recreation; the arg is global to the whole WebView2 environment (chrome+content share it).
- **macOS — `unknown`, the weakest tier (corrected to _harder_ than "unknown").** `WKWebsiteDataStore.proxyConfigurations` (macOS 14+) exists, **but `objc2-web-kit 0.3.2` does NOT bind `proxyConfigurations`**, and **no `objc2-network`/Network.framework binding exists** for `NWEndpoint`/proxy-config. So macOS needs **raw `msg_send!` + a hand-rolled Network.framework binding** — CI/Mac-only, plus a reported iOS-18 crash. Not "may be missing" — it _is_ missing.
- **Android — `degraded`, but EASIER than the design claimed (corrected).** `ProxyController.getInstance().setProxyOverride(...)` gated on `WebViewFeature.PROXY_OVERRIDE`. **`androidx.webkit:webkit:1.14.0` is already a Gradle dep** (`build.gradle.kts:83`, used by `RustWebView.kt`) — **nothing to add.** Set it **once** in `onWebViewCreate`/`onCreate` (it's **process-global** — hits the chrome webview too), driven from chrome via a bridge method. Proxy-auth support is **unconfirmed** — mark it a gap.

**Data model / IPC:** a `proxy` object on settings `{ mode: 'off'|'proxy'|'system'; kind: 'http'|'socks5'; host; port; username?; password?; bypassHosts[] }`, default `{ mode:'off' }`. New `vpn.rs` (managed via `app.manage` like `AdblockState`/`SafetyState`) + `vpn.getState/setConfig/connect/disconnect` channels and a `vpn.state` event. Per-platform appliers called from `vpn.rs` and `nav::spawn_tab` so new tabs inherit the proxy.

**Key security consideration:** A proxy reroutes browsing through a third party — **must be user-chosen and disclosed, never silently on.** **Secrets must not go in `settings.json`:** `data.export` bundles `settings::all(app)` verbatim (`data.rs:34`) → a stored password leaks into the Downloads export file. Put secrets in the S3 keychain and **exclude from export**. **The honesty trap:** a webview proxy does **not** stop WebRTC, DNS, or QUIC/UDP leaks (Chromium WebView2/Android send STUN/QUIC outside an HTTP proxy), and does **not** cover the chrome's own updater/`subs.rs` fetches (separate `reqwest`/rustls stack) — the real IP leaks regardless.

**Critic-flagged limits to honor:**

- **Naming/expectation fraud is the top risk** — label it **"Proxy," never "VPN."**
- **Gate it on the WebRTC-leak fix (3.1)** or the privacy promise is hollow.
- Windows can't live-switch; Android is process-global + auth-unconfirmed; macOS is the unverified, hand-rolled-binding tier.

**Effort: L** (corrected from M). M holds only for Linux+Windows+Android (Linux is a clean bound API, Windows is one env-var write, Android's lib is already present). macOS parity (the repo rule) + the keychain secret storage the design itself requires push it to L.

**Brave-parity verdict:** **Nowhere near, and saying otherwise would be dishonest.** Brave = a real paid OS WireGuard tunnel routing all device traffic with an exit-node fleet. Aegis Tier-1 = a content-webview-only proxy, leaky (WebRTC/DNS/QUIC + the chrome's own egress), no live-switch on Windows, process-global/auth-unconfirmed on Android, unverified on macOS, BYO-proxy. Useful for light geo/region testing or pairing an external proxy — **not** anonymity. The only way to approach Brave's _model_ is Tier 2 (reselling a partner's OS VPN — exactly Brave-via-Guardian), a business decision.

---

## 4. The hard truths

What the shell model **fundamentally cannot match**, regardless of effort:

1. **Engine-level farbling strength.** Brave perturbs canvas/audio/WebGL _inside Blink_, below all page JS: genuinely-native patched functions, no proxy traps, survives cross-realm/iframe comparison, non-detectable. Aegis's only universal lever is same-world JS monkey-patching — reliably detectable (`toString` tampering, Proxy traps, pristine-prototype comparison via a fresh iframe), so a determined fingerprinter can detect _and then fingerprint on_ the presence of Aegis. On a tiny user population this can be **net-negative**. And on Linux/macOS the engine is WebKit while the UA claims Chrome 148 — an inconsistency Brave never has because it _is_ Chromium; engine-quirk detection defeats the spoof regardless of any shim.

2. **WebRTC enforcement below page JS.** Only Linux (`enable-webrtc`) and Windows (`--force-webrtc-ip-handling-policy`) have a native toggle, and both are coarse on/off-style controls, not Brave's fine-grained per-tab IP policy. macOS/Android are JS-shim-only — bypassable via Workers and direct `localDescription.sdp` reads.

3. **A true OS VPN.** No tun/utun, no privileged daemon, no exit-node fleet — and building them is explicitly **not browser work**. The shell maxes out at a leaky per-webview proxy. Matching Brave's _model_ means reselling a partner's OS VPN (Tier 2), which is a business relationship, not code Aegis ships alone.

4. **Chromium's integrated autofill.** Brave's password manager runs in the renderer with the browser-process's **authoritative committed origin** (unspoofable by page script), Chrome's shared form heuristics, per-site process isolation, and a **trusted dropdown the page cannot read or overlay**. Aegis cannot get any of that: heuristic detection, an in-page affordance that's clickjackable, an origin derived from a _navigated URL_ (not a committed origin, and blank for srcdoc/blob/sandboxed frames), and a DEK in a webview process with no renderer-sandbox isolation.

5. **Local-at-rest encryption.** Brave leans on Chromium's OS-integrated storage encryption. Aegis's JSON stores are **plaintext today**; sync doesn't fix this, and only the optional keychain anchor (S3) improves it — shakiest on Android.

**The security tension that needs an explicit decision:** **autofill's content-webview bridge vs. the current clean isolation.** The audit's single strongest property is that **the untrusted content webview has no path to the core** — no IPC bridge, no `addJavascriptInterface` on content tabs (verified: the only one is on the _chrome_ webview, `MainActivity.kt:328`). Phase-B autofill **deliberately pierces this**, and the primitives are unproven off Linux: desktop has no clean page→core channel (the element picker resorts to a Linux-only `document.title` side-channel because a script-message handler collides with wry's IPC), and Android requires adding a brand-new `@JavascriptInterface` to the untrusted content WebView. A subtle mistake — origin spoof via srcdoc/sandboxed frame, a non-top-frame fill, a replayable setter, an over-broad bridge method — **silently exfiltrates stored credentials to a hostile page.** Sync, WebRTC defense, and farbling all _preserve_ the no-bridge invariant; autofill is the only feature that breaks it, and that breach must be an explicit, eyes-open product decision.

---

## 5. Recommended sequencing

### Phase 0 — shared infra (do this first, it unblocks everything)

1. **S1 atomic writes** (S) — prerequisite for sync and vault; benefits all data.
2. **S2 crypto layer** (S) — `chacha20poly1305`/`hkdf`/`argon2`/`zeroize` assembled once; add a cargo-audit gate (CI audits JS only today).
3. **S4 Android document-start injection** (M) — the long pole; finish the Android content-tab injection path **and** wire the missing popup guard while you're there. Refactor `adblock_inject::script()` to return an owned `String`.

### Phase 1 — quick, high-leverage wins (preserve the no-bridge invariant)

4. **WebRTC IP-leak defense (3.1, L)** — establish the Linux baseline first; ship the native toggle (Linux/Windows) + JS `public-only` shim everywhere; scope-test the Worker bypass and document it honestly.
5. **Password vault — Phase A only (3.4, L)** — encrypted vault + copy/paste, all platforms, on S1+S2(+S3). Highest user value per unit risk; defer autofill.

### Phase 2 — the near-parity feature

6. **E2E sync (3.3, XL)** — the retrofit (uuid+hlc+tombstones across 5 store modules) is the bulk; build the per-key settings split, a minimal backend **with a restored auth tier**, targeted-refetch (not reload), and four-platform engine-refresh-after-pull. This is the one place Aegis gets genuinely close to Brave.

### Phase 3 — the harder, more-detectable / boundary-breaking features

7. **Anti-fingerprinting (3.2, XL)** — opt-in, default-off, per-site escape hatch; the two-engine consistency tuning is the risk; document the per-frame-origin seeding limitation; fix the salt-invertibility framing.
8. **Proxy ("VPN" Tier 1) (3.5, L)** — only after 3.1, and **labeled "Proxy."** macOS needs the hand-rolled Network.framework binding.
9. **Autofill — Phase B (3.4, L–XL)** — last, behind an explicit decision to pierce isolation; greenfield page→core signal on Win/macOS; new Android content-WebView bridge.

### The 2–3 product decisions the user must make _before_ building

1. **Sync backend: self-hosted vs. managed — and the auth tier.** Self-hosted minimal blob+cursor service (matches the project's self-reliant, GitHub-releases-as-infra ethos; user owns uptime) vs. managed object store (S3/R2/Backblaze — least code, adds a cloud bill + account-auth). **Either way, the server needs an authentication tier** (the design dropped Brave's Ed25519 signed tokens, leaving the server with no auth — anyone with an `accountId` can withhold/overwrite). Decide the backend _and_ the auth model up front; design the protocol so the other backend is a drop-in.

2. **"VPN": true vs. proxy vs. partner.** A true OS VPN is out of scope (XL, non-browser, needs a fleet). Decide: ship **only** the honestly-labeled Tier-1 proxy (shippable), pursue a **Tier-2 commercial partner** (business decision, gives Brave's actual model), or both. Commit to _not_ marketing either as Brave-tunnel parity.

3. **Autofill: mediated vs. copy-only-first.** Phase A (copy/paste) is safe and near-parity — ship it regardless. The decision is whether to take on **Phase B mediated autofill**, which deliberately breaks the audit's strongest isolation property and needs a new content-webview bridge per platform. Recommend: ship copy-only, treat mediated autofill as a separate, explicitly-authorized security project — not an automatic follow-up.

> A standing constraint on all of the above: the repo's **"all platforms at parity before done"** rule is what turns three of these from L to XL (macOS hand-rolled bindings, the new Android injection/bridge, four-platform engine refresh). Honestly account for it in every estimate rather than shipping Linux-only and calling a feature complete.
