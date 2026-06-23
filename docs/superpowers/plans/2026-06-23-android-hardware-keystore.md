# Sub-project J — Android hardware-Keystore anchor (finish S3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anchor the 32-byte E2E-sync/vault root seed in Android secure hardware (StrongBox where present, else the TEE) by making the already-wired Rust→Kotlin JNI keystore up-call use a `StrongBox`-preferring `KeyGenParameterSpec`, while keeping the passphrase/in-memory fallback intact — so `VaultBacking::Keychain` on Android means a hardware-non-exportable AES key wraps the seed.

**Architecture:** The seed-at-rest selection logic in `sync_keystore.rs` already routes Android through `android_keystore::wrap`/`unwrap`, which up-call the Kotlin `AegisKeystore.wrap([B)Ljava/lang/String;` / `unwrap(Ljava/lang/String;)[B` over JNI (the `JavaVM` is captured in `JNI_OnLoad`, never `ndk_context` — see Global Constraints). `AegisKeystore.kt` already does a real `AndroidKeyStore` AES-256-GCM wrap via `KeyGenParameterSpec`, but it does **not** request StrongBox, so on devices with a Secure Element the key lands in the TEE rather than the strongest available hardware. This plan (1) makes the Kotlin keygen prefer StrongBox with a graceful retry to TEE when StrongBox is unavailable (the dominant device case — emulators and most phones have no `FEATURE_STRONGBOX_KEYSTORE`), (2) adds Rust unit tests for the platform-agnostic backing-selection/round-trip invariants that hold on every target, and (3) closes the verification loop: the documented `cargo check --target aarch64-linux-android` Rust gate, the `compileUniversalDebugKotlin` Kotlin gate, and a manual on-device wrap/unwrap verify. **No new IPC channel, no new UI** — `SyncState.vaultBacking` already exists (`shared/types.ts:309`) and already shows `"keychain"` when the keystore path succeeds; this sub-project only deepens the hardware guarantee behind that existing string.

**Tech Stack:** Rust JNI (the `jni = "0.21"` crate, android-gated in `Cargo.toml`), Kotlin (`AndroidKeyStore` / `KeyGenParameterSpec` / `Cipher AES/GCM/NoPadding`), the Android Keystore system (StrongBox `KeyStore` provider where `PackageManager.FEATURE_STRONGBOX_KEYSTORE` is present, else TEE).

## Global Constraints

These project-wide rules (from the spec §6 and the repo CLAUDE.md) apply to **every** task below; each task's requirements implicitly include this section.

- **JNI_OnLoad, NEVER ndk_context.** Any Rust→Java up-call in this Tauri Android app must reach the `JavaVM` via the `JNI_OnLoad`-captured `OnceLock<JavaVM>` (already in `sync_keystore.rs::android_keystore`) and wrap the up-call body in `std::panic::catch_unwind(AssertUnwindSafe(...))`. Tauri does NOT run ndk-glue, so `ndk_context::android_context()` panics, and that panic aborts (SIGABRT) across the non-unwinding `Rust_ipc` JNI frame. Do not reintroduce `ndk_context` (the `fix(android)` at commit `03f0012` removed it). This already exists — do not regress it.
- **No invented JNI signatures.** The Kotlin method descriptors used from Rust must match the Kotlin source byte-for-byte: `wrap([B)Ljava/lang/String;` and `unwrap(Ljava/lang/String;)[B` on class `com/aegis/browser/AegisKeystore`, both `@JvmStatic`, both returning null on any failure. Do not change these signatures (the Rust `call_static_method` calls in `android_keystore` depend on them exactly).
- **Fail-safe to the existing fallback, never crash.** Every keystore path must degrade to the passphrase-wrapped vault (or in-memory-only) on ANY error — `with_env` returns `None` on a missing VM or a panic; the Kotlin `wrap`/`unwrap` return `null` inside `try { … } catch (t: Throwable) { null }`. The worst case must be identical to "this path didn't exist."
- **Parity before "done"** (CLAUDE.md): the seed-at-rest contract is `Keychain` (OS-hardware) → `Passphrase` → `None` on every platform. Desktop already gets the OS keychain via the `keyring` crate; this sub-project brings **Android** to the same "hardware-anchored when available" level. Do not leave Android weaker than desktop without it being a documented hardware limit (StrongBox-vs-TEE IS such a documented, device-dependent fact, not a gap).
- **IPC unchanged.** No new `IPC` channel: this sub-project adds none. `SyncState.vaultBacking` (`shared/types.ts:309`, the `'keychain' | 'passphrase' | 'none'` union) is unchanged — Android already reports `"keychain"` when `store_root` returns `VaultBacking::Keychain`. Therefore the autopilot drift-guard requires **no** new `catalog.ts`/`screens.ts` entry for this work (no new channel, screen, overlay, or interactive control is introduced). Confirm this explicitly in the final task rather than assuming.
- **Verification reality (spec §4):** Linux = the Rust unit tests + `cargo test` (the backing-selection/round-trip invariants are platform-agnostic and run here). Android device = the only place the JNI up-call + hardware wrap can be confirmed; the on-device wrap/unwrap verify is the closing gate. Android **compile** gates (`cargo check --target aarch64-linux-android` and `compileUniversalDebugKotlin`) DO run on this Linux host (NDK 27 + JBR 21 installed). Windows/macOS are unaffected by this change (their `#[cfg]` blocks are untouched).

---

## Current-state findings (read before starting — this is a "finish/verify", not a "build")

A survey established the real state, correcting the spec's §1.1 line ("documented but not connected"):

1. **`AegisKeystore.kt` EXISTS** at `src-tauri/gen/android/app/src/main/java/com/aegis/browser/AegisKeystore.kt` and already does a **real hardware-backed** AES-256-GCM wrap: it generates/loads a non-exportable key in the `AndroidKeyStore` via `KeyGenParameterSpec.Builder(ALIAS, ENCRYPT|DECRYPT).setBlockModes(GCM).setEncryptionPaddings(NONE).setKeySize(256)`, and `wrap`/`unwrap` produce/consume `base64(iv ‖ ct+tag)`. It does **not** call `setIsStrongBoxBacked(true)` — that is the one substantive deepening this sub-project makes.
2. **The Rust JNI path is ALREADY WIRED AND CALLED** (not dead, not documented-only): `sync.rs` calls `sync_keystore::store_root` (line 369), `has_stored_root` (441), `load_root` (446), and `clear_root` (534). Each of those four functions has a `#[cfg(target_os = "android")]` block that calls `android_keystore::wrap`/`unwrap` and reads/writes `sync-keystore-vault.json`. `JNI_OnLoad` (sync_keystore.rs:172) captures the VM into a `OnceLock<JavaVM>`; `mod sync_keystore` is declared in `lib.rs:72`; `jni = "0.21"` is android-gated in `Cargo.toml`.
3. **The Android keystore connection was already fixed and device-verified** at commit `03f0012` ("fix(android): sync Restore/enable aborts the app — capture JavaVM in JNI_OnLoad", on a Galaxy S23) — that is what made the spec's "documented but not connected" line stale. So sub-project J is **finish + harden + re-verify**, NOT build-from-scratch.

**Therefore the genuine remaining work is exactly:**

- (J1) Make the Kotlin keygen prefer **StrongBox**, retrying without it when the device lacks a Secure Element (so `Keychain` means the strongest hardware the device has).
- (J2) Add Rust **unit-test coverage** for the backing-selection invariants that are testable off-device (the `VaultBacking` enum contract + passphrase round-trip already partly covered — extend, don't duplicate).
- (J3) Run the **two compile gates** (`cargo check --target aarch64-linux-android`, `compileUniversalDebugKotlin`) and the **manual device** wrap/unwrap verify, and confirm the autopilot/IPC drift-guard needs no new entry.

---

## File Structure

| File                                                                         | Responsibility                                                                                                                                                | Change                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src-tauri/gen/android/app/src/main/java/com/aegis/browser/AegisKeystore.kt` | Hardware wrap/unwrap of the seed via `AndroidKeyStore`.                                                                                                       | **Modify** — make `secretKey()` prefer StrongBox with a TEE fallback; keep the exact `wrap([B)…`/`unwrap(…)[B` JvmStatic signatures + null-on-failure contract.                                                                                                    |
| `src-tauri/src/sync_keystore.rs`                                             | Seed-at-rest selection (`store_root`/`load_root`/`has_stored_root`/`clear_root`), the `android_keystore` JNI up-call, `VaultBacking`, passphrase wrap/unwrap. | **Modify** — add `#[test]`s for the platform-agnostic invariants (`VaultBacking::as_str` mapping, passphrase round-trip tamper-rejection). The android JNI code is already correct — do **not** touch its signatures or the `JNI_OnLoad`/`catch_unwind` structure. |

No other files change. No new module, no new IPC channel, no UI, no autopilot catalog/screen entry (confirmed in Task 4).

---

### Task 1: Make the Android keystore prefer StrongBox (graceful TEE fallback)

**Files:**

- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/AegisKeystore.kt` (the `secretKey()` private fn)

**Interfaces:**

- Consumes: nothing new — `secretKey()` is private and is already called by `wrap`/`unwrap`.
- Produces: unchanged public surface — `@JvmStatic fun wrap(data: ByteArray): String?` and `@JvmStatic fun unwrap(blob: String): ByteArray?`, both on `object AegisKeystore` in package `com.aegis.browser`, both returning `null` on any failure. The Rust descriptors `([B)Ljava/lang/String;` / `(Ljava/lang/String;)[B` MUST keep matching — do not rename or re-sign these methods.

**Why:** `KeyGenParameterSpec.Builder(...).setIsStrongBoxBacked(true)` requests a key bound to a hardware Secure Element. On a device WITHOUT one (most phones, all emulators — no `FEATURE_STRONGBOX_KEYSTORE`), `kg.init(...)` / `generateKey()` throws `StrongBoxUnavailableException` (API 28+). So we try StrongBox first and, on `StrongBoxUnavailableException`, retry the identical spec without StrongBox (the existing TEE/software-backed behavior). Net effect: strongest-available hardware, never a regression. `setIsStrongBoxBacked` is API 28; `minSdk = 24`, so the call is wrapped in an API-level guard (`Build.VERSION.SDK_INT >= P`) — below P we go straight to the non-StrongBox path (today's behavior).

- [ ] **Step 1: Read the current file to anchor the edit**

Run: open `src-tauri/gen/android/app/src/main/java/com/aegis/browser/AegisKeystore.kt`.
Expected: it matches the survey — `secretKey()` builds a single `KeyGenParameterSpec` with no StrongBox, and `wrap`/`unwrap` already `try { … } catch (t: Throwable) { null }`. Note the existing imports (`KeyGenParameterSpec`, `KeyProperties`, `KeyStore`, `Cipher`, `KeyGenerator`, `SecretKey`, `GCMParameterSpec`, `Base64`).

- [ ] **Step 2: Add the `android.os.Build` import**

Add this import alongside the existing ones near the top of the file (after `import android.security.keystore.KeyProperties`):

```kotlin
import android.os.Build
```

- [ ] **Step 3: Replace `secretKey()` to prefer StrongBox with a TEE fallback**

Replace the entire existing `private fun secretKey(): SecretKey { … }` block with:

```kotlin
  private fun secretKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    // No key yet — generate a non-exportable AES-256-GCM key bound to secure hardware.
    // Prefer a StrongBox Secure Element where the device has one; gracefully fall back to
    // the TEE/software-backed key (today's behavior) when StrongBox is unavailable, so this
    // never regresses on the common no-Secure-Element device (emulators, most phones).
    fun spec(strongBox: Boolean) =
      KeyGenParameterSpec.Builder(
        ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .apply { if (strongBox) setIsStrongBoxBacked(true) }
        .build()

    val kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      try {
        kg.init(spec(true))
        return kg.generateKey()
      } catch (_: android.security.keystore.StrongBoxUnavailableException) {
        // No Secure Element — re-init the SAME generator without StrongBox.
      }
    }
    kg.init(spec(false))
    return kg.generateKey()
  }
```

Notes for the implementer:

- `setIsStrongBoxBacked` is guarded by `SDK_INT >= P` (API 28) because it doesn't exist below P; `minSdk` is 24, so this guard is required to compile-and-run on 24–27.
- `StrongBoxUnavailableException` is `android.security.keystore.StrongBoxUnavailableException` (API 28+). Catching it inside the `>= P` branch is safe — that class is only referenced where the SDK guarantees it.
- Do **not** add `setUserAuthenticationRequired(true)`: the seed must unwrap at boot with no user present (`sync::start` → `load_root(app, None)` auto-unlocks). Requiring auth would break headless boot auto-unlock — which is exactly the fail-safe-to-passphrase path we are trying to make unnecessary on Android.
- The `wrap`/`unwrap` methods are unchanged — leave them exactly as-is (their `@JvmStatic` + `String?`/`ByteArray?` signatures back the Rust descriptors).

- [ ] **Step 4: Kotlin compile gate**

This is the Kotlin gate from the Android build-gates note. From `src-tauri/gen/android/`:

```bash
export JAVA_HOME=~/development/android-studio/jbr
export ANDROID_HOME=~/development/android-sdk
./gradlew :app:compileUniversalDebugKotlin
```

Expected: `BUILD SUCCESSFUL`. (The task is **flavored** — a bare `compileDebugKotlin` fails as ambiguous between the `arm` and `universal` flavors; use `compileUniversalDebugKotlin`. This task does NOT build the Rust `.so`, so it's fast.) If it fails on `StrongBoxUnavailableException` resolution, confirm the import path is `android.security.keystore.StrongBoxUnavailableException` and that it's referenced only inside the `>= P` branch.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/AegisKeystore.kt
git commit -m "feat(android): prefer StrongBox for the sync-seed keystore key (TEE fallback)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rust unit tests for the platform-agnostic backing invariants

**Files:**

- Modify: `src-tauri/src/sync_keystore.rs` (the existing `#[cfg(test)] mod tests` block at the bottom)

**Interfaces:**

- Consumes: `VaultBacking` (the `Keychain | Passphrase | None` enum and its `as_str()`), `wrap_with_passphrase`, `unwrap_with_passphrase`, `RootSecret` — all already in this file (RootSecret re-exported via `use super::*`).
- Produces: nothing consumed downstream; pure test coverage.

**Why:** The Android hardware path itself is device-only (the JNI up-call needs a JVM). But the **selection contract** that surrounds it — what `VaultBacking` maps to in the UI string, and that the fallback (passphrase wrap) round-trips and rejects tampering — is platform-agnostic and runs in `cargo test` on Linux. The existing tests cover passphrase round-trip, wrong-passphrase, and fresh-salt; we add the `VaultBacking::as_str` mapping (the value the chrome reads via `SyncState.vaultBacking`) and a tamper-rejection test, so a regression to either the backing labels or the fallback's authentication is caught in CI on every push — not just on a phone.

- [ ] **Step 1: Write the failing tests**

Add these two `#[test]` functions inside the existing `#[cfg(test)] mod tests { … }` block in `src-tauri/src/sync_keystore.rs` (after `wrap_uses_a_fresh_salt_each_time`):

```rust
    #[test]
    fn vault_backing_maps_to_the_ui_strings() {
        // These exact strings back SyncState.vaultBacking in shared/types.ts
        // ('keychain' | 'passphrase' | 'none'); a rename here desyncs the chrome.
        assert_eq!(VaultBacking::Keychain.as_str(), "keychain");
        assert_eq!(VaultBacking::Passphrase.as_str(), "passphrase");
        assert_eq!(VaultBacking::None.as_str(), "none");
    }

    #[test]
    fn passphrase_fallback_rejects_a_tampered_blob() {
        // The fallback used whenever the keychain/keystore is unavailable must fail
        // authentication on a corrupted ciphertext rather than returning garbage bytes.
        let root = RootSecret([7u8; 32]);
        let blob = wrap_with_passphrase(&root, "pw").unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&blob).unwrap();
        // Flip a hex nibble in the ciphertext (still valid hex, wrong bytes).
        let ct = v["ct"].as_str().unwrap().to_string();
        let mut chars: Vec<char> = ct.chars().collect();
        chars[0] = if chars[0] == '0' { '1' } else { '0' };
        v["ct"] = serde_json::Value::String(chars.into_iter().collect());
        let tampered = serde_json::to_string(&v).unwrap();
        assert!(unwrap_with_passphrase(&tampered, "pw").is_err());
    }
```

- [ ] **Step 2: Run them to verify they pass (these assert already-correct behavior)**

Run: from `src-tauri/`,

```bash
cargo test --lib sync_keystore::tests::vault_backing_maps_to_the_ui_strings \
           sync_keystore::tests::passphrase_fallback_rejects_a_tampered_blob -- --nocapture
```

Expected: `2 passed`. (Unlike a from-scratch TDD red phase, these lock in existing invariants — they should pass immediately. If `vault_backing_maps_to_the_ui_strings` fails, the `as_str()` mapping drifted from `shared/types.ts`; if the tamper test fails, the AEAD authentication in `crypto::open` regressed — investigate before proceeding, do not "fix" the test to match.)

- [ ] **Step 3: Run the whole module's tests to confirm no regression**

Run: from `src-tauri/`,

```bash
cargo test --lib sync_keystore
```

Expected: all `sync_keystore::tests::*` pass (the original three + the two new ones = 5 passed).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sync_keystore.rs
git commit -m "test(android): cover VaultBacking string mapping + passphrase-fallback tamper rejection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Android compile gate (Rust `cargo check` for the android target)

**Files:** none modified — this task is a gate that proves the android-gated code (the `android_keystore` JNI module, untouched, plus everything it sits beside) still type-checks for `aarch64-linux-android`. The Kotlin change in Task 1 does not affect Rust, but the Rust android cfg-blocks are only compiled by this target, so run it to be certain nothing in the wider android build regressed alongside this sub-project.

**Interfaces:** none.

- [ ] **Step 1: Run the Rust android cross-check**

This is the documented gate; the toolchain is present on this host (NDK 27 + the aarch64-linux-android target installed). From `src-tauri/`:

```bash
export ANDROID_NDK_HOME=~/development/android-sdk/ndk/27.0.12077973
TC=$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin
export CC_aarch64_linux_android=$TC/aarch64-linux-android24-clang
export AR_aarch64_linux_android=$TC/llvm-ar
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$TC/aarch64-linux-android24-clang
cargo check --target aarch64-linux-android
```

Expected: `Finished` with no errors (warnings tolerated). This compiles the `#[cfg(target_os = "android")] mod android_keystore` block, `JNI_OnLoad`, the four android `#[cfg]` arms in `store_root`/`load_root`/`has_stored_root`/`clear_root`, and the `jni = "0.21"` android dep — none of which the default `cargo check` (or the Windows cross-check) compiles. If this is the first run, `jni` and the android target std may need to download/build; that's expected.

- [ ] **Step 2: No commit (this task produces no file change)**

Nothing to commit. Record the `cargo check --target aarch64-linux-android` output as the gate evidence for the sub-project's verification log.

---

### Task 4: Confirm IPC/autopilot drift-guard needs no new entry; parity + device verify

**Files:** none modified (this is the verification-and-parity closing task). Two of its checks are runnable on this Linux host; the third (device wrap/unwrap) is hardware-gated and is the honest "done" condition.

**Interfaces:** none.

- [ ] **Step 1: Prove no new IPC channel / autopilot entry is required**

This sub-project introduces no new `IPC` channel, no new UI screen/overlay, and no new interactive control — it deepens the hardware guarantee behind the already-existing `SyncState.vaultBacking` string. Confirm, don't assume:

```bash
# No new channel name was added by this sub-project:
git diff main -- shared/types.ts
# The vaultBacking union is unchanged and still present:
grep -n "vaultBacking" shared/types.ts
# The drift guard still passes (it fails the build if a channel lacks a catalog entry):
npm test -- src/autopilot/coverage.test.ts
```

Expected: `git diff` shows no change to `shared/types.ts` from this sub-project; `grep` shows `vaultBacking: 'keychain' | 'passphrase' | 'none';`; the coverage test passes. Because no channel/screen/control was added, the drift-guard requires no new `catalog.ts` or `screens.ts` entry for J — this step is the evidence of that.

- [ ] **Step 2: Full unit-test gate (Rust + JS)**

```bash
# Rust core:
( cd src-tauri && cargo test )
# JS/vitest tour + drift guard:
npm test
```

Expected: `cargo test` green (includes the five `sync_keystore::tests::*`); `npm test` green. This is the spec §6 per-sub-project gate's non-runtime half. (No runtime autopilot ad-block trace is needed for J: it changes neither navigation nor ad-block — it only changes how the Android keystore key is generated. State that explicitly in the verification log.)

- [ ] **Step 3: Manual on-device wrap/unwrap verify (hardware-gated — the real "done")**

The JNI up-call + hardware wrap can ONLY be confirmed on a device. Build the arm64 debug APK (needs JDK 21 — the JBR — per gotcha 8), install to a real phone, and verify the keystore path is taken and round-trips:

```bash
# Build the arm64 debug APK (device is arm64-v8a):
JAVA_HOME=~/development/android-studio/jbr npm run android:build -- --target aarch64
# Confirm which package is actually installed BEFORE testing (debug = com.aegis.browser.debug,
# a SEPARATE package from release com.aegis.browser — installing -r the wrong one tests stale code):
adb shell pm list packages | grep aegis
adb install -r <path-to-the-just-built-debug-apk>
adb logcat -c   # clear, then watch:
adb logcat | grep -iE "aegis|keystore|AndroidKeyStore|StrongBox|SIGABRT|ndk"
```

Then, in the app: **Settings → Sync → Start new sync** (this calls `store_root` → `android_keystore::wrap` → `AegisKeystore.wrap`). Expected, on a real device:

- The app does **NOT** close/crash (the `03f0012` JNI_OnLoad fix prevents the old SIGABRT; this task confirms the StrongBox change didn't reintroduce a crash). No `ndk_context`/`SIGABRT` in logcat.
- The UI shows the sync backing as **keychain** (driven by `SyncState.vaultBacking`), confirming `store_root` returned `VaultBacking::Keychain` (i.e. `wrap` succeeded and `sync-keystore-vault.json` was written) rather than falling through to passphrase/none.
- **Auto-unlock round-trip:** force-stop and relaunch the app. `sync::start` → `has_stored_root` (sees `sync-keystore-vault.json`) → `load_root(app, None)` → `android_keystore::unwrap` → `AegisKeystore.unwrap` must return the same 32 bytes, so sync re-enables at boot with no passphrase. Confirm sync shows enabled/keychain after relaunch.
- **Fallback still works headless:** there's no clean way to remove the Secure Element on a real device, but the StrongBox→TEE fallback in Task 1 means a no-Secure-Element device simply lands in the TEE and still reports `keychain` — verify on whatever device is available that the round-trip succeeds regardless of whether the device advertises StrongBox. (If a StrongBox device is available, `adb shell pm list features | grep strongbox` confirms `android.hardware.strongbox_keystore`; the key is then SE-bound. This is best-effort — its presence is device-dependent and is the documented hardware-tier limit, not a gap.)

Record the device, Android version, whether StrongBox was present, and the observed `keychain` backing + relaunch auto-unlock as the verification evidence. If a device is unavailable in this session, mark this step **explicitly pending** ("compile-gated green on Linux; device wrap/unwrap PENDING a phone") rather than claiming completion — per the repo's verify-don't-guess rule.

- [ ] **Step 4: Update the roadmap/status line for S3 (parity bookkeeping)**

Sub-project B owns the broad `FEATURE_ROADMAP.md` reconcile, but this sub-project's completion changes the S3 status. After the device verify passes, ensure the S3 line reflects reality: Android hardware-Keystore anchor is **connected and StrongBox-preferring** (was "documented but not connected" — already stale, now closed). If `FEATURE_ROADMAP.md` or a CLAUDE.md status line still says S3 is partial/unconnected for Android, correct it in this commit (coordinate with sub-project B to avoid a conflicting edit). Commit any such doc correction:

```bash
git add -A
git commit -m "docs: S3 Android hardware Keystore anchored (StrongBox-preferring, device-verified)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If no doc line needs changing (B already handled it), skip the commit and note that in the log.

---

## Self-Review

**1. Spec coverage (§ J — "Connect the Rust JNI path to the existing `AegisKeystore.kt` so the sync/vault seed is hardware-anchored on Android (StrongBox/`KeyGenParameterSpec`), keeping the passphrase fallback. Acceptance: Android device wraps/unwraps via hardware Keystore; fallback still works headless"):**

- "Hardware-anchored on Android (StrongBox/KeyGenParameterSpec)" → **Task 1** adds `setIsStrongBoxBacked(true)` with the TEE fallback; the existing `KeyGenParameterSpec` is retained.
- "Connect the Rust JNI path" → the survey established it is **already connected** (callers in `sync.rs`, `JNI_OnLoad` capture, matching descriptors); the plan documents this in "Current-state findings" and Task 3 compile-verifies the android Rust path. No re-wiring needed (verified, not assumed).
- "keeping the passphrase fallback" → **Task 1** Step 3 note (no `setUserAuthenticationRequired`, StrongBox→TEE retry) preserves it; **Task 2** unit-tests the passphrase fallback round-trip + tamper rejection.
- "Acceptance: device wraps/unwraps via hardware Keystore; fallback still works headless" → **Task 4** Step 3 (device wrap/unwrap + relaunch auto-unlock + fallback note), with the honest "mark pending if no device" clause.
- Spec §6 cross-cutting: IPC three-places — **N/A, no new channel** (Task 4 Step 1 proves it); autopilot drift-guard — **no new entry needed**, confirmed not assumed (Task 4 Step 1); per-sub-project gate `npm test` — **Task 4 Step 2**; parity — Global Constraints + Task 4 Step 4. No gaps.

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N"/"write tests for the above". Every code step shows complete Kotlin or Rust; every command step shows the exact command + expected output. The one unavoidable `<path-to-the-just-built-debug-apk>` / `<device>` placeholders are runtime artifacts the implementer fills from their own build/device, not undefined plan content.

**3. Type consistency:** The Kotlin method names/signatures are unchanged across all references (`wrap([B)Ljava/lang/String;`, `unwrap(Ljava/lang/String;)[B`, both `@JvmStatic`, both `…?`) — Global Constraints, File Structure, Task 1 Interfaces all state the identical descriptors, matching the Rust `call_static_method` in `android_keystore`. `VaultBacking::Keychain.as_str() == "keychain"` is consistent between Task 2's test, the `shared/types.ts:309` union, and Task 4's device expectation. `RootSecret([_; 32])` / 32-byte seed is consistent with `crypto.rs`. No drift.

Two findings worth surfacing to the caller: (a) the spec's §1.1 "documented but not connected" line is **stale** — the connection landed at `03f0012` and was device-verified — so J is finish/harden/re-verify, and (b) the only substantive code change is the StrongBox preference; the rest is tests + the two compile gates + the device round-trip.
