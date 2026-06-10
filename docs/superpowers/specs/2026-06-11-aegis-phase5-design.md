# Aegis Phase 5 — Content & Security UX (final phase)

**Date:** 2026-06-11
**Status:** Design approved; spec for review.
**Goal:** Complete the brief's remaining Phase-5 content/permission/security work — real downloads handling,
PDF/media policy, remembered per-site permissions, a chrome-renderer CSP + security-audit sign-off — plus the
folded-in deferred extras (downloads-location, data export/import, element picker). **Distribution (packaging,
code-signing, auto-update, publishing) is explicitly DEFERRED** — it collides with the standing local-only /
headless constraint; this spec documents what a real release needs instead of building it.

---

## 1. Scope (locked with the user)

In scope (six workstreams):
1. **Downloads UX** — `DownloadItem` pipeline → `downloads.*` IPC → a **new Sidebar tab** + toolbar indicator;
   `DownloadsRepo` (persisted); `downloadDir` setting.
2. **PDF / media UX** — inline Chromium PDF viewer; autoplay + fullscreen policy.
3. **Remembered site-permissions** — per-site prompt (on the existing toast/confirm) + `PermissionsRepo`; a
   "Site permissions" Settings tab to review/revoke.
4. **Security: CSP + audit sign-off** — strict CSP on the **chrome renderer only**; written audit sign-off +
   engine/Chromium update policy.
5. **Data export/import** — favorites + history + saved + **settings** → JSON (save dialog); import with a
   **merge-vs-replace choice**.
6. **Element picker (stretch)** — click-to-hide → cosmetic selector → Phase-4 `CustomFiltersRepo` → engine rebuild.

### Sub-decisions (locked)
- **(A) Downloads surface = a new Sidebar tab** (alongside History/Saved → History/Saved/Downloads).
- **(B) CSP scope = chrome-renderer only** (a strict CSP on the privileged React UI document; **NOT** on visited
  websites — imposing app CSP on arbitrary sites would break the web, which is incorrect for a browser).
- **(C) Export/import includes settings** (favorites + history + saved + settings); **import offers merge OR
  replace** (user chooses).

### Out of scope / DEFERRED to a real release cycle (documented, not built)
Packaging (electron-builder targets/installers), `extraResources` seed bundling, code-signing, notarization,
auto-update (electron-updater + remote feed), release publishing, detailed ad-block stats/logs. These need a
remote release host and/or signing certs that the local-only/headless setup rules out.

---

## 2. As-built leverage (do not rebuild)

- **Downloads floor:** `viewController.ts:167` `will-download`→`preventDefault` (the only download handling today);
  content runs on `persist:content`.
- **Permissions:** deny-by-default `setPermissionRequestHandler` + `setPermissionCheckHandler`
  (`viewController.ts:163-164`).
- **Toast/confirm system:** already built (Phase 0) — `useDialog`, `ConfirmDialog`, `Toaster`, the `confirm()`
  in `src/lib/toast.ts`. The permission prompt + import-confirm reuse these.
- **Sidebar tabs:** `Sidebar.tsx` (History/Saved tablist) — Downloads adds a third tab via the same pattern.
- **Settings modal:** `SettingsModal.tsx` (Phase-4 tablist) — new tabs (Downloads, Site permissions, Data) add via
  the same pattern; `Settings`/`SettingsRepo`/`settings.*` IPC extend additively.
- **Custom filters + engine rebuild:** Phase-4 `CustomFiltersRepo` + `rebuildEngineFromCache()` + the verified
  cosmetic-merge (`buildEngine([...listTexts, customFilters])`) — the element picker appends to this.
- **Repos pattern + additive migrations:** `runMigrations` single `CREATE TABLE IF NOT EXISTS` block;
  prepared-statement repos. New `downloads`, `site_permissions` tables append additively.
- **Security posture (already strong, audit will document):** `webPreferences` sandbox/contextIsolation/
  webSecurity true + nodeIntegration false; scheme allowlist (`schemes.ts`); sender-guarded IPC (`ipc/guard.ts`);
  deny-all `setWindowOpenHandler` (`windowOpen.ts`) + in-place routing; scheme-gated navigation. The one gap = CSP.

---

## 3. Workstream designs

### 3.1 Downloads UX
- **Main:** in the `will-download` handler, instead of `preventDefault`, resolve the target dir from
  `settingsRepo.get().downloadDir` (default `app.getPath('downloads')`), set `item.setSavePath(join(dir, filename))`
  (uniquify on collision), insert a `DownloadsRepo` row, subscribe `item.on('updated', (_e, state) => …)` and
  `item.on('done', (_e, state) => …)`, persist progress/final state, and push a `downloads.changed` event to chrome.
- **`DownloadsRepo`** (`downloads` table: `id INTEGER PK AUTOINCREMENT, url, filename, savePath, state TEXT
  (progressing|completed|cancelled|interrupted), receivedBytes INTEGER, totalBytes INTEGER, startedAt INTEGER`):
  `list()`, `record(input)`, `update(id, partial)`, `remove(id)`, `clear()`.
- **IPC:** `downloads.list` / `downloads.remove(id)` / `downloads.clear` / `downloads.openFile(id)` (shell.openPath)
  / `downloads.showInFolder(id)` (shell.showItemInFolder) / `downloads.cancel(id)` (cancel the live item); event
  `downloads.changed`. Cancel needs a main-side live-item map keyed by repo id.
- **Renderer:** `useDownloads` hook (list + onChanged refresh + actions); a **`DownloadsPanel`** mounted as a third
  **Sidebar tab**; a toolbar **downloads indicator** (active-count badge, opens the sidebar to Downloads).
- **`downloadDir` setting:** add to `Settings` (default `''` → main resolves to OS Downloads when empty); a new
  **Downloads Settings tab** (folder path text + "use default"); reuses `settings.set`.
- **Policy:** allow `http(s)`/`blob:`/`data:` downloads (saved to disk). Navigation scheme allowlist unchanged.

### 3.2 PDF / media UX
- **PDF:** ensure the content `webPreferences` enables Chromium's PDF plugin (`plugins: true`) so `application/pdf`
  renders inline in the content view; a PDF can be saved via the Downloads pipeline (3.1). Verify via content-WC
  state (the PDF viewer extension loads), not eyeballing.
- **Media:** set an explicit **autoplay policy** (block autoplay-with-sound; `document-user-activation-required`)
  — the exact mechanism (an `app.commandLine` switch at boot vs a session/webPreferences option) is pinned by the
  plan's contract from the real Electron 42 API — and allow HTML5 **fullscreen** within the content view (handle
  enter/leave + Esc-to-exit). No new persistent UI; behaviorally tested.

### 3.3 Remembered site-permissions
- **`PermissionsRepo`** (`site_permissions` table: `origin TEXT, permission TEXT, decision TEXT (allow|deny),
  PRIMARY KEY(origin, permission)`): `get(origin, permission)`, `set(origin, permission, decision)`,
  `list()`, `remove(origin, permission)`, `clear()`.
- **Handler wiring:** `setPermissionRequestHandler(wc, permission, cb, details)` → compute `origin` from
  `details.requestingUrl`; if `PermissionsRepo.get(origin, permission)` exists → `cb(decision === 'allow')`; else
  raise a **prompt** to chrome (a `permissions.prompt` event) → the renderer shows an allow/deny dialog (reusing
  `ConfirmDialog`/toast) → the choice is persisted via `PermissionsRepo.set` + the original `cb` resolved.
  `setPermissionCheckHandler` reads the remembered decision (deny if none). Pure resolver
  `resolvePermission(remembered, ...)` extracted for unit tests.
- **Scope:** the meaningful set — `geolocation`, `notifications`, `media` (camera/mic), `clipboard-read`. All
  others stay denied (deny-by-default preserved).
- **Settings:** a **"Site permissions" Settings tab** lists remembered `(origin, permission, decision)` rows with
  revoke + clear-all.

### 3.4 Security: CSP + audit sign-off
- **CSP (chrome-renderer only):** add a `<meta http-equiv="Content-Security-Policy">` to the chrome `index.html`
  with a strict policy for the privileged UI (e.g. `default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src
  'none'`). The visited-content view is intentionally NOT given an app CSP (correct browser behavior). Dev-mode
  HMR may need a relaxed CSP (vite ws/eval) — the plan pins a build-mode-aware approach (strict in the packaged
  chrome; dev relaxed) and the e2e asserts the directive is present on the chrome document.
- **Audit sign-off doc** (`docs/superpowers/`): each hardening control → its enforcing code + its test
  (sandbox/contextIsolation/webSecurity/nodeIntegration, scheme allowlist, sender-guarded IPC, deny-all popups,
  scheme-gated nav, deny-by-default permissions, CSP). Note residual accepted items.
- **Engine/Chromium update policy doc:** how filter lists refresh (24h scheduler + manual + the bundled seed
  fallback) and the Chromium/Electron update stance (deferred to a real release cadence; documented).

### 3.5 Data export/import
- **Export:** `data.export()` → main serializes `{ version, favorites, history, saved, settings }` to JSON, prompts
  a save dialog (`dialog.showSaveDialog`), writes the file. (No secrets in settings.)
- **Import:** `data.import(mode: 'merge'|'replace')` → main prompts an open dialog, parses + validates the JSON
  (version + shape), then per the chosen mode: **merge** = insert non-duplicate rows (by url) + shallow-merge
  settings; **replace** = clear each store then insert + overwrite settings. Reuses the existing repos; pure
  `validateExport(json)` + the merge/replace planning extracted for unit tests. A "Data" Settings tab: Export +
  Import (merge/replace radio) buttons, with a confirm on replace.

### 3.6 Element picker (stretch)
- **Arm:** a toolbar/Settings "Pick element to hide" action → main calls
  `contentWebContents.executeJavaScript(pickerIIFE, true)`. The IIFE (injected into the sandboxed content WC, no
  preload) overlays a hover highlight and returns a Promise that resolves on the next click with a computed stable
  CSS selector (id → unique class path → nth-of-type fallback); Esc resolves null (cancel).
- **Persist + apply:** main appends `${host}##${selector}` to the Phase-4 `CustomFiltersRepo` (get → append line →
  set) and calls `rebuildEngineFromCache()` → the element is hidden on the next navigation (verified cosmetic
  merge). Pure `computeSelector`/`appendCosmeticRule(host, selector, existing)` extracted for unit tests; the
  injected-picker behavior is e2e-tested against a fixture.

---

## 4. Data model / IPC additions (summary)

- New tables (additive): `downloads`, `site_permissions`.
- New repos: `DownloadsRepo`, `PermissionsRepo`.
- `Settings` gains `downloadDir: string`.
- New IPC namespaces (sender-guarded): `downloads.{list,remove,clear,openFile,showInFolder,cancel}` + event
  `downloads.changed`; `permissions.{list,remove,clear}` + event `permissions.prompt` (+ a renderer→main
  `permissions.resolve(origin,permission,decision)`); `data.{export,import}`; `picker.start`. `settings.*` reused
  for `downloadDir`.
- New renderer hooks/components: `useDownloads` + `DownloadsPanel` + Sidebar 3rd tab + toolbar indicator;
  `usePermissions` + permission-prompt UI + Site-permissions Settings tab; Data Settings tab; Downloads Settings
  tab; the picker action.

---

## 5. Testing strategy (dual-ABI, as established)

- **Unit (Node ABI / jsdom):** DownloadsRepo, PermissionsRepo, the new `site_permissions`/`downloads` migrations;
  the IPC builders (fake repos/spies); pure helpers (`resolvePermission`, `validateExport`, merge/replace planner,
  `computeSelector`, `appendCosmeticRule`); the new hooks + Settings tabs + DownloadsPanel + permission-prompt
  component.
- **e2e (Electron ABI):** a real fixture download → assert DownloadsRepo state + file on disk + the `downloads.changed`
  push; a permission request → remembered decision round-trips (request twice → second is auto-answered); the CSP
  meta/header is present on the chrome document; export→import round-trip (merge AND replace) via `__aegisTest`;
  element-picker selector → customFilter → cosmetic-hide on a fixture. Autoplay/fullscreen + PDF verified at the
  policy/state level.
- **Full regression gate** at the exit: `npm test` then `npm run build && npm run test:e2e`, green, no regression.

---

## 6. Success criteria (Phase-5 exit)

1. A download saves to the configured `downloadDir` (default OS Downloads), shows a live progress indicator + a
   Downloads sidebar tab with open-file/show-in-folder/cancel/clear, and the list survives restart.
2. PDFs render inline in the content view; media autoplay-with-sound is blocked by default; HTML5 fullscreen works.
3. A site permission request prompts once, the decision is **remembered per origin+permission**, and a second
   request is auto-answered; remembered grants are reviewable/revocable in Settings.
4. The chrome renderer document carries a strict CSP; visited sites are unaffected. A security-audit sign-off doc
   + engine-update policy doc exist mapping every control to code + test.
5. Export produces a JSON of favorites+history+saved+settings; import restores it with a user-chosen **merge or
   replace**; round-trips cleanly.
6. The element picker hides a clicked element and persists it as a cosmetic custom-filter that survives restart.
7. The deferred-distribution doc records exactly what packaging/signing/auto-update would require.
8. **No regression:** the full prior gate (Phases 0–4 unit + e2e) stays green.
