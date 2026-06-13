# Aegis Security Phase 4 — Fingerprint/Leak Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce passive fingerprinting + a network leak on the content session: a WebRTC IP policy that stops local-IP enumeration, a mainstream Chrome User-Agent (so the content session doesn't advertise "Electron/Aegis"), and download-dir path validation that rejects traversal/relative dirs.

**Architecture:** Two pure, unit-tested helpers — `resolveDownloadDir` (hardened) and a new `chromeUserAgent(platform, chromeVersion)` — plus a thin wiring step in `index.ts` that, on the content view, sets the WebRTC IP policy (`webContents.setWebRTCIPHandlingPolicy`) and the content-session UA (`session.setUserAgent`). The UA is DERIVED from `process.versions.chrome` so it always matches the bundled Chromium (no manual engine-bump update, no version-mismatch tell).

**Tech Stack:** Electron 42 (`setWebRTCIPHandlingPolicy`, `session.setUserAgent`), Vitest (node), Playwright e2e.

**Branch:** Execute on `feat/security-phase4` cut from `main` (no push/branch/rename beyond this branch).

---

## Verified grounding (live source / Electron 42 type defs — do not re-derive)

- **WebRTC API:** `webContents.setWebRTCIPHandlingPolicy(policy: 'default' | 'default_public_interface_only' | 'default_public_and_private_interfaces' | 'disable_non_proxied_udp'): void` (`node_modules/electron/electron.d.ts:18336`). **Chosen value: `'default_public_interface_only'`** — confirmed valid; uses only the default public interface, hiding local/LAN IPs from STUN enumeration while keeping WebRTC functional (`'disable_non_proxied_udp'` would break WebRTC without a proxy). Resolves spec §7's open verification.
- **UA API:** `session.setUserAgent(userAgent: string, acceptLanguages?: string): void` (`electron.d.ts:13296`).
- **ViewController accessors** (`electron/main/viewController.ts`): `get contentWebContents(): Electron.WebContents` (`:77-78`, `this.view.webContents`) and `get contentSession(): Electron.Session` (`:82-83`, `this.view.webContents.session`); content WC uses `partition: 'persist:content'` (`:60`). So `vc.contentWebContents.setWebRTCIPHandlingPolicy(...)` and `vc.contentSession.setUserAgent(...)`.
- **`index.ts` wiring site:** content-session wiring already happens after `const vc = new ViewController({...})` — e.g. `wireDownloads(vc.contentSession, ...)`, `wirePermissions(vc.contentSession, ...)`, the `AdblockController` with `vc.contentSession`. The WebRTC + UA wiring goes in that same region, BEFORE the first navigation (`safety!.navigate(firstUrl)`).
- **Download dir:** `resolveDownloadDir(settingDir, osDir)` (`electron/main/downloadsHelpers.ts:38-41`) currently just returns `settingDir.trim() || osDir` — **no validation**. Used in `electron/main/downloads.ts:32` (`resolveDownloadDir(settingsRepo.get().downloadDir, app.getPath('downloads'))`) as the save dir. `Settings.downloadDir` is user-set via the settings UI (`'' → OS Downloads`). `node:path` (a Node builtin, not Electron) is fine to import in this pure helper — it already tests under Node.
- **Chromium version:** read at runtime from `process.versions.chrome` (main process). Modern Chrome reports a REDUCED UA (`Chrome/<major>.0.0.0`), so derive `Chrome/<major>.0.0.0` from the major.

## Scope notes / documented deviations
- **UA derived, not a pinned constant** (spec §3.4 said "pinned constant updated by the engine-bump checklist"). Deriving from `process.versions.chrome` is strictly better: the UA can never drift from the real Chromium version (a version mismatch is itself a fingerprint tell), and it needs no manual bump. Documented here as an intentional improvement.
- **WebRTC policy has no runtime getter**, so it gets a wiring task + code-review verification, not a unit/e2e assertion of the value. The UA IS e2e-assertable (`navigator.userAgent`).
- Out of scope (spec Tier-3 non-goals): full fingerprint *farbling* (canvas/font/audio randomization).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `electron/main/downloadsHelpers.ts` (modify) | Harden `resolveDownloadDir` — reject non-absolute / `..`-bearing dirs → OS Downloads. |
| `electron/main/userAgent.ts` (create) | Pure `chromeUserAgent(platform, chromeVersion)`. |
| `electron/main/index.ts` (modify) | Set WebRTC IP policy + content-session Chrome UA after `vc` construction. |
| `electron/test/e2e/fingerprint.spec.ts` (create) | e2e: content `navigator.userAgent` is a Chrome string with no `Electron`/`Aegis` token. |

---

## Task 1: Harden `resolveDownloadDir`

**Files:** Modify `electron/main/downloadsHelpers.ts`; Modify `electron/main/downloadsHelpers.test.ts`.

- [ ] **Step 1: Write failing tests** — add to `electron/main/downloadsHelpers.test.ts` (find the existing `resolveDownloadDir` describe or add one; mirror the file's test style):

```ts
describe('resolveDownloadDir (path validation)', () => {
  const OS = '/home/user/Downloads';

  it('returns the OS dir when the setting is empty', () => {
    expect(resolveDownloadDir('', OS)).toBe(OS);
    expect(resolveDownloadDir('   ', OS)).toBe(OS);
  });

  it('returns a valid absolute dir (normalized)', () => {
    expect(resolveDownloadDir('/srv/dl', OS)).toBe('/srv/dl');
    expect(resolveDownloadDir('/srv/dl/', OS)).toBe('/srv/dl'); // trailing slash normalized
    expect(resolveDownloadDir('/srv//dl', OS)).toBe('/srv/dl'); // double slash normalized
  });

  it('rejects a relative dir (falls back to OS)', () => {
    expect(resolveDownloadDir('relative/dir', OS)).toBe(OS);
    expect(resolveDownloadDir('./dl', OS)).toBe(OS);
  });

  it('rejects a traversal (..-bearing) dir (falls back to OS)', () => {
    expect(resolveDownloadDir('../etc', OS)).toBe(OS);
    expect(resolveDownloadDir('/home/user/../../etc', OS)).toBe(OS);
    expect(resolveDownloadDir('/a/../b', OS)).toBe(OS);
  });
});
```

- [ ] **Step 2: Run (red)** — `npx vitest run electron/main/downloadsHelpers.test.ts` → the new relative/traversal cases fail (current impl returns them as-is).

- [ ] **Step 3: Implement** — in `electron/main/downloadsHelpers.ts`, add the import and replace `resolveDownloadDir`:

```ts
import { isAbsolute, resolve } from 'node:path';
```

```ts
/**
 * The configured download dir if it's a safe absolute path, else the OS Downloads
 * dir. Rejects non-absolute dirs (would resolve against an unpredictable cwd) and
 * any `..`-bearing input (path traversal) — a crafted `downloadDir` setting must
 * not be able to write files outside an explicit absolute location.
 */
export function resolveDownloadDir(settingDir: string, osDir: string): string {
  const trimmed = settingDir.trim();
  if (trimmed.length === 0) return osDir;
  const hasTraversal = trimmed.split(/[\\/]+/).includes('..');
  if (!isAbsolute(trimmed) || hasTraversal) return osDir;
  return resolve(trimmed); // normalize separators / trailing slash
}
```

(Keep `uniquifyFilename` + `splitPath` unchanged. The file header comment says "No fs/electron deps"; `node:path` is a Node builtin, not fs/electron — the helper still tests under Node. Update the header comment if it implies `path` is excluded.)

- [ ] **Step 4: Run (green)** — `npx vitest run electron/main/downloadsHelpers.test.ts` → all pass. Then `npm test` → full suite green (report count).

- [ ] **Step 5: Commit**

```bash
git add electron/main/downloadsHelpers.ts electron/main/downloadsHelpers.test.ts
git commit -m "$(cat <<'EOF'
fix(security): validate downloadDir (reject relative/traversal) in resolveDownloadDir

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `chromeUserAgent` pure helper

**Files:** Create `electron/main/userAgent.ts`; Test `electron/main/userAgent.test.ts`.

- [ ] **Step 1: Write failing tests** — `electron/main/userAgent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chromeUserAgent } from './userAgent';

describe('chromeUserAgent', () => {
  it('builds a reduced Chrome UA for Linux', () => {
    expect(chromeUserAgent('linux', '134.0.6998.88')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    );
  });

  it('builds a reduced Chrome UA for Windows', () => {
    expect(chromeUserAgent('win32', '134.0.6998.88')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    );
  });

  it('builds a reduced Chrome UA for macOS', () => {
    expect(chromeUserAgent('darwin', '134.0.6998.88')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    );
  });

  it('reduces the version to <major>.0.0.0', () => {
    expect(chromeUserAgent('linux', '128.0.1.2')).toContain('Chrome/128.0.0.0 ');
  });

  it('does not contain Electron or the app name', () => {
    const ua = chromeUserAgent('linux', '134.0.6998.88');
    expect(ua).not.toMatch(/electron/i);
    expect(ua).not.toMatch(/aegis/i);
  });

  it('falls back to a Linux token for an unknown platform', () => {
    expect(chromeUserAgent('freebsd' as NodeJS.Platform, '134.0.0.0')).toContain('X11; Linux x86_64');
  });
});
```

- [ ] **Step 2: Run (red)** — `npx vitest run electron/main/userAgent.test.ts` → module not found.

- [ ] **Step 3: Implement** — `electron/main/userAgent.ts`:

```ts
// electron/main/userAgent.ts
// Build a mainstream Chrome User-Agent for the content session so browsed pages
// see a common Chrome string (not "Electron/Aegis"), reducing UA fingerprintability
// and UA-sniffing breakage. DERIVED from the bundled Chromium version
// (process.versions.chrome) so it can never drift from the real engine — a version
// mismatch is itself a fingerprint tell. Modern Chrome reports a reduced UA
// (Chrome/<major>.0.0.0), which this mirrors.

/** Platform token used in the UA's parenthesized section. */
function platformToken(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    default:
      return 'X11; Linux x86_64';
  }
}

/**
 * @param platform e.g. process.platform
 * @param chromeVersion e.g. process.versions.chrome ("134.0.6998.88")
 */
export function chromeUserAgent(platform: NodeJS.Platform, chromeVersion: string): string {
  const major = chromeVersion.split('.')[0] || '0';
  const reduced = `${major}.0.0.0`;
  return `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reduced} Safari/537.36`;
}
```

- [ ] **Step 4: Run (green)** — `npx vitest run electron/main/userAgent.test.ts` → all pass. Commit.

```bash
git add electron/main/userAgent.ts electron/main/userAgent.test.ts
git commit -m "$(cat <<'EOF'
feat(security): add chromeUserAgent helper (derived from bundled Chromium)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire WebRTC policy + content-session UA

**Files:** Modify `electron/main/index.ts`.

> READ `index.ts` around the `vc` construction + the content-session wiring (`wireDownloads`/`wirePermissions`/`AdblockController` with `vc.contentSession`). Add the two lines in that region, BEFORE the first navigation.

- [ ] **Step 1: Import the helper** — add with the other imports:

```ts
import { chromeUserAgent } from './userAgent';
```

- [ ] **Step 2: Add the wiring** — in `boot()`, after `vc` is constructed and where the other content-session wiring lives (and before `safety!.navigate(firstUrl)`), add:

```ts
  // Fingerprint/leak hardening on the content view:
  //  - WebRTC: only the default public interface, so pages can't enumerate LAN/local IPs.
  //  - UA: a mainstream Chrome string (derived from the bundled Chromium) instead of
  //    advertising "Electron/Aegis".
  vc.contentWebContents.setWebRTCIPHandlingPolicy('default_public_interface_only');
  vc.contentSession.setUserAgent(chromeUserAgent(process.platform, process.versions.chrome));
```

- [ ] **Step 3: Build + suite** — `npm run build` → success; `npm test` → green (report count). Confirm `npx tsc --noEmit 2>&1 | grep "main/index.ts"` shows no NEW index.ts errors.

- [ ] **Step 4: Commit**

```bash
git add electron/main/index.ts
git commit -m "$(cat <<'EOF'
feat(security): set content WebRTC IP policy + Chrome UA on the content session

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: e2e — content UA is a Chrome string

**Files:** Create `electron/test/e2e/fingerprint.spec.ts`.

- [ ] **Step 1: Learn the harness** — read `electron/test/e2e/nav.spec.ts` (and any spec that reads content via `view.webContents.executeJavaScript`, e.g. `myfilters.spec.ts`'s `readContent` helper). Reuse the `launchApp` + the content-`executeJavaScript` mechanism.

- [ ] **Step 2: Write the scenario** — launch the app (set `AEGIS_HOME_URL` to a fixture or `about:blank`; navigate to a fixture page so a content document exists), then read `navigator.userAgent` from the content view (via `view.webContents.executeJavaScript('navigator.userAgent', true)`) and assert:
  - it contains `'Chrome/'` and `'Safari/537.36'`,
  - it does NOT match `/electron/i`,
  - it does NOT match `/aegis/i`.

  (Mirror `myfilters.spec.ts`'s `readContent`/`navigateAndSettle` helpers — copy them; do not invent.) If the harness can also read `navigator.userAgent` before any navigation, prefer asserting after a real fixture navigation so it reflects the content session.

- [ ] **Step 3: Run** — `npm run test:e2e`. Report the ACTUAL output. (The WebRTC policy itself has no runtime getter to assert; it's verified by code review in Task 3 — note this in the report, don't fake an assertion.)

- [ ] **Step 4: Commit**

```bash
git add electron/test/e2e/fingerprint.spec.ts
git commit -m "$(cat <<'EOF'
test(security): e2e assert content UA is a Chrome string (no Electron/Aegis)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all tasks)
- [ ] `npm test` → full unit suite green (report count).
- [ ] `npm run build` → success.
- [ ] `npm run test:e2e` → report actual (note the WebRTC policy is code-review-verified, not e2e-asserted).
- [ ] Manual smoke (optional, dev): in the content view devtools console, `navigator.userAgent` is a Chrome string; a WebRTC IP-leak test page (e.g. browserleaks.com/webrtc) shows no local/private IPs.

## Success criteria (spec §3.4 + §6.4)
| Requirement | Delivered by |
| --- | --- |
| WebRTC no longer leaks local IPs | Task 3 (`setWebRTCIPHandlingPolicy('default_public_interface_only')`) |
| Content UA is a mainstream Chrome string | Tasks 2, 3 + Task 4 e2e |
| A traversal/relative `downloadDir` is rejected | Task 1 |
| No regression | Final verification: `npm test` + build + e2e |

## Completes the initiative
Phase 4 is the LAST of the Tier-1+2 security-upgrades initiative (Phases 1, 2, 3a, 3b already merged to `main` locally). After this, the only remaining item is the deferred/manual ones already documented (push `main` to origin to activate the P2 CI/Dependabot + cut a `v*` tag for the P1 auto-update round-trip; enable GitHub private vulnerability reporting). The security-audit sign-off matrix should be extended with the new controls (auto-update integrity, fuses, HTTPS-Only, MalwareGuard, WebRTC/UA, downloadDir validation).
