# Password Vault (Phase A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to execute this plan. Dispatch each task to a subagent, review the diff against the task's
> acceptance criteria before moving on, and never batch independent tasks into one agent.
> Each task below is sized to be a single, reviewable TDD unit (test first, then code).

**Sub-project:** K (of the Aegis Improvements Program — see
`docs/superpowers/specs/2026-06-23-improvements-program-design.md` §3 K, §2.1, §6).
**Branch:** `feat/improvements-program`.
**Date:** 2026-06-23.

---

## Goal

Add a **local, encrypted-at-rest password vault** to Aegis: store and manage credential
records (site, username, password, notes) sealed with the existing `crypto.rs` AEAD under a
dedicated vault namespace, gated by a **master-password Argon2id KDF**. Lock/unlock with key
**zeroization on lock**, full CRUD + search, persisted via the existing `jsonstore` atomic
write. Exposed through `vault.*` IPC and a Settings "Passwords" tab with a manage/add UI.

**Phase A only.** The locked scope decision (§2.1) is **NO autofill, NO page→core bridge** —
the vault never injects into, reads from, or is reachable by the content webview. It is a
manual credential manager: the user copies values out of the chrome UI by hand. Autofill
(Phase B) is a separate go/no-go because it deliberately pierces the no-page→core invariant.

---

## Architecture

### Encryption model (reuse `crypto.rs` + `sync_keystore.rs`, do not reinvent)

The vault has its **own master password**, independent of the sync recovery phrase. The KDF
and AEAD primitives are reused verbatim from the existing crypto surface — the only new
crypto code is wiring, not algorithms.

**Key derivation (Argon2id), mirroring the existing passphrase path in `sync_keystore.rs`:**
the master password + a random 16-byte salt are run through `argon2::Argon2::default()
.hash_password_into(...)` exactly as `sync_keystore::derive_kek` does, producing a 256-bit
**vault key** (`vk`). That salt is stored in cleartext in the vault file header (it is not
secret; it only individualizes the KDF). `Argon2` is already a dependency (`sync_keystore.rs`
line 64 uses it).

**Per-record sealing (XChaCha20-Poly1305 via `crypto::seal`/`crypto::open`):** each credential
record is serialized to JSON and sealed with `crypto::seal(&vk, ns, uuid, hlc_bytes, plaintext)`
→ `(nonce, ciphertext)`, and opened with `crypto::open(&vk, &nonce, &ct, ns, uuid, hlc_bytes)`.

- `ns` (namespace) = the constant `"vault"`. This is the vault's **own namespace** — distinct
  from the sync data-key namespaces (`favorites`/`saved`/`settings`/…), and distinct from the
  sync-keystore's internal use of `seal` with `ns="vault", uuid="root"` (which seals the _root
  seed_, not credential records; our records use real per-record uuids so there is no AAD
  collision). The vault key `vk` is NOT a sync `data_key` — it is Argon2-derived from the user's
  master password, so the vault is gated by something the sync key tree never sees.
- `uuid` = the record's own v4 UUID (one per credential).
- `hlc_bytes` = a fixed per-record version tag. v1 uses the record's `updatedAt` epoch-ms as 8
  big-endian bytes, so the AAD binds the sealed body to _this_ record id + _this_ version. (No
  HLC/sync engine involvement — the vault is **not synced in Phase A**; it is local-only. The
  bytes just need to be reproducible at open time, which `updatedAt` is, since it's stored
  cleartext alongside the record.)

**Why AEAD AAD matters here (same property `crypto.rs` documents):** rebuilding the AAD from
`(ns, uuid, hlc_bytes)` at open time means a record sealed for one uuid cannot be silently
spliced under a different uuid, and a tampered ciphertext fails authentication — the existing
`open_fails_on_aad_mismatch` test proves this for the primitive; the vault inherits it.

**File at rest (`vault.json` via `jsonstore::write_atomic`):** a single JSON object:

```json
{
  "v": 1,
  "kdf": "argon2id",
  "salt": "<hex 16 bytes>",
  "verifier": { "nonce": "<hex>", "ct": "<hex>" },
  "records": [{ "uuid": "<v4>", "updatedAt": 1750000000000, "nonce": "<hex>", "ct": "<hex>" }]
}
```

- `salt` — the Argon2 salt (cleartext, not secret).
- `verifier` — a sealed known constant (`b"aegis-vault-verifier-v1"`) under
  `seal(&vk, "vault", "verifier", b"aegis-vault-verifier-v1", const)`. **Wrong-password
  detection:** on unlock we derive `vk` from the entered password + stored salt, then
  `crypto::open` the verifier; AEAD authentication failing = wrong password (no per-record
  decryption needed to detect it, and no password is ever stored).
- `records[]` — each is `{uuid, updatedAt, nonce, ct}` with cleartext routing fields and the
  sealed credential JSON (`{site, username, password, notes}`) in `ct`. **No plaintext field of
  any credential value ever touches the file.**

Persisted with `jsonstore::write_atomic` (temp→`sync_all`→rename→dir-fsync + `.bak`) and read
with `jsonstore::read_with_backup` (corrupt-primary recovery), identical to every other store.

### Lock state (in-memory, zeroized on lock)

A Tauri-managed `VaultState(Mutex<Inner>)`, mirroring `sync::SyncState`'s shape:

```rust
pub struct Inner {
    /// The Argon2-derived vault key while UNLOCKED. None when locked. Wiped on lock.
    key: Option<Zeroizing<[u8; 32]>>,
    /// Decrypted records held in memory while unlocked (cleared on lock).
    records: Vec<Cred>,           // Cred has Zeroize/ZeroizeOnDrop (see Task 1)
    created: bool,                // does vault.json exist (a vault has been set up)?
}
```

- **Locked** is the resting state: `key = None`, `records` empty, every plaintext credential
  absent from memory. The only thing the app knows while locked is _whether a vault exists_
  (`created`, derived from `vault.json`'s presence — no secret).
- **Unlock** derives `vk`, opens the verifier (rejecting a wrong password), then opens every
  record into memory. **Lock** sets `key = None` and clears `records`, so the `Zeroizing<[u8;
32]>` and the `Zeroize`-implementing `Cred`s are wiped on drop. No timer in v1 (manual
  Lock button + a documented note that closing the app drops the process memory anyway).
- **No reads while locked.** `vault.list`/`vault.add`/… all return `Err("vault is locked")`
  when `key` is `None` (mirrors `sync`'s `"sync is locked"` guards), so the renderer can never
  pull a credential without an unlock.

### Storage / data flow summary

```
master password ──Argon2id(salt)──▶ vault key vk (32B, zeroized on lock)
                                          │
credential {site,user,pw,notes} ──serde──┼──crypto::seal(vk,"vault",uuid,updatedAt)──▶ {nonce,ct}
                                          │                                                  │
                                          └──crypto::open(vk,...)──◀──jsonstore::read_with_backup──┘
                                                                                            │
                                            jsonstore::write_atomic(vault.json) ◀───────────┘
```

---

## Tech Stack

- **Rust core:** `crypto.rs` (`seal`/`open`, reused), `argon2` crate (already a dep, used by
  `sync_keystore.rs`), `zeroize`/`Zeroizing` (already a dep), `jsonstore.rs` (atomic write +
  `.bak`), `serde_json`, `uuid`, `getrandom` — all already in `Cargo.toml`. **No new crates.**
- **IPC:** `shared/types.ts` (`IPC` const + `Vault*` interfaces + `AegisApi.vault`), the Rust
  `vault::dispatch` arm in `lib.rs::ipc()`, `src/lib/ipcClient.ts`.
- **UI:** React 19 + TS. New `useVault` hook (mirrors `useSync`), `VaultSettingsTab.tsx`
  (mirrors `SyncSettingsTab.tsx`), a new `'vault'` entry in `SettingsModal`'s `SettingsTab`
  union / `TAB_ORDER` / props.
- **Autopilot:** `catalog.ts` (entry + `verify` round-trip), `screens.ts` (auto via
  `TAB_ORDER`, plus `reach.ts` label), `interactions/` (new `vault.ts` domain file +
  `controls.ts` ids), the drift guards.

## Global Constraints (§6 + the locked decision)

1. **NO autofill / NO page→core bridge (locked, §2.1).** The vault is unreachable from the
   content webview. No document-start injection, no `window.AegisVault`, no nav-policy hook, no
   clipboard auto-population from a page. The user reads values from the chrome UI manually.
2. **IPC in three places (§6.1):** every new channel goes in `shared/types.ts` (`IPC` const),
   the Rust `ipc()` dispatcher (`vault::dispatch`), and `src/lib/ipcClient.ts`. The vault emits
   **one event** (`vault.state`) — emitted only via `crate::emit_event` (the `.`→`:` rewrite);
   never a raw dotted name.
3. **Autopilot coverage in the same commit (drift-guarded, §6.2):** the new `vault.*` channels
   get a `catalog.ts` entry whose `channels` lists **every** `IPC.vault*` constant (the IPC
   drift guard `coverage.test.ts` fails the build otherwise) plus a `verify(api)` round-trip
   (it mutates user data). The new Settings tab is auto-covered by `SETTINGS_SCREENS` (it maps
   `TAB_ORDER`), but `reach.ts`'s `SETTINGS_TAB_LABEL` map needs the `vault: 'Passwords'` entry
   or it can't click the tab. New interactive controls get specs + `INTERACTIVE_CONTROLS` ids
   (interaction drift guard).
4. **Gate (§6.3):** `npm test` green; for the runtime-touching legs, the live autopilot
   `RESULT: … 0 failed` and `ad-block blocking (trace): PASS` on Linux.
5. **Parity before "done" (§6.4):** the vault is **pure Rust core + chrome React UI with no
   per-platform native code** (no GTK/WebView2/objc2/JNI — it never touches the content
   webview), so it compiles and runs identically on Linux/Windows/macOS/Android. Verify: Linux
   live (autopilot), Android (it's the same `app_lib` Rust + the same `MobileApp` React
   surface — add a mobile menu entry so it's reachable), Windows/macOS via the existing CI
   build. There is no platform-specific code path to leave behind.
6. **Reuse, don't reinvent crypto.** `crypto::seal`/`crypto::open` and the Argon2id derivation
   pattern from `sync_keystore::derive_kek` are reused verbatim. Do not write a second cipher
   or KDF.

---

## File Structure

```
src-tauri/src/
  vault.rs                         NEW — vault core: Cred type, VaultState, KDF/seal/open,
                                         CRUD + search, lock/unlock, jsonstore persistence,
                                         dispatch(vault.*). #[cfg(test)] unit tests.
  lib.rs                           EDIT — `mod vault;`, `.manage(vault::VaultState::default())`,
                                         a `vault::dispatch(...)` arm in ipc().

shared/
  types.ts                         EDIT — IPC.vault* channels + evtVaultState; Cred/VaultState/
                                         VaultRecordInput interfaces; AegisApi.vault namespace.

src/lib/
  ipcClient.ts                     EDIT — aegis.vault.{getState,create,unlock,lock,list,add,
                                         update,remove,search} + onState.

src/hooks/
  useVault.ts                      NEW — owns VaultState + the action wrappers (mirror useSync).
  useVault.test.ts                 NEW — hook unit tests (mocked aegis.vault).

src/components/
  VaultSettingsTab.tsx             NEW — the Settings "Passwords" tab UI (mirror SyncSettingsTab):
                                         create/unlock/lock + list + add/edit/remove + search.
  VaultSettingsTab.test.tsx        NEW — component tests (create/unlock/add/copy/lock flows).
  SettingsModal.tsx                EDIT — add 'vault' to SettingsTab union, TAB_ORDER, props.

src/App.tsx                        EDIT — const vault = useVault(); pass <VaultSettingsTab/> to
                                         SettingsModal's new `vault` prop; mobile menu entry.

src/autopilot/
  catalog.ts                       EDIT — vault.crud entry (channels + exercise + verify).
  reach.ts                         EDIT — SETTINGS_TAB_LABEL['vault'] = 'Passwords'.
  interactions/vault.ts            NEW — VAULT_INTERACTIONS specs.
  interactions/index.ts            EDIT — spread ...VAULT_INTERACTIONS.
  interactions/controls.ts         EDIT — new vault.* control ids.
```

`screens.ts` needs **no edit** — `SETTINGS_SCREENS` is `TAB_ORDER.map(...)`, so adding
`'vault'` to `TAB_ORDER` auto-creates the `settings:vault` screen the tour walks.

---

## Tasks (bite-sized, TDD)

Each task: write the test(s) first, watch them fail, implement, watch them pass. Rust tests
run with `cargo test` (the `vault.rs` `#[cfg(test)]` module); TS with `npm test`.

---

### Task 1 — `vault.rs` crypto + state core (Rust, TDD)

**Write first** (`src-tauri/src/vault.rs`, `#[cfg(test)] mod tests`):

- `seal_persist_reopen_unlock_decrypt_round_trips` — create a vault with a master password +
  one record, serialize the file to JSON, parse it back fresh (simulating a reopen), unlock
  with the right password, assert the decrypted record equals the original.
- `wrong_password_fails_unlock` — unlock with a different password returns `Err`, and the
  cleartext record is NOT produced.
- `lock_zeroizes_key_and_clears_records` — after `lock`, `Inner.key` is `None` and
  `Inner.records` is empty (a subsequent `list` without re-unlock errors).
- `record_at_rest_has_no_plaintext` — serialize the file and assert the JSON text does NOT
  contain the plaintext password/username/site/notes substrings (only `nonce`/`ct` hex).
- `tampered_ciphertext_fails_open` — flip a byte in a record's `ct`; opening it errors.

Build the pure, AppHandle-free seam so these tests need no Tauri (mirrors how `crypto.rs`,
`sync.rs::seal_wire`, and `settings.rs::merge_projection` keep the testable logic pure):

```rust
//! Local, encrypted-at-rest password vault (Phase A — manage only, NO autofill).
//!
//! Credential records are sealed with the SAME XChaCha20-Poly1305 AEAD as the sync engine
//! (crypto::seal/open) under the dedicated "vault" namespace, gated by a master-password
//! Argon2id KDF (mirroring sync_keystore::derive_kek). The vault is NOT synced and NEVER
//! reachable from the content webview — there is no page->core bridge (locked decision).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const NS: &str = "vault";
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
    for x in b { s.push_str(&format!("{x:02x}")); }
    s
}
fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 { return None; }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
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
fn hlc_bytes(updated_at: i64) -> [u8; 8] { updated_at.to_be_bytes() }

/// Seal one credential into a wire record `{uuid, updatedAt, nonce, ct}` (cleartext routing
/// fields + the sealed JSON body). NO plaintext credential field leaves this function.
fn seal_record(vk: &[u8; 32], c: &Cred) -> Result<Value, String> {
    let plaintext = Zeroizing::new(serde_json::to_vec(c).map_err(|e| e.to_string())?);
    let (nonce, ct) = crate::crypto::seal(vk, NS, &c.uuid, &hlc_bytes(c.updated_at), &plaintext)?;
    Ok(json!({ "uuid": c.uuid, "updatedAt": c.updated_at, "nonce": hex(&nonce), "ct": hex(&ct) }))
}

/// Open a wire record back into a Cred, authenticating against its cleartext uuid/updatedAt.
fn open_record(vk: &[u8; 32], w: &Value) -> Result<Cred, String> {
    let uuid = w.get("uuid").and_then(Value::as_str).ok_or("record missing uuid")?;
    let updated_at = w.get("updatedAt").and_then(Value::as_i64).ok_or("record missing updatedAt")?;
    let nonce = w.get("nonce").and_then(Value::as_str).and_then(unhex).ok_or("record bad nonce")?;
    let ct = w.get("ct").and_then(Value::as_str).and_then(unhex).ok_or("record bad ct")?;
    let pt = Zeroizing::new(crate::crypto::open(vk, &nonce, &ct, NS, uuid, &hlc_bytes(updated_at))?);
    serde_json::from_slice(&pt).map_err(|e| e.to_string())
}

/// Seal the fixed verifier constant so unlock can detect a wrong password via AEAD auth alone.
fn seal_verifier(vk: &[u8; 32]) -> Result<Value, String> {
    let (nonce, ct) = crate::crypto::seal(vk, NS, VERIFIER_UUID, VERIFIER_HLC, VERIFIER_PLAINTEXT)?;
    Ok(json!({ "nonce": hex(&nonce), "ct": hex(&ct) }))
}
/// Returns Ok(()) iff `vk` is the right key (the verifier authenticates + matches).
fn check_verifier(vk: &[u8; 32], v: &Value) -> Result<(), String> {
    let nonce = v.get("nonce").and_then(Value::as_str).and_then(unhex).ok_or("bad verifier")?;
    let ct = v.get("ct").and_then(Value::as_str).and_then(unhex).ok_or("bad verifier")?;
    let pt = crate::crypto::open(vk, &nonce, &ct, NS, VERIFIER_UUID, VERIFIER_HLC)
        .map_err(|_| "wrong master password".to_string())?;
    if pt == VERIFIER_PLAINTEXT { Ok(()) } else { Err("wrong master password".into()) }
}
```

The in-memory lock state + the pure file (de)serialization the tests drive:

```rust
use std::sync::Mutex;

pub struct VaultState(pub Mutex<Inner>);
#[derive(Default)]
pub struct Inner {
    key: Option<Zeroizing<[u8; 32]>>,
    records: Vec<Cred>,
    salt: Vec<u8>,        // the Argon2 salt for THIS vault (loaded from the file)
    created: bool,        // a vault file exists
}
impl Default for VaultState { fn default() -> Self { VaultState(Mutex::new(Inner::default())) } }

/// Build the on-disk JSON object from the verifier + sealed records (the at-rest file).
fn file_json(salt: &[u8], verifier: Value, records: &[Value]) -> Value {
    json!({ "v": 1, "kdf": "argon2id", "salt": hex(salt), "verifier": verifier, "records": records })
}
```

The tests construct a `vk` from a fixed salt + password, seal a `Cred`, build `file_json`,
`serde_json::to_string`, parse back, derive `vk` again from the parsed salt + (right/wrong)
password, `check_verifier`, then `open_record` each. The `no_plaintext` test asserts on the
serialized string. These prove the round-trip, wrong-password rejection, tamper rejection, and
at-rest secrecy with **zero Tauri**.

**Then** register the module: `lib.rs` gets `mod vault;` and
`.manage(vault::VaultState::default())` in the builder chain (next to the other `.manage(...)`
calls). No dispatch wiring yet — that's Task 3.

**Acceptance:** all five Rust tests pass via `cargo test`; `cargo check` clean.

---

### Task 2 — Vault file I/O + CRUD/search over the live state (Rust, TDD)

Now add the AppHandle-touching layer (persist/load via `jsonstore`) and the in-memory CRUD,
keeping the mutation logic pure where possible so it stays testable.

**Write first** (extend `vault.rs` tests — pure helpers only, no AppHandle):

- `add_assigns_uuid_and_updated_at` — `add_record(&mut recs, input, now)` pushes a `Cred` with
  a fresh uuid + `updated_at == now`, returns it.
- `update_replaces_fields_and_bumps_updated_at` — updating an existing uuid merges the partial
  and sets a newer `updated_at`.
- `remove_drops_the_record` — removing by uuid leaves it absent.
- `search_matches_site_and_username_case_insensitively` — `search(&recs, "exam")` matches a
  record whose site is `https://Example.com`; an empty query returns all.

```rust
fn now_ms() -> i64 { crate::jsonstore::now_ms() }

fn add_record(recs: &mut Vec<Cred>, site: &str, username: &str, password: &str, notes: &str, now: i64) -> Cred {
    let c = Cred {
        uuid: uuid::Uuid::new_v4().to_string(),
        updated_at: now,
        site: site.to_string(), username: username.to_string(),
        password: password.to_string(), notes: notes.to_string(),
    };
    recs.push(c.clone());
    c
}

fn update_record(recs: &mut [Cred], uuid: &str, site: Option<&str>, username: Option<&str>,
                  password: Option<&str>, notes: Option<&str>, now: i64) -> bool {
    if let Some(c) = recs.iter_mut().find(|c| c.uuid == uuid) {
        if let Some(v) = site { c.site = v.to_string(); }
        if let Some(v) = username { c.username = v.to_string(); }
        if let Some(v) = password { c.password = v.to_string(); }
        if let Some(v) = notes { c.notes = v.to_string(); }
        c.updated_at = now;
        true
    } else { false }
}

fn search<'a>(recs: &'a [Cred], q: &str) -> Vec<&'a Cred> {
    let needle = q.trim().to_lowercase();
    recs.iter()
        .filter(|c| needle.is_empty()
            || c.site.to_lowercase().contains(&needle)
            || c.username.to_lowercase().contains(&needle))
        .collect()
}
```

**Then** the AppHandle persistence wrappers (untested directly — they're thin I/O over the
already-tested pure helpers + the already-tested `jsonstore`; same convention as `places.rs`
keeping the pure logic in `jsonstore`):

```rust
use tauri::{AppHandle, Manager};

fn vault_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("vault.json"))
}

/// True iff a vault file exists (the only thing knowable while locked).
fn vault_exists(app: &AppHandle) -> bool {
    vault_path(app).map(|p| p.exists()).unwrap_or(false)
}

/// Read + parse the at-rest file (with .bak recovery), or None if absent/corrupt.
fn read_file(app: &AppHandle) -> Option<Value> {
    vault_path(app)
        .and_then(|p| crate::jsonstore::read_with_backup(&p))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

/// Re-seal the current in-memory state to disk (called after every mutation while unlocked).
fn persist(app: &AppHandle, g: &Inner) -> Result<(), String> {
    let vk = g.key.as_ref().ok_or("vault is locked")?;
    let verifier = seal_verifier(vk)?;
    let mut records = Vec::with_capacity(g.records.len());
    for c in &g.records { records.push(seal_record(vk, c)?); }
    let file = file_json(&g.salt, verifier, &records);
    let p = vault_path(app).ok_or("no app data dir")?;
    let txt = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    crate::jsonstore::write_atomic(&p, txt.as_bytes()).map_err(|e| e.to_string())
}
```

**Acceptance:** the four new pure tests pass; `cargo check` clean. (The persist/read wrappers
ship now but are exercised by Task 3's dispatch + the live autopilot in Task 7.)

---

### Task 3 — `vault::dispatch` + IPC contract (Rust + shared/types.ts, three places)

Wire the `vault.*` channels. **PLACE 1 — `shared/types.ts`:** add to the `IPC` const, the
payload interfaces, and `AegisApi`:

```ts
// in IPC:
  // password vault (Phase A — manage only, NO autofill)
  vaultGetState: 'vault.getState',
  vaultCreate: 'vault.create',
  vaultUnlock: 'vault.unlock',
  vaultLock: 'vault.lock',
  vaultList: 'vault.list',
  vaultAdd: 'vault.add',
  vaultUpdate: 'vault.update',
  vaultRemove: 'vault.remove',
  vaultSearch: 'vault.search',
  evtVaultState: 'vault.state',

// interfaces:
export interface VaultState {
  exists: boolean;   // a vault has been created
  unlocked: boolean; // currently unlocked (key in memory)
  count: number;     // number of stored credentials (0 while locked)
}
export interface VaultRecord {
  uuid: string;
  updatedAt: number;
  site: string;
  username: string;
  password: string;
  notes: string;
}
export interface VaultRecordInput {
  site: string; username: string; password: string; notes?: string;
}

// in AegisApi:
  vault: {
    getState(): Promise<VaultState>;
    create(masterPassword: string): Promise<VaultState>;
    unlock(masterPassword: string): Promise<VaultState>;
    lock(): Promise<VaultState>;
    list(): Promise<VaultRecord[]>;
    add(input: VaultRecordInput): Promise<VaultRecord[]>;
    update(uuid: string, partial: Partial<VaultRecordInput>): Promise<VaultRecord[]>;
    remove(uuid: string): Promise<VaultRecord[]>;
    search(q: string): Promise<VaultRecord[]>;
    onState(cb: (s: VaultState) => void): () => void;
  };
```

**PLACE 2 — `vault.rs::dispatch` + the arm in `lib.rs::ipc()`.** Add
`if let Some(result) = vault::dispatch(&app, &channel, &payload) { return result; }` to `ipc()`
(next to the other dispatch arms). The dispatcher (mirrors `sync::dispatch` lock-guard style):

```rust
fn state_json(app: &AppHandle) -> Value {
    let g = app.state::<VaultState>();
    let g = g.0.lock().unwrap();
    json!({ "exists": g.created || vault_exists(app), "unlocked": g.key.is_some(), "count": g.records.len() })
}
fn emit_state(app: &AppHandle) { crate::emit_event(app, "vault.state", state_json(app)); }

/// Render the live (unlocked) records to the renderer shape. Errors if locked.
fn live_records(g: &Inner) -> Result<Value, String> {
    g.key.as_ref().ok_or("vault is locked")?;
    let arr: Vec<Value> = g.records.iter().map(|c| json!({
        "uuid": c.uuid, "updatedAt": c.updated_at, "site": c.site,
        "username": c.username, "password": c.password, "notes": c.notes,
    })).collect();
    Ok(json!(arr))
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let pw = || payload.get("masterPassword").and_then(Value::as_str).unwrap_or("").to_string();
    match channel {
        "vault.getState" => Some(Ok(state_json(app))),

        "vault.create" => {
            if vault_exists(app) { return Some(Err("a vault already exists".into())); }
            let password = pw();
            if password.is_empty() { return Some(Err("master password required".into())); }
            let mut salt = [0u8; 16];
            if getrandom::getrandom(&mut salt).is_err() { return Some(Err("rng failed".into())); }
            let vk = match derive_vault_key(&password, &salt) { Ok(k) => k, Err(e) => return Some(Err(e)) };
            {
                let st = app.state::<VaultState>();
                let mut g = st.0.lock().unwrap();
                g.salt = salt.to_vec();
                g.key = Some(vk);
                g.records = Vec::new();
                g.created = true;
                if let Err(e) = persist(app, &g) { return Some(Err(e)); }
            }
            emit_state(app);
            Some(Ok(state_json(app)))
        }

        "vault.unlock" => {
            let Some(file) = read_file(app) else { return Some(Err("no vault to unlock".into())); };
            let salt = match file.get("salt").and_then(Value::as_str).and_then(unhex) {
                Some(s) => s, None => return Some(Err("vault file: bad salt".into())),
            };
            let vk = match derive_vault_key(&pw(), &salt) { Ok(k) => k, Err(e) => return Some(Err(e)) };
            if let Some(v) = file.get("verifier") {
                if let Err(e) = check_verifier(&vk, v) { return Some(Err(e)); }
            } else { return Some(Err("vault file: no verifier".into())); }
            // Open every record (skip+log any single undecryptable one, never abort).
            let mut records = Vec::new();
            if let Some(arr) = file.get("records").and_then(Value::as_array) {
                for w in arr {
                    match open_record(&vk, w) {
                        Ok(c) => records.push(c),
                        Err(e) => eprintln!("[aegis-vault] skip undecryptable record: {e}"),
                    }
                }
            }
            {
                let st = app.state::<VaultState>();
                let mut g = st.0.lock().unwrap();
                g.salt = salt; g.key = Some(vk); g.records = records; g.created = true;
            }
            emit_state(app);
            Some(Ok(state_json(app)))
        }

        "vault.lock" => {
            {
                let st = app.state::<VaultState>();
                let mut g = st.0.lock().unwrap();
                g.key = None;             // Zeroizing<[u8;32]> wiped on drop
                g.records.clear();        // each Cred is ZeroizeOnDrop
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
            let get = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
            let st = app.state::<VaultState>();
            let mut g = st.0.lock().unwrap();
            if g.key.is_none() { return Some(Err("vault is locked".into())); }
            add_record(&mut g.records, get("site"), get("username"), get("password"), get("notes"), now_ms());
            if let Err(e) = persist(app, &g) { return Some(Err(e)); }
            let out = live_records(&g);
            drop(g); emit_state(app);
            Some(out)
        }

        "vault.update" => {
            let uuid = payload.get("uuid").and_then(Value::as_str).unwrap_or("").to_string();
            let p = payload.get("partial").cloned().unwrap_or_else(|| json!({}));
            let opt = |k: &str| p.get(k).and_then(Value::as_str);
            let st = app.state::<VaultState>();
            let mut g = st.0.lock().unwrap();
            if g.key.is_none() { return Some(Err("vault is locked".into())); }
            update_record(&mut g.records, &uuid, opt("site"), opt("username"), opt("password"), opt("notes"), now_ms());
            if let Err(e) = persist(app, &g) { return Some(Err(e)); }
            let out = live_records(&g);
            drop(g); emit_state(app);
            Some(out)
        }

        "vault.remove" => {
            let uuid = payload.get("uuid").and_then(Value::as_str).unwrap_or("").to_string();
            let st = app.state::<VaultState>();
            let mut g = st.0.lock().unwrap();
            if g.key.is_none() { return Some(Err("vault is locked".into())); }
            g.records.retain(|c| c.uuid != uuid);
            if let Err(e) = persist(app, &g) { return Some(Err(e)); }
            let out = live_records(&g);
            drop(g); emit_state(app);
            Some(out)
        }

        "vault.search" => {
            let q = payload.get("q").and_then(Value::as_str).unwrap_or("");
            let st = app.state::<VaultState>();
            let g = st.0.lock().unwrap();
            if g.key.is_none() { return Some(Err("vault is locked".into())); }
            let arr: Vec<Value> = search(&g.records, q).into_iter().map(|c| json!({
                "uuid": c.uuid, "updatedAt": c.updated_at, "site": c.site,
                "username": c.username, "password": c.password, "notes": c.notes,
            })).collect();
            Some(Ok(json!(arr)))
        }

        _ => None,
    }
}
```

> Note the `getrandom`/`uuid` imports are already crate deps (used by `crypto.rs`/`jsonstore.rs`).
> `vault.*` does **not** call `sync::nudge` — the vault is local-only in Phase A, never synced.

**PLACE 3 — `src/lib/ipcClient.ts`:** add the `vault` namespace:

```ts
  vault: {
    getState: () => call<VaultState>(IPC.vaultGetState),
    create: (masterPassword) => call<VaultState>(IPC.vaultCreate, { masterPassword }),
    unlock: (masterPassword) => call<VaultState>(IPC.vaultUnlock, { masterPassword }),
    lock: () => call<VaultState>(IPC.vaultLock),
    list: () => call<VaultRecord[]>(IPC.vaultList),
    add: (input) => call<VaultRecord[]>(IPC.vaultAdd, { input }),
    update: (uuid, partial) => call<VaultRecord[]>(IPC.vaultUpdate, { uuid, partial }),
    remove: (uuid) => call<VaultRecord[]>(IPC.vaultRemove, { uuid }),
    search: (q) => call<VaultRecord[]>(IPC.vaultSearch, { q }),
    onState: (cb) => on<VaultState>(IPC.evtVaultState, cb),
  },
```

(Import `VaultState`, `VaultRecord`, `VaultRecordInput` from `../../shared/types`.) This is a
chrome-only feature, so there is **no `androidBridge()` branch** — `call(...)` reaches the
shared Rust core on every platform, including Android (the vault never touches the native
content WebView).

**Acceptance:** `npm test` green (`shared/types.test.ts` still passes — every `IPC` value is
dot-separated + unique); `cargo check`/`cargo test` clean. The `types.ts`↔dispatcher↔ipcClient
trio is in sync.

---

### Task 4 — `useVault` hook (React, TDD)

**Write first** (`src/hooks/useVault.test.ts`, mocking `aegis.vault`): assert mount fetches
`getState`, subscribes `onState`, and unsubscribes on unmount; `create`/`unlock` set
`unlocked`; `lock` clears it; `add`/`update`/`remove`/`search` proxy to the API and surface the
returned list. Mirror `useSync.test.ts`'s structure.

**Then** (`src/hooks/useVault.ts`, mirror `useSync.ts`):

```ts
import { useCallback, useEffect, useState } from 'react';
import type { VaultState, VaultRecord, VaultRecordInput } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const EMPTY: VaultState = { exists: false, unlocked: false, count: 0 };

export interface UseVault {
  state: VaultState;
  create(masterPassword: string): Promise<void>;
  unlock(masterPassword: string): Promise<void>;
  lock(): Promise<void>;
  list(): Promise<VaultRecord[]>;
  add(input: VaultRecordInput): Promise<VaultRecord[]>;
  update(uuid: string, partial: Partial<VaultRecordInput>): Promise<VaultRecord[]>;
  remove(uuid: string): Promise<VaultRecord[]>;
  search(q: string): Promise<VaultRecord[]>;
}

export function useVault(): UseVault {
  const [state, setState] = useState<VaultState>(EMPTY);
  useEffect(() => {
    let active = true;
    void aegis.vault.getState().then((s) => {
      if (active) setState(s);
    });
    const off = aegis.vault.onState((s) => setState(s));
    return () => {
      active = false;
      off();
    };
  }, []);
  const create = useCallback(async (pw: string) => {
    setState(await aegis.vault.create(pw));
  }, []);
  const unlock = useCallback(async (pw: string) => {
    setState(await aegis.vault.unlock(pw));
  }, []);
  const lock = useCallback(async () => {
    setState(await aegis.vault.lock());
  }, []);
  const list = useCallback(() => aegis.vault.list(), []);
  const add = useCallback((i: VaultRecordInput) => aegis.vault.add(i), []);
  const update = useCallback(
    (u: string, p: Partial<VaultRecordInput>) => aegis.vault.update(u, p),
    [],
  );
  const remove = useCallback((u: string) => aegis.vault.remove(u), []);
  const search = useCallback((q: string) => aegis.vault.search(q), []);
  return { state, create, unlock, lock, list, add, update, remove, search };
}
```

**Acceptance:** `useVault.test.ts` green.

---

### Task 5 — `VaultSettingsTab` component + Settings tab registration (React, TDD)

**Write first** (`src/components/VaultSettingsTab.test.tsx`): three flows over a mocked
`UseVault` —

1. **No vault yet** (`exists:false`): renders a "Create vault" form; entering a master password
   - confirm and submitting calls `create`.
2. **Locked** (`exists:true, unlocked:false`): renders an unlock form; submitting calls
   `unlock`; a wrong-password rejection surfaces the error.
3. **Unlocked** (`unlocked:true`): renders the list + add form + a "Lock" button; adding calls
   `add` and re-lists; the search box filters via `search`; "Lock" calls `lock`; a per-row
   "Copy password" / "Copy username" button writes to `navigator.clipboard` (mock it). Assert
   passwords are masked by default (a "Show" toggle reveals).

**Then** (`src/components/VaultSettingsTab.tsx`, mirror `SyncSettingsTab.tsx`'s three-state
structure + the `run`/`busy`/`error` helper). Key requirements:

- Master-password create requires a confirm field that must match (client-side guard before
  calling `create`).
- The list shows site + username; the password is **masked** (`••••••••`) with a per-row Show
  toggle and Copy buttons (`navigator.clipboard.writeText`). All controls carry `aria-label`s
  so the autopilot/interaction tour can target them by role+label (the `byRole` helper).
- A prominent note in the UI: _"Stored encrypted on this device. Aegis does not autofill — copy
  the value when you need it."_ (matches the locked no-autofill decision; sets user expectation).
- Add/edit form fields: Site (URL), Username, Password, Notes. Edit reuses the form pre-filled.

**Register the tab** in `SettingsModal.tsx`: add `'vault'` to the `SettingsTab` union, to
`TAB_LABELS` (`vault: 'Passwords'`), to `TAB_ORDER` (place it after `'security'`, before
`'sync'`), to `SettingsModalProps`, to the destructured props, and to the `panels` record +
`tabIds`/`useId` block (one new `vaultTabId = useId()` line + the map entry), following every
other tab exactly.

**Acceptance:** `VaultSettingsTab.test.tsx` + existing `SettingsModal` tests green; the
`SettingsTab` union exhaustiveness compiles (all `Record<SettingsTab, …>` maps include `vault`).

---

### Task 6 — Wire it into `App.tsx` (desktop + mobile) + tab-label reach

**Edit `src/App.tsx`:** `const vault = useVault();` near `const sync = useSync();`; import
`VaultSettingsTab`; pass `vault={<VaultSettingsTab vault={vault} />}` to `<SettingsModal>` (the
new prop). For mobile parity, ensure the Settings modal (which `MobileApp` reuses) renders the
same tab — the tab is part of `SettingsModal`, which both shells use, so no separate mobile
component is needed; just confirm `MobileApp` passes the `vault` prop too (it constructs the
same `<SettingsModal>` — wire the prop there as well if it builds the panel set independently).

**Edit `src/autopilot/reach.ts`:** add `vault: 'Passwords'` to the `SETTINGS_TAB_LABEL` map so
the autopilot can click the new tab (without it, `reachScreen('settings:vault')` falls back to
the raw id `'vault'` and the click misses).

**Acceptance:** `npm test` green (the desktop + mobile vitest tours now walk `settings:vault`
without crashing); `tsc --noEmit` on the touched files clean.

---

### Task 7 — Autopilot coverage: catalog `verify` round-trip + interactions (drift-guarded)

**`src/autopilot/catalog.ts`** — add a vault entry whose `channels` lists **every**
`IPC.vault*` constant (the IPC drift guard requires it) and a live `verify` round-trip on the
disposable profile:

```ts
  // vault — Phase A password manager (NO autofill). The live verify creates/unlocks a throwaway
  // vault on the disposable profile, round-trips a credential, then locks. Safe to mutate.
  { id: 'vault.crud', domain: 'vault', title: 'Vault create/unlock/add/list/search/update/remove/lock',
    channels: [IPC.vaultGetState, IPC.vaultCreate, IPC.vaultUnlock, IPC.vaultLock,
      IPC.vaultList, IPC.vaultAdd, IPC.vaultUpdate, IPC.vaultRemove, IPC.vaultSearch],
    exercise: async (a) => { assertObject(await a.vault.getState()); },
    verify: async (a) => {
      const pw = 'ap-vault-pass-9271';
      let st = await a.vault.getState();
      // Create only if absent (the disposable profile starts empty); else unlock.
      if (!st.exists) st = await a.vault.create(pw);
      else if (!st.unlocked) st = await a.vault.unlock(pw);
      if (!st.unlocked) throw new Error('vault: not unlocked after create/unlock');
      const probeSite = 'https://ap-vault.test/';
      const added = await a.vault.add({ site: probeSite, username: 'ap-user', password: 'ap-secret', notes: 'n' });
      const rec = added.find((r) => r.site === probeSite);
      if (!rec) throw new Error('add: probe credential not in list');
      if (rec.password !== 'ap-secret') throw new Error('add: password not round-tripped');
      // search finds it by site substring
      const found = await a.vault.search('ap-vault');
      if (!found.some((r) => r.uuid === rec.uuid)) throw new Error('search: probe not found');
      // update the username, assert it changed
      const updated = await a.vault.update(rec.uuid, { username: 'ap-user-2' });
      if (updated.find((r) => r.uuid === rec.uuid)?.username !== 'ap-user-2') throw new Error('update: username not changed');
      // remove it
      const afterRemove = await a.vault.remove(rec.uuid);
      if (afterRemove.some((r) => r.uuid === rec.uuid)) throw new Error('remove: probe survived');
      // lock zeroizes — list must now error (locked) and getState.unlocked=false
      await a.vault.lock();
      const locked = await a.vault.getState();
      if (locked.unlocked) throw new Error('lock: still unlocked');
      let listErrored = false;
      try { await a.vault.list(); } catch { listErrored = true; }
      if (!listErrored) throw new Error('lock: list did not error while locked');
      return 'vault create→unlock→add→search→update→remove→lock(+locked-list-rejected) ok';
    } },
```

Add the unlock/create/lock/etc. channels that `exercise` does NOT call live to
`UNTESTED_CHANNELS` **only if** the drift-guard requires it — but since `verify` covers them
and the guard only requires each `UNTESTED_CHANNELS` member to appear in some entry's
`channels` (it does), the cleanest path is: list all nine in `channels`, call only the
read-only `getState` in `exercise`, and add the mutating ones
(`vaultCreate/Unlock/Lock/Add/Update/Remove`) to `UNTESTED_CHANNELS` with a comment that they
are live-`verify`-only (mirrors how `syncEnableNew` etc. are listed). `vaultList`/`vaultSearch`
are read-shaped but locked-gated, so also list them there with the same rationale.

**`src/autopilot/interactions/vault.ts`** (NEW) — `VAULT_INTERACTIONS: InteractionSpec[]`, each
`screen: 'settings:vault'`, `layers: ['vitest']` (the live tour drives only IPC + screens; the
DOM gestures live in vitest), covering: create-form submit, unlock submit, add-credential
submit, search-box typing filters the list, Show-password toggle, Copy buttons, Lock button.
Each `run(ctx)` uses `ctx.byRole`/`ctx.click`/`fireInputChange` against the mocked `aegis`;
each `assert(ctx)` checks `ctx.calls.called(IPC.vaultAdd)` etc. Register the new control ids in
**`interactions/controls.ts`** (`vault.create.submit`, `vault.unlock.submit`, `vault.add.submit`,
`vault.search.input`, `vault.row.showPassword`, `vault.row.copyPassword`, `vault.lock`) and
spread `...VAULT_INTERACTIONS` into **`interactions/index.ts`**.

**Acceptance:** `npm test` green — specifically `coverage.test.ts` (every `IPC.vault*` is in a
catalog entry's `channels`; every `UNTESTED_CHANNELS` member appears in some `channels`),
`interactions.coverage.test.ts` (every new control id has ≥1 spec; ids unique), and the desktop

- mobile interaction tours pass the new specs.

---

### Task 8 — Live + parity verification (Linux runtime; Android/Windows/macOS parity)

Per §6.3/§6.4. This task is verification, not new code (beyond any fixes the runs surface).

- **Linux live (required):** run `bash scripts/autopilot/run-autopilot.sh`. Confirm `RESULT: …
0 failed` (the new `vault.crud` `verify` round-trip passes against the real Rust core on the
  disposable profile), the `settings:vault` screen screenshots, and **`ad-block blocking
(trace): PASS`** is unchanged (the vault touches no nav/content path, so the trace must be
  untouched). Inspect the report's vault step detail string.
- **At-rest evidence (manual, once):** after a live add, open `…/app_data/vault.json` and
  confirm it contains only `salt`/`verifier`/`nonce`/`ct` hex — no plaintext site/username/
  password/notes. (The Task 1 `record_at_rest_has_no_plaintext` test already proves this
  programmatically; this is a belt-and-suspenders human check.)
- **Android parity:** the vault is the same `app_lib` Rust core + the same `SettingsModal`
  React surface reached from `MobileMenuSheet` → Settings → Passwords. Build
  (`JAVA_HOME=…/jbr npm run android:build`) and confirm it compiles; device-verify
  create→unlock→add→lock through the mobile Settings if a device is available. (No JNI/native
  vault code exists to break — it's chrome + shared Rust only.)
- **Windows/macOS parity:** covered by the existing CI build (`tauri-build-check.yml`) — the
  vault adds no platform-gated Rust, so a green desktop-trio build is the parity bar (GUI
  runtime stays CI-built + owner/sub-project-I as per §4). No `#[cfg(...)]` branches were added.

**Acceptance:** Linux autopilot `0 failed` + ad-block trace PASS; Android build green; CI
desktop-trio green; the at-rest file inspection shows ciphertext only.

---

## Self-Review

Run this checklist against the merged result before declaring K done.

**At-rest encryption confirmed.**

- Every credential value (`site`/`username`/`password`/`notes`) reaches disk only inside a
  record's sealed `ct` (XChaCha20-Poly1305 via `crypto::seal`), never as a JSON field. The
  file holds `{v, kdf, salt, verifier{nonce,ct}, records[{uuid, updatedAt, nonce, ct}]}` — the
  only cleartext is the non-secret KDF salt and the routing fields (uuid/updatedAt) that the
  AEAD AAD binds. ✅ proven by `record_at_rest_has_no_plaintext` (Task 1) + the manual file
  inspection (Task 8).
- The master password is never stored — only the Argon2id `salt` (cleartext, non-secret) is.
  Wrong-password detection is via AEAD authentication of the `verifier`, so no password hash to
  exfiltrate. ✅ `wrong_password_fails_unlock`.
- Tampering or splicing a record fails authentication (the AAD binds `ns|uuid|updatedAt`). ✅
  `tampered_ciphertext_fails_open`, inherited from `crypto.rs`'s `open_fails_on_aad_mismatch`.
- Reused crypto, not reinvented: `crypto::seal`/`crypto::open` (XChaCha20-Poly1305 + HKDF
  primitives) and the Argon2id derivation pattern from `sync_keystore::derive_kek`. No new
  cipher/KDF code. ✅

**No plaintext path.**

- Plaintext credentials exist in exactly two places, both in-process and bounded: (1) in
  `Inner.records: Vec<Cred>` while unlocked, and (2) transiently in the `serde_json` buffer
  during seal/open (wrapped in `Zeroizing`). Neither is written to disk, logged, or emitted.
  The `vault.state` event carries only `{exists, unlocked, count}` — no credential data. ✅
- The renderer receives plaintext only in the direct response to `list`/`add`/`update`/
  `remove`/`search` while unlocked — i.e. only when the chrome UI explicitly asked, over the
  in-process IPC, never to the content webview. ✅
- **NO autofill / page→core bridge (locked decision).** No document-start injection, no
  `window.AegisVault`, no nav-policy/`shouldInterceptRequest` hook, no clipboard auto-fill from
  a page. The content webview cannot reach the vault. Confirm by grep: no `vault` reference in
  `adblock_inject.rs`, `nav.rs`, `webrtc_shim.rs`, `MainActivity.kt`, or any
  document-start/injection path. ✅ (Decision §2.1.)

**Locked state safe.**

- Resting state is **locked**: `key = None`, `records` empty. The only knowable fact while
  locked is _whether a vault exists_. ✅
- `vault.lock` sets `key = None` (the `Zeroizing<[u8;32]>` is wiped on drop) and clears
  `records` (each `Cred` is `Zeroize + ZeroizeOnDrop`, wiped on drop). ✅
  `lock_zeroizes_key_and_clears_records`.
- Every read/mutate channel (`list`/`add`/`update`/`remove`/`search`) returns
  `Err("vault is locked")` when `key` is `None`, so no credential can be pulled without an
  unlock. ✅ proven by the live `verify`'s locked-list-rejected assertion (Task 7).
- No auto-unlock at boot: unlike sync (which auto-unlocks from the keychain), the vault has a
  **separate master password** and starts **locked every launch** — it is never persisted
  unwrapped and never read from a keychain in Phase A. ✅

**Parity + drift guards.**

- Pure Rust core + chrome React UI, **zero platform-gated code** → identical on Linux/Win/mac/
  Android. Linux live-verified; Android/CI build-verified. ✅ §6.4.
- IPC in all three places (`types.ts`, `vault::dispatch` in `lib.rs`, `ipcClient.ts`); event
  emitted only via `emit_event` (`.`→`:`). ✅ §6.1.
- Autopilot updated in the same commit: `catalog.ts` (channels + `verify`), the auto-generated
  `settings:vault` screen + `reach.ts` label, `interactions/vault.ts` + `controls.ts` ids. All
  drift guards (`coverage.test.ts`, `interactions.coverage.test.ts`,
  `compositor.test.tsx` — the vault tab opens inside the existing `settings` surface, already a
  registered compositor surface, so it inherits the content-lowering) green. ✅ §6.2.

**Living docs.** Update `src-tauri/CLAUDE.md` (add `vault.rs` to the module map), `shared/
CLAUDE.md` (the `vault.*` channels + `VaultState`/`VaultRecord` interfaces), and `src/CLAUDE.md`
(the `useVault` hook + `VaultSettingsTab`) **in the same commit** as the code (CLAUDE.md is a
living doc, enforced by repo convention).
