# Sync Test-Connection Button + Automatic Dedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Test connection" button to Settings → Sync (reachability check via the server's `/healthz`), and make sync automatically collapse cross-device duplicate records.

**Architecture:** Feature A adds one IPC channel (`sync.testConnection`) routed through `sync::dispatch`, backed by a pure `healthz_url` normalizer + a short-timeout blocking `reqwest` probe on a spawned thread, surfaced by a button in `SyncSettingsTab`'s setup form. Feature B adds a pure `duplicate_losers` function to `sync_stores.rs` and calls it inside `merge_into` (after `merge_records`, before `save`) to tombstone duplicate losers so all devices converge. Both live in ungated Rust + shared React, so Linux/Windows/macOS/Android all get them.

**Tech Stack:** Rust (axum-free core, `reqwest::blocking`, serde_json), React 19 + TypeScript, vitest, cargo test.

**Specs:** `docs/superpowers/specs/2026-06-18-sync-test-connection-button-design.md`, `docs/superpowers/specs/2026-06-18-sync-dedup-design.md`

**Test gates:** `cargo test --manifest-path src-tauri/Cargo.toml` and `npm test` (vitest). Android parity via `cargo check --target aarch64-linux-android`.

---

## Reference: verified current shapes

- `sync.rs::dispatch` matches `"sync.*"` arms and returns `Some(Ok(Value))` / `Some(Err(String))`. `http()` shows the spawn-thread + `reqwest::blocking::Client::builder().timeout(...)` pattern is the way to do blocking HTTP here.
- `sync_stores.rs`: `pub const SYNCABLE: &[&str] = &["favorites", "saved", "allowlist"];`. `merge_into(app, name, remote) -> Vec<String>` calls `merge_records` (pure) then `jsonstore::save`, and re-seeds ad-block for `allowlist`. Records are `serde_json::Value` with `uuid` / `hlc` / `deleted` + a `url` (favorites/saved) or `host` (allowlist) field.
- `jsonstore`: `uuid_of(&Value) -> Option<&str>`, `is_deleted(&Value) -> bool`, `tombstone(&mut [Value], pred, app) -> bool` (sets `deleted:true` + fresh HLC).
- `sync_envelope`: `pub struct Hlc { wall_ms: i64, counter: u32, node: String }` (derives `Ord`), `from_value(&Value) -> Option<Hlc>`.
- `SyncSettingsTab.tsx`: setup branch has the URL `<input aria-label="Sync server URL">` bound to local `serverUrl` state; every button uses the `run(async () => …)` busy/error wrapper; inline errors render as `<p className="sync-tab__error" role="alert">`.

---

# Feature A — "Test connection" button

## Task A1: Rust — `healthz_url` + `sync.testConnection` handler

**Files:**

- Modify: `src-tauri/src/sync.rs`

- [ ] **Step 1: Write the failing test**

Add inside `sync.rs`'s `#[cfg(test)] mod tests`:

```rust
#[test]
fn healthz_url_builds_or_rejects() {
    assert_eq!(healthz_url(""), None);
    assert_eq!(healthz_url("   "), None);
    assert_eq!(healthz_url("http://h:8787"), Some("http://h:8787/healthz".to_string()));
    assert_eq!(healthz_url("http://h:8787/"), Some("http://h:8787/healthz".to_string()));
    assert_eq!(
        healthz_url("  https://sync.example.com/  "),
        Some("https://sync.example.com/healthz".to_string())
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml healthz_url_builds_or_rejects`
Expected: FAIL — `cannot find function healthz_url`.

- [ ] **Step 3: Add `healthz_url` + `test_connection`**

Add near the other free helpers in `sync.rs` (above `dispatch`):

```rust
/// Build the unauthenticated health-probe URL from a user-entered server URL. `None` for an
/// empty/whitespace entry. Trims surrounding whitespace and a single trailing slash.
fn healthz_url(raw: &str) -> Option<String> {
    let base = raw.trim().trim_end_matches('/');
    if base.is_empty() {
        return None;
    }
    Some(format!("{base}/healthz"))
}

/// Probe `{url}/healthz` (unauthenticated) with a short timeout. Returns a STRUCTURED result —
/// a failed probe is a value, not a thrown IPC error. Uses the spawn-thread + reqwest::blocking
/// pattern (blocking client can't run in the command's async context); 8s keeps it interactive.
fn test_connection(raw_url: &str) -> Value {
    let Some(target) = healthz_url(raw_url) else {
        return json!({ "ok": false, "error": "Enter a server URL first" });
    };
    let start = std::time::Instant::now();
    let probe = std::thread::spawn(move || -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&target).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        Ok(())
    })
    .join()
    .map_err(|_| "probe thread panicked".to_string())
    .and_then(|r| r);
    match probe {
        Ok(()) => json!({ "ok": true, "latencyMs": start.elapsed().as_millis() as i64 }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}
```

- [ ] **Step 4: Add the dispatch arm**

In `sync.rs`'s `dispatch` match, add alongside the other `"sync.*"` arms:

```rust
"sync.testConnection" => {
    let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
    Some(Ok(test_connection(url)))
}
```

- [ ] **Step 5: Run tests + build to verify**

Run: `cargo test --manifest-path src-tauri/Cargo.toml healthz_url_builds_or_rejects`
Expected: PASS.
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean (no errors; `test_connection` + the arm are reachable so no dead-code error).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/sync.rs
git commit -m "feat(sync): sync.testConnection IPC — probe server /healthz"
```

---

## Task A2: IPC contract + hook wiring

**Files:**

- Modify: `shared/types.ts`
- Modify: `src/lib/ipcClient.ts`
- Modify: `src/hooks/useSync.ts`

- [ ] **Step 1: Add the channel + API type (`shared/types.ts`)**

In the `IPC` const, in the sync section (next to `syncNow: 'sync.syncNow',`), add:

```ts
syncTestConnection: 'sync.testConnection',
```

In the `AegisApi` `sync` interface (next to `syncNow(): Promise<SyncState>;`), add:

```ts
testConnection(url: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
```

- [ ] **Step 2: Add the client call (`src/lib/ipcClient.ts`)**

In the `sync:` object (next to `syncNow: () => call<SyncState>(IPC.syncNow),`), add:

```ts
testConnection: (url: string) =>
  call<{ ok: boolean; latencyMs?: number; error?: string }>(IPC.syncTestConnection, { url }),
```

- [ ] **Step 3: Add the hook action (`src/hooks/useSync.ts`)**

Add a `useCallback` next to the existing `syncNow` action:

```ts
const testConnection = useCallback((url: string) => aegis.sync.testConnection(url), []);
```

Then add `testConnection` to BOTH the object the hook returns AND the `UseSync` type/interface (mirror exactly how `syncNow` appears in each — `testConnection: (url: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;` in the type).

- [ ] **Step 4: Verify the contract still type-checks + channel invariant holds**

Run: `npm test -- types`
Expected: PASS (the `types.test.ts` invariant — every `IPC` value dot-separated + unique — accepts `'sync.testConnection'`).
Run: `npm run build:renderer`
Expected: builds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts src/lib/ipcClient.ts src/hooks/useSync.ts
git commit -m "feat(sync): wire testConnection through the IPC client + useSync"
```

---

## Task A3: UI button (`SyncSettingsTab`)

**Files:**

- Modify: `src/components/SyncSettingsTab.tsx`
- Test: `src/components/SyncSettingsTab.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `SyncSettingsTab.test.tsx`, add `testConnection` to the `fakeSync` factory (next to `syncNow`):

```ts
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
```

Then add two tests:

```ts
it('disabled: Test connection reports success with latency', async () => {
  const testConnection = vi.fn(async () => ({ ok: true, latencyMs: 42 }));
  render(<SyncSettingsTab sync={fakeSync({ testConnection })} onSetServerUrl={vi.fn()} />);
  const url = screen.getByLabelText(/sync server url/i);
  await userEvent.clear(url);
  await userEvent.type(url, 'http://localhost:8787');
  await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
  expect(testConnection).toHaveBeenCalledWith('http://localhost:8787');
  expect(await screen.findByText(/connected/i)).toBeInTheDocument();
});

it('disabled: Test connection reports failure', async () => {
  const testConnection = vi.fn(async () => ({ ok: false, error: 'refused' }));
  render(<SyncSettingsTab sync={fakeSync({ testConnection })} onSetServerUrl={vi.fn()} />);
  const url = screen.getByLabelText(/sync server url/i);
  await userEvent.clear(url);
  await userEvent.type(url, 'http://bad');
  await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
  expect(await screen.findByText(/failed: refused/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- SyncSettingsTab`
Expected: FAIL — no button named "Test connection".

- [ ] **Step 3: Implement the button**

In `SyncSettingsTab.tsx`:

(a) Add the status state next to the other `useState`s:

```tsx
const [testStatus, setTestStatus] = useState('');
```

(b) In the Server URL input's `onChange`, also clear the stale status. Change:

```tsx
onChange={(e) => setServerUrl(e.target.value)}
```

to:

```tsx
onChange={(e) => { setServerUrl(e.target.value); setTestStatus(''); }}
```

(c) Directly below the Server URL `<label>` and before the "Start new sync" button (still inside the disabled-state branch), add:

```tsx
<button
  type="button"
  disabled={busy || serverUrl.trim().length === 0}
  onClick={() =>
    void run(async () => {
      const r = await sync.testConnection(serverUrl.trim());
      setTestStatus(r.ok ? `Connected — ${r.latencyMs} ms` : `Failed: ${r.error ?? 'unreachable'}`);
    })
  }
>
  Test connection
</button>;
{
  testStatus && (
    <p className="sync-tab__status" role="status">
      {testStatus}
    </p>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- SyncSettingsTab`
Expected: PASS (both new tests + the existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/components/SyncSettingsTab.tsx src/components/SyncSettingsTab.test.tsx
git commit -m "feat(sync): Test connection button in the Sync setup form"
```

---

# Feature B — Automatic sync deduplication

## Task B1: pure `duplicate_losers` + normalization

**Files:**

- Modify: `src-tauri/src/sync_stores.rs`

- [ ] **Step 1: Write the failing tests**

Add inside `sync_stores.rs`'s `#[cfg(test)] mod tests`:

```rust
fn drec(uuid: &str, key: &str, key_field: &str, wall: i64, deleted: bool) -> Value {
    json!({
        "uuid": uuid,
        key_field: key,
        "hlc": { "wall_ms": wall, "counter": 0, "node": "n" },
        "deleted": deleted,
    })
}

#[test]
fn dedup_keeps_latest_hlc_survivor() {
    let recs = vec![
        drec("a", "http://x/p", "url", 10, false),
        drec("b", "http://x/p", "url", 20, false),
    ];
    assert_eq!(duplicate_losers(&recs, "url"), vec!["a".to_string()]);
}

#[test]
fn dedup_hlc_tie_smaller_uuid_survives() {
    let recs = vec![
        drec("b", "http://x/p", "url", 10, false),
        drec("a", "http://x/p", "url", 10, false),
    ];
    assert_eq!(duplicate_losers(&recs, "url"), vec!["b".to_string()]);
}

#[test]
fn dedup_normalizes_slash_and_fragment() {
    let recs = vec![
        drec("a", "http://x/p/", "url", 10, false),
        drec("b", "http://x/p", "url", 20, false),
        drec("c", "http://x/p#frag", "url", 30, false),
    ];
    let mut losers = duplicate_losers(&recs, "url");
    losers.sort();
    assert_eq!(losers, vec!["a".to_string(), "b".to_string()]); // survivor = c
}

#[test]
fn dedup_distinct_query_not_merged() {
    let recs = vec![
        drec("a", "http://x/p?id=1", "url", 10, false),
        drec("b", "http://x/p?id=2", "url", 20, false),
    ];
    assert!(duplicate_losers(&recs, "url").is_empty());
}

#[test]
fn dedup_allowlist_host_case_insensitive() {
    let recs = vec![
        drec("a", "Example.com", "host", 10, false),
        drec("b", "example.com", "host", 20, false),
    ];
    assert_eq!(duplicate_losers(&recs, "host"), vec!["a".to_string()]);
}

#[test]
fn dedup_ignores_tombstones_and_singletons() {
    let recs = vec![
        drec("a", "http://x/p", "url", 10, true),   // already deleted
        drec("b", "http://x/p", "url", 20, false),  // sole live in its group
        drec("c", "http://y", "url", 5, false),
    ];
    assert!(duplicate_losers(&recs, "url").is_empty());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml dedup_`
Expected: FAIL — `cannot find function duplicate_losers`.

- [ ] **Step 3: Implement the pure functions**

Add to `sync_stores.rs` (above the `#[cfg(test)]` module):

```rust
/// Normalize a favorites/saved URL for dup detection: drop the #fragment and one trailing
/// slash, trim whitespace. Path + query preserved, no case-folding (so `?id=1` ≠ `?id=2`).
fn normalize_url(u: &str) -> String {
    let no_frag = u.split('#').next().unwrap_or("");
    no_frag.trim().trim_end_matches('/').to_string()
}

/// The dedup key for a record, by namespace field: `"host"` (allowlist) is lowercased; any
/// other field (`"url"`) is URL-normalized.
fn dedup_key(rec: &Value, key_field: &str) -> Option<String> {
    let raw = rec.get(key_field).and_then(Value::as_str)?;
    Some(if key_field == "host" {
        raw.trim().to_lowercase()
    } else {
        normalize_url(raw)
    })
}

/// Among LIVE records, group by normalized key; for each group of >1, keep the deterministic
/// survivor (highest HLC, tie-broken by lexicographically smallest uuid) and return the loser
/// uuids. Pure + convergent: every device computes the same survivor from replicated fields.
fn duplicate_losers(records: &[Value], key_field: &str) -> Vec<String> {
    use std::collections::HashMap;
    let mut groups: HashMap<String, Vec<(String, Option<crate::sync_envelope::Hlc>)>> =
        HashMap::new();
    for r in records {
        if crate::jsonstore::is_deleted(r) {
            continue;
        }
        let (Some(key), Some(uuid)) = (dedup_key(r, key_field), crate::jsonstore::uuid_of(r))
        else {
            continue;
        };
        groups
            .entry(key)
            .or_default()
            .push((uuid.to_string(), crate::sync_envelope::from_value(r)));
    }
    let mut losers = Vec::new();
    for (_key, members) in groups {
        if members.len() < 2 {
            continue;
        }
        // Survivor = max by HLC; on an HLC tie the smaller uuid wins (so it ranks as "max").
        let survivor = members
            .iter()
            .enumerate()
            .max_by(|(_, (ua, ha)), (_, (ub, hb))| match ha.cmp(hb) {
                std::cmp::Ordering::Equal => ub.cmp(ua),
                other => other,
            })
            .map(|(i, _)| i)
            .unwrap();
        for (i, (uuid, _)) in members.into_iter().enumerate() {
            if i != survivor {
                losers.push(uuid);
            }
        }
    }
    losers
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml dedup_`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sync_stores.rs
git commit -m "feat(sync): pure duplicate_losers + url/host normalization"
```

---

## Task B2: wire dedup into `merge_into`

**Files:**

- Modify: `src-tauri/src/sync_stores.rs`

- [ ] **Step 1: Write the failing test**

Add to `sync_stores.rs`'s `mod tests`:

```rust
#[test]
fn key_field_for_picks_host_only_for_allowlist() {
    assert_eq!(key_field_for("allowlist"), "host");
    assert_eq!(key_field_for("favorites"), "url");
    assert_eq!(key_field_for("saved"), "url");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml key_field_for`
Expected: FAIL — `cannot find function key_field_for`.

- [ ] **Step 3: Add `key_field_for` + wire dedup into `merge_into`**

Add the helper near `duplicate_losers`:

```rust
/// Which record field identifies a duplicate, per namespace.
fn key_field_for(name: &str) -> &'static str {
    if name == "allowlist" {
        "host"
    } else {
        "url"
    }
}
```

Replace the body of `merge_into` with (the dedup block is the only addition; the rest is unchanged):

```rust
pub fn merge_into(app: &AppHandle, name: &str, remote: &[Value]) -> Vec<String> {
    let node = crate::sync_identity::node_id(app);
    let local = read_all(app, name);
    let (mut merged, mut changed) =
        merge_records(local, remote, &node, crate::jsonstore::now_ms());
    // Collapse cross-device duplicates (same normalized url/host): tombstone the losers so the
    // deletion converges across devices. Idempotent — tombstoned losers are skipped next pass.
    let losers = duplicate_losers(&merged, key_field_for(name));
    if !losers.is_empty() {
        crate::jsonstore::tombstone(
            &mut merged,
            |it| {
                crate::jsonstore::uuid_of(it)
                    .map(|u| losers.iter().any(|l| l == u))
                    .unwrap_or(false)
            },
            app,
        );
        for u in losers {
            if !changed.contains(&u) {
                changed.push(u);
            }
        }
    }
    if !changed.is_empty() {
        let _ = crate::jsonstore::save(app, name, &merged);
        if name == "allowlist" {
            crate::adblock::seed_from_disk(app);
            crate::adblock_refresh::refresh(app);
        }
    }
    changed
}
```

- [ ] **Step 4: Run the full crate test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — the 6 existing `merge_records` tests + the new dedup/key_field tests + everything else. (merge_records is unchanged; only `merge_into`'s wrapper changed.)
Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sync_stores.rs
git commit -m "feat(sync): dedup duplicate records during merge_into"
```

---

## Final verification (controller)

- [ ] Full Rust gate: `cargo test --manifest-path src-tauri/Cargo.toml` — all green.
- [ ] Full JS gate: `npm test` — all green.
- [ ] **Cross-platform parity:** `cargo check --target aarch64-linux-android` (with the NDK env: `ANDROID_NDK_HOME` + `CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER`/`CC_aarch64_linux_android` = `…/aarch64-linux-android24-clang`) — confirms both features compile for Android (the handler + dedup are ungated; the React UI is shared, so the button appears in `MobileApp` too). No per-platform work needed.
- [ ] Manual smoke (desktop, sync server running via Docker): type the server URL → **Test connection** → `Connected — N ms`; bad URL → `Failed: …`.
- [ ] Manual smoke (dedup): add the same bookmark on two devices/profiles pointed at the same server → after sync, it appears once.
- [ ] Build a fresh **release** APK (android fix + both features) for the device: `JAVA_HOME=<jbr-21> NDK_HOME=<ndk> npm run android:build -- --target aarch64`, then `adb install -r` the universal APK. (Note: debug installs as `com.aegis.browser.debug`; release as `com.aegis.browser`.)
- [ ] Update memory: note the test-connection button + auto-dedup shipped on `main`.

```

```
