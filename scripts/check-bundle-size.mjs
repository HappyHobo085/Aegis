#!/usr/bin/env node
// Bundle-size gate. ONE implementation, used by both `npm run sizecheck` and the
// "Check bundle size" step in .github/workflows/ci.yml.
//
// Why this is a script and not a shell one-liner in the workflow: the gate used to
// be inline YAML that computed the gzipped JS size, compared it to a threshold and,
// on exceeding it, printed `::warning::` and fell through. It could not fail, so a
// 5x bundle regression stayed green. The threshold is a real `process.exit(1)` here.
//
// Sizes are measured the same way the old step measured them: the CONCATENATED
// gzipped bytes of every emitted asset of that kind, which is what a user actually
// downloads over the wire (gzip, not brotli — matching the previous definition so the
// threshold keeps its meaning). CSS is checked too; it used not to be checked at all.
//
// Thresholds are deliberately loose (roughly 3.8x headroom on JS, 7x on CSS) so
// normal feature growth does not trip them, while a pathological regression still
// does. Raise them explicitly and knowingly, never by reflex.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(REPO_ROOT, 'dist', 'assets');

/** Gzipped-byte budgets, in bytes. */
const BUDGETS = {
  js: 512_000, // 500 KB — the historical threshold, unchanged
  css: 102_400, // 100 KB — previously unchecked entirely
};

/**
 * Whether this renderer build may legitimately emit NO asset of a kind.
 *
 * Only CSS: Vite emits no stylesheet until one is imported. JS is different — `main.tsx`
 * is always imported by `index.html`, so a build that emits zero `.js` chunks is not a
 * build that chose to ship no JavaScript, it is a `dist/` that is missing or truncated.
 * Treating the two the same (which this script did) meant the stale-dist guard below was
 * skipped precisely in the case it exists for: `assetsOfKind` succeeded, `files.length` was
 * 0, the loop `continue`d, and the gate exited 0 — so a `dist/` containing only a CSS file
 * reported a clean run no matter how broken it was. A boolean per kind keeps the
 * justification where the reader can see it, next to the consequence.
 */
const MAY_BE_ABSENT = {
  js: false,
  css: true,
};

function assetsOfKind(ext) {
  let entries;
  try {
    entries = readdirSync(ASSETS);
  } catch {
    console.error(
      `::error::No build output at ${ASSETS}. Run \`npm run build:renderer\` first ` +
        '(the size gate measures dist/, it does not build it).',
    );
    process.exit(1);
  }
  return entries.filter((f) => f.endsWith(ext)).sort();
}

function measure(kind, ext) {
  const files = assetsOfKind(ext);
  if (files.length === 0) {
    // Absent is only "fine" for a kind that MAY be absent — see MAY_BE_ABSENT. For any
    // other kind this returns the same zeroed measurement anyway, and the loop below
    // deliberately does NOT skip it: `biggest: 0` is what trips the stale-dist guard,
    // which is the whole point of measuring it.
    return {
      kind,
      files: 0,
      bytes: 0,
      budget: BUDGETS[kind],
      over: false,
      biggest: 0,
      mayBeAbsent: MAY_BE_ABSENT[kind] === true,
    };
  }
  const paths = files.map((f) => join(ASSETS, f));
  // One gzip stream over every asset of this kind, so the total is the size of the
  // concatenated payload rather than the sum of per-file overheads.
  const bytes = gzipSync(Buffer.concat(paths.map((p) => readFileSync(p)))).length;
  return {
    kind,
    files: files.length,
    bytes,
    budget: BUDGETS[kind],
    over: bytes > BUDGETS[kind],
    // Guards against measuring a stale or truncated dist/: a 500-byte "bundle"
    // would otherwise sail under the budget and report a clean run.
    biggest: paths.reduce((max, p) => Math.max(max, statSync(p).size), 0),
    mayBeAbsent: false,
  };
}

const kb = (n) => `${Math.round(n / 1024)} KB`;
let failed = false;

for (const r of [measure('js', '.js'), measure('css', '.css')]) {
  const label = r.kind.toUpperCase().padEnd(3);
  if (r.files === 0 && r.mayBeAbsent) {
    console.log(`  ${label}  no assets emitted — skipped (none is a legitimate build)`);
    continue;
  }
  if (r.files === 0) {
    // Not skippable, and not a size regression either: fall through so the
    // stale-dist guard reports it, then skip the budget line that would read "0 KB".
    console.error(
      `::error::No ${r.kind.toUpperCase()} assets emitted at ${ASSETS}. This renderer ` +
        'always emits JavaScript, so dist/ is stale or truncated — re-run ' +
        '`npm run build:renderer`.',
    );
    failed = true;
    continue;
  }
  console.log(
    `  ${label}  ${kb(r.bytes).padStart(8)} gzipped` +
      `  (budget ${kb(r.budget)}, ${r.files} file${r.files === 1 ? '' : 's'})`,
  );
  if (r.over) {
    failed = true;
    const pct = Math.round(((r.bytes - r.budget) / r.budget) * 100);
    console.error(
      `::error::gzipped ${label} is ${kb(r.bytes)}, ${pct}% over the ${kb(r.budget)} ` +
        `budget. Shed the weight, or raise BUDGETS.${r.kind} in ` +
        'scripts/check-bundle-size.mjs in the same commit.',
    );
  }
  if (r.biggest < 1024) {
    failed = true;
    console.error(
      `::error::Largest ${label} asset is only ${r.biggest} bytes — dist/ looks stale ` +
        'or truncated. Re-run `npm run build:renderer`.',
    );
  }
}

process.exit(failed ? 1 : 0);
