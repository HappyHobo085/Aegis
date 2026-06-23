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
