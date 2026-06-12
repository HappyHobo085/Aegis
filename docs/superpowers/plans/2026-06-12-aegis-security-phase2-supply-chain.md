# Aegis Security Phase 2 — Supply-Chain Hygiene & Currency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate the dependency/engine-currency discipline from `docs/superpowers/engine-update-policy.md` — Dependabot, a CI test gate, an `npm audit` gate, an "Electron out of its security-support window" check, and a `SECURITY.md` disclosure policy.

**Architecture:** Two pure, unit-tested ES-module classifiers (`scripts/auditCheck.mjs`, `scripts/electronCurrency.mjs`) wrapped by thin CLI gates (`scripts/check-npm-audit.mjs`, `scripts/check-electron-current.mjs`). A new `.github/workflows/ci.yml` runs the existing unit suite **plus** both gates on every PR (so Dependabot's grouped PRs are gated), on push to `main`, and weekly. `.github/dependabot.yml` and `SECURITY.md` are repo-hygiene files validated locally and by GitHub.

**Tech Stack:** Node 22 ESM (`.mjs`), Vitest (`node` project), GitHub Actions, Dependabot v2, `npm audit --json` (auditReportVersion 2).

**Branch:** Execute on `feat/security-phase2` cut from `main` (do **not** commit to `main` directly; no push/branch/rename beyond this branch).

---

## Verified grounding (do not re-derive)

- **Installed Electron = latest stable = `42.4.0`** (`node_modules/electron/package.json`; `npm view electron version` → `42.4.0`). The live currency check therefore returns **OK** today.
- **Electron security-support window = the latest 3 stable majors** (electronjs.org/docs/latest/tutorial/electron-timelines: *"The latest three stable major versions are supported"*; the third-latest receives security fixes only). Hence: `behindMajors >= 3` → **fail**; `1–2` → **warn**; same major but older patch → **warn**; latest → **ok**.
- **`npm audit --json` (auditReportVersion 2)** shape: `{ vulnerabilities: { <pkg>: { name, severity, via: [ string | { source:<number>, url, severity, title, name } ] } }, metadata: { vulnerabilities: { info, low, moderate, high, critical, total } } }`. A **string** `via` entry is a transitive pointer (no advisory of its own); the **object** `via` entry carries the advisory. Current repo: **0 vulnerabilities**.
- **No test-gate CI exists yet** — `.github/workflows/` has only `build-windows.yml` (build-only) and `release.yml`. This plan creates the gate.
- **Vitest `node` project** currently includes only `shared/**/*.test.ts` + `electron/**/*.test.ts`. It must be extended to discover `scripts/**/*.test.mjs`.
- **Dependabot v2 keys** `groups` / `applies-to: version-updates` / `update-types: [minor, patch]` / `patterns` / `exclude-patterns` are confirmed valid.

## Out of scope for Phase 2 (documented non-goals)

- **e2e in CI.** The e2e suite needs Electron + a virtual display (xvfb) + a native rebuild; it stays the local pre-merge gate. CI runs the **unit** suite (`npm test`, node + jsdom — headless) as the PR gate. Re-evaluate adding an xvfb e2e job in a later phase.
- **Auto-merging Dependabot PRs.** PRs are gated, not auto-merged — a human approves bumps (Electron/`@ghostery/*` especially go through the dual-ABI gate).
- **Signing / publishing** — owned by Phase 1.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/auditCheck.mjs` (create) | Pure: partition `npm audit` advisories into `{ blocking, allowed }` given an allowlist. No I/O. |
| `scripts/auditCheck.test.mjs` (create) | Unit tests for the audit evaluator. |
| `scripts/check-npm-audit.mjs` (create) | CLI gate: spawn `npm audit --json`, read `.audit-allowlist.json`, call evaluator, set exit code. |
| `.audit-allowlist.json` (create) | Accepted-advisory allowlist (numeric `source` or advisory `url`). Empty by default. |
| `scripts/electronCurrency.mjs` (create) | Pure: classify installed-vs-latest Electron as `ok`/`warn`/`fail`. No I/O. |
| `scripts/electronCurrency.test.mjs` (create) | Unit tests for the currency classifier. |
| `scripts/check-electron-current.mjs` (create) | CLI gate: read installed version, query npm for latest, classify, set exit code. |
| `vitest.config.ts` (modify) | Extend `node` project `include` to discover `scripts/**/*.test.mjs`. |
| `.github/workflows/ci.yml` (create) | PR/push/weekly gate: `npm test` + audit gate + currency check. |
| `.github/dependabot.yml` (create) | Weekly grouped npm minor/patch PRs (Electron + `@ghostery/*` excluded) + github-actions ecosystem. |
| `SECURITY.md` (create) | Supported-versions + private-disclosure policy + security-model summary. |

---

## Task 1: Audit evaluator (pure) + Vitest `.mjs` discovery

**Files:**
- Modify: `vitest.config.ts` (extend `node` project `include`)
- Create: `scripts/auditCheck.mjs`
- Test: `scripts/auditCheck.test.mjs`

- [ ] **Step 1: Extend the Vitest `node` project to discover `scripts/**/*.test.mjs`**

In `vitest.config.ts`, change the `node` project's `include` (currently `['shared/**/*.test.ts', 'electron/**/*.test.ts']`) to add the scripts glob:

```ts
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'shared/**/*.test.ts',
            'electron/**/*.test.ts',
            'scripts/**/*.test.mjs',
          ],
          exclude: ['electron/test/e2e/**', 'node_modules/**', 'out/**'],
        },
      },
```

- [ ] **Step 2: Write the failing test**

Create `scripts/auditCheck.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import { collectBlockingAdvisories, isAllowlisted, evaluateAudit } from './auditCheck.mjs';

// Realistic auditReportVersion-2 fixture: two high/critical advisories, one
// moderate (ignored), and one purely-transitive string `via` (ignored).
const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: 'lodash',
      severity: 'high',
      via: [
        {
          source: 1065,
          name: 'lodash',
          dependency: 'lodash',
          title: 'Prototype Pollution in lodash',
          url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695',
          severity: 'high',
          range: '<4.17.12',
        },
      ],
    },
    minimist: {
      name: 'minimist',
      severity: 'critical',
      via: [
        {
          source: 1179,
          name: 'minimist',
          dependency: 'minimist',
          title: 'Prototype Pollution',
          url: 'https://github.com/advisories/GHSA-vh95-rmgr-6w4m',
          severity: 'critical',
          range: '<0.2.1',
        },
      ],
    },
    moderateThing: {
      name: 'moderate-thing',
      severity: 'moderate',
      via: [
        {
          source: 9999,
          name: 'moderate-thing',
          title: 'A moderate issue',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          severity: 'moderate',
          range: '<1.0.0',
        },
      ],
    },
    transitive: {
      name: 'transitive',
      severity: 'high',
      via: ['lodash'], // string pointer, not its own advisory
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 1, total: 3 } },
};

describe('collectBlockingAdvisories', () => {
  it('collects only high/critical advisory objects, deduped by source', () => {
    const sources = collectBlockingAdvisories(REPORT).map((a) => a.source).sort((x, y) => x - y);
    expect(sources).toEqual([1065, 1179]);
  });

  it('returns [] for a clean report', () => {
    expect(collectBlockingAdvisories({ vulnerabilities: {}, metadata: {} })).toEqual([]);
  });
});

describe('isAllowlisted', () => {
  it('matches by numeric source', () => {
    expect(isAllowlisted({ source: 1065 }, [1065])).toBe(true);
  });
  it('matches by advisory url', () => {
    const url = 'https://github.com/advisories/GHSA-vh95-rmgr-6w4m';
    expect(isAllowlisted({ url }, [url])).toBe(true);
  });
  it('does not match an unrelated entry', () => {
    expect(isAllowlisted({ source: 1065 }, [1179])).toBe(false);
  });
});

describe('evaluateAudit', () => {
  it('blocks all high/critical when allowlist empty', () => {
    const { blocking, allowed } = evaluateAudit(REPORT, { allow: [] });
    expect(blocking.map((a) => a.source).sort((x, y) => x - y)).toEqual([1065, 1179]);
    expect(allowed).toEqual([]);
  });

  it('moves an allowlisted advisory (by source) out of blocking', () => {
    const { blocking, allowed } = evaluateAudit(REPORT, { allow: [1065] });
    expect(blocking.map((a) => a.source)).toEqual([1179]);
    expect(allowed.map((a) => a.source)).toEqual([1065]);
  });

  it('moves an allowlisted advisory (by url) out of blocking', () => {
    const { blocking } = evaluateAudit(REPORT, {
      allow: ['https://github.com/advisories/GHSA-vh95-rmgr-6w4m'],
    });
    expect(blocking.map((a) => a.source)).toEqual([1065]);
  });

  it('treats a missing allowlist as empty (all blocking)', () => {
    expect(evaluateAudit(REPORT, {}).blocking.length).toBe(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run scripts/auditCheck.test.mjs`
Expected: FAIL — Vitest cannot resolve the import (`Failed to resolve import "./auditCheck.mjs"` / module does not exist). If Vitest reports **"No test files found"**, Step 1's glob edit is wrong — fix it before continuing.

- [ ] **Step 4: Implement the evaluator**

Create `scripts/auditCheck.mjs`:

```js
// scripts/auditCheck.mjs
// Pure evaluation of `npm audit --json` (auditReportVersion 2) output against an
// allowlist of accepted advisories. No I/O — the CLI wrapper (check-npm-audit.mjs)
// spawns `npm audit` and reads the allowlist file, then calls evaluateAudit().
//
// npm audit v2 shape (verified against the npm shipped with Node 22):
//   { auditReportVersion: 2,
//     vulnerabilities: { <pkg>: { name, severity,
//        via: [ string | { source, url, severity, title, name } ] } },
//     metadata: { vulnerabilities: { info, low, moderate, high, critical, total } } }
// A `via` STRING is a transitive pointer to another package (no advisory of its
// own); the advisory OBJECT (numeric `source`) is what we gate on. Each distinct
// advisory is deduped by `source` (falling back to `url`).

/** Severities that block CI by default. */
export const BLOCKING_SEVERITIES = ['high', 'critical'];

/**
 * Collect distinct high/critical advisory objects from an npm-audit v2 report,
 * deduped by `source` (or `url` when source is absent).
 * @param {object} auditJson parsed `npm audit --json`
 * @returns {Array<{source:(number|undefined), url:(string|undefined), severity:string, title:(string|undefined), name:(string|undefined)}>}
 */
export function collectBlockingAdvisories(auditJson) {
  const out = new Map();
  const vulns = (auditJson && auditJson.vulnerabilities) || {};
  for (const pkg of Object.values(vulns)) {
    const via = (pkg && pkg.via) || [];
    for (const entry of via) {
      if (!entry || typeof entry !== 'object') continue; // string => transitive pointer
      if (!BLOCKING_SEVERITIES.includes(entry.severity)) continue;
      const key = entry.source != null ? `src:${entry.source}` : `url:${entry.url}`;
      if (!out.has(key)) {
        out.set(key, {
          source: entry.source,
          url: entry.url,
          severity: entry.severity,
          title: entry.title,
          name: entry.name,
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * True if `advisory` is covered by the allowlist (matched by numeric `source`
 * or by advisory `url`).
 * @param {{source?:number,url?:string}} advisory
 * @param {Array<number|string>} allow
 */
export function isAllowlisted(advisory, allow) {
  if (!Array.isArray(allow)) return false;
  return allow.some(
    (a) =>
      (advisory.source != null && a === advisory.source) ||
      (advisory.url != null && a === advisory.url),
  );
}

/**
 * Partition blocking advisories into { blocking, allowed } using the allowlist.
 * @param {object} auditJson parsed `npm audit --json`
 * @param {{allow?: Array<number|string>}} allowlist
 * @returns {{ blocking: Array<object>, allowed: Array<object> }}
 */
export function evaluateAudit(auditJson, allowlist) {
  const allow = (allowlist && allowlist.allow) || [];
  const blocking = [];
  const allowed = [];
  for (const adv of collectBlockingAdvisories(auditJson)) {
    if (isAllowlisted(adv, allow)) allowed.push(adv);
    else blocking.push(adv);
  }
  return { blocking, allowed };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run scripts/auditCheck.test.mjs`
Expected: PASS — all tests green.

- [ ] **Step 6: Confirm the full suite still discovers + passes**

Run: `npm test`
Expected: PASS — the prior baseline (855 unit tests) plus the new `auditCheck` tests, all green. (Note the new total; later tasks add more.)

- [ ] **Step 7: Commit**

```bash
git add vitest.config.ts scripts/auditCheck.mjs scripts/auditCheck.test.mjs
git commit -m "$(cat <<'EOF'
test(security): add pure npm-audit advisory evaluator + .mjs test discovery

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `npm audit` CLI gate + allowlist file

**Files:**
- Create: `scripts/check-npm-audit.mjs`
- Create: `.audit-allowlist.json`

- [ ] **Step 1: Create the allowlist file**

Create `.audit-allowlist.json`:

```json
{
  "_comment": "Accepted npm-audit advisories that must NOT fail CI. Add the numeric `source` id OR the advisory `url` (GHSA link) exactly as it appears in `npm audit --json`. Justify each entry in the PR that adds it, and keep this list empty unless an advisory is genuinely non-applicable or unfixable.",
  "allow": []
}
```

- [ ] **Step 2: Implement the CLI gate**

Create `scripts/check-npm-audit.mjs`:

```js
#!/usr/bin/env node
// scripts/check-npm-audit.mjs
// CI gate: fail when `npm audit` reports a high/critical advisory that is not in
// `.audit-allowlist.json`. Pure partition logic lives in ./auditCheck.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAudit } from './auditCheck.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(__dirname, '..', '.audit-allowlist.json');

function runAuditJson() {
  // `npm audit` exits non-zero when vulnerabilities exist; the JSON report is
  // still written to stdout. execFileSync throws in that case — recover stdout
  // from the thrown error.
  try {
    return execFileSync('npm', ['audit', '--json'], { encoding: 'utf8' });
  } catch (err) {
    if (err && typeof err.stdout === 'string' && err.stdout.length) return err.stdout;
    throw err;
  }
}

function loadAllowlist() {
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  } catch {
    return { allow: [] };
  }
}

function main() {
  let report;
  try {
    report = JSON.parse(runAuditJson());
  } catch (err) {
    console.error('[check-npm-audit] could not run/parse `npm audit --json`:', err.message);
    process.exitCode = 1;
    return;
  }

  const { blocking, allowed } = evaluateAudit(report, loadAllowlist());

  if (allowed.length) {
    console.log(`[check-npm-audit] ${allowed.length} allowlisted advisory(ies) ignored:`);
    for (const a of allowed) {
      console.log(`  - ALLOWED ${a.severity} ${a.name} (source ${a.source}) ${a.url || ''}`);
    }
  }

  if (blocking.length) {
    console.error(`[check-npm-audit] ${blocking.length} blocking high/critical advisory(ies):`);
    for (const a of blocking) {
      console.error(`  - ${String(a.severity).toUpperCase()} ${a.name} (source ${a.source}) ${a.title || ''} ${a.url || ''}`);
    }
    console.error('Fix them, or add the `source`/`url` to .audit-allowlist.json with justification.');
    process.exitCode = 1;
    return;
  }

  console.log('[check-npm-audit] OK — no blocking high/critical advisories.');
}

main();
```

- [ ] **Step 3: Run the gate for real (integration verification)**

Run: `node scripts/check-npm-audit.mjs; echo "exit=$?"`
Expected: prints `[check-npm-audit] OK — no blocking high/critical advisories.` and `exit=0` (the repo currently has 0 advisories — verified).

- [ ] **Step 4: Verify the failing path with a temporary allowlist sanity check (non-destructive)**

Confirm the parser wiring end-to-end by feeding a synthetic report through the evaluator via a one-off node check (does not modify the repo):

Run:
```bash
node --input-type=module -e "import { evaluateAudit } from './scripts/auditCheck.mjs'; const r = evaluateAudit({ vulnerabilities: { x: { name: 'x', severity: 'high', via: [{ source: 1, severity: 'high', name: 'x', url: 'u' }] } } }, { allow: [] }); console.log('blocking=', r.blocking.length); process.exit(r.blocking.length === 1 ? 0 : 1);"
echo "exit=$?"
```
Expected: `blocking= 1` and `exit=0` (the evaluator correctly flags a high advisory).

- [ ] **Step 5: Commit**

```bash
git add scripts/check-npm-audit.mjs .audit-allowlist.json
git commit -m "$(cat <<'EOF'
ci(security): add npm audit gate with advisory allowlist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Electron currency classifier (pure)

**Files:**
- Create: `scripts/electronCurrency.mjs`
- Test: `scripts/electronCurrency.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/electronCurrency.test.mjs`:

```js
import { describe, it, expect } from 'vitest';
import {
  SECURITY_SUPPORT_WINDOW_MAJORS,
  parseSemver,
  compareSemver,
  classifyElectronCurrency,
} from './electronCurrency.mjs';

describe('parseSemver', () => {
  it('parses major/minor/patch', () => {
    expect(parseSemver('42.4.0')).toEqual({ major: 42, minor: 4, patch: 0 });
  });
  it('tolerates a leading v', () => {
    expect(parseSemver('v41.10.2')).toEqual({ major: 41, minor: 10, patch: 2 });
  });
  it('throws on garbage', () => {
    expect(() => parseSemver('not-a-version')).toThrow();
  });
});

describe('compareSemver', () => {
  it('orders by major then minor then patch', () => {
    expect(compareSemver('42.0.0', '43.0.0')).toBe(-1);
    expect(compareSemver('42.4.0', '42.3.9')).toBe(1);
    expect(compareSemver('42.4.0', '42.4.0')).toBe(0);
  });
});

describe('classifyElectronCurrency', () => {
  it('ok when on the latest stable', () => {
    const r = classifyElectronCurrency('42.4.0', '42.4.0');
    expect(r.status).toBe('ok');
    expect(r.behindMajors).toBe(0);
  });

  it('ok when the installed patch is ahead of the npm latest', () => {
    expect(classifyElectronCurrency('42.5.0', '42.4.0').status).toBe('ok');
  });

  it('warn when a newer patch/minor exists in the same major', () => {
    const r = classifyElectronCurrency('42.3.0', '42.4.0');
    expect(r.status).toBe('warn');
    expect(r.behindMajors).toBe(0);
  });

  it('warn when 1 major behind (within support window)', () => {
    expect(classifyElectronCurrency('41.0.0', '42.4.0').status).toBe('warn');
  });

  it('warn when 2 majors behind (still within window)', () => {
    expect(classifyElectronCurrency('40.0.0', '42.4.0').status).toBe('warn');
  });

  it('fail when exactly 3 majors behind (outside the security-support window)', () => {
    const r = classifyElectronCurrency('39.0.0', '42.4.0');
    expect(r.status).toBe('fail');
    expect(r.behindMajors).toBe(3);
  });

  it('fail when many majors behind', () => {
    expect(classifyElectronCurrency('30.0.0', '42.4.0').status).toBe('fail');
  });

  it('exposes the support window constant as 3', () => {
    expect(SECURITY_SUPPORT_WINDOW_MAJORS).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run scripts/electronCurrency.test.mjs`
Expected: FAIL — `Failed to resolve import "./electronCurrency.mjs"` (module not created yet).

- [ ] **Step 3: Implement the classifier**

Create `scripts/electronCurrency.mjs`:

```js
// scripts/electronCurrency.mjs
// Pure classifier for "how far is the installed Electron behind the latest
// stable?" — the automated form of engine-update-policy.md's manual "bump on
// each security release" step. No I/O; the CLI (check-electron-current.mjs)
// supplies the installed + latest version strings.
//
// Electron supports the LATEST THREE stable majors with security fixes
// (electronjs.org/docs/latest/tutorial/electron-timelines: "The latest three
// stable major versions are supported"; the third-latest gets security fixes
// only). Falling 3+ majors behind means the bundled Chromium no longer receives
// security backports -> hard fail.
export const SECURITY_SUPPORT_WINDOW_MAJORS = 3;

/** Parse a semver string ("42.4.0" -> {major:42,minor:4,patch:0}). */
export function parseSemver(version) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) throw new Error(`unparseable version: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Compare two semver strings: -1 if a<b, 0 if equal, 1 if a>b (ignores prerelease). */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * Classify installed-vs-latest Electron currency.
 * @param {string} installed e.g. "42.4.0"
 * @param {string} latest    e.g. "42.4.0" (npm `latest` dist-tag = newest stable)
 * @returns {{status:'ok'|'warn'|'fail', installed:string, latest:string,
 *           installedMajor:number, latestMajor:number, behindMajors:number,
 *           reason:string}}
 */
export function classifyElectronCurrency(installed, latest) {
  const installedMajor = parseSemver(installed).major;
  const latestMajor = parseSemver(latest).major;
  const behindMajors = latestMajor - installedMajor;
  const cmp = compareSemver(installed, latest);

  let status;
  let reason;
  if (behindMajors >= SECURITY_SUPPORT_WINDOW_MAJORS) {
    status = 'fail';
    reason =
      `Electron ${installed} is ${behindMajors} majors behind ${latest} — outside the ` +
      `${SECURITY_SUPPORT_WINDOW_MAJORS}-major security-support window; the bundled Chromium ` +
      `no longer receives security backports. Bump Electron and re-run the dual-ABI gate.`;
  } else if (behindMajors > 0) {
    status = 'warn';
    reason =
      `Electron ${installed} is ${behindMajors} major(s) behind ${latest} (still within the ` +
      `${SECURITY_SUPPORT_WINDOW_MAJORS}-major support window). Plan an upgrade.`;
  } else if (cmp < 0) {
    status = 'warn';
    reason =
      `Electron ${installed} is on the latest major but behind the latest stable ${latest} — ` +
      `a patch (possibly a security fix) is available.`;
  } else {
    status = 'ok';
    reason = `Electron ${installed} is the latest stable (or newer).`;
  }

  return { status, installed, latest, installedMajor, latestMajor, behindMajors, reason };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run scripts/electronCurrency.test.mjs`
Expected: PASS — all classifier tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/electronCurrency.mjs scripts/electronCurrency.test.mjs
git commit -m "$(cat <<'EOF'
test(security): add pure Electron security-currency classifier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Electron currency CLI gate

**Files:**
- Create: `scripts/check-electron-current.mjs`

- [ ] **Step 1: Implement the CLI gate**

Create `scripts/check-electron-current.mjs`:

```js
#!/usr/bin/env node
// scripts/check-electron-current.mjs
// CI gate: warn when the installed Electron is behind the latest stable, and
// FAIL when it has fallen outside Electron's 3-major security-support window.
// Pure classification lives in ./electronCurrency.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyElectronCurrency } from './electronCurrency.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function installedElectronVersion() {
  const pkgPath = join(__dirname, '..', 'node_modules', 'electron', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

function latestStableElectronVersion() {
  // npm `latest` dist-tag = newest STABLE (betas live under the `beta` tag).
  return execFileSync('npm', ['view', 'electron', 'version'], { encoding: 'utf8' }).trim();
}

function main() {
  let installed;
  try {
    installed = installedElectronVersion();
  } catch (err) {
    console.error('[check-electron-current] cannot read installed electron version:', err.message);
    process.exitCode = 1;
    return;
  }

  let latest;
  try {
    latest = latestStableElectronVersion();
  } catch (err) {
    // Registry unreachable — do not block CI on a network blip; warn and pass.
    console.warn('[check-electron-current] could not query npm for latest electron; skipping:', err.message);
    return;
  }

  const r = classifyElectronCurrency(installed, latest);
  const line = `[check-electron-current] installed=${r.installed} latest=${r.latest} behindMajors=${r.behindMajors} -> ${r.status.toUpperCase()}`;
  if (r.status === 'fail') {
    console.error(line);
    console.error(r.reason);
    process.exitCode = 1;
  } else if (r.status === 'warn') {
    console.warn(line);
    console.warn(r.reason);
  } else {
    console.log(line);
    console.log(r.reason);
  }
}

main();
```

- [ ] **Step 2: Run the gate for real (integration verification)**

Run: `node scripts/check-electron-current.mjs; echo "exit=$?"`
Expected: prints `[check-electron-current] installed=42.4.0 latest=42.4.0 behindMajors=0 -> OK` and `exit=0` (installed == latest, verified). If npm is offline, it prints the skip-warning and still `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-electron-current.mjs
git commit -m "$(cat <<'EOF'
ci(security): add Electron security-currency CLI gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: CI workflow (test gate + supply-chain checks)

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

# Unit-test gate + supply-chain checks. Runs on every PR (so Dependabot's
# grouped update PRs are gated), on push to main, and weekly (to catch
# dependency-audit / Electron-currency drift even without a PR). The e2e suite
# is intentionally NOT run here — it needs Electron + a virtual display and stays
# the local pre-merge gate.
on:
  pull_request: {}
  push:
    branches:
      - main
  schedule:
    - cron: '17 6 * * 1' # Mondays 06:17 UTC
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - name: Unit tests (node + jsdom)
        run: npm test
      - name: Dependency audit gate (high/critical)
        if: ${{ !cancelled() }}
        run: node scripts/check-npm-audit.mjs
      - name: Electron security-currency check
        if: ${{ !cancelled() }}
        run: node scripts/check-electron-current.mjs
```

> `if: ${{ !cancelled() }}` lets the audit + currency checks run even if `npm test` fails, so one `npm ci` yields all three signals; the job still fails if any step fails.

- [ ] **Step 2: Validate the workflow YAML parses**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml: valid YAML')"
```
Expected: `ci.yml: valid YAML`.
If `python3`/PyYAML is unavailable on this machine, instead run `npx --yes js-yaml .github/workflows/ci.yml >/dev/null && echo "ci.yml: valid YAML"`. (GitHub also validates the file server-side on push.)

- [ ] **Step 3: Verify the job's three commands all succeed locally (proves the job body)**

Run:
```bash
npm test && node scripts/check-npm-audit.mjs && node scripts/check-electron-current.mjs; echo "chain exit=$?"
```
Expected: the unit suite passes, both gates print OK, and `chain exit=0`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci(security): add CI workflow running unit gate + audit + Electron currency

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Dependabot configuration

**Files:**
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Create the Dependabot config**

Create `.github/dependabot.yml`:

```yaml
version: 2

# Supply-chain currency. Grouped minor/patch npm PRs reduce noise; the CI
# workflow (.github/workflows/ci.yml) gates every PR with the unit suite + audit
# + Electron-currency checks. Electron and @ghostery/* are EXCLUDED from the
# grouped updates so they arrive as individual, deliberate PRs that go through
# the dual-ABI gate (per docs/superpowers/engine-update-policy.md).
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
    groups:
      npm-minor-and-patch:
        applies-to: version-updates
        update-types:
          - "minor"
          - "patch"
        patterns:
          - "*"
        exclude-patterns:
          - "electron"
          - "@ghostery/*"

  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

- [ ] **Step 2: Validate the YAML parses**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/dependabot.yml')); print('dependabot.yml: valid YAML')"
```
Expected: `dependabot.yml: valid YAML`.
(Fallback: `npx --yes js-yaml .github/dependabot.yml >/dev/null && echo ok`. GitHub validates the schema on push and surfaces errors on the repo's **Insights → Dependency graph → Dependabot** tab; opening PRs is GitHub-side and verified in the follow-ups section.)

- [ ] **Step 3: Commit**

```bash
git add .github/dependabot.yml
git commit -m "$(cat <<'EOF'
ci(security): add Dependabot config (grouped npm minor/patch + actions)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: SECURITY.md disclosure policy

**Files:**
- Create: `SECURITY.md`

- [ ] **Step 1: Create the policy**

Create `SECURITY.md`:

```markdown
# Security Policy

## Supported versions

Aegis ships an auto-update channel (electron-updater + GitHub Releases). Only the
**latest released version** receives security updates; older builds are expected
to auto-update to it. There is no long-term-support branch.

| Version        | Supported                     |
| -------------- | ----------------------------- |
| Latest release | ✅                            |
| Older releases | ❌ (auto-update to latest)    |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **private vulnerability reporting**:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability** (GitHub Security Advisories).
3. Include the affected version, impact, and reproduction steps.

This routes the report privately to the maintainers. We aim to acknowledge within
**7 days** and to ship a fix or mitigation in a subsequent auto-updated release.
If private reporting is unavailable, contact the maintainer via the address on
their GitHub profile rather than filing a public issue.

## Security model (summary)

Aegis is an Electron application configured for browsing untrusted web content:

- **Process isolation:** web content runs sandboxed with `contextIsolation` on and
  `nodeIntegration` off; the chrome to main IPC surface is sender-guarded.
- **Patch cadence:** Electron is exact-pinned and tracked against upstream stable.
  CI fails when it falls outside Electron's 3-major security-support window (see
  `docs/superpowers/engine-update-policy.md`), and releases ship over the
  SHA512-verified auto-update feed.
- **Tamper resistance:** packaged builds flip Electron fuses
  (RunAsNode / NODE_OPTIONS / inspect off, load-app-from-asar only, cookie
  encryption) and enable ASAR integrity where the platform supports it.
- **Network protections:** built-in ad/tracker blocking via the Ghostery engine.
  (Additional network hardening — HTTPS-Only and malicious-site blocking — is on
  the roadmap.)

## Dependencies

Dependencies are kept current by Dependabot and gated in CI by an `npm audit`
check: high/critical advisories block merge unless explicitly allowlisted, with
justification, in `.audit-allowlist.json`.
```

- [ ] **Step 2: Verify it renders as valid Markdown (sanity)**

Run: `test -s SECURITY.md && head -1 SECURITY.md`
Expected: prints `# Security Policy` (file exists and is non-empty).

- [ ] **Step 3: Commit**

```bash
git add SECURITY.md
git commit -m "$(cat <<'EOF'
docs(security): add SECURITY.md disclosure policy + security model summary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all tasks)

- [ ] **Full suite green:** `npm test` → all unit tests pass (855 baseline + the new `auditCheck` + `electronCurrency` tests).
- [ ] **Both gates green locally:** `node scripts/check-npm-audit.mjs` → OK/exit 0; `node scripts/check-electron-current.mjs` → `... -> OK`/exit 0.
- [ ] **Build unaffected:** `npm run build` succeeds (no source/runtime files changed; this confirms nothing regressed).
- [ ] **Workflows parse:** `ci.yml` and `dependabot.yml` validated as YAML in their tasks.

## Manual / GitHub-side follow-ups (cannot be done from committed files)

These require pushing the branch and repository settings access; record them, do **not** block the plan on them:

1. **Enable GitHub private vulnerability reporting** — repo **Settings → Code security → Private vulnerability reporting → Enable**. `SECURITY.md` points reporters here; the toggle itself is a repo setting, not a file.
2. **Confirm Dependabot is active** — after the branch merges to the default branch, check **Insights → Dependency graph → Dependabot** for the two ecosystems and that it opens the first grouped npm PR (success criterion §6.2). Dependabot only runs from the **default branch's** config.
3. **Confirm CI runs on PRs** — open/observe a PR and confirm the `CI / verify` check runs `npm test` + both gates. (Required-status-check enforcement is a branch-protection setting, optional.)

---

## Success criteria (spec §6.2 mapping)

| Spec §6.2 requirement | Delivered by |
| --- | --- |
| Dependabot opens grouped npm PRs that run the gate | Task 6 (`dependabot.yml`) + Task 5 (`ci.yml` runs on `pull_request`) |
| CI fails when Electron is a security release behind | Tasks 3–4 (classifier + CLI; `fail` outside the 3-major window) wired in Task 5 |
| `npm audit` gate runs | Tasks 1–2 (evaluator + CLI) wired in Task 5 |
| `SECURITY.md` + private vuln reporting exist | Task 7 (file) + follow-up #1 (repo toggle) |
| No regression (dual-ABI gate stays green) | Final verification: `npm test` + `npm run build` |
