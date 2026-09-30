import { describe, it, expect } from 'vitest';
import {
  METRICS,
  buildBaseline,
  compareToBaseline,
  coversLess,
  baselineLoweringSkipMessage,
  detectBaselineLowering,
  pctOf,
  resolveBaselineBaseRef,
} from './coverageCheck.mjs';

// A metric record in the shape istanbul writes into coverage-summary.json.
const rec = (covered, total) => ({
  total,
  covered,
  skipped: 0,
  pct: total ? (covered / total) * 100 : 100,
});

const summaryFor = (files) => ({
  total: {
    lines: rec(10, 20),
    statements: rec(10, 20),
    functions: rec(5, 10),
    branches: rec(1, 2),
  },
  ...files,
});

describe('coversLess', () => {
  it('is false for an identical record (the unchanged-tree case)', () => {
    // Guards the float-rounding trap: two runs of an unchanged tree must compare equal.
    expect(coversLess(rec(3990, 4856), rec(3990, 4856))).toBe(false);
  });

  it('is true when proportionally less is covered', () => {
    // 45/100 = 45% is less than 50/100 = 50%, even though `covered` is not smaller.
    expect(coversLess(rec(45, 100), rec(50, 100))).toBe(true);
  });

  it('is false when proportionally more is covered', () => {
    expect(coversLess(rec(60, 100), rec(50, 100))).toBe(false);
  });

  it('detects a fall that also shrinks the denominator', () => {
    // 5/10 = 50% -> 1/2 = 50% is not a fall.
    expect(coversLess(rec(1, 2), rec(5, 10))).toBe(false);
    // 5/10 = 50% -> 1/4 = 25% is.
    expect(coversLess(rec(1, 4), rec(5, 10))).toBe(true);
  });

  it('treats two empty metrics as equal rather than as a fall', () => {
    expect(coversLess(rec(0, 0), rec(0, 0))).toBe(false);
  });

  it('treats a metric that lost all its statements as a fall', () => {
    expect(coversLess(rec(0, 0), rec(3, 10))).toBe(true);
  });

  it('treats a missing record as a fall', () => {
    expect(coversLess(undefined, rec(1, 2))).toBe(true);
  });
});

describe('pctOf', () => {
  it("carries istanbul's own pct through rather than re-deriving it", () => {
    // istanbul TRUNCATES to 2dp (branches 3216/4275 = 75.2280 -> it reports 75.22).
    // Re-deriving with toFixed would print 75.23 next to the report's own 75.22, so
    // the recorded value is passed through instead of recomputed.
    expect(pctOf({ total: 4275, covered: 3216, pct: 75.22 })).toBe(75.22);
  });

  it('falls back to a 2dp derivation when the record carries no pct', () => {
    expect(pctOf({ total: 100, covered: 42 })).toBe(42);
  });

  it('returns undefined for an empty metric so it is not gated', () => {
    expect(pctOf(rec(0, 0))).toBeUndefined();
  });
});

describe('buildBaseline', () => {
  it('records the four gated metrics and omits the v8 branchesTrue artefact', () => {
    const b = buildBaseline(summaryFor({}));
    expect(Object.keys(b.total).sort()).toEqual([...METRICS].sort());
    expect(b.total.branchesTrue).toBeUndefined();
  });

  it('rewrites absolute provider paths to repo-relative ones', () => {
    const b = buildBaseline(
      summaryFor({
        '/repo/src/lib/url.ts': {
          lines: rec(1, 1),
          statements: rec(1, 1),
          functions: rec(1, 1),
          branches: rec(1, 1),
        },
      }),
      { repoRoot: '/repo' },
    );
    expect(Object.keys(b.files)).toEqual(['src/lib/url.ts']);
  });

  it('rejects a summary with no total rather than emitting a useless baseline', () => {
    expect(() => buildBaseline({})).toThrow(/no `total`/);
    expect(() => buildBaseline(null)).toThrow(TypeError);
  });
});

describe('compareToBaseline', () => {
  const baseline = buildBaseline(summaryFor({}));

  it('passes an identical run', () => {
    const r = compareToBaseline(baseline, buildBaseline(summaryFor({})));
    expect(r.regressions).toEqual([]);
  });

  it('fails when a metric falls, and names the metric and both numbers', () => {
    const fallen = summaryFor({});
    fallen.total.lines = rec(1, 20); // 5% vs the baseline's 50%
    const r = compareToBaseline(baseline, buildBaseline(fallen));
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toMatch(/^total lines: 5% \(1\/20\) < baseline 50% \(10\/20\)$/);
  });

  it('reports a rise as an improvement, not a regression', () => {
    const better = summaryFor({});
    better.total.lines = rec(19, 20);
    const r = compareToBaseline(baseline, buildBaseline(better));
    expect(r.regressions).toEqual([]);
    expect(r.improvements.some((l) => l.startsWith('total lines: 95%'))).toBe(true);
  });

  it('fails when a baseline file drops out of the report', () => {
    // This is the `coverage.exclude` escape hatch: adding an exclude would otherwise
    // raise every percentage and pass. It must be caught.
    const withFile = buildBaseline(
      summaryFor({
        '/repo/src/gone.ts': {
          lines: rec(1, 1),
          statements: rec(1, 1),
          functions: rec(1, 1),
          branches: rec(1, 1),
        },
      }),
      { repoRoot: '/repo' },
    );
    const r = compareToBaseline(withFile, buildBaseline(summaryFor({}), { repoRoot: '/repo' }));
    expect(r.removedFiles).toEqual(['src/gone.ts']);
    expect(r.regressions.some((l) => /file dropped out of the report: src\/gone\.ts/.test(l))).toBe(
      true,
    );
  });

  it('lists a newly measured file without failing', () => {
    const r = compareToBaseline(
      baseline,
      buildBaseline(
        summaryFor({
          '/repo/src/new.ts': {
            lines: rec(1, 1),
            statements: rec(1, 1),
            functions: rec(1, 1),
            branches: rec(1, 1),
          },
        }),
        { repoRoot: '/repo' },
      ),
    );
    expect(r.newFiles).toEqual(['src/new.ts']);
    expect(r.regressions).toEqual([]);
  });

  it('fails when the baseline itself has no recorded metric', () => {
    const holed = buildBaseline(summaryFor({}));
    delete holed.total.branches;
    const r = compareToBaseline(holed, buildBaseline(summaryFor({})));
    expect(r.regressions.some((l) => /baseline has no recorded value/.test(l))).toBe(true);
  });
});

describe('detectBaselineLowering', () => {
  const base = buildBaseline(summaryFor({}));

  it('finds nothing when the baseline is unchanged', () => {
    expect(detectBaselineLowering(base, buildBaseline(summaryFor({})))).toEqual([]);
  });

  it('finds nothing when the baseline is raised', () => {
    const raised = summaryFor({});
    raised.total.lines = rec(19, 20);
    expect(detectBaselineLowering(base, buildBaseline(raised))).toEqual([]);
  });

  it('reports the metric and both values when the baseline is lowered', () => {
    const lowered = summaryFor({});
    lowered.total.lines = rec(1, 20);
    const found = detectBaselineLowering(base, buildBaseline(lowered));
    expect(found).toHaveLength(1);
    expect(found[0]).toBe('lines: baseline 50% -> 5% (10/20 -> 1/20)');
  });

  it('is a no-op on the first commit that introduces a baseline', () => {
    expect(detectBaselineLowering(null, base)).toEqual([]);
  });
});

// The base of the lowering check. Every branch here is reachable only because the
// function takes its inputs as arguments: the bug it exists to fix was a CI
// worktree comparing a file with itself, which a test calling the real thing can
// no longer reproduce by accident.
describe('resolveBaselineBaseRef', () => {
  it('uses AEGIS_BASE_REF when the caller knows the base', () => {
    // ci.yml derives this from the event; a human can set it by hand.
    expect(resolveBaselineBaseRef({ env: { AEGIS_BASE_REF: 'deadbeef' }, isCI: true })).toEqual({
      ref: 'deadbeef',
      source: 'AEGIS_BASE_REF',
    });
  });

  it('prefers AEGIS_BASE_REF over the local HEAD fallback', () => {
    expect(resolveBaselineBaseRef({ env: { AEGIS_BASE_REF: 'base-sha' } }).ref).toBe('base-sha');
  });

  it('returns NO ref in CI with nothing set, so the caller skips loudly', () => {
    // THE bug: the old code answered `HEAD` here, and in a CI worktree HEAD is
    // the file being checked, so the comparison was a file against itself and
    // `COVERAGE_ALLOW_BASELINE_LOWER=1` was unreachable.
    expect(resolveBaselineBaseRef({ env: {}, isCI: true })).toEqual({
      ref: null,
      source: 'ci-without-a-base-ref',
    });
  });

  it('treats an EMPTY AEGIS_BASE_REF as unset, not as a ref named ""', () => {
    // `AEGIS_BASE_REF=` in a workflow env block is an empty string, and
    // `git show :coverage-baseline.json` would read the INDEX — a fourth kind of
    // comparison nobody asked for.
    expect(resolveBaselineBaseRef({ env: { AEGIS_BASE_REF: '' }, isCI: true }).ref).toBe(null);
    expect(resolveBaselineBaseRef({ env: { AEGIS_BASE_REF: '' } }).ref).toBe('HEAD');
  });

  it('falls back to HEAD outside CI, which is correct there', () => {
    // Locally the file on disk is the uncommitted candidate and HEAD is what it
    // would replace, so HEAD is the right base — the local behaviour is unchanged
    // on purpose.
    expect(resolveBaselineBaseRef({ env: {} })).toEqual({ ref: 'HEAD', source: 'local-HEAD' });
    expect(resolveBaselineBaseRef({ isCI: false }).ref).toBe('HEAD');
  });
});

// The wording of a check that did not run is the whole deliverable of that branch:
// the outcome is a pass either way, so the only thing distinguishing "I checked and
// it is fine" from "I could not check" is this text. Asserted here so the two ratchets
// cannot drift into saying something else.
describe('baselineLoweringSkipMessage', () => {
  const ci = { ref: null, source: 'ci-without-a-base-ref' };
  const unreadable = { ref: 'deadbeef', source: 'AEGIS_BASE_REF' };

  it('names the cause and disclaims a pass when there is no base ref', () => {
    const m = baselineLoweringSkipMessage({
      script: 'coverage ratchet',
      base: ci,
      baselineRel: 'coverage-baseline.json',
    });
    expect(m).toContain('coverage ratchet: SKIPPING the "baseline was lowered" check');
    expect(m).toContain('ci-without-a-base-ref');
    expect(m).toContain('This is not a pass');
  });

  it('names the ref and the fix when the ref is not in the clone', () => {
    const m = baselineLoweringSkipMessage({
      script: 'rust coverage ratchet',
      base: unreadable,
      baselineRel: 'src-tauri/coverage-baseline.json',
    });
    expect(m).toContain('could not read');
    expect(m).toContain('src-tauri/coverage-baseline.json at deadbeef');
    expect(m).toContain('fetch-depth: 0');
    expect(m).toContain('Not a pass');
  });

  it('survives a missing base argument instead of printing "undefined"', () => {
    // A caller that forgets to resolve the ref must still get a usable message.
    expect(baselineLoweringSkipMessage({ script: 'x', baselineRel: 'y' })).toContain('no-base-ref');
  });
});
