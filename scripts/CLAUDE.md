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
    - `AEGIS_AUTOPILOT_TRACE=1` — makes `linux_layout::connect_block_counter` log a
      `[aegis-count] block=… page=… url=…` line per subresource to `app.log`. The
      summarizer reads these to assert ad-block **blocking** (see `summarize.mjs`).
  - **Watchdog:** polls `done.sentinel` every second with a configurable timeout
    (default 1800 s — the first run compiles the Rust core, which a cold `tauri dev`
    build can take 10-20 min; override with `AEGIS_AUTOPILOT_TIMEOUT=<seconds>`). Then
    runs `summarize.mjs` and exits non-zero if any step failed **or** ad-block blocking
    regressed.
  - Report lands in `target/autopilot/<ts>/report.html` (screenshot gallery) and
    `target/autopilot/<ts>/report.json`.

- **`summarize.mjs`** — prints the run summary and computes the **authoritative ad-block
  blocking verdict** from the `[aegis-count]` A/B trace in `app.log`. The live shield
  COUNT can't prove blocking for well-known hosts (the WebKit content filter cancels a
  matched request _before_ `resource-load-started` fires, so the counter never sees it —
  see `src-tauri/src/linux_layout.rs`). Instead the fixture is loaded twice — ad-block
  OFF (`?ab=off`, filter removed) then ON (`?ab=on`, filter active) — and the verdict is
  PASS when ad subresources fire in the OFF phase and **vanish** in the ON phase, FAIL if
  any still load with ad-block ON, SKIP if no trace. Pure logic is unit-tested in
  `summarize.test.mjs` (node project) against a real captured trace.

- **`fixture-server.mjs`** — a tiny Node `http.createServer` that serves files from
  `scripts/autopilot/fixture/` over HTTP on `127.0.0.1:8137`. Must be HTTP (not
  `file://`) so the content webview's network ad-block filtering applies. The query
  string is ignored for routing (`split('?')[0]`), so the `?ab=off`/`?ab=on` phase
  markers still serve `index.html` while forcing a full reload. Path traversal is
  rejected (`403`); unknown paths return `404`.

- **`fixture/index.html`** — an ad-bait page: an inline script fires requests
  (`new Image().src`, **cache-busted per load** with a unique query) to known third-party
  ad/tracker hosts so the ad-block A/B trace can verify real blocking. The specific
  domains come from the Brave `adblock` filter lists bundled in the Rust core (EasyList +
  EasyPrivacy + Peter Lowe's + abuse-TLDs). Cache-busting matters because WebKit
  negative-caches a blocked URL, so static ad URLs wouldn't re-fire the load signal.

### How to run

```bash
bash scripts/autopilot/run-autopilot.sh
```

Expected output: `RESULT: N passed, 0 failed, M skipped`, then
`ad-block blocking (trace): PASS — N ad subresource(s) loaded with ad-block OFF, 0 with
ad-block ON`, and the gallery path. If `$DISPLAY`/`$WAYLAND_DISPLAY` is unset, screenshots
are skipped and the functional tour still runs (IPC + ad-block steps only).

### Live run step order (from `src/autopilot/run.ts`)

1. **Screen tour** — every `SCREENS` entry is reached, screenshotted, and torn down.
2. **Catalog verification** — every `CATALOG` entry's `exercise(api)` runs. If `live=true`,
   `verify(api)` also runs for entries that declare it (functional round-trips on the
   disposable profile).
3. **Interaction specs** — every `INTERACTIONS` spec with `layers.includes('live')` runs
   via `makeLiveCtx`. Results appear in the report as `interaction:<spec.id>` rows.
   All mobile-only specs (`domain: 'mobile.*'`) are `['vitest']` only and are NOT
   included in the live run (the live harness drives only the desktop shell).
4. **Ad-block induction** — A/B navigation of the fixture page (ad-block OFF then ON)
   to verify blocking at the network layer.
