# Phase B: Vault Autofill + Sync Integration

**Date:** 2026-07-23
**Status:** Approved for implementation
**Scope:** Full autofill pipeline (detect → suggest → fill → save) + vault record sync across devices

---

## 1. Problem

The vault (Phase A) manages credentials at rest but has no interaction with the browsing experience. Users must manually copy/paste passwords. Phase B closes the loop: detect login forms, suggest matching credentials, auto-fill on click, and save new credentials after submission. Additionally, vault records should sync across devices via the existing E2E sync infrastructure.

## 2. Goals

1. **Auto-detect login forms** in the content webview and show an in-page badge
2. **Suggest matching vault credentials** for the detected domain
3. **Auto-fill form fields** on badge click (smart fill: one match = instant, multiple = pick)
4. **Save new credentials** via a post-submit prompt in the chrome
5. **Sync vault records** across devices using the existing sync server (opaque ciphertext, HLC merge)
6. All platforms: Linux, Windows, macOS, Android

## 3. Non-Goals

- Credit card / address autofill (separate feature)
- Import from Chrome/Firefox password managers (follow-up)
- Password generator (follow-up)
- Biometric unlock (follow-up, needs platform-specific work)

## 4. Architecture

### 4.1 Overview

Three layers plus sync:

```
Layer 1: Form Detection    — injected JS observes password fields, emits events
Layer 2: Badge + Autofill  — injected JS renders badge, fills fields on click
Layer 3: Save Prompt       — chrome shows prompt after form submission
Sync:   Vault Records      — encrypted records synced via existing sync server
```

### 4.2 Form Detection (extending `form.rs`)

**Current state:** `form.rs` has a one-shot `detect_login_form` that evals JS in the content webview and waits for a response via Tauri event. This is too slow for real-time detection (5s timeout, blocks IPC).

**New approach:** Replace the one-shot eval with a persistent injected script.

- A lightweight JS observer is injected at document start via `adblock_inject.rs` (same pipeline as webrtc shim, farble shim)
- The observer uses `MutationObserver` + input event listeners to detect password fields
- When a password field appears/disappears, the script emits `form:detectionResult` with `{hasLoginForm, domain, tabId}`
- `form.rs` listens and relays as `form.state` events to the chrome
- The one-shot `detect_login_form` IPC is retained for explicit queries but the real-time detection is event-driven

**Detection script behavior:**

- Watches for `input[type="password"]` elements (added via MutationObserver or direct insertion)
- Also watches for `autocomplete="current-password"` fields (handles password managers that change the type)
- Reports the domain from `window.location.hostname` (or form action hostname if present)
- Debounces rapid changes (200ms) to avoid event storms during page load
- No detection on `about:blank`, `chrome://`, or other non-http origins

### 4.3 In-Page Badge + Auto-Fill (new `vault_inject.rs`)

**New module:** `vault_inject.rs` composes an injection script that handles the badge UI and autofill mechanics.

**Badge rendering:**

- A small lock/key icon (SVG, inline) positioned near the detected password field
- Styled with inline CSS (shadow DOM not available in main world)
- Positioned via `getBoundingClientRect()` of the password field, offset slightly (top-right corner)
- Re-positions on scroll/resize via `IntersectionObserver` + `resize` listener
- Themed to match common page styles (neutral gray, subtle shadow)

**Credential flow:**

1. Content script emits `form:detectionResult` with domain
2. Chrome receives `form.state` event → `useLoginFormDetector` updates
3. `useVaultDomainSuggestions` calls `vault.autofillSuggestions(domain)`
4. Chrome emits `vault.autofillData` event to content webview with `{count, labels: [{site, username}]}`
   - **Passwords are NEVER sent to the content webview** — only count + labels
5. Content script renders badge with count indicator
6. On badge click:
   - If 1 match: fills username + password fields immediately
   - If multiple: shows a small dropdown with credential labels (site + username)
   - User picks one → chrome emits `vault.autofillResult` event with `{username, password}` (one-time, scoped to this fill action)
   - Content script fills fields and clears the event data

**Fill mechanics:**

- Dispatches native `input` + `change` events on the fields (React/Angular/Vue-compatible)
- Sets `value` property directly, then fires events to trigger framework bindings
- Handles both `<form>` submit and standalone `<input>` fields
- Works with shadow DOM (if password field is inside a shadow root, traverses it)

**Security:**

- Vault passwords never persist in the content webview's JS context
- The `vault.autofillResult` event is consumed once and cleared
- No credentials are stored in `localStorage`, `sessionStorage`, or any content-side storage
- The badge script has no access to the vault — it only receives fill data for the current action

### 4.4 Save Prompt (post-submit)

**Detection:**

- The injected script listens for `submit` events on forms containing password fields
- Before the form submits, it captures `{domain, username, password}` and emits `form:willSubmit` to the chrome
- Also watches `beforeunload` as a fallback for JS-driven navigation

**Chrome-side prompt:**

- A non-blocking banner/infobar appears: "Save credential for {domain}?"
- Pre-fills the username from the submitted form
- User confirms → `vault.add({site: domain, username, password})` is called
- User dismisses → credential is not saved
- A "Never save for this site" option adds the domain to a per-site save-exclusion list (stored in settings)

**Timing:**

- The prompt appears after the page navigation completes (not during)
- This avoids blocking the navigation or losing the credential data
- The captured data is held in a short-lived in-memory buffer (cleared after prompt is handled or after 30s timeout)

### 4.5 Sync Integration

**New sync namespace:** `vault`

**Record format:** Vault records are already individually sealed with `crypto::seal(uuid|updatedAt|plaintext)` — the AAD binds identity so spliced records fail authentication. The sync server stores this opaque ciphertext.

**Merge strategy:** HLC last-writer-wins (same as `sync_stores.rs` for favorites/saved/history).

**Cross-device unlock constraint:** All synced devices must share the same master password. The DEK is derived from the master password via Argon2id + per-vault salt. If Device A and Device B have different master passwords, they cannot decrypt each other's records.

**Sync flow:**

1. `vault.add/update/remove` → emit `vault.changed` event
2. `sync.rs` picks up the change in its periodic background pass
3. POST sealed records to `/v1/records` (namespace: `vault`)
4. Other devices pull, merge via HLC, and locally decrypt
5. After merge, emit `vault.state` so the chrome updates the record count

**New file:** `sync_vault.rs` — namespace registration + merge handler for vault records.

**Modified files:**

- `vault.rs` — emit `vault.changed` after mutations
- `sync.rs` — register `vault` namespace in the pull/push loop

## 5. IPC Changes

### New Channels

| Channel                              | Direction           | Payload                         | Description                                |
| ------------------------------------ | ------------------- | ------------------------------- | ------------------------------------------ |
| `vault.autofillSuggestions`          | chrome → core       | `{domain: string}`              | Get matching credentials for a domain      |
| `vault.autofillSuggestions` response | core → chrome       | `VaultRecord[]`                 | Matching records (no passwords in summary) |
| `form.state`                         | core → chrome event | `{hasLoginForm, domain, tabId}` | Real-time login form detection state       |

### New Events

| Event                  | Payload                               | Description                                               |
| ---------------------- | ------------------------------------- | --------------------------------------------------------- |
| `form.state`           | `{hasLoginForm, domain, tabId}`       | Emitted when login form appears/disappears in a tab       |
| `vault.autofillData`   | `{count, labels: [{site, username}]}` | Sent to content webview for badge rendering               |
| `vault.autofillResult` | `{username, password}`                | One-time fill data sent to content webview on badge click |
| `form.willSubmit`      | `{domain, username, password}`        | Captured before form submission for save prompt           |

### Modified Channels

| Channel                   | Change                                                |
| ------------------------- | ----------------------------------------------------- |
| `vault.getState`          | Add `syncEnabled: boolean` to `VaultState`            |
| `vault.add/update/remove` | Emit `vault.changed` after mutation (for sync pickup) |

## 6. File Changes

### New Files

| File                               | Purpose                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| `src-tauri/src/vault_inject.rs`    | In-page badge + autofill JS injection (composes the content script) |
| `src-tauri/src/sync_vault.rs`      | Vault namespace handler for sync pull→merge→push                    |
| `src/components/AutofillBadge.tsx` | Chrome-side save credential prompt (infobar)                        |
| `src/hooks/useAutofillSave.ts`     | Hook managing save prompt state                                     |

### Restored Files (deleted during cleanup, recover from git)

| File                                     | Purpose                                                      |
| ---------------------------------------- | ------------------------------------------------------------ |
| `src/hooks/useVaultAutofill.ts`          | Thin wrapper calling `vault.autofillSuggestions`             |
| `src/hooks/useLoginFormDetector.ts`      | Listens to `form.state` events, manages detection state      |
| `src/hooks/useVaultDomainSuggestions.ts` | Chains detection + suggestions, fetches matching credentials |

### Modified Files

| File                                  | Change                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| `src-tauri/src/vault.rs`              | Add `autofillSuggestions` method, emit `vault.changed`, add `saveCredential`  |
| `src-tauri/src/form.rs`               | Replace one-shot eval with event-driven detection, emit `form.state`          |
| `src-tauri/src/adblock_inject.rs`     | Add `vault_inject::script()` to document-start injection pipeline             |
| `src-tauri/src/lib.rs`                | Wire `vault_inject` + `sync_vault` modules, register `form::install_listener` |
| `src-tauri/src/sync.rs`               | Register `vault` namespace in sync loop                                       |
| `shared/types.ts`                     | Add new channels/events/interfaces                                            |
| `src/lib/ipcClient.ts`                | Add listeners for `form.state`, `vault.autofillData`, `form.willSubmit`       |
| `src/components/VaultSettingsTab.tsx` | Restore autofill UI section, add sync status indicator                        |
| `src/autopilot/catalog.ts`            | Add `vault.autofill` exercise + verify round-trip                             |
| `src/autopilot/interactions/vault.ts` | Add autofill interaction specs                                                |

### Deleted Files

None (all changes are additive or modifications).

## 7. Platform Matrix

| Feature         | Linux          | Windows        | macOS          | Android                       |
| --------------- | -------------- | -------------- | -------------- | ----------------------------- |
| Form detection  | Injected JS    | Injected JS    | Injected JS    | Kotlin `NativeFormDetect` JNI |
| Badge rendering | Injected JS    | Injected JS    | Injected JS    | Kotlin overlay                |
| Auto-fill       | Injected JS    | Injected JS    | Injected JS    | Kotlin `evaluateJavascript`   |
| Save prompt     | Chrome infobar | Chrome infobar | Chrome infobar | Chrome `Snackbar`             |
| Vault sync      | `sync.rs`      | `sync.rs`      | `sync.rs`      | `sync.rs` (same path)         |

**Android specifics:**

- Form detection uses `NativeFormDetect` JNI getter (same pattern as `NativeFarble`, `NativeWebrtc`)
- Badge + autofill uses Kotlin's `WebView.evaluateJavascript` (not the Tauri eval path)
- Save prompt uses Material `Snackbar` (same pattern as `RedirectBar` on Android)

## 8. Security Considerations

1. **Passwords never in content webview JS context persistently** — the `vault.autofillResult` event is consumed once and cleared
2. **No credentials in content-side storage** — no `localStorage`, `sessionStorage`, cookies, or `indexedDB`
3. **Master password required** — vault must be unlocked for any autofill to work
4. **Private tabs excluded** — vault autofill is disabled in private/incognito tabs
5. **Per-site exclusion** — users can disable save prompts per domain
6. **Sync server sees only ciphertext** — same security model as all other synced stores
7. **Same master password required across devices** — enforced by the DEK derivation

## 9. Testing

### Unit Tests

- `vault.rs` — `autofillSuggestions` returns correct matches, empty on no match, respects private tab exclusion
- `form.rs` — event relay works, debouncing works, non-http origins skipped
- `vault_inject.rs` — script composition produces valid JS, placeholder substitution works
- `sync_vault.rs` — HLC merge works, tombstone propagation works

### Vitest Interaction Tests

- Form detection: navigate to fixture with login form → badge appears
- Auto-fill (single match): click badge → fields filled
- Auto-fill (multiple matches): click badge → dropdown appears → pick → fields filled
- Save prompt: submit login form → prompt appears → confirm → record added to vault
- Save dismissal: submit login form → prompt appears → dismiss → no record added

### Autopilot Coverage

- `vault.autofill` catalog entry with `verify` round-trip
- `form.detectLoginForm` catalog entry
- Interaction specs for badge click, save prompt confirm/dismiss

## 10. Implementation Order

1. **Restore hooks** — recover deleted hook files from git
2. **Vault backend** — add `autofillSuggestions` to `vault.rs`
3. **Form detection** — extend `form.rs` for event-driven detection
4. **Injection pipeline** — create `vault_inject.rs`, wire into `adblock_inject.rs`
5. **Badge + autofill** — implement the content-side badge UI and fill mechanics
6. **Save prompt** — implement `AutofillBadge.tsx` + `useAutofillSave.ts`
7. **Sync integration** — create `sync_vault.rs`, register namespace
8. **IPC wiring** — update `shared/types.ts`, `ipcClient.ts`, event listeners
9. **Android support** — Kotlin JNI for form detection + autofill
10. **Tests** — unit tests, vitest interaction specs, autopilot coverage
11. **Platform verification** — live test on Linux, Windows, macOS, Android
