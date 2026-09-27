// Regenerate `src-tauri/coverage-baseline.json` from a `cargo llvm-cov --lib --json`
// export. Run it ONLY when Rust coverage went UP — the ratchet is what stops it
// going down.
//
//   node scripts/rust-coverage-baseline.mjs [path/to/llvmcov.json]
//
// A file argument makes this script usable without re-running cargo (and is what
// lets a reviewer regenerate a baseline from an artifact in the CI log).
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXCLUSIONS,
  METRICS,
  applyExclusions,
  assertExclusionsJustified,
  buildRustBaseline,
  llvmToSummary,
} from './rustCoverageCheck.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src-tauri/coverage-baseline.json');

const argPath = process.argv[2];
let raw;
if (argPath) {
  raw = readFileSync(resolve(argPath), 'utf8');
} else {
  // shell:false + an explicit PATH-free env is not enough — cargo llvm-cov is a
  // cargo subcommand and needs to be on PATH. Fail loudly if it is not.
  try {
    raw = execFileSync('cargo', ['llvm-cov', '--lib', '--json'], {
      cwd: resolve(ROOT, 'src-tauri'),
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    console.error('rust-coverage-baseline: `cargo llvm-cov --lib --json` failed.');
    console.error('  needs cargo-llvm-cov on PATH and llvm-tools-preview installed:');
    console.error('    rustup component add llvm-tools-preview');
    console.error('    cargo install cargo-llvm-cov --locked');
    if (e.stderr) console.error(String(e.stderr).split('\n').slice(-8).join('\n'));
    process.exit(1);
  }
}

let exportObj;
try {
  exportObj = JSON.parse(raw);
} catch (e) {
  console.error(`rust-coverage-baseline: the llvm export is not JSON: ${e.message}`);
  process.exit(1);
}

assertExclusionsJustified(EXCLUSIONS);

const summary = llvmToSummary(exportObj, { repoRoot: `${ROOT}/` });
const { kept, excluded, stale, notCompiledHere, total } = applyExclusions(summary, EXCLUSIONS);

if (stale.length) {
  console.error('rust-coverage-baseline: these exclusions matched NO file on this platform:');
  for (const e of stale) console.error(`  - ${e.file} (expected on ${e.expectOn})`);
  console.error('  The file was deleted or renamed — delete the entry too.');
  process.exit(1);
}

let toolchain = null;
try {
  toolchain = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
    .split('\n')
    .find((l) => l.startsWith('release:'))
    ?.slice('release:'.length)
    .trim();
} catch {
  /* recorded as null, not fatal */
}

const baseline = buildRustBaseline({ total, files: kept }, { toolchain, exclusions: EXCLUSIONS });
writeFileSync(OUT, JSON.stringify(baseline, null, 2) + '\n');

console.log(
  `wrote src-tauri/coverage-baseline.json (${Object.keys(kept).length} files, toolchain ${toolchain})`,
);
for (const e of excluded) {
  const l = e.summary?.lines;
  console.log(`  excluded ${e.file}: ${l ? `${l.covered}/${l.count} lines` : 'no line data'}`);
}
if (notCompiledHere.length) {
  console.log(
    `  not compiled on this platform (inert here, listed for the other targets): ` +
      notCompiledHere.map((e) => e.file).join(', '),
  );
}
for (const m of METRICS) {
  const r = baseline.total[m];
  console.log(`  ${m.padEnd(11)} ${r.pct ?? 'n/a'}% (${r.covered}/${r.total})`);
}
