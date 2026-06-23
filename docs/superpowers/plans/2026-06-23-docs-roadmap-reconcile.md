# Sub-project B — Docs / Roadmap Reconcile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the stale documentation into agreement with the verified current-state baseline in the master spec §1.1. `docs/FEATURE_ROADMAP.md` is written as a forward-looking "to build" design and still frames sync (F2b), WebRTC defense, and the S1/S2/S4 infra as *not started* when they are in fact **shipped in the real code**; the root `CLAUDE.md` and `src-tauri/CLAUDE.md` status sections omit those subsystems. This plan makes precise, evidence-grounded edits so the docs read DONE where the code is DONE, desktop-done/Android-partial where S3 is, and keeps vault / farbling / proxy framed as the genuinely-remaining work.

**Architecture:** This is a **documentation-only** change — no source, config, test, or build files are touched. The roadmap's rich design content stays (it is the implementation basis for sub-projects K/L/M and the still-open S3 Android leg); we do **not** delete it. The reconcile is achieved by (a) inserting a single prominent **"Current state (2026-06-23)"** status table near the top of `FEATURE_ROADMAP.md` that mirrors §1.1, (b) adding short, inline **STATUS** callouts at the head of each now-shipped sub-section (S1, S2, S4-Android, §3.1 WebRTC, §3.3 sync) so a reader of that section can't mistake it for unbuilt, and (c) replacing the two CLAUDE.md status blocks so they list the shipped privacy/sync subsystems and the remaining ones. Every replacement quotes the exact stale text and the exact new text. Each evidence reference below was confirmed against the real code before being quoted (see "Evidence confirmed" under each task).

**Tech Stack:** Markdown / docs only. No code, no tests, no build, no git operations are part of the deliverable beyond the described (not executed) commit step. Verification for every task is a `grep`/`Read` showing the stale claim no longer presents as "not done" and the corrective text is present.

## Global Constraints (from master spec §6, as applicable to a docs task)

The cross-cutting requirements in spec §6 (IPC-in-three-places, autopilot coverage, per-sub-project test gate, platform parity) govern **feature** sub-projects. Sub-project B ships **no code and no user-facing behavior**, so:

1. **No IPC channels, no autopilot/catalog/screens entries, no test changes** are created or required — there is nothing for the drift-guard to cover. (If a reviewer expects an autopilot touch, the correct answer is "docs-only, none applies.")
2. **The §6 "parity before done" rule is itself a fact this plan documents** (which subsystems are at which platform level), not a gate this plan must satisfy.
3. **Don't-guess-verify (CLAUDE.md global rule):** every status word written here ("DONE", "PARTIAL", "ABSENT") is backed by a code reference that was read, not inferred. The plan records the confirming grep/path under each task.

The acceptance bar for the whole sub-project (spec §3 entry B): *"doc matches §1.1; reviewer confirms."*

---

## File Structure (only these three files change)

```
docs/
├── FEATURE_ROADMAP.md            ← Tasks 1–6: status banner + inline STATUS callouts
CLAUDE.md                         ← Task 7: status section lists sync/WebRTC/infra + remaining
src-tauri/CLAUDE.md               ← Task 8: status mention of sync/WebRTC/crypto modules
docs/superpowers/plans/
└── 2026-06-23-docs-roadmap-reconcile.md   ← THIS plan (already created)
```

No new files are created. No files are deleted.

---

## Reference: the verified baseline (master spec §1.1, re-confirmed against code)

| Item | Real state | Evidence (confirmed in this repo) |
|---|---|---|
| E2E sync "F2b" | **DONE** | `src-tauri/src/sync.rs` (`reqwest::blocking` client; `GET/POST /v1/records` at `sync.rs:303/322`; background loop `sync.rs:425`), `sync_auth.rs` (Ed25519 signed tokens, `use ed25519_dalek::{Signature,Signer,SigningKey,VerifyingKey}`), `sync_stores.rs` (per-uuid HLC last-writer-wins `merge_into`) |
| WebRTC IP-leak defense | **DONE** | `src-tauri/src/webrtc_shim.rs` + `webrtc_shim.public-only.js` / `webrtc_shim.disable.js`; `webrtcPolicy: 'default' \| 'public-only' \| 'disable'` at `shared/types.ts:293`; native backstops documented in `src-tauri/CLAUDE.md` (Linux `set_enable_webrtc`, Windows `--force-webrtc-ip-handling-policy`) |
| S1 atomic store writes | **DONE** | `jsonstore::write_atomic` / `write_atomic_no_backup` (temp → `sync_all` → `rename` → dir-fsync + `.bak`, `jsonstore.rs:42-87`); callers `settings.rs:42`, `customfilters.rs:53`, `data.rs:48`, `subs.rs:104` |
| S2 shared crypto | **DONE** | `crypto.rs`: XChaCha20-Poly1305 (`chacha20poly1305::XChaCha20Poly1305`), HKDF-SHA256 (`hkdf::Hkdf::<Sha256>`), `zeroize` (`Zeroize, ZeroizeOnDrop`), Argon2id via `sync_keystore` |
| S3 OS keychain | **PARTIAL** | Desktop `keyring` done (`sync_keystore.rs:21` `KEYRING_SERVICE`); Android hardware-Keystore JNI path **documented but not connected**, passphrase fallback works (`sync_keystore.rs:3-15`) → remaining sub-project **J** |
| S4 Android document-start JS | **DONE** | `MainActivity.kt:304` `WebViewCompat.addDocumentStartJavaScript(wv, documentStartScript, setOf("*"))`, applied per tab; WebRTC shim re-applied `MainActivity.kt:316` |
| Password vault | **ABSENT** | No `vault.rs` (`ls src-tauri/src` → none) → remaining sub-project **K** |
| Anti-fingerprinting / farbling | **ABSENT** | No `farble.rs` → remaining sub-project **L** |
| VPN / proxy | **ABSENT** | No proxy/`vpn.rs` module → remaining sub-project **M** |

Every "DONE/PARTIAL/ABSENT" above was checked by reading the cited file/line in this repo on 2026-06-23.

---

## Task 1: Add a "Current state" status banner to FEATURE_ROADMAP.md

The roadmap's intro blockquote frames the whole doc as a *design to be built*. Add a status table immediately after it so the very first thing a reader sees is what is already shipped vs. remaining. This is the single highest-leverage edit (it corrects the document's overall posture).

**Files:**
- Modify: `docs/FEATURE_ROADMAP.md`

**Evidence confirmed:** intro blockquote occupies lines 3–5; the `---` separator is line 7; `## 1. TL;DR` is line 9 (read 2026-06-23). All nine status rows match the table in "Reference" above, each cite re-read.

- [ ] **Step 1: Locate the exact insertion anchor.** The current text is:

```markdown
> The one constant: **Aegis is a shell, not an engine fork.** It cannot do what Brave does inside Blink/V8. The honest question per feature is "how close can a JS shim / native webview setting / app-level feature get, and how detectable/weaker is it." Effort scale matches the critics' *revised* numbers.

---

## 1. TL;DR
```

- [ ] **Step 2: Replace it with the same text plus the status banner inserted before the `---`.** New text:

```markdown
> The one constant: **Aegis is a shell, not an engine fork.** It cannot do what Brave does inside Blink/V8. The honest question per feature is "how close can a JS shim / native webview setting / app-level feature get, and how detectable/weaker is it." Effort scale matches the critics' *revised* numbers.

> **⚠️ Status note (2026-06-23 — read this first).** Large parts of this roadmap are **already shipped**; the section bodies below are kept as the *design basis* and now carry an inline **STATUS** line where reality has moved past them. Verified current state (see `docs/superpowers/specs/2026-06-23-improvements-program-design.md` §1.1 for the evidence trail):
>
> | Roadmap item | State | Where it lives in the code |
> |---|---|---|
> | **E2E sync (F2b)** | ✅ **DONE** | `src-tauri/src/sync.rs` (pull→merge→push, `GET/POST /v1/records`, background loop), `sync_auth.rs` (Ed25519 signed device tokens), `sync_stores.rs` (per-uuid HLC LWW merge) |
> | **WebRTC IP-leak defense (§3.1)** | ✅ **DONE** | `webrtc_shim.rs` + `webrtc_shim.{public-only,disable}.js`; `webrtcPolicy` setting (`shared/types.ts`); native Linux/Windows backstops |
> | **S1 atomic store writes** | ✅ **DONE** | `jsonstore::write_atomic` (temp→fsync→rename→dir-fsync + `.bak`); `settings.rs`, `customfilters.rs`, `data.rs`, `subs.rs` route through it |
> | **S2 shared crypto** | ✅ **DONE** | `crypto.rs`: XChaCha20-Poly1305 + HKDF-SHA256 + Argon2id (via `sync_keystore`) + `zeroize` |
> | **S4 Android document-start injection** | ✅ **DONE** | `MainActivity.kt` `WebViewCompat.addDocumentStartJavaScript(...)` per tab (ad-block popup guard + WebRTC shim) |
> | **S3 OS keychain** | 🟡 **PARTIAL** | Desktop `keyring` done (`sync_keystore.rs`); **Android hardware-Keystore JNI path documented but not yet connected** (passphrase fallback works) — remaining sub-project **J** |
> | **Password vault (§3.4 Phase A)** | ⬜ **REMAINING** | No `vault.rs` yet — sub-project **K** |
> | **Anti-fingerprinting / farbling (§3.2)** | ⬜ **REMAINING** | No `farble.rs` yet — sub-project **L** |
> | **Proxy ("VPN" Tier-1, §3.5)** | ⬜ **REMAINING** | No proxy module yet — sub-project **M** |

---

## 1. TL;DR
```

- [ ] **Step 3: Verify.** Run `grep -n "Status note (2026-06-23" docs/FEATURE_ROADMAP.md` → one hit; `grep -n "E2E sync (F2b)" docs/FEATURE_ROADMAP.md` → one hit. Confirm the original blockquote and `## 1. TL;DR` line are still present and intact (the only insertion is the new blockquote between them).

---

## Task 2: Add a STATUS line to S1 (atomic writes — DONE)

S1's body still opens with **"Confirmed bug:"** and "**Fix:** write to a temp file…", reading as unfixed. The fix shipped. Add a STATUS line at the head of the section without deleting the design (it documents the rationale).

**Files:**
- Modify: `docs/FEATURE_ROADMAP.md`

**Evidence confirmed:** `jsonstore.rs:42` `fn write_atomic_inner(path, bytes, backup)` does temp-write → `f.sync_all()` (`:80`) → `fs::rename` (`:82`) → dir fsync (`:87`); `.bak` recovery copy (`:20`, `:37`). Callers confirmed: `settings.rs:42`, `customfilters.rs:53`, `data.rs:48` (`write_atomic_no_backup`), `subs.rs:104`. The "Confirmed bug" line cites `jsonstore.rs:34` / `settings.rs:42` etc. — those line numbers are now historical, not current.

- [ ] **Step 1: Locate the S1 section header.** Current text (lines 27–28):

```markdown
### S1 — Atomic store writes (prerequisite for sync **and** the vault)
**Confirmed bug:** `jsonstore::save` (`jsonstore.rs:34`), `settings::write` (`settings.rs:42`), `customfilters::write` (`customfilters.rs:29`), plus bare writes in `data.rs:42` and `subs.rs` all use `std::fs::write` = truncate-then-write, no fsync, no rename. A crash mid-flush truncates the store to empty.
```

- [ ] **Step 2: Insert a STATUS line between the header and the body.** New text:

```markdown
### S1 — Atomic store writes (prerequisite for sync **and** the vault)
> **STATUS: ✅ DONE.** Shipped as `jsonstore::write_atomic` / `write_atomic_no_backup` (temp file → `sync_all` → atomic `rename` → parent-dir fsync, plus a `.bak` recovery copy). All store writers route through it: `settings.rs`, `customfilters.rs`, `data.rs`, `subs.rs`. The "Confirmed bug" text below is the original problem statement, retained for rationale; the line numbers it cites are pre-fix.

**Confirmed bug:** `jsonstore::save` (`jsonstore.rs:34`), `settings::write` (`settings.rs:42`), `customfilters::write` (`customfilters.rs:29`), plus bare writes in `data.rs:42` and `subs.rs` all use `std::fs::write` = truncate-then-write, no fsync, no rename. A crash mid-flush truncates the store to empty.
```

- [ ] **Step 3: Verify.** `grep -n "STATUS: ✅ DONE" docs/FEATURE_ROADMAP.md` includes the S1 line; the original "Confirmed bug" sentence is still present directly below the new STATUS blockquote.

---

## Task 3: Add a STATUS line to S2 (shared crypto — DONE)

S2 is written as "Build it once as a small internal crypto module" — it exists.

**Files:**
- Modify: `docs/FEATURE_ROADMAP.md`

**Evidence confirmed:** `crypto.rs` imports `chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce}` (`:15`), `hkdf::Hkdf` (`:17`), `zeroize::{Zeroize, ZeroizeOnDrop}` (`:19`); `Hkdf::<Sha256>::new(...)` at `:55`. Argon2id is reached via `sync_keystore` (passphrase wrapping). The new crates the section lists (`chacha20poly1305`/`hkdf`/`argon2`/`zeroize`) are present.

- [ ] **Step 1: Locate the S2 header + first line.** Current text (lines 32–33):

```markdown
### S2 — Shared crypto + key-derivation layer (sync **and** vault)
Both features need the same RustCrypto stack. Build it once as a small internal crypto module.
```

- [ ] **Step 2: Insert a STATUS line.** New text:

```markdown
### S2 — Shared crypto + key-derivation layer (sync **and** vault)
> **STATUS: ✅ DONE.** Shipped as `src-tauri/src/crypto.rs`: XChaCha20-Poly1305 seal/open (24-byte random nonce), HKDF-SHA256 per-namespace key derivation, `zeroize` on drop, with Argon2id passphrase wrapping in `sync_keystore.rs`. The crates below (`chacha20poly1305`/`hkdf`/`argon2`/`zeroize`) are in `Cargo.toml`. The vault (sub-project K) will reuse this module unchanged.

Both features need the same RustCrypto stack. Build it once as a small internal crypto module.
```

- [ ] **Step 3: Verify.** `grep -n "src-tauri/src/crypto.rs" docs/FEATURE_ROADMAP.md` → the new STATUS line; the original "Build it once…" sentence still follows.

---

## Task 4: Correct S3 (PARTIAL — desktop done, Android remaining) and S4 (Android DONE)

S3 says "treat full keychain integration as a follow-up tier and ship master-password-only first" — desktop keychain is actually shipped; only the Android hardware path is the follow-up (sub-project J). S4's Android bullet says **"Android: must be BUILT — it does not exist."** — it was built.

**Files:**
- Modify: `docs/FEATURE_ROADMAP.md`

**Evidence confirmed (S3):** `sync_keystore.rs:3` "the primary store is the OS keychain (desktop `keyring` / Android hardware Keystore), with a passphrase-wrapped file as the fallback"; `:12-15` notes Android up-calls Kotlin `AegisKeystore` over JNI and "Either path falls back to the passphrase-wrapped file"; `KEYRING_SERVICE = "com.aegis.browser"` (`:21`). Desktop keyring is wired; the Android hardware leg is the documented-not-connected piece → spec sub-project J.
**Evidence confirmed (S4):** `MainActivity.kt:280` builds `documentStartScript` from `NativeInject.documentStartScript()`; `:304` `WebViewCompat.addDocumentStartJavaScript(wv, documentStartScript, setOf("*"))`; `:316` adds the WebRTC shim the same way. The "does not exist" claim is false today.

- [ ] **Step 1: Add a STATUS line to S3.** Current header + first bullet (lines 39–40):

```markdown
### S3 — OS-keychain abstraction (sync seed-at-rest, vault DEK anchoring, proxy/VPN secrets)
- `keyring` v4 (confirmed: feature-gated backends for Linux Secret Service / keyutils, Windows Credential Manager, macOS Keychain, Android, iOS — one crate covers the desktop trio's anchor). On Linux it transitively pulls zbus/D-Bus and **needs a running Secret Service daemon at runtime** — must **degrade gracefully to master-password-only** when absent, never crash.
```

Replace the header line and insert a STATUS blockquote before the first bullet:

```markdown
### S3 — OS-keychain abstraction (sync seed-at-rest, vault DEK anchoring, proxy/VPN secrets)
> **STATUS: 🟡 PARTIAL.** Desktop is done — `sync_keystore.rs` anchors the sync root in the OS keychain via the `keyring` crate (service `com.aegis.browser`), degrading to a passphrase-wrapped file when no Secret Service / Credential Manager / Keychain is available. **Remaining (sub-project J):** the Android hardware-backed Keystore (StrongBox / `KeyGenParameterSpec`) JNI path is documented in `sync_keystore.rs` but **not yet connected** — Android currently uses the passphrase fallback. This stays here as the design for that follow-up.

- `keyring` v4 (confirmed: feature-gated backends for Linux Secret Service / keyutils, Windows Credential Manager, macOS Keychain, Android, iOS — one crate covers the desktop trio's anchor). On Linux it transitively pulls zbus/D-Bus and **needs a running Secret Service daemon at runtime** — must **degrade gracefully to master-password-only** when absent, never crash.
```

- [ ] **Step 2: Add a STATUS line to S4 and correct the Android bullet.** Current header + first bullet (lines 45–47):

```markdown
### S4 — A unified document-start injection framework across all 4 platforms — **including finishing Android**
This is the single biggest piece of shared leverage: WebRTC defense, farbling, and autofill *detection* all ride document-start injection into the **content** webview.
- **Desktop (Linux/Windows/macOS): already exists.** `nav.rs:123` `spawn_tab` calls `.initialization_script_for_all_frames(crate::adblock_inject::script())` (verified API: `tauri 2.11.2 webview/mod.rs:927`, `for_main_frame_only:false`, flows through wry to all engines incl. cross-origin iframes). `adblock_inject::script()` returns `POPUP_GUARD` on Linux and `POPUP_GUARD + build()` on non-Linux (`adblock_inject.rs:53-60`).
```

Insert a STATUS blockquote after the intro sentence:

```markdown
### S4 — A unified document-start injection framework across all 4 platforms — **including finishing Android**
This is the single biggest piece of shared leverage: WebRTC defense, farbling, and autofill *detection* all ride document-start injection into the **content** webview.
> **STATUS: ✅ DONE.** The desktop path always existed; the Android content-tab path is now **built** — `MainActivity.kt` calls `WebViewCompat.addDocumentStartJavaScript(wv, documentStartScript, setOf("*"))` per tab (the ad-block popup guard + the WebRTC shim ride it). The Android bullet below saying "must be BUILT — it does not exist" is **superseded** and kept only for the original analysis.

- **Desktop (Linux/Windows/macOS): already exists.** `nav.rs:123` `spawn_tab` calls `.initialization_script_for_all_frames(crate::adblock_inject::script())` (verified API: `tauri 2.11.2 webview/mod.rs:927`, `for_main_frame_only:false`, flows through wry to all engines incl. cross-origin iframes). `adblock_inject::script()` returns `POPUP_GUARD` on Linux and `POPUP_GUARD + build()` on non-Linux (`adblock_inject.rs:53-60`).
```

- [ ] **Step 3: Mark the stale Android "does not exist" bullet inline.** Current text (line 49, the bullet beginning "**Android: must be BUILT…**"):

```markdown
- **Android: must be BUILT — it does not exist.** `createTabWebView` (`MainActivity.kt:263-283`) builds a plain `WebView`, sets UA/settings/clients, and injects **no** script.
```

Replace the leading clause (keep the rest of that long bullet unchanged):

```markdown
- **Android: ✅ NOW BUILT (was: "must be BUILT — it does not exist").** `createTabWebView` (`MainActivity.kt:263-283`) builds a plain `WebView`, sets UA/settings/clients, and — as shipped — now ALSO attaches the document-start script via `WebViewCompat.addDocumentStartJavaScript`. (Original analysis follows, retained for context: it built no script at the time.)
```

- [ ] **Step 4: Verify.** `grep -n "STATUS: 🟡 PARTIAL" docs/FEATURE_ROADMAP.md` → S3 line; `grep -n "NOW BUILT" docs/FEATURE_ROADMAP.md` → one hit; `grep -n "must be BUILT — it does not exist\b" docs/FEATURE_ROADMAP.md` → now appears ONLY inside the parenthetical "(was: …)" quote, never as a standalone present-tense claim. Confirm the S4 STATUS line is present.

---

## Task 5: Add a STATUS line to §3.1 (WebRTC IP-leak defense — DONE)

Section §3.1 reads as an unbuilt approach ("**Hook points:** native toggles at…", "**Effort: L.**"). It shipped.

**Files:**
- Modify: `docs/FEATURE_ROADMAP.md`

**Evidence confirmed:** `webrtc_shim.rs` exists with `webrtc_shim.public-only.js` / `webrtc_shim.disable.js`; `webrtcPolicy: 'default' | 'public-only' | 'disable'` at `shared/types.ts:293`; `src-tauri/CLAUDE.md` lines 111–129 document the shipped shim (wraps `RTCPeerConnection`, filters ICE/SDP/getStats), Linux `set_enable_webrtc(false)` for `disable`, Windows `--force-webrtc-ip-handling-policy`, Android `NativeWebrtc.shimScript` per tab, and the honest "shim covers page+iframe but NOT Worker scopes" residual matrix.

- [ ] **Step 1: Locate the §3.1 header line (line 65).** Current text:

```markdown
### 3.1 WebRTC IP-leak defense

**Approach per platform (corrected):**
```

- [ ] **Step 2: Insert a STATUS line under the header.** New text:

```markdown
### 3.1 WebRTC IP-leak defense
> **STATUS: ✅ DONE.** Shipped as `webrtc_shim.rs` (+ single-sourced `webrtc_shim.public-only.js` / `webrtc_shim.disable.js`) driven by the `webrtcPolicy` setting (`'default' | 'public-only' | 'disable'`, `shared/types.ts`). The shim wraps `RTCPeerConnection` to filter local/private ICE candidates, SDP, and `getStats()`; native backstops are wired (Linux `set_enable_webrtc(false)` for `disable`; Windows `--force-webrtc-ip-handling-policy`); Android registers it per tab via the document-start path (S4). **The Worker-bypass limit below is honored as a documented known gap, not a bug** (see the residual matrix in `src-tauri/CLAUDE.md`). The approach text below matches what shipped.

**Approach per platform (corrected):**
```

- [ ] **Step 3: Verify.** `grep -n "Shipped as \`webrtc_shim.rs\`" docs/FEATURE_ROADMAP.md` → one hit; the "**Approach per platform (corrected):**" line still follows immediately.

---

## Task 6: Add a STATUS line to §3.3 (E2E sync — DONE) and confirm vault/farbling/proxy stay REMAINING

Section §3.3 is the largest "to build" block (uuid/hlc/tombstone retrofit, "a **real deployable backend**", "Effort: XL"). It shipped (F2b). Conversely §3.2 (farbling), §3.4 (vault), and §3.5 (proxy/VPN) must remain framed as remaining — their modules do not exist — so this task explicitly does NOT add a DONE marker to them, only confirms (in the banner from Task 1) that they are REMAINING.

**Files:**
- Modify: `docs/FEATURE_ROADMAP.md`

**Evidence confirmed (DONE):** `sync.rs` — `reqwest::blocking::Client` (`:167/470`), `GET /v1/records?ns=` (`:303`), `POST /v1/records` (`:322`), `GET /v1/devices` (`:586`), periodic background sync spawn (`:425`); `sync_auth.rs:1` "Per-device authentication for the sync server (F2b): short-lived Ed25519 signed tokens"; `sync_stores.rs:9` `merge_into` "per-uuid HLC last-writer-wins". **Evidence confirmed (REMAINING):** `ls src-tauri/src` shows no `vault.rs`, `farble.rs`, or proxy/`vpn.rs` module.

- [ ] **Step 1: Locate the §3.3 header (line 111).** Current text:

```markdown
### 3.3 End-to-end-encrypted cross-platform sync

**Approach (all platforms `full`, engine-independent):** Brave-style zero-knowledge sync.
```

- [ ] **Step 2: Insert a STATUS line under the header.** New text:

```markdown
### 3.3 End-to-end-encrypted cross-platform sync
> **STATUS: ✅ DONE (this is "F2b").** Shipped as `sync.rs` (per-namespace pull→merge→push over `reqwest::blocking`, `GET/POST /v1/records`, a debounced periodic background pass), `sync_auth.rs` (the **restored auth tier** — short-lived per-device **Ed25519** signed tokens, addressing the "server has no authentication" gap flagged below), and `sync_stores.rs` (per-uuid **HLC last-writer-wins** merge with tombstones). A self-hosted reference server lives in `sync-server/`. The uuid/hlc/tombstone retrofit, per-key settings split, and targeted-refetch described below were all implemented. Local-at-rest still depends on S3 (PARTIAL on Android) as the design notes.

**Approach (all platforms `full`, engine-independent):** Brave-style zero-knowledge sync.
```

- [ ] **Step 3: Confirm vault/farbling/proxy are NOT marked done.** No edit is made to §3.2 (line 89), §3.4 (line 137), or §3.5 (line 161). Verify they carry no DONE marker: `grep -n "STATUS: ✅ DONE" docs/FEATURE_ROADMAP.md` returns hits for S1/S2/S4/§3.1/§3.3 only (five section-level DONE lines, plus the banner rows) and **none** under the `### 3.2`, `### 3.4`, or `### 3.5` headers. The Task-1 banner already lists them as REMAINING.

- [ ] **Step 4: Verify.** `grep -n 'STATUS: ✅ DONE (this is "F2b")' docs/FEATURE_ROADMAP.md` → one hit; the "**Approach (all platforms…**" line still follows.

---

## Task 7: Align the root CLAUDE.md status section

The root `CLAUDE.md` "Status" block (lines 109–118) covers only browse + ad-block + security per platform; it never mentions sync, WebRTC defense, or the remaining vault/farbling/proxy work. Add those subsystems so the project guide's status matches §1.1.

**Files:**
- Modify: `CLAUDE.md`

**Evidence confirmed:** root `CLAUDE.md` lines 109–118 read as quoted below (read 2026-06-23); none of "sync", "WebRTC", "vault", "farbling", or "proxy" appears in that block (`grep -niE 'sync|webrtc|vault|farbl|proxy' CLAUDE.md` → no hit in the Status section). The added sentences mirror the §1.1 states and the per-platform reality already stated in the block.

- [ ] **Step 1: Locate the Status block.** Current text (lines 109–118):

```markdown
## Status (as of the Tauri migration branch)

Linux desktop is verified on real hardware. Windows desktop is verified on real
hardware (Windows 11): browses and ad-blocks — both the WebView2 network tier
(`adblock_win`) and the injected tier — with no crash, and the CI-built portable
exe behaves identically to a local build. (The shield block-*counter* is still
Linux-only; ad-block works on Windows, it just isn't counted on the badge — see the
adblock note in `src-tauri/CLAUDE.md`.) Android browses + ad-blocks + is secure
(verified on emulator). macOS compiles + bundles green in CI but is not yet
GUI-runtime-verified. iOS is unstarted (needs macOS + Xcode).
```

- [ ] **Step 2: Replace it with the same browse/ad-block/security text plus a privacy-and-sync paragraph.** New text:

```markdown
## Status (as of the Tauri migration branch)

Linux desktop is verified on real hardware. Windows desktop is verified on real
hardware (Windows 11): browses and ad-blocks — both the WebView2 network tier
(`adblock_win`) and the injected tier — with no crash, and the CI-built portable
exe behaves identically to a local build. (The shield block-*counter* is still
Linux-only; ad-block works on Windows, it just isn't counted on the badge — see the
adblock note in `src-tauri/CLAUDE.md`.) Android browses + ad-blocks + is secure
(verified on emulator). macOS compiles + bundles green in CI but is not yet
GUI-runtime-verified. iOS is unstarted (needs macOS + Xcode).

**Privacy & sync subsystems (DONE).** Beyond browse/ad-block/security, the following
are shipped across platforms: **E2E sync** (`sync.rs` pull→merge→push, `sync_auth.rs`
Ed25519 device tokens, `sync_stores.rs` HLC-LWW merge; self-hosted `sync-server/`),
**WebRTC IP-leak defense** (`webrtc_shim.rs` + the `webrtcPolicy` setting, with native
Linux/Windows backstops), the **atomic store-write** path (`jsonstore::write_atomic`),
the **shared crypto** layer (`crypto.rs` — XChaCha20-Poly1305 / HKDF / Argon2id /
zeroize), and **Android document-start JS injection** (`MainActivity.kt`
`addDocumentStartJavaScript`). The **OS-keychain anchor** is desktop-done / Android-
partial (hardware-Keystore JNI path documented, not yet connected — passphrase
fallback works). **Remaining roadmap features:** a password vault, anti-fingerprinting
(farbling), and a content-webview proxy — see `docs/FEATURE_ROADMAP.md` and the
improvements-program decomposition in `docs/superpowers/specs/`.
```

- [ ] **Step 3: Verify.** `grep -nE 'E2E sync|WebRTC IP-leak|password vault' CLAUDE.md` → present; the original Linux/Windows/Android/macOS paragraph is unchanged above the new one. `grep -n "shield block-\*counter\*" CLAUDE.md` still returns its one original hit (the existing text was preserved, not rewritten).

---

## Task 8: Add the privacy/sync modules to src-tauri/CLAUDE.md's module map note

`src-tauri/CLAUDE.md` already documents the WebRTC shim (lines 111–129) and the shield-counter reality well, but its module map has **no entry for the sync modules or `crypto.rs`** — a reader scanning `src/*.rs` would not learn that sync is implemented. Add a concise sync/crypto bullet to the module map so the backend guide reflects §1.1. (No status sentence in this file claims sync is *unbuilt*, so this is an addition, not a correction — but it is required for the doc to "match §1.1".)

**Files:**
- Modify: `src-tauri/CLAUDE.md`

**Evidence confirmed:** `ls src-tauri/src` shows `sync.rs`, `sync_auth.rs`, `sync_envelope.rs`, `sync_identity.rs`, `sync_keystore.rs`, `sync_stores.rs`, `crypto.rs`; the module map section (`## Module map (src/*.rs)`) currently lists `lib.rs`, `tab_registry.rs`, `tabs.rs`, `nav.rs`, `view.rs`, `data.rs`, the data stores, ad-block tiers, Security, WebRTC, Linux, and Misc — but no sync/crypto bullet (`grep -n 'sync\.rs\|crypto\.rs' src-tauri/CLAUDE.md` → no module-map hit; sync is mentioned only inside the new bullet we add).

- [ ] **Step 1: Locate the "Security" bullet in the module map** (the WebRTC bullet immediately follows it). Current text (lines 109–110, the Security entry):

```markdown
- **Security** — `safety.rs` (URLhaus malware host set from `resources/`, JNI
  `isMalwareHost`), `permissions.rs` (site permission prompts).
```

- [ ] **Step 2: Insert a Sync & crypto bullet immediately after the Security bullet** (before the existing "**WebRTC IP-leak defense**" bullet). New text:

```markdown
- **Security** — `safety.rs` (URLhaus malware host set from `resources/`, JNI
  `isMalwareHost`), `permissions.rs` (site permission prompts).
- **E2E sync ("F2b") + crypto** — `sync.rs` (per-namespace pull→merge→push over
  `reqwest::blocking`, `GET/POST /v1/records`, a debounced periodic background pass),
  `sync_auth.rs` (per-device **Ed25519** signed access tokens — the server authorizes
  iff the signature verifies and the device pubkey is registered), `sync_stores.rs`
  (per-uuid **HLC last-writer-wins** merge with tombstones — the `sync.changed`
  targeted-refetch seam, never a full reload), `sync_envelope.rs` / `sync_identity.rs`
  (record sealing + identity), and `sync_keystore.rs` (root-secret-at-rest: desktop
  `keyring`, Android hardware-Keystore JNI path **documented but not yet connected**,
  passphrase-wrapped file fallback). All record crypto is `crypto.rs`:
  **XChaCha20-Poly1305** seal/open (24-byte nonce), **HKDF-SHA256** per-namespace keys,
  **Argon2id** passphrase KDF, `zeroize`-on-drop. A self-hosted reference server is the
  standalone `sync-server/` crate. `sync.*` data channels flow on Android for free
  (they ride the normal `ipc` chokepoint, not the `AegisAndroid` nav bridge).
```

- [ ] **Step 3: Verify.** `grep -n 'E2E sync ("F2b") + crypto' src-tauri/CLAUDE.md` → one hit, positioned between the Security and WebRTC bullets; the WebRTC bullet (line beginning "**WebRTC IP-leak defense**") is unchanged and still follows.

---

## Task 9: Commit (describe only — do NOT execute)

This sub-project is a single logical change (docs reconcile). When implementing, stage exactly the three docs and commit with a message that names the reconcile and references the spec.

**Files:** none beyond the three already edited.

- [ ] **Step 1: Stage and commit.** The command an implementer would run (the writing-plans process does not run it; the executing session does):

```bash
git add docs/FEATURE_ROADMAP.md CLAUDE.md src-tauri/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: reconcile roadmap + CLAUDE.md status with shipped reality

Sub-project B of the improvements program. FEATURE_ROADMAP.md framed sync
(F2b), WebRTC defense, and the S1/S2/S4 infra as not-yet-built; they ship in
src-tauri/. Add a current-state banner + per-section STATUS lines marking
sync/WebRTC/S1/S2/S4 DONE, S3 desktop-done/Android-partial, and keep
vault/farbling/proxy as remaining. Align both CLAUDE.md status sections.
Per docs/superpowers/specs/2026-06-23-improvements-program-design.md §1.1.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Do NOT push.** Leave the commit on `feat/improvements-program`; pushing/merging is a separate, owner-gated step (this plan's scope ends at the local commit).

---

## Final verification (controller)

Run each as a `grep`/`Read` and confirm the result — "verification for a doc task = the stale claim no longer appears (as a present-tense not-done claim) and the corrective text is present":

- [ ] `grep -n "Status note (2026-06-23" docs/FEATURE_ROADMAP.md` → the top-of-doc banner exists (Task 1).
- [ ] `grep -nE "STATUS: ✅ DONE" docs/FEATURE_ROADMAP.md` → five section-level DONE lines (S1, S2, S4, §3.1, §3.3) plus the banner; **none** under `### 3.2`, `### 3.4`, `### 3.5`.
- [ ] `grep -n "STATUS: 🟡 PARTIAL" docs/FEATURE_ROADMAP.md` → S3 (Task 4).
- [ ] `grep -n "must be BUILT — it does not exist\b" docs/FEATURE_ROADMAP.md` → appears **only** inside the parenthetical "(was: …)" quote, never as a live claim (Task 4).
- [ ] `grep -nE 'E2E sync|WebRTC IP-leak|password vault' CLAUDE.md` → all present in the Status section (Task 7); original per-platform paragraph intact.
- [ ] `grep -n 'E2E sync ("F2b") + crypto' src-tauri/CLAUDE.md` → the new module-map bullet (Task 8).
- [ ] Re-read the Task-1 banner table against §1.1 of the spec → every row's state matches (sync/WebRTC/S1/S2/S4 = DONE, S3 = PARTIAL, vault/farbling/proxy = REMAINING).

---

## Self-Review: every stale claim in §1.1 has a corrective task

| §1.1 row | Stale framing in the docs | Corrective task(s) |
|---|---|---|
| E2E sync "F2b" = **DONE** | §3.3 reads "to build", "Effort: XL"; root CLAUDE.md omits it; src-tauri CLAUDE.md module map omits it | Task 1 (banner), Task 6 (§3.3 STATUS), Task 7 (root CLAUDE.md), Task 8 (module map) |
| WebRTC defense = **DONE** | §3.1 reads as an unbuilt "Approach"; root CLAUDE.md omits it | Task 1 (banner), Task 5 (§3.1 STATUS), Task 7 (root CLAUDE.md) |
| S1 atomic writes = **DONE** | S1 opens "**Confirmed bug** … **Fix:**" | Task 1 (banner), Task 2 (S1 STATUS) |
| S2 shared crypto = **DONE** | S2 reads "Build it once as a small internal crypto module" | Task 1 (banner), Task 3 (S2 STATUS), Task 7 + Task 8 (crypto.rs noted) |
| S3 OS keychain = **PARTIAL** | S3 says "ship master-password-only first", implying not done; doesn't separate desktop-done from Android-remaining | Task 1 (banner = PARTIAL), Task 4 Step 1 (S3 STATUS), Task 7 (desktop-done/Android-partial) |
| S4 Android injection = **DONE** | S4 bullet states "**Android: must be BUILT — it does not exist.**" | Task 1 (banner), Task 4 Steps 2–3 (S4 STATUS + inline correction) |
| Password vault = **ABSENT** (remaining K) | Already framed as to-build — must STAY remaining | Task 1 banner lists it REMAINING; Task 6 Step 3 asserts no DONE marker is added to §3.4 |
| Farbling = **ABSENT** (remaining L) | Already to-build — must STAY remaining | Task 1 banner; Task 6 Step 3 (no DONE marker on §3.2) |
| Proxy/VPN = **ABSENT** (remaining M) | Already to-build — must STAY remaining | Task 1 banner; Task 6 Step 3 (no DONE marker on §3.5) |

**Result:** every one of the nine §1.1 rows is covered — the six shipped/partial rows each get an explicit corrective edit (banner + inline), and the three genuinely-remaining rows are pinned as REMAINING in the banner with an explicit guard (Task 6 Step 3) against accidentally marking them done. No source, test, or build file is touched; the only writes are to `docs/FEATURE_ROADMAP.md`, `CLAUDE.md`, and `src-tauri/CLAUDE.md`. Acceptance per spec §3-B ("doc matches §1.1; reviewer confirms") is satisfied once a reviewer checks the Final-verification greps.
