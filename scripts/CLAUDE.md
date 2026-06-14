# scripts/ — supply-chain CI gate

Node ESM scripts that gate CI on `npm audit`. Run from `.github/workflows/ci.yml`
("Dependency audit gate") and tested in the vitest **node** project.

## Files

- **`auditCheck.mjs`** — pure logic, no I/O. Parses an `npm audit --json`
  (auditReportVersion 2) report and partitions high/critical advisories into
  `{ blocking, allowed }` using an allowlist. Key exports:
  `BLOCKING_SEVERITIES` (`['high','critical']`), `collectBlockingAdvisories`,
  `isAllowlisted`, `evaluateAudit`. Advisories are deduped by `source` (npm
  advisory id), falling back to `url`.
- **`check-npm-audit.mjs`** — the CLI wrapper. Spawns `npm audit --json` (recovering
  stdout when npm exits non-zero), loads the allowlist from `../.audit-allowlist.json`,
  calls `evaluateAudit()`, and **exits non-zero if any blocking advisory remains**.
  Allowlisted ones are logged and ignored.
- **`auditCheck.test.mjs`** — unit tests for the pure logic above.

## Allowlist

`../.audit-allowlist.json` (`{ "allow": [<source-id|url>, ...] }`). To accept a
high/critical advisory, add its numeric `source` or `url` there **with
justification in the commit** — that's the documented escape hatch.

## Run

```bash
node scripts/check-npm-audit.mjs   # the gate
npm test                           # includes auditCheck.test.mjs (node project)
```

> Note: a comment in `.github/dependabot.yml` references an Electron/@ghostery
> currency policy from the now-removed `docs/`. That tooling targets the legacy
> Electron build; on the Tauri branch it's inert but harmless.
