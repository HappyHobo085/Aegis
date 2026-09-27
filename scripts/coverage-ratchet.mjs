// The coverage RATCHET. This is the CI gate.
//
//   node scripts/coverage-ratchet.mjs
//
// Three failure modes, all of them real regressions:
//   1. any metric below the committed baseline
//   2. the baseline itself lowered in this commit (vs the version in git HEAD)
//   3. a baseline file dropped out of the report (a new coverage.exclude)
//
// Raising coverage, or raising the baseline, always passes. Lowering the
// baseline needs `COVERAGE_ALLOW_BASELINE_LOWER=1`, which exists so the gate is
// not an impassable wall — it is deliberately noisy and is an owner decision,
// not a thing a contributor does to make a red build green.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METRICS,
  buildBaseline,
  compareToBaseline,
  detectBaselineLowering,
} from './coverageCheck.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY = resolve(ROOT, 'coverage/coverage-summary.json');
const BASELINE = resolve(ROOT, 'coverage-baseline.json');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** The baseline as committed, or null if it is new / unavailable (shallow clone). */
function committedBaseline() {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `HEAD:${'coverage-baseline.json'}`], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
}

function fail(lines) {
  console.error('\ncoverage ratchet: FAILED\n');
  for (const l of lines) console.error(`  - ${l}`);
  console.error('');
  process.exit(1);
}

let summary;
let baseline;
try {
  summary = readJson(SUMMARY);
  baseline = readJson(BASELINE);
} catch (e) {
  fail([
    `cannot read coverage input: ${e.message}`,
    'run `npm test -- --coverage` before this script',
  ]);
}

const current = buildBaseline(summary, { repoRoot: ROOT });
const { regressions, improvements, newFiles } = compareToBaseline(baseline, current);

if (newFiles.length) {
  console.log(`coverage: ${newFiles.length} newly measured file(s):`);
  for (const f of newFiles) console.log(`  + ${f}`);
}

if (improvements.length) {
  console.log('coverage improvements over baseline:');
  for (const l of improvements) console.log(`  + ${l}`);
}

if (regressions.length) fail(regressions);

const lowered = detectBaselineLowering(committedBaseline(), baseline);
if (lowered.length) {
  if (process.env.COVERAGE_ALLOW_BASELINE_LOWER === '1') {
    console.warn(
      '\ncoverage ratchet: baseline LOWERED — allowed by COVERAGE_ALLOW_BASELINE_LOWER=1',
    );
    for (const l of lowered) console.warn(`  ! ${l}`);
    console.warn('');
  } else {
    fail([
      'the committed baseline was LOWERED in this commit:',
      ...lowered.map((l) => `  ${l}`),
      '',
      'Raising coverage is always allowed; lowering the bar to cover a fall is not.',
      'If this reduction is genuinely correct (e.g. a large block of dead code was',
      'deleted), re-run with COVERAGE_ALLOW_BASELINE_LOWER=1 and say so in the PR.',
    ]);
  }
}

const parts = METRICS.map((m) => `${m} ${baseline.total[m].pct}%`);
console.log(
  `coverage ratchet: OK — ${parts.join(', ')} (${Object.keys(baseline.files).length} files)`,
);
