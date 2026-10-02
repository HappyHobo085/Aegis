#!/usr/bin/env node
// scripts/check-npm-audit.mjs
// CI gate: fail when `npm audit` reports a high/critical advisory that is not in
// `.audit-allowlist.json`. Pure partition logic lives in ./auditCheck.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditReportProblem, evaluateAudit } from './auditCheck.mjs';

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
  let text;
  try {
    text = readFileSync(ALLOWLIST_PATH, 'utf8');
  } catch (err) {
    // A missing allowlist is the ordinary "nothing is allowed" case, and it is
    // the only read failure that may mean that. Every other one — a permissions
    // error, a wrong path, the file being a directory — used to collapse into
    // the same `{ allow: [] }`, which is indistinguishable from a deliberately
    // empty allowlist. The gate still failed CLOSED either way, so this was
    // never a silent pass; the cost was diagnosability, because the report then
    // named the advisory ("3 new blocking advisories") and never the file that
    // was actually broken.
    if (err && err.code === 'ENOENT') return { allow: [] };
    console.error(
      `[check-npm-audit] could not read ${ALLOWLIST_PATH}:`,
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // A one-character typo in the allowlist is not "no advisories are allowed".
    // Say which file is malformed, and stop: auditing against a silently
    // emptied allowlist turns a typo into an unrelated wall of red.
    console.error(
      `[check-npm-audit] ${ALLOWLIST_PATH} is not valid JSON:`,
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
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

  // Fail CLOSED on a report that is not an audit report. `npm audit` emits valid
  // JSON on stdout even when it dies outright (a malformed `overrides` block, for
  // instance, yields `{"error":{...}}`), so parsing alone does not prove the audit
  // ran. Without this check such a run reported "OK" and exited 0 — the gate
  // passing because it could not see anything. See auditCheck.auditReportProblem.
  const shapeProblem = auditReportProblem(report);
  if (shapeProblem) {
    console.error('[check-npm-audit] `npm audit --json` did not produce an audit report:');
    console.error(`  - ${shapeProblem}`);
    console.error(
      'Refusing to report success on an audit that did not run. Fix the audit command ' +
        '(e.g. a malformed package.json/overrides) and re-run this gate.',
    );
    process.exitCode = 1;
    return;
  }

  const { blocking, allowed } = evaluateAudit(report, loadAllowlist());

  if (allowed.length) {
    console.log(`[check-npm-audit] ${allowed.length} allowlisted advisory(ies) ignored:`);
    for (const a of allowed) {
      console.log(
        `  - ALLOWED ${a.severity} ${a.name} (source ${a.source ?? 'n/a'}) ${a.url || ''}`,
      );
    }
  }

  if (blocking.length) {
    console.error(`[check-npm-audit] ${blocking.length} blocking high/critical advisory(ies):`);
    for (const a of blocking) {
      console.error(
        `  - ${String(a.severity).toUpperCase()} ${a.name} (source ${a.source ?? 'n/a'}) ${a.title || ''} ${a.url || ''}`,
      );
    }
    console.error(
      'Fix them, or add the `source`/`url` to .audit-allowlist.json with justification.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('[check-npm-audit] OK — no blocking high/critical advisories.');
}

main();
