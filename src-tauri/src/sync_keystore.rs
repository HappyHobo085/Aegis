//! The sync seed at rest (F2b).
//!
//! Per the product decision, the primary store is the OS keychain (desktop `keyring` /
//! Android hardware Keystore), with a passphrase-wrapped file as the fallback when no
//! keychain is available (headless/CI, or no secret-service daemon). The unwrapped
//! `RootSecret` lives in memory only while sync is unlocked.
//!
//! Two persisted, NEVER-exported files: `sync-vault.json` (the passphrase-wrapped root, only
//! when that backing is used) and `sync-device-salt.json` (the per-install salt that makes
//! this device's signing key distinct — see crypto::device_signing_seed).
//!
//! NOTE: desktop uses the `keyring` crate; Android up-calls the Kotlin `AegisKeystore` over JNI
//! (the JavaVM is captured in `JNI_OnLoad` — Tauri doesn't run ndk-glue, so `ndk_context` is
//! never initialized — and the `AegisKeystore` class itself is handed over from
//! `MainActivity.onCreate`, because `FindClass` can't see app classes from a native thread).
//! Either path falls back to the passphrase-wrapped file, or in-memory-only
//! if no passphrase is set, on any error.
use crate::crypto::{hex, unhex, RootSecret};
use tauri::{AppHandle, Manager, Runtime};
use zeroize::Zeroize;
// Only the DESKTOP keyring paths touch a `Zeroizing` (see `keyring_set`), and that fn is
// `#[cfg]`-gated to the three desktop targets, so on Android this import would be unused —
// and `-D warnings` (which CI injects from outside the repo) turns that into a build failure.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
use zeroize::Zeroizing;

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
const KEYRING_SERVICE: &str = "com.aegis.browser";
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
const KEYRING_USER: &str = "sync-root";

/// Managed-state override for the keyring entry's user field.
///
/// The production entry (`KEYRING_USER`) is a single, fixed, global slot, so anything that
/// exercises `store_root`/`load_root` against it collides with every other such caller —
/// and with the developer's real, live sync seed. `with_tmp_app` manages one of these with
/// a unique user per test app so the suite never touches the real entry. Nothing in the
/// shipped app manages it, so `keyring_user` always returns `KEYRING_USER` in production.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
#[derive(Clone, Debug)]
pub struct KeyringSlot(pub String);

/// The keyring `user` this app instance reads and writes.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn keyring_user<R: Runtime>(app: &AppHandle<R>) -> String {
    app.try_state::<KeyringSlot>()
        .map(|s| s.0.clone())
        .unwrap_or_else(|| KEYRING_USER.to_string())
}

/// Route this app instance at a private keyring entry (tests only). A no-op on platforms
/// without an OS keychain so callers need no `cfg` of their own.
///
/// `#[cfg(test)]` because the only caller is `test_support`, which is itself `#![cfg(test)]` —
/// without this gate the release lib build sees the function as dead code and
/// `clippy -D warnings` fails the build. `KeyringSlot` itself stays unconditional because
/// `keyring_user` reads it via `try_state` in every build.
#[cfg(test)]
pub fn manage_test_slot<R: Runtime>(app: &AppHandle<R>, id: usize) {
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    app.manage(KeyringSlot(format!("test-{id}")));
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    let _ = (app, id);
}

/// Where the seed ended up (mirrors `SyncState.vaultBacking` in the UI).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VaultBacking {
    Keychain,
    Passphrase,
    None,
}

impl VaultBacking {
    pub fn as_str(&self) -> &'static str {
        match self {
            VaultBacking::Keychain => "keychain",
            VaultBacking::Passphrase => "passphrase",
            VaultBacking::None => "none",
        }
    }
}

/// Derive a 256-bit key-encryption key from a passphrase + salt (Argon2id).
///
/// Parameters: argon2id defaults (m_cost=19456/19 MiB, t_cost=2, p_cost=1) —
/// the OWASP 2024 minimum floor. For stronger offline-attack resistance on
/// desktop-class hardware, consider upgrading to m_cost=65536, t_cost=3, p_cost=4
/// (OWASP recommended). Changing params requires a migration path for existing
/// vaults (KDF version field in the wrapped blob).
fn derive_kek(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut kek = [0u8; 32];
    argon2::Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut kek)
        .map_err(|e| e.to_string())?;
    Ok(kek)
}

/// Wrap the root with a passphrase: Argon2id(passphrase, random salt) → KEK, then
/// XChaCha20-Poly1305-seal the root. Returns a JSON blob `{v, salt, nonce, ct}` (hex).
pub fn wrap_with_passphrase(root: &RootSecret, passphrase: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    let mut kek = derive_kek(passphrase, &salt)?;
    let sealed = crate::crypto::seal(&kek, "vault", "root", b"aegis-vault-v1", &root.0);
    kek.zeroize();
    let (nonce, ct) = sealed?;
    serde_json::to_string(&serde_json::json!({
        "v": 1, "salt": hex(&salt), "nonce": hex(&nonce), "ct": hex(&ct),
    }))
    .map_err(|e| e.to_string())
}

/// Reverse `wrap_with_passphrase`. A wrong passphrase fails authentication.
pub fn unwrap_with_passphrase(blob: &str, passphrase: &str) -> Result<RootSecret, String> {
    let v: serde_json::Value = serde_json::from_str(blob).map_err(|e| e.to_string())?;
    let get = |k: &str| -> Result<Vec<u8>, String> {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .and_then(unhex)
            .ok_or_else(|| format!("vault: bad/missing {k}"))
    };
    let salt = get("salt")?;
    let nonce = get("nonce")?;
    let ct = get("ct")?;
    let mut kek = derive_kek(passphrase, &salt)?;
    let opened = crate::crypto::open(&kek, &nonce, &ct, "vault", "root", b"aegis-vault-v1");
    kek.zeroize();
    // `pt` is the cleartext root; Vec<u8> isn't zeroize-on-drop, so wipe it on every path.
    let mut pt = opened?;
    if pt.len() != 32 {
        pt.zeroize();
        return Err("vault: bad root length".into());
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&pt);
    pt.zeroize();
    Ok(RootSecret(arr))
}

fn vault_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sync-vault.json"))
}

fn salt_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sync-device-salt.json"))
}

/// The per-install 16-byte salt (read-or-create) that makes this device's signing key
/// distinct, so `removeDevice` can revoke exactly one install. Never exported.
pub fn device_local_salt<R: Runtime>(app: &AppHandle<R>) -> Vec<u8> {
    if let Some(p) = salt_path(app) {
        if let Some(salt) = crate::jsonstore::read_with_backup(&p)
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| {
                v.get("salt")
                    .and_then(serde_json::Value::as_str)
                    .map(String::from)
            })
            .and_then(|s| unhex(&s))
            .filter(|s| s.len() == 16)
        {
            return salt;
        }
        let mut salt = [0u8; 16];
        let _ = getrandom::getrandom(&mut salt);
        let txt =
            serde_json::to_string(&serde_json::json!({ "salt": hex(&salt) })).unwrap_or_default();
        if let Err(e) = crate::jsonstore::write_atomic(&p, txt.as_bytes()) {
            eprintln!("[aegis] failed to persist device salt: {e}");
        }
        return salt.to_vec();
    }
    let mut salt = [0u8; 16];
    let _ = getrandom::getrandom(&mut salt);
    salt.to_vec()
}

// --- Android hardware Keystore (via the Kotlin AegisKeystore up-call) ---
// The seed is wrapped by a non-exportable hardware AES key in the AndroidKeyStore and the
// wrapped blob is stored in a file. RUNTIME device-verify PENDING: the JNI up-call + the
// hardware wrapping can only be confirmed on a device. Every path here fail-safes to None
// (→ the passphrase/in-memory fallback), so a runtime failure degrades gracefully and never
// crashes — the worst case is the same as before this path existed.
#[cfg(target_os = "android")]
fn keystore_vault_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sync-keystore-vault.json"))
}

#[cfg(target_os = "android")]
mod android_keystore {
    use jni::objects::{GlobalRef, JByteArray, JClass, JObject, JString, JValue};
    use jni::JavaVM;

    use std::sync::OnceLock;

    // Tauri's Android runtime does NOT use ndk-glue, so `ndk_context` is never initialized —
    // calling `ndk_context::android_context()` panics ("android context was not initialized"),
    // and because the keystore up-call runs under the non-unwinding `Rust_ipc` JNI frame, that
    // panic aborts the whole process (SIGABRT) instead of falling back. So we capture the VM
    // the canonical way instead: `JNI_OnLoad`, which the runtime calls exactly once when
    // libapp_lib.so loads, before any other JNI entry point.
    static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();

    // The `AegisKeystore` Class, as a JNI *global* ref, handed to us from Java (see
    // `provideClass`). It has to come from Java: this up-call runs on a native thread that we
    // attached ourselves, so it has NO Java caller frame, and JNI resolves `FindClass` on such a
    // thread against the *system* class loader — which cannot see the app's own classes. The
    // old `call_static_method("com/aegis/browser/AegisKeystore", …)` therefore always died with
    // ClassNotFoundException, which we swallowed, so `wrap` returned None on every enable and
    // the seed was silently never persisted (Settings → Sync reset to "set up" after every
    // restart). A global ref to the Class is valid on any thread for the life of the process.
    static KEYSTORE_CLASS: OnceLock<GlobalRef> = OnceLock::new();

    /// Called once by the Android runtime when the native library is loaded; stashes the VM
    /// so Rust→Java up-calls (the hardware Keystore) can attach without ndk-glue.
    #[allow(unsafe_code)]
    // `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
    // name means two libraries could export the same symbol, which the linker leaves
    // undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
    // by name), so it is allowed here explicitly rather than by the module scope —
    // `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
    #[no_mangle]
    pub extern "system" fn JNI_OnLoad(
        vm: *mut jni::sys::JavaVM,
        _reserved: *mut std::ffi::c_void,
    ) -> jni::sys::jint {
        if let Ok(vm) = unsafe { JavaVM::from_raw(vm) } {
            let _ = JAVA_VM.set(vm);
        }
        jni::sys::JNI_VERSION_1_6
    }

    /// `NativeSyncKeystore.provideClass(AegisKeystore.class)` → cache that Class globally.
    /// Called from `MainActivity.onCreate` *before* `super.onCreate` (which is what runs
    /// `Rust.create()` → our `setup()` → the boot sync restore), so the class is always in
    /// place before any up-call. Safe to call more than once; the first one wins.
    #[allow(unsafe_code)]
    // `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
    // name means two libraries could export the same symbol, which the linker leaves
    // undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
    // by name), so it is allowed here explicitly rather than by the module scope —
    // `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
    #[no_mangle]
    pub extern "system" fn Java_com_aegis_browser_NativeSyncKeystore_provideClass(
        env: jni::JNIEnv,
        _class: JClass<'_>,
        class: JObject<'_>,
    ) {
        // This runs from `MainActivity.onCreate` *before* `super.onCreate`, i.e. during
        // class initialization, and it was the one export with no guard at all — a panic
        // here aborts the app before the UI ever appears. `env` is captured by reference
        // only (it is !UnwindSafe), which `AssertUnwindSafe` asserts is fine.
        match crate::ffi_guard(|| env.new_global_ref(&class)) {
            Some(Ok(g)) => {
                let _ = KEYSTORE_CLASS.set(g);
            }
            Some(Err(e)) => {
                eprintln!("[aegis-sync] could not pin the AegisKeystore class: {e}")
            }
            None => eprintln!("[aegis-sync] provideClass panicked; class not cached"),
        }
    }

    /// Attach to the JVM and run `f` with a JNIEnv + the pinned `AegisKeystore` class. Returns
    /// `None` (NEVER a crash) if the VM/class isn't available or the closure panics — callers
    /// then fall back to the passphrase / in-memory path. The `catch_unwind` is essential: this
    /// executes beneath the `extern "C"` `Rust_ipc` frame, where an escaping panic aborts the
    /// process rather than unwinding.
    fn with_env<T>(f: impl FnOnce(&mut jni::JNIEnv, &GlobalRef) -> Option<T>) -> Option<T> {
        let vm = JAVA_VM.get()?;
        let class = KEYSTORE_CLASS.get().or_else(|| {
            eprintln!(
                "[aegis-sync] AegisKeystore class was never provided by MainActivity — \
                 falling back to the passphrase/in-memory vault"
            );
            None
        })?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let mut env = vm.attach_current_thread().ok()?;
            f(&mut env, class)
        }))
        .ok()
        .flatten()
    }

    /// Wrap the 32-byte root via `AegisKeystore.wrap([B)Ljava/lang/String;`. None on any error.
    pub fn wrap(root: &[u8; 32]) -> Option<String> {
        with_env(|env, class| {
            let arr = env.byte_array_from_slice(root).ok()?;
            let res = env.call_static_method(
                class,
                "wrap",
                "([B)Ljava/lang/String;",
                &[JValue::Object(&arr)],
            );
            let val = match res {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[aegis-sync] AegisKeystore.wrap failed: {e}");
                    let _ = env.exception_clear();
                    return None;
                }
            };
            let obj = val.l().ok()?;
            if obj.is_null() {
                return None;
            }
            let s: String = env.get_string(&JString::from(obj)).ok()?.into();
            Some(s)
        })
    }

    /// Unwrap via `AegisKeystore.unwrap(Ljava/lang/String;)[B`. None on any error.
    pub fn unwrap(blob: &str) -> Option<Vec<u8>> {
        with_env(|env, class| {
            let jblob = env.new_string(blob).ok()?;
            let res = env.call_static_method(
                class,
                "unwrap",
                "(Ljava/lang/String;)[B",
                &[JValue::Object(&jblob)],
            );
            let val = match res {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[aegis-sync] AegisKeystore.unwrap failed: {e}");
                    let _ = env.exception_clear();
                    return None;
                }
            };
            let obj = val.l().ok()?;
            if obj.is_null() {
                return None;
            }
            env.convert_byte_array(JByteArray::from(obj)).ok()
        })
    }
}

// --- desktop OS keychain (on a dedicated thread; secret-service can block/prompt) ---
//
// The root is stored HEX-ENCODED, not as raw bytes. `keyring`'s secret-service backend
// tags every secret it writes as "text/plain" (keyring-3.6.3 secret_service.rs:
// `create_item(.., "text/plain")` / `set_item_secret(..)`), and gnome-keyring REJECTS a
// write whose bytes aren't valid UTF-8 under that tag:
//   "Secret value contains invalid UTF-8 sequences but content_type declares text
//    encoding; use application/octet-stream for binary data"
// A 32-byte CSPRNG root is essentially never valid UTF-8, so `set_secret(&raw)` failed on
// every real enable — the seed was silently never persisted, boot found no stored root,
// and Settings → Sync came back DISABLED after every restart. The keyring crate offers no
// way to override the content type, so hex is the fix: it is pure ASCII, and the extra
// layer of encoding costs nothing since the value is already a high-entropy secret.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
/// Store `bytes` in the OS keychain under `user`.
///
/// `bytes` is a [`Zeroizing`] so the caller's copy of the root secret is wiped on drop: the
/// signature used to take a bare `Vec<u8>`, and the only zeroizing in here was applied to the
/// hex copy this function makes — so the raw copy it was handed sat in freed heap until it was
/// reused. Taking the already-wrapped type means a future caller cannot reintroduce that, and
/// it also means there is no `.to_vec()` at the call site (which would have undone it anyway).
fn keyring_set(user: &str, bytes: Zeroizing<Vec<u8>>) -> Result<(), String> {
    let mut encoded = hex(&bytes);
    let user = user.to_string();
    std::thread::spawn(move || -> Result<(), String> {
        let e = keyring::Entry::new(KEYRING_SERVICE, &user).map_err(|e| e.to_string())?;
        let r = e.set_password(&encoded).map_err(|e| e.to_string());
        // Wipe the hex copy (which is the cleartext root) once the keychain has it.
        encoded.zeroize();
        r
    })
    .join()
    .map_err(|_| "keyring thread panicked".to_string())?
}

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn keyring_get(user: &str) -> Option<Vec<u8>> {
    let user = user.to_string();
    std::thread::spawn(move || {
        keyring::Entry::new(KEYRING_SERVICE, &user)
            .ok()
            .and_then(|e| e.get_password().ok())
            .and_then(decode_keyring_value)
    })
    .join()
    .ok()
    .flatten()
}

/// Turn a keychain string back into the 32-byte root. Normally that is the hex we wrote;
/// a pre-hex build may have stored the raw bytes, so a value that is already 32 bytes
/// long is accepted as-is. Anything else (truncated, or a foreign entry) is rejected
/// rather than guessed at — a wrong root here would sync as the wrong account.
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn decode_keyring_value(stored: String) -> Option<Vec<u8>> {
    if let Some(bytes) = unhex(&stored).filter(|b| b.len() == 32) {
        return Some(bytes);
    }
    let raw = stored.into_bytes();
    (raw.len() == 32).then_some(raw)
}

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn keyring_clear(user: &str) {
    let user = user.to_string();
    let _ = std::thread::spawn(move || {
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, &user) {
            let _ = e.delete_credential();
        }
    })
    .join();
}

/// Is the OS secure store actually usable in THIS environment? (`test-only`)
///
/// The keychain tests and `sync::tests::restart_restores_an_enabled_sync_state` exercise
/// the REAL Secret Service / Credential Manager / Keychain, so they need a running
/// secure-storage daemon. A headless Linux CI runner has none — the
/// `org.freedesktop.secrets` bus name is unowned and every call fails with
/// `ServiceUnknown`. That is an environment gap, not a code defect, and the dependent
/// tests are meaningless without a keychain to talk to.
///
/// Rust has no runtime "skip", so those tests return early instead. The skip is LOUD
/// (`eprintln!`, visible in `cargo test` output) precisely because the alternative — a
/// silent pass — would let the keychain regressions these tests exist to catch ship
/// unnoticed. A local dev machine with a keyring daemon runs them for real.
///
/// Probes with a WRITE, not a read: an unowned/absent service fails on the first call
/// either way, and a write is the only way to catch a keychain that accepts reads of
/// nothing but rejects stores (the exact failure `store_root` fell through on).
#[cfg(test)]
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
pub(crate) fn keyring_available() -> bool {
    const PROBE: &str = "test-keyring-availability-probe";
    let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, PROBE) else {
        eprintln!("SKIP keychain tests: no keyring service for {KEYRING_SERVICE}/{PROBE}");
        return false;
    };
    match e.set_password("probe") {
        Ok(()) => {
            let _ = e.delete_credential();
            true
        }
        Err(err) => {
            eprintln!("SKIP keychain tests: OS secure storage unavailable ({err})");
            false
        }
    }
}

/// Persist the root: OS keychain first (desktop), else a passphrase-wrapped file if a
/// passphrase is supplied, else not at all (in-memory only). Returns where it landed.
pub fn store_root<R: Runtime>(
    app: &AppHandle<R>,
    root: &RootSecret,
    passphrase: Option<&str>,
) -> VaultBacking {
    // Android: hardware Keystore first (graceful fall-through on any error).
    #[cfg(target_os = "android")]
    {
        let wrapped = android_keystore::wrap(&root.0);
        if let (Some(blob), Some(p)) = (&wrapped, keystore_vault_path(app)) {
            if crate::jsonstore::write_atomic(&p, blob.as_bytes()).is_ok() {
                if let Some(pp) = passphrase {
                    let _ = store_passphrase_vault(app, root, pp);
                } else if let Some(vp) = vault_path(app) {
                    let _ = std::fs::remove_file(vp); // no stale passphrase vault
                }
                return VaultBacking::Keychain;
            }
        }
        // Keystore unavailable/failed → REMOVE any stale keystore vault so load_root can't
        // resurrect an OLD root over the passphrase/in-memory path we're about to use.
        if let Some(p) = keystore_vault_path(app) {
            let _ = std::fs::remove_file(p);
        }
    }
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    {
        if keyring_set(&keyring_user(app), Zeroizing::new(root.0.to_vec())).is_ok() {
            if let Some(pp) = passphrase {
                let _ = store_passphrase_vault(app, root, pp);
            } else if let Some(p) = vault_path(app) {
                let _ = std::fs::remove_file(p); // don't leave a stale passphrase vault
            }
            return VaultBacking::Keychain;
        }
    }
    if let Some(pp) = passphrase {
        if store_passphrase_vault(app, root, pp).is_ok() {
            return VaultBacking::Passphrase;
        }
    }
    VaultBacking::None
}

fn store_passphrase_vault<R: Runtime>(
    app: &AppHandle<R>,
    root: &RootSecret,
    passphrase: &str,
) -> Result<(), String> {
    let blob = wrap_with_passphrase(root, passphrase)?;
    let p = vault_path(app).ok_or_else(|| "vault path unavailable".to_string())?;
    crate::jsonstore::write_atomic(&p, blob.as_bytes()).map_err(|e| e.to_string())
}

/// Load the root at boot: OS keychain (desktop), else the passphrase vault if a passphrase
/// is supplied. `None` means sync stays locked until the user re-enters the phrase.
pub fn load_root<R: Runtime>(app: &AppHandle<R>, passphrase: Option<&str>) -> Option<RootSecret> {
    #[cfg(target_os = "android")]
    {
        if let Some(blob) = keystore_vault_path(app).and_then(|p| std::fs::read_to_string(p).ok()) {
            if let Some(mut bytes) = android_keystore::unwrap(&blob) {
                if bytes.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&bytes);
                    bytes.zeroize();
                    return Some(RootSecret(arr));
                }
                bytes.zeroize();
            }
        }
    }
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    {
        if let Some(mut bytes) = keyring_get(&keyring_user(app)) {
            if bytes.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&bytes);
                bytes.zeroize();
                return Some(RootSecret(arr));
            }
            bytes.zeroize();
        }
    }
    if let (Some(pp), Some(p)) = (passphrase, vault_path(app)) {
        if let Ok(blob) = std::fs::read_to_string(&p) {
            return unwrap_with_passphrase(&blob, pp).ok();
        }
    }
    None
}

/// Explicit user unlock for a passphrase-backed vault. This intentionally prefers the
/// passphrase vault over the OS keychain because entering a passphrase means "unlock the
/// saved vault", not "try any keychain entry first".
pub fn unlock_with_passphrase<R: Runtime>(
    app: &AppHandle<R>,
    passphrase: &str,
) -> Result<RootSecret, String> {
    let p = vault_path(app)
        .ok_or_else(|| "No saved sync vault was found. Restore with your recovery phrase once, then set a sync passphrase.".to_string())?;
    if !p.exists() {
        return Err("No saved sync vault was found. Restore with your recovery phrase once, then set a sync passphrase.".into());
    }
    let blob = std::fs::read_to_string(&p).map_err(|_| {
        "Couldn't read the saved sync vault. Restore with your recovery phrase to repair it."
            .to_string()
    })?;
    unwrap_with_passphrase(&blob, passphrase)
        .map_err(|_| "That passphrase couldn't unlock the saved sync vault.".to_string())
}

/// Whether a persisted seed exists (keychain or vault file) — for the boot auto-unlock check.
pub fn has_stored_root<R: Runtime>(app: &AppHandle<R>) -> bool {
    #[cfg(target_os = "android")]
    {
        if keystore_vault_path(app)
            .map(|p| p.exists())
            .unwrap_or(false)
        {
            return true;
        }
    }
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    {
        // keyring has no "exists" probe; fetch + immediately wipe the returned root copy.
        if let Some(mut bytes) = keyring_get(&keyring_user(app)) {
            bytes.zeroize();
            return true;
        }
    }
    vault_path(app).map(|p| p.exists()).unwrap_or(false)
}

/// Forget the stored seed (disable + forget-keys).
pub fn clear_root<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(target_os = "android")]
    if let Some(p) = keystore_vault_path(app) {
        let _ = std::fs::remove_file(p);
    }
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    keyring_clear(&keyring_user(app));
    if let Some(p) = vault_path(app) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keychain tests below all share ONE keyring entry (the real KEYRING_USER), so
    /// cargo's parallel test threads would clobber each other. They run in their own
    /// keyring slots instead — the production helpers, with the entry `user` swapped.
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    mod keyring_slots {
        use super::{decode_keyring_value, hex, KEYRING_SERVICE};
        use zeroize::Zeroize;

        fn entry(user: &str) -> keyring::Entry {
            keyring::Entry::new(KEYRING_SERVICE, user).expect("keyring entry")
        }

        pub fn set(user: &str, bytes: Vec<u8>) -> Result<(), String> {
            let mut encoded = hex(&bytes);
            let e = entry(user);
            let r = e.set_password(&encoded).map_err(|e| e.to_string());
            encoded.zeroize();
            r
        }

        /// Store RAW bytes (bypassing the hex encoding) to simulate a pre-fix entry.
        pub fn set_raw(user: &str, bytes: Vec<u8>) {
            entry(user).set_secret(&bytes).expect("raw keychain write");
        }

        pub fn get(user: &str) -> Option<Vec<u8>> {
            decode_keyring_value(entry(user).get_password().ok()?)
        }

        pub fn clear(user: &str) {
            let _ = entry(user).delete_credential();
        }
    }

    /// THE REGRESSION: a real (non-UTF-8) root must survive the OS keychain round-trip.
    /// `set_secret(&raw_bytes)` is rejected by gnome-keyring ("invalid UTF-8 sequences …
    /// content_type declares text encoding"), so the seed never persisted and Settings →
    /// Sync came back disabled after every restart. ASCII-only test roots could never
    /// catch this — the value has to be one that is genuinely NOT valid UTF-8.
    #[test]
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    fn keychain_round_trips_a_non_utf8_root() {
        use keyring_slots as k;
        if !keyring_available() {
            return;
        }
        const U: &str = "test-roundtrip";
        // 0x80 is a UTF-8 continuation byte — guaranteed invalid on its own.
        let root = RootSecret([0x80u8; 32]);
        assert!(
            std::str::from_utf8(&root.0).is_err(),
            "the test root must not be valid UTF-8, or it proves nothing"
        );
        k::set(U, root.0.to_vec()).expect("the keychain must accept a real root");
        assert_eq!(k::get(U), Some(root.0.to_vec()));
        k::clear(U);
    }

    /// A second enable must OVERWRITE the first root, not leave the previous one behind —
    /// otherwise a re-enabled account silently keeps syncing as the old identity.
    #[test]
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    fn keychain_overwrites_a_previous_root() {
        use keyring_slots as k;
        if !keyring_available() {
            return;
        }
        const U: &str = "test-overwrite";
        let a = RootSecret([0x80u8; 32]);
        let b = RootSecret([0xFEu8; 32]);
        k::set(U, a.0.to_vec()).expect("first store");
        k::set(U, b.0.to_vec()).expect("second store must overwrite");
        assert_eq!(k::get(U), Some(b.0.to_vec()));
        k::clear(U);
    }

    /// A legacy entry stored as raw 32 bytes (pre-hex builds) must still load, so an
    /// existing user's keychain is not orphaned by this change.
    #[test]
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    fn keychain_reads_a_legacy_raw_byte_entry() {
        use keyring_slots as k;
        if !keyring_available() {
            return;
        }
        const U: &str = "test-legacy";
        // 0x41 is valid ASCII AND valid hex, so it decodes as hex to 16 bytes — the
        // length filter must reject that and fall back to the raw 32 bytes.
        let raw = vec![0x41u8; 32];
        k::set_raw(U, raw.clone());
        assert_eq!(k::get(U), Some(raw));
        k::clear(U);
    }

    #[test]
    fn passphrase_wrap_round_trips() {
        let root = RootSecret([42u8; 32]);
        let blob = wrap_with_passphrase(&root, "correct horse battery staple").unwrap();
        let back = unwrap_with_passphrase(&blob, "correct horse battery staple").unwrap();
        assert_eq!(back.0, root.0);
    }

    #[test]
    fn wrong_passphrase_fails() {
        let root = RootSecret([42u8; 32]);
        let blob = wrap_with_passphrase(&root, "right").unwrap();
        assert!(unwrap_with_passphrase(&blob, "wrong").is_err());
    }

    #[test]
    fn wrap_uses_a_fresh_salt_each_time() {
        // Two wraps of the same root + passphrase differ (random salt + nonce).
        let root = RootSecret([1u8; 32]);
        let a = wrap_with_passphrase(&root, "pw").unwrap();
        let b = wrap_with_passphrase(&root, "pw").unwrap();
        assert_ne!(a, b);
    }

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

    #[test]
    fn passphrase_vault_file_is_written_and_unlockable() {
        crate::test_support::with_tmp_app(|app| {
            let root = RootSecret([9u8; 32]);
            store_passphrase_vault(app, &root, "pw").unwrap();

            let p = vault_path(app).expect("vault path resolves");
            assert!(p.exists(), "passphrase vault must be written at {p:?}");
            let blob = std::fs::read_to_string(p).unwrap();
            let back = unwrap_with_passphrase(&blob, "pw").unwrap();
            assert_eq!(back.0, root.0);
            let unlocked = unlock_with_passphrase(app, "pw").unwrap();
            assert_eq!(unlocked.0, root.0);
        });
    }

    #[test]
    fn passphrase_unlock_explains_missing_vault() {
        crate::test_support::with_tmp_app(|app| {
            let err = match unlock_with_passphrase(app, "pw") {
                Ok(_) => panic!("unlock must fail without a vault file"),
                Err(err) => err,
            };
            assert!(err.contains("No saved sync vault"));
        });
    }
}
