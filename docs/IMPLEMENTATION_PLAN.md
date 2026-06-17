# Aegis Implementation Plan — WebRTC IP-Leak Defense + E2E-Encrypted Sync

**Scope:** exactly two user-facing features — (1) WebRTC IP-leak defense, (2) end-to-end-encrypted cross-platform sync — plus the shared foundation they require. Password manager, VPN/proxy, and anti-fingerprinting are explicitly **out of scope**.

This plan folds in every adversarial-review correction. Where a reviewer marked a claim wrong/unverified/incomplete, the corrected form is what appears below (and is flagged ⚠️ FIX at the point of change so an implementer doesn't re-introduce the mistake).

---

## 1. Scope & sequencing

### 1.1 The three deliverables

| # | Deliverable | What it is |
|---|-------------|------------|
| **F0** | **Shared foundation** | Atomic durable writes for every JSON/text store; `adblock_inject::script()` refactored `&'static str` → owned `String`; a real Android document-start injection path (today Android injects *nothing*) + the missing pop-under guard on Android; the worked 3-places IPC/settings/event pattern as the template for F1/F2. |
| **F1** | **WebRTC IP-leak defense** | A tri-state `webrtcPolicy` setting (`'default' | 'public-only' | 'disable'`, default `'public-only'`) implemented as a per-session document-start JS shim (RTCPeerConnection wrap + ICE-candidate filter + SDP rewrite, keeping TURN/relay) plus per-platform native backstops, a per-site escape hatch reusing the adblock allowlist, and an honest worker-bypass residual matrix. |
| **F2** | **E2E-encrypted sync** | Two halves: **F2a** the sync **data-layer retrofit** (uuid + HLC + tombstones across every store + the in-memory allowlist; per-key settings; atomic writes already from F0; lazy on-disk migration; cross-platform post-merge adblock refresh) and **F2b** the sync **engine** (crypto key tree, restored Ed25519 signed-token auth, pull/merge/push client, device pairing, the full IPC surface, OS-keychain seed anchoring, export exclusion, `useSync` hook + Sync settings tab). |

### 1.2 Dependency graph

```
            ┌──────────────────────────────────────────────┐
            │  F0  Shared foundation                        │
            │  (atomic writes · script() String · Android   │
            │   doc-start inject · 3-places template)       │
            └───────────────┬───────────────┬──────────────┘
                            │               │
                  ┌─────────▼──────┐   ┌─────▼───────────────┐
                  │  F1  WebRTC    │   │  F2a Sync data-layer │
                  │  (shim+native) │   │  (uuid/HLC/tombstone,│
                  │                │   │   per-key settings,  │
                  │                │   │   allowlist persist, │
                  │                │   │   adblock_refresh)   │
                  └────────────────┘   └─────────┬───────────┘
                                                 │  (HARD dep: F2b is a
                                                 │   contract against F2a's
                                                 │   SyncRecord/Hlc/merge)
                                       ┌─────────▼───────────┐
                                       │  F2b Sync engine    │
                                       │  (crypto · auth ·   │
                                       │   client · pairing ·│
                                       │   keystore · UI)    │
                                       └─────────────────────┘
```

Key facts driving the order (all verified against the code):

- **F0 must land first.** F1 bakes its WebRTC shim into the `String` that F0's refactored `script()` returns and into the Android doc-start path F0 builds. F2a needs F0's atomic-write primitive *with the concurrency fix* (see §2.1) because F2b's sync thread and the IPC thread both write the same stores. F1 and F2a are independent of each other and can proceed in parallel after F0.
- **F2b is a hard contract against F2a** (reviewer: "a contract against vapor" today — grep confirms zero uuid/hlc/tombstone infra exists). F2b's `sync.rs` references `SyncRecord`/`Hlc`/`apply_remote`/`local_changes_since`/`cursor`. **F2a must land with the exact signatures named in §4 before F2b is implemented**, or F2b inherits silent data-loss bugs no F2b test can catch (its tests use a fake store).

### 1.3 Phased build order + effort

| Phase | Deliverable | Effort | Gating notes |
|-------|-------------|--------|--------------|
| **Phase 0** | F0 Foundation | **M** | No new top-level Cargo deps. Android `cargo check --target aarch64-linux-android` + JDK-21 build are HARD gates (not checkable on this Linux host). |
| **Phase 1** | F1 WebRTC | **L** | Parallelizable with Phase 2 after Phase 0. Linux GUI-leak-verified on real HW; Win/mac/Android via CI-compile + on-device follow-up. |
| **Phase 2** | F2a Sync data-layer | **L** | Must precede Phase 3. `adblock_engine.rs` pulled into scope for `reload_lists` (see §4 fix). |
| **Phase 3** | F2b Sync engine | **XL** | Hard dep on Phase 2 contract. Crypto deps cross-compile gate on windows-gnu + aarch64-linux-android. Android Keystore JNI device-only-verifiable. |

Total: roughly **M + L + L + XL**. Phases 1 and 2 overlap; Phase 3 is the long pole and cannot start until Phase 2's record model is frozen.

---

## 2. Phase 0 — Foundation

No new runtime IPC channels; no new top-level Cargo deps (`uuid`/`sha2`/`getrandom`/`zeroize` already resolve transitively; the atomic helper is pure `std`). Baseline gate: `cargo test` + `npm test` (~413 vitest) green before starting.

### 2.1 Atomic durable write helper (`jsonstore.rs`) — with the concurrency fix

**File:** `src-tauri/src/jsonstore.rs`. Today `save()` is the non-atomic `std::fs::write(&p, txt)` at **line 34** (verified); `load()` is `read_to_string … from_str::<Vec<Value>> … unwrap_or_default()` at **lines 18-23** (verified — a corrupt parse silently zeroes the store).

Add `use std::fs::{self, File}; use std::io::Write;` and three helpers:

```rust
/// Durably write `bytes` to `path`: temp file → fsync → rename over target →
/// fsync parent dir. Keeps the prior good copy at <name>.bak for recovery.
pub fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() { fs::create_dir_all(dir)?; }
    if path.exists() {
        let bak = bak_path(path);
        let _ = fs::copy(path, &bak);
    }
    // ⚠️ FIX (reviewer biggest-risk): PROCESS-UNIQUE tmp suffix, NOT a fixed `.tmp`.
    // F2b's sync thread + the IPC thread can both write e.g. favorites.json
    // concurrently; a fixed `<name>.tmp` collides → interleaved rename corrupts/loses
    // a write. The unit tests (single-threaded tempdir) would NEVER catch this.
    let tmp = path.with_extension(format!(
        "{}.{}.tmp", std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos()).unwrap_or(0)));
    {
        let mut f = File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    // Best-effort dir fsync; File::open on a dir fails on Windows — swallow it there.
    if let Some(dir) = path.parent() {
        if let Ok(d) = File::open(dir) { let _ = d.sync_all(); }
    }
    Ok(())
}

fn bak_path(path: &std::path::Path) -> std::path::PathBuf {
    path.with_extension(format!(
        "{}bak", path.extension().and_then(|e| e.to_str())
            .map(|e| format!("{e}.")).unwrap_or_default()))
}

/// JSON-validated read with .bak fallback (works for arrays AND objects).
pub fn read_with_backup(path: &std::path::Path) -> Option<String> {
    let primary = fs::read_to_string(path).ok();
    if let Some(ref t) = primary {
        if serde_json::from_str::<serde_json::Value>(t).is_ok() { return primary; }
    }
    fs::read_to_string(bak_path(path)).ok()
        .filter(|t| serde_json::from_str::<serde_json::Value>(t).is_ok())
}

/// Non-JSON (filter text) read with .bak fallback — no structural validation.
pub fn read_text_with_backup(path: &std::path::Path) -> Option<String> {
    let primary = fs::read_to_string(path).ok().filter(|t| !t.is_empty());
    primary.or_else(|| fs::read_to_string(bak_path(path)).ok())
}
```

Rewrite `save()` to build `txt` then `write_atomic(&p, txt.as_bytes()).map_err(|e| e.to_string())`. Rewrite `load()` to source via `read_with_backup(&p)` instead of the bare `read_to_string`. `next_id` (line 38) and `now_ms` are unchanged.

> ⚠️ **Reviewer "atomicity" wording fix:** `std::fs::rename`'s own docs do *not* guarantee an atomic replace and do *not* name `MoveFileEx/REPLACE_EXISTING`. State only what's true: temp-then-rename in the **same directory** (tmp is a sibling of the target) replaces an existing file and is the standard durable-write idiom — strictly better than truncate-then-write. Don't overclaim atomicity in comments.

### 2.2 Route the other stores through the helpers

Open each file and match by string (line numbers drift; reviewer found the `settings.set` block mis-cited):

- **`settings.rs`** — `write()` (~37-44), the `settings.set` dispatch write block (**real range ~107-126**, *not* 112-124), and `load()`'s `read_to_string` (~line 85). `write()` and the dispatch arm use `crate::jsonstore::write_atomic(&p, …)`; `load()` uses `read_with_backup` (settings is an object — the helper validates generic JSON, so it works). The defaults overlay is unchanged: a corrupt `settings.json` now recovers from `settings.json.bak` instead of resetting every key.
- **`customfilters.rs`** — `write()` (~24-31) and the `customFilters.set` write (~line 42) → `write_atomic`. `load()` (~line 19) → `read_text_with_backup` (custom-filters.txt is plain filter text, NOT JSON).
- **`data.rs`** — export write (~line 42) → `write_atomic` (keep the `Ok(())`/`Err(e)` match). The export path is same-dir-rename so cross-fs is not a concern. Export is a user artifact, not an app store → no `.bak` desired; pass through `write_atomic` but the implementer may add a `write_atomic_no_backup` variant if a stray `.bak` next to a user's download is undesirable (cosmetic).
- **`subs.rs`** — the two cache writes (lines **103 and 152**, verified) → `write_atomic` (these run on spawned threads but for *distinct* `list_id` paths, so they don't collide; the process-unique tmp suffix from §2.1 makes this airtight).

### 2.3 Refactor `adblock_inject::script()` to owned `String`

**File:** `src-tauri/src/adblock_inject.rs` (verified: `script() -> &'static str` at 52-61, `SCRIPT` OnceLock at 14-16 gated `#[cfg(not(target_os = "linux"))]`, popup test calls `script()` at line 173). The **only** external caller is `nav.rs:123` (verified).

Add a forward-compatible config seam (F1 fills `webrtc`):

```rust
#[derive(Clone, Default)]
pub struct InjectConfig {
    // Phase 1 (F1) adds: pub webrtc: crate::webrtc_shim::WebrtcInjectPolicy,
    // and host_allowlisted is passed separately to script() (see §3).
}

// Keep the heavy build() cached so it parses once; only the cheap wrapper varies.
#[cfg(not(target_os = "linux"))]
static BUILT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn script(cfg: &InjectConfig) -> String {
    let _ = cfg;
    #[cfg(target_os = "linux")]
    { POPUP_GUARD.to_string() }
    #[cfg(not(target_os = "linux"))]
    { format!("{POPUP_GUARD}\n{}", BUILT.get_or_init(build)) }
}
```

Delete the old `SCRIPT` OnceLock (it cached the whole string; the new `BUILT` caches only the heavy `build()` so the per-config wrapper can vary). Update the popup test at line 173 to `super::script(&super::InjectConfig::default()).contains("__aegisBlocked")`.

**`nav.rs:123`** — ⚠️ **FIX (reviewer):** `initialization_script_for_all_frames` is `pub fn …(script: impl Into<String>)` (verified tauri-2.11.2 webview/mod.rs:927). `&String` does **not** implement `Into<String>`; pass the **owned** `String` with **no leading `&`**:

```rust
.initialization_script_for_all_frames(crate::adblock_inject::script(&crate::adblock_inject::InjectConfig::default()))
```

### 2.4 Android document-start injection (today injects nothing) + missing pop-under guard

**Verified:** `MainActivity.kt createTabWebView` (~263-283) sets clients/UA/multi-window but has **no** `addDocumentStartJavaScript` anywhere — Android gets neither the pop-under guard nor the injected ad-block tier. `androidx.webkit:webkit:1.14.0` is at `gen/android/app/build.gradle.kts:83`; `addDocumentStartJavaScript(WebView, String, Set<String>)` and the `DOCUMENT_START_SCRIPT` feature constant are both present in that jar (reviewer javap-verified).

**Make the module compile for Android.** Change lib.rs:24-25 from `#[cfg(any(desktop, test))]` to `#[cfg(any(desktop, target_os = "android", test))]` (mirroring `mod adblock_engine` at lib.rs:9-10). `build()`/`is_procedural` are already `#[cfg(any(not(target_os="linux"), test))]` so they compile for Android; `adblock_lists::ALL` is unconditional.

**Rust JNI getter** (in `adblock_inject.rs`, gated `#[cfg(target_os = "android")]`), returning a `jstring` — a **new return type** for this repo (only `jboolean` today); verify `env.new_string(...).into_raw()` against `jni = "0.21"` (Cargo.toml:55):

```rust
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeInject_documentStartScript<'a>(
    mut env: jni::JNIEnv<'a>, _this: jni::objects::JObject<'a>,
) -> jni::sys::jstring {
    // Phase 1 folds the WebRTC shim in via the same InjectConfig seam.
    let s = format!("{POPUP_GUARD}\n{}", build());
    match env.new_string(s) { Ok(js) => js.into_raw(), Err(_) => std::ptr::null_mut() }
}
```

**Kotlin** — `NativeInject.kt` mirroring `NativeSafety.kt` (object + `System.loadLibrary("app_lib")` in `init` + `external fun documentStartScript(): String`).

**Wire into `createTabWebView`** — ⚠️ **FIX (reviewer gap):** guard on the runtime feature or it throws `UnsupportedOperationException`/leaks on old System WebView, and a malformed origin rule throws `IllegalArgumentException` (Capacitor #7423 precedent) — keep the try/catch:

```kotlin
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
// field, computed once (the ~1 MB string crossing JNI per-tab would be wasteful):
private val documentStartScript: String by lazy {
    try { NativeInject.documentStartScript() } catch (_: Throwable) { "" }
}
// in createTabWebView, after the clients are set:
if (documentStartScript.isNotEmpty()
        && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
    try { WebViewCompat.addDocumentStartJavaScript(wv, documentStartScript, setOf("*")) }
    catch (t: Throwable) { Log.w("AegisInject", "document-start inject failed", t) }
}
```

**HARD gate (reviewer):** `cargo check --target aarch64-linux-android` + a JDK-21 `npm run android:build` (gotcha 8) — none of this is checkable from the Linux host (gotcha 10), and the on-device confirmation that `setOf("*")` is accepted and that DOCUMENT_START fires in the page main world before page scripts is a manual must-do, not optional.

### 2.5 The worked 3-places IPC/settings/event pattern (template for F1/F2)

Document in `shared/CLAUDE.md` (extend the existing "Adding a channel" section). No code shipped beyond extending `shared/types.test.ts` to assert every `IPC` value is dot-separated and unique. The canonical add (illustrated with `sync.changed`):

- **PLACE 1 — `shared/types.ts`:** add the name to the `IPC` const (lines 7-107), add any payload interface, add the typed method/namespace to `AegisApi` (270-395).
- **PLACE 2 — `src-tauri/src/lib.rs`:** add `mod foo;`; insert `if let Some(result) = foo::dispatch(&app, &channel, &payload) { return result; }` into the `ipc()` chain (64-109) before the fallthrough; the module's `dispatch(app,channel,payload) -> Option<Result<Value,String>>` matches its channels and returns `None` otherwise (settings.rs:104 shape). For an event, emit **only** via `crate::emit_event(app, "sync.changed", payload)` (lib.rs:54-56 does `.`→`:`); **never** `app.emit` a dotted name.
- **PLACE 3 — `src/lib/ipcClient.ts`:** `call<T>(IPC.x, payload)` for commands; `on<T>(IPC.evtX, cb)` for events (tauriInvoke.ts:20-34 reverses `:`→`.`).
- **Settings-field shortcut:** a new settings field needs **no new channel** — add to `settings.rs defaults()` + the `Settings` interface; `settings.set` shallow-merges (settings.rs merge ~95-101, dispatch ~107-126; ipcClient.ts:187). F1's `webrtcPolicy` and F2's `syncServerUrl` both ride this.
- **`sync.changed` must drive TARGETED per-store refetch, never `window.location.reload()`** (the anti-pattern is `data.import` at ipcClient.ts:242; the right precedent is `useHistory.ts` subscribing `onChanged(() => list())`).

---

## 3. Phase 1 — WebRTC IP-leak defense

`webrtcPolicy: 'default' | 'public-only' | 'disable'` (default `'public-only'`). `'public-only'` = filter host/private/.local candidates, keep relay/TURN + public srflx so calls survive; `'disable'` = construction throws; `'default'` = no interference.

### 3.1 Settings field (no new channel)

- **`shared/types.ts`** `Settings` interface (~256-267, after `tabIdleTimeout`): add `webrtcPolicy: 'default' | 'public-only' | 'disable';`.
- **`settings.rs defaults()`** (~14-29): add `"webrtcPolicy": "public-only"`.
- **`src/hooks/useSettings.ts`** `emptySettings` (~7-14): add `webrtcPolicy: 'public-only'`. (Note: `emptySettings` already omits `httpsOnly`/`tabIdleTimeout` while annotated `: Settings` — tsc is not a gate; add the field for correctness.)
- `SecurityTab.test.tsx` casts `as never`, so adding a required field breaks no existing test.

### 3.2 Settings reader (mirror `https_only`)

`settings.rs`, after `https_only()` (~61): `pub fn webrtc_policy(app: &AppHandle) -> String { load(app).get("webrtcPolicy").and_then(Value::as_str).unwrap_or("public-only").to_string() }`. Single source for the shim builder + native backstops.

### 3.3 The JS shim + bake-in (`webrtc_shim.rs`)

**New module** `src-tauri/src/webrtc_shim.rs`. ⚠️ **FIX (reviewer):** gate it like `adblock_engine` — `#[cfg(any(desktop, target_os = "android", test))]` (so the JNI export links on Android), with the JNI fn itself `#[cfg(target_os = "android")]`. **Not** the `adblock_inject` gating (which excludes Android).

Public API: `pub fn shim_for(policy: &str, allowlisted_for_host: bool) -> String`.

- `'default'` or allowlisted host → `""` (no interference).
- `'disable'` → JS overriding `window.RTCPeerConnection` + `window.webkitRTCPeerConnection` with a constructor that throws `DOMException('WebRTC disabled by Aegis','NotAllowedError')`.
- `'public-only'` → wrap the constructor, returning a real `pc` with filters installed: (i) wrap `addEventListener('icecandidate', …)` and the `onicecandidate` setter, dropping candidates per `keep_candidate`; (ii) wrap `createOffer`/`createAnswer` to run returned SDP through `filter_sdp`; (iii) shim the `localDescription`/`currentLocalDescription`/`pendingLocalDescription` getters to run stored SDP through `filter_sdp` (closes the direct-read bypass). Everything in try/catch (**fail open** — a shim error never breaks page JS).

⚠️ **SHOULD-FIX (reviewer biggest-risk):** make the filter a **single tested artifact**, not a Rust-tested copy plus a hand-transliterated JS copy that can drift. Author `keep_candidate(line:&str)->bool` and `filter_sdp(sdp:&str)->String` as Rust pure fns **and emit the shipped JS from them / test the emitted JS string directly** so the test covers shipped code. The filter:

- `keep_candidate`: KEEP `typ relay` (TURN) and public srflx; DROP `typ host`/`typ srflx` with RFC1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), unique-local (fc00::/7), loopback (127/8, ::1), or `.local` mDNS; **FAIL OPEN (keep) on any unparseable/malformed/truncated line or unexpected IPv6 form**.
- `filter_sdp`: rewrite private `c=IN IP4/IP6` and `o=` host lines to `0.0.0.0`/`::`, leave public alone, drop private candidate lines while keeping relay, idempotent.

**Bake-in.** Change `adblock_inject::script` to `pub fn script(app: &AppHandle, host_allowlisted: bool) -> String` and PREPEND `webrtc_shim::shim_for(&crate::settings::webrtc_policy(app), host_allowlisted) + "\n"` before the popup-guard/build body. Keep `BUILT` caching the heavy part; concat the cheap shim per call. `nav.rs:123` becomes `script(app, host_allowlisted)` (pass the owned String, no `&`). Register `mod webrtc_shim;` in lib.rs.

### 3.4 Per-platform native backstops (corrected APIs)

**Linux** (`linux_layout.rs`): ⚠️ **FIX (reviewer):** `WebViewExt::settings()` returns `Option<Settings>`, not `Settings`. Add `use webkit2gtk::SettingsExt;` (v2_38 is resolved transitively; the file imports only `WebViewExt` today) and:

```rust
pub fn apply_webrtc_policy_label(app: &AppHandle, label: &str, policy: &str) {
    let Some(w) = app.get_webview(label) else { return };
    let disable = policy == "disable";
    let _ = w.with_webview(move |pw| {
        use webkit2gtk::{WebViewExt, SettingsExt};
        if let Some(s) = pw.inner().settings() { s.set_enable_webrtc(!disable); }
    });
}
```

`set_enable_webrtc` is all-or-nothing, so it only backstops `'disable'`; `'public-only'`/`'default'` leave it `true` and rely on the shim. Call it from `nav.rs` spawn_tab's Linux arm after the other `connect_*_label` calls, gated on `!host_allowlisted`.

**Windows** (`nav.rs` spawn_tab WebviewBuilder, ~118-123): map `'disable'` → `disable_non_proxied_udp`, `'public-only'` → `default_public_interface_only`, `'default'` → omit, via `--force-webrtc-ip-handling-policy`. ⚠️ **CRITICAL (verified):** `additional_browser_args` **replaces** wry's default `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` (wry-0.55.1 webview2/mod.rs:294-297), so re-include it:

```rust
#[cfg(target_os = "windows")] {
    let pol = crate::settings::webrtc_policy(app);
    let mut args = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    if !host_allowlisted {
        match pol.as_str() {
            "disable" => args.push_str(" --force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
            "public-only" => args.push_str(" --force-webrtc-ip-handling-policy=default_public_interface_only"),
            _ => {}
        }
    }
    builder = builder.additional_browser_args(&args);
}
```

Make `builder` `mut`. The switch is read only at webview **creation** (immutable after) → a mid-session change applies only to new tabs natively; the shim covers open tabs until reload. The switch-value spellings are Chromium-standard and corroborated by the prior Electron implementation; runtime acceptance by the bundled WebView2 is a Windows-desktop verify item (UNVERIFIED here — honest residual).

**macOS / Android:** no native WebRTC lever found → shim-only for both modes (honest residual; see §3.7).

### 3.5 Per-site escape hatch (reuse the adblock allowlist)

In `nav.rs` spawn_tab, derive the tab host from the url arg and check `AdblockState.allowlist` (lock `app.try_state::<crate::adblock::AdblockState>()`, suffix-match `host == h || host.ends_with(&format!(".{h}"))`). Add `pub fn host_allowlisted(app, host) -> bool` in `adblock.rs` to centralize it. Pass the bool into `script(app, host_allowlisted)` (shim returns `""`) and gate the Linux/Windows native backstops on `!host_allowlisted`. Residual: keyed on the spawn URL's host; SPA navigation to a new host within the same tab is not re-evaluated until respawn — documented.

### 3.6 Settings UI

`src/components/SecurityTab.tsx` (receives `settings` + `update(partial)`; httpsOnly input is ~lines 32-33): add a `<select>` bound to `settings.webrtcPolicy` with options `public-only` ("Hide my local IP (recommended)"), `disable` ("Disable WebRTC entirely — breaks video calls"), `default` ("No protection"), `onChange` → `update({ webrtcPolicy: … })`. Help text states the call-breaking tradeoff for `disable` and that changes apply to new tabs / reload to apply. The same `SecurityTab` renders in the desktop modal and the mobile sheet.

### 3.7 Worker-bypass scope-test + honest residual matrix

Document (code comment in `webrtc_shim.rs` + SecurityTab help text): document-start injection covers page + iframe frames, **not** Web Worker / SharedWorker scopes, where `RTCPeerConnection` also exists — so a page constructing a peer connection in a Worker bypasses the `'public-only'` shim. The native levers ARE engine-wide (incl. workers). Honest coverage:

| Policy | Linux | Windows | macOS | Android |
|--------|-------|---------|-------|---------|
| `disable` | native (set_enable_webrtc) — worker-tight | native — worker-tight | shim-only — workers leak | shim-only — workers leak |
| `public-only` | shim-only — workers leak | native (default_public_interface_only) — worker-tight | shim-only — workers leak | shim-only — workers leak |

macOS is weakest (shim-only both modes). The plan states the matrix; it does not claim a worker fix it cannot deliver.

### 3.8 Test plan (mapped in §7)

Rust-unit `keep_candidate`/`filter_sdp`/`shim_for` (incl. IPv6 + fail-open fuzz); the `script(app, allowlisted)` regression (popup guard + shim prefix); vitest SecurityTab + useSettings; Linux manual leak-test (browserleaks/webrtc + a self-hosted ICE dump page, captured with spectacle per the live-testing note) for all three policies; the Worker scope-test page recording the matrix above; Win/mac/Android CI-compile + `cargo check` cross-targets, with GUI leak-verify as user-session follow-ups.

---

## 4. Phase 2 — Sync data-layer retrofit (F2a)

Retrofit every store + the in-memory allowlist with `uuid` + HLC + tombstone, without changing renderer-visible shapes or breaking the ~413 vitest tests (they mock IPC and never touch Rust — reviewer-confirmed, so envelope keys can't leak to them).

### 4.1 `uuid` as a direct dep

`src-tauri/Cargo.toml` `[dependencies]` (line 20): add `uuid = { version = "1", features = ["v4", "serde"] }`. ⚠️ **FIX (reviewer):** Cargo.lock is **not** byte-identical — it gains exactly one line (`"uuid",` in the `app` package's dependency list). No new crate, no version bump. `sha2`/`getrandom`/`rand`/`zeroize` stay transitive (do not add crypto deps here — those are Phase 3).

### 4.2 `sync_envelope.rs` — HLC + ordering

Pure logic, `mod sync_envelope;` ungated (compiles all platforms):

```rust
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hlc { pub wall_ms: i64, pub counter: u32, pub node: String }
impl Hlc { pub fn zero(node:&str)->Self { Hlc{wall_ms:0,counter:0,node:node.into()} }
           fn key(&self)->(i64,u32,&str){(self.wall_ms,self.counter,self.node.as_str())} }
impl Ord for Hlc { fn cmp(&self,o:&Self)->std::cmp::Ordering{ self.key().cmp(&o.key()) } }
impl PartialOrd for Hlc { fn partial_cmp(&self,o:&Self)->Option<std::cmp::Ordering>{Some(self.cmp(o))} }
```

Plus a process-global clock `static CLOCK: OnceLock<Mutex<Hlc>>` with `tick(node, now_ms) -> Hlc` (strictly monotonic; counter increments within a wall-ms) and `observe(node, now_ms, &remote) -> Hlc` (standard HLC receive-update). Also expose a **deterministic fixed big-endian `hlc_bytes(&Hlc) -> Vec<u8>`** (used by F2b's AEAD AAD — must NOT be serde_json, which can reorder).

### 4.3 `sync_identity.rs` — stable node id

`pub fn node_id(app) -> String`: read `sync-device.json`; if absent generate `Uuid::new_v4()`, write via `write_atomic`, cache in `OnceLock`. The HLC `node`. ⚠️ **Comment the F2b coupling:** when the Ed25519 device key lands (Phase 3), the node id should become its public-key fingerprint and live in the **same file** — pick one owner so there aren't two device-id files.

### 4.4 jsonstore syncable-record layer

Atomic writes are already done in §2.1. Add (factor the pure helpers to take `Vec<Value>` + `node: &str` so they're AppHandle-free unit-testable; the AppHandle wrappers are thin):

- `ensure_sync_meta(item, node, now_ms)` — assign `uuid`/`hlc`/`deleted` only if absent (idempotent migration).
- `stamp_new(item, app)` — fresh uuid + ticked hlc + `deleted=false`.
- `tombstone(items, pred, app) -> bool` — set `deleted=true` + bump hlc on matches.
- `touch(item, app)` — bump hlc on a mutated (live) record.
- `load_synced(app, name) -> Vec<Value>` — `load` + `ensure_sync_meta` each, persist back **only if** something was assigned.
- `live(items) -> Vec<Value>` — filter out `deleted == true` for renderer reads.

`next_id` (line 38) stays int-based and scans the full array (incl. tombstones, verified) so a deleted id is never reused. **Behavioral contract change:** every renderer-facing read must use `live(load_synced(...))` or counts/dedup/`has` see ghosts.

### 4.5 Retrofit each store

For every store: mutations load via `load_synced`, persist the **full** array (tombstones kept on disk); reads return `live(...)`; deletes become tombstones; edits `touch`.

- **`places.rs`** (favorites + saved): `add` → `stamp_new`; `remove` `items.retain(...)` (favorites :53, saved :110) → `tombstone`; `update` → `touch`; `reorder` → touch changed rows; saved `add` dedup (:91-93) and `has` (:79-85) and `tagUnion` (:153) filter via `live`; `persist()` (:170) returns `live(items)` to the renderer while saving the full array.
- **`history.rs`**: `record` → `stamp_new` (dup-check ignores a tombstoned last row); `list`/`search` wrap in `live` before `.rev()`; `remove` → tombstone; `clear` (106-111) tombstones every live row instead of writing `[]` (else a peer resurrects it). The MAX_ENTRIES cap (27-30) stays a **hard drain** (not tombstoned) — documented asymmetry (see §9).
- **`subs.rs`**: keyed by `listId`; `add` (upsert at :210) **revives a tombstoned row in place** (preserving uuid) instead of hard-removing; `setEnabled`/fetch-stamp → `touch`; `remove` (:244) → tombstone (still delete the cache .txt); `enabled_text`/`update_all` iterate `live`.
- **`downloads.rs`**: `record` → `stamp_new` (terminal-state transition only, not every byte tick); `remove`/`cancel` → tombstone; `clear` (85-93) tombstones finished rows. (Reviewer note: `useDownloads.test.tsx` **does** exist and mocks IPC, so it stays green.)
- **`customfilters.rs`**: single-record sync via a sibling `custom-filters-sync.json` `{uuid,text,hlc,deleted}`; `customFilters.set` bumps the record's HLC after writing the .txt. ⚠️ **FIX (reviewer gap):** `picker.rs:110` writes `custom-filters.txt` **directly** via `customfilters::write()`, bypassing `customFilters.set` — so route the sync-record stamp into `customfilters::write()` itself (not just the `set` dispatch) so picker-added rules also bump the HLC and sync.

### 4.6 Settings — per-key projection (defeat defaults-resurrection)

**Verified trap:** `load()` (82-92) starts from `defaults()` and shallow-overlays the saved file, so deleting a key resurrects its default. Keep `settings.json` flat and untouched (all getters + the heavily-tested live path unchanged), and add a parallel `settings-sync.json` of per-key records `{key,value,uuid,hlc,deleted}`:

- `record_change(app, key, value)` — called per-key from `settings.set` dispatch; upsert the record, `tick` its HLC.
- `apply_synced(app, records)` — the post-merge applier: write each value into flat settings, or if `deleted=true` **remove the key** so `load()` falls to default (= "reset to default" semantic).
- Migration: first `sync_projection` call with no file builds one record per current key with ticked HLCs.

### 4.7 Allowlist persistence + projection

**Verified bug:** `adblock.rs Inner.allowlist` (71-74) is in-memory-only, empty default (76-83), no boot-load — lost on restart. Add `allowlist.json` of `{host,uuid,hlc,deleted}` records:

- `load_allowlist`/`add_host`/`remove_host`/`clear_allowlist` in `adblock.rs`; route `toggleAllowlist`/`removeAllowlist`/`clearAllowlist` (132-154) through them.
- ⚠️ **FIX (reviewer):** `AdblockState` is `.manage()`d at builder time (lib.rs:344) **before** `setup()`. Seed `Inner.allowlist` by **mutating the already-managed state in `setup()`** (`app.state::<AdblockState>().0.lock()…`), not by constructing it with data. This fixes the restart-loses-allowlist bug on all platforms.

### 4.8 `adblock_refresh.rs` — cross-platform post-merge refresh

**Verified:** the re-apply after a filter change is Linux-only `install_adblock` (customfilters.rs:48, adblock.rs:123, data.rs:87, subs.rs via `reinstall_adblock`, **and picker.rs:110**). ⚠️ **FIX (reviewer gap):** the original plan omitted **picker.rs:110** — include it. Add `pub fn refresh(app)` that: Linux → `install_adblock` (rebuilds WebKit filters); all targets → re-sync on/off + allowlist into the engine via `adblock_engine::set_policy`; all targets → `adblock_engine::reload_lists(app)` to re-parse the FilterSet (Win/Android currently never re-read subs/customfilters after boot).

⚠️ **FIX (reviewer biggest-risk for F2a):** `reload_lists` is **not** a same-module change and **cannot** "go through the existing mpsc channel" — the engine channel carries only `Query{url,source,rtype,reply}` (adblock_engine.rs:51-58) with no rebuild variant, and the engine is `!Send` (gotcha 4). **Pull `adblock_engine.rs` into Phase 2 scope** and redesign its channel to an enum (e.g. `Msg::Query(Query) | Msg::Reload{app}`) + the thread loop, rebuilding the FilterSet from `adblock_lists::ALL + subs::enabled_text(app) + customfilters::load(app)` on the engine thread. If perf-prohibitive on every sub change, debounce. **Fallback if descoped:** ship `set_policy`-on-all-platforms + Linux WebKit reinstall now (both already supported via globals) and file the FilterSet reload as an explicitly-scoped fast-follow — but the parity mandate argues for doing it here. Rewire all five callers (incl. picker.rs:110) to `adblock_refresh::refresh(app)`.

### 4.9 `data.rs` export/import — envelope + new stores + migrate-on-import

Add `"allowlist"` to the exported stores; bump bundle `version` 1 → 2; on import run `ensure_sync_meta` over each imported array (old v1 exports lack envelopes); rebuild the settings per-key projection and the customFilters sync record on import; replace the Linux-only `install_adblock` (:87) with `adblock_refresh::refresh(app)`. The sync vault/salt (Phase 3) are their own files, NOT in the export store list (see §5.10).

### 4.10 `sync_stores.rs` — the merge seam F2b consumes

`pub const SYNCABLE: &[&str] = &["favorites","saved","history","downloads","allowlist"];` plus the two special projections (settings per-key, customFilters single-record). Expose:

- `read_all(app, name) -> Vec<Value>` = `load_synced` (full array incl. tombstones).
- `merge_into(app, name, remote) -> Vec<String>` (changed uuids): per-uuid HLC-LWW — replace if `remote.hlc > local.hlc` (incl. flipping `deleted`), insert if new uuid, `observe` each remote HLC. Persist via `write_atomic`. **Returns which stores/uuids changed** so the caller can emit targeted `sync.changed` (not a reload).
- After a merge touching subs/customFilters/allowlist → `adblock_refresh::refresh(app)` + re-seed `Inner.allowlist`.

### 4.11 Which existing tests change

None of the ~413 vitest tests change (mocked IPC; reviewer-confirmed the `toEqual`-worry is moot). New Rust `#[cfg(test)]` modules are additive (jsonstore/places/history/subs/customfilters/settings/adblock/data have none today). `adblock_engine.rs` gains tests for the new `Reload` message (it already has the policy/popup tests).

---

## 5. Phase 3 — Sync engine (F2b)

**HARD dep on Phase 2's frozen contract.** F2b assumes `SyncRecord { uuid, hlc: Hlc, deleted, namespace, payload }`, `Hlc{wall_ms,counter,node}` with tombstone-aware LWW, and per-namespace `read_all`/`merge_into`/`local_changes_since`/`cursor` from §4. If Phase 2 lands different shapes, reconcile names before implementing.

### 5.1 New Cargo deps

`src-tauri/Cargo.toml`: `chacha20poly1305 = "0.10"` (XChaCha20Poly1305, 24-byte nonce + AAD via the `Payload{msg,aad}` struct — needs `use chacha20poly1305::aead::{Aead, KeyInit, Payload, AeadCore}`), `hkdf = "0.12"`, `ed25519-dalek = { version = "2", features = ["rand_core","zeroize"] }` (`SigningKey::from_bytes(&[u8;32])` is **infallible**; `.sign()` needs `use ed25519_dalek::Signer`; `verify_strict` resists malleability), `bip39 = { version = "2", default-features = false, features = ["std"] }` (`from_entropy` returns `Result`; handle the Err arm), `argon2 = "0.5"`. Promote `getrandom = "0.2"` (⚠️ **FIX (reviewer):** uuid 1.23.3 pulls getrandom **0.4.2**, NOT 0.2.17 — three majors coexist; the direct `getrandom="0.2"` resolves to 0.2.17 and its API is `getrandom::getrandom(&mut buf)`; 0.3+ renamed it to `fill`), `sha2 = "0.10"`, `zeroize = { version = "1", features = ["derive"] }`.

Keychain (desktop-only — keyring 3.x has **no** Android backend, reviewer-confirmed):
```toml
[target.'cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))'.dependencies]
keyring = { version = "3", features = ["linux-native-sync-persistent","windows-native","apple-native"] }
```
⚠️ **HARD gate:** actually run `cargo check`, `cargo check --target x86_64-pc-windows-gnu`, `cargo check --target aarch64-linux-android` to prove the new graph (incl. keyring's zbus/secret-service) cross-compiles — assertion is not verification.

### 5.2 `crypto.rs` — key tree, accountId, seal/open, zeroize

`RootSecret([u8;32])` (`#[derive(Zeroize, ZeroizeOnDrop)]`). `generate_root` (getrandom), `root_to_phrase`/`phrase_to_root` (bip39 24-word, checksum-validated). Everything HKDF-derived: `Hkdf::<Sha256>::new(Some(b"aegis-sync-v1"), &root.0)` then `.expand(label, out)`. Labels: `account-id` → hex (non-reversible HKDF output, not the seed); `data-key:{ns}` → `chacha20poly1305::Key`. **Seal:** XChaCha20Poly1305, fresh random 24-byte nonce, `aad = [ns, b"|", uuid, b"|", hlc_bytes]` (binds ciphertext to identity+version so the server can't splice records). AAD must be canonical — namespaces are a fixed internal enum (no `|`), assert it. `open` rebuilds the same AAD; mismatch → Err. Register `mod crypto;`.

### 5.3 `sync_auth.rs` — restored Ed25519 signed-token auth tier

(This restores the per-device server auth the prior design dropped.) `AuthToken { account_id, device_id, device_pubkey_hex, issued_ms, expires_ms, nonce }`, **canonical fixed-field-order** serialization (serde key order is not stable). `mint(root, ttl)` signs with the device key; wire = header `Authorization: AegisSig {accountId}.{token_b64}.{sig_b64}`. `verify(token,sig)` checks expiry, reconstructs the VerifyingKey, `verify_strict`, confirms `device_id == hex(vk)`. Server-side authorization = signature valid **AND** pubkey ∈ the accountId's registered set (registration at pairing). Short TTL (~300s) + nonce defeats long-term replay. Honest residual: a stolen device key = full access until `removeDevice` revocation.

### 5.4 `sync_keystore.rs` — seed at rest

`trait SeedVault { store/load/clear }`. Desktop `KeyringVault` (cfg linux/windows/macos) via `keyring::Entry::new("com.aegis.browser","sync-root").set_secret/get_secret` — **on a dedicated thread** (keyring blocks; secret-service prompt on the UI thread would freeze the window; mirror the subs.rs spawn-join). Linux must **fall back to the passphrase file** when no secret-service daemon (headless/CI) — never panic. Android `AndroidKeystoreVault` (cfg android) via JNI → new `AegisKeystore.kt` wrapping the 32-byte root with a hardware AndroidKeyStore AES key. Passphrase fallback (all platforms): argon2id-derive a key + XChaCha20Poly1305-seal the root into `sync-vault.json` (atomic; **not** exported). The unwrapped `RootSecret` lives in memory only while unlocked (ZeroizeOnDrop on lock).

### 5.5 `sync.rs` — engine + state machine

`SyncState(Mutex<Inner>)`, `Inner { root: Option<RootSecret>, enabled, server_url, per_ns_cursor: HashMap, last_sync_ms, last_error, status }`, `SyncStatus = Idle|Syncing|Error|Disabled`. `sync_once(app)` on a dedicated thread (reqwest-blocking pattern from subs.rs/update.rs, proven on Android per update.rs:157): mint token → per namespace GET `/v1/records?ns&since` → decrypt (skip+log bad records, never crash) → `sync_stores::merge_into` (pull before push) → POST local changes with `baseCursor` (409 → re-pull + retry) → advance cursor → emit **targeted** `sync.changed {namespace, changedUuids}`. Triggers: periodic loop while enabled + on-mutation `sync::nudge(app)` (debounced). Boot: load vault; if root present + enabled, start the loop. Register `mod sync;` (ungated — compiles into the Android lib), `.manage(SyncState::default())` at lib.rs:344, and the `sync::dispatch` arm in `ipc()` before the fallthrough.

### 5.6 Device pairing + registration

The 24-word phrase **is** the pairing credential. `enableFromPhrase` derives the same accountId + data keys + a **distinct per-device signing key**: ⚠️ **device key = `HKDF(root, "device-sign:" + device_local_salt)`** where `device_local_salt` is 16 random bytes generated once per install (stored in the vault, not exported) — without it every install from the same phrase has an identical key and `removeDevice` can't target one device. On enable, POST `/v1/devices {accountId, devicePubkeyHex, label}`; `removeDevice` deregisters the pubkey (revocation). Consequence: restore-from-phrase creates a new device entry each time (acceptable; a "forget unused devices" affordance covers it).

### 5.7 Full IPC surface (all 3 places — see §6 table)

Commands `sync.getState`/`enableNew`/`enableFromPhrase`/`disable`/`syncNow`/`getRecoveryPhrase`/`listDevices`/`removeDevice`; events `sync.state`/`sync.changed`; the `syncServerUrl` settings field. `getRecoveryPhrase` is the highest-sensitivity channel — gated on `payload.confirm`, never logged. `enableNew` returns the phrase once (show-once-then-discard UI). On Android these go through the **same Tauri `invoke` path** (sync.rs is in the Android lib) — NOT the `AegisAndroid` content-WebView bridge — so ipcClient needs no androidBridge branch.

### 5.8 Backend-agnostic contract + recommended default

Encode the contract in `sync.rs` doc-comments (no .md per harness rules). Client depends only on: `Authorization: AegisSig {accountId}.{token}.{sig}`; `GET /v1/records?ns&since` → `{records:[{uuid,hlc,deleted,nonce_b64,ct_b64}], cursor}`; `POST /v1/records {ns,baseCursor,records}` → `{cursor}` | `409 {cursor}`; `POST /v1/devices`, `GET /v1/devices`, `POST /v1/devices/remove`. Server stores **opaque ciphertext** keyed `(accountId,ns,uuid)` + a per-`(accountId,ns)` monotonic cursor + a per-accountId registered-pubkey set; it cannot decrypt. Server auth = verify the signed token AND pubkey ∈ registered set (this is what rejects withhold/rollback/overwrite by unknown/removed devices). **Recommendation:** ship the client against the pluggable contract + provide a reference minimal Rust/axum blob+cursor server; default `syncServerUrl` empty (user pastes their endpoint), matching the project's self-hosted, GitHub-as-infra ethos. The server-side verifier MUST reuse the exact canonical serialization from §5.3 byte-for-byte (share the crypto code).

### 5.9 `useSync` hook + Sync settings tab

- **`shared/types.ts`:** add the channels/events + `SyncState`/`SyncDevice`/`SyncChanged` interfaces + the `aegis.sync` namespace + `syncServerUrl?` on `Settings`.
- **`ipcClient.ts`:** add the `sync` block (plain `call`/`on`, no androidBridge branch).
- **`src/hooks/useSync.ts`** (+ test): `getState` on mount, subscribe `onState`/`onChanged`; on `changed` publish to a tiny module-level `syncBus` (EventTarget) that domain hooks subscribe to for **targeted refetch** (NOT `window.location.reload()`); debounce bursts; unsubscribe on unmount. ⚠️ **FIX (reviewer):** 4 of 6 target hooks (`useFavorites`, `useSaved`, `useSettings`, `useSubscriptions`) fetch only on mount with **no extractable refetch** — they must be refactored to expose a refetch callback (touches their existing tests); `useHistory`/`useAdblock` already have one. This is required work, not a per-hook one-liner.
- **`src/components/SyncSettingsTab.tsx`** + add `'sync'` to `SettingsModal`'s `SettingsTab` union / `TAB_LABELS` / `TAB_ORDER` / props / panels / `tabIds`. Disabled → setup form (server URL + Start-new [shows phrase once, clears on confirm] / Restore-from-phrase [24-word textarea]). Enabled → status + Sync-now + Show-phrase (gated behind a confirm dialog) + devices list (Remove per other device) + Disable (forget-keys checkbox). Same modal renders on Android; verify clipboard works in the System WebView, fall back to a selectable textarea.

### 5.10 Seed/keys excluded from `data.export`

`sync-vault.json` + `device_local_salt` are their own jsonstore files, NOT in the export store list → already excluded. Add a defensive redaction constant + a Rust unit test asserting the export bundle contains no `sync-vault`/`root`/`device-sign`/`recoveryPhrase` substring. `syncServerUrl` (non-secret) may export. The vault write is atomic regardless (a corrupt vault = lost root = lost access).

### 5.11 Android parity pass

Ensure `mod sync/crypto/sync_auth/sync_keystore` are ungated (compiled into `libapp_lib.so`); only the keyring vault is desktop-gated, Android uses the JNI Keystore. Build under JDK 21. On emulator/device: enable sync, phrase shows, a 2nd instance restoring from the phrase converges (favorites/saved/allowlist), root survives restart (Keystore-anchored), `data.export` has no vault. Android Keystore + JNI is device-only-verifiable (reviewer: high risk).

---

## 6. Consolidated IPC & settings appendix

| Name | Kind | PLACE 1 `shared/types.ts` | PLACE 2 Rust | PLACE 3 `ipcClient.ts` |
|------|------|---------------------------|--------------|------------------------|
| `webrtcPolicy` | setting-field | `Settings.webrtcPolicy: 'default'|'public-only'|'disable'` (~256-267) | `settings.rs defaults()` += `"webrtcPolicy":"public-only"`; reader `webrtc_policy(app)`; **no dispatch arm** (shallow-merge) | none (rides `settings.set`) |
| `AegisAndroid.setWebrtcPolicy` | native bridge (NOT a Tauri channel) | not in `IPC`; add to `AndroidBridge` iface (~32-56) + exported helper | JNI/Kotlin bridge method in MainActivity; not in `ipc()` | thin helper alongside `setFullscreen` |
| `syncServerUrl` | setting-field | `Settings.syncServerUrl?: string` | `settings.rs defaults()` += `"syncServerUrl":""` | none (rides `settings.set`) |
| `sync.getState` | command | `syncGetState` + `getState():Promise<SyncState>` | `sync::dispatch` arm | `call<SyncState>(IPC.syncGetState)` |
| `sync.enableNew` | command | `syncEnableNew` + `enableNew(opts):Promise<{recoveryPhrase}>` | gen root, vault, register, start loop | `call<{recoveryPhrase}>(…,{...opts})` |
| `sync.enableFromPhrase` | command | `syncEnableFromPhrase` + `enableFromPhrase(opts):Promise<SyncState>` | phrase→root, vault, register, start | `call<SyncState>(…,{...opts})` |
| `sync.disable` | command | `syncDisable` + `disable(opts?):Promise<SyncState>` | stop loop, zeroize root, opt clear | `call<SyncState>(…,{...(opts??{})})` |
| `sync.syncNow` | command | `syncNow` + `syncNow():Promise<SyncState>` | one `sync_once` | `call<SyncState>(IPC.syncNow)` |
| `sync.getRecoveryPhrase` | command | `syncGetRecoveryPhrase` + `getRecoveryPhrase({confirm}):Promise<{recoveryPhrase}>` | **gated** on confirm + unlocked; never logged | `call<{recoveryPhrase}>(…,{...opts})` |
| `sync.listDevices` | command | `syncListDevices` + `listDevices():Promise<SyncDevice[]>` | GET `/v1/devices` | `call<SyncDevice[]>(…)` |
| `sync.removeDevice` | command | `syncRemoveDevice` + `removeDevice(id):Promise<SyncDevice[]>` | POST remove (revoke pubkey) | `call<SyncDevice[]>(…,{deviceId:id})` |
| `sync.state` | event | `evtSyncState` + `onState(cb)` | `emit_event(app,"sync.state",…)` (.→:) | `on<SyncState>(IPC.evtSyncState,cb)` |
| `sync.changed` | event | `evtSyncChanged` + `onChanged(cb)` + `SyncChanged{namespace,changedUuids}` | `emit_event` per ns after `merge_into`; **targeted, never reload** | `on<SyncChanged>(…)` → `syncBus` → per-hook refetch |

New interfaces: `SyncState{enabled,status,serverUrl,lastSyncMs,lastError,deviceId,accountId,vaultBacking:'keychain'|'passphrase'|'none'}`, `SyncDevice{deviceId,label,lastSeenMs,isThisDevice}`, `SyncChanged{namespace,changedUuids}`.

---

## 7. Consolidated test plan

**Rust-unit (`cargo test`):**
- F0: `write_atomic`/`read_with_backup`/`read_text_with_backup` (corrupt-primary→.bak recovery, missing-both→None) using a tempdir; updated `script(&InjectConfig::default())` popup-guard test; whole-crate regression (adblock_inject + nav + tab_registry 24 all green).
- F1: `keep_candidate`/`filter_sdp`/`shim_for` incl. IPv6 forms + fail-open fuzz (random/truncated lines) — testing the **shipped JS artifact**, not a parallel copy.
- F2a: HLC `tick`/`observe` monotonicity + tie-break (~8); jsonstore meta helpers `ensure_sync_meta`/`stamp_new`/`tombstone`/`touch`/`live`/`load_synced` (~10); places tombstone+revive+persist-returns-live (~6); history clear/remove/dup-guard (~4); settings per-key projection incl. the resurrection-trap fix (~5); allowlist persistence + restart-seed (~4); `sync_stores::merge_into` LWW over tombstones + changed-store report (~8); `adblock_engine` new `Reload` message.
- F2b: crypto seal/open round-trip + AAD binding (wrong ns/uuid/hlc fails) + phrase↔root + accountId determinism + distinct data keys; `sync_auth` mint→verify, tampered/expired/wrong-key fail, `device_id==hex(vk)`; passphrase argon2 wrap/unwrap; `data.export` contains no seed material.

**Vitest (`npm test`, ~413 stay green unchanged):**
- F1: SecurityTab select + useSettings.
- F2b: useSync (mount getState, onState, onChanged→targeted refetch, unsubscribe, phrase-once); the 6 domain hooks refetch on matching `syncBus` namespace and ignore others; SyncSettingsTab + SettingsModal tab; `shared/types.test.ts` accepts the new dotted channels (+ the new dot-separated/unique invariant from F0).

**Manual-device:**
- F0: `cargo check --target aarch64-linux-android` + JDK-21 build (HARD gate); Android pages get popup guard + injected ad-block (previously nothing), `setOf("*")` accepted, DOCUMENT_START fires pre-page-script.
- F1: Linux real-HW leak-test (all 3 policies via browserleaks/self-hosted ICE dump, spectacle capture) + Worker scope-test recording the §3.7 matrix; Win/mac/Android via CI-compile + cross-`cargo check`, GUI follow-up.
- F2a: install over a pre-envelope profile (Linux HW + Android emulator) — data lists intact (lazy migration), remove→on-disk `deleted=true` + list omits, allowlist survives restart, sub change re-applies ad-block on every platform.
- F2b: Android end-to-end (enable, phrase, 2nd-instance convergence, restart-survival, export-has-no-vault) under JDK 21; desktop keyring-survives-restart (Linux HW; Win/mac via CI artifacts/user session) + secret-service-absent → passphrase fallback (no panic) + two-profile convergence.

---

## 8. Migration & backward-compat

- **F0:** no on-disk format change. `load()` sources through `read_with_backup` (a superset of `read_to_string`); first write creates a transient process-unique `.tmp` and a `.bak`. Corrupt-recovery is strictly better than today's silent-empty. `script()` change is internal Rust (only nav.rs + the test). Android injection is additive (worst case if `DOCUMENT_START_SCRIPT` unsupported = today's no-injection, feature-gated). No Cargo.lock churn, no audit-gate impact.
- **F1:** existing `settings.json` without `webrtcPolicy` resolves to `'public-only'` (defaults overlay). This **changes default behavior** (private-IP leak now filtered) — intentional privacy improvement; a LAN-WebRTC user switches to `'default'` or allowlists the host. The `as never` cast in `SecurityTab.test.tsx` means the new required field breaks no test. `webrtcPolicy` rides export/import (falls to default on a key-less old backup).
- **F2a:** `load` (`unwrap_or_default`) tolerates extra keys — old files parse, `load_synced` assigns missing meta once. Renderer reads go through `live()` + keep original fields, so `shared/types.ts` interfaces are unchanged and the ~413 vitest tests (mocked IPC, never touch Rust) stay green. `settings.json` flat + getters byte-identical (per-key clocks live in `settings-sync.json`). `custom-filters.txt` plain (clocks in `custom-filters-sync.json`). Allowlist gains persistence (strictly better). Export version 1→2; both interoperate. Downgrade safe (old build ignores extra keys).
- **F2b:** opt-in (Disabled default, no vault, no network) — a never-enabled user is unaffected. Settings "delete a key = reset to default" via the per-key tombstone projection. Importing an old export never wipes sync vault state (vault not in the bundle). Wire format carries the HKDF label `aegis-sync-v1` for future cipher/KDF versioning.
- **Existing `#[cfg(test)]` suites** (tab_registry 24, update 2, adblock_engine) untouched except adblock_engine gaining the `Reload` test.

---

## 9. Open product decisions (recommendations)

1. **Sync backend host (the one real product fork).** Options: (a) user-self-hosted minimal Rust/axum blob+cursor service, (b) a managed endpoint the project runs, (c) GitHub-Releases/Gist-as-store hack. **Recommend (a)** — pluggable via `syncServerUrl` (default empty), ship the reference axum server, matching the project's self-reliant, updater-via-GitHub-Releases ethos. Needs the user's call.
2. **Auth posture.** Per-device Ed25519 signed tokens + server-side registered-pubkey set (restored). Honest residual: stolen device key = access until `removeDevice`. Confirm acceptable; `getRecoveryPhrase` gated on `confirm` (optionally Android Keystore user-auth) — confirm whether biometric re-auth is required.
3. **History sync** is large/privacy-sensitive. **Recommend a per-namespace toggle in the Sync tab, history OFF by default** (Brave-style). Also resolves the history capped-eviction asymmetry (§4.5): if history syncs, an aged-out record on A re-syncs from B (converges to the per-device-capped union — acceptable for personal use, or make history non-syncable).
4. **Downloads sync.** They reference device-specific `savePath`. **Recommend retrofitting the envelope for delete-hygiene but EXCLUDING downloads from `SYNCABLE`** (don't push over the wire). Confirm.
5. **Allowlist coupling.** The WebRTC escape hatch reuses the adblock allowlist, conflating "trust this site's ads" with "expose my local IP to this site." The brief directed reuse; confirm the coupling is acceptable vs. an independent WebRTC hatch.
6. **Conflict UX.** Silent HLC-LWW for v1 (no conflict UI) — acceptable for single-owner personal data. Confirm.
7. **Device-key derivation tradeoff.** Per-install salt (distinct keys, `removeDevice` works) means restore-from-phrase creates a new device entry each time — recommend per-install salt + a "forget unused devices" affordance.

---

**Files cited (all absolute):** `/home/happyhobo/Documents/AI_Apps/Aegis/src-tauri/src/{jsonstore.rs,adblock_inject.rs,lib.rs,settings.rs,customfilters.rs,data.rs,subs.rs,history.rs,downloads.rs,places.rs,adblock.rs,adblock_engine.rs,nav.rs,linux_layout.rs,picker.rs}`, new `/home/happyhobo/Documents/AI_Apps/Aegis/src-tauri/src/{webrtc_shim.rs,sync_envelope.rs,sync_identity.rs,sync_stores.rs,adblock_refresh.rs,crypto.rs,sync_auth.rs,sync_keystore.rs,sync.rs}`, `/home/happyhobo/Documents/AI_Apps/Aegis/src-tauri/Cargo.toml`, `/home/happyhobo/Documents/AI_Apps/Aegis/src-tauri/gen/android/app/src/main/java/com/aegis/browser/{MainActivity.kt,NativeInject.kt,NativeWebrtc.kt,AegisKeystore.kt}`, `/home/happyhobo/Documents/AI_Apps/Aegis/src-tauri/gen/android/app/build.gradle.kts`, `/home/happyhobo/Documents/AI_Apps/Aegis/shared/types.ts`, `/home/happyhobo/Documents/AI_Apps/Aegis/src/lib/ipcClient.ts`, `/home/happyhobo/Documents/AI_Apps/Aegis/src/lib/tauriInvoke.ts`, `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/{useSettings.ts,useSync.ts,useFavorites.ts,useSaved.ts,useHistory.ts,useSubscriptions.ts,useAdblock.ts}`, `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/{SecurityTab.tsx,SyncSettingsTab.tsx,SettingsModal.tsx}`.
