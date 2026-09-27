// The RUST coverage RATCHET. This is the `rust` job's CI gate.
//
//   node scripts/rust-coverage-ratchet.mjs [path/to/llvmcov.json]
//
// It is deliberately the same gate as `coverage-ratchet.mjs` — same three
// failure modes, same shared comparison logic from `coverageCheck.mjs` — because
// "the ratchet may only go up" is a single promise, not one per language:
//
//   1. any metric below the committed baseline
//   2. the baseline itself lowered in this commit (vs the version in git HEAD)
//   3. a baseline file dropped out of the report (a new exclusion)
//
// The file argument exists so the gate can be re-run against an artifact without
// re-instrumenting the crate, and so a reviewer can reproduce a CI failure from
// the log alone.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToBaseline, detectBaselineLowering, METRICS } from './coverageCheck.mjs';
import {
  EXCLUSIONS,
  applyExclusions,
  assertExclusionsJustified,
  buildRustBaseline,
  llvmToSummary,
  formatDeltas,
  perFileDeltas,
} from './rustCoverageCheck.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'src-tauri/coverage-baseline.json');
const BASELINE_REL = 'src-tauri/coverage-baseline.json';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function committedBaseline() {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `HEAD:${BASELINE_REL}`], {
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
  console.error('\nrust coverage ratchet: FAILED\n');
  for (const l of lines) console.error(`  - ${l}`);
  console.error('');
  process.exit(1);
}

const argPath = process.argv[2];
let raw;
if (argPath) {
  try {
    raw = readFileSync(resolve(argPath), 'utf8');
  } catch (e) {
    fail([`cannot read ${argPath}: ${e.message}`]);
  }
} else {
  try {
    raw = execFileSync('cargo', ['llvm-cov', '--lib', '--json'], {
      cwd: resolve(ROOT, 'src-tauri'),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    fail([
      '`cargo llvm-cov --lib --json` failed: ' + String(e.stderr ?? e.message).split('\n')[0],
      'It needs cargo-llvm-cov on PATH and the llvm-tools-preview component:',
      '  rustup component add llvm-tools-preview',
      '  cargo install cargo-llvm-cov --locked',
    ]);
  }
}

let exportObj;
try {
  exportObj = JSON.parse(raw);
} catch (e) {
  fail([`the llvm export is not JSON: ${e.message}`]);
}

let baseline;
try {
  baseline = readJson(BASELINE);
} catch (e) {
  fail([`cannot read ${BASELINE_REL}: ${e.message}`, 'run `npm run coverage:rust:baseline` first']);
}

try {
  assertExclusionsJustified(EXCLUSIONS);
} catch (e) {
  fail(
    e.message
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

const summary = llvmToSummary(exportObj, { repoRoot: `${ROOT}/` });
const { kept, excluded, stale, notCompiledHere, total } = applyExclusions(summary, EXCLUSIONS);

if (stale.length) {
  fail([
    'these exclusions matched NO file on this platform, so they are not excluding anything:',
    ...stale.map(
      (e) => `${e.file} — expected to be compiled on ${e.expectOn}, so it was deleted or renamed`,
    ),
    'Delete the entry; keeping it means the list has stopped describing reality.',
  ]);
}

// The exclusions are printed with their REAL numbers every run, so a file can
// never quietly stop being measured and nobody notices.
console.log('rust coverage: excluded from the gate (unexecutable in a headless runner):');
for (const e of excluded) {
  const l = e.summary?.lines;
  console.log(
    `  - ${e.file}: ${l ? `${l.covered}/${l.count} lines (${l.percent.toFixed(2)}%)` : 'no line data'}`,
  );
}
if (notCompiledHere.length) {
  console.log(
    `  - (not compiled on this platform, so nothing to exclude: ` +
      `${notCompiledHere.map((e) => e.file).join(', ')})`,
  );
}

const current = buildRustBaseline(
  { total, files: kept },
  { toolchain: null, exclusions: EXCLUSIONS },
);
const { regressions, improvements, newFiles } = compareToBaseline(baseline, current);

if (newFiles.length) {
  console.log(`rust coverage: ${newFiles.length} newly measured file(s):`);
  for (const f of newFiles) console.log(`  + ${f}`);
}
if (improvements.length) {
  console.log('rust coverage improvements over baseline:');
  for (const l of improvements) console.log(`  + ${l}`);
}
if (regressions.length) {
  // A total alone cannot be diagnosed. On CI run 36325245069 this step reported
  // 11038/14750 against a 11175/14750 baseline, and the cause was a file-level drop
  // that had to be reconstructed by hand (a local run with D-Bus unavailability
  // reproduced it exactly). Name the file in one run instead.
  // The computation AND the formatting live in the pure module: this file is a
  // top-level script that no test imports, so v8 scores it 0% and every line added
  // here would dilute the very ratio it reports.
  fail([...formatDeltas(perFileDeltas(baseline, current)), ...regressions]);
}

const lowered = detectBaselineLowering(committedBaseline(), baseline);
if (lowered.length) {
  if (process.env.COVERAGE_ALLOW_BASELINE_LOWER === '1') {
    console.warn(
      '\nrust coverage ratchet: baseline LOWERED — allowed by COVERAGE_ALLOW_BASELINE_LOWER=1',
    );
    for (const l of lowered) console.warn(`  ! ${l}`);
    console.warn('');
  } else {
    fail([
      `the committed baseline was LOWERED in this commit:`,
      ...lowered.map((l) => `  ${l}`),
      '',
      'Raising coverage is always allowed; lowering the bar to cover a fall is not.',
      'If this reduction is genuinely correct (e.g. a large block of untestable',
      'platform code was deleted), re-run with COVERAGE_ALLOW_BASELINE_LOWER=1 and',
      'say so in the PR.',
    ]);
  }
}

const parts = METRICS.filter((m) => baseline.total[m].total > 0).map(
  (m) => `${m} ${baseline.total[m].pct}%`,
);
console.log(
  `rust coverage ratchet: OK — ${parts.join(', ')} (${Object.keys(baseline.files).length} files)`,
);
const unmeasurable = METRICS.filter((m) => baseline.total[m].total === 0);
if (unmeasurable.length) {
  console.log(`  (${unmeasurable.join(', ')} not gated: llvm branch coverage needs nightly)`);
}
