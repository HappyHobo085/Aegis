# Audit fix plan — 2026-11-02

Source: full read-only codebase audit (2026-11-02). Every finding below was either re-read and
confirmed in code by the coordinating session (**✔**) or reported by a reviewer and NOT yet
re-confirmed (**R**). For every **R** item, reproduce/confirm first; if it does not hold, drop it
and say so. Line numbers are from commit `d83d486` + the uncommitted Tauri CLI bump — re-locate
by symbol, not line.

## Ground rules for the fixing session

1. Read `AGENTS.md`, `src-tauri/AGENTS.md`, `src/AGENTS.md`, `sync-server/AGENTS.md`,
   `scripts/AGENTS.md`, `.github/AGENTS.md` before touching an area.
2. **Test first.** Each fix lands with a test that fails on the current code (run it red, then
   green). Rust: unit test in the owning module. Renderer: drive the real UI / real
   `ipcClient` module, not `aegisMock` alone.
3. **Platform parity** (AGENTS.md): a fix for a cross-platform behaviour covers Linux, Windows,
   macOS, Android in the same task, or the task is not done.
4. Update the stale `AGENTS.md` lines in the same change (they are living docs).
5. Never commit/push without the owner's explicit OK. One commit per phase is the suggested
   granularity; ask before committing.
6. Gates after each phase (use these exact invocations — `node_modules/.bin` is currently empty,
   run `npm install` first or call tools by path):
   - `npm test` (or `node node_modules/vitest/vitest.mjs run`)
   - `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
   - `npm run lint`
   - `cd src-tauri && cargo clippy --all-targets --locked && cargo test --locked`
   - `cd sync-server && cargo clippy --all-targets --locked && cargo test --locked`
   - `npm run test:coverage && npm run coverage:ratchet` — regenerate the baseline if the file
     list/totals changed (see AGENTS.md "Test coverage").
7. Windows/macOS/Android code cannot be compiled here for every target; say which targets were
   actually built and which were only reviewed.

## Decisions — RESOLVE WITH THE OWNER BEFORE STARTING (one question each)

Recommendation given for each; the owner decides.

**Owner answers (2026-11-03):** D1 optional secret + boot warning + global caps · D2 yes (owner
approval) + document rotate-root · D3 reject http + refuse https→http · D4 **`webrtcPolicy` only**
(proxy keeps syncing) · D5 **auto-transfer ownership** · D6 fail + opt-out env · D7 yes, last in
Phase 2 · 6.5 remove the no-op env.

- **D1 Sync-server registration gate** (Phase 1.2): add `AEGIS_SYNC_REGISTRATION_SECRET` env
  (required to register a NEW account) + global record/byte caps. _Rec: yes, secret optional but
  warn loudly at boot when unset._
- **D2 Device revocation semantics** (Phase 1.4): new device registration for an EXISTING
  account requires owner-device approval? _Rec: yes; and document that true revocation =
  rotate the root._
- **D3 Plain-http filter subscriptions** (Phase 4.1): reject `http://` outright? _Rec: reject;
  also refuse https→http redirects._
- **D4 Local-only settings** (Phase 4.4): add `webrtcPolicy` and `proxy` to `LOCAL_ONLY_KEYS`?
  This changes current deliberate behaviour (`proxy.rs` syncs proxy on purpose). _Rec: yes, both._
- **D5 Owner self-removal** (Phase 1.5): refuse while other devices exist vs. auto-transfer
  ownership. _Rec: refuse with a clear error._
- **D6 Android release signing** (Phase 6.4): fail release builds when `keystore.properties` is
  absent (opt-out env for local dev)? _Rec: yes._
- **D7 Argon2 parameters** (Phase 2.7): raise under a versioned KDF header (e.g. 64 MiB, t=3).
  Migration on next unlock. _Rec: yes, but schedule last in Phase 2._

---

## Phase 1 — Sync server + transport (security)

1.1 ✅ **✔ Nonce map fillable by unregistered callers** — `sync-server/src/main.rs` `verify_auth`
(~132-178). Move registration check before nonce insert (for `post_device`, verify the
account-root signature first); cap `token.nonce` length (≤64 hex). Fix the false comment.
Test: unregistered device_id with valid self-signature → 401 and map size unchanged.
1.2 ✅ **R Unlimited accounts** — `post_device` (~1493). Per D1. Test: registration without secret
refused when set; global cap returns 507/429.
1.3 ✅ **R `hlc`/`ord` unbounded** — push handler (~1391) / `page_records` (~1307). Validate `hlc`
shape `{wall_ms,counter,node}` with `node` ≤64; ignore client-sent `ord`; count serialized
hlc/ord in `MAX_RESPONSE_BYTES`. Also reject empty `ns` on POST (~1388) and return 400 not
413 on GET.
1.4 ✅ **R Revocation bypass** — normalise every hex id to lowercase at parse (`unhex` ~59 accepts
upper); deny-list on normalised key; D2.
1.5 ✅ **R Owner self-removal strands account** (~1578-1605). Per D5.
1.6 ✅ **R Retried push returns ok without persisting** (~1437-1458). Add a dirty flag; persist when
dirty even if `changed=false`. Test with an injected persist failure.
1.7 ✅ **R Whole-store rewrite per push + no dir fsync** (~914-933). At minimum fsync the directory
after rename (reuse the pattern from `src-tauri/src/jsonstore.rs`). Per-account files are a
larger refactor — note as follow-up, don't do it here unless trivial.
1.8 ✅ **✔ Insecure-URL check bypass via `\`** — `src-tauri/src/sync.rs` (~1262-1290). Parse with the
`url` crate and check `host()`. Test: `http://evil.com\@127.0.0.1:8787` rejected;
`http://[::1]:8787`, `http://127.0.0.1` accepted.
1.9 ✅ **R Self-removed device keeps syncing into 403s** — `sync.rs` (~1527-1561): disable sync after
self-removal.
1.10 ✅ **R systemd**: `systemd/aegis-sync-server.service` probe honours `AEGIS_SYNC_PORT`;
`wait-for-bind-address.sh` matches `inet6` for IPv6.

## Phase 2 — Sync data integrity + vault

2.1 ✅ **✔ Remote far-future HLC wins forever** — `src-tauri/src/sync_stores.rs` `merge_records`
(~120-147). Refuse/quarantine remote records with `wall_ms > now + MAX_REMOTE_SKEW_MS`
(`sync_envelope.rs:114`). Check the same in `settings.rs` `merge_projection` (~657) and
`sync_vault.rs`. Test: remote `wall_ms = now + 1 year` does not replace local.
2.2 ✅ **✔ Vault LWW uses raw wall clock** — `vault.rs` `update_record` (~1054) stamps `now`; merge
(~757). Stamp `max(now, prev+1)` (as `vault.remove` ~1449 already does) and bound remote
`updatedAt`. Test: skewed-peer edit does not beat a later local edit.
2.3 ✅ **R Settings import reverted by next sync** — `settings.rs` `apply_imported` →
`rebuild_projection_from_current` (~721) → `ensure_sync_projection` stamps `Hlc::zero`
(~579). Import must stamp fresh HLCs (`tick`). Fix the doc comment at ~720. Test: import, then
merge a server projection with older-than-now HLCs → import survives.
2.4 ✅ **R `.bak` copies of key material survive** — `jsonstore.rs` (~113-127) +
`sync_keystore.rs` `store_root`/`clear_root`. Use `write_atomic_no_backup` for key blobs;
delete `*.bak` on clear/replace. Test: after `clear_root`, no `sync-vault.json*` remains.
2.5 ✅ **R Import races sync** — `data.rs` `import_blocking` (~422) saves without
`with_store_lock`. Wrap per store.
2.6 ✅ **R Autofill host match inverted** — `vault.rs` `autofill_suggestions` (~985-1005) and the
test at ~2580 that asserts the wrong direction. Child→parent, eTLD+1-aware (check whether a
PSL crate is already in `Cargo.lock` before adding one; adding a dep needs owner OK).
2.7 ✅ **R Argon2 defaults** — `vault.rs` ~211, `sync_keystore.rs` ~73. Per D7.
2.8 ✅ **R Smaller vault items** (metadata-return sub-item NOT done — see ledger/ruling): vault tombstone GC (~349); `vault.add/update/remove` return
metadata not all plaintext passwords (~1189) — check renderer callers; `device_local_salt`
(~283) must error instead of minting a fresh salt on save failure; `AegisKeystore.kt` ~73
catch broader exception for StrongBox → TEE fallback; zeroize in `keyring_get` (~430).
2.9 ✅ **R `vault_inject.js` runs in all frames** (Android `setOf("*")`, MainActivity.kt ~987) —
restrict to top frame before autofill Phase B. Low priority while the bridge is inert; do it
if cheap.

## Phase 3 — Private-mode leaks (all platforms)

3.1 ✅ **R Android: popup from private tab opens non-private** — `MainActivity.kt` ~756,
`src/components/mobile/MobileApp.tsx` ~204, `tabs.rs` ~247. Pass opener privateness through
`__aegisOpenTab(url, isPrivate)` → `tabs.create(url, true, isPrivate)`. Component test.
3.2 ✅ **✔ Blocked-redirect background tab ignores privateness** — `redirect_guard.rs`
`on_blocked_redirect_to_new_tab` passes `false` (~377) and ignores `_tab`. Use
`tabs::is_private(tab)`; for Android (tab 0 at ~729) pass the real tab id/flag through JNI.
3.3 ✅ **R `is_private` fails open after close** — `tabs.rs` ~188; callers `nav.rs` ~763/791/832,
`linux_layout.rs` ~211. Capture `private` at spawn into the callback closures.
3.4 ✅ **R Private download completes someone else's row** — `downloads.rs` `on_finished`
(~281-304). No newest-in-progress fallback when a URL is given.
3.5 ✅ **R `PendingNavs` not cleared on tab close** — `tabs.rs` `forget_closed_tab` (~508).

## Phase 4 — Ad-block / content protection

4.1 ✅ **✔ Subscriptions: http allowed, no size cap** — `subs.rs` `subs.add` (~387), `fetch_text`
(~101-113). Per D3; read body with a hard cap (e.g. 16 MiB, streaming `take`), refuse
https→http redirect (custom redirect policy).
4.2 ✅ **R Linux content-filter cache loads wrong rules** — `lib.rs` ~374 marker by hash vs
`adblock_webkit.rs` ~183 fixed ids `aegis-{i}`; concurrent `install_adblock` race (~76-80);
stale higher-index filters not removed (~112-131). Make ids include the source hash (or clear
the store before save), serialise installs, remove filters beyond new chunk count. Verify
WebKit `add_filter` id semantics from the webkit2gtk docs/source before deciding.
4.3 ✅ **R Engine rebuild stalls UI** — `adblock_engine.rs` QUERY_TIMEOUT 5 s (~116, ~444-463);
`refresh` file reads on IPC thread (`lib.rs` ~351, `adblock_refresh.rs` ~35). During rebuild,
answer from the previous engine instead of waiting.
4.4 ✅ **✔ Synced settings can disable WebRTC protection / set proxy** — `settings.rs`
`LOCAL_ONLY_KEYS` (~319). Per D4; update `proxy.rs` ~361 comment + AGENTS.md.
4.5 ✅ **✔ Windows COM string leaks** — `adblock_win.rs` (~91, ~111), `nav_policy_win.rs` (~47, ~52,
plus missing null check), `nav_url_win.rs` (~85, ~98). Free with `CoTaskMemFree` (mirror wry's
`take_pwstr`). Cross-check with `scripts/build-windows-portable-cross.sh` that it compiles.
4.6 ✅ **R WebRTC public-only shim bypass** — `webrtc_shim.public-only.js` ~78-167: wrappers are own
props; prototype methods/getters unfiltered. Patch on the prototype (and `localDescription`
getters, `addEventListener` for `icecandidate`). Runtime test in the existing shim test style
(indirect eval, global scope).
4.7 ✅ **R Farble gaps** — `farble.standard.js`/`farble.strict.js`: OffscreenCanvas
(`getImageData`, `convertToBlob`); `toDataURL/toBlob` must serialise a scratch copy, never
`putImageData` back into `this` (~255-280); opaque-origin (`"null"`) frames need a per-frame
salt (~127-135); mark the `Function.prototype.toString` override native (~210). Extend
`src/lib/farbleShim.test.ts`.
4.8 ✅ **✔ Picker host spoofable** — `picker.rs` `on_picked` (~380) uses payload `host`. Take host
from the active tab's webview URL. Fix doc at ~231.
4.9 ✅ **R Smaller** (find-shim nonce dropped — see ledger): `adblock_engine::host_of` strip `?#` (~69); injected `fetch` wrapper handle
`URL`/`Request` objects (`adblock_inject.rs` ~303); find-shim title signal nonce
(`find_shim.js` ~123); Android popup capture WebView sets `CHROME_UA` (MainActivity.kt ~711);
docs: `adblock_refresh.rs` ~10 ("blocks everywhere" — false on macOS), `webrtc_shim.rs` JNI doc.

## Phase 5 — Renderer

5.1 ✅ **✔ Dedup cache serves stale data** — `src/lib/ipcClient.ts` `dedupedCall` (~240-276). Dedup
in-flight only (evict on settle), or invalidate namespace on any mutation/event. Fix
`ipcClient.test.ts` ~364 which asserts the buggy reuse. Add a contract test through the real
module: read → mutate/event → read issues a second `invoke`.
5.2 ✅ **✔ Second permission prompt replaces first** — `src/hooks/usePermissions.ts` ~31. FIFO queue.
Test: two prompts → both shown in turn, both resolved.
5.3 ✅ **R Seed fetch overwrites newer event** — `useNav.ts` ~42, `useAdblock.ts` ~39,
`useDownloads.ts` ~30, `useTabs.ts` ~26: skip seed result if an event arrived first.
5.4 ✅ **R Clipboard not cleared when Settings closes** — `VaultSettingsTab.tsx` ~37-47. Module-level
timer.
5.5 ✅ **R `listen()` rejection unhandled** — `src/lib/tauriInvoke.ts` ~27.
5.6 ✅ **R Permission prompt lacks tab id** — `permissions.rs` ~206 + prompt dialog.
5.7 ✅ **R Lint** _(measured 2026-11-04: 14 warnings in 7 files — App.tsx 7, MobileApp.tsx 2, AdblockShield/TabStrip/useChromeHeights/useHistory/usePopoverSurface 1 each; owner chose enable + fix all; done: rule is an error, 13 fixed, `useChromeHeights` has a justified inline disable)_: `react-hooks/exhaustive-deps` is off (`eslint.config.mjs` ~122). Turning it on is
likely noisy — measure the warning count first and ask the owner before enabling.

## Phase 6 — Release / CI / build

6.1 ✅ **✔ No updater artifacts** — `tauri.conf.json` lacks `bundle.createUpdaterArtifacts: true`.
Add it; make `tauri-release.yml` preflight fail when `latest.json` is missing. Verify the key
name against `node_modules/@tauri-apps/cli/config.schema.json`.
6.2 ✅ **✔ Unpinned `actions-rust-lang/setup-rust-toolchain@v1`** — `tauri-release.yml` ~117, ~291,
`ci.yml`, `tauri-build-check.yml`. Pin to SHA; `persist-credentials: false` on release
checkout. Fix the "one third-party action" comment (~173).
6.3 ✅ **R Tag vs `tauri.conf.json` version not checked** — preflight (~56). Fail on mismatch.
6.4 ✅ **R Android release signing silently debug** — `build.gradle.kts` ~67. Per D6. Also
**R** Android update check can never fire (`update.rs` ~61) — needs a stable key + an
`android` entry in `latest.json`; do after D6.
6.5 ✅ **R Windows signing env is a no-op** — `tauri-release.yml` ~193. Either implement (pfx import +
`signCommand`/thumbprint) or remove the env and the "present" claim. Ask owner which.
6.6 ✅ **✔ Gradle wrapper has no `distributionSha256Sum`** — add the official checksum for 8.14.3
(fetch from gradle.org's published `.sha256`; do not guess).
6.7 ✅ **R `repack-appimage-gstreamer.sh` runs unchecked download** — pin a versioned appimagetool
URL + `sha256sum -c`.
6.8 ✅ **✔(partial) Cross-compile exe may be a dev build** — `scripts/build-windows-portable-cross.sh`
~38 uses plain `cargo build` with no `custom-protocol` feature. FIRST verify (build, then check
whether the exe loads `devUrl`); if confirmed, add `--features tauri/custom-protocol` (or a
crate feature) and document.
6.9 ✅ **R Smaller**: `-- --locked` on tauri-action args; pin `cargo install … --version`; coverage
ratchet: fail when a file is newly added to `coverage.exclude`/Rust `EXCLUSIONS` in the same
commit (`coverageCheck.mjs` ~127-161); Rust exclusions match full path not basename
(`rustCoverageCheck.mjs` ~196); `build-windows-portable.ps1` honour `CARGO_TARGET_DIR`;
attest/Android jobs and a red desktop leg (document or `if: !cancelled()`).

## Phase 7 — Remaining correctness (lower priority)

7.1 ✅ **✔ Android HTTPS-Only toggle needs restart** — `settings.rs` `apply_local` (~1146) never calls
`note_https_only` (only `write()` ~164 and boot `lib.rs` ~801 do). Call it in `apply_local`;
test via `apply_local`, not `write()`.
7.2 ✅ **R Settings cache race** — `settings.rs` ~407-413: re-check generation under the write lock.
7.3 ✅ **R `apply_synced` wipes local-only keys when file unreadable** — `settings.rs` ~748.
7.4 ✅ **R Redirect-guard false positives** (http→https, apex→www) — `redirect_guard.rs` ~47-54:
same-site relaxation. Needs care; write tests for each case first.
7.5 ✅ **R macOS WKWebView leak** — `nav_url_mac.rs` ~73/143/205/216: observers hold strong refs and
are `mem::forget`-ed. Use weak refs / remove observers on close. Can't build macOS here —
CI build-check only; mark runtime verify PENDING.
7.6 ✅ **R Downloads filename** — `downloads.rs` ~167: prefer engine-suggested name, sanitise,
length cap, `(n)` de-dup.
7.7 ✅ **R Misc**: JNI null returns vs Kotlin non-null (`permissions.rs` ~372/415 → return `""`);
`GestureContainer.kt` ~174 cancel stale timeout; `places.rs` `*.update` field allowlist +
`favorites.add` URL validation.
7.8 ✅ **✔ `jsonstore.rs` tests leak temp dirs** — each `cargo test` run leaves ~12
`$TMPDIR/aegis-jsonstore-*` dirs (bak, bakfail, concurrent, failtmp, load, nobak, none,
recover, roundtrip…). Use a drop-guard (or `tempfile::TempDir` if already a dev-dep).

## Phase 8 — Docs

_✅ Done 2026-11-04: test counts + coverage table recomputed from `coverage-baseline.json` (2092 tests / 134 files; 133 measured files), vault Phase B status, `build.rs` / capabilities folder map, sync-server quota claim, CHANGELOG per phase._

- `AGENTS.md`: test count (now 2022 tests / 133 files — recompute), coverage table (recompute
  from baseline), vault Phase B status (plumbing is live but inert).
- `src-tauri/AGENTS.md`: `build.rs` uses `try_build` with an app ACL manifest; capabilities are
  `default.json` + `surface.json`.
- `sync-server/AGENTS.md`: per-account vs global quota claim; revocation semantics (D2).
- `CHANGELOG.md` entry per phase.

## Not audited (remaining gaps)

- Runtime/device behaviour of anything (all findings are static).
- Whether document-start scripts reach `about:blank` iframes (possible shim bypass).
- WebKit `add_filter` same-id replacement semantics; reqwest default redirect policy; Android
  `hasGesture()` on redirect hops.
