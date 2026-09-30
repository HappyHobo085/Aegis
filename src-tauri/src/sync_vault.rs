// src-tauri/src/sync_vault.rs — the bridge between `vault.rs` (domain) and `sync.rs` (engine).
//
// # What crosses the wire
//
// Only *sealed* records: `{uuid, updatedAt, nonce, ct}`, AEAD-sealed under the vault key. The
// server and the transport layer never see a credential, and this module never decrypts a
// credential either — it hands ciphertext to `sync.rs` and hands authenticated plaintext back
// to `vault.rs`, which owns the key.
//
// # Why a "meta" namespace exists at all
//
// The vault key is `Argon2id(master_password, salt)`, and the salt is a *plaintext* field of
// `vault.json` — a KDF salt is public by design, so there is nothing secret about it here. The
// original cross-device failure was never "the salt leaks"; it was that **each device minted
// its OWN random salt**, so every device derived a DIFFERENT key and no record could ever
// cross. So we needed a way for a joining device to learn the account's one salt.
//
// The account publishes it as a single record in the `pwvault-meta` namespace, sealed under
// `crypto::data_key(root, "pwvault-meta")` (i.e. the sync root, which we already have during a
// sync pass). A joining device adopts it by re-sealing its own records under it — see
// `vault::reseal_with_salt`. The KDF is deliberately UNCHANGED; only the salt's origin differs.
//
// The adopted salt is ALSO cached locally in `vault-sync.json`, which is what lets the two
// halves meet without either blocking on the other:
//
//   * the sync pass has the root but NOT the master password  -> it can publish/adopt the salt
//   * `vault.unlock` has the password but NOT the root        -> it can read the cached salt
//
// Unlock therefore never touches the network, and — importantly — removing the sync account
// later can never brick the vault, because the salt it needs is already on local disk.
//
// The handshake has a THIRD step, and it is the one that is easy to leave out: the very first
// device has nobody to adopt from, so it has to become the account's vault by publishing its
// OWN salt — and publishing used to require already being the account's vault, which made the
// whole feature unreachable on a cold install (a `syncVault` toggle that could never take
// effect). `local_meta_record` therefore publishes a v1 vault's salt when the account has none
// yet and the user has opted in, and `sync_vault_once` then stamps the file through
// `vault::stamp_shared_salt` — which needs no password precisely because the salt did not
// change. Joining devices still adopt the published salt at unlock, re-sealing for real.
//
// # Integrity
//
// A record arriving from a peer is only ever accepted after `vault::open_record` authenticates
// it under the local key; anything that fails is counted as quarantined and never written.
// That is what stops a peer (or a corrupted blob) from destroying a real local credential,
// which the previous timestamp-only merge could do silently and permanently.
//
// This module used to carry a module-level `#![allow(dead_code)]`, with no comment saying
// what it was for. It is gone, and it was not needed: `lib.rs` declares the module PRIVATE
// (`mod sync_vault;`), so nothing in it is exported and rustc already treats every item as
// dead-eligible on every crate type, `cdylib` included. A blanket allow here suppressed the
// real diagnostics this platform is compiled to report, which is the opposite of what a
// placeholder for "not wired up yet" should do.

use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

use crate::crypto::{hex, unhex};
use crate::vault;

/// The namespace holding the account's published vault salt (and only that).
pub(crate) const NS_META: &str = "pwvault-meta";

/// The single record's uuid inside [`NS_META`].
const META_UUID: &str = "meta";

/// Node id stamped on the meta record's HLC. The meta record is account-wide, not per-device,
/// so it deliberately does not use a device id.
const META_NODE: &str = "vault";

/// Local cache of the adopted/published salt, so `vault.unlock` can adopt without the root.
const CACHE_FILE: &str = "vault-sync.json";

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(CACHE_FILE))
}

/// The account's shared salt as last seen/published by a sync pass, if any.
///
/// Deliberately tolerant: a corrupt or absent cache is simply "no salt yet", never an error.
/// It is a cache of *public* data (a KDF salt), so it carries no secret and needs no KDF.
pub(crate) fn cached_salt<R: Runtime>(app: &AppHandle<R>) -> Option<Vec<u8>> {
    cached(app).and_then(|c| unhex(c.get("salt")?.as_str()?))
}

/// The cached HLC for the salt we last published, so a sync pass that has nothing new to say
/// re-pushes the *same* stamp instead of minting a fresh (and therefore always-winning) one.
/// Without this, every pass would out-rank the peer's copy on the server's LWW and two devices
/// that briefly disagreed would flap the published salt back and forth forever.
fn cached_hlc<R: Runtime>(app: &AppHandle<R>) -> Option<crate::sync_envelope::Hlc> {
    let v = cached(app)?;
    crate::sync_envelope::from_value(&v)
}

fn cached<R: Runtime>(app: &AppHandle<R>) -> Option<Value> {
    crate::jsonstore::read_value_with_backup(&cache_path(app)?)
}

/// Record the salt locally so a later `vault.unlock` (which has no root) can adopt it.
/// `hlc` is the stamp the record was published under, if known.
pub(crate) fn set_cached_salt<R: Runtime>(
    app: &AppHandle<R>,
    salt: &[u8],
    hlc: Option<&crate::sync_envelope::Hlc>,
) -> Result<(), String> {
    let p = cache_path(app).ok_or("no app data dir")?;
    let mut body = json!({ "v": vault::KDF_V_SYNCED, "salt": hex(salt) });
    if let Some(h) = hlc {
        body["hlc"] = serde_json::to_value(h).map_err(|e| e.to_string())?;
    }
    let txt = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    crate::jsonstore::write_atomic(&p, txt.as_bytes()).map_err(|e| e.to_string())
}

/// Read vault records for sync export — the sealed wire shape, verbatim from the file.
///
/// Returns an empty vec when there is no vault file. Deliberately does NOT go through the
/// in-memory state: this runs on a sync thread with no lock held, and the ciphertext it returns
/// is exactly what is on disk (so a re-seal that has not flushed yet cannot publish stale
/// blobs under a new salt).
pub fn read_for_sync<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    let Some(file) = vault::read_file(app) else {
        return Vec::new();
    };
    file.get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The local `pwvault-meta` record to publish, or `None` if this pass must not publish one.
///
/// `remote_published` is what the pull found already on the server. `sync_ns` merges (pulls)
/// BEFORE it reads local records, so by the time this runs the answer is known — and it is what
/// keeps a second opted-in device from hijacking the account: a freshly minted HLC always wins
/// the server's LWW, so a joiner publishing its own salt would re-key the account out from
/// under every record already sitting on it.
fn local_meta_record<R: Runtime>(app: &AppHandle<R>, remote_published: bool) -> Option<Value> {
    let salt = vault::file_salt(&vault::read_file(app)?)?;
    if !vault::is_synced(app) && (remote_published || !vault_sync_opted_in(app)) {
        // A v1 vault is this device's own, and it becomes the account's vault by PUBLISHING its
        // salt. That step used to be unreachable: this function demanded `is_synced`, `is_synced`
        // demanded an adopted salt, and a salt could only ever arrive from a published record —
        // so on a cold install neither could ever happen and `syncVault` was dead on arrival.
        // Publish only when the account has no salt yet and the user has actually opted the
        // vault into sync; a joiner adopts, and a local-only vault is not ours to publish.
        return None;
    }
    // Reuse the stamp we last published under whenever it still describes THIS salt, so a
    // steady-state pass is a no-op on the server rather than a fresh winning write.
    let hlc = match (cached_salt(app), cached_hlc(app)) {
        (Some(cached_salt), Some(h)) if cached_salt == salt => h,
        _ => crate::sync_envelope::tick(META_NODE, crate::jsonstore::now_ms()),
    };
    Some(json!({
        "uuid": META_UUID,
        "hlc": serde_json::to_value(&hlc).ok()?,
        "salt": hex(&salt),
        "v": vault::KDF_V_SYNCED,
    }))
}

/// Adopt the account's shared salt if one is cached and this device has not adopted it yet.
///
/// Called from `vault.unlock`, which is the only place the master password exists. Returns
/// `Ok(())` when there is nothing to do, and `Err(human_readable)` when adoption was refused —
/// the caller surfaces that as a note and the vault simply stays local-only. It must NEVER
/// fail the unlock itself: the user's own records stay readable either way.
///
/// The guard is [`vault_sync_opted_in`], NOT [`is_sync_enabled`]. The latter also demands
/// `vault::is_synced` — i.e. that adoption has already happened — so using it here made
/// adoption unreachable for every device that had not already adopted, which is every device.
pub(crate) fn try_adopt<R: Runtime>(app: &AppHandle<R>, password: &str) -> Result<(), String> {
    if !vault_sync_opted_in(app) {
        return Ok(());
    }
    let Some(shared) = cached_salt(app) else {
        return Ok(()); // no sync pass has run yet
    };
    let Some(file) = vault::read_file(app) else {
        return Ok(());
    };
    let cur = vault::file_salt(&file);
    if cur.as_deref() == Some(shared.as_slice()) {
        // Already on the shared salt. Still make sure the version is stamped, so
        // `is_synced` (and therefore the UI) agrees.
        if vault::file_version(&file) < vault::KDF_V_SYNCED {
            adopt(app, password, &file, &shared)?;
        }
        return Ok(());
    }
    adopt(app, password, &file, &shared)
}

/// Re-seal the whole vault under `shared`, write it, and point the live state at it.
fn adopt<R: Runtime>(
    app: &AppHandle<R>,
    password: &str,
    file: &Value,
    shared: &[u8],
) -> Result<(), String> {
    let next = vault::reseal_with_salt(file, password, shared).map_err(|e| e.to_string())?;
    let count = next
        .get("records")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);
    let p = vault::vault_path(app).ok_or("no app data dir")?;
    let txt = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    crate::jsonstore::write_atomic(&p, txt.as_bytes()).map_err(|e| e.to_string())?;
    // Repoint the live state (re-derives the key for the new salt) and flush the unchanged
    // records under it, so memory and disk can never disagree about which salt is in force.
    vault::adopt_resealed(app, &next, password)?;
    set_cached_salt(app, shared, None)?;
    eprintln!(
        "[aegis-vault] adopted the account's shared vault salt ({count} record(s) re-sealed)"
    );
    Ok(())
}

/// Whether the user has asked for the vault to be part of this account — the conditions that
/// are knowable BEFORE anything has been adopted.
///
/// Deliberately separate from [`is_sync_enabled`], which adds "has adopted". Anything that
/// *performs* adoption or publication must ask this question instead: asking the other one is
/// circular, because adoption is what satisfies it, and a guard that can only be satisfied by
/// the operation it guards never runs.
fn vault_sync_opted_in<R: Runtime>(app: &AppHandle<R>) -> bool {
    crate::settings::sync_vault(app) && crate::sync::is_enabled(app)
}

/// Whether the vault's records may be uploaded.
///
/// MUST agree with what the UI reports as `syncEnabled`, or a user who turned vault sync off
/// would still have their (encrypted) vault uploaded with no way to see or stop it. Four
/// conditions, all required:
///
/// 1. the separate `syncVault` opt-in is on (default **off** — the vault is local until the
///    user explicitly opts in),
/// 2. the sync engine itself is enabled,
/// 3. this device's vault is the account's vault — its salt is the published one. Until that
///    is true, records sealed here are unreadable on the account's other devices, so pushing
///    them would only fill the server with blobs nobody can open,
/// 4. the vault is unlocked, so this device can actually read what it would be publishing.
///
/// Conditions 1 and 2 are [`vault_sync_opted_in`]; 3 and 4 are the outcome of the handshake.
pub fn is_sync_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    if !vault_sync_opted_in(app) {
        return false;
    }
    if !vault::is_synced(app) {
        return false;
    }
    vault::unlocked_key(app).is_some()
}

// ─── The sync pass ──────────────────────────────────────────────────────────

/// Pull → merge → push for the vault: the `pwvault-meta` namespace plus, when the vault is
/// opted in, adopted and unlocked, the `pwvault` records themselves.
///
/// Runs on its own thread inside `sync::sync_once`. Returns `(changed, quarantined)` so the
/// caller can emit a targeted event and surface an authenticated-failure note. Quarantining is
/// deliberately NOT fatal: a peer that cannot authenticate is something to tell the user about,
/// not a reason to fail the whole pass.
pub(crate) fn sync_vault_once<R: Runtime>(
    app: &AppHandle<R>,
    base: &str,
    account_id: &str,
    device_seed: &[u8; 32],
    root: &crate::crypto::RootSecret,
    gen: u64,
) -> Result<(Vec<String>, Vec<String>), String> {
    // ── 1. The meta namespace ──────────────────────────────────────────────
    // Always in flight when the account exists: this is how a device learns the shared salt, so
    // it must work even while the vault is locked or opted out — otherwise a device could never
    // learn it in the first place.
    //
    // `remote_published` is written by the merge below and read by the producer, which is safe
    // only because `sync_ns` merges before it reads local records. `published` carries what THIS
    // pass pushed when it was the device establishing the account's salt — nobody else will ever
    // hand that device its own salt back, so it has to be cached from here.
    let remote_published = Mutex::new(false);
    let published: Mutex<Option<(Vec<u8>, crate::sync_envelope::Hlc)>> = Mutex::new(None);
    let meta_changed = crate::sync::sync_ns(
        app,
        base,
        NS_META,
        &crate::crypto::data_key(root, NS_META),
        account_id,
        device_seed,
        gen,
        || {
            let remote = *remote_published.lock().unwrap_or_else(|e| e.into_inner());
            let Some(rec) = local_meta_record(app, remote) else {
                return Vec::new();
            };
            if let Some((salt, hlc)) = rec
                .get("salt")
                .and_then(Value::as_str)
                .and_then(unhex)
                .zip(crate::sync_envelope::from_value(&rec))
            {
                if let Ok(mut p) = published.lock() {
                    *p = Some((salt, hlc));
                }
            }
            vec![rec]
        },
        |remote| {
            let mut ch = Vec::new();
            for r in remote {
                if r.get("uuid").and_then(Value::as_str) != Some(META_UUID) {
                    continue;
                }
                let Some(salt) = r.get("salt").and_then(Value::as_str).and_then(unhex) else {
                    eprintln!("[aegis-vault] published meta record has no usable salt");
                    continue;
                };
                if salt.len() != 32 {
                    eprintln!(
                        "[aegis-vault] published meta salt is {} bytes, want 32",
                        salt.len()
                    );
                    continue;
                }
                if let Ok(mut seen) = remote_published.lock() {
                    *seen = true;
                }
                if cached_salt(app).as_deref() == Some(salt.as_slice()) {
                    continue;
                }
                // Keep the remote's own HLC alongside the salt: re-publishing under it keeps our
                // next push from out-ranking the copy we just accepted.
                let hlc = crate::sync_envelope::from_value(r);
                match set_cached_salt(app, &salt, hlc.as_ref()) {
                    Ok(()) => ch.push(META_UUID.to_string()),
                    Err(e) => eprintln!("[aegis-vault] could not cache the shared salt: {e}"),
                }
            }
            ch
        },
    )?;
    let mut changed = meta_changed;

    // The publisher's half of the handshake. A completed meta pass leaves `cached_salt` holding
    // the account's salt — from the merge above for a joiner, from the record just pushed for
    // the device that established it — and when that salt is this vault's OWN, the vault IS the
    // account's vault and its file version is the only thing left to fix. That is a no-op for a
    // device whose salt is somebody else's, so it is safe to attempt unconditionally.
    if let Some((salt, hlc)) = published.into_inner().unwrap_or(None) {
        if let Err(e) = set_cached_salt(app, &salt, Some(&hlc)) {
            eprintln!("[aegis-vault] could not cache the published vault salt: {e}");
        }
    }
    if let Some(shared) = cached_salt(app) {
        match vault::stamp_shared_salt(app, &shared) {
            Ok(true) => {
                eprintln!(
                    "[aegis-vault] this vault is the account's vault now (its records were \
                     already sealed under the published salt)"
                );
                vault::emit_state_after_external_change(app);
            }
            Ok(false) => {}
            Err(e) => eprintln!("[aegis-vault] could not mark the vault account-synced: {e}"),
        }
    }

    // ── 2. The records themselves ──────────────────────────────────────────
    // Only when the user opted in AND this device can actually read what it would be publishing
    // (opted in + account on + adopted salt + unlocked). `is_sync_enabled` checks all of that.
    if !is_sync_enabled(app) {
        return Ok((changed, Vec::new()));
    }

    // The transport layer is sealed under `data_key(root, "pwvault")` (so a device that has the
    // root but not the vault salt cannot even unwrap the envelope), and the record inside is
    // sealed under the vault key (so only a master password reveals a credential). Both layers
    // are needed and they are different keys.
    let quarantined: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let record_changed = crate::sync::sync_ns(
        app,
        base,
        vault::NS,
        &crate::crypto::data_key(root, vault::NS),
        account_id,
        device_seed,
        gen,
        || read_for_sync_with_hlc(app),
        |remote| match vault::merge_remote(app, remote) {
            Ok(outcome) => {
                if let Ok(mut q) = quarantined.lock() {
                    q.extend(outcome.quarantined);
                }
                outcome.changed
            }
            // Not fatal: the rest of the pass (meta, other stores) must still complete, and a
            // locked/absent vault simply has nothing to merge.
            Err(e) => {
                eprintln!("[aegis-vault] record merge skipped: {e}");
                Vec::new()
            }
        },
    )?;
    changed.extend(record_changed);

    let quarantined = quarantined.into_inner().unwrap_or_default();
    Ok((changed, quarantined))
}

/// FNV-1a 32 over the record uuid, yielding a value that fits [`crate::sync_envelope::Hlc`]'s
/// `counter: u32` — `from_value` deserializes with serde, which ERRORS on an out-of-range
/// integer, so a wider digest would make every synthesized stamp unparseable and silently stop
/// the vault from syncing at all.
///
/// Deliberately NOT `DefaultHasher`: that is randomly seeded per process, so the digest would
/// differ between passes and fork every unchanged record into a new version. FNV-1a is a fixed
/// function, so the digest is byte-identical on every pass and on every device — which is what
/// keeps the synthesized HLC, and therefore the AEAD associated data, stable for a record nobody
/// edited. A 32-bit digest makes an accidental tie ~2⁻³² per pair, and a tie is in any case only
/// ever a last-resort tiebreak on the server, never a client-side ambiguity.
fn uuid_digest(uuid: &str) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in uuid.as_bytes() {
        h ^= u32::from(*b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The sealed records as the transport wants them.
///
/// Vault records carry `updatedAt` (wall ms) rather than a real HLC, so the transport's
/// cleartext `hlc` field — which is bound as the AEAD associated data — is synthesised from it.
/// It is derived from the record's own timestamp, so it is stable across passes: re-pushing an
/// unchanged record therefore re-uses the same AAD and does not fork into a new version.
///
/// The `counter` is a stable digest of the record's own uuid, NOT a constant. `vault.json` does
/// not persist a real HLC, so this stamp is re-derived from `updatedAt` on every push and a
/// ticking counter is impossible (any tick would yield a different AAD each pass and fork the
/// record). The consequence of the old constant `0` was that two records sharing an `updatedAt`
/// millisecond collided on the SAME `(wall_ms, counter, node)` tuple — guaranteed, not
/// probabilistic, and in particular every record with no `updatedAt` collided with every other.
/// That tie was unbreakable on the wire, so the server had to resolve it, and resolving it by
/// rewriting the AAD-bound `hlc` permanently bricked both records. Folding the uuid in makes the
/// stamp unique per record, so honest clients never produce a tie at all. The trade-off: two
/// credentials saved in the same millisecond are ordered by a stable digest of their ids rather
/// than by save order. That is still a total, deterministic, device-independent order — all the
/// merge ever needed — instead of a tie nobody could resolve.
/// The transport HLC for a vault record, which carries `updatedAt` rather than a real HLC.
fn synth_hlc(rec: &Value) -> Value {
    let ts = rec.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
    let counter = uuid_digest(rec.get("uuid").and_then(Value::as_str).unwrap_or(""));
    json!({ "wall_ms": ts, "counter": counter, "node": META_NODE })
}

fn read_for_sync_with_hlc<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    read_for_sync(app)
        .into_iter()
        .map(|mut r| {
            let hlc = synth_hlc(&r);
            if let Some(o) = r.as_object_mut() {
                o.entry("hlc".to_string()).or_insert_with(|| hlc);
            }
            r
        })
        .collect()
}

// ─── Tests ───────────────────────────────────────────────────────────────────
//
// These deliberately assert the OPPOSITE of the tests this module used to have. The old suite
// pushed `nonce:"eeff", ct:"1122"` — ciphertext that cannot possibly authenticate — and then
// REQUIRED it to overwrite a real credential, which is the data-loss bug itself. A test that
// pins destructive behaviour is worse than no test, so each case below is about a record that
// must NOT be allowed in, plus the one that legitimately must be.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;
    use crate::vault::{Cred, KDF_V_SYNCED};
    use zeroize::Zeroizing;

    const PW: &str = "correct horse battery";

    /// A fresh salt standing in for "the account's published salt".
    fn salt(b: u8) -> Vec<u8> {
        vec![b; 32]
    }

    /// Flip the `syncVault` opt-in through the same store the settings module writes, so the
    /// getter under test sees it. (`settings::dispatch` is not generic over `Runtime` — it takes
    /// a concrete `&AppHandle` — so the unit test cannot drive the IPC channel directly; the
    /// validator it calls is exercised separately by `validate_setting_*` below.)
    fn set_flag<R: Runtime>(app: &AppHandle<R>, on: bool) {
        let mut next = crate::settings::load(app);
        next.as_object_mut()
            .expect("settings is an object")
            .insert("syncVault".into(), json!(on));
        crate::settings::write(app, &next).expect("settings fixture write");
    }

    // ── A real HTTP sync server, on loopback ───────────────────────────────
    //
    // The salt handshake only exists in `sync_vault_once`, and every half of it is decided by
    // what the server returns and receives. Asserting on `local_meta_record` or on a
    // hand-written `vault-sync.json` would test a fiction: production can only reach this state
    // by pulling an empty account and pushing a record, and both of those used to be impossible
    // to reach. So these cases speak HTTP to a real socket, through the real `sync_ns`, and
    // read the wire records back with the production `open_wire`.

    /// What the fake server has seen and what it will serve back.
    #[derive(Default)]
    struct ServerState {
        /// Canned wire records to answer a `GET /v1/records?ns=…` with, keyed by namespace.
        canned: std::collections::HashMap<String, Vec<Value>>,
        /// Every `(ns, wire records)` batch the client POSTed, in order.
        pushed: Vec<(String, Vec<Value>)>,
    }

    struct FakeServer {
        base: String,
        state: std::sync::Arc<Mutex<ServerState>>,
    }

    impl FakeServer {
        /// Serve `canned` (namespace → wire records) and record everything pushed.
        ///
        /// One request per connection, always answered with `connection: close`, which is what
        /// lets the single-threaded accept loop read a request, reply, and return. reqwest is
        /// told the connection is dead, so it opens a fresh one for the next call — the pass
        /// makes several (a pull and a push per namespace).
        fn start(canned: &[(&str, Vec<Value>)]) -> Self {
            use std::io::{BufRead, BufReader, Read, Write};
            use std::net::TcpListener;
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
            let base = format!("http://{}", listener.local_addr().expect("local addr"));
            let state = std::sync::Arc::new(Mutex::new(ServerState {
                canned: canned
                    .iter()
                    .map(|(ns, recs)| ((*ns).to_string(), recs.clone()))
                    .collect(),
                pushed: Vec::new(),
            }));
            let sink = std::sync::Arc::clone(&state);
            std::thread::spawn(move || {
                for conn in listener.incoming().flatten() {
                    let mut reader = BufReader::new(match conn.try_clone() {
                        Ok(c) => c,
                        Err(_) => continue,
                    });
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).is_err() {
                        continue;
                    }
                    let mut content_length = 0usize;
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).is_err() {
                            break;
                        }
                        if header == "\r\n" || header == "\n" {
                            break;
                        }
                        let lower = header.to_ascii_lowercase();
                        if let Some(v) = lower.strip_prefix("content-length:") {
                            content_length = v.trim().parse().unwrap_or(0);
                        }
                    }
                    let mut body = vec![0u8; content_length];
                    if content_length > 0 && reader.read_exact(&mut body).is_err() {
                        continue;
                    }
                    let body: Value = if body.is_empty() {
                        Value::Null
                    } else {
                        serde_json::from_slice(&body).unwrap_or(Value::Null)
                    };
                    let path = request_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let response = if path.starts_with("/v1/records?") || path == "/v1/records" {
                        if request_line.starts_with("GET") {
                            let ns = path
                                .split('?')
                                .nth(1)
                                .unwrap_or("")
                                .split('&')
                                .filter_map(|kv| kv.strip_prefix("ns="))
                                .find(|v| !v.is_empty())
                                .unwrap_or("")
                                .to_string();
                            let recs = sink
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .canned
                                .get(&ns)
                                .cloned()
                                .unwrap_or_default();
                            // `next: null` is the documented final page, so the client's
                            // pagination loop stops after one GET instead of re-requesting.
                            json!({ "records": recs, "next": Value::Null })
                        } else {
                            let ns = body
                                .get("ns")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let recs = body
                                .get("records")
                                .and_then(Value::as_array)
                                .cloned()
                                .unwrap_or_default();
                            sink.lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .pushed
                                .push((ns, recs));
                            json!({})
                        }
                    } else {
                        // `/v1/devices` and anything else the pass may reach: accept and ignore.
                        json!({})
                    };
                    let mut out = conn;
                    let body = serde_json::to_string(&response).unwrap_or_else(|_| "{}".into());
                    let _ = write!(
                        out,
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: \
                         {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = out.flush();
                }
            });
            FakeServer { base, state }
        }

        /// The wire records pushed into `ns`, in order.
        fn pushed(&self, ns: &str) -> Vec<Value> {
            self.state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pushed
                .iter()
                .filter(|(n, _)| n == ns)
                .flat_map(|(_, recs)| recs.clone())
                .collect()
        }
    }

    /// The root a sync pass runs under, plus the data keys the transport derives from it.
    fn root() -> crate::crypto::RootSecret {
        crate::crypto::RootSecret([3u8; 32])
    }

    /// Open every wire record the fake server received in `ns`, exactly as a peer would.
    fn opened(ns: &str, wire: &[Value]) -> Vec<Value> {
        let dk = crate::crypto::data_key(&root(), ns);
        wire.iter()
            .map(|w| {
                crate::sync::open_wire(&dk, ns, w)
                    .unwrap_or_else(|e| panic!("the pushed {ns} record must open: {e}"))
            })
            .collect()
    }

    /// Run one full vault sync pass the way `sync::sync_once` does.
    ///
    /// `gen` must be the generation currently in `SyncState`, or `sync_ns` treats the pass as
    /// cancelled and does nothing at all.
    fn pass(app: &AppHandle<impl Runtime>, base: &str, gen: u64) {
        crate::sync::set_enabled_for_test(app, true, gen);
        set_flag(app, true);
        let (changed, quarantined) = sync_vault_once(app, base, "acct-1", &[7u8; 32], &root(), gen)
            .expect("the sync pass must succeed");
        assert!(quarantined.is_empty(), "nothing should be quarantined");
        let _ = changed;
    }

    /// A vault that is unlocked in memory AND on disk, holding `records`, so `merge_remote`
    /// has something real to protect. Returns the unlocked vault key.
    fn seeded_unlocked<R: Runtime>(app: &AppHandle<R>, records: &[Cred]) -> Zeroizing<[u8; 32]> {
        let (file, vk) = vault::init_vault(PW).expect("init vault");
        crate::jsonstore::write_atomic(
            &vault::vault_path(app).expect("app data dir"),
            serde_json::to_string_pretty(&file).unwrap().as_bytes(),
        )
        .expect("write vault");
        vault::dispatch(app, "vault.unlock", &json!({ "masterPassword": PW }))
            .expect("unlock channel")
            .expect("unlock");
        for c in records {
            vault::dispatch(
                app,
                "vault.add",
                &json!({ "input": {
                    "site": c.site, "username": c.username,
                    "password": c.password, "notes": c.notes,
                }}),
            )
            .expect("add channel")
            .expect("add ok");
        }
        vk
    }

    fn cred(uuid: &str, updated_at: i64) -> Cred {
        Cred {
            uuid: uuid.into(),
            updated_at,
            site: "https://example.com".into(),
            username: "alice".into(),
            password: "hunter2".into(),
            notes: String::new(),
        }
    }

    // ── The synthesized transport HLC ──────────────────────────────────────────
    //
    // This is the reachability guard for the bug where the sync server mutated the AEAD-bound
    // `hlc` to break an HLC tie, permanently bricking the record. The server only ever had to
    // break a tie because the client could produce one: a CONSTANT counter plus a CONSTANT node
    // meant two credentials saved in the same millisecond were indistinguishable on the wire.
    // These three tests pin the fix, the property it rests on, and the width that keeps it
    // parseable at all.

    /// The regression itself: same millisecond, different records ⇒ different `hlc`.
    #[test]
    fn synthesized_vault_hlc_is_unique_per_record_within_one_millisecond() {
        let a = synth_hlc(&json!({ "uuid": "aaaa", "updatedAt": 1_700_000_000_000i64 }));
        let b = synth_hlc(&json!({ "uuid": "bbbb", "updatedAt": 1_700_000_000_000i64 }));
        assert_ne!(
            a, b,
            "two records saved in the same millisecond must not collide on the wire, or the \
             server has to break the tie by rewriting the AEAD-bound hlc and brick both"
        );
    }

    /// A record with no `updatedAt` used to collide with EVERY other such record — a guaranteed
    /// tie, not a probabilistic one. Same guarantee to check here.
    #[test]
    fn synthesized_vault_hlc_is_unique_even_when_updated_at_is_missing() {
        let a = synth_hlc(&json!({ "uuid": "aaaa" }));
        let b = synth_hlc(&json!({ "uuid": "bbbb" }));
        assert_ne!(a["counter"], b["counter"]);
    }

    /// The property the AEAD binding rests on: re-deriving the stamp for an UNCHANGED record must
    /// be byte-identical, or every push would seal a different AAD and fork the record into a new
    /// version on every single sync. This is why the digest is FNV-1a and not a randomly-seeded
    /// hasher.
    #[test]
    fn synthesized_vault_hlc_is_stable_across_passes() {
        let rec = json!({ "uuid": "aaaa", "updatedAt": 1_700_000_000_000i64 });
        assert_eq!(synth_hlc(&rec), synth_hlc(&rec));
    }

    /// `Hlc.counter` is a `u32` and `sync_envelope::from_value` deserializes with serde, which
    /// ERRORS on an out-of-range integer rather than truncating. A digest wider than 32 bits
    /// would therefore make `from_value` return `None`, `seal_wire` return `Err("record missing
    /// hlc")`, and the whole vault silently stop syncing. This test is what caught that.
    #[test]
    fn synthesized_vault_hlc_parses_as_a_real_hlc() {
        for uuid in ["a", "abcd", "ffffffff-ffff-ffff-ffff-ffffffffffff", ""] {
            let hlc = synth_hlc(&json!({ "uuid": uuid, "updatedAt": 1_700_000_000_000i64 }));
            let parsed = crate::sync_envelope::from_value(&json!({ "hlc": hlc }))
                .unwrap_or_else(|| panic!("synthesized hlc for {uuid:?} must parse"));
            assert_eq!(parsed.wall_ms, 1_700_000_000_000i64);
            assert_eq!(parsed.node, META_NODE);
        }
    }

    /// A real `Hlc` already on the record must win over the synthesis.
    #[test]
    fn an_existing_hlc_is_never_overwritten() {
        let rec = json!({
            "uuid": "aaaa",
            "updatedAt": 1_700_000_000_000i64,
            "hlc": { "wall_ms": 5, "counter": 9, "node": "real" },
        });
        // Mirror what `read_for_sync_with_hlc` does: `or_insert_with` must not fire.
        let mut r = rec.clone();
        let hlc = synth_hlc(&r);
        if let Some(o) = r.as_object_mut() {
            o.entry("hlc".to_string()).or_insert_with(|| hlc);
        }
        assert_eq!(r["hlc"]["node"], json!("real"));
    }

    /// The headline fix: a record that does not authenticate must be quarantined, and the
    /// local credential it targeted must survive untouched. This is the exact scenario the
    /// old suite asserted the *opposite* of.
    #[test]
    fn unauthenticated_record_is_quarantined_and_local_record_survives() {
        with_tmp_app(|app| {
            let vk = seeded_unlocked(app, &[cred("keep-me", 1_000)]);
            // `vault.add` mints its own uuid, so read back the real one — an attacker targets a
            // record that actually exists.
            let before = vault::dispatch(app, "vault.list", &json!({}))
                .expect("list channel")
                .expect("list");
            let arr = before.as_array().expect("array");
            assert_eq!(arr.len(), 1, "the local record must be seeded");
            let target = arr[0]["uuid"].as_str().expect("uuid").to_string();
            // A well-formed-looking record with a newer timestamp but garbage ciphertext: what a
            // hostile or corrupt peer would send.
            let forged = json!({
                "uuid": target,
                "updatedAt": 9_999_999i64,
                "nonce": "eeff",
                "ct": "1122",
            });

            let out = vault::merge_remote(app, &[forged]).expect("merge runs");
            assert_eq!(out.changed, Vec::<String>::new(), "nothing may be accepted");
            assert_eq!(out.quarantined, vec![target.clone()]);

            // The local record is still there and still decrypts to the ORIGINAL secret.
            let listed = vault::dispatch(app, "vault.list", &json!({}))
                .expect("list channel")
                .expect("list");
            let arr = listed.as_array().expect("array");
            assert_eq!(arr.len(), 1, "the forged record must not have been stored");
            assert_eq!(arr[0]["uuid"], target);
            assert_eq!(arr[0]["password"], "hunter2", "original secret intact");
            let _ = vk;
        });
    }

    /// A record sealed under a DIFFERENT vault key (a peer that has the sync root but not this
    /// vault's password) must not be readable, and must not be merged. This is the specific
    /// attack the recovery-phrase-only peer represents.
    #[test]
    fn record_sealed_under_a_different_vault_key_is_quarantined() {
        with_tmp_app(|app| {
            seeded_unlocked(app, &[]);
            let other_vk = vault::init_vault("a completely different password")
                .expect("init second vault")
                .1;
            let alien = vault::seal_record(&other_vk, &cred("alien", 5_000))
                .expect("seal under foreign key");

            let out = vault::merge_remote(app, &[alien]).expect("merge runs");
            assert!(out.changed.is_empty());
            assert_eq!(out.quarantined, vec!["alien".to_string()]);
            let listed = vault::dispatch(app, "vault.list", &json!({}))
                .expect("list")
                .expect("list");
            assert!(listed.as_array().expect("array").is_empty());
        });
    }

    /// The happy path must still work: a record sealed under the SAME key by a genuine paired
    /// device merges, and an older one does not clobber a newer local edit.
    #[test]
    fn authentic_record_merges_and_older_timestamp_loses() {
        with_tmp_app(|app| {
            let vk = seeded_unlocked(app, &[]);
            let mut newer = cred("shared", 2_000);
            newer.password = "from-peer".into();
            let mut older = cred("shared", 1_500);
            older.password = "stale".into();

            let out = vault::merge_remote(app, &[vault::seal_record(&vk, &newer).unwrap()])
                .expect("merge");
            assert_eq!(out.changed, vec!["shared".to_string()]);
            assert!(out.quarantined.is_empty());

            let out = vault::merge_remote(app, &[vault::seal_record(&vk, &older).unwrap()])
                .expect("merge");
            assert!(out.changed.is_empty(), "an older record must not win");
            assert!(out.quarantined.is_empty(), "it is authentic, just stale");

            let listed = vault::dispatch(app, "vault.list", &json!({}))
                .expect("list")
                .expect("list");
            assert_eq!(listed[0]["password"], "from-peer");
        });
    }

    /// A locked vault must refuse to merge outright — you cannot authenticate what you cannot
    /// decrypt, and writing unverified ciphertext is the original bug.
    #[test]
    fn locked_vault_refuses_to_merge() {
        with_tmp_app(|app| {
            let vk = seeded_unlocked(app, &[]);
            vault::dispatch(app, "vault.lock", &json!({}))
                .expect("lock")
                .expect("lock");
            let rec = vault::seal_record(&vk, &cred("x", 1)).unwrap();
            assert_eq!(
                vault::merge_remote(app, &[rec]).unwrap_err(),
                "vault is locked"
            );
        });
    }

    // ── the salt handshake, walked through production ──
    //
    // The two cases below used to call `set_cached_salt` by hand and then assert the cache
    // round-tripped. That is worse than no test: it fabricated the one precondition production
    // cannot produce (a salt that arrived from a published record, when publishing a record
    // required already having one), so twenty green tests sat on top of a feature that could
    // never run. Everything here goes through the real pass instead.

    /// THE headline case. On a cold install — the only install there ever is for the first user
    /// of an account — `syncVault` must be able to take effect at all.
    ///
    /// No helper here calls `set_cached_salt`. A real HTTP server on loopback answers the pull
    /// with an empty namespace and records what the client pushes, and the salt is read back
    /// off the wire with the production `open_wire`. Before the fix this could not happen at
    /// any point: `local_meta_record` demanded `is_synced`, `is_synced` demanded an adopted
    /// salt, and an adopted salt could only arrive from a published record.
    #[test]
    fn a_cold_install_publishes_its_own_salt_and_becomes_the_accounts_vault() {
        with_tmp_app(|app| {
            vault::dispatch(app, "vault.create", &json!({ "masterPassword": PW }))
                .expect("create channel")
                .expect("create");
            vault::dispatch(
                app,
                "vault.add",
                &json!({ "input": { "site": "https://example.com", "username": "alice",
                                    "password": "hunter2", "notes": "" }}),
            )
            .expect("add channel")
            .expect("add ok");
            let own = vault::file_salt(&vault::read_file(app).expect("vault")).expect("own salt");
            assert!(
                !vault::is_synced(app),
                "a fresh vault starts at the local-only version"
            );

            let server = FakeServer::start(&[]);
            pass(app, &server.base, 9);

            // 1. This device's salt reached the account.
            let meta = opened(NS_META, &server.pushed(NS_META));
            assert_eq!(
                meta.len(),
                1,
                "exactly one meta record is published, got {meta:?}"
            );
            assert_eq!(meta[0]["uuid"], META_UUID);
            assert_eq!(
                meta[0]["salt"],
                hex(&own),
                "the account's salt is this device's OWN, so every device can derive the key"
            );

            // 2. The stamp it went up under is remembered, so a steady pass is a no-op on the
            //    server instead of a fresh (and therefore always-winning) write.
            assert_eq!(cached_salt(app).as_deref(), Some(&own[..]));
            assert_eq!(
                cached_hlc(app),
                crate::sync_envelope::from_value(&meta[0]),
                "the published HLC is cached, not re-minted next pass"
            );

            // 3. The vault is now the account's vault — no unlock, no password, one pass.
            assert!(
                vault::is_synced(app),
                "the publisher stamps its own vault without needing a lock/unlock cycle"
            );
            assert!(
                is_sync_enabled(app),
                "so the UI agrees the records may sync, which is what the toggle promises"
            );

            // 4. And the credential went up in the SAME pass, not one sync later. The wire
            //    record is still SEALED, because the transport's key and the vault's key are
            //    two different layers and the account can open neither — so the check is that
            //    the vault key opens it, not that a field is readable in the clear.
            let recs = opened(vault::NS, &server.pushed(vault::NS));
            assert_eq!(
                recs.len(),
                1,
                "the credential saved with the vault publishes at once"
            );
            assert!(
                recs[0].get("site").is_none(),
                "nothing readable in the clear on the wire: {recs:?}"
            );
            let vk = vault::unlocked_key(app).expect("the vault is still unlocked");
            let inner = vault::open_record(&vk, &recs[0])
                .expect("the pushed record must open under THIS device's vault key");
            assert_eq!(inner.site, "https://example.com");
            assert_eq!(inner.password, "hunter2");
        });
    }

    /// A steady-state pass must re-push the SAME stamp. A freshly minted HLC always wins the
    /// server's LWW, so minting one every pass would out-rank every peer copy forever and two
    /// devices that briefly disagreed would flap the published salt back and forth endlessly.
    #[test]
    fn a_steady_pass_re_pushes_the_same_stamp_rather_than_a_fresh_winning_one() {
        with_tmp_app(|app| {
            vault::dispatch(app, "vault.create", &json!({ "masterPassword": PW }))
                .expect("create channel")
                .expect("create");
            let server = FakeServer::start(&[]);

            pass(app, &server.base, 9);
            let first = opened(NS_META, &server.pushed(NS_META));
            assert_eq!(first.len(), 1);

            pass(app, &server.base, 9);
            let second = opened(NS_META, &server.pushed(NS_META));
            assert_eq!(second.len(), 2, "the second pass publishes once more");
            assert_eq!(
                second[1]["hlc"], first[0]["hlc"],
                "a pass with nothing new to say must not out-rank its own earlier copy"
            );
            assert_eq!(second[1]["salt"], first[0]["salt"], "nor change the salt");
        });
    }

    /// The other half of the handshake, which had a second, separate circularity of its own:
    /// `try_adopt` guarded on `is_sync_enabled`, which already demanded adoption.
    ///
    /// A joining device must do neither of the two things that would re-key the account out
    /// from under every record already on it — publish its own salt over a salt that is
    /// already published, or stamp itself on the strength of somebody else's — and must still
    /// adopt at unlock, which is the only moment a master password exists.
    #[test]
    fn a_joining_device_adopts_the_published_salt_at_unlock_and_never_publishes_its_own() {
        with_tmp_app(|app| {
            vault::dispatch(app, "vault.create", &json!({ "masterPassword": PW }))
                .expect("create channel")
                .expect("create");
            vault::dispatch(
                app,
                "vault.add",
                &json!({ "input": { "site": "https://example.com", "username": "alice",
                                    "password": "hunter2", "notes": "" }}),
            )
            .expect("add channel")
            .expect("add ok");
            let own = vault::file_salt(&vault::read_file(app).expect("vault")).expect("own salt");

            let theirs = salt(0x5A);
            let published = json!({
                "uuid": META_UUID,
                "hlc": serde_json::to_value(crate::sync_envelope::tick(META_NODE, 1_700_000_000_000i64))
                    .expect("hlc"),
                "salt": hex(&theirs),
                "v": KDF_V_SYNCED,
            });
            let canned = vec![crate::sync::seal_wire(
                &crate::crypto::data_key(&root(), NS_META),
                NS_META,
                &published,
            )
            .expect("seal the canned record")];
            let server = FakeServer::start(&[(NS_META, canned)]);

            pass(app, &server.base, 9);

            // The account already had a salt, so this device published NOTHING.
            assert!(
                server.pushed(NS_META).is_empty(),
                "a joiner must never re-publish: a fresh HLC wins the server's LWW and would \
                 re-key the account out from under every record already on it"
            );
            assert!(
                !vault::is_synced(app),
                "somebody else's salt cannot stamp this device's vault"
            );
            assert!(
                !is_sync_enabled(app),
                "so its records stay local until it adopts"
            );
            assert_eq!(
                cached_salt(app).as_deref(),
                Some(&theirs[..]),
                "but the account's salt IS cached, because unlock is where the password lives"
            );

            // Unlock is the only place the master password exists, and it is enough.
            vault::dispatch(app, "vault.unlock", &json!({ "masterPassword": PW }))
                .expect("unlock channel")
                .expect("unlock");
            assert!(
                vault::is_synced(app),
                "unlocking must adopt the cached salt — guarded on is_sync_enabled it could \
                 never run on the one device that needs it"
            );
            let after = vault::read_file(app).expect("vault after adopt");
            assert_eq!(vault::file_salt(&after).as_deref(), Some(&theirs[..]));
            assert_ne!(
                vault::file_salt(&after).as_deref(),
                Some(&own[..]),
                "the salt really changed"
            );

            // Re-sealing must not cost the user anything: the credential is still readable.
            let listed = vault::dispatch(app, "vault.list", &json!({}))
                .expect("list")
                .expect("list");
            let arr = listed.as_array().expect("array");
            assert_eq!(arr.len(), 1, "the credential survived the re-seal");
            assert_eq!(arr[0]["password"], "hunter2");
        });
    }

    /// The port that makes the whole feature work: a device re-seals its own records under the
    /// account's shared salt, and every record still opens afterwards.
    #[test]
    fn reseal_with_salt_keeps_every_record_readable_under_the_new_salt() {
        with_tmp_app(|app| {
            let old_vk = seeded_unlocked(app, &[cred("a", 1_000), cred("b", 2_000)]);
            let file = vault::read_file(app).expect("vault on disk");
            let new_salt = salt(0x5A);
            let next = vault::reseal_with_salt(&file, PW, &new_salt).expect("reseal");
            assert_eq!(vault::file_salt(&next).as_deref(), Some(&new_salt[..]));
            assert_eq!(vault::file_version(&next), KDF_V_SYNCED);
            // Every record still opens under the NEW salt — this is the whole point of adoption.
            let unlocked = vault::unlock_vault(&next, PW).expect("unlock under new salt");
            assert!(unlocked.orphans.is_empty(), "nothing became an orphan");
            assert_eq!(
                unlocked.records.len(),
                2,
                "both records survived the re-seal"
            );

            // Now drive the real adoption path the way `try_adopt` does, so the in-memory key
            // actually changes (a pure re-seal deliberately does not touch it).
            vault::adopt_resealed(app, &next, PW).expect("adopt");
            let new_vk = vault::unlocked_key(app).expect("still unlocked");
            assert_ne!(
                &*new_vk, &*old_vk,
                "the vault key must change with the salt"
            );
            assert!(vault::is_synced(app), "adoption stamps the file as synced");

            // The data is intact and readable through the normal channel.
            let listed = vault::dispatch(app, "vault.list", &json!({}))
                .expect("list")
                .expect("list");
            let arr = listed.as_array().expect("array");
            assert_eq!(arr.len(), 2);
            assert!(arr.iter().any(|c| c["password"] == "hunter2"));

            // And the OLD key can no longer open the re-sealed file — the salt change is real,
            // which is exactly why a peer without the shared salt cannot forge a record.
            let wire = vault::read_file(app).expect("adopted file on disk");
            for r in wire["records"].as_array().expect("records") {
                assert!(
                    vault::open_record(&old_vk, r).is_err(),
                    "the pre-adoption key must not open post-adoption records"
                );
                assert!(vault::open_record(&new_vk, r).is_ok());
            }

            // Re-sealing under the salt it already uses is a no-op, not a rewrite.
            let again = vault::reseal_with_salt(&next, PW, &new_salt).expect("idempotent reseal");
            assert_eq!(
                vault::unlock_vault(&again, PW)
                    .expect("still opens")
                    .records
                    .len(),
                2
            );
        });
    }

    /// A wrong password must be rejected BEFORE any re-seal, so a typo can never "succeed" and
    /// produce an empty vault under the new salt (which would destroy the records).
    #[test]
    fn reseal_rejects_a_wrong_password_without_producing_a_file() {
        let (file, _) = vault::init_vault(PW).expect("init");
        assert!(vault::reseal_with_salt(&file, "nope", &salt(1)).is_err());
    }

    /// Adoption must refuse when the vault holds records it cannot decrypt: a re-seal rewrites
    /// the record array, so carrying orphans across is impossible and dropping them would be
    /// silent credential loss. The honest outcome is "stay local", not "delete".
    #[test]
    fn adoption_refuses_when_orphans_are_present() {
        let (mut file, _) = vault::init_vault(PW).expect("init");
        // Splice in a record that cannot decrypt.
        if let Some(arr) = file.get_mut("records").and_then(|r| r.as_array_mut()) {
            arr.push(json!({ "uuid": "corrupt", "updatedAt": 1, "nonce": "ee", "ct": "ff" }));
        }
        let err = vault::reseal_with_salt(&file, PW, &salt(2)).unwrap_err();
        assert!(
            err.to_string().contains("undecryptable"),
            "expected an orphan-specific refusal, got {err}"
        );
    }

    /// A vault created before any account existed is version 1, and `is_synced` must say so —
    /// that is what keeps the old destructive bridge from ever running on it.
    #[test]
    fn a_fresh_local_vault_is_not_synced() {
        with_tmp_app(|app| {
            assert!(!vault::is_synced(app));
            assert!(!is_sync_enabled(app), "and the opt-in is off by default");
        });
    }

    /// With the flag on and an adopted file, the record namespace must actually be enabled.
    #[test]
    fn sync_requires_the_flag_and_adoption_together() {
        with_tmp_app(|app| {
            seeded_unlocked(app, &[]);
            set_flag(app, true);
            // The flag is on, but this vault is still on its own per-device salt, so records
            // must NOT sync: pushing them would only publish blobs no other device can open.
            assert!(!vault::is_synced(app));
            assert!(
                !is_sync_enabled(app),
                "adoption is required before records sync, regardless of the flag"
            );
        });
    }

    /// The settings validator must reject the settings that used to be silently accepted.
    #[test]
    fn settings_validator_rejects_dangerous_values() {
        for (key, bad) in [
            ("homeUrl", json!("file:///home/u/.ssh/id_rsa")),
            ("homeUrl", json!("ftp://example.com")),
            ("homeUrl", json!(42)),
            ("defaultSearchTemplate", json!("https://d.example/?q=")), // no %s
            ("syncServerUrl", json!("not a url")),
            ("downloadDir", json!("relative/path")),
            ("webrtcPolicy", json!("off")),
            ("antiFingerprint", json!("loud")),
            ("httpsOnly", json!("yes")),
            ("tabIdleTimeout", json!(-1)),
            ("tabIdleTimeout", json!(999_999)),
            ("primaryColor", json!("red; background: url(x)")),
            ("notARealSetting", json!(true)),
        ] {
            let r = crate::settings::validate_setting_for_test(key, &bad);
            assert!(r.is_err(), "{key} = {bad} should have been rejected");
        }
    }

    #[test]
    fn settings_validator_accepts_the_real_settings() {
        for (key, good) in [
            ("homeUrl", json!("https://example.com")),
            ("homeUrl", json!("about:blank")),
            ("homeUrl", json!("http://localhost:8080/")),
            (
                "defaultSearchTemplate",
                json!("https://duckduckgo.com/?q=%s"),
            ),
            ("syncServerUrl", json!("https://sync.example.com")),
            ("syncServerUrl", json!("")),                      // clears
            ("syncServerUrl", json!("http://127.0.0.1:8787")), // loopback is legal
            ("downloadDir", json!("/home/u/Downloads")),
            ("downloadDir", json!("")), // "use the default"
            ("webrtcPolicy", json!("public-only")),
            ("antiFingerprint", json!("strict")),
            ("httpsOnly", json!(true)),
            ("syncVault", json!(false)),
            ("hideChromeByDefault", json!(false)),
            ("tabIdleTimeout", json!(0)),
            ("tabIdleTimeout", json!(30)),
            ("backgroundTabTimeout", json!(30000)),
            ("aggressiveSweepThreshold", json!(20)),
            ("syncIntervalSec", json!(900)),
            ("primaryColor", json!("#4f8cff")),
            ("primaryColor", json!("#4f8cff80")),
            ("primaryColor", json!("")), // "use the default"
            ("themeMode", json!("dark")),
            (
                // The real `SearchEngine` shape is `{id, name, template}` — see
                // `shared/types.ts`. This case originally used a `url` key, which asserted
                // the validator's own bug as correct: the app's `defaults()`, the TS type and
                // `SearchTab` all write `template`, so requiring `url` rejected all three and
                // silently disabled the whole search-engine editor. `settings.rs` now owns
                // the detailed per-field cases; this stays as the cross-module "a realistic
                // bundle validates" check.
                "searchEngines",
                json!([{ "id": "ddg", "name": "ddg", "template": "https://duckduckgo.com/?q=%s" }]),
            ),
            ("proxy", json!({})),
        ] {
            let r = crate::settings::validate_setting_for_test(key, &good);
            assert!(r.is_ok(), "{key} = {good} should be accepted: {:?}", r);
        }
    }

    // ── Vault delete tombstones ────────────────────────────────────────────────
    //
    // The bug these guard: `vault.remove` did a bare `records.retain(..)`, so a delete was a
    // purely local event. Nothing in the wire format could express "gone" — `merge_remote` had
    // no branch that could ever drop a record — so every paired device re-pushed the credential
    // on its next pass and it simply came back. A user who deleted a credential *because it
    // leaked* could never get rid of it, and the ciphertext stayed on the server forever.
    //
    // A tombstone is a normal AEAD record whose plaintext is `TOMBSTONE_BODY`, so the delete
    // inherits the same authentication as the credential it removes: only a peer holding the
    // vault key can mint one, and a forged one is quarantined rather than obeyed.

    /// Listed uuids, via the public channel, so the assertions read the same way a user's
    /// vault would.
    fn listed_uuids<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
        vault::dispatch(app, "vault.list", &json!({}))
            .expect("list channel")
            .expect("list ok")
            .as_array()
            .expect("list is an array")
            .iter()
            .filter_map(|v| v.get("uuid").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    /// The headline fix: a delete sticks, even though the peer re-pushes the credential it
    /// still holds on every single pass.
    #[test]
    fn a_tombstone_deletes_the_credential_and_survives_the_peer_re_pushing_it() {
        with_tmp_app(|app| {
            let vk = seeded_unlocked(app, &[]);
            let mut c = cred("leaked", 2_000);
            c.password = "secret".into();

            // The peer pushes the credential, then learns it leaked and pushes a delete.
            vault::merge_remote(app, &[vault::seal_record(&vk, &c).unwrap()]).expect("merge");
            assert_eq!(listed_uuids(app), vec!["leaked".to_string()]);

            let tomb = vault::seal_tombstone(&vk, "leaked", 2_001).expect("seal tombstone");
            vault::merge_remote(app, &[tomb]).expect("merge delete");
            assert!(
                listed_uuids(app).is_empty(),
                "the tombstone must remove the credential, not just shadow it"
            );

            // The whole bug: the peer still has it and re-pushes on its next pass. This used
            // to resurrect the credential, because no merge branch could drop a record.
            let out = vault::merge_remote(app, &[vault::seal_record(&vk, &c).unwrap()])
                .expect("merge re-push");
            assert!(
                out.quarantined.is_empty(),
                "the re-push is authentic, so it must be dropped as deleted, not quarantined"
            );
            assert!(
                out.changed.is_empty(),
                "a deleted record must not come back"
            );
            assert!(
                listed_uuids(app).is_empty(),
                "a deleted credential must stay deleted across a re-push"
            );
        });
    }

    /// LWW in the other direction: a credential genuinely re-saved *after* the delete is a
    /// real edit by the user, and must win. Otherwise the delete would be permanent forever and
    /// there would be no way to undo it.
    #[test]
    fn a_credential_saved_after_the_delete_wins() {
        with_tmp_app(|app| {
            let vk = seeded_unlocked(app, &[]);
            let tomb = vault::seal_tombstone(&vk, "back", 2_000).expect("seal");
            vault::merge_remote(app, &[tomb]).expect("merge delete");
            assert!(listed_uuids(app).is_empty());

            let mut readded = cred("back", 2_001); // strictly newer than the tombstone
            readded.password = "new".into();
            let out = vault::merge_remote(app, &[vault::seal_record(&vk, &readded).unwrap()])
                .expect("merge re-add");
            assert_eq!(out.changed, vec!["back".to_string()]);
            assert_eq!(listed_uuids(app), vec!["back".to_string()]);

            // And the now-obsolete tombstone must not linger to block the NEXT edit.
            let mut again = cred("back", 2_002);
            again.password = "newer".into();
            let out = vault::merge_remote(app, &[vault::seal_record(&vk, &again).unwrap()])
                .expect("merge second edit");
            assert_eq!(
                out.changed,
                vec!["back".to_string()],
                "a stale tombstone must not veto a later edit"
            );
        });
    }

    /// The authority is the SEALED BODY, never the cleartext `deleted` hint (the hint exists
    /// only so the server can prune without holding keys). A peer that flips the hint to
    /// `false` therefore still deletes — otherwise the hint would be load-bearing and a
    /// downgrade would resurrect the credential.
    #[test]
    fn clearing_the_deleted_hint_does_not_resurrect_the_credential() {
        with_tmp_app(|app| {
            let vk = seeded_unlocked(app, &[]);
            let mut c = cred("hint", 2_000);
            c.password = "secret".into();
            vault::merge_remote(app, &[vault::seal_record(&vk, &c).unwrap()]).expect("merge");

            let mut tomb = vault::seal_tombstone(&vk, "hint", 2_001).expect("seal");
            tomb["deleted"] = json!(false); // lie in the cleartext hint
            let out = vault::merge_remote(app, &[tomb]).expect("merge");
            assert!(out.quarantined.is_empty(), "the seal is still valid");
            assert!(
                listed_uuids(app).is_empty(),
                "the hint is advisory for pruning only; the sealed body decides"
            );
        });
    }

    /// A record that claims `deleted: true` in cleartext but is sealed under a FOREIGN key
    /// must be quarantined, not obeyed. Without this, any peer could delete any credential by
    /// name with no key at all — the exact hole the sealed design exists to close.
    #[test]
    fn a_forged_cleartext_delete_is_quarantined() {
        with_tmp_app(|app| {
            let vk = seeded_unlocked(app, &[]);
            let mut c = cred("keep", 2_000);
            c.password = "secret".into();
            vault::merge_remote(app, &[vault::seal_record(&vk, &c).unwrap()]).expect("merge");
            assert_eq!(listed_uuids(app), vec!["keep".to_string()]);

            // Seal a REAL tombstone for "keep" under an attacker-chosen key, then hand it over.
            let attacker = [7u8; 32];
            let forged = vault::seal_tombstone(&attacker, "keep", 9_999).expect("seal");
            let out = vault::merge_remote(app, &[forged]).expect("merge");
            assert_eq!(
                out.quarantined,
                vec!["keep".to_string()],
                "an unauthenticated delete must be quarantined"
            );
            assert_eq!(
                listed_uuids(app),
                vec!["keep".to_string()],
                "a forged delete must not remove a real credential"
            );
        });
    }
}
