// Regenerate `coverage-baseline.json` from a coverage run.
//
//   node scripts/coverage-baseline.mjs
//
// Run it AFTER `vitest run --coverage` and ONLY when you intend to move the
// committed bar. `coverage-ratchet.mjs` is what CI runs; this is the deliberate,
// human-initiated way to raise the bar.
//
// The gate refuses a LOWERED baseline in the same commit as the change that
// caused it, so a regression cannot be made invisible by relaxing the number.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBaseline } from './coverageCheck.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY = resolve(ROOT, 'coverage/coverage-summary.json');
const OUT = resolve(ROOT, 'coverage-baseline.json');

function vitestVersion() {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, 'node_modules/vitest/package.json'), 'utf8'))
      .version;
  } catch {
    return null;
  }
}

try {
  const summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
  const baseline = buildBaseline(summary, { repoRoot: ROOT, vitestVersion: vitestVersion() });
  writeFileSync(OUT, JSON.stringify(baseline, null, 2) + '\n');
  const n = Object.keys(baseline.files).length;
  console.log(`wrote coverage-baseline.json — ${n} files`);
  for (const [m, r] of Object.entries(baseline.total)) {
    console.log(`  ${m.padEnd(11)} ${String(r.pct).padStart(6)}%  (${r.covered}/${r.total})`);
  }
} catch (e) {
  console.error(`coverage-baseline: ${e.message}`);
  console.error('Run `npm test -- --coverage` first to produce coverage/coverage-summary.json.');
  process.exit(1);
}
