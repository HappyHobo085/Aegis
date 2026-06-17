# Sync "Test connection" button — design

**Date:** 2026-06-18
**Status:** Approved (brainstorming), pending implementation plan
**Topic:** A button in Settings → Sync that checks reachability of the sync server

## Goal

Let the user validate a sync **Server URL before committing to setup** — type a URL, tap
**Test connection**, see "reachable + latency" or the error. Fills the gap that the existing
"Sync now" button can't (it needs sync already enabled + valid keys); reachability uses the
server's unauthenticated `GET /healthz`, so it works with no keys.

## Scope

- Button lives in the **setup form** (disabled-state branch of `SyncSettingsTab`), below the
  Server URL field, before "Start new sync".
- Tests the **currently-typed URL** (passed as an IPC payload), NOT the persisted setting —
  avoids the blur-timing gap (the URL is only written to settings `onBlur`).
- Reachability only (`/healthz`). The enabled-view authenticated round-trip is already
  covered by "Sync now". No new UI in the enabled view.

## Components

### 1. IPC channel `sync.testConnection` (the standard 3 places)

- `shared/types.ts`: add `syncTestConnection: 'sync.testConnection'` to the `IPC` const, and
  `testConnection(url: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>`
  to the `AegisApi.sync` interface.
- `src/lib/ipcClient.ts`: in the `sync` object,
  `testConnection: (url) => call<{ ok: boolean; latencyMs?: number; error?: string }>(IPC.syncTestConnection, { url })`.
- `src-tauri/src/sync.rs`: a `"sync.testConnection"` arm in `dispatch()`. No `lib.rs` change
  (sync dispatch is already routed). **Works on Android automatically** — `sync.rs` is
  ungated and rides the normal Tauri IPC bridge; no Kotlin changes.

### 2. Rust handler

- A **pure, unit-tested** helper `fn healthz_url(raw: &str) -> Option<String>`: `None` for
  empty/whitespace; else `{trimmed-trailing-slash}/healthz`.
- The handler reads `url` from the payload, calls `healthz_url`; if `None`, returns
  `{ok:false, error:"Enter a server URL first"}`. Otherwise does a blocking `reqwest` GET on
  a spawned thread (mirroring the existing `http()` thread pattern, since `reqwest::blocking`
  can't run in the command's async context) with a **short 8-second timeout** (interactive;
  the engine's own calls use 30s). Returns `{ok:true, latencyMs}` on a 2xx, else
  `{ok:false, error}` (a failed probe is a *result*, not a thrown IPC error).

### 3. UI (`SyncSettingsTab.tsx` + `useSync.ts`)

- `useSync`: add `testConnection: (url: string) => aegis.sync.testConnection(url)` to the hook
  + its `UseSync` type.
- `SyncSettingsTab`: a new `const [testStatus, setTestStatus] = useState('')`. A **Test
  connection** button (disabled when `busy` or the URL is empty) that runs inside the existing
  `run()` busy/error wrapper:
  `const r = await sync.testConnection(serverUrl.trim()); setTestStatus(r.ok ? \`Connected — ${r.latencyMs} ms\` : \`Failed: ${r.error ?? 'unreachable'}\`)`.
  Render `testStatus` as a `<p role="status">` (separate from the existing `error` line). Clear
  `testStatus` in the URL field's `onChange` so a stale result doesn't linger.

## Error handling

Reachability failures are structured `{ok:false, error}` shown in `testStatus`. Only an
IPC/transport exception falls through to `run()`'s `error` paragraph. The 8s timeout keeps it
snappy on a dead/unreachable host.

## Cross-platform parity

Linux/Windows/macOS/Android all covered by the single ungated `sync.rs` handler + the shared
React UI. No per-platform work.

## Testing

- **Rust:** unit-test `healthz_url` — empty/whitespace → `None`; `"http://h:8787/"` and
  `"http://h:8787"` both → `"http://h:8787/healthz"`; appends `/healthz`.
- **vitest (`SyncSettingsTab.test.tsx`):** add `testConnection` to the `fakeSync` mock;
  assert clicking **Test connection** calls it with the typed URL and renders `Connected …`
  (mock `{ok:true,latencyMs:42}`) and `Failed: …` (mock `{ok:false,error:'…'}`).
- **Manual:** against the running Docker sync server — good URL → `Connected — N ms`; bad URL
  → `Failed: …`.
```
