// The coverage RATCHET. This is the CI gate.
//
//   node scripts/coverage-ratchet.mjs
//
// Three failure modes, all of them real regressions:
//   1. any metric below the committed baseline
//   2. the baseline itself lowered in this commit (vs the version in the commit
//      it descends from — NOT vs `HEAD`, which in a CI worktree is this very file;
//      see `resolveBaselineBaseRef` in coverageCheck.mjs)
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
  baselineLoweringSkipMessage,
  detectBaselineLowering,
  resolveBaselineBaseRef,
} from './coverageCheck.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY = resolve(ROOT, 'coverage/coverage-summary.json');
const BASELINE_REL = 'coverage-baseline.json';
const BASELINE = resolve(ROOT, BASELINE_REL);

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/**
 * The baseline as recorded at `ref`, or null if that commit does not have one.
 *
 * Two different failures both mean "no comparison was made", and the caller
 * reports them, because the whole point of this fix is that a check which did
 * not run must not read as a check which passed. `ref` may be unresolvable (a
 * shallow clone, or a base ref that was never fetched) — the ratchet step in
 * ci.yml verifies it and only exports a ref that resolves, so this is a
 * belt-and-braces path.
 */
function committedBaselineAt(ref) {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${ref}:${BASELINE_REL}`], {
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

const base = resolveBaselineBaseRef({
  env: process.env,
  isCI: process.env.GITHUB_ACTIONS === 'true',
});
const committed = base.ref ? committedBaselineAt(base.ref) : null;
if (!committed) {
  console.warn(
    baselineLoweringSkipMessage({ script: 'coverage ratchet', base, baselineRel: BASELINE_REL }),
  );
}
const lowered = detectBaselineLowering(committed, baseline);
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
