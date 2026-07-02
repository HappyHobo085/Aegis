//! Local, encrypted-at-rest password vault (Phase A — manage only, NO autofill).
//!
//! Credential records are sealed with the SAME XChaCha20-Poly1305 AEAD as the sync engine
//! (crypto::seal/open) under the dedicated "vault" namespace, gated by a master-password
//! Argon2id KDF (mirroring sync_keystore::derive_kek). The vault is NOT synced and NEVER
//! reachable from the content webview — there is no page->core bridge (locked decision).
use crate::crypto::{hex, unhex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
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
    // Raw wire records that failed to decrypt on unlock (corrupt/truncated ciphertext). Kept
    // VERBATIM and re-written by `persist` so a later mutation's re-seal never silently drops
    // them — a password vault must not destroy data it can't read. Surfaced as the
    // `undecryptable` count in `vault.state` so the user is warned. These are sealed
    // ciphertext, never plaintext.
    orphans: Vec<Value>,
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
#[allow(dead_code)]
pub fn init_vault(password: &str) -> Result<(Value, Zeroizing<[u8; 32]>), VaultError> {
    // Generate a fresh random 32-byte Argon2id salt.
    let mut salt = vec![0u8; 32];
    getrandom::getrandom(&mut salt).map_err(|e| VaultError::Crypto(e.to_string()))?;
    let vk = derive_vault_key(password, &salt)?;
    let verifier = seal_verifier(&vk)?;
    let file = file_json(&salt, verifier, &[]);
    Ok((file, vk))
}

/// The decrypted contents of an unlocked vault.
#[derive(Debug)]
pub struct UnlockedVault {
    pub key: Zeroizing<[u8; 32]>,
    pub records: Vec<Cred>,
    pub orphans: Vec<Value>,
}

/// Unlock an existing vault from its on-disk JSON. Derives the key, verifies it against the
/// verifier, then decrypts records. A record that fails to decrypt is NOT an error and is NOT
/// dropped — its wire form is returned as an "orphan" so a later re-seal preserves it (a
/// password vault must never destroy data it can't read); the caller surfaces the count.
/// `WrongPassword` iff the verifier (not a record) fails to authenticate. Used by
/// `VaultState::unlock`, which the production `vault.unlock` dispatch now routes through —
/// so this is the single unlock implementation.
pub fn unlock_vault(
    file: &Value,
    password: &str,
) -> Result<UnlockedVault, VaultError> {
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

    // Decrypt records; preserve any that fail (corrupt/truncated ciphertext) as orphans
    // rather than erroring out the whole unlock and losing the readable records with them.
    let mut records = Vec::new();
    let mut orphans = Vec::new();
    if let Some(arr) = file.get("records").and_then(Value::as_array) {
        for w in arr {
            match open_record(&vk, w) {
                Ok(c) => records.push(c),
                Err(_) => orphans.push(w.clone()),
            }
        }
    }

    Ok(UnlockedVault {
        key: vk,
        records,
        orphans,
    })
}

/// Re-seal all records (and the verifier) under `vk`, returning an updated on-disk JSON.
/// Called when adding/updating/removing a record while the vault is unlocked.
#[allow(dead_code)]
pub fn seal_vault(salt: &[u8], vk: &[u8; 32], records: &[Cred]) -> Result<Value, VaultError> {
    let verifier = seal_verifier(vk)?;
    let mut wire: Vec<Value> = Vec::with_capacity(records.len());
    for c in records {
        wire.push(seal_record(vk, c)?);
    }
    Ok(file_json(salt, verifier, &wire))
}

// ─── VaultState methods (pure, AppHandle-free) ──────────────────────────────

#[allow(dead_code)]
impl VaultState {
    /// Load an existing vault file into memory and derive the key.
    /// Returns `WrongPassword` if the password is wrong; `NotCreated` if `file` is None.
    pub fn unlock(&self, file: Option<&Value>, password: &str) -> Result<(), VaultError> {
        let file = file.ok_or(VaultError::NotCreated)?;
        let unlocked = unlock_vault(file, password)?;
        let mut inner = self.0.lock().unwrap();
        inner.key = Some(unlocked.key);
        inner.records = unlocked.records;
        inner.orphans = unlocked.orphans; // preserve undecryptable records (surfaced as `undecryptable`)
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
        inner.orphans.clear(); // re-read from disk on next unlock
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

// ─── Pure CRUD helpers (no AppHandle) ────────────────────────────────────────

/// Push a new `Cred` with a fresh uuid and `updated_at = now` onto `recs`, returning
/// a clone of the inserted record. Pure — no I/O, no AppHandle.
pub fn add_record(
    recs: &mut Vec<Cred>,
    site: &str,
    username: &str,
    password: &str,
    notes: &str,
    now: i64,
) -> Cred {
    let c = Cred {
        uuid: uuid::Uuid::new_v4().to_string(),
        updated_at: now,
        site: site.to_string(),
        username: username.to_string(),
        password: password.to_string(),
        notes: notes.to_string(),
    };
    recs.push(c.clone());
    c
}

/// Apply a partial update to the record with `uuid`, bumping `updated_at` to `now`.
/// Returns `true` iff the record was found. Pure — no I/O, no AppHandle.
pub fn update_record(
    recs: &mut [Cred],
    uuid: &str,
    site: Option<&str>,
    username: Option<&str>,
    password: Option<&str>,
    notes: Option<&str>,
    now: i64,
) -> bool {
    if let Some(c) = recs.iter_mut().find(|c| c.uuid == uuid) {
        if let Some(v) = site {
            c.site = v.to_string();
        }
        if let Some(v) = username {
            c.username = v.to_string();
        }
        if let Some(v) = password {
            c.password = v.to_string();
        }
        if let Some(v) = notes {
            c.notes = v.to_string();
        }
        c.updated_at = now;
        true
    } else {
        false
    }
}

/// Case-insensitive substring search over `site` and `username`.
/// An empty (or whitespace-only) query returns all records.
/// Pure — no I/O, no AppHandle.
pub fn search<'a>(recs: &'a [Cred], q: &str) -> Vec<&'a Cred> {
    let needle = q.trim().to_lowercase();
    recs.iter()
        .filter(|c| {
            needle.is_empty()
                || c.site.to_lowercase().contains(&needle)
                || c.username.to_lowercase().contains(&needle)
        })
        .collect()
}

// ─── File I/O layer (generic over Runtime so tests use MockRuntime) ───────────

/// Absolute path to the vault's at-rest file inside the app data dir.
pub fn vault_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("vault.json"))
}

/// Returns `true` iff a vault file currently exists on disk.
pub fn vault_exists<R: Runtime>(app: &AppHandle<R>) -> bool {
    vault_path(app).map(|p| p.exists()).unwrap_or(false)
}

/// Read + parse the at-rest vault file (with `.bak` recovery).
/// Returns `None` if absent, unreadable, or not valid JSON.
pub fn read_file<R: Runtime>(app: &AppHandle<R>) -> Option<Value> {
    vault_path(app)
        .and_then(|p| crate::jsonstore::read_with_backup(&p))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

/// Re-seal the current in-memory vault state to disk atomically (temp→rename, keeps `.bak`).
/// Called after every mutation while the vault is unlocked. Returns `Err` if locked.
pub fn persist<R: Runtime>(app: &AppHandle<R>, g: &Inner) -> Result<(), String> {
    let vk = g.key.as_ref().ok_or("vault is locked")?;
    let verifier = seal_verifier(vk)?;
    let mut records = Vec::with_capacity(g.records.len() + g.orphans.len());
    for c in &g.records {
        records.push(seal_record(vk, c)?);
    }
    // Pass through records that couldn't be decrypted on unlock verbatim — re-sealing only the
    // decrypted set would permanently drop them (silent credential loss). They stay sealed as-is.
    records.extend(g.orphans.iter().cloned());
    let file = file_json(&g.salt, verifier, &records);
    let p = vault_path(app).ok_or("no app data dir")?;
    let txt = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    crate::jsonstore::write_atomic(&p, txt.as_bytes()).map_err(|e| e.to_string())
}

// ─── IPC dispatcher ──────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    crate::jsonstore::now_ms()
}

fn state_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    let g = app.state::<VaultState>();
    let g = g.0.lock().unwrap();
    json!({
        "exists": g.created || vault_exists(app),
        "unlocked": g.key.is_some(),
        "count": g.records.len(),
        // Records present on disk that couldn't be decrypted (corrupt/truncated). Preserved,
        // not dropped — the UI warns the user instead of silently losing credentials.
        "undecryptable": g.orphans.len()
    })
}

fn emit_state<R: Runtime>(app: &AppHandle<R>) {
    crate::emit_event(app, "vault.state", state_json(app));
}

fn live_records(g: &Inner) -> Result<Value, String> {
    g.key
        .as_ref()
        .ok_or_else(|| "vault is locked".to_string())?;
    let arr: Vec<Value> = g
        .records
        .iter()
        .map(|c| {
            json!({
                "uuid": c.uuid, "updatedAt": c.updated_at, "site": c.site,
                "username": c.username, "password": c.password, "notes": c.notes,
            })
        })
        .collect();
    Ok(json!(arr))
}

pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let pw = || {
        payload
            .get("masterPassword")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match channel {
        "vault.getState" => Some(Ok(state_json(app))),

        "vault.create" => {
            if vault_exists(app) {
                return Some(Err("a vault already exists".into()));
            }
            let password = pw();
            if password.is_empty() {
                return Some(Err("master password required".into()));
            }
            let mut salt = [0u8; 32];
            if getrandom::getrandom(&mut salt).is_err() {
                return Some(Err("rng failed".into()));
            }
            let vk = match derive_vault_key(&password, &salt) {
                Ok(k) => k,
                Err(e) => return Some(Err(e)),
            };
            {
                let st = app.state::<VaultState>();
                let mut g = st.0.lock().unwrap();
                g.salt = salt.to_vec();
                g.key = Some(vk);
                g.records = Vec::new();
                g.orphans = Vec::new();
                g.created = true;
                if let Err(e) = persist(app, &g) {
                    return Some(Err(e));
                }
            }
            emit_state(app);
            Some(Ok(state_json(app)))
        }

        "vault.unlock" => {
            let Some(file) = read_file(app) else {
                return Some(Err("no vault to unlock".into()));
            };
            // Single source of truth: route through the same `VaultState::unlock` the unit
            // tests exercise. It preserves undecryptable records as orphans (surfaced as
            // `undecryptable` in state) instead of erroring and losing the readable records.
            let st = app.state::<VaultState>();
            if let Err(e) = st.unlock(Some(&file), &pw()) {
                return Some(Err(e.to_string()));
            }
            emit_state(app);
            Some(Ok(state_json(app)))
        }

        "vault.lock" => {
            {
                let st = app.state::<VaultState>();
                let mut g = st.0.lock().unwrap();
                g.key = None;
                g.records.clear();
                g.orphans.clear();
            }
            emit_state(app);
            Some(Ok(state_json(app)))
        }

        "vault.list" => {
            let st = app.state::<VaultState>();
            let g = st.0.lock().unwrap();
            Some(live_records(&g))
        }

        "vault.add" => {
            let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
            let site = input
                .get("site")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let username = input
                .get("username")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let password = input
                .get("password")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let notes = input
                .get("notes")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let st = app.state::<VaultState>();
            let mut g = st.0.lock().unwrap();
            if g.key.is_none() {
                return Some(Err("vault is locked".into()));
            }
            add_record(
                &mut g.records,
                &site,
                &username,
                &password,
                &notes,
                now_ms(),
            );
            if let Err(e) = persist(app, &g) {
                return Some(Err(e));
            }
            let out = live_records(&g);
            drop(g);
            emit_state(app);
            Some(out)
        }

        "vault.update" => {
            let uuid = payload
                .get("uuid")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let p = payload.get("partial").cloned().unwrap_or_else(|| json!({}));
            // Must bind to owned Strings so the &str references live long enough.
            let opt_site_s = p.get("site").and_then(Value::as_str).map(str::to_string);
            let opt_username_s = p
                .get("username")
                .and_then(Value::as_str)
                .map(str::to_string);
            let opt_password_s = p
                .get("password")
                .and_then(Value::as_str)
                .map(str::to_string);
            let opt_notes_s = p.get("notes").and_then(Value::as_str).map(str::to_string);
            let st = app.state::<VaultState>();
            let mut g = st.0.lock().unwrap();
            if g.key.is_none() {
                return Some(Err("vault is locked".into()));
            }
            update_record(
                &mut g.records,
                &uuid,
                opt_site_s.as_deref(),
                opt_username_s.as_deref(),
                opt_password_s.as_deref(),
                opt_notes_s.as_deref(),
                now_ms(),
            );
            if let Err(e) = persist(app, &g) {
                return Some(Err(e));
            }
            let out = live_records(&g);
            drop(g);
            emit_state(app);
            Some(out)
        }

        "vault.remove" => {
            let uuid = payload
                .get("uuid")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let st = app.state::<VaultState>();
            let mut g = st.0.lock().unwrap();
            if g.key.is_none() {
                return Some(Err("vault is locked".into()));
            }
            g.records.retain(|c| c.uuid != uuid);
            if let Err(e) = persist(app, &g) {
                return Some(Err(e));
            }
            let out = live_records(&g);
            drop(g);
            emit_state(app);
            Some(out)
        }

        "vault.search" => {
            let q = payload
                .get("q")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let st = app.state::<VaultState>();
            let g = st.0.lock().unwrap();
            if g.key.is_none() {
                return Some(Err("vault is locked".into()));
            }
            let arr: Vec<Value> = search(&g.records, &q)
                .into_iter()
                .map(|c| {
                    json!({
                        "uuid": c.uuid, "updatedAt": c.updated_at, "site": c.site,
                        "username": c.username, "password": c.password, "notes": c.notes,
                    })
                })
                .collect();
            Some(Ok(json!(arr)))
        }

        _ => None,
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
        let unlocked = unlock_vault(&parsed, password).expect("unlock_vault failed");
        let vk2 = unlocked.key;
        let records = unlocked.records;
        let orphans = unlocked.orphans;
        assert_eq!(records.len(), 1);
        assert_eq!(records[0], cred);
        assert!(orphans.is_empty(), "a valid record must not be orphaned");
        // The re-derived key must produce the same bytes.
        assert_eq!(*vk, *vk2);
    }

    /// `unlock_vault` (the unit-tested path now ALSO used by the production `vault.unlock`
    /// dispatch) must PRESERVE an undecryptable record as an orphan rather than erroring —
    /// matching `unlock_preserves_undecryptable_records_across_a_later_mutation`. This pins
    /// the unit path and the dispatch path to the same data-loss-safe behavior.
    #[test]
    fn unlock_vault_preserves_undecryptable_record_as_orphan() {
        let cred = make_cred("uuid-orphan", "x.com", "u", "p");
        let (file, vk) = init_vault("pw").expect("init");
        let salt = unhex(file.get("salt").unwrap().as_str().unwrap()).unwrap();
        let mut wire = seal_record(&vk, &cred).expect("seal");
        // Corrupt the ciphertext (valid hex, broken AEAD) so the record can't decrypt.
        let ct = wire["ct"].as_str().unwrap().to_string();
        let mut chars: Vec<char> = ct.chars().collect();
        chars[0] = if chars[0] == 'a' { 'b' } else { 'a' };
        wire["ct"] = json!(chars.into_iter().collect::<String>());
        let verifier = seal_verifier(&vk).expect("verifier");
        let on_disk = file_json(&salt, verifier, std::slice::from_ref(&wire));

        let unlocked = unlock_vault(&on_disk, "pw").expect("unlock must succeed");
        let records = unlocked.records;
        let orphans = unlocked.orphans;
        assert!(
            records.is_empty(),
            "the corrupt record is not a live record"
        );
        assert_eq!(
            orphans.len(),
            1,
            "the corrupt record is preserved as an orphan"
        );
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

    // ── Task-2 pure-helper tests ──────────────────────────────────────────────

    fn now_ms() -> i64 {
        crate::jsonstore::now_ms()
    }

    /// add_record pushes a Cred with a fresh uuid and `updated_at == now`.
    #[test]
    fn add_assigns_uuid_and_updated_at() {
        let mut recs: Vec<Cred> = Vec::new();
        let t = now_ms();
        let c = add_record(&mut recs, "https://example.com", "alice", "secret", "n", t);
        assert_eq!(recs.len(), 1);
        assert!(!c.uuid.is_empty(), "uuid must be non-empty");
        assert_eq!(c.updated_at, t);
        assert_eq!(recs[0].uuid, c.uuid);
    }

    /// update_record merges the partial and bumps updated_at.
    #[test]
    fn update_replaces_fields_and_bumps_updated_at() {
        let mut recs: Vec<Cred> = Vec::new();
        let t1 = 1_700_000_000_000i64;
        let c = add_record(&mut recs, "site.com", "bob", "old-pw", "", t1);
        let t2 = t1 + 1000;
        let found = update_record(&mut recs, &c.uuid, None, None, Some("new-pw"), None, t2);
        assert!(found, "update_record must return true for a known uuid");
        assert_eq!(recs[0].password, "new-pw");
        assert_eq!(recs[0].site, "site.com", "unchanged field must stay");
        assert_eq!(recs[0].updated_at, t2, "updated_at must be bumped");
    }

    /// remove_drops_the_record: uuid is gone after retain.
    #[test]
    fn remove_drops_the_record() {
        let mut recs: Vec<Cred> = Vec::new();
        let c = add_record(&mut recs, "a.com", "u", "p", "", now_ms());
        add_record(&mut recs, "b.com", "v", "q", "", now_ms());
        recs.retain(|r| r.uuid != c.uuid);
        assert_eq!(recs.len(), 1);
        assert!(recs.iter().all(|r| r.uuid != c.uuid));
    }

    /// search matches site and username case-insensitively; empty query returns all.
    #[test]
    fn search_matches_site_and_username_case_insensitively() {
        let mut recs: Vec<Cred> = Vec::new();
        add_record(&mut recs, "https://Example.com", "alice", "p", "", now_ms());
        add_record(
            &mut recs,
            "https://other.net",
            "ALICE_work",
            "p",
            "",
            now_ms(),
        );
        add_record(&mut recs, "https://nomatch.io", "bob", "p", "", now_ms());

        // Matches site of first record
        let hits = search(&recs, "exam");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].site, "https://Example.com");

        // Matches username of second record
        let hits2 = search(&recs, "alice");
        assert_eq!(hits2.len(), 2, "both alice records must match");

        // Empty query returns all
        let all = search(&recs, "");
        assert_eq!(all.len(), 3);

        // Whitespace-only also returns all
        let all2 = search(&recs, "   ");
        assert_eq!(all2.len(), 3);

        // No match
        let none = search(&recs, "zzznomatch");
        assert!(none.is_empty());
    }

    // ── Task-2 file-roundtrip tests (via with_tmp_app) ────────────────────────

    /// create → persist → file exists → fresh state → unlock → list is empty.
    #[test]
    fn create_persists_file_and_roundtrips_empty() {
        crate::test_support::with_tmp_app(|app| {
            let vs = VaultState::default();
            // Create transitions to unlocked and returns the on-disk JSON.
            let file_json_val = vs.create("master-pw").expect("create failed");

            // Persist to the temp dir.
            {
                let g = vs.0.lock().unwrap();
                persist(app, &g).expect("persist failed");
            }

            // File must exist.
            assert!(vault_exists(app), "vault file must exist after persist");

            // read_file must round-trip as valid JSON.
            let loaded = read_file(app).expect("read_file must return Some after persist");
            assert_eq!(loaded.get("v").and_then(Value::as_i64), Some(1));

            // Fresh VaultState + unlock → empty list.
            let vs2 = VaultState::default();
            vs2.unlock(Some(&loaded), "master-pw")
                .expect("unlock from file failed");
            let creds = vs2.list().expect("list failed");
            assert!(creds.is_empty(), "no creds yet");

            // Wrong password must fail.
            let vs3 = VaultState::default();
            assert!(matches!(
                vs3.unlock(Some(&file_json_val), "wrong-pw"),
                Err(VaultError::WrongPassword)
            ));
        });
    }

    /// add cred → persist → reload → cred is present.
    #[test]
    fn add_cred_persists_and_reloads() {
        crate::test_support::with_tmp_app(|app| {
            let vs = VaultState::default();
            vs.create("pw2").expect("create");

            // Add a record via add_record then upsert it.
            let t = now_ms();
            let cred = {
                let mut g = vs.0.lock().unwrap();
                let c = add_record(
                    &mut g.records,
                    "https://vault.test",
                    "carol",
                    "s3cr3t",
                    "notes",
                    t,
                );
                persist(app, &g).expect("persist after add");
                c
            };

            // Reload and verify.
            let loaded = read_file(app).expect("read_file");
            let vs2 = VaultState::default();
            vs2.unlock(Some(&loaded), "pw2").expect("unlock");
            let creds = vs2.list().expect("list");
            assert_eq!(creds.len(), 1);
            assert_eq!(creds[0].uuid, cred.uuid);
            assert_eq!(creds[0].site, "https://vault.test");
            assert_eq!(creds[0].username, "carol");
        });
    }

    /// update cred → persist → reload → updated fields present.
    #[test]
    fn update_cred_persists_and_reloads() {
        crate::test_support::with_tmp_app(|app| {
            let vs = VaultState::default();
            vs.create("pw3").expect("create");

            // Add then update.
            let uuid = {
                let mut g = vs.0.lock().unwrap();
                let c = add_record(&mut g.records, "old.site", "dan", "old-pw", "", now_ms());
                let uuid = c.uuid.clone();
                update_record(
                    &mut g.records,
                    &uuid,
                    Some("new.site"),
                    None,
                    Some("new-pw"),
                    None,
                    now_ms() + 1,
                );
                persist(app, &g).expect("persist after update");
                uuid
            };

            // Reload.
            let loaded = read_file(app).expect("read_file");
            let vs2 = VaultState::default();
            vs2.unlock(Some(&loaded), "pw3").expect("unlock");
            let creds = vs2.list().expect("list");
            assert_eq!(creds.len(), 1);
            assert_eq!(creds[0].uuid, uuid);
            assert_eq!(creds[0].site, "new.site");
            assert_eq!(creds[0].password, "new-pw");
            assert_eq!(creds[0].username, "dan", "unchanged field must persist");
        });
    }

    /// remove cred → persist → reload → gone.
    #[test]
    fn remove_cred_persists_and_is_gone_on_reload() {
        crate::test_support::with_tmp_app(|app| {
            let vs = VaultState::default();
            vs.create("pw4").expect("create");

            // Add two creds, remove one.
            let uuid_to_remove = {
                let mut g = vs.0.lock().unwrap();
                let c1 = add_record(&mut g.records, "keep.io", "eve", "p1", "", now_ms());
                let c2 = add_record(&mut g.records, "remove.io", "frank", "p2", "", now_ms());
                let remove_uuid = c2.uuid.clone();
                g.records.retain(|r| r.uuid != remove_uuid);
                persist(app, &g).expect("persist after remove");
                (c1.uuid.clone(), remove_uuid)
            };

            // Reload → only the kept cred is present.
            let loaded = read_file(app).expect("read_file");
            let vs2 = VaultState::default();
            vs2.unlock(Some(&loaded), "pw4").expect("unlock");
            let creds = vs2.list().expect("list");
            assert_eq!(creds.len(), 1);
            assert_eq!(creds[0].uuid, uuid_to_remove.0);
            assert!(creds.iter().all(|c| c.uuid != uuid_to_remove.1));
        });
    }

    /// Locked-state op returns Locked.
    #[test]
    fn locked_state_returns_locked_error() {
        let vs = VaultState::default();
        // Not created or unlocked → list returns Locked.
        assert!(matches!(vs.list(), Err(VaultError::Locked)));
        // upsert while locked → Locked.
        let cred = make_cred("uid", "x.com", "user", "pw");
        assert!(matches!(vs.upsert(cred), Err(VaultError::Locked)));
        // remove while locked → Locked.
        assert!(matches!(vs.remove("uid"), Err(VaultError::Locked)));
    }

    /// Wrong password on reload fails with WrongPassword.
    #[test]
    fn wrong_password_reload_fails() {
        crate::test_support::with_tmp_app(|app| {
            let vs = VaultState::default();
            vs.create("correct-pw").expect("create");
            {
                let g = vs.0.lock().unwrap();
                persist(app, &g).expect("persist");
            }
            let loaded = read_file(app).expect("read_file");
            let vs2 = VaultState::default();
            assert!(matches!(
                vs2.unlock(Some(&loaded), "wrong-pw"),
                Err(VaultError::WrongPassword)
            ));
        });
    }

    /// search filters correctly over the live records.
    #[test]
    fn search_filters_correctly_over_live_records() {
        let mut recs: Vec<Cred> = Vec::new();
        add_record(
            &mut recs,
            "https://github.com",
            "gh-user",
            "p",
            "",
            now_ms(),
        );
        add_record(
            &mut recs,
            "https://gitlab.com",
            "gl-user",
            "p",
            "",
            now_ms(),
        );
        add_record(
            &mut recs,
            "https://bitbucket.org",
            "bb-user",
            "p",
            "",
            now_ms(),
        );

        let hits = search(&recs, "git");
        assert_eq!(hits.len(), 2, "github + gitlab must match 'git'");

        let hits2 = search(&recs, "bb-user");
        assert_eq!(hits2.len(), 1);
        assert_eq!(hits2[0].site, "https://bitbucket.org");
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

    // ── Task-3 dispatch tests ─────────────────────────────────────────────────

    #[test]
    fn unlock_preserves_undecryptable_records_across_a_later_mutation() {
        crate::test_support::with_tmp_app(|app| {
            super::dispatch(app, "vault.create", &json!({"masterPassword": "pw"}))
                .unwrap()
                .unwrap();
            super::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "a.com", "username": "alice", "password": "p1", "notes": ""}}),
            )
            .unwrap()
            .unwrap();
            super::dispatch(app, "vault.lock", &json!({}))
                .unwrap()
                .unwrap();

            // Corrupt the single record's ciphertext on disk so it can't be decrypted on unlock.
            let p = vault_path(app).expect("vault path");
            let mut file: Value =
                serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            let ct = file["records"][0]["ct"].as_str().unwrap().to_string();
            let mut chars: Vec<char> = ct.chars().collect();
            chars[0] = if chars[0] == 'a' { 'b' } else { 'a' }; // flip a nibble: valid hex, broken AEAD
            file["records"][0]["ct"] = json!(chars.into_iter().collect::<String>());
            std::fs::write(&p, serde_json::to_string(&file).unwrap()).unwrap();

            // Unlock: the corrupted record is undecryptable — it must NOT appear as a live record,
            // and the count MUST be surfaced (not silently swallowed).
            let st = super::dispatch(app, "vault.unlock", &json!({"masterPassword": "pw"}))
                .unwrap()
                .unwrap();
            assert_eq!(
                st["count"],
                json!(0),
                "the corrupted record is not a live record"
            );
            assert_eq!(
                st["undecryptable"],
                json!(1),
                "the undecryptable-record count must be surfaced to the UI"
            );

            // A later mutation (add) must PRESERVE the undecryptable record, not erase it.
            super::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "b.com", "username": "bob", "password": "p2", "notes": ""}}),
            )
            .unwrap()
            .unwrap();

            let after: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
            let recs = after["records"].as_array().unwrap();
            assert_eq!(
                recs.len(),
                2,
                "the undecryptable record must survive a re-seal (1 orphan + 1 new)"
            );
        });
    }

    #[test]
    fn dispatch_roundtrip_create_unlock_add_list_search_update_remove_lock() {
        crate::test_support::with_tmp_app(|app| {
            // getState: not yet created
            let s = super::dispatch(app, "vault.getState", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(s["exists"], json!(false));
            assert_eq!(s["unlocked"], json!(false));

            // create
            let s = super::dispatch(app, "vault.create", &json!({"masterPassword": "hunter2"}))
                .unwrap()
                .unwrap();
            assert_eq!(s["exists"], json!(true));
            assert_eq!(s["unlocked"], json!(true));
            assert_eq!(s["count"], json!(0));

            // add two records
            let r1 = super::dispatch(
                app,
                "vault.add",
                &json!({
                    "input": { "site": "https://example.com", "username": "alice", "password": "s3cr3t", "notes": "note1" }
                }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(r1.as_array().unwrap().len(), 1);
            let uuid1 = r1[0]["uuid"].as_str().unwrap().to_string();

            let r2 = super::dispatch(
                app,
                "vault.add",
                &json!({
                    "input": { "site": "https://other.net", "username": "bob", "password": "p@ss", "notes": "" }
                }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(r2.as_array().unwrap().len(), 2);

            // list
            let list = super::dispatch(app, "vault.list", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(list.as_array().unwrap().len(), 2);

            // search — matches "alice"
            let hits = super::dispatch(app, "vault.search", &json!({"q": "alice"}))
                .unwrap()
                .unwrap();
            assert_eq!(hits.as_array().unwrap().len(), 1);
            assert_eq!(hits[0]["username"], json!("alice"));

            // list returns plaintext passwords (Phase A: chrome needs them for display/copy)
            assert_eq!(list[0]["password"], json!("s3cr3t"));

            // update uuid1: change password
            let updated = super::dispatch(
                app,
                "vault.update",
                &json!({ "uuid": uuid1, "partial": { "password": "new-pw" } }),
            )
            .unwrap()
            .unwrap();
            let rec = updated
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r["uuid"] == json!(uuid1))
                .unwrap();
            assert_eq!(rec["password"], json!("new-pw"));
            assert_eq!(rec["site"], json!("https://example.com"));

            // remove uuid1
            let after_remove = super::dispatch(app, "vault.remove", &json!({"uuid": uuid1}))
                .unwrap()
                .unwrap();
            assert_eq!(after_remove.as_array().unwrap().len(), 1);
            assert!(after_remove
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["uuid"] != json!(uuid1)));

            // lock
            let locked = super::dispatch(app, "vault.lock", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(locked["unlocked"], json!(false));
            assert_eq!(locked["count"], json!(0));

            // ops while locked → error
            let err = super::dispatch(app, "vault.list", &json!({}))
                .unwrap()
                .unwrap_err();
            assert!(err.contains("locked"), "expected locked error, got: {err}");
        });
    }

    #[test]
    fn dispatch_wrong_password_fails_unlock() {
        crate::test_support::with_tmp_app(|app| {
            super::dispatch(app, "vault.create", &json!({"masterPassword": "correct"}))
                .unwrap()
                .unwrap();
            super::dispatch(app, "vault.lock", &json!({}))
                .unwrap()
                .unwrap();
            let err = super::dispatch(app, "vault.unlock", &json!({"masterPassword": "wrong"}))
                .unwrap()
                .unwrap_err();
            assert!(
                err.contains("wrong master password"),
                "expected wrong password error, got: {err}"
            );
        });
    }

    #[test]
    fn dispatch_ops_while_locked_return_error() {
        crate::test_support::with_tmp_app(|app| {
            super::dispatch(app, "vault.create", &json!({"masterPassword": "pw"}))
                .unwrap()
                .unwrap();
            super::dispatch(app, "vault.lock", &json!({}))
                .unwrap()
                .unwrap();

            let list_err = super::dispatch(app, "vault.list", &json!({}))
                .unwrap()
                .unwrap_err();
            assert!(list_err.contains("locked"));

            let add_err = super::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site":"x.com","username":"u","password":"p","notes":""}}),
            )
            .unwrap()
            .unwrap_err();
            assert!(add_err.contains("locked"));

            let upd_err = super::dispatch(app, "vault.update", &json!({"uuid":"x","partial":{}}))
                .unwrap()
                .unwrap_err();
            assert!(upd_err.contains("locked"));

            let rem_err = super::dispatch(app, "vault.remove", &json!({"uuid":"x"}))
                .unwrap()
                .unwrap_err();
            assert!(rem_err.contains("locked"));

            let srch_err = super::dispatch(app, "vault.search", &json!({"q":"x"}))
                .unwrap()
                .unwrap_err();
            assert!(srch_err.contains("locked"));
        });
    }

    /// Full lock→file→unlock round-trip through the IPC dispatcher.
    ///
    /// Proves that `vault.unlock` reads the persisted file from disk and derives +
    /// decrypts fresh — NOT from in-memory state (which `vault.lock` clears).
    #[test]
    fn dispatch_lock_file_unlock_round_trip() {
        crate::test_support::with_tmp_app(|app| {
            // Step 1: create the vault via dispatch.
            let s = super::dispatch(app, "vault.create", &json!({"masterPassword": "master-pw"}))
                .unwrap()
                .unwrap();
            assert_eq!(s["exists"], json!(true));
            assert_eq!(s["unlocked"], json!(true));

            // Step 2: add a distinctive credential via dispatch.
            let added = super::dispatch(
                app,
                "vault.add",
                &json!({
                    "input": {
                        "site": "https://roundtrip.test",
                        "username": "roundtrip-user",
                        "password": "r0unDtr1P-s3cr3t!",
                        "notes": "dispatch round-trip note"
                    }
                }),
            )
            .unwrap()
            .unwrap();
            let records = added.as_array().unwrap();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0]["site"], json!("https://roundtrip.test"));

            // Step 3: lock the vault via dispatch; confirm in-memory state is cleared.
            let locked = super::dispatch(app, "vault.lock", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(locked["unlocked"], json!(false));
            assert_eq!(locked["count"], json!(0));

            // Confirm vault.list returns a locked error (in-memory key is gone).
            let list_err = super::dispatch(app, "vault.list", &json!({}))
                .unwrap()
                .unwrap_err();
            assert!(
                list_err.contains("locked"),
                "expected locked error after lock, got: {list_err}"
            );

            // Step 4: unlock via dispatch — this MUST re-read the persisted file from
            // disk and re-derive + re-decrypt (the in-memory key is None after lock).
            let unlocked =
                super::dispatch(app, "vault.unlock", &json!({"masterPassword": "master-pw"}))
                    .unwrap()
                    .unwrap();
            assert_eq!(
                unlocked["unlocked"],
                json!(true),
                "unlock from file must succeed"
            );

            // Step 5: list and confirm the distinctive credential survived
            // the lock → file → unlock round-trip.
            let list = super::dispatch(app, "vault.list", &json!({}))
                .unwrap()
                .unwrap();
            let creds = list.as_array().unwrap();
            assert_eq!(
                creds.len(),
                1,
                "exactly one credential must survive the round-trip"
            );
            assert_eq!(creds[0]["site"], json!("https://roundtrip.test"));
            assert_eq!(creds[0]["username"], json!("roundtrip-user"));
            assert_eq!(
                creds[0]["password"],
                json!("r0unDtr1P-s3cr3t!"),
                "plaintext password must survive lock→file→unlock"
            );
            assert_eq!(creds[0]["notes"], json!("dispatch round-trip note"));
        });
    }
}
