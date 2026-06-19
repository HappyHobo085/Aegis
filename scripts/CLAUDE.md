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

## Autopilot launcher (`scripts/autopilot/`)

**Linux only. Needs a real display (X11 or Wayland).** Drives the entire Aegis feature
surface through the real Rust core in an isolated, disposable environment.

### Files

- **`run-autopilot.sh`** — the entry point. Creates a timestamped output directory
  (`target/autopilot/<ts>/`), spins up the fixture server, launches `npm run tauri:dev`
  with a disposable XDG profile (`XDG_DATA_HOME`/`XDG_CONFIG_HOME` → a `mktemp` dir so
  no user data is touched), and polls for `done.sentinel` (written by
  `autopilot_done` on the Rust side). On exit (including error/timeout), a trap kills
  the app + fixture server and deletes the temp profile.
  - **Key env vars passed to the app:**
    - `VITE_AEGIS_AUTOPILOT=1` — activates the `main.tsx` bootstrap branch.
    - `VITE_AEGIS_AUTOPILOT_FIXTURE=http://127.0.0.1:8137/` — URL of the fixture page
      used for the ad-block induction step.
    - `VITE_AEGIS_AUTOPILOT_DISPLAY=1` (or empty) — whether to attempt screenshots
      (`spectacle`). Set automatically from `$DISPLAY`/`$WAYLAND_DISPLAY`.
    - `AEGIS_AUTOPILOT_OUT=<ts-dir>` — where the Rust commands write report files.
  - **Watchdog:** polls `done.sentinel` every second with a 300 s timeout. Prints a
    pass/fail summary via `node -e '…'` reading `report.json` and exits non-zero if any
    step failed.
  - Report lands in `target/autopilot/<ts>/report.html` (screenshot gallery) and
    `target/autopilot/<ts>/report.json`.

- **`fixture-server.mjs`** — a tiny Node `http.createServer` that serves files from
  `scripts/autopilot/fixture/` over HTTP on `127.0.0.1:8137`. Must be HTTP (not
  `file://`) so the content webview's network ad-block filtering applies — the ad-block
  induction step checks that navigating the fixture page raises the session block count.
  Path traversal is rejected (`403`); unknown paths return `404`.

- **`fixture/index.html`** — a static ad-bait page: embeds external ad-network URLs
  (via `<img src="...">` / `<script src="...">`) so the ad-block induction step can
  verify real blocking. The specific domains come from the Brave `adblock` filter lists
  bundled in the Rust core (EasyList + EasyPrivacy + Peter Lowe's + abuse-TLDs).

### How to run

```bash
bash scripts/autopilot/run-autopilot.sh
```

Expected output: `RESULT: N passed, 0 failed, M skipped` with the gallery path.
If `$DISPLAY`/`$WAYLAND_DISPLAY` is unset, screenshots are skipped and the functional
tour still runs (IPC + ad-block steps only).
