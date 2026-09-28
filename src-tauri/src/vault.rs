//! Local, encrypted-at-rest password vault (Phase A — manage only, NO autofill).
//!
//! Credential records are sealed with the SAME XChaCha20-Poly1305 AEAD as the sync engine
//! (crypto::seal/open) under the dedicated "pwvault" namespace, gated by a master-password
//! Argon2id KDF (mirroring sync_keystore::derive_kek).
//!
//! # The vault DOES sync, and how that is made to work
//!
//! The vault is part of E2E sync under the `pwvault` namespace, but only when the separate
//! `syncVault` opt-in is on. Sync moves the *sealed* records — the server and the transport
//! layer never see a credential — and the two halves of the problem are handled separately.
//!
//! **Portability (why records are readable on a paired device at all).** The key is
//! `Argon2id(master_password, salt)`, and the salt is a *plaintext* field of `vault.json`.
//! A salt is public by design, so nothing about it needs to be secret — the bug was never
//! that. The bug was that every device minted its OWN random salt, so `Argon2id` produced a
//! different key per device and no record could ever cross. So the account publishes ONE salt
//! (`sync_vault`'s `pwvault-meta` namespace) and a joining device **adopts** it by re-sealing
//! its own records under it — see [`KDF_V_SYNCED`], [`reseal_with_salt`] and
//! `sync_vault::try_adopt`. Because the KDF itself is unchanged, adoption is pure
//! re-encryption, and the adopted salt is cached locally, so removing the account later can
//! never brick the vault.
//!
//! **Integrity (why a remote record can no longer destroy a local one).** A record arriving
//! from a peer is only ever accepted after `open_record` authenticates it under the local
//! key; anything that fails is counted as quarantined and never written. The previous bridge
//! merged by `updatedAt` WITHOUT decrypting and rewrote the file preserving only
//! salt/verifier/kdf, so a peer — or a corrupted blob — could overwrite a real credential
//! with permanently unreadable ciphertext. That path no longer exists.
//!
//! The security posture this yields: a peer that holds the recovery phrase but NOT the master
//! password cannot read the vault (it lacks the Argon2id output) and cannot forge a record
//! that authenticates, so its writes are quarantined. A peer holding both is equivalent to
//! legitimate access, which is the point of pairing.
//!
//! # The content webview CAN reach autofill plumbing
//!
//! An older header also claimed the vault was "NEVER reachable from the content webview —
//! there is no page->core bridge". That was false: `adblock_inject` injects `vault_inject.js`
//! at document start, which emits `form:willSubmit` and listens on the app-wide Tauri event
//! bus for `vault:autofillResult`. Autofill stays inert only because `withGlobalTauri` is
//! not enabled (so pages have no `invoke`) and because no component subscribes to
//! `vault:requestFill` / `vault:autofillResult`. Do not read the inert state as a guarantee:
//! enabling `withGlobalTauri` would broadcast any credential to every open webview, since
//! Tauri's `app.emit` has no per-webview targeting.
use crate::crypto::{hex, unhex};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

static FAILED_ATTEMPTS: AtomicU32 = AtomicU32::new(0);

/// When the most recent failed unlock was recorded (ms since epoch; 0 = never). Paired with
/// [`FAILED_ATTEMPTS`] to implement a *non-blocking* unlock rate limit — see
/// [`remaining_backoff_ms`].
static LAST_FAILURE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The longest an unlock is refused for, regardless of how many attempts have failed.
const BACKOFF_MAX_MS: u64 = 300_000;

/// The backoff window for a given number of consecutive failures: 0 for the first two, then
/// 1s, 2s, 4s … doubling, clamped to [`BACKOFF_MAX_MS`].
///
/// Uses `saturating_pow` and a clamped exponent rather than `2u64.pow(n)`: the old
/// expression overflow-panicked in debug builds once `n` reached 64, and `n` is derived from a
/// counter that only ever grows.
fn backoff_ms(attempts: u32) -> u64 {
    if attempts < 3 {
        return 0;
    }
    let exp = (attempts - 3).min(20);
    1_000u64
        .saturating_mul(2u64.saturating_pow(exp))
        .min(BACKOFF_MAX_MS)
}

/// How long the caller must still wait before another unlock attempt is accepted (0 = now).
///
/// Also decays the counter: once a full window has elapsed with no further attempt, the streak
/// is forgotten, so a user who mistypes a few times, walks away, and comes back is not punished
/// for the earlier attempts. This is what the old code never did — `FAILED_ATTEMPTS` was
/// process-global, reset *only* by a successful unlock, so it ratcheted up over a session and
/// never came back down.
fn remaining_backoff_ms() -> u64 {
    let attempts = FAILED_ATTEMPTS.load(Ordering::Relaxed);
    let window = backoff_ms(attempts);
    if window == 0 {
        return 0;
    }
    let last = LAST_FAILURE_MS.load(Ordering::Relaxed);
    if last == 0 {
        return 0;
    }
    let elapsed = (now_ms().max(0) as u64).saturating_sub(last);
    if elapsed >= window {
        // The window elapsed unused — decay the streak and let the attempt through.
        FAILED_ATTEMPTS.store(0, Ordering::Relaxed);
        LAST_FAILURE_MS.store(0, Ordering::Relaxed);
        return 0;
    }
    window - elapsed
}

/// The user-facing throttle message. `after_failure` distinguishes "your attempt was just
/// refused because the password was wrong" from "the previous backoff is still running".
fn backoff_message(wait_ms: u64, after_failure: bool) -> String {
    if wait_ms == 0 {
        return if after_failure {
            "incorrect master password".to_string()
        } else {
            String::new()
        };
    }
    let secs = (wait_ms as f64 / 1000.0).ceil() as u64;
    if after_failure {
        format!("too many failed attempts — try again in {secs}s")
    } else {
        format!("too many failed attempts — wait {secs}s before trying again")
    }
}

pub(crate) const NS: &str = "pwvault";
const VERIFIER_UUID: &str = "verifier";
const VERIFIER_PLAINTEXT: &[u8] = b"aegis-vault-verifier-v1";
const VERIFIER_HLC: &[u8] = b"aegis-vault-verifier-v1"; // fixed AAD version tag for the verifier

/// The vault file's KDF version, stored in its `"v"` field.
///
/// **1 — local.** The Argon2id salt is 32 random bytes minted by whichever device created the
/// vault. Because every device mints its *own*, records sealed here are undecryptable on any
/// other device even with the right master password, so such a vault cannot sync.
///
/// **2 — adopted.** The salt is the one the sync account published for this vault (see
/// [`sync_vault`]), so every paired device derives the *same* `Argon2id(password, salt)` and
/// can read every other device's records. The derivation is deliberately UNCHANGED between v1
/// and v2 — only the salt's origin differs. That is what lets a device join an existing vault
/// by simply re-sealing its own records under the shared salt, with no new KDF, no
/// re-derivation of the password, and no risk of bricking a vault whose account is later
/// removed (the adopted salt stays cached locally in `vault-sync.json`).
pub(crate) const KDF_V_LOCAL: u64 = 1;
pub(crate) const KDF_V_SYNCED: u64 = 2;

/// The file's KDF version, defaulting to [`KDF_V_LOCAL`] for a file written before `"v"`
/// existed or that was tampered with into a non-numeric value.
pub fn file_version(file: &Value) -> u64 {
    file.get("v").and_then(Value::as_u64).unwrap_or(KDF_V_LOCAL)
}

/// The Argon2id salt this vault's records are sealed under.
pub fn file_salt(file: &Value) -> Option<Vec<u8>> {
    file.get("salt").and_then(Value::as_str).and_then(unhex)
}

/// One decrypted credential. Zeroized on drop so a dropped vault leaves no plaintext.
///
/// `Debug` is hand-written and REDACTED. The derive would print `site`, `username`,
/// `password` and `notes` in cleartext, and this type is exactly the one a developer reaches
/// for when something is wrong with a vault — so the derive makes the most likely debugging
/// line in the file into a credential leak, into a terminal scrollback, a CI log, or a bug
/// report. `uuid` and `updated_at` are not secrets (`updated_at` is bound as cleartext AAD)
/// and stay visible, because a redacted-everything `Debug` is one nobody can use.
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop, PartialEq)]
pub struct Cred {
    pub uuid: String,
    #[zeroize(skip)] // a millisecond timestamp isn't secret and is needed as cleartext AAD
    pub updated_at: i64,
    pub site: String,
    pub username: String,
    pub password: String,
    pub notes: String,
}

impl std::fmt::Debug for Cred {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cred")
            .field("uuid", &self.uuid)
            .field("updated_at", &self.updated_at)
            .field("site", &self.site)
            .field("username", &redacted(!self.username.is_empty()))
            .field("password", &redacted(!self.password.is_empty()))
            .field("notes", &redacted(!self.notes.is_empty()))
            .finish()
    }
}

/// The redaction marker. Reports WHETHER a field held anything, so a redacted dump still
/// distinguishes "empty" from "present but secret" — which is usually the question being
/// asked — without printing any of it.
fn redacted(present: bool) -> &'static str {
    if present {
        "<redacted>"
    } else {
        "<empty>"
    }
}

/// Argon2id(master_password, salt) -> 256-bit vault key.
///
/// Parameters: argon2id defaults (m_cost=19456/19 MiB, t_cost=2, p_cost=1) —
/// the OWASP 2024 minimum floor. For stronger offline-attack resistance on
/// desktop-class hardware, consider upgrading to m_cost=65536, t_cost=3, p_cost=4
/// (OWASP recommended). Changing params requires a KDF version migration for
/// existing vaults.
///
/// Reuses the exact derivation the sync passphrase path uses
/// (sync_keystore::derive_kek); kept as its own fn so the params stay
/// single-sourced if they ever change.
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
///
/// `pub(crate)` for the same reason as [`open_record`]: the sync bridge's tests must be able to
/// forge a record the way a malicious or buggy peer would, in order to prove such a record is
/// quarantined rather than merged.
pub(crate) fn seal_record(vk: &[u8; 32], c: &Cred) -> Result<Value, String> {
    let plaintext = Zeroizing::new(serde_json::to_vec(c).map_err(|e| e.to_string())?);
    let (nonce, ct) = crate::crypto::seal(vk, NS, &c.uuid, &hlc_bytes(c.updated_at), &plaintext)?;
    Ok(json!({ "uuid": c.uuid, "updatedAt": c.updated_at, "nonce": hex(&nonce), "ct": hex(&ct) }))
}

/// Open a wire record back into a Cred, authenticating against its cleartext uuid/updatedAt.
///
/// Thin wrapper over [`open_kind`] that rejects tombstones, for callers that want "a
/// credential or an error".
///
/// `#[cfg(test)]` because it no longer has a production caller: once tombstones existed, the
/// merge and unlock paths both need to tell a tombstone from a credential, so they call
/// `open_kind` directly, and only the tests want the narrower shape. Without the attribute the
/// release build sees dead code and `clippy -- -D warnings` fails.
#[cfg(test)]
pub(crate) fn open_record(vk: &[u8; 32], w: &Value) -> Result<Cred, String> {
    match open_kind(vk, w)? {
        Opened::Cred(c) => Ok(c),
        Opened::Tombstone => Err("record is a tombstone".into()),
    }
}

/// The sealed plaintext of a tombstone. Short, fixed, and — critically — DISTINCT from any
/// serialized [`Cred`]: a `Cred` always has a `uuid` string, so a body carrying `"t"` can never
/// be confused with a live credential in either direction.
const TOMBSTONE_BODY: &[u8] = br#"{"t":1}"#;

/// What an authenticated wire record turned out to be.
pub(crate) enum Opened {
    Cred(Cred),
    Tombstone,
}

/// Seal a *tombstone* for `uuid` — an authenticated "this record is deleted at `updated_at`"
/// marker, carrying no credential material whatsoever.
///
/// ## Why a tombstone exists
/// Every other synced namespace in this app (favorites, history, downloads, allowlist, …) carries
/// a `deleted` flag through the same HLC-LWW merge. The vault did not, and that turned a *local*
/// delete into a **resurrection**: `vault.remove` dropped the record from memory and disk, but
/// nothing told any peer, so the next pull of a still-provisioned device re-added it — and the
/// ciphertext, which for a password the user deleted *because it leaked*, sat on the server
/// forever. `merge_remote` had no branch that could drop a record at all.
///
/// ## Why it is a sealed record and not a cleartext flag
/// A cleartext `deleted: true` would let any peer delete any credential it can name, with no key.
/// Here the tombstone is sealed under the vault key with the SAME AAD as a live record —
/// `(NS, uuid, hlc_bytes(updated_at))` — so forging one still requires the vault key, and the
/// AAD already binds both the identity and the timestamp the merge orders by. The cleartext
/// `deleted` field on the wire is an **advisory hint for the server's pruning only**; the
/// authoritative signal is the sealed body, which is what `open_kind` decides on. A peer that
/// flips the hint to `false` still gets a tombstone, because the body is what decrypts.
pub(crate) fn seal_tombstone(vk: &[u8; 32], uuid: &str, updated_at: i64) -> Result<Value, String> {
    let (nonce, ct) = crate::crypto::seal(vk, NS, uuid, &hlc_bytes(updated_at), TOMBSTONE_BODY)?;
    Ok(json!({
        "uuid": uuid,
        "updatedAt": updated_at,
        "deleted": true,
        "nonce": hex(&nonce),
        "ct": hex(&ct),
    }))
}

/// Authenticate a wire record and report what it is — a live credential or a tombstone.
///
/// Shared by [`open_record`] (which only accepts the former) and the unlock/merge paths (which
/// must handle both). Authenticates first and decides from the *decrypted body*, never from the
/// cleartext hint.
pub(crate) fn open_kind(vk: &[u8; 32], w: &Value) -> Result<Opened, String> {
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
    if pt.as_slice() == TOMBSTONE_BODY {
        return Ok(Opened::Tombstone);
    }
    // The parse happens on the DECRYPTED body, so serde's `Display` would describe recovered
    // user data (see `crypto::redact_json_error`). This string is what the quarantine log and
    // the IPC error both carry.
    serde_json::from_slice(&pt)
        .map(Opened::Cred)
        .map_err(|e| crate::crypto::redact_json_error(&e))
}

/// Record a deletion marker, keeping the NEWEST one per uuid.
///
/// Last-writer-wins on the timestamp. A delete is a synced record like any other, so it has to
/// interleave correctly with the edits around it: a stale tombstone must not erase a credential
/// that was re-saved afterwards, and a newer one must win.
fn upsert_tombstone(list: &mut Vec<(String, i64)>, uuid: String, at: i64) {
    match list.iter_mut().find(|(u, _)| *u == uuid) {
        Some(slot) => slot.1 = slot.1.max(at),
        None => list.push((uuid, at)),
    }
}

/// True when a deletion marker for `uuid` is at least as new as `updated_at`, i.e. the record
/// has been deleted and must not come back.
fn is_tombstoned(list: &[(String, i64)], uuid: &str, updated_at: i64) -> bool {
    list.iter().any(|(u, at)| u == uuid && *at >= updated_at)
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
    // `Zeroizing`, matching `open_kind`/`open_tombstone` above: the decrypted verifier is a
    // copy of a known constant, so it is not itself a secret — but it is a plaintext buffer
    // on the heap, and the point of zeroizing the other two is that this class of buffer
    // never survives the function that made it.
    let pt = Zeroizing::new(
        crate::crypto::open(vk, &nonce, &ct, NS, VERIFIER_UUID, VERIFIER_HLC)
            .map_err(|_| "wrong master password".to_string())?,
    );
    if pt.as_slice() == VERIFIER_PLAINTEXT {
        Ok(())
    } else {
        Err("wrong master password".into())
    }
}

/// Build the on-disk JSON object from the verifier + sealed records (the at-rest file).
///
/// `v` is the KDF version — see [`KDF_V_LOCAL`] / [`KDF_V_SYNCED`]. Raising it requires a
/// migration that re-seals under the new parameters, which for the v1→v2 bump is exactly
/// [`reseal_with_salt`] (triggered at unlock, see `sync_vault`).
fn file_json(salt: &[u8], verifier: Value, records: &[Value], v: u64) -> Value {
    json!({ "v": v, "kdf": "argon2id", "salt": hex(salt), "verifier": verifier, "records": records })
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
    // Deletion markers (uuid, deleted-at) — see `seal_tombstone`. A credential the user deleted
    // must STAY deleted when a peer that still has it pushes again, so the delete has to be a
    // first-class, synced, ordered record rather than a local removal.
    tombstones: Vec<(String, i64)>,
    salt: Vec<u8>, // the Argon2 salt for THIS vault (loaded from the file)
    version: u64,  // the file's KDF version — see `KDF_V_LOCAL` / `KDF_V_SYNCED`
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
///
/// `salt` is the Argon2id salt to use. A **local** vault passes a fresh random one; a vault
/// created while a shared salt is already cached passes that instead, so the new vault is
/// born [`KDF_V_SYNCED`] and its records are readable by the account's other devices from the
/// very first write. The derivation is the same either way — only the salt's origin differs.
pub fn init_vault_with_salt(
    password: &str,
    salt: &[u8],
    version: u64,
) -> Result<(Value, Zeroizing<[u8; 32]>), VaultError> {
    let vk = derive_vault_key(password, salt)?;
    let verifier = seal_verifier(&vk)?;
    let file = file_json(salt, verifier, &[], version);
    Ok((file, vk))
}

/// [`init_vault_with_salt`] with a fresh random 32-byte salt from the OS CSPRNG — the
/// local-only (v1) case.
pub fn init_vault(password: &str) -> Result<(Value, Zeroizing<[u8; 32]>), VaultError> {
    let mut salt = vec![0u8; 32];
    getrandom::getrandom(&mut salt).map_err(|e| VaultError::Crypto(e.to_string()))?;
    init_vault_with_salt(password, &salt, KDF_V_LOCAL)
}

/// The decrypted contents of an unlocked vault.
///
/// `Debug` is hand-written and REDACTED, and here the stakes are higher than on [`Cred`]:
/// the derived form would print `key` — the 32-byte vault key that every record is sealed
/// under — in hex, plus every credential in the vault. A single `{:#?}` of this value is a
/// complete plaintext password dump and a ready-to-use vault key, and this is the type a
/// developer prints when a vault looks wrong. Only the counts and the key's PRESENCE are
/// reported; the key itself is never formatted.
#[derive(PartialEq)]
pub struct UnlockedVault {
    pub key: Zeroizing<[u8; 32]>,
    pub records: Vec<Cred>,
    pub orphans: Vec<Value>,
    /// Deletion markers, newest-wins per uuid. See [`seal_tombstone`] for why these exist and
    /// why they are sealed rather than a cleartext flag.
    pub tombstones: Vec<(String, i64)>,
}

impl std::fmt::Debug for UnlockedVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnlockedVault")
            .field("key", &redacted(!self.key.iter().all(|b| *b == 0)))
            .field("records", &self.records.len())
            .field("orphans", &self.orphans.len())
            .field("tombstones", &self.tombstones.len())
            .finish()
    }
}

/// Unlock an existing vault from its on-disk JSON. Derives the key, verifies it against the
/// verifier, then decrypts records. A record that fails to decrypt is NOT an error and is NOT
/// dropped — its wire form is returned as an "orphan" so a later re-seal preserves it (a
/// password vault must never destroy data it can't read); the caller surfaces the count.
/// `WrongPassword` iff the verifier (not a record) fails to authenticate. Used by
/// `VaultState::unlock`, which the production `vault.unlock` dispatch now routes through —
/// so this is the single unlock implementation.
pub fn unlock_vault(file: &Value, password: &str) -> Result<UnlockedVault, VaultError> {
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
    let mut tombstones: Vec<(String, i64)> = Vec::new();
    if let Some(arr) = file.get("records").and_then(Value::as_array) {
        for w in arr {
            // A tombstone and a credential are both just sealed records in this same array, so
            // classify on the AUTHENTICATED body (`open_kind`) — never on the cleartext
            // `deleted` hint. Only a genuine decrypt failure is an orphan.
            match open_kind(&vk, w) {
                Ok(Opened::Cred(c)) => records.push(c),
                Ok(Opened::Tombstone) => {
                    if let (Some(uuid), Some(at)) = (
                        w.get("uuid").and_then(Value::as_str),
                        w.get("updatedAt").and_then(Value::as_i64),
                    ) {
                        upsert_tombstone(&mut tombstones, uuid.to_string(), at);
                    }
                }
                Err(_) => orphans.push(w.clone()),
            }
        }
    }

    Ok(UnlockedVault {
        key: vk,
        records,
        tombstones,
        orphans,
    })
}

/// Re-seal all records under `new_salt`, returning a [`KDF_V_SYNCED`] vault file.
///
/// This is how a device **adopts** a shared vault: the account publishes one salt, and every
/// paired device re-seals its own records under it so they all derive the same key. Because
/// the KDF is unchanged, adoption is a pure re-encryption — no new password derivation and
/// nothing to migrate but the ciphertext.
///
/// Fails (without touching anything) when the password is wrong, or when the vault holds
/// records it cannot decrypt: re-sealing rewrites the record array, so carrying orphans
/// across is impossible and dropping them would be silent credential loss. The caller is
/// expected to surface that and leave the vault local-only.
pub fn reseal_with_salt(
    file: &Value,
    password: &str,
    new_salt: &[u8],
) -> Result<Value, VaultError> {
    let cur_salt = file_salt(file).ok_or_else(|| VaultError::Crypto("missing salt".into()))?;
    // Authenticate the password against the CURRENT key first. Without this a wrong password
    // would "succeed", producing an empty vault under the new salt and destroying the records.
    let unlocked = unlock_vault(file, password)?;
    if !unlocked.orphans.is_empty() {
        return Err(VaultError::Crypto(format!(
            "cannot adopt a shared vault: {} record(s) here are undecryptable and a re-seal \
             would drop them",
            unlocked.orphans.len()
        )));
    }
    if cur_salt == new_salt {
        // Already on the shared salt — just stamp the version so `state_json` can report it.
        let mut out = file.clone();
        if let Some(o) = out.as_object_mut() {
            o.insert("v".into(), json!(KDF_V_SYNCED));
        }
        return Ok(out);
    }
    let vk = derive_vault_key(password, new_salt)?;
    let mut wire = Vec::with_capacity(unlocked.records.len());
    for c in &unlocked.records {
        wire.push(seal_record(&vk, c)?);
    }
    let verifier = seal_verifier(&vk)?;
    Ok(file_json(new_salt, verifier, &wire, KDF_V_SYNCED))
}

/// Adopt a re-sealed vault file into the live state.
///
/// `new_file` must already be on disk (written by the caller). This re-derives the key for the
/// NEW salt, repoints the in-memory state at it, and re-flushes the records — which are
/// unchanged by a re-seal, only re-encrypted — so the in-memory vault and the file agree.
///
/// The password is required because the key is salted: without it we could not produce the key
/// that `new_file` was sealed under, and persisting the old key's ciphertext under the new
/// salt would make every record permanently unreadable.
pub(crate) fn adopt_resealed<R: Runtime>(
    app: &AppHandle<R>,
    new_file: &Value,
    password: &str,
) -> Result<(), String> {
    let salt = file_salt(new_file).ok_or("re-sealed vault is missing its salt")?;
    let version = file_version(new_file);
    // Re-derive under the new salt. `reseal_with_salt` already authenticated the password
    // against the old file, so a wrong password cannot reach here.
    let vk = derive_vault_key(password, &salt)?;
    let st = app
        .try_state::<VaultState>()
        .ok_or("vault state unavailable")?;
    let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
    g.salt = salt;
    g.version = version;
    g.key = Some(vk);
    // `g.records` / `g.orphans` are deliberately untouched: a re-seal moves bytes, not data.
    // If a re-seal ever did change the record set, that would be a bug worth failing on.
    persist(app, &g)
}

/// What [`merge_remote`] did, so the sync pass can report it.
#[derive(Debug, Default, PartialEq)]
pub struct MergeOutcome {
    /// uuids added or replaced.
    pub changed: Vec<String>,
    /// Records that arrived but did not authenticate under the local key. Never written.
    pub quarantined: Vec<String>,
}

/// Merge sealed records from a peer into the UNLOCKED in-memory vault, then persist once.
///
/// Every incoming record is authenticated with [`open_record`] **before** it is allowed to
/// influence the vault, and only a record that decrypts is eligible for the
/// `updatedAt`-newer replacement. This is the fix for the original bridge, which merged on
/// `updatedAt` alone and rewrote the file preserving only salt/verifier/kdf — so a peer could
/// overwrite a real credential with permanently unreadable ciphertext.
///
/// Merging happens in memory and is flushed by a single [`persist`], so the on-disk file can
/// never be left holding a partial merge. Returns `Err` only if the vault is locked or the
/// final write fails; a `quarantined` entry is never fatal, by design.
pub(crate) fn merge_remote<R: Runtime>(
    app: &AppHandle<R>,
    remote: &[Value],
) -> Result<MergeOutcome, String> {
    let st = app
        .try_state::<VaultState>()
        .ok_or("vault state unavailable")?;
    let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
    let vk = g.key.clone().ok_or("vault is locked")?;
    let mut out = MergeOutcome::default();

    for r in remote {
        let Some(uuid) = r.get("uuid").and_then(Value::as_str) else {
            out.quarantined.push("<no-uuid>".into());
            continue;
        };
        // Authenticate FIRST. An unauthenticated record must not be able to displace a good one,
        // and only an authenticated tombstone is allowed to delete anything.
        let cred = match open_kind(&vk, r) {
            Ok(Opened::Cred(c)) => c,
            Ok(Opened::Tombstone) => {
                let Some(at) = r.get("updatedAt").and_then(Value::as_i64) else {
                    out.quarantined.push(uuid.to_string());
                    continue;
                };
                upsert_tombstone(&mut g.tombstones, uuid.to_string(), at);
                // The delete is authoritative: drop the local copy outright.
                let before = g.records.len();
                g.records.retain(|c| c.uuid != uuid);
                if g.records.len() != before {
                    out.changed.push(uuid.to_string());
                }
                continue;
            }
            Err(e) => {
                eprintln!("[aegis-vault] quarantined {uuid} from sync: {e}");
                out.quarantined.push(uuid.to_string());
                continue;
            }
        };
        // The cleartext uuid the record claims must match the one the ciphertext authenticated
        // under — `open_kind` binds uuid into the AAD, so a mismatch cannot have decrypted.
        debug_assert_eq!(cred.uuid, uuid);
        // A delete at least as new as this edit wins. THIS is what makes a delete stick: the peer
        // is pushing a version the user already removed, and accepting it would resurrect the
        // credential — permanently, since that peer would re-push it on every pass.
        if is_tombstoned(&g.tombstones, &cred.uuid, cred.updated_at) {
            eprintln!(
                "[aegis-vault] dropped {} — deleted at/after this edit",
                cred.uuid
            );
            // Only report a change if there WAS a local copy to remove. A peer re-pushing an
            // already-deleted credential is a no-op, and listing it in `changed` would claim
            // local state moved when it did not (and drive a pointless re-seal/push).
            let before = g.records.len();
            g.records.retain(|c| c.uuid != cred.uuid);
            if g.records.len() != before {
                out.changed.push(cred.uuid.clone());
            }
            continue;
        }
        // Genuinely newer than the delete ⇒ the credential was re-added after the delete, so the
        // delete no longer applies to it.
        g.tombstones.retain(|(u, _)| *u != cred.uuid);
        match g.records.iter_mut().find(|c| c.uuid == cred.uuid) {
            Some(local) => {
                if cred.updated_at > local.updated_at {
                    *local = cred;
                    out.changed.push(uuid.to_string());
                }
            }
            None => {
                g.records.push(cred);
                out.changed.push(uuid.to_string());
            }
        }
    }

    if !out.changed.is_empty() {
        persist(app, &g)?;
    }
    Ok(out)
}

/// The vault key, but only while the vault is unlocked.
///
/// Vault sync needs this to authenticate an incoming record before it is allowed anywhere
/// near the file, so a **locked vault does not sync at all**: it is neither uploaded nor
/// merged. That is deliberate — you cannot merge records you cannot decrypt, and writing
/// unverified ciphertext to disk is precisely the bug that made the old bridge destructive.
pub fn unlocked_key<R: Runtime>(app: &AppHandle<R>) -> Option<Zeroizing<[u8; 32]>> {
    app.try_state::<VaultState>()?
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .key
        .clone()
}

/// True when this device's vault has adopted the account's shared salt, i.e. it can actually
/// read records sealed on a paired device.
pub fn is_synced<R: Runtime>(app: &AppHandle<R>) -> bool {
    match read_file(app) {
        Some(f) => file_version(&f) >= KDF_V_SYNCED,
        None => false,
    }
}

/// Stamp a v1 vault whose salt is ALREADY the account's shared salt as [`KDF_V_SYNCED`].
///
/// Returns `Ok(true)` if it stamped, `Ok(false)` if there was nothing to do (no vault, a
/// salt that is not the account's, or already stamped).
///
/// This is deliberately password-free, and that is the entire point. Adoption normally
/// *changes* the salt, so it has to re-seal every record and therefore needs the master
/// password (see [`reseal_with_salt`] / `sync_vault::try_adopt`). But when the salt is
/// already the account's, the key sitting in memory is byte-for-byte the key the password
/// would derive, so a re-seal would be a cryptographic no-op and the version stamp is the
/// only thing missing. That is what lets the device which *published* the account's salt
/// reach a synced vault inside a sync pass — where no master password exists at all —
/// instead of waiting for a lock/unlock cycle that a user who created the vault a minute
/// ago has no reason to perform.
///
/// The lock is what makes this safe to do from the sync thread: every production writer of
/// `vault.json` holds it across its write (all of them go through [`persist`]), so the
/// read-modify-write below cannot interleave with a `vault.add` and revert a credential.
pub(crate) fn stamp_shared_salt<R: Runtime>(
    app: &AppHandle<R>,
    shared: &[u8],
) -> Result<bool, String> {
    let st = app
        .try_state::<VaultState>()
        .ok_or("vault state unavailable")?;
    let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some(file) = read_file(app) else {
        return Ok(false); // no vault on this device
    };
    if file_salt(&file).as_deref() != Some(shared) {
        return Ok(false); // our own salt is not the account's; that is adoption's job
    }
    if file_version(&file) >= KDF_V_SYNCED {
        return Ok(false); // already stamped
    }
    if g.key.is_some() {
        // Unlocked, so the live state is authoritative: stamp through `persist` rather than
        // writing a snapshot of the file back. Refuse if the two disagree about the salt —
        // stamping a file whose records are sealed under a different key would publish
        // unopenable records, which is strictly worse than not syncing at all.
        if g.salt.as_slice() != shared {
            return Err(format!(
                "the live vault is sealed under a different salt than its file ({} bytes vs {} \
                 bytes); refusing to stamp it as account-synced",
                g.salt.len(),
                shared.len()
            ));
        }
        g.version = KDF_V_SYNCED;
        persist(app, &g)?;
        return Ok(true);
    }
    // Locked, so nothing can mutate the file and rewriting the one field in place is safe.
    // The next `unlock` reads this version into `Inner::version`, which is what the next
    // `persist` re-stamps from — so the stamp survives the next credential write too.
    let mut out = file;
    let Some(o) = out.as_object_mut() else {
        return Err("vault file is not a JSON object".into());
    };
    o.insert("v".into(), json!(KDF_V_SYNCED));
    let p = vault_path(app).ok_or("no app data dir")?;
    let txt = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
    crate::jsonstore::write_atomic(&p, txt.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Re-emit `vault.state` after something outside this module changed the vault file.
///
/// Every other emission is driven by a local mutation inside [`dispatch`], so the sync pass
/// stamping a vault as the account's (see [`stamp_shared_salt`]) had no way to tell the UI —
/// which would then keep reporting `syncEnabled: false` until the panel was reopened.
pub(crate) fn emit_state_after_external_change<R: Runtime>(app: &AppHandle<R>) {
    emit_state(app);
}

/// Re-seal all records (and the verifier) under `vk`, returning an updated on-disk JSON.
/// Called when adding/updating/removing a record while the vault is unlocked.
pub fn seal_vault(salt: &[u8], vk: &[u8; 32], records: &[Cred]) -> Result<Value, VaultError> {
    seal_vault_versioned(salt, vk, records, KDF_V_LOCAL)
}

/// [`seal_vault`] with an explicit KDF version stamp.
pub fn seal_vault_versioned(
    salt: &[u8],
    vk: &[u8; 32],
    records: &[Cred],
    v: u64,
) -> Result<Value, VaultError> {
    let verifier = seal_verifier(vk)?;
    let mut wire: Vec<Value> = Vec::with_capacity(records.len());
    for c in records {
        wire.push(seal_record(vk, c)?);
    }
    Ok(file_json(salt, verifier, &wire, v))
}

// ─── VaultState methods (pure, AppHandle-free) ──────────────────────────────

#[allow(dead_code)] // pub methods called via ipc dispatcher — lib-crate analysis can't trace the dispatch
impl VaultState {
    /// Load an existing vault file into memory and derive the key.
    /// Returns `WrongPassword` if the password is wrong; `NotCreated` if `file` is None.
    pub fn unlock(&self, file: Option<&Value>, password: &str) -> Result<(), VaultError> {
        let file = file.ok_or(VaultError::NotCreated)?;
        let unlocked = unlock_vault(file, password)?;
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.key = Some(unlocked.key);
        inner.records = unlocked.records;
        inner.orphans = unlocked.orphans; // preserve undecryptable records (surfaced as `undecryptable`)
        inner.tombstones = unlocked.tombstones;
        inner.created = true;
        // Extract salt for re-sealing later, and the KDF version so `persist` keeps stamping it.
        if let Some(s) = file_salt(file) {
            inner.salt = s;
        }
        inner.version = file_version(file);
        Ok(())
    }

    /// Create a new vault with `password`, transitioning to the unlocked state.
    /// Returns the on-disk JSON the caller must persist.
    pub fn create(&self, password: &str) -> Result<Value, VaultError> {
        let (file, vk) = init_vault(password)?;
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let salt = file_salt(&file).unwrap_or_default();
        inner.key = Some(vk);
        inner.records = Vec::new();
        inner.salt = salt;
        inner.version = file_version(&file);
        inner.created = true;
        Ok(file)
    }

    /// Lock the vault: zeroize the derived key and drop all decrypted records.
    pub fn lock(&self) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.key = None; // Zeroizing<[u8;32]> zeroizes on drop
        inner.records.clear(); // Cred implements ZeroizeOnDrop
        inner.records.shrink_to_fit();
        inner.orphans.clear(); // re-read from disk on next unlock
        inner.tombstones.clear();
    }

    /// Returns true if the vault is currently unlocked.
    pub fn is_unlocked(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .key
            .is_some()
    }

    /// List all credentials. Returns `Locked` if not unlocked.
    pub fn list(&self) -> Result<Vec<Cred>, VaultError> {
        let inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.key.is_none() {
            return Err(VaultError::Locked);
        }
        Ok(inner.records.clone())
    }

    /// Add or replace a credential (matched by uuid). Returns the updated on-disk JSON.
    pub fn upsert(&self, cred: Cred) -> Result<Value, VaultError> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        // Copy the key bytes into a Zeroizing wrapper so the copy is zeroized on return,
        // leaving no key residue on the stack after the function exits.
        let vk = Zeroizing::new(*inner.key.as_deref().ok_or(VaultError::Locked)?);
        inner.records.retain(|r| r.uuid != uuid);
        let file = seal_vault(&inner.salt, &vk, &inner.records)?;
        Ok(file)
    }

    /// Return credentials matching a browsing domain for autofill suggestions.
    /// The vault MUST be unlocked (the master password was already entered to reach this).
    /// Matching is a case-insensitive suffix check: `example.com` matches `login.example.com`.
    pub fn autofill_suggestions(&self, domain: &str) -> Result<Vec<Cred>, VaultError> {
        let inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.key.is_none() {
            return Err(VaultError::Locked);
        }
        let needle = domain.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        Ok(inner
            .records
            .iter()
            .filter(|c| {
                let site = c.site.to_lowercase();
                site == needle || site.ends_with(&format!(".{needle}"))
            })
            .cloned()
            .collect())
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
    let mut records = Vec::with_capacity(g.records.len() + g.tombstones.len() + g.orphans.len());
    for c in &g.records {
        records.push(seal_record(vk, c)?);
    }
    // Deletion markers are sealed alongside the credentials so a delete survives a restart and,
    // once synced, is what stops a peer re-adding the record. They must round-trip through the
    // file exactly like a credential does — dropping them here would silently un-delete
    // everything on the next launch.
    for (uuid, at) in &g.tombstones {
        records.push(seal_tombstone(vk, uuid, *at)?);
    }
    // Pass through records that couldn't be decrypted on unlock verbatim — re-sealing only the
    // decrypted set would permanently drop them (silent credential loss). They stay sealed as-is.
    records.extend(g.orphans.iter().cloned());
    let file = file_json(&g.salt, verifier, &records, g.version);
    let p = vault_path(app).ok_or("no app data dir")?;
    let txt = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    crate::jsonstore::write_atomic(&p, txt.as_bytes()).map_err(|e| e.to_string())
}

// ─── IPC dispatcher ──────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    crate::jsonstore::now_ms()
}

/// The snapshot behind `vault.getState` and every `vault.state` event.
///
/// `syncEnabled` is computed with the lock RELEASED, and that is load-bearing rather than
/// stylistic. `is_sync_enabled` ends in `unlocked_key`, which locks this same
/// `std::sync::Mutex` — and a std mutex is NOT reentrant, so asking it from inside the guard
/// self-deadlocks instead of merely being slow. Every gate inside `is_sync_enabled` short
/// circuits before that last `unlocked_key` in the three states the test suite lives in
/// (`syncVault` defaults off, the engine is off in a mock app, and a fresh vault is v1), which
/// is exactly how twenty tests sat on top of the freeze. All three flipped — a created vault,
/// the opt-in, and one sync pass — and the ask never returns; because `ipc` is a synchronous
/// Tauri command, in the app that is the GUI thread dead for good.
///
/// So the four fields the guard owns are copied out and dropped before the ask, which reads
/// the same state a moment later on its own lock.
fn state_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    let g = app.state::<VaultState>();
    let (created, unlocked, count, undecryptable) = {
        let g = g.0.lock().unwrap_or_else(|e| e.into_inner());
        (g.created, g.key.is_some(), g.records.len(), g.orphans.len())
    }; // guard dropped here — see the doc comment
    json!({
        "exists": created || vault_exists(app),
        "unlocked": unlocked,
        "count": count,
        // Records present on disk that couldn't be decrypted (corrupt/truncated). Preserved,
        // not dropped — the UI warns the user instead of silently losing credentials.
        "undecryptable": undecryptable,
        // The vault is part of E2E sync, but only when BOTH the separate `syncVault` opt-in is
        // on AND this device has adopted the account's shared salt. Until adoption happens the
        // honest answer is false: records sealed here are unreadable on the account's other
        // devices, so syncing them would only push blobs nobody can open.
        "syncEnabled": crate::sync_vault::is_sync_enabled(app),
    })
}

fn emit_state<R: Runtime>(app: &AppHandle<R>) {
    crate::emit_event(app, "vault.state", state_json(app));
}

/// Emit the `vault.changed` event so sync and other listeners know the vault data mutated.
fn emit_changed<R: Runtime>(app: &AppHandle<R>) {
    crate::emit_event(app, "vault.changed", json!(null));
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
    // Zeroizing: this is the MASTER PASSWORD, and the closure hands out a fresh copy per call
    // (3 call sites). A plain `String` left each copy in the heap until it was reused. The type
    // is the fix rather than a manual `.zeroize()` at each of the three sites, because a new
    // arm that forgot the wipe would then be a silent leak — with `Zeroizing` the compiler
    // requires nothing and leaks nothing.
    let pw = || {
        Zeroizing::new(
            payload
                .get("masterPassword")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        )
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
            if password.len() < 8 {
                return Some(Err("master password must be at least 8 characters".into()));
            }
            // A vault created while the account already has a published shared salt is born
            // sync-capable, so its very first record is readable by the other devices. This
            // is the common "new phone joins an existing account" path.
            let shared = crate::sync_vault::cached_salt(app);
            let (salt, version) = match shared {
                Some(s) => (s, KDF_V_SYNCED),
                None => {
                    let mut s = [0u8; 32];
                    if getrandom::getrandom(&mut s).is_err() {
                        return Some(Err("rng failed".into()));
                    }
                    (s.to_vec(), KDF_V_LOCAL)
                }
            };
            let vk = match derive_vault_key(&password, &salt) {
                Ok(k) => k,
                Err(e) => return Some(Err(e)),
            };
            {
                let st = app.state::<VaultState>();
                let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
                g.salt = salt;
                g.version = version;
                g.key = Some(vk);
                g.records = Vec::new();
                g.orphans = Vec::new();
                g.tombstones = Vec::new();
                g.created = true;
                if let Err(e) = persist(app, &g) {
                    return Some(Err(e));
                }
            }
            emit_state(app);
            emit_changed(app);
            Some(Ok(state_json(app)))
        }

        "vault.unlock" => {
            let Some(file) = read_file(app) else {
                return Some(Err("no vault to unlock".into()));
            };
            // Single source of truth: route through the same `VaultState::unlock` the unit
            // tests exercise. It preserves undecryptable records as orphans (surfaced as
            // `undecryptable` in state) instead of erroring and losing the readable records.
            // Rate limit, checked BEFORE deriving the key.
            //
            // This used to `thread::sleep` the backoff after a wrong password. That is a hard
            // freeze: `ipc` is a *synchronous* Tauri command, so it runs on the GUI thread
            // (see src-tauri/AGENTS.md), and after 8 typos the sleep was 5 minutes *per
            // attempt*, forever, with no way for the user to recover short of restarting.
            // Refusing the attempt for the length of the window instead keeps the throttle
            // while never blocking the UI, and skipping the Argon2id makes a rejected attempt
            // cheap instead of merely slow.
            let wait = remaining_backoff_ms();
            if wait > 0 {
                return Some(Err(backoff_message(wait, false)));
            }
            let st = app.state::<VaultState>();
            if let Err(e) = st.unlock(Some(&file), &pw()) {
                FAILED_ATTEMPTS.fetch_add(1, Ordering::Relaxed);
                LAST_FAILURE_MS.store(now_ms() as u64, Ordering::Relaxed);
                let msg = backoff_message(remaining_backoff_ms(), true);
                return Some(Err(format!("{e} — {msg}")));
            }
            FAILED_ATTEMPTS.store(0, Ordering::Relaxed);
            LAST_FAILURE_MS.store(0, Ordering::Relaxed);
            // The password is only available here (not in the background sync pass), so this is
            // where a local vault ADOPTS the account's shared salt and re-seals its records.
            // Best-effort: a refusal leaves the vault local-only and is reported in state, never
            // a failed unlock — the user's own records stay readable either way.
            let mut adopt_note: Option<String> = None;
            if let Err(e) = crate::sync_vault::try_adopt(app, &pw()) {
                adopt_note = Some(e);
            }
            emit_state(app);
            emit_changed(app);
            let mut st = state_json(app);
            if let Some(note) = adopt_note {
                st["adoptionNote"] = json!(note);
            }
            Some(Ok(st))
        }

        "vault.lock" => {
            {
                let st = app.state::<VaultState>();
                let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
                g.key = None;
                g.records.clear();
                g.orphans.clear();
                g.tombstones.clear();
            }
            emit_state(app);
            emit_changed(app);
            Some(Ok(state_json(app)))
        }

        "vault.list" => {
            let st = app.state::<VaultState>();
            let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
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
            let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
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
            emit_changed(app);
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
            let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
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
            emit_changed(app);
            Some(out)
        }

        "vault.remove" => {
            let uuid = payload
                .get("uuid")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let st = app.state::<VaultState>();
            let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
            if g.key.is_none() {
                return Some(Err("vault is locked".into()));
            }
            let removed_at = g
                .records
                .iter()
                .find(|c| c.uuid == uuid)
                .map(|c| c.updated_at);
            g.records.retain(|c| c.uuid != uuid);
            // A delete that only vanished locally gets undone by the next pull from any peer that
            // still has the record. Write a tombstone instead: sealed under the vault key (see
            // `seal_tombstone`) and carried by the normal sync path, so the record stops coming
            // back AND the server can finally reap its ciphertext. Strictly newer than the
            // version being removed, so it wins the LWW comparison even when the delete lands in
            // the same millisecond as the edit it removes.
            let at = now_ms().max(removed_at.map_or(i64::MIN, |a| a.saturating_add(1)));
            upsert_tombstone(&mut g.tombstones, uuid, at);
            if let Err(e) = persist(app, &g) {
                return Some(Err(e));
            }
            let out = live_records(&g);
            drop(g);
            emit_state(app);
            emit_changed(app);
            Some(out)
        }

        "vault.search" => {
            let q = payload
                .get("q")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let st = app.state::<VaultState>();
            let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
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

        // `vault.autofill` was declared in `shared/types.ts` and typed as
        // `Promise<VaultRecord[]>`, consumed by `useVaultAutofill`, and covered by tests —
        // but every one of those tests runs against the IPC MOCK, so nothing ever proved a
        // Rust arm existed. There was none, and the `ipc` chokepoint resolved unknown channels
        // to `Ok(Value::Null)`, so in a release build it silently returned `null` and the
        // declared return type was a lie. Now implemented: same lookup as
        // `autofillSuggestions`, plus the optional `username` narrowing that is the only
        // difference between the two channels.
        "vault.autofill" => {
            let domain = payload.get("domain").and_then(Value::as_str).unwrap_or("");
            let want_user = payload.get("username").and_then(Value::as_str);
            let st = app.state::<VaultState>();
            match st.autofill_suggestions(domain) {
                Ok(creds) => {
                    let arr: Vec<Value> = creds
                        .into_iter()
                        .filter(|c| want_user.is_none_or(|u| c.username == u))
                        .map(|c| {
                            json!({
                                "uuid": c.uuid, "updatedAt": c.updated_at, "site": c.site,
                                "username": c.username, "password": c.password, "notes": c.notes,
                            })
                        })
                        .collect();
                    Some(Ok(json!(arr)))
                }
                Err(e) => Some(Err(e.to_string())),
            }
        }

        "vault.autofillSuggestions" => {
            let domain = payload
                .get("domain")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let st = app.state::<VaultState>();
            match st.autofill_suggestions(&domain) {
                Ok(creds) => {
                    let arr: Vec<Value> = creds
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
                Err(e) => Some(Err(e.to_string())),
            }
        }

        _ => None,
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    // ── Reading state in the configuration where vault sync works ──────────────
    //
    // `state_json` holds this module's `VaultState.0` to take its snapshot and then asks
    // `sync_vault::is_sync_enabled`, which ends in `unlocked_key` and locks the SAME
    // non-reentrant `std::sync::Mutex`. Every gate inside `is_sync_enabled` short-circuits
    // before that final lock in the three states a test usually lives in — `syncVault`
    // defaults off, a mock app's sync engine is off, and a fresh vault is v1 — so the read
    // always returned and the freeze was invisible. This case sets all three.

    /// A v2 vault, unlocked, opted in, with the engine on: the one state in which
    /// `is_sync_enabled` actually reaches `unlocked_key`.
    ///
    /// Built the way the product builds it, but skipping the network: a salt in the sync cache
    /// is what makes `vault.create` mint a vault under the ACCOUNT's salt and stamp it v2 — the
    /// "new phone joins an existing account" path. That is a genuinely reachable state, not a
    /// fabricated one; the route that gets there over HTTP is `sync_vault`'s own test, and this
    /// one only needs the state to exist.
    fn vault_in_the_working_sync_state<R: Runtime>(app: &AppHandle<R>) {
        crate::sync_vault::set_cached_salt(app, &[0x5Au8; 32], None).expect("cache the salt");
        crate::test_support::ran(
            dispatch(
                app,
                "vault.create",
                &json!({ "masterPassword": "correct horse" }),
            ),
            "vault.create",
        )
        .expect("create");
        let mut next = crate::settings::load(app);
        next.as_object_mut()
            .expect("settings object")
            .insert("syncVault".into(), json!(true));
        crate::settings::write(app, &next);
        crate::sync::set_enabled_for_test(app, true, 0);
    }

    /// The regression: `vault.getState` never returned in the configuration where vault sync
    /// actually works. Because `ipc` is a synchronous Tauri command, in the app that is the
    /// GUI thread frozen for good — the vault panel simply stops responding.
    ///
    /// The walk runs on a worker thread, so the regression is a bounded FAILURE rather than a
    /// stalled suite; see `test_support::assert_returns_within`.
    #[test]
    fn vault_get_state_answers_in_the_configuration_where_vault_sync_works() {
        with_tmp_app(|app| {
            let owned = app.clone();
            crate::test_support::assert_returns_within(20, move || {
                vault_in_the_working_sync_state(&owned);
                // Preconditions, so a failure names the gate that stopped short rather than
                // blaming the lock for a state that never got there.
                if !is_synced(&owned) {
                    return Err("the vault is still v1, so the read is not exercised".into());
                }
                if !crate::sync_vault::is_sync_enabled(&owned) {
                    return Err("vault sync is off, so the read is not exercised".into());
                }
                if unlocked_key(&owned).is_none() {
                    return Err("the vault is locked, so the last gate short-circuits".into());
                }
                let st = crate::test_support::ran(
                    dispatch(&owned, "vault.getState", &json!({})),
                    "vault.getState",
                )?;
                // Not merely "it returned" — it returned the truth. A read that answered
                // `false` would report a synced, unlocked vault as local, which is the same
                // freeze's other face: a lie the panel would show.
                if st.get("syncEnabled") != Some(&json!(true)) {
                    return Err(format!("syncEnabled must be true here, got {st}"));
                }
                if st.get("unlocked") != Some(&json!(true)) {
                    return Err(format!("unlocked must be true here, got {st}"));
                }
                if st.get("exists") != Some(&json!(true)) {
                    return Err(format!("exists must be true here, got {st}"));
                }
                Ok(())
            });
        });
    }

    // ── Unlock rate limiter (the anti-guessing backoff) ───────────────────────
    //
    // These exercise the pure helpers, plus one test of the process-global decay
    // path. That one mutates `FAILED_ATTEMPTS` / `LAST_FAILURE_MS`, which are shared
    // across the whole process, so it takes `test_support::lock()` (public for exactly
    // this reason) and restores both statics — otherwise it would race the AppHandle
    // tests that unlock for real under `cargo test`'s parallel execution.

    #[test]
    fn backoff_is_free_for_the_first_three_attempts() {
        assert_eq!(backoff_ms(0), 0);
        assert_eq!(backoff_ms(1), 0);
        assert_eq!(backoff_ms(2), 0);
        assert_eq!(backoff_ms(3), 1_000, "the 3rd failure opens the window");
    }

    #[test]
    fn backoff_doubles_and_then_clamps() {
        assert_eq!(backoff_ms(4), 2_000);
        assert_eq!(backoff_ms(5), 4_000);
        assert_eq!(backoff_ms(6), 8_000);
        // Saturates rather than growing without bound...
        assert_eq!(backoff_ms(40), BACKOFF_MAX_MS);
        // ...and must not overflow at absurd attempt counts. The old code computed
        // `1000 * 2u64.pow(attempts - 3)`, which debug-overflow-panicked at 67.
        assert_eq!(
            backoff_ms(67),
            BACKOFF_MAX_MS,
            "67 was the old overflow point"
        );
        assert_eq!(backoff_ms(u32::MAX), BACKOFF_MAX_MS);
    }

    #[test]
    fn a_throttled_attempt_is_told_how_long_to_wait() {
        // Reported BEFORE the attempt (the password was never checked).
        let before = backoff_message(4_500, false);
        assert!(before.contains("wait"), "{before}");
        assert!(before.contains("5s"), "4500ms ceils to 5s: {before}");
        // Reported AFTER a failure (the real reason is shown too).
        let after = backoff_message(0, true);
        assert!(after.contains("incorrect master password"), "{after}");
        let after_wait = backoff_message(4_500, true);
        assert!(
            after_wait.contains("too many failed attempts"),
            "{after_wait}"
        );
        assert!(after_wait.contains("5s"), "{after_wait}");
    }

    #[test]
    fn an_idle_streak_decays_so_the_vault_cannot_be_locked_out_forever() {
        let _guard = crate::test_support::lock();
        let saved_attempts = FAILED_ATTEMPTS.load(Ordering::Relaxed);
        let saved_at = LAST_FAILURE_MS.load(Ordering::Relaxed);
        // A failure inside the current window is still throttled...
        FAILED_ATTEMPTS.store(9, Ordering::Relaxed);
        LAST_FAILURE_MS.store(now_ms() as u64, Ordering::Relaxed);
        let wait = remaining_backoff_ms();
        assert!(wait > 0, "a fresh failure must still be throttled");
        assert_eq!(
            FAILED_ATTEMPTS.load(Ordering::Relaxed),
            9,
            "not yet decayed"
        );
        // ...but once a full window has passed with no attempt, the streak resets so
        // the user is never permanently locked out by their own typos.
        LAST_FAILURE_MS.store(
            (now_ms() as u64).saturating_sub(backoff_ms(9) + 1_000),
            Ordering::Relaxed,
        );
        assert_eq!(remaining_backoff_ms(), 0, "an elapsed window must decay");
        assert_eq!(FAILED_ATTEMPTS.load(Ordering::Relaxed), 0);
        FAILED_ATTEMPTS.store(saved_attempts, Ordering::Relaxed);
        LAST_FAILURE_MS.store(saved_at, Ordering::Relaxed);
    }

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
        let on_disk = file_json(&salt, verifier, &records_sealed, KDF_V_LOCAL);

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
        let on_disk = file_json(&salt, verifier, std::slice::from_ref(&wire), KDF_V_LOCAL);

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
        let on_disk = file_json(&salt, verifier, &[wire], KDF_V_LOCAL);

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
        let inner = vs.0.lock().unwrap_or_else(|e| e.into_inner());
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
        let on_disk = file_json(&salt, verifier, &[wire], KDF_V_LOCAL);

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
        let on_disk = file_json(&salt, verifier, std::slice::from_ref(&wire), KDF_V_LOCAL);

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
                let g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
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
                let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
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
                let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
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
                let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
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
                let g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
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
            super::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
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
            let st = super::dispatch(app, "vault.unlock", &json!({"masterPassword": "long-pw!"}))
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
            let s = super::dispatch(app, "vault.create", &json!({"masterPassword": "hunter2!"}))
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
            super::dispatch(app, "vault.create", &json!({"masterPassword": "correct!"}))
                .unwrap()
                .unwrap();
            super::dispatch(app, "vault.lock", &json!({}))
                .unwrap()
                .unwrap();
            let err = super::dispatch(app, "vault.unlock", &json!({"masterPassword": "wrong!"}))
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
            super::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
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

    // ── Task-4 autofill_suggestions tests ───────────────────────────────────

    /// autofill_suggestions matches records by exact domain (case-insensitive).
    #[test]
    fn autofill_suggestions_matches_domain() {
        let vs = VaultState::default();
        vs.create("pw").expect("create");
        let t = now_ms();
        {
            let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
            add_record(&mut g.records, "github.com", "alice", "pass1", "", t);
            add_record(&mut g.records, "github.com", "bob", "pass2", "", t);
            add_record(&mut g.records, "google.com", "charlie", "pass3", "", t);
        }
        let results = vs.autofill_suggestions("github.com").unwrap();
        assert_eq!(results.len(), 2, "must match both github.com records");
        assert!(results
            .iter()
            .all(|c| c.site.to_lowercase() == "github.com"));
    }

    /// autofill_suggestions is case-insensitive.
    #[test]
    fn autofill_suggestions_case_insensitive() {
        let vs = VaultState::default();
        vs.create("pw").expect("create");
        {
            let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
            add_record(&mut g.records, "GitHub.com", "alice", "pass1", "", now_ms());
        }
        let results = vs.autofill_suggestions("github.com").unwrap();
        assert_eq!(results.len(), 1, "must match case-insensitively");
        assert_eq!(results[0].username, "alice");
    }

    /// autofill_suggestions matches subdomains: stored "github.com" matches query
    /// "github.com" (exact), and stored "api.example.com" matches query "example.com"
    /// (stored is a subdomain of the queried domain). Querying for a broader domain does
    /// NOT surface credentials for an unrelated subdomain (e.g. "api.github.com" does NOT
    /// match stored "github.com" — only exact match).
    #[test]
    fn autofill_suggestions_subdomain_match() {
        let vs = VaultState::default();
        vs.create("long-pw!").expect("create");
        let t = now_ms();
        {
            let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
            add_record(&mut g.records, "github.com", "alice", "pass1", "", t);
            add_record(&mut g.records, "api.example.com", "bob", "pass2", "", t);
        }
        // Query for a broader domain than a stored site — should NOT match
        // (stored subdomain credentials don't bleed to parent-domain queries).
        let results = vs.autofill_suggestions("api.github.com").unwrap();
        assert_eq!(
            results.len(),
            0,
            "stored parent must not match a subdomain query"
        );

        // Query for a parent domain of a stored subdomain — SHOULD match
        // (credentials for api.example.com are relevant when visiting example.com).
        let results2 = vs.autofill_suggestions("example.com").unwrap();
        assert_eq!(
            results2.len(),
            1,
            "stored subdomain must match parent domain query"
        );
        assert_eq!(results2[0].site, "api.example.com");
    }

    /// autofill_suggestions returns empty for a vault that doesn't exist / is locked.
    #[test]
    fn autofill_suggestions_empty_when_no_vault() {
        let vs = VaultState::default();
        let result = vs.autofill_suggestions("example.com");
        assert!(matches!(result, Err(VaultError::Locked)));
    }

    /// autofill_suggestions returns empty when vault is explicitly locked.
    #[test]
    fn autofill_suggestions_empty_when_locked() {
        let vs = VaultState::default();
        vs.create("pw").expect("create");
        {
            let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
            add_record(&mut g.records, "example.com", "u", "p", "", now_ms());
        }
        vs.lock();
        let result = vs.autofill_suggestions("example.com");
        assert!(matches!(result, Err(VaultError::Locked)));
    }

    /// autofill_suggestions returns empty vec for empty/whitespace domain.
    #[test]
    fn autofill_suggestions_empty_domain_returns_empty() {
        let vs = VaultState::default();
        vs.create("pw").expect("create");
        {
            let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
            add_record(&mut g.records, "example.com", "u", "p", "", now_ms());
        }
        let results = vs.autofill_suggestions("").unwrap();
        assert!(
            results.is_empty(),
            "empty domain must return no suggestions"
        );
        let results2 = vs.autofill_suggestions("   ").unwrap();
        assert!(
            results2.is_empty(),
            "whitespace domain must return no suggestions"
        );
    }

    /// autofill_suggestions returns no matches when nothing matches the query.
    #[test]
    fn autofill_suggestions_no_match() {
        let vs = VaultState::default();
        vs.create("pw").expect("create");
        {
            let mut g = vs.0.lock().unwrap_or_else(|e| e.into_inner());
            add_record(&mut g.records, "github.com", "alice", "pass1", "", now_ms());
        }
        let results = vs.autofill_suggestions("unrelated.com").unwrap();
        assert!(results.is_empty());
    }

    // ── dispatch-level autofill_suggestions tests ───────────────────────────

    /// Dispatch: vault.autofillSuggestions returns matching records.
    #[test]
    fn dispatch_autofill_suggestions_matches_domain() {
        crate::test_support::with_tmp_app(|app| {
            super::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
                .unwrap()
                .unwrap();
            super::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "github.com", "username": "alice", "password": "p1", "notes": ""}}),
            )
            .unwrap()
            .unwrap();
            super::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "google.com", "username": "bob", "password": "p2", "notes": ""}}),
            )
            .unwrap()
            .unwrap();

            // The TS client sends the domain as a bare string, but the Rust dispatch
            // reads payload.get("domain"), so the IPC payload must be {"domain": "..."}.
            let result = super::dispatch(
                app,
                "vault.autofillSuggestions",
                &json!({"domain": "github.com"}),
            )
            .unwrap()
            .unwrap();
            let list = result.as_array().unwrap();
            assert_eq!(list.len(), 1, "must match only github.com");
            assert_eq!(list[0]["username"], json!("alice"));
        });
    }

    /// `vault.autofill` exists in `shared/types.ts` with a declared `Promise<VaultRecord[]>`
    /// return type and a test in `useVaultAutofill.test.ts` — but that test runs against the
    /// IPC mock, so it would have kept passing if the channel had no Rust arm at all (which
    /// it did not). This drives the real dispatcher. The optional `username` is the only
    /// difference from `autofillSuggestions`, so both behaviours are pinned here.
    #[test]
    fn autofill_narrows_by_username_and_matches_the_suggestions_channel() {
        crate::test_support::with_tmp_app(|app| {
            let _ = super::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
                .unwrap()
                .unwrap();
            for (site, user) in [
                ("github.com", "alice"),
                ("github.com", "bob"),
                ("example.com", "carol"),
            ] {
                super::dispatch(
                    app,
                    "vault.add",
                    &json!({"input": {"site": site, "username": user, "password": "p", "notes": ""}}),
                )
                .unwrap()
                .unwrap();
            }

            let all = super::dispatch(app, "vault.autofill", &json!({"domain": "github.com"}))
                .unwrap()
                .unwrap();
            let all = all.as_array().unwrap();
            assert_eq!(
                all.len(),
                2,
                "no username given => every match for the domain"
            );

            // The narrowing is the whole difference from autofillSuggestions.
            let one = super::dispatch(
                app,
                "vault.autofill",
                &json!({"domain": "github.com", "username": "bob"}),
            )
            .unwrap()
            .unwrap();
            let one = one.as_array().unwrap();
            assert_eq!(one.len(), 1, "username narrows to the one match");
            assert_eq!(one[0]["username"], json!("bob"));

            // An unknown username is an empty result, not an error and not "everything".
            let miss = super::dispatch(
                app,
                "vault.autofill",
                &json!({"domain": "github.com", "username": "nobody"}),
            )
            .unwrap()
            .unwrap();
            assert_eq!(
                miss.as_array().unwrap().len(),
                0,
                "no such username => empty, never all"
            );

            // A domain with no creds is likewise empty, not a passthrough of everything.
            let none = super::dispatch(app, "vault.autofill", &json!({"domain": "absent.test"}))
                .unwrap()
                .unwrap();
            assert_eq!(none.as_array().unwrap().len(), 0);
        });
    }

    /// Dispatch: vault.autofillSuggestions returns empty when locked.
    #[test]
    fn dispatch_autofill_suggestions_empty_when_locked() {
        crate::test_support::with_tmp_app(|app| {
            super::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
                .unwrap()
                .unwrap();
            super::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "github.com", "username": "u", "password": "p", "notes": ""}}),
            )
            .unwrap()
            .unwrap();
            super::dispatch(app, "vault.lock", &json!({}))
                .unwrap()
                .unwrap();

            let result = super::dispatch(
                app,
                "vault.autofillSuggestions",
                &json!({"domain": "github.com"}),
            )
            .unwrap()
            .unwrap_err();
            assert!(
                result.contains("locked"),
                "expected locked error, got: {result}"
            );
        });
    }

    /// A `Debug` that prints a credential is a credential leak waiting for the first
    /// `dbg!`, the first panic message, or the first bug report. This asserts the
    /// redaction property directly rather than trusting the derive list.
    #[test]
    fn debug_output_never_carries_plaintext_or_the_vault_key() {
        let c = Cred {
            uuid: "u-1".into(),
            updated_at: 1_700_000_000_000,
            site: "https://bank.example".into(),
            username: "alice@example.com".into(),
            password: "hunter2-correct-horse".into(),
            notes: "the recovery code is 1234".into(),
        };
        let pretty = format!("{c:#?}");
        for secret in [
            "hunter2-correct-horse",
            "alice@example.com",
            "the recovery code is 1234",
        ] {
            assert!(
                !pretty.contains(secret),
                "Debug must not print {secret:?}: {pretty}"
            );
        }
        // Non-secret context stays visible, or the dump is useless for debugging.
        assert!(pretty.contains("u-1"), "uuid should stay visible: {pretty}");

        let v = UnlockedVault {
            key: Zeroizing::new([0xABu8; 32]),
            records: vec![c],
            orphans: vec![],
            tombstones: vec![],
        };
        let pv = format!("{v:#?}");
        // The vault key is 32 bytes of 0xAB = 64 hex chars; assert on a distinctive run.
        assert!(
            !pv.to_lowercase().contains(&"ab".repeat(8)),
            "Debug must not print the vault key: {pv}"
        );
        assert!(!pv.contains("hunter2"), "vault Debug leaks records: {pv}");
    }

    /// An all-zero key is reported as absent, not as a value — and an empty field as empty
    /// rather than redacted, so a redacted dump still answers the question usually being asked.
    #[test]
    fn debug_distinguishes_absent_from_present() {
        let empty = Cred {
            uuid: "u-2".into(),
            updated_at: 0,
            site: String::new(),
            username: String::new(),
            password: String::new(),
            notes: String::new(),
        };
        let d = format!("{empty:?}");
        assert!(
            d.contains("<empty>"),
            "empty fields should read as empty: {d}"
        );
        assert!(!d.contains("<redacted>"), "nothing was present: {d}");
    }

    /// A parse error raised AFTER `open` has authenticated and decrypted the record is a
    /// description of recovered user data: serde embeds the offending value in its message.
    /// The error string is what every caller logs and surfaces, so the canary below is what
    /// used to reach stderr — the user's terminal, a CI log, any pasted bug report.
    const DECRYPTED_CANARY: &str = "hunter2-correct-horse-battery-staple";

    /// Build a wire record that AUTHENTICATES but whose plaintext is not a `Cred`, by sealing
    /// the body directly. The canary sits in `updated_at`, which `Cred` takes as an i64, so
    /// serde's type error quotes it back. (`Cred` renames nothing, so the wire shape is
    /// snake_case — a camelCase key yields only "missing field", a message with no value in
    /// it, and the probe would pass for the wrong reason. I hit exactly that.)
    fn authentic_but_malformed(vk: &[u8; 32], uuid: &str) -> Value {
        let body = format!(
            r#"{{"uuid":"{uuid}","updated_at":"{DECRYPTED_CANARY}","site":"s","username":"u","password":"p","notes":""}}"#
        );
        let (nonce, ct) = crate::crypto::seal(vk, NS, uuid, &hlc_bytes(7), body.as_bytes())
            .expect("seal the malformed body");
        json!({
            "uuid": uuid,
            "updatedAt": 7,
            "deleted": false,
            "nonce": crate::crypto::hex(&nonce),
            "ct": crate::crypto::hex(&ct),
        })
    }

    #[test]
    fn an_undecryptable_record_does_not_echo_its_own_plaintext_into_the_error() {
        let vk = [9u8; 32];
        // `Opened` deliberately has no `Debug` (it would print a decrypted credential), so
        // unwrap the error by hand rather than reaching for `expect_err`.
        let Err(err) = open_kind(&vk, &authentic_but_malformed(&vk, "u-1")) else {
            panic!("a record whose plaintext is not a Cred cannot be opened");
        };
        assert!(
            !err.contains(DECRYPTED_CANARY),
            "the error text is what every caller logs, and it must not carry the \
             DECRYPTED record's contents: {err}"
        );
        // The redaction must not throw away the diagnostic that makes the failure
        // reportable: which kind of failure, and where in the record.
        assert!(
            err.contains("line") && err.contains("column"),
            "the error must still say WHERE it failed, or a quarantined record is \
             undiagnosable: {err}"
        );
    }

    /// A tombstones-shaped body is not a `Cred` either, and takes a different path; it must
    /// also produce no content. (Guards against a future refactor reordering the two checks.)
    #[test]
    fn a_valid_credential_still_opens_so_the_redaction_cannot_be_vacuous() {
        let vk = [9u8; 32];
        let cred = Cred {
            uuid: "u-2".into(),
            updated_at: 7,
            site: "s".into(),
            username: "u".into(),
            password: "p".into(),
            notes: String::new(),
        };
        let w = seal_record(&vk, &cred).expect("seal");
        assert!(
            matches!(open_kind(&vk, &w), Ok(Opened::Cred(_))),
            "a well-formed record must still open, or the redaction test above would pass \
             for the wrong reason"
        );
    }
}
