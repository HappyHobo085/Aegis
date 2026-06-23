# Rust Core Unit Tests Implementation Plan (Sub-project C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add meaningful `#[test]` coverage to the Aegis Rust core modules that currently have **zero** tests — `adblock`, `safety`, `permissions`, `data`, `history`, `places`, `downloads`, `tabs`, `subs` — so `cargo test` exercises their real logic (state machines, store mutations, the export→import roundtrip) and so sub-project A's CI `cargo test` gate guards real behavior rather than only the already-tested pure helpers (`jsonstore`, `tab_registry`, `crypto`).

**Architecture:** The repo's existing Rust tests (`jsonstore.rs`, `tab_registry.rs`, `crypto.rs`, `settings.rs`, `update.rs`, `sync_stores.rs`, `adblock_engine.rs`) test only **AppHandle-free** functions. The nine target modules are different: their real logic lives in `pub fn dispatch(app: &AppHandle, channel, payload)` functions whose effects flow through `jsonstore`, which resolves paths from `app.path().app_data_dir()`. To test that real logic we introduce **one** crate-wide `#[cfg(test)] mod test_support` that builds a `tauri::test::mock_app()` whose `app_data_dir()` / `app_cache_dir()` are redirected into a fresh temp dir via the XDG env vars (`dirs` honors `$XDG_DATA_HOME` / `$XDG_CACHE_HOME` on Linux — verified in `dirs-6.0.0/src/lin.rs`). Because env vars are process-global and cargo runs tests multithreaded, `test_support` serializes every AppHandle test behind one `static Mutex` and `.manage()`s the state objects the dispatchers touch (`AdblockState`, `SafetyState`, `SyncState`). Pure helpers (`subs::list_id_from_url`, `places` internals via dispatch, etc.) and the `tabs.rs` Tauri-free session logic are tested directly. Each module gets a `#[cfg(test)] mod tests` block; one new `[dev-dependencies]` line enables `tauri`'s `test` feature.

**Tech Stack:** Rust, `cargo test`. New test-only dependency: `tauri` built with `features = ["test"]` (the `mock_app` / `mock_builder` / `mock_context` API, gated behind the crate's `test = []` feature — verified present in `tauri-2.11.2/src/test/mod.rs`). No `serial_test` crate is added — serialization uses a hand-rolled `static Mutex` in `test_support`.

## Global Constraints

(From master spec §6, plus the verification reality this sub-project lives under.)

- **No source behavior changes.** This sub-project only adds `#[cfg(test)]` blocks, one `test_support` module, and dev-only `Cargo.toml` wiring. The single exception is **Task 11**, which fixes a real bug found while writing a test — and it fixes it test-first, with the fix scoped to the buggy function only.
- **One IPC chokepoint is untouched.** Tests call each module's `dispatch(app, channel, payload)` directly (the same entry the `lib.rs` `ipc()` dispatcher calls) — they do **not** add channels or a side door. Channel-name strings in tests must match `shared/types.ts` (`IPC` const) exactly.
- **Tests must not touch real user data.** Every AppHandle test redirects `$XDG_DATA_HOME` / `$XDG_CACHE_HOME` / `$XDG_CONFIG_HOME` to a fresh per-test temp dir **before** the mock app is built, and runs under the `test_support` serialization lock so two tests never share the env. A test that writes to `~/.local/share` is a bug in the test.
- **Linux-host reality.** `cargo test` runs on this Linux box. Some dispatchers (`subs.*`, `adblock.setEnabled`/`*Allowlist`, `data.import`) call `crate::adblock_refresh::refresh` → on Linux `crate::install_adblock`, which `std::thread::spawn`s WebKit content-filter conversion. With a mock app there are **no content webviews** (`app.webviews()` is empty → `apply_filters` no-ops) and the spawned thread is detached, so it can't panic the test; any cache writes it makes land in the redirected `$XDG_CACHE_HOME`. Tests assert the **persisted store + returned value**, never the detached refresh.
- **`SyncState` must be managed or `nudge` panics.** `places::persist`, `adblock` allowlist mutations, and `data.import` reach `crate::sync::nudge`, which calls `app.state::<SyncState>()` (panics if unmanaged). `test_support` always manages `SyncState::default()` (which has `enabled=false`, so `nudge` returns early before spawning anything). This is observed in `sync.rs:390` + `sync.rs:62`.
- **`cargo test` must stay green** and run on a clean checkout (sub-project A wires it into CI).
- **Parity note.** These are pure-Rust unit tests of cross-platform store/dispatch logic; they run identically on every platform's `cargo test`. No per-OS test divergence is introduced (the few `#[cfg(target_os = "linux")]`-only paths — e.g. `permissions::install_handler_label`, `safety::raise`'s webview navigation — are not unit-tested here; they need a real webview and are covered by the live autopilot).

---

## File Structure

**Create:**
- `src-tauri/src/test_support.rs` — `#[cfg(test)]` crate-wide helper: `with_tmp_app(|app| { … })` (serialized, XDG-redirected mock app with `AdblockState`/`SafetyState`/`SyncState` managed). Declared in `lib.rs` as `#[cfg(test)] mod test_support;`.

**Modify (add a `#[cfg(test)] mod tests` block at the end of each; add nothing else):**
- `src-tauri/src/tabs.rs` — session-persistence helpers (`load_session`/`save_session` are AppHandle-bound; the registry is already tested in `tab_registry.rs`, so here we cover the `tabs.json` (de)serialization through the app + the `dispatch` list/create/activate/close surface).
- `src-tauri/src/history.rs`
- `src-tauri/src/places.rs`
- `src-tauri/src/downloads.rs`
- `src-tauri/src/permissions.rs`
- `src-tauri/src/safety.rs`
- `src-tauri/src/adblock.rs`
- `src-tauri/src/subs.rs`
- `src-tauri/src/data.rs`

**Modify (build wiring + module decl):**
- `src-tauri/Cargo.toml` — add `[dev-dependencies] tauri = { version = "2.11.2", features = ["test"] }`.
- `src-tauri/src/lib.rs` — add `#[cfg(test)] mod test_support;` near the other `mod` lines (~line 64).

---

## Task 1: Enable the `tauri/test` feature + the shared `test_support` harness

This is the enabler every later task depends on. It establishes the **one** pattern for an AppHandle-backed unit test in this repo.

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/test_support.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces produced:**
- `test_support::with_tmp_app<T>(f: impl FnOnce(&tauri::AppHandle) -> T) -> T` — runs `f` with a freshly-built `mock_app()` whose data/cache/config dirs are an empty temp dir, with `AdblockState`/`SafetyState`/`SyncState` managed, under a global serialization lock. Cleans the temp dir afterward.

- [ ] **Step 1: Add the dev-dependency**

In `src-tauri/Cargo.toml`, after the existing `[target.…]` dependency blocks (i.e. as a new top-level section), add:

```toml
[dev-dependencies]
# Enables tauri::test::mock_app / mock_builder / mock_context (the crate's `test`
# feature) so AppHandle-backed dispatchers can be unit-tested. Dev-only: release
# builds never pull the test runtime. Version must match the normal `tauri` dep.
tauri = { version = "2.11.2", features = ["test"] }
```

- [ ] **Step 2: Declare the module in `lib.rs`**

Near the other `mod` declarations (after `mod tabs;` / before `mod update;`, ~line 78), add:

```rust
#[cfg(test)]
mod test_support;
```

- [ ] **Step 3: Write `test_support.rs`**

```rust
// src-tauri/src/test_support.rs
//! Crate-wide test harness for AppHandle-backed unit tests.
//!
//! The data stores resolve their paths from `app.path().app_data_dir()`, which on
//! Linux comes from `$XDG_DATA_HOME` (and the cache dir from `$XDG_CACHE_HOME`) —
//! see `dirs`/`dirs-sys`. A `tauri::test::mock_app()` has an EMPTY bundle identifier,
//! so `app_data_dir()` resolves to `$XDG_DATA_HOME` directly. We point those env
//! vars at a fresh temp dir per test so store IO never touches real user data.
//!
//! Env vars are process-global and cargo runs tests on many threads, so EVERY
//! AppHandle test must hold `LOCK` for its whole body — `with_tmp_app` does this.
#![cfg(test)]

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::test::{mock_builder, mock_context, noop_assets};
use tauri::{AppHandle, Manager};

/// Serializes all AppHandle tests: they share process env vars + process-global
/// statics (e.g. `sync_identity::NODE_ID`, the adblock counters), so they must not
/// run concurrently. A poisoned lock from a panicking test is recovered (we only
/// guard the env, not invariants), so one failing test doesn't cascade-fail the rest.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

fn fresh_tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "aegis-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Run `f` with a mock `AppHandle` whose data/cache/config dirs are a fresh temp dir
/// and whose managed state matches what the dispatchers expect. Serialized + cleaned.
pub fn with_tmp_app<T>(f: impl FnOnce(&AppHandle) -> T) -> T {
    let _guard = lock();
    let tmp = fresh_tmp();
    // Must be set BEFORE the app is built — app_data_dir() reads them on each call,
    // but setting up front keeps every store under `tmp` for the whole test.
    std::env::set_var("XDG_DATA_HOME", &tmp);
    std::env::set_var("XDG_CACHE_HOME", &tmp);
    std::env::set_var("XDG_CONFIG_HOME", &tmp);

    let app = mock_builder()
        .manage(crate::adblock::AdblockState::default())
        .manage(crate::safety::SafetyState::default())
        .manage(crate::sync::SyncState::default())
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    let out = f(app.handle());

    drop(app);
    let _ = std::fs::remove_dir_all(&tmp);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tmp_app_data_dir_is_under_the_temp_dir() {
        with_tmp_app(|app| {
            let dir = app.path().app_data_dir().expect("data dir resolves");
            // The redirected XDG_DATA_HOME root (empty identifier ⇒ no subfolder).
            assert!(
                dir.starts_with(std::env::temp_dir()),
                "data dir {dir:?} must be under the OS temp dir, not real user data"
            );
        });
    }

    #[test]
    fn required_state_is_managed() {
        with_tmp_app(|app| {
            assert!(app.try_state::<crate::adblock::AdblockState>().is_some());
            assert!(app.try_state::<crate::safety::SafetyState>().is_some());
            assert!(app.try_state::<crate::sync::SyncState>().is_some());
        });
    }
}
```

- [ ] **Step 4: Run the harness tests, expecting a compile error first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml test_support::`
Expected on first run: **compile error or test failure**. The most likely first failure modes and their fixes:
- `cannot find function mock_builder in module tauri::test` → the `[dev-dependencies] tauri … features=["test"]` line (Step 1) is missing or the version mismatches; fix and re-run.
- `AdblockState`/`SafetyState`/`SyncState` not public → confirm they are `pub struct` in their modules (they are: `adblock.rs:71`, `safety.rs:32`, `sync.rs:46`); if a `Default` impl is missing, do **not** add one — `AdblockState`/`SafetyState`/`SyncState` already derive/impl `Default` (verified). 
- a panic building the mock app → read the panic; `mock_context(noop_assets())` needs no `tauri.conf.json`, so a panic means a managed-state constructor itself paniced (none should).

Iterate until both tests **PASS** against the real code.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/test_support.rs src-tauri/src/lib.rs
git commit -m "test(core): tauri/test dev-dep + serialized XDG-redirected mock-app harness"
```

---

## Task 2: `history.rs` — record / list / search / remove / clear

**Functions under test:** `history::record(app, url, title)`, `history::dispatch(app, "history.list"|"history.search"|"history.remove"|"history.clear", payload)`. Real behavior to pin: skips `about:`/`data:`/empty, de-dups consecutive same-URL visits, caps at `MAX_ENTRIES = 5000`, list returns **newest-first** with limit/offset, search is case-insensitive over url+title, remove deletes by id, clear empties the file (history is NOT tombstoned — it hard-deletes).

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/history.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    #[test]
    fn record_dedups_and_skips_non_web_schemes() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A");
            record(app, "https://a.test/", "A"); // consecutive dup → ignored
            record(app, "about:blank", "blank"); // non-web → ignored
            record(app, "data:text/html,x", "data"); // non-web → ignored
            record(app, "", ""); // empty → ignored
            record(app, "https://b.test/", "B");
            let items = jsonstore::load(app, "history");
            let urls: Vec<&str> = items
                .iter()
                .filter_map(|i| i.get("url").and_then(Value::as_str))
                .collect();
            assert_eq!(urls, vec!["https://a.test/", "https://b.test/"]);
        });
    }

    #[test]
    fn list_returns_newest_first_with_limit_and_offset() {
        with_tmp_app(|app| {
            for n in 0..5 {
                record(app, &format!("https://s{n}.test/"), &format!("S{n}"));
            }
            // newest-first, skip the newest (offset 1), take 2
            let v = dispatch(app, "history.list", &json!({ "opts": { "limit": 2, "offset": 1 } }))
                .unwrap()
                .unwrap();
            let urls: Vec<&str> = v
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|i| i.get("url").and_then(Value::as_str))
                .collect();
            assert_eq!(urls, vec!["https://s3.test/", "https://s2.test/"]);
        });
    }

    #[test]
    fn search_is_case_insensitive_over_url_and_title() {
        with_tmp_app(|app| {
            record(app, "https://rust-lang.org/", "The Rust Language");
            record(app, "https://example.com/", "Example");
            let by_title = dispatch(app, "history.search", &json!({ "q": "RUST" }))
                .unwrap()
                .unwrap();
            assert_eq!(by_title.as_array().unwrap().len(), 1);
            let by_url = dispatch(app, "history.search", &json!({ "q": "example.com" }))
                .unwrap()
                .unwrap();
            assert_eq!(by_url.as_array().unwrap().len(), 1);
            // empty query returns everything
            let all = dispatch(app, "history.search", &json!({ "q": "" })).unwrap().unwrap();
            assert_eq!(all.as_array().unwrap().len(), 2);
        });
    }

    #[test]
    fn remove_deletes_by_id_and_clear_empties() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A");
            record(app, "https://b.test/", "B");
            let items = jsonstore::load(app, "history");
            let id = items[0].get("id").and_then(Value::as_i64).unwrap();
            dispatch(app, "history.remove", &json!({ "id": id })).unwrap().unwrap();
            let after = jsonstore::load(app, "history");
            assert_eq!(after.len(), 1);
            assert_ne!(after[0].get("id").and_then(Value::as_i64), Some(id));
            dispatch(app, "history.clear", &json!({})).unwrap().unwrap();
            assert!(jsonstore::load(app, "history").is_empty());
        });
    }

    #[test]
    fn dispatch_ignores_unknown_channel() {
        with_tmp_app(|app| {
            assert!(dispatch(app, "history.nope", &json!({})).is_none());
        });
    }
}
```

- [ ] **Step 2: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml history::tests`
Expected: first run may fail to compile (e.g. `json!`/`Value` already imported at module top — they are, via `use serde_json::{json, Value};`). If the inner `use super::*;` double-imports, drop the redundant `use`. Iterate until all five **PASS**.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "test(history): record dedup/scheme-skip, newest-first list, search, remove/clear"
```

---

## Task 3: `places.rs` — favorites + saved CRUD, tombstones, tags

**Functions under test:** `places::dispatch(app, channel, payload)` for `favorites.{list,add,update,remove,reorder}` and `saved.{list,add,has,remove,update,renameTag,deleteTag,tagUnion}`. Real behavior to pin: every mutation returns the **live** array (tombstones excluded); `add` stamps an id/position; `remove` tombstones (record stays on disk but vanishes from `list`); `saved.add` dedups against live URLs and a removed URL can be re-added; `reorder` reassigns positions over live rows; `renameTag`/`deleteTag` rewrite tag arrays; `tagUnion` is the sorted, de-duped union of live tags.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/places.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    fn arr(v: Result<Value, String>) -> Vec<Value> {
        v.unwrap().as_array().cloned().unwrap()
    }

    #[test]
    fn favorites_add_list_returns_live_records_with_positions() {
        with_tmp_app(|app| {
            let r = dispatch(app, "favorites.add", &json!({ "input": { "name": "A", "url": "https://a.test/" } }))
                .unwrap();
            let live = arr(r);
            assert_eq!(live.len(), 1);
            assert_eq!(live[0].get("name").and_then(Value::as_str), Some("A"));
            assert_eq!(live[0].get("position").and_then(Value::as_i64), Some(0));
            // list reflects the same single live record.
            let listed = dispatch(app, "favorites.list", &json!({})).unwrap().unwrap();
            assert_eq!(listed.as_array().unwrap().len(), 1);
        });
    }

    #[test]
    fn favorites_remove_tombstones_so_list_hides_it_but_disk_keeps_it() {
        with_tmp_app(|app| {
            let live = arr(dispatch(app, "favorites.add", &json!({ "input": { "name": "A", "url": "https://a.test/" } })).unwrap());
            let id = live[0].get("id").and_then(Value::as_i64).unwrap();
            let after = arr(dispatch(app, "favorites.remove", &json!({ "id": id })).unwrap());
            assert!(after.is_empty(), "removed favorite is gone from the live list");
            // The tombstone is still on disk (full array via load_synced).
            let full = jsonstore::load_synced(app, "favorites");
            assert_eq!(full.len(), 1);
            assert!(jsonstore::is_deleted(&full[0]));
        });
    }

    #[test]
    fn favorites_update_merges_partial_fields() {
        with_tmp_app(|app| {
            let live = arr(dispatch(app, "favorites.add", &json!({ "input": { "name": "A", "url": "https://a.test/" } })).unwrap());
            let id = live[0].get("id").and_then(Value::as_i64).unwrap();
            let after = arr(dispatch(app, "favorites.update", &json!({ "id": id, "partial": { "name": "Renamed" } })).unwrap());
            assert_eq!(after[0].get("name").and_then(Value::as_str), Some("Renamed"));
            assert_eq!(after[0].get("url").and_then(Value::as_str), Some("https://a.test/"));
        });
    }

    #[test]
    fn favorites_reorder_reassigns_positions() {
        with_tmp_app(|app| {
            dispatch(app, "favorites.add", &json!({ "input": { "name": "A", "url": "https://a.test/" } })).unwrap();
            dispatch(app, "favorites.add", &json!({ "input": { "name": "B", "url": "https://b.test/" } })).unwrap();
            let live = jsonstore::live(jsonstore::load_synced(app, "favorites"));
            let id_a = live.iter().find(|i| i.get("name").and_then(Value::as_str) == Some("A")).unwrap().get("id").and_then(Value::as_i64).unwrap();
            let id_b = live.iter().find(|i| i.get("name").and_then(Value::as_str) == Some("B")).unwrap().get("id").and_then(Value::as_i64).unwrap();
            let after = arr(dispatch(app, "favorites.reorder", &json!({ "ids": [id_b, id_a] })).unwrap());
            let pos = |name: &str| after.iter().find(|i| i.get("name").and_then(Value::as_str) == Some(name)).unwrap().get("position").and_then(Value::as_i64).unwrap();
            assert_eq!(pos("B"), 0);
            assert_eq!(pos("A"), 1);
        });
    }

    #[test]
    fn saved_add_dedups_live_but_allows_readd_after_remove() {
        with_tmp_app(|app| {
            dispatch(app, "saved.add", &json!({ "input": { "url": "https://x.test/", "title": "X", "tags": ["t"] } })).unwrap();
            // Adding the same live URL again is a no-op (still one live row).
            let again = arr(dispatch(app, "saved.add", &json!({ "input": { "url": "https://x.test/", "title": "X2", "tags": [] } })).unwrap());
            assert_eq!(again.len(), 1);
            assert!(dispatch(app, "saved.has", &json!({ "url": "https://x.test/" })).unwrap().unwrap().as_bool().unwrap());
            let id = again[0].get("id").and_then(Value::as_i64).unwrap();
            dispatch(app, "saved.remove", &json!({ "id": id })).unwrap();
            assert!(!dispatch(app, "saved.has", &json!({ "url": "https://x.test/" })).unwrap().unwrap().as_bool().unwrap());
            // Re-add of a removed URL is allowed.
            let re = arr(dispatch(app, "saved.add", &json!({ "input": { "url": "https://x.test/", "title": "X3", "tags": [] } })).unwrap());
            assert_eq!(re.len(), 1);
        });
    }

    #[test]
    fn saved_tag_rename_delete_and_union() {
        with_tmp_app(|app| {
            dispatch(app, "saved.add", &json!({ "input": { "url": "https://a.test/", "title": "A", "tags": ["news", "rust"] } })).unwrap();
            dispatch(app, "saved.add", &json!({ "input": { "url": "https://b.test/", "title": "B", "tags": ["rust"] } })).unwrap();
            // union is sorted + deduped over live rows.
            let union = dispatch(app, "saved.tagUnion", &json!({})).unwrap().unwrap();
            let tags: Vec<&str> = union.as_array().unwrap().iter().filter_map(Value::as_str).collect();
            assert_eq!(tags, vec!["news", "rust"]);
            // rename rust → crab everywhere.
            dispatch(app, "saved.renameTag", &json!({ "oldT": "rust", "newT": "crab" })).unwrap();
            let union2 = dispatch(app, "saved.tagUnion", &json!({})).unwrap().unwrap();
            let tags2: Vec<&str> = union2.as_array().unwrap().iter().filter_map(Value::as_str).collect();
            assert_eq!(tags2, vec!["crab", "news"]);
            // delete news → only crab remains.
            dispatch(app, "saved.deleteTag", &json!({ "tag": "news" })).unwrap();
            let union3 = dispatch(app, "saved.tagUnion", &json!({})).unwrap().unwrap();
            let tags3: Vec<&str> = union3.as_array().unwrap().iter().filter_map(Value::as_str).collect();
            assert_eq!(tags3, vec!["crab"]);
        });
    }
}
```

- [ ] **Step 2: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml places::tests`
Expected: first run may fail (e.g. `dispatch` returns `Option<Result<…>>`; the helper `arr` unwraps the `Option` then the `Result` — confirm `.unwrap()` levels match). Iterate to green. **Note:** `saved.add`/`favorites.add` go through `persist` → `crate::sync::nudge`; with `SyncState` managed and `enabled=false`, `nudge` returns early (no thread). If a test panics in `nudge`, `SyncState` wasn't managed — re-check Task 1.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/places.rs
git commit -m "test(places): favorites/saved CRUD, tombstone-hide, reorder, tag ops"
```

---

## Task 4: `downloads.rs` — record / list / remove / cancel / clear

**Functions under test:** `downloads::on_requested(app, url, &mut dest)`, `downloads::on_finished(app, success)`, `downloads::dispatch(app, "downloads.{list,remove,cancel,clear}", payload)`. Real behavior to pin: `on_requested` derives a filename from the URL (strips the query), sets `*destination` under the resolved dir, records a `progressing` entry; `on_finished` marks the newest progressing entry `completed`/`interrupted`; `list` returns live rows; `remove`/`cancel` tombstone by id; `clear` tombstones only finished rows (keeps `progressing` live). The OS-`open` paths (`openFile`/`showInFolder`) are NOT unit-tested (they spawn `xdg-open`).

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/downloads.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    fn live(app: &AppHandle) -> Vec<Value> {
        jsonstore::live(jsonstore::load_synced(app, "downloads"))
    }

    #[test]
    fn on_requested_derives_filename_and_records_progressing() {
        with_tmp_app(|app| {
            let mut dest = PathBuf::new();
            on_requested(app, "https://files.test/path/report.pdf?token=abc", &mut dest);
            assert_eq!(dest.file_name().unwrap().to_string_lossy(), "report.pdf");
            let rows = live(app);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].get("filename").and_then(Value::as_str), Some("report.pdf"));
            assert_eq!(rows[0].get("state").and_then(Value::as_str), Some("progressing"));
        });
    }

    #[test]
    fn on_finished_marks_newest_progressing_completed() {
        with_tmp_app(|app| {
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/a.bin", &mut d);
            on_finished(app, true);
            let rows = live(app);
            assert_eq!(rows[0].get("state").and_then(Value::as_str), Some("completed"));
        });
    }

    #[test]
    fn on_finished_false_marks_interrupted() {
        with_tmp_app(|app| {
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/a.bin", &mut d);
            on_finished(app, false);
            assert_eq!(live(app)[0].get("state").and_then(Value::as_str), Some("interrupted"));
        });
    }

    #[test]
    fn remove_tombstones_one_row() {
        with_tmp_app(|app| {
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/a.bin", &mut d);
            on_finished(app, true);
            let id = live(app)[0].get("id").and_then(Value::as_i64).unwrap();
            let after = dispatch(app, "downloads.remove", &json!({ "id": id })).unwrap().unwrap();
            assert!(after.as_array().unwrap().is_empty());
        });
    }

    #[test]
    fn clear_keeps_progressing_and_tombstones_finished() {
        with_tmp_app(|app| {
            // one finished, one still progressing.
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/done.bin", &mut d);
            on_finished(app, true);
            let mut d2 = PathBuf::new();
            on_requested(app, "https://files.test/inflight.bin", &mut d2);
            let after = dispatch(app, "downloads.clear", &json!({})).unwrap().unwrap();
            let rows = after.as_array().unwrap();
            assert_eq!(rows.len(), 1, "only the progressing row survives clear");
            assert_eq!(rows[0].get("state").and_then(Value::as_str), Some("progressing"));
        });
    }
}
```

- [ ] **Step 2: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml downloads::tests`
Expected: first run may fail to compile if `PathBuf` isn't in scope inside `tests` — it is, via the module-top `use std::path::{Path, PathBuf};` + `use super::*;`. Iterate to green.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/downloads.rs
git commit -m "test(downloads): filename derivation, requested/finished states, remove, clear"
```

---

## Task 5: `permissions.rs` — list / remove / clear

**Functions under test:** `permissions::dispatch(app, "permissions.{list,remove,clear}", payload)`. The `resolve` path and `install_handler_label` are `#[cfg(target_os = "linux")]` and need a real WebKit `PermissionRequest`, so they are NOT unit-tested (live autopilot covers the prompt). We CAN test list/remove/clear because they're plain JSON-store ops. To set up state, we seed the `permissions` store directly via `jsonstore::save` (the dispatcher has no public "persist" entry — `persist` is `#[cfg(target_os="linux")]`-reachable only).

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/permissions.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    fn seed(app: &AppHandle) {
        let rows = vec![
            json!({ "origin": "https://a.test", "permission": "geolocation", "decision": "allow" }),
            json!({ "origin": "https://a.test", "permission": "camera", "decision": "deny" }),
            json!({ "origin": "https://b.test", "permission": "notifications", "decision": "allow" }),
        ];
        jsonstore::save(app, "permissions", &rows).unwrap();
    }

    #[test]
    fn list_returns_all_seeded_decisions() {
        with_tmp_app(|app| {
            seed(app);
            let v = dispatch(app, "permissions.list", &json!({})).unwrap().unwrap();
            assert_eq!(v.as_array().unwrap().len(), 3);
        });
    }

    #[test]
    fn remove_deletes_only_the_matching_origin_permission_pair() {
        with_tmp_app(|app| {
            seed(app);
            let after = dispatch(
                app,
                "permissions.remove",
                &json!({ "origin": "https://a.test", "permission": "camera" }),
            )
            .unwrap()
            .unwrap();
            let rows = after.as_array().unwrap();
            assert_eq!(rows.len(), 2);
            // The (a.test, camera) pair is gone; (a.test, geolocation) stays.
            assert!(rows.iter().all(|it| !(it.get("origin").and_then(Value::as_str) == Some("https://a.test")
                && it.get("permission").and_then(Value::as_str) == Some("camera"))));
            assert!(rows.iter().any(|it| it.get("permission").and_then(Value::as_str) == Some("geolocation")));
        });
    }

    #[test]
    fn clear_empties_the_store() {
        with_tmp_app(|app| {
            seed(app);
            let after = dispatch(app, "permissions.clear", &json!({})).unwrap().unwrap();
            assert!(after.as_array().unwrap().is_empty());
            assert!(jsonstore::load(app, "permissions").is_empty());
        });
    }

    #[test]
    fn origin_of_strips_path_keeping_scheme_host_port() {
        // origin_of is #[cfg(target_os = "linux")] — assert it only on Linux hosts.
        #[cfg(target_os = "linux")]
        {
            assert_eq!(origin_of("https://example.com:8443/some/path?x=1"), "https://example.com:8443");
            assert_eq!(origin_of("https://example.com/"), "https://example.com");
            assert_eq!(origin_of("not-a-url"), "not-a-url");
        }
    }
}
```

- [ ] **Step 2: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml permissions::tests`
Expected: first run may fail if `origin_of` is private+cfg-gated and the test refers to it on a non-Linux build — the `#[cfg(target_os = "linux")]` block guards that. On this Linux host all four run. Iterate to green.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/permissions.rs
git commit -m "test(permissions): list/remove/clear store ops + origin_of (linux)"
```

---

## Task 6: `safety.rs` — malware match + proceed/exceptions state machine

**Functions under test:** `safety::is_blocked(app, &Url)`, `safety::dispatch(app, "safety.{getState,proceed,listExceptions,removeException}", payload)`. Real behavior to pin: `is_blocked` is true for a bundled malware host and false otherwise; a session exception (added via `proceed` or directly) makes `is_blocked` false for that host; `getState` returns the current interstitial payload (Null when none); `proceed` records the host as a session exception and clears the interstitial; `listExceptions` returns the set; `removeException` drops one. We must pick a real host from the bundled `resources/malware-hosts.txt`. **Sub-step 0** reads one so the test isn't guessing.

- [ ] **Step 0: Pick a real malware host from the bundled list**

Run: `grep -vE '^\s*#|^\s*$' src-tauri/resources/malware-hosts.txt | head -1`
Read the first data line; its second whitespace field (hosts format `0.0.0.0 domain`) is a real bundled malware host. Use that exact domain as `MALWARE_HOST` in the test below. (Do NOT invent one — `is_blocked` checks membership in the real parsed set.)

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/safety.rs`. Replace `EXAMPLE_MALWARE_HOST` with the domain found in Step 0:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    // Filled from resources/malware-hosts.txt in Step 0 — a REAL bundled entry.
    const MALWARE_HOST: &str = "EXAMPLE_MALWARE_HOST";

    #[test]
    fn malware_hosts_parsed_from_bundle_is_nonempty_and_contains_the_probe() {
        assert!(!malware_hosts().is_empty(), "bundled malware host set must parse");
        assert!(
            malware_hosts().contains(MALWARE_HOST),
            "the chosen probe host must be in the bundled list (re-run Step 0 if this fails)"
        );
    }

    #[test]
    fn is_blocked_true_for_malware_host_false_for_clean() {
        with_tmp_app(|app| {
            let bad = Url::parse(&format!("https://{MALWARE_HOST}/x")).unwrap();
            let good = Url::parse("https://example.com/").unwrap();
            assert!(is_blocked(app, &bad));
            assert!(!is_blocked(app, &good));
        });
    }

    #[test]
    fn session_exception_unblocks_the_host() {
        with_tmp_app(|app| {
            let bad = Url::parse(&format!("https://{MALWARE_HOST}/x")).unwrap();
            assert!(is_blocked(app, &bad));
            // Add a session exception directly (the same set `proceed` writes).
            app.state::<SafetyState>()
                .exceptions
                .lock()
                .unwrap()
                .insert(MALWARE_HOST.to_string());
            assert!(!is_blocked(app, &bad), "an excepted host is no longer blocked");
        });
    }

    #[test]
    fn proceed_records_exception_and_clears_interstitial() {
        with_tmp_app(|app| {
            // Seed an interstitial as raise() would.
            *app.state::<SafetyState>().interstitial.lock().unwrap() =
                json!({ "url": format!("https://{MALWARE_HOST}/"), "reason": "malware" });
            let url = format!("https://{MALWARE_HOST}/");
            dispatch(app, "safety.proceed", &json!({ "url": url })).unwrap().unwrap();
            // interstitial cleared.
            let state = dispatch(app, "safety.getState", &json!({})).unwrap().unwrap();
            assert_eq!(state, Value::Null);
            // exception recorded → listExceptions contains the host.
            let list = dispatch(app, "safety.listExceptions", &json!({})).unwrap().unwrap();
            let hosts: Vec<&str> = list.as_array().unwrap().iter().filter_map(Value::as_str).collect();
            assert!(hosts.contains(&MALWARE_HOST));
        });
    }

    #[test]
    fn remove_exception_drops_it() {
        with_tmp_app(|app| {
            app.state::<SafetyState>()
                .exceptions
                .lock()
                .unwrap()
                .insert(MALWARE_HOST.to_string());
            dispatch(app, "safety.removeException", &json!({ "host": MALWARE_HOST })).unwrap();
            let list = dispatch(app, "safety.listExceptions", &json!({})).unwrap().unwrap();
            assert!(list.as_array().unwrap().is_empty());
        });
    }
}
```

> **Note on `proceed` navigating a webview:** the `safety.proceed` arm calls `app.get_webview(&label)` and, if present, `w.navigate(u)`. A mock app has no content webview, so `get_webview` returns `None` and the navigation is skipped — the exception-recording + interstitial-clearing logic still runs and is what we assert. Confirm this holds; if `proceed` ever panics, it's because `active_content_label`/`get_webview` paniced on a missing webview — read the panic and, if real, flag it (it would be a source bug, handled like Task 11).

- [ ] **Step 2: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml safety::tests`
Expected: the FIRST run fails on `malware_hosts_parsed_from_bundle…` if `MALWARE_HOST` still says `"EXAMPLE_MALWARE_HOST"` — fix it to the Step-0 domain, then iterate to green.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/safety.rs
git commit -m "test(safety): malware-host match, session-exception unblock, proceed/remove"
```

---

## Task 7: `adblock.rs` — enable + allowlist state machine + counters

**Functions under test:** `adblock::dispatch(app, "adblock.{getState,setEnabled,toggleAllowlist,removeAllowlist,clearAllowlist}", payload)`, `adblock::host_allowlisted(app, host)`, `adblock::load_allowlist_hosts(app)`, the counter functions `session_blocked`/`note_blocked`/`reset_page`. Real behavior to pin: default `enabled=true`, empty allowlist; `setEnabled` flips and persists in-memory state; `toggleAllowlist` adds then removes a host (persisted to the `allowlist` store); `removeAllowlist`/`clearAllowlist` tombstone; `host_allowlisted` covers subdomains; `getState` reflects `enabled`/`allowlistedHosts`.

> **Counter caveat (process-global statics):** `SESSION_BLOCKED` / `PAGE_BLOCKED` are process-wide and persist across tests in the same binary. We assert `note_blocked` *increments* (delta), not an absolute value, and the counter test runs under the `with_tmp_app` lock so it doesn't interleave. `note_blocked`/`reset_page` emit `adblock.blockedCount` via `emit_event` — with a mock app this is a no-op event (no listener) and won't panic.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/adblock.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    #[test]
    fn default_state_is_enabled_with_empty_allowlist() {
        with_tmp_app(|app| {
            let s = dispatch(app, "adblock.getState", &json!({})).unwrap().unwrap();
            assert_eq!(s.get("enabled").and_then(Value::as_bool), Some(true));
            assert!(s.get("allowlistedHosts").and_then(Value::as_array).unwrap().is_empty());
        });
    }

    #[test]
    fn set_enabled_flips_the_flag() {
        with_tmp_app(|app| {
            let off = dispatch(app, "adblock.setEnabled", &json!({ "enabled": false })).unwrap().unwrap();
            assert_eq!(off.get("enabled").and_then(Value::as_bool), Some(false));
            let on = dispatch(app, "adblock.setEnabled", &json!({ "enabled": true })).unwrap().unwrap();
            assert_eq!(on.get("enabled").and_then(Value::as_bool), Some(true));
        });
    }

    #[test]
    fn toggle_allowlist_adds_then_removes_and_persists() {
        with_tmp_app(|app| {
            // toggle on
            let on = dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "ads.example.com" })).unwrap().unwrap();
            let hosts: Vec<&str> = on.get("allowlistedHosts").and_then(Value::as_array).unwrap().iter().filter_map(Value::as_str).collect();
            assert!(hosts.contains(&"ads.example.com"));
            assert_eq!(load_allowlist_hosts(app), vec!["ads.example.com".to_string()]);
            // toggle off
            let off = dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "ads.example.com" })).unwrap().unwrap();
            assert!(off.get("allowlistedHosts").and_then(Value::as_array).unwrap().is_empty());
            assert!(load_allowlist_hosts(app).is_empty());
        });
    }

    #[test]
    fn host_allowlisted_covers_subdomains() {
        with_tmp_app(|app| {
            dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "example.com" })).unwrap();
            assert!(host_allowlisted(app, "example.com"));
            assert!(host_allowlisted(app, "www.example.com")); // subdomain covered
            assert!(!host_allowlisted(app, "notexample.com")); // not a subdomain
            assert!(!host_allowlisted(app, "")); // empty never matches
        });
    }

    #[test]
    fn clear_allowlist_tombstones_everything() {
        with_tmp_app(|app| {
            dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "a.test" })).unwrap();
            dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "b.test" })).unwrap();
            let cleared = dispatch(app, "adblock.clearAllowlist", &json!({})).unwrap().unwrap();
            assert!(cleared.get("allowlistedHosts").and_then(Value::as_array).unwrap().is_empty());
            assert!(load_allowlist_hosts(app).is_empty());
        });
    }

    #[test]
    fn note_blocked_increments_session_and_page_counters() {
        with_tmp_app(|app| {
            let before = session_blocked();
            note_blocked(app, 1);
            note_blocked(app, 1);
            assert_eq!(session_blocked(), before + 2, "session total is monotonic");
            // reset_page zeroes the per-page count for that tab (session unchanged).
            let session_after = session_blocked();
            reset_page(app, 1);
            assert_eq!(session_blocked(), session_after);
        });
    }
}
```

- [ ] **Step 2: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml adblock::tests`
Expected: first run may fail because `adblock.setEnabled` on Linux calls `crate::install_adblock(app.clone())` / `adblock_webkit::remove_all(app)` — both are webview-iterating and `std::thread::spawn` work that no-ops with no content webviews. If `remove_all` or `install_adblock` panics with a mock app, read the panic; the likely cause is `app.webviews()` returning empty is fine, so a panic here would be a real robustness bug — flag it like Task 11. Iterate to green.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/adblock.rs
git commit -m "test(adblock): enable flip, allowlist toggle/clear persistence, subdomain match, counters"
```

---

## Task 8: `subs.rs` — pure helpers + add/setEnabled/remove store ops

**Functions under test:** the pure helpers `subs::list_id_from_url(url)`, `subs::hash_text(text)`, `subs::url_of(items, list_id)`, `subs::enabled_text(app)`; and `subs::dispatch(app, "subs.{list,add,setEnabled,remove}", payload)` for the **store** effects (the network fetch runs detached in `fetch_in_background` and is not awaited — a failed fetch just `eprintln`s). `subs.add` validates the URL scheme (rejects non-http(s)). `enabled_text` reads cache files; we seed a cache file to test it.

- [ ] **Step 1: Write the failing tests**

Append to `src-tauri/src/subs.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    #[test]
    fn list_id_from_url_strips_txt_and_takes_last_segment() {
        assert_eq!(list_id_from_url("https://x.test/lists/easyprivacy.txt"), "easyprivacy");
        assert_eq!(list_id_from_url("https://x.test/regional/de"), "de");
        assert_eq!(list_id_from_url("https://x.test/trailing/"), "trailing");
        assert_eq!(list_id_from_url("noslash"), "noslash");
    }

    #[test]
    fn hash_text_is_stable_and_distinguishes() {
        assert_eq!(hash_text("a"), hash_text("a"));
        assert_ne!(hash_text("a"), hash_text("b"));
    }

    #[test]
    fn url_of_finds_the_row_by_list_id() {
        let items = vec![
            json!({ "listId": "ep", "url": "https://x/ep.txt" }),
            json!({ "listId": "de", "url": "https://x/de.txt" }),
        ];
        assert_eq!(url_of(&items, "de").as_deref(), Some("https://x/de.txt"));
        assert_eq!(url_of(&items, "missing"), None);
    }

    #[test]
    fn add_rejects_non_http_scheme() {
        with_tmp_app(|app| {
            let r = dispatch(app, "subs.add", &json!({ "url": "ftp://x/list.txt" }));
            assert!(matches!(r, Some(Err(_))), "non-http(s) url must be rejected");
        });
    }

    #[test]
    fn add_inserts_optimistic_row_then_list_and_remove() {
        with_tmp_app(|app| {
            let after = dispatch(app, "subs.add", &json!({ "url": "https://x.test/easyprivacy.txt" }))
                .unwrap()
                .unwrap();
            let rows = after.as_array().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].get("listId").and_then(Value::as_str), Some("easyprivacy"));
            assert_eq!(rows[0].get("enabled").and_then(Value::as_bool), Some(true));
            assert!(rows[0].get("lastUpdated").map(Value::is_null).unwrap_or(false), "fetch is async → null until done");
            // list reflects it.
            let listed = dispatch(app, "subs.list", &json!({})).unwrap().unwrap();
            assert_eq!(listed.as_array().unwrap().len(), 1);
            // remove tombstones it (live list empties).
            let removed = dispatch(app, "subs.remove", &json!({ "listId": "easyprivacy" })).unwrap().unwrap();
            assert!(removed.as_array().unwrap().is_empty());
        });
    }

    #[test]
    fn set_enabled_flips_persisted_flag() {
        with_tmp_app(|app| {
            dispatch(app, "subs.add", &json!({ "url": "https://x.test/easyprivacy.txt" })).unwrap();
            let after = dispatch(app, "subs.setEnabled", &json!({ "listId": "easyprivacy", "enabled": false }))
                .unwrap()
                .unwrap();
            assert_eq!(after.as_array().unwrap()[0].get("enabled").and_then(Value::as_bool), Some(false));
        });
    }

    #[test]
    fn enabled_text_concatenates_cached_enabled_lists_only() {
        with_tmp_app(|app| {
            // Seed two rows: one enabled with a cache file, one disabled.
            let rows = vec![
                json!({ "listId": "ep", "url": "https://x/ep.txt", "enabled": true }),
                json!({ "listId": "off", "url": "https://x/off.txt", "enabled": false }),
            ];
            jsonstore::save(app, "subs", &rows).unwrap();
            // Write the cache file enabled_text reads (cache_path is private — mirror it via the cache dir).
            let cache = subs_dir(app).join("ep.txt");
            std::fs::write(&cache, "||cached-ad.example^\n").unwrap();
            let text = enabled_text(app);
            assert!(text.contains("||cached-ad.example^"), "enabled cached list contributes its text");
            assert!(!text.contains("off"), "a disabled list contributes nothing");
        });
    }
}
```

> **Note:** `subs.add` / `subs.setEnabled` spawn `fetch_in_background` (a detached thread doing a real network GET that will fail offline and just log) and `subs.remove` / the no-fetch branch call `reinstall_adblock` → `refresh` → detached `install_adblock` (no-op without webviews). None block or panic the test; we assert only the persisted store + return value.

- [ ] **Step 2: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml subs::tests`
Expected: first run may fail to compile if `subs_dir` is private and unused elsewhere — it's a module-private `fn` and `use super::*;` makes it reachable inside `tests`. If `hash_text`/`url_of`/`list_id_from_url` are private, the same applies. Iterate to green.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/subs.rs
git commit -m "test(subs): list_id/hash/url_of helpers, add scheme-reject, add/setEnabled/remove, enabled_text"
```

---

## Task 9: `tabs.rs` — session persistence roundtrip + dispatch surface

**Functions under test:** `tabs::dispatch(app, "tabs.{list,create,activate,close,setPinned,setTitle,reorder,reopenClosed}", payload)` and the `tabs.json` session (de)serialization. The pure `tab_registry` is already exhaustively tested; here we cover the **Tauri layer** that the registry feeds — specifically that `tabs.list` returns a well-formed `TabsState`, and that session save/load round-trips through the app data dir. The webview-spawning side effects (`spawn_tab`, `add_child`) no-op or are skipped under a mock app (no real window), so we assert the **registry/session state**, not webviews.

> **Read first:** open `src-tauri/src/tabs.rs` fully before writing — confirm the exact names of the session helpers (`load_session`/`save_session` or similar at `tabs.rs:187` where `tabs.json` is referenced) and the shape of the managed `Tabs` state. The registry is `Tabs.reg` (a `Mutex<Registry>`). If `tabs::dispatch` requires a managed `Tabs` that `test_support` doesn't provide, either (a) add `.manage(Tabs::…)` construction to a **local** helper in this test module (NOT to `test_support`, to keep the harness minimal), or (b) test only the session save/load free functions. Decide based on what the file actually exposes — do not assume.

- [ ] **Step 1: Read `tabs.rs` and note the testable surface**

Run: `sed -n '1,60p;170,230p' src-tauri/src/tabs.rs` and identify: the `Tabs` managed-state constructor, the session-persistence functions, and whether `dispatch` needs a window. Record the exact function names you'll call.

- [ ] **Step 2: Write the failing tests**

Append to `src-tauri/src/tabs.rs`. Adjust the function/constructor names to what Step 1 found; the shape below assumes a session save/load pair plus a managed-`Tabs` `dispatch`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    #[test]
    fn session_round_trips_through_the_app_data_dir() {
        with_tmp_app(|app| {
            // Build a session from the pure registry and persist it via the Tauri layer.
            let mut reg = crate::tab_registry::Registry::new("https://home.test/".into());
            reg.create(Some("https://a.test/".into()), false, 0);
            let session = reg.to_persisted();
            save_session(app, &session); // <-- confirm this is the real fn name in Step 1
            let loaded = load_session(app); // <-- confirm
            assert_eq!(loaded.tabs.len(), 2);
            assert_eq!(loaded.active_id, session.active_id);
            assert_eq!(loaded.next_id, session.next_id);
        });
    }

    #[test]
    fn missing_session_file_loads_an_empty_or_default_session() {
        with_tmp_app(|app| {
            // No tabs.json written yet.
            let loaded = load_session(app);
            // A fresh app has no persisted tabs (the registry falls back to one home tab
            // at runtime); the persisted-session loader returns the default/empty shape.
            assert!(loaded.tabs.is_empty() || loaded.tabs.len() == 1);
        });
    }
}
```

> **If `tabs.rs` has no public `save_session`/`load_session` free functions** (Step 1 reveals the real names — e.g. they may be `persist`/`restore_session` or inlined into `dispatch`), test the smallest persistable surface that exists: drive `tabs.list` through `dispatch` (after `.manage`-ing whatever state it needs in a local helper) and assert the returned `TabsState` JSON has `tabs` + `activeId`. The goal is real coverage of the Tauri layer, adapted to its actual API — not forcing a function that isn't there.

- [ ] **Step 3: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml tabs::tests`
Expected: first run fails to compile on the placeholder function names from Step 1 — replace them with the real names, then iterate to green.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/tabs.rs
git commit -m "test(tabs): session persistence round-trip + default load via the Tauri layer"
```

---

## Task 10: `data.rs` — export → import roundtrip (every store survives)

This is the headline test (the spec calls out a prior live-crash). It must assert that **every** store survives a full export → import cycle: favorites, saved, history, downloads, allowlist, settings, customFilters.

**Functions under test:** `data::dispatch(app, "data.export", payload)` and `data::dispatch(app, "data.import", payload)`. The export bundle (`STORES = ["favorites","saved","history","downloads","allowlist"]` + `settings` + `customFilters`, `version: 2`) is written to the path in `payload.path` (so the test passes an explicit temp path — no reliance on the OS Downloads dir). Import is replace-mode and re-seeds the allowlist + refreshes ad-block (detached).

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/data.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    /// Seed one real row in every exported store + a settings change + a custom filter.
    fn seed_all(app: &AppHandle) {
        crate::places::dispatch(app, "favorites.add", &json!({ "input": { "name": "Fav", "url": "https://fav.test/" } })).unwrap();
        crate::places::dispatch(app, "saved.add", &json!({ "input": { "url": "https://saved.test/", "title": "Saved", "tags": ["t"] } })).unwrap();
        crate::history::record(app, "https://hist.test/", "Hist");
        // a downloads row
        let mut dest = std::path::PathBuf::new();
        crate::downloads::on_requested(app, "https://dl.test/file.bin", &mut dest);
        // an allowlist host
        crate::adblock::dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "allow.test" })).unwrap();
        // a non-default setting
        crate::settings::write(app, &json!({ "homeUrl": "https://home.seed/", "primaryColor": "#abcdef", "httpsOnly": false }));
        // a custom filter
        crate::customfilters::write(app, "||seed-filter.example^\n");
    }

    #[test]
    fn export_writes_a_v2_bundle_with_every_store() {
        with_tmp_app(|app| {
            seed_all(app);
            let path = app.path().app_data_dir().unwrap().join("export.json");
            let res = dispatch(app, "data.export", &json!({ "path": path.to_string_lossy() }))
                .unwrap()
                .unwrap();
            assert_eq!(res.get("ok").and_then(Value::as_bool), Some(true));
            let txt = std::fs::read_to_string(&path).unwrap();
            let bundle: Value = serde_json::from_str(&txt).unwrap();
            assert_eq!(bundle.get("version").and_then(Value::as_i64), Some(2));
            for key in ["favorites", "saved", "history", "downloads", "allowlist", "settings", "customFilters"] {
                assert!(bundle.get(key).is_some(), "export bundle is missing `{key}`");
            }
            // sanity: the favorite we seeded is in the bundle.
            assert!(bundle.get("favorites").and_then(Value::as_array).unwrap().iter()
                .any(|it| it.get("url").and_then(Value::as_str) == Some("https://fav.test/")));
        });
    }

    #[test]
    fn export_then_import_into_a_fresh_app_restores_every_store() {
        // 1) Export from app A (seeded), capturing the bundle text.
        let bundle_text = with_tmp_app(|app| {
            seed_all(app);
            let path = app.path().app_data_dir().unwrap().join("export.json");
            dispatch(app, "data.export", &json!({ "path": path.to_string_lossy() })).unwrap().unwrap();
            std::fs::read_to_string(&path).unwrap()
        });

        // 2) Import the pasted bundle text into a FRESH, empty app B and assert each store.
        with_tmp_app(|app| {
            // Fresh app: every store starts empty.
            assert!(jsonstore::live(jsonstore::load_synced(app, "favorites")).is_empty());

            let res = dispatch(app, "data.import", &json!({ "text": bundle_text })).unwrap().unwrap();
            assert_eq!(res.get("ok").and_then(Value::as_bool), Some(true));

            // favorites
            let favs = crate::places::dispatch(app, "favorites.list", &json!({})).unwrap().unwrap();
            assert!(favs.as_array().unwrap().iter().any(|it| it.get("url").and_then(Value::as_str) == Some("https://fav.test/")), "favorites did not survive import");
            // saved
            let saved = crate::places::dispatch(app, "saved.list", &json!({})).unwrap().unwrap();
            assert!(saved.as_array().unwrap().iter().any(|it| it.get("url").and_then(Value::as_str) == Some("https://saved.test/")), "saved did not survive import");
            // history
            let hist = crate::history::dispatch(app, "history.list", &json!({ "opts": {} })).unwrap().unwrap();
            assert!(hist.as_array().unwrap().iter().any(|it| it.get("url").and_then(Value::as_str) == Some("https://hist.test/")), "history did not survive import");
            // downloads
            let dls = crate::downloads::dispatch(app, "downloads.list", &json!({})).unwrap().unwrap();
            assert!(dls.as_array().unwrap().iter().any(|it| it.get("url").and_then(Value::as_str) == Some("https://dl.test/file.bin")), "downloads did not survive import");
            // allowlist (re-seeded into the live engine cache by import)
            assert!(crate::adblock::load_allowlist_hosts(app).contains(&"allow.test".to_string()), "allowlist did not survive import");
            // settings
            let s = crate::settings::all(app);
            assert_eq!(s.get("homeUrl").and_then(Value::as_str), Some("https://home.seed/"), "settings did not survive import");
            assert_eq!(s.get("httpsOnly").and_then(Value::as_bool), Some(false));
            // custom filters
            assert!(crate::customfilters::load(app).contains("||seed-filter.example^"), "custom filters did not survive import");
        });
    }

    #[test]
    fn import_of_garbage_text_returns_not_ok() {
        with_tmp_app(|app| {
            let res = dispatch(app, "data.import", &json!({ "text": "{ not json" })).unwrap().unwrap();
            assert_eq!(res.get("ok").and_then(Value::as_bool), Some(false));
        });
    }
}
```

> **Why a fresh app for import:** exporting and re-importing into the *same* app could pass even if import were a no-op (the data is already there). Importing the captured bundle into a **second, empty** `with_tmp_app` proves import actually writes every store. The bundle text crosses between the two `with_tmp_app` calls as a `String` (no shared filesystem needed). `crate::settings::write`/`customfilters::write`/`adblock::load_allowlist_hosts` are confirmed `pub`.

- [ ] **Step 2: Run, expecting failure first**

Run: `cargo test --manifest-path src-tauri/Cargo.toml data::tests`
Expected: first run may surface real issues:
- `crate::places`/`history`/`downloads`/`adblock`/`settings`/`customfilters` must be reachable as `crate::…` from within `data`'s test module — they are sibling modules in the same crate (all `mod …;` in `lib.rs`), so `crate::places::dispatch` resolves.
- If `customfilters::write`/`load` or `settings::write`/`all` are not `pub`, the test won't compile — verify with `grep -n "pub fn" src-tauri/src/customfilters.rs src-tauri/src/settings.rs`; they are `pub` (settings.rs:34/39, customfilters.rs:29/107).
- If `import` paniced on a missing webview during `adblock_refresh::refresh` → see the Linux-host note; it's detached. If a panic surfaces synchronously, it's a real bug → Task 11.

Iterate until all four PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/data.rs
git commit -m "test(data): export bundle shape + export→import roundtrip restores EVERY store"
```

---

## Task 11: (Conditional) Fix a real bug surfaced by a test

If any task above produced a **synchronous panic or wrong result that is a genuine source bug** (not a test mistake), fix it here — test-first, scoped to the one function. The most likely candidates, ranked by what the code review surfaced:

1. **`adblock.setEnabled`/`subs`/`data.import` panicking on a mock app** (no content webview). `apply_filters` iterates `app.webviews()` (empty → fine) and `install_adblock` spawns a detached thread, so this *should* be panic-free — but `adblock_webkit::remove_all` (called by `setEnabled(false)` on Linux) was not read in full here. If it `.unwrap()`s on a missing webview, that's a real robustness gap.
2. **`safety.proceed` / `data.import` reaching into managed state that a real (non-mock) boot guarantees but a mock doesn't.** If found, the fix is to make the function tolerate the absent piece (it already uses `try_state` in most places).

- [ ] **Step 1: Reproduce** — quote the exact panic/assertion from the failing task's `cargo test` output. If no task panicked synchronously, **skip this entire task** (mark it N/A in the commit log) — do not invent a fix.

- [ ] **Step 2: Write a focused failing test** in the owning module that reproduces the bug at the function boundary (e.g. `remove_all_is_a_noop_without_content_webviews`).

- [ ] **Step 3: Run it, confirm it fails** for the bug's reason.

- [ ] **Step 4: Make the minimal source fix** (e.g. guard a `.unwrap()` → `if let Some(...)`), scoped to the one function. Do NOT broaden behavior.

- [ ] **Step 5: Re-run the test + the whole module suite**, confirm green, and confirm no other test regressed.

- [ ] **Step 6: Commit** with a message that names the bug and the surfacing test:

```bash
git add src-tauri/src/<module>.rs
git commit -m "fix(<module>): <bug> — guard <fn> when no content webview is present (test-first)"
```

---

## Task 12: Full suite green + count audit

- [ ] **Step 1: Run the entire Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -30`
Expected: `test result: ok.` with **0 failed**. The new tests add to the existing ~119; record the new total. If any test is **flaky** across two runs (re-run the command twice), the cause is almost certainly the env-var/process-global serialization — confirm every AppHandle test body is inside `with_tmp_app` (which holds the lock) and that no test reads a process-global counter as an absolute value.

- [ ] **Step 2: Confirm release builds are unaffected**

Run: `cargo build --release --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: builds clean. The `[dev-dependencies] tauri … features=["test"]` does **not** affect the release dependency graph (dev-deps are excluded from `--release` binaries), and every `mod tests` / `mod test_support` is `#[cfg(test)]`, so none of it compiles into the release artifact.

- [ ] **Step 3: Confirm no real user data was touched**

Run: `ls -la ~/.local/share/*.json 2>/dev/null; echo "exit=$?"`
Expected: no Aegis store files (`favorites.json`, etc.) created or modified by the test run (the tests redirect `$XDG_DATA_HOME`). If any appeared with a recent mtime, a test escaped the harness — find it and wrap it in `with_tmp_app`.

- [ ] **Step 4: Update the docs (living-docs rule)**

In `src-tauri/CLAUDE.md`, update the module-map lines for the nine now-tested modules to note their coverage (e.g. add "unit-tested via `test_support::with_tmp_app`") and add a short subsection documenting the `test_support` harness pattern (XDG redirect + serialization lock + managed `AdblockState`/`SafetyState`/`SyncState`) so future tests follow it. This is the same commit discipline the repo enforces for `tab_registry`/`jsonstore`.

- [ ] **Step 5: Commit the docs**

```bash
git add src-tauri/CLAUDE.md
git commit -m "docs(core): document the test_support mock-app harness + new module coverage"
```

---

## Self-Review

**Does the plan meet sub-project C's acceptance criteria?**
- ✅ **Every named module gets meaningful `#[test]` coverage:** adblock (Task 7), safety (6), permissions (5), data (10), history (2), places (3), downloads (4), tabs (9), subs (8). Each test names the **real** functions under test (`dispatch` channels, `record`, `on_requested`, `is_blocked`, `host_allowlisted`, `enabled_text`, the pure helpers) and asserts real behavior, not shapes.
- ✅ **The `data` roundtrip asserts every store survives:** Task 10's roundtrip test imports into a *fresh* app and asserts favorites, saved, history, downloads, allowlist, settings, AND customFilters all survive — the strongest form of the requirement (a same-app re-import could false-pass; a cross-app import can't).
- ✅ **`cargo test` will gate in CI** (sub-project A) — all tests are standard `#[test]`s in `#[cfg(test)]` modules.

**The AppHandle problem — handled per the repo's real constraints, not invented:**
- The repo's existing Rust tests test **only AppHandle-free** functions; there was no mock-app pattern. I verified `tauri::test::mock_app` exists in the pinned `tauri-2.11.2` but is behind the crate's `test` feature (not currently enabled) → the plan adds it as a **dev-dependency** (Task 1), which is the correct, release-safe idiom.
- I verified (by reading `dirs-6.0.0/src/lin.rs` + tauri's `path/desktop.rs`) that `app_data_dir()`/`app_cache_dir()` resolve from `$XDG_DATA_HOME`/`$XDG_CACHE_HOME` on Linux and that a mock app's identifier is empty — so redirecting those env vars cleanly sandboxes all store IO. This is a verified mechanism, not a guess.
- I caught that env vars are process-global + cargo is multithreaded → the harness serializes with a `static Mutex` (no `serial_test` dep, since the repo has none).

**Real bugs / risks surfaced while reading (flagged, not hidden):**
1. **`crate::sync::nudge` uses `app.state::<SyncState>()` (not `try_state`) and panics if unmanaged** (`sync.rs:390`). `places::persist`, adblock allowlist, and `data.import` all reach it. The harness manages `SyncState::default()` (enabled=false → `nudge` returns before spawning). This is a latent fragility (a non-boot caller of `nudge` would panic) but in-product `nudge` is only ever reached after `setup()` manages `SyncState`, so it's not a product bug — only a test constraint, handled.
2. **Linux test host runs `install_adblock` (detached WebKit thread) on `setEnabled`/`subs`/`import`.** It no-ops without content webviews and is detached, so it can't fail the synchronous test — but `adblock_webkit::remove_all` was not fully read; if it `.unwrap()`s on a missing webview it's a real robustness bug. **Task 11 is the test-first escape valve** for exactly this, and Task 7/8/10's "run, expecting failure first" steps will surface it if real.
3. **Process-global counters** (`SESSION_BLOCKED`, `PAGE_BLOCKED`) + **`sync_identity::NODE_ID` `OnceLock`** persist across tests in one binary. The plan asserts the counters by **delta** (not absolute) and serializes all AppHandle tests, so a leaked global can't cause a false failure. `NODE_ID` initializing once under the first test's `$XDG_DATA_HOME` then being reused is harmless (it's just a node id string).
4. **`tabs.rs` session API is assumed, not confirmed.** Task 9 explicitly front-loads a "read the file, confirm the real function names" step and gives a fallback (test `tabs.list` via `dispatch`) so the plan adapts to the actual API instead of fabricating one — honoring "don't guess."

**Hard constraints honored:** no source modified except the conditional, test-first, scoped Task 11; the only non-test source change is the `[dev-dependencies]` line + the `#[cfg(test)] mod test_support;` declaration (both inert in release). I did not run cargo/tests/git while writing this plan (per the task's hard constraints); every "expected" outcome is written as a TDD checkpoint for the implementer to verify against real output, with explicit "run, expecting failure first" steps so claims are evidence-gated at execution time.

**Residual uncertainty (stated, not papered over):** I did not fully read `tabs.rs` (only its registry-facing top + the `tabs.json` path line) or `adblock_webkit::remove_all`/`customfilters` bodies in full. Task 9 and the Task-7/11 notes account for this by making the implementer read those files before asserting their API — the plan tells them exactly what to confirm rather than assuming. If `tabs.rs` has no persistable free functions, Task 9 degrades gracefully to dispatch-level coverage.
