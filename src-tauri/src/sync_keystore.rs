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
//! never initialized). Either path falls back to the passphrase-wrapped file, or in-memory-only
//! if no passphrase is set, on any error.
use crate::crypto::{hex, unhex, RootSecret};
use tauri::{AppHandle, Manager, Runtime};
use zeroize::Zeroize;

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
const KEYRING_SERVICE: &str = "com.aegis.browser";
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
const KEYRING_USER: &str = "sync-root";

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
pub fn device_local_salt(app: &AppHandle) -> Vec<u8> {
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
    use jni::objects::{JByteArray, JString, JValue};
    use jni::JavaVM;

    use std::sync::OnceLock;

    // Tauri's Android runtime does NOT use ndk-glue, so `ndk_context` is never initialized —
    // calling `ndk_context::android_context()` panics ("android context was not initialized"),
    // and because the keystore up-call runs under the non-unwinding `Rust_ipc` JNI frame, that
    // panic aborts the whole process (SIGABRT) instead of falling back. So we capture the VM
    // the canonical way instead: `JNI_OnLoad`, which the runtime calls exactly once when
    // libapp_lib.so loads, before any other JNI entry point.
    static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();

    /// Called once by the Android runtime when the native library is loaded; stashes the VM
    /// so Rust→Java up-calls (the hardware Keystore) can attach without ndk-glue.
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

    /// Attach to the JVM and run `f` with a JNIEnv. Returns `None` (NEVER a crash) if the VM
    /// isn't available or the closure panics — callers then fall back to the passphrase /
    /// in-memory path. The `catch_unwind` is essential: this executes beneath the `extern "C"`
    /// `Rust_ipc` frame, where an escaping panic aborts the process rather than unwinding.
    fn with_env<T>(f: impl FnOnce(&mut jni::JNIEnv) -> Option<T>) -> Option<T> {
        let vm = JAVA_VM.get()?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let mut env = vm.attach_current_thread().ok()?;
            f(&mut env)
        }))
        .ok()
        .flatten()
    }

    /// Wrap the 32-byte root via `AegisKeystore.wrap([B)Ljava/lang/String;`. None on any error.
    pub fn wrap(root: &[u8; 32]) -> Option<String> {
        with_env(|env| {
            let arr = env.byte_array_from_slice(root).ok()?;
            let res = env.call_static_method(
                "com/aegis/browser/AegisKeystore",
                "wrap",
                "([B)Ljava/lang/String;",
                &[JValue::Object(&arr)],
            );
            let val = match res {
                Ok(v) => v,
                Err(_) => {
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
        with_env(|env| {
            let jblob = env.new_string(blob).ok()?;
            let res = env.call_static_method(
                "com/aegis/browser/AegisKeystore",
                "unwrap",
                "(Ljava/lang/String;)[B",
                &[JValue::Object(&jblob)],
            );
            let val = match res {
                Ok(v) => v,
                Err(_) => {
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

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn keyring_set(bytes: Vec<u8>) -> Result<(), String> {
    std::thread::spawn(move || -> Result<(), String> {
        let mut bytes = bytes; // wipe the root copy after handing it to the keychain
        let e = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
        let r = e.set_secret(&bytes).map_err(|e| e.to_string());
        bytes.zeroize();
        r
    })
    .join()
    .map_err(|_| "keyring thread panicked".to_string())?
}

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn keyring_get() -> Option<Vec<u8>> {
    std::thread::spawn(|| {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .ok()
            .and_then(|e| e.get_secret().ok())
    })
    .join()
    .ok()
    .flatten()
}

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
fn keyring_clear() {
    let _ = std::thread::spawn(|| {
        if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
            let _ = e.delete_credential();
        }
    })
    .join();
}

/// Persist the root: OS keychain first (desktop), else a passphrase-wrapped file if a
/// passphrase is supplied, else not at all (in-memory only). Returns where it landed.
pub fn store_root(app: &AppHandle, root: &RootSecret, passphrase: Option<&str>) -> VaultBacking {
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
        if keyring_set(root.0.to_vec()).is_ok() {
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
pub fn load_root(app: &AppHandle, passphrase: Option<&str>) -> Option<RootSecret> {
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
        if let Some(mut bytes) = keyring_get() {
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
        if let Some(mut bytes) = keyring_get() {
            bytes.zeroize();
            return true;
        }
    }
    vault_path(app).map(|p| p.exists()).unwrap_or(false)
}

/// Forget the stored seed (disable + forget-keys).
pub fn clear_root(app: &AppHandle) {
    #[cfg(target_os = "android")]
    if let Some(p) = keystore_vault_path(app) {
        let _ = std::fs::remove_file(p);
    }
    #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
    keyring_clear();
    if let Some(p) = vault_path(app) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
