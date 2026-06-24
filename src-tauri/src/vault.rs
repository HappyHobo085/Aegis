//! Local, encrypted-at-rest password vault (Phase A — manage only, NO autofill).
//!
//! Credential records are sealed with the SAME XChaCha20-Poly1305 AEAD as the sync engine
//! (crypto::seal/open) under the dedicated "vault" namespace, gated by a master-password
//! Argon2id KDF (mirroring sync_keystore::derive_kek). The vault is NOT synced and NEVER
//! reachable from the content webview — there is no page->core bridge (locked decision).
//
// Task 3 (IPC dispatcher) is not yet wired — suppress dead_code lints on the pure seam.
#![allow(dead_code)]
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const NS: &str = "pwvault";
const VERIFIER_UUID: &str = "verifier";
const VERIFIER_PLAINTEXT: &[u8] = b"aegis-vault-verifier-v1";
const VERIFIER_HLC: &[u8] = b"aegis-vault-verifier-v1"; // fixed AAD version tag for the verifier

/// One decrypted credential. Zeroized on drop so a dropped vault leaves no plaintext.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop, PartialEq, Debug)]
pub struct Cred {
    pub uuid: String,
    #[zeroize(skip)] // a millisecond timestamp isn't secret and is needed as cleartext AAD
    pub updated_at: i64,
    pub site: String,
    pub username: String,
    pub password: String,
    pub notes: String,
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Argon2id(master_password, salt) -> 256-bit vault key. Reuses the exact derivation the
/// sync passphrase path uses (sync_keystore::derive_kek); kept as its own fn so the params
/// stay single-sourced if they ever change.
fn derive_vault_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let mut vk = Zeroizing::new([0u8; 32]);
    argon2::Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut vk[..])
        .map_err(|e| e.to_string())?;
    Ok(vk)
}

/// 8 big-endian bytes of `updated_at` — the per-record AAD version tag bound by the seal.
fn hlc_bytes(updated_at: i64) -> [u8; 8] {
    updated_at.to_be_bytes()
}

/// Seal one credential into a wire record `{uuid, updatedAt, nonce, ct}` (cleartext routing
/// fields + the sealed JSON body). NO plaintext credential field leaves this function.
fn seal_record(vk: &[u8; 32], c: &Cred) -> Result<Value, String> {
    let plaintext = Zeroizing::new(serde_json::to_vec(c).map_err(|e| e.to_string())?);
    let (nonce, ct) = crate::crypto::seal(vk, NS, &c.uuid, &hlc_bytes(c.updated_at), &plaintext)?;
    Ok(json!({ "uuid": c.uuid, "updatedAt": c.updated_at, "nonce": hex(&nonce), "ct": hex(&ct) }))
}

/// Open a wire record back into a Cred, authenticating against its cleartext uuid/updatedAt.
fn open_record(vk: &[u8; 32], w: &Value) -> Result<Cred, String> {
    let uuid = w
        .get("uuid")
        .and_then(Value::as_str)
        .ok_or("record missing uuid")?;
    let updated_at = w
        .get("updatedAt")
        .and_then(Value::as_i64)
        .ok_or("record missing updatedAt")?;
    let nonce = w
        .get("nonce")
        .and_then(Value::as_str)
        .and_then(unhex)
        .ok_or("record bad nonce")?;
    let ct = w
        .get("ct")
        .and_then(Value::as_str)
        .and_then(unhex)
        .ok_or("record bad ct")?;
    let pt = Zeroizing::new(crate::crypto::open(
        vk,
        &nonce,
        &ct,
        NS,
        uuid,
        &hlc_bytes(updated_at),
    )?);
    serde_json::from_slice(&pt).map_err(|e| e.to_string())
}

/// Seal the fixed verifier constant so unlock can detect a wrong password via AEAD auth alone.
fn seal_verifier(vk: &[u8; 32]) -> Result<Value, String> {
    let (nonce, ct) = crate::crypto::seal(vk, NS, VERIFIER_UUID, VERIFIER_HLC, VERIFIER_PLAINTEXT)?;
    Ok(json!({ "nonce": hex(&nonce), "ct": hex(&ct) }))
}

/// Returns Ok(()) iff `vk` is the right key (the verifier authenticates + matches).
fn check_verifier(vk: &[u8; 32], v: &Value) -> Result<(), String> {
    let nonce = v
        .get("nonce")
        .and_then(Value::as_str)
        .and_then(unhex)
        .ok_or("bad verifier")?;
    let ct = v
        .get("ct")
        .and_then(Value::as_str)
        .and_then(unhex)
        .ok_or("bad verifier")?;
    let pt = crate::crypto::open(vk, &nonce, &ct, NS, VERIFIER_UUID, VERIFIER_HLC)
        .map_err(|_| "wrong master password".to_string())?;
    if pt == VERIFIER_PLAINTEXT {
        Ok(())
    } else {
        Err("wrong master password".into())
    }
}

/// Build the on-disk JSON object from the verifier + sealed records (the at-rest file).
fn file_json(salt: &[u8], verifier: Value, records: &[Value]) -> Value {
    json!({ "v": 1, "kdf": "argon2id", "salt": hex(salt), "verifier": verifier, "records": records })
}

/// The in-memory vault state: locked (key = None, records empty) or unlocked.
#[derive(Default)]
pub struct Inner {
    key: Option<Zeroizing<[u8; 32]>>,
    records: Vec<Cred>,
    salt: Vec<u8>, // the Argon2 salt for THIS vault (loaded from the file)
    created: bool, // a vault file exists
}

/// Tauri managed state for the vault — a single Mutex around the inner state.
pub struct VaultState(pub Mutex<Inner>);

impl Default for VaultState {
    fn default() -> Self {
        VaultState(Mutex::new(Inner::default()))
    }
}

/// Errors returned by vault operations.
#[derive(Debug, PartialEq)]
pub enum VaultError {
    Locked,
    WrongPassword,
    Crypto(String),
    NotCreated,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Locked => write!(f, "vault is locked"),
            VaultError::WrongPassword => write!(f, "wrong master password"),
            VaultError::Crypto(e) => write!(f, "crypto error: {e}"),
            VaultError::NotCreated => write!(f, "vault not yet created"),
        }
    }
}

impl From<String> for VaultError {
    fn from(s: String) -> Self {
        VaultError::Crypto(s)
    }
}

// Pure vault operations that work directly on a `file_json` Value — no AppHandle needed.
// Tasks 2 and 3 wrap these with file I/O and Tauri IPC respectively.

/// Initialize a brand-new vault: derive the key from `password`, seal the verifier,
/// return the on-disk JSON (no records yet) and the derived key so the caller can
/// transition to "unlocked" without a second KDF call.
pub fn init_vault(password: &str) -> Result<(Value, Zeroizing<[u8; 32]>), VaultError> {
    // Generate a fresh random 32-byte Argon2id salt.
    let mut salt = vec![0u8; 32];
    getrandom::getrandom(&mut salt).map_err(|e| VaultError::Crypto(e.to_string()))?;
    let vk = derive_vault_key(password, &salt)?;
    let verifier = seal_verifier(&vk)?;
    let file = file_json(&salt, verifier, &[]);
    Ok((file, vk))
}

/// Unlock an existing vault from its on-disk JSON.
/// Derives the key, verifies it against the verifier, then decrypts all records.
/// Returns `VaultError::WrongPassword` if the AEAD authentication fails.
pub fn unlock_vault(
    file: &Value,
    password: &str,
) -> Result<(Zeroizing<[u8; 32]>, Vec<Cred>), VaultError> {
    let salt_hex = file
        .get("salt")
        .and_then(Value::as_str)
        .ok_or_else(|| VaultError::Crypto("missing salt".into()))?;
    let salt = unhex(salt_hex).ok_or_else(|| VaultError::Crypto("bad salt hex".into()))?;
    let vk = derive_vault_key(password, &salt)?;

    // Authenticate via the verifier before attempting to decrypt any records.
    let verifier = file
        .get("verifier")
        .ok_or_else(|| VaultError::Crypto("missing verifier".into()))?;
    check_verifier(&vk, verifier).map_err(|_| VaultError::WrongPassword)?;

    // Decrypt all records.
    let records = match file.get("records").and_then(Value::as_array) {
        Some(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for w in arr {
                out.push(open_record(&vk, w)?);
            }
            out
        }
        None => Vec::new(),
    };

    Ok((vk, records))
}

/// Re-seal all records (and the verifier) under `vk`, returning an updated on-disk JSON.
/// Called when adding/updating/removing a record while the vault is unlocked.
pub fn seal_vault(salt: &[u8], vk: &[u8; 32], records: &[Cred]) -> Result<Value, VaultError> {
    let verifier = seal_verifier(vk)?;
    let mut wire: Vec<Value> = Vec::with_capacity(records.len());
    for c in records {
        wire.push(seal_record(vk, c)?);
    }
    Ok(file_json(salt, verifier, &wire))
}

// ─── VaultState methods (pure, AppHandle-free) ──────────────────────────────

impl VaultState {
    /// Load an existing vault file into memory and derive the key.
    /// Returns `WrongPassword` if the password is wrong; `NotCreated` if `file` is None.
    pub fn unlock(&self, file: Option<&Value>, password: &str) -> Result<(), VaultError> {
        let file = file.ok_or(VaultError::NotCreated)?;
        let (vk, records) = unlock_vault(file, password)?;
        let mut inner = self.0.lock().unwrap();
        inner.key = Some(vk);
        inner.records = records;
        inner.created = true;
        // Extract salt for re-sealing later.
        if let Some(s) = file.get("salt").and_then(Value::as_str).and_then(unhex) {
            inner.salt = s;
        }
        Ok(())
    }

    /// Create a new vault with `password`, transitioning to the unlocked state.
    /// Returns the on-disk JSON the caller must persist.
    pub fn create(&self, password: &str) -> Result<Value, VaultError> {
        let (file, vk) = init_vault(password)?;
        let mut inner = self.0.lock().unwrap();
        let salt = file
            .get("salt")
            .and_then(Value::as_str)
            .and_then(unhex)
            .unwrap_or_default();
        inner.key = Some(vk);
        inner.records = Vec::new();
        inner.salt = salt;
        inner.created = true;
        Ok(file)
    }

    /// Lock the vault: zeroize the derived key and drop all decrypted records.
    pub fn lock(&self) {
        let mut inner = self.0.lock().unwrap();
        inner.key = None; // Zeroizing<[u8;32]> zeroizes on drop
        inner.records.clear(); // Cred implements ZeroizeOnDrop
        inner.records.shrink_to_fit();
    }

    /// Returns true if the vault is currently unlocked.
    pub fn is_unlocked(&self) -> bool {
        self.0.lock().unwrap().key.is_some()
    }

    /// List all credentials. Returns `Locked` if not unlocked.
    pub fn list(&self) -> Result<Vec<Cred>, VaultError> {
        let inner = self.0.lock().unwrap();
        if inner.key.is_none() {
            return Err(VaultError::Locked);
        }
        Ok(inner.records.clone())
    }

    /// Add or replace a credential (matched by uuid). Returns the updated on-disk JSON.
    pub fn upsert(&self, cred: Cred) -> Result<Value, VaultError> {
        let mut inner = self.0.lock().unwrap();
        // Copy the key bytes into a Zeroizing wrapper so the copy is zeroized on return,
        // leaving no key residue on the stack after the function exits.
        let vk = Zeroizing::new(*inner.key.as_deref().ok_or(VaultError::Locked)?);
        // Replace if uuid exists, otherwise append.
        if let Some(pos) = inner.records.iter().position(|r| r.uuid == cred.uuid) {
            inner.records[pos] = cred;
        } else {
            inner.records.push(cred);
        }
        let file = seal_vault(&inner.salt, &vk, &inner.records)?;
        Ok(file)
    }

    /// Remove a credential by uuid. Returns the updated on-disk JSON.
    pub fn remove(&self, uuid: &str) -> Result<Value, VaultError> {
        let mut inner = self.0.lock().unwrap();
        // Copy the key bytes into a Zeroizing wrapper so the copy is zeroized on return,
        // leaving no key residue on the stack after the function exits.
        let vk = Zeroizing::new(*inner.key.as_deref().ok_or(VaultError::Locked)?);
        inner.records.retain(|r| r.uuid != uuid);
        let file = seal_vault(&inner.salt, &vk, &inner.records)?;
        Ok(file)
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cred(uuid: &str, site: &str, username: &str, password: &str) -> Cred {
        Cred {
            uuid: uuid.to_string(),
            updated_at: 1_700_000_000_000,
            site: site.to_string(),
            username: username.to_string(),
            password: password.to_string(),
            notes: "some notes".to_string(),
        }
    }

    /// Create a vault → serialize → parse → unlock → verify record round-trip.
    #[test]
    fn seal_persist_reopen_unlock_decrypt_round_trips() {
        let password = "correct-horse-battery-staple";
        let cred = make_cred("uuid-1", "example.com", "alice", "s3cr3t!");

        // --- Create and seal ---
        let (file, vk) = init_vault(password).expect("init_vault failed");
        let salt_hex = file.get("salt").unwrap().as_str().unwrap();
        let salt = unhex(salt_hex).unwrap();
        let wire_record = seal_record(&vk, &cred).expect("seal_record failed");
        let records_sealed = vec![wire_record];
        let verifier = seal_verifier(&vk).expect("seal_verifier failed");
        let on_disk = file_json(&salt, verifier, &records_sealed);

        // --- Simulate a process restart: serialize to JSON string and parse back ---
        let json_str = serde_json::to_string(&on_disk).expect("serialize failed");
        let parsed: Value = serde_json::from_str(&json_str).expect("parse failed");

        // --- Unlock from the parsed file ---
        let (vk2, records) = unlock_vault(&parsed, password).expect("unlock_vault failed");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0], cred);
        // The re-derived key must produce the same bytes.
        assert_eq!(*vk, *vk2);
    }

    /// A wrong password must return WrongPassword, never panic, never produce records.
    #[test]
    fn wrong_password_fails_unlock() {
        let cred = make_cred("uuid-2", "bank.com", "bob", "hunter2");
        let (file, vk) = init_vault("right-password").expect("init failed");
        let salt_hex = file.get("salt").unwrap().as_str().unwrap();
        let salt = unhex(salt_hex).unwrap();
        let wire = seal_record(&vk, &cred).expect("seal failed");
        let verifier = seal_verifier(&vk).expect("verifier failed");
        let on_disk = file_json(&salt, verifier, &[wire]);

        let result = unlock_vault(&on_disk, "wrong-password");
        assert!(
            matches!(result, Err(VaultError::WrongPassword)),
            "expected WrongPassword, got: {result:?}"
        );
    }

    /// After lock(), the Inner.key is None and list() errors (Locked).
    #[test]
    fn lock_zeroizes_key_and_clears_records() {
        let vs = VaultState::default();

        // Create and unlock the vault.
        let _file = vs.create("my-pass").expect("create failed");
        assert!(vs.is_unlocked(), "should be unlocked after create");

        // Lock and verify state.
        vs.lock();
        assert!(!vs.is_unlocked(), "should be locked after lock()");

        // list() should now return Locked.
        let err = vs.list().unwrap_err();
        assert_eq!(err, VaultError::Locked);

        // Inner.records must be empty (no plaintext survives).
        let inner = vs.0.lock().unwrap();
        assert!(inner.records.is_empty(), "records must be empty after lock");
        assert!(inner.key.is_none(), "key must be None after lock");
    }

    /// The serialized on-disk JSON must contain NO plaintext of any sensitive field.
    #[test]
    fn record_at_rest_has_no_plaintext() {
        let cred = make_cred("uuid-3", "secret-bank.com", "carol", "TopS3cr3t!");
        let (file, vk) = init_vault("master").expect("init failed");
        let salt_hex = file.get("salt").unwrap().as_str().unwrap();
        let salt = unhex(salt_hex).unwrap();
        let wire = seal_record(&vk, &cred).expect("seal failed");
        let verifier = seal_verifier(&vk).expect("verifier failed");
        let on_disk = file_json(&salt, verifier, &[wire]);

        let json_str = serde_json::to_string(&on_disk).expect("serialize failed");

        // Sensitive plaintext must NOT appear in the serialized JSON.
        assert!(
            !json_str.contains("secret-bank.com"),
            "site leaked into ciphertext JSON"
        );
        assert!(
            !json_str.contains("carol"),
            "username leaked into ciphertext JSON"
        );
        assert!(
            !json_str.contains("TopS3cr3t!"),
            "password leaked into ciphertext JSON"
        );
        assert!(
            !json_str.contains("some notes"),
            "notes leaked into ciphertext JSON"
        );

        // The wire record must have nonce and ct fields (hex-encoded ciphertext).
        assert!(
            json_str.contains("\"nonce\""),
            "missing nonce field in wire record"
        );
        assert!(
            json_str.contains("\"ct\""),
            "missing ct field in wire record"
        );
    }

    /// Flipping a byte in a record's ct must make open_record return an error.
    #[test]
    fn tampered_ciphertext_fails_open() {
        let cred = make_cred("uuid-4", "shop.com", "dave", "pass123");
        let (file, vk) = init_vault("pw").expect("init failed");
        let salt_hex = file.get("salt").unwrap().as_str().unwrap();
        let salt = unhex(salt_hex).unwrap();
        let wire = seal_record(&vk, &cred).expect("seal failed");
        let verifier = seal_verifier(&vk).expect("verifier failed");
        let on_disk = file_json(&salt, verifier, std::slice::from_ref(&wire));

        // Serialize then parse so we have a clean Value to tamper with.
        let json_str = serde_json::to_string(&on_disk).unwrap();
        let mut parsed: Value = serde_json::from_str(&json_str).unwrap();

        // Flip the first byte of the ct hex in the first record.
        let ct_hex: String = {
            let ct_str = parsed["records"][0]["ct"].as_str().unwrap();
            let mut bytes = unhex(ct_str).unwrap();
            bytes[0] ^= 0xff; // flip the first byte
            hex(&bytes)
        };
        parsed["records"][0]["ct"] = Value::String(ct_hex);

        // Tampered ciphertext must fail AEAD verification, returning an error.
        let nonce = {
            let s = parsed["records"][0]["nonce"].as_str().unwrap();
            unhex(s).unwrap()
        };
        let ct = {
            let s = parsed["records"][0]["ct"].as_str().unwrap();
            unhex(s).unwrap()
        };
        let updated_at = parsed["records"][0]["updatedAt"].as_i64().unwrap();
        let uuid = parsed["records"][0]["uuid"].as_str().unwrap();

        let result = crate::crypto::open(&vk, &nonce, &ct, NS, uuid, &hlc_bytes(updated_at));
        assert!(result.is_err(), "tampered ciphertext must fail open");
    }

    /// upsert + remove mutation paths: exercises the Zeroizing-fixed key copy end-to-end.
    /// - create + unlock VaultState → upsert a Cred → seal/persist to JSON string
    /// - parse + unlock a fresh VaultState → assert the cred round-trips via list()
    /// - remove the cred → re-persist → parse + unlock a third VaultState → assert it's gone
    #[test]
    fn upsert_and_remove_mutation_round_trip() {
        let password = "mutation-test-password";
        let cred = make_cred("uuid-mut-1", "mutsite.com", "mutuser", "mutpass!");

        // --- Create a new vault and upsert the cred ---
        let vs1 = VaultState::default();
        let _initial_file = vs1.create(password).expect("create failed");
        let on_disk1 = vs1.upsert(cred.clone()).expect("upsert failed");

        // Simulate persisting + reloading: serialize then parse.
        let json1 = serde_json::to_string(&on_disk1).expect("serialize failed");
        let parsed1: Value = serde_json::from_str(&json1).expect("parse failed");

        // --- Unlock a fresh VaultState and confirm the cred is present ---
        let vs2 = VaultState::default();
        vs2.unlock(Some(&parsed1), password)
            .expect("unlock (after upsert) failed");
        let creds = vs2.list().expect("list failed");
        assert_eq!(creds.len(), 1, "expected exactly one cred after upsert");
        assert_eq!(creds[0], cred, "cred did not round-trip correctly");

        // --- Remove the cred from vs2 and re-persist ---
        let on_disk2 = vs2.remove(&cred.uuid).expect("remove failed");
        let json2 = serde_json::to_string(&on_disk2).expect("serialize after remove failed");
        let parsed2: Value = serde_json::from_str(&json2).expect("parse after remove failed");

        // --- Unlock a third VaultState and confirm the cred is gone ---
        let vs3 = VaultState::default();
        vs3.unlock(Some(&parsed2), password)
            .expect("unlock (after remove) failed");
        let creds_after = vs3.list().expect("list after remove failed");
        assert!(
            creds_after.is_empty(),
            "expected no creds after remove, got: {creds_after:?}"
        );
    }
}
