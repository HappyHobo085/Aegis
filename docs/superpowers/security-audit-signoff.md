# Aegis — Security Audit Sign-off (Phase-5 exit)

**Date:** 2026-06-11
**Scope:** Electron 42.4.0 ad-blocking browser. Every hardening control below maps to
its enforcing code and its test. Verified at the Phase-5 exit gate (unit + e2e green).

## Control matrix

| # | Control | Enforcing code | Test(s) |
|---|---------|----------------|---------|
| 1 | Content view sandboxed | `electron/main/viewController.ts` content `webPreferences` `sandbox:true` | `electron/test/e2e/sandbox.spec.ts` (`content WebContents reports the locked-down sandbox config`), `boot.spec.ts` |
| 2 | Context isolation on | `viewController.ts` `contextIsolation:true`; `electron/main/window.ts` chrome `contextIsolation:true` | `sandbox.spec.ts` |
| 3 | Node integration off | `viewController.ts`/`window.ts` `nodeIntegration:false` | `sandbox.spec.ts` (`content main world has no Node globals`), `boot.spec.ts` |
| 4 | Web security on | `viewController.ts` `webSecurity:true` (chrome default true) | `sandbox.spec.ts` |
| 5 | Scheme allowlist (navigation) | `ALLOWED_NAV_SCHEMES=['https:','http:']` (defined `shared/types.ts`, consumed by `electron/lib/schemes.ts` `isAllowedNavigationUrl`); content gate `viewController.ts` `will-navigate`/`will-redirect`; chrome `isAppUrl` `window.ts` | `electron/lib/schemes.test.ts`, `sandbox.spec.ts` (`file://`/`javascript:` blocked), `nav.spec.ts` |
| 6 | Sender-guarded IPC | `electron/main/ipc/guard.ts` (`event.sender.id===chromeWebContentsId`) | `electron/main/ipc/guard.test.ts`, `sandbox.spec.ts` (content WC cannot invoke privileged IPC) |
| 7 | Deny-all popups (window.open) | chrome `window.ts` `setWindowOpenHandler` deny; content `viewController.ts` via `decideWindowOpen` (`electron/main/windowOpen.ts`) | `windowOpen.test.ts`, `chromeLockdown.spec.ts`, `popup.spec.ts` |
| 8 | webviewTag never enabled | not set in either `webPreferences`; no `<webview>` in renderer | `sandbox.spec.ts` (locked webPreferences) |
| 9 | Deny-by-default permissions + remembered grants | `viewController.ts` deny-floor handlers; re-set by `electron/main/permissions.ts` `wirePermissions` (`PermissionsRepo`-backed, Phase-5 set only: geolocation/notifications/media/clipboard-read) | `permissions.test.ts` (pure `resolvePermission`), `electron/test/e2e/permissions.spec.ts` (remembered allow/deny round-trip + restart) |
| 10 | Strict CSP on the chrome renderer | build-mode-aware `transformIndexHtml` in `electron.vite.config.ts` (strict prod / relaxed dev); static meta removed from `src/index.html` | `electron/test/e2e/csp.spec.ts` (built `out/renderer/index.html` + live chrome doc carry strict directives; content view has none) |
| 11 | Downloads contained (no arbitrary main-process exec) | `electron/main/downloads.ts` `wireDownloads` (`setSavePath` synchronous-in-callback, repo-tracked); open via `shell.openPath`/`shell.showItemInFolder` only | `electron/main/ipc/downloads.test.ts`, `electron/test/e2e/downloads.spec.ts` |
| 12 | Picker injection scoped to content WC | `electron/main/ipc/picker.ts` `executeJavaScript(PICKER_IIFE, true)` into the sandboxed content WC (no preload); output is a host-scoped cosmetic rule only | `picker.test.ts` (pure `appendCosmeticRule`), `electron/test/e2e/picker.spec.ts` |

## Residual / accepted items

- **Visited content view has NO app CSP** — intentional and correct: imposing the app's
  CSP on arbitrary websites would break the web. CSP applies to the privileged chrome
  renderer only (control #10). Accepted.
- **Dev-mode CSP is relaxed** (`'unsafe-eval'`, `ws:`) to permit Vite HMR. The packaged
  (prod) chrome carries the strict policy; the e2e asserts the prod artifact is strict and
  the dev relaxations do NOT leak into `out/renderer/index.html`. Accepted (dev-only).
- **`onHeadersReceived`/`webRequest` not used** — CSP is delivered as a document `<meta>`
  because the prod chrome loads via `loadFile` (no HTTP layer). Network-level ad-blocking
  is handled by the @ghostery/adblocker engine, not `webRequest`. Accepted by design.
- **PDF inline-render + autoplay-block are verified at the `webPreferences` flag/state
  level**, not by eyeballing a rendered fixture: the content `webPreferences` set
  `plugins:true` (Chromium PDF viewer) and `autoplayPolicy:'document-user-activation-required'`
  (block autoplay-with-sound until a user gesture), both confirmed in
  `electron/main/viewController.ts` and asserted by the Task-24 content-policy e2e at the
  flag/state level. Accepted (no change) — spec §3.2 permits flag-level verification.
- **History import collapses adjacent same-url rows (C5)** — import inserts each history
  row via `historyRepo.record(entry, () => entry.visitedAt)`, and `record` dedups against
  the most-recent row by url, so adjacent SAME-url export rows collapse to a single history
  row on import. This is accepted: history is a timeline and collapsing adjacent same-url
  visits is benign. The behavior is documented and asserted by `electron/main/dataPort.test.ts`
  (the C5 case) and exercised in `electron/test/e2e/dataPort.spec.ts`. Accepted.
- **Distribution hardening (code-signing, notarization, auto-update integrity)** — deferred;
  see `deferred-distribution.md`. Accepted for the local-only/headless constraint.

## Sign-off

All twelve controls are enforced in code and covered by tests; the full dual-ABI gate
(`npm test` + `npm run build && npm run test:e2e`) is green at the Phase-5 exit. Signed off
for the local-only build. A real release must additionally complete the deferred items.
