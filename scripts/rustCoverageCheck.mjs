// Pure logic for the RUST coverage ratchet. No I/O, no process.exit — see
// `rust-coverage-ratchet.mjs` for the CLI wrapper. Same split as
// `coverageCheck.mjs` / `coverage-ratchet.mjs` and `auditCheck.mjs` /
// `check-npm-audit.mjs`, so this is unit-testable without spawning cargo.
//
// The GATE ITSELF is shared with the TypeScript side: `compareToBaseline` and
// `detectBaselineLowering` are imported from `coverageCheck.mjs` rather than
// reimplemented, so "the ratchet may only go up" means the same thing in both
// jobs and there is exactly one definition of a regression. What this module
// owns is the translation, which is where the Rust measurement could quietly
// become a different measurement:
//
//   1. llvm's `regions` become the `statements` slot. An istanbul statement is
//      one expression; an llvm region is a code span, and the two are NOT the
//      same unit. The number is still a monotone, comparable "how much of this
//      file ran" measure, which is all a ratchet needs — but the label is a
//      deliberate fiction and is documented as one.
//   2. `branches` are all zero, and that is NOT a bug: llvm's branch coverage
//      needs `-Z coverage-options=branch`, which is nightly-only, and the
//      pinned toolchain here is stable 1.98.0 (see `rust-toolchain.toml`).
//      Measuring branches would mean measuring a different compiler, and a
//      baseline is only meaningful against a fixed toolchain. So the Rust
//      ratchet gates three metrics, and `pctOf` turns the 0/0 into `undefined`
//      so it is not compared at all rather than compared as a fake 100%.
//   3. Totals are re-summed from the kept files instead of taken from llvm's
//      `totals`, because `totals` covers every file INCLUDING the excluded
//      ones. Using it would make the "exclusion" a no-op that still moved the
//      headline number.

import { METRICS, pctOf } from './coverageCheck.mjs';

/**
 * Which llvm summary key feeds which gated metric.
 *
 * `branches` is listed for completeness and reads `{count: 0}` on a stable
 * toolchain; it is kept here so the mapping is total, and `buildRustBaseline`
 * turns the resulting 0/0 into `undefined` so it cannot be compared.
 */
export const METRIC_SOURCES = {
  lines: 'lines',
  statements: 'regions',
  functions: 'functions',
  branches: 'branches',
};

/**
 * The committed exclusion list. Every entry is a source file that **cannot**
 * execute in a headless Linux CI runner, so its coverage is structurally 0%
 * and no test can move it. Excluding it keeps the ratchet's signal honest:
 * every percentage the gate compares is made only of code that a test COULD
 * cover, so a fall in the number always means a real fall.
 *
 * A reason is mandatory, not decorative — `assertExclusionsJustified` fails
 * without one, so the list cannot grow silently. Adding a file here is a
 * claim that nothing can ever test it, and the claim is reviewable because it
 * shows up in the diff next to the reason.
 *
 * `expectOn` is the platform where the file is even COMPILED, which is a
 * different claim from "where it runs" and the one that decides whether the
 * entry does any work. MEASURED: on Linux exactly one of these eight files
 * reaches the llvm export at all — the other seven are `#[cfg]`-gated out of
 * the build, so an entry whose `expectOn` is not the host platform matches
 * nothing and is reported as such rather than treated as a stale list. An entry
 * that IS expected here but matches nothing is a hard failure: the file was
 * deleted or renamed and the list has stopped describing reality.
 */
export const EXCLUSIONS = [
  {
    file: 'linux_layout.rs',
    expectOn: 'linux',
    reason:
      'WebKitGTK windowing: every body needs a live X/Wayland display and a real ' +
      'WebKitWebView. `cargo test` in a headless runner compiles it (it is not ' +
      'cfg-gated out) and can never execute it — measured 0.00% of 604 lines.',
  },
  {
    file: 'adblock_win.rs',
    expectOn: 'windows',
    reason:
      'WebView2 `WebResourceRequested` tier. COM; the Windows surface is only ' +
      'compiled by the `cross-target` job, never run by any test on any platform.',
  },
  {
    file: 'find_win.rs',
    expectOn: 'windows',
    reason: 'WebView2 `findString`/`findNext` tier. COM; compile-only on any runner.',
  },
  {
    file: 'nav_policy_win.rs',
    expectOn: 'windows',
    reason:
      'Windows `block_at_start` navigation policy. Runs in the webview2 host ' +
      'process, which no unit test instantiates.',
  },
  {
    file: 'nav_url_win.rs',
    expectOn: 'windows',
    reason: 'Windows URL/`OsStr` helpers behind `#[cfg(target_os = "windows")]`.',
  },
  {
    file: 'nav_url_mac.rs',
    expectOn: 'macos',
    reason:
      'objc2/`msg_send!` URL handling. Needs a macOS C toolchain, which is why the ' +
      '`cross-target` matrix has a macOS-15 runner; no test executes it.',
  },
  {
    file: 'zoom_win.rs',
    expectOn: 'windows',
    reason: 'WebView2 `setZoomFactor` tier. COM; compile-only.',
  },
  {
    file: 'zoom_mac.rs',
    expectOn: 'macos',
    reason: 'WKWebView `pageZoom` tier. objc2; compile-only.',
  },
];

/** `process.platform` mapped to the spelling `expectOn` uses. Takes the platform
 *  as an argument so the logic is testable without a Windows machine. */
export function hostPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return platform;
}

/** The basename half of a path, whichever separator the host uses. */
export function basename(p) {
  return String(p).split(/[\\/]/).pop();
}

/** Is this file on the exclusion list? Matching is on the basename, because the
 *  llvm export's paths are absolute and machine-specific. */
export function isExcluded(pathOrName, exclusions = EXCLUSIONS) {
  const name = basename(pathOrName);
  return exclusions.find((e) => e.file === name) ?? null;
}

/**
 * Turn the llvm JSON export into `{ total, files }` in repo-relative paths.
 *
 * `total` is deliberately RE-SUMMED from the files rather than copied from
 * llvm's own `totals`, which includes files this module then excludes.
 */
export function llvmToSummary(exportObj, { repoRoot = '' } = {}) {
  if (!exportObj || typeof exportObj !== 'object') {
    throw new TypeError('llvmToSummary: export must be an object');
  }
  const data = exportObj?.data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new TypeError('llvmToSummary: export has no `data` array');
  }

  const files = {};
  for (const f of data[0].files ?? []) {
    let rel = f.filename;
    if (repoRoot && rel.startsWith(repoRoot))
      rel = rel.slice(repoRoot.length).replace(/^[\\/]/, '');
    files[rel] = f.summary;
  }

  const total = {};
  for (const m of Object.values(METRIC_SOURCES)) {
    total[m] = { count: 0, covered: 0, percent: 0 };
  }
  for (const summary of Object.values(files)) {
    for (const key of Object.values(METRIC_SOURCES)) {
      const rec = summary?.[key];
      if (!rec) continue;
      total[key].count += rec.count;
      total[key].covered += rec.covered;
    }
  }

  return { total, files };
}

/**
 * Split a summary into the files the ratchet measures and the ones it excludes,
 * carrying each exclusion's real numbers so the ratchet can print them.
 *
 * `stale` = an entry that SHOULD be here (its `expectOn` is this host) but
 * matched no file: the file was deleted or renamed and the list now lies.
 * `notCompiledHere` = an entry for another platform, which is expected to match
 * nothing and is reported so a reader can see the list is still accurate rather
 * than silently doing nothing.
 */
export function applyExclusions(summary, exclusions = EXCLUSIONS, platform = process.platform) {
  const here = hostPlatform(platform);
  const kept = {};
  const excluded = [];
  const stale = [];
  const notCompiledHere = [];

  for (const [path, rec] of Object.entries(summary.files)) {
    const hit = exclusions.find((e) => e.file === basename(path));
    if (hit) {
      excluded.push({ file: hit.file, path, reason: hit.reason, summary: rec });
    } else {
      kept[path] = rec;
    }
  }

  const seen = new Set(excluded.map((e) => e.file));
  for (const e of exclusions) {
    if (seen.has(e.file)) continue;
    if (e.expectOn === here) stale.push(e);
    else notCompiledHere.push(e);
  }

  const total = {};
  for (const key of Object.values(METRIC_SOURCES)) {
    total[key] = { count: 0, covered: 0, percent: 0 };
  }
  for (const rec of Object.values(kept)) {
    for (const key of Object.values(METRIC_SOURCES)) {
      const r = rec?.[key];
      if (!r) continue;
      total[key].count += r.count;
      total[key].covered += r.covered;
    }
  }

  return { kept, excluded, stale, notCompiledHere, total };
}

/** Every exclusion carries a real reason and a valid platform. Throws otherwise —
 *  the guard that stops the list growing silently. */
export function assertExclusionsJustified(exclusions = EXCLUSIONS) {
  const bad = [];
  const names = new Set();
  const PLATFORMS = new Set(['linux', 'windows', 'macos']);
  for (const e of exclusions) {
    if (!e || typeof e.file !== 'string' || !e.file.endsWith('.rs')) {
      bad.push(`not a Rust source file: ${JSON.stringify(e?.file)}`);
      continue;
    }
    if (names.has(e.file)) bad.push(`listed twice: ${e.file}`);
    names.add(e.file);
    if (!PLATFORMS.has(e.expectOn)) {
      bad.push(`${e.file}: expectOn must be one of linux/windows/macos, got ${e.expectOn}`);
    }
    if (typeof e.reason !== 'string' || e.reason.trim().length < 40) {
      bad.push(`${e.file}: reason must be a sentence, not a label`);
    }
  }
  if (bad.length) {
    throw new Error('every coverage exclusion needs a real reason:\n  - ' + bad.join('\n  - '));
  }
  return exclusions;
}

/**
 * Build the committed baseline from an llvm summary, in the SAME shape
 * `coverageCheck.buildBaseline` produces so the shared comparison works.
 * `toolchain` is recorded in the file: a baseline measured on a different
 * compiler is not the same baseline.
 */
export function buildRustBaseline(summary, { toolchain = null, exclusions = EXCLUSIONS } = {}) {
  if (!summary || !summary.total) throw new TypeError('buildRustBaseline: summary has no `total`');

  const pick = (rec) => ({
    total: rec?.count ?? 0,
    covered: rec?.covered ?? 0,
    pct: pctOf({ total: rec?.count ?? 0, covered: rec?.covered ?? 0 }),
  });

  const files = {};
  for (const [path, rec] of Object.entries(summary.files ?? summary)) {
    if (path === 'total') continue;
    const entry = {};
    for (const [metric, key] of Object.entries(METRIC_SOURCES)) {
      entry[metric] = pick(rec?.[key]);
    }
    files[path] = entry;
  }

  const total = {};
  for (const m of METRICS) total[m] = pick(summary.total[METRIC_SOURCES[m]]);

  return {
    $comment:
      'Generated by scripts/rust-coverage-baseline.mjs — do not hand-edit. ' +
      'Enforced by scripts/rust-coverage-ratchet.mjs as a ratchet: Rust coverage ' +
      'may rise, never fall, and this file may never be lowered in the same commit. ' +
      '`statements` is llvm `regions` (a code span), not an istanbul statement; ' +
      '`branches` is absent because llvm branch coverage is nightly-only and this ' +
      'baseline is pinned to a stable toolchain.',
    toolchain,
    excluded: exclusions.map((e) => ({ file: e.file, reason: e.reason })),
    total,
    files,
  };
}

export { METRICS };
