import { describe, it, expect } from 'vitest';
import {
  METRICS,
  buildBaseline,
  compareToBaseline,
  coversLess,
  detectBaselineLowering,
  pctOf,
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
