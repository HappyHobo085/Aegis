// Unit tests for the Rust coverage translation layer (scripts/rustCoverageCheck.mjs).
//
// This file exists because the translation is where a Rust coverage number could
// quietly stop meaning what it claims: if `total` were copied from llvm instead
// of re-summed, or if the exclusion list stopped matching anything, the ratchet
// would still print a percentage and still exit 0. Every test below is aimed at
// one of those two failure modes.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareToBaseline, coversLess } from './coverageCheck.mjs';
import {
  EXCLUSIONS,
  METRIC_SOURCES,
  applyExclusions,
  assertExclusionsJustified,
  basename,
  buildRustBaseline,
  hostPlatform,
  isExcluded,
  llvmToSummary,
} from './rustCoverageCheck.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A tiny llvm export with the exact shape cargo-llvm-cov emits. */
const metric = (count, covered) => ({ count, covered, percent: (covered / count) * 100 });
const fileRec = (name, { lines, regions, functions }) => ({
  filename: `/repo/src-tauri/src/${name}`,
  summary: {
    lines: metric(...lines),
    regions: metric(...regions),
    functions: metric(...functions),
    branches: { count: 0, covered: 0, notcovered: 0, percent: 0 },
  },
});

const exportWith = (files, totalsOverride) => ({
  data: [
    {
      files,
      // Deliberately a LIE unless overridden: the whole point of the totals test
      // is that nothing in the pipeline is allowed to read this.
      totals: totalsOverride ?? {
        lines: metric(1, 0),
        regions: metric(1, 0),
        functions: metric(1, 0),
      },
      functions: [],
    },
  ],
  type: 'llvm.coverage.json.export',
  version: '3.1.0',
});

const SAMPLE = exportWith([
  fileRec('adblock.rs', { lines: [100, 90], regions: [200, 180], functions: [10, 9] }),
  fileRec('linux_layout.rs', { lines: [50, 0], regions: [80, 0], functions: [4, 0] }),
  fileRec('vault.rs', { lines: [100, 50], regions: [200, 100], functions: [10, 5] }),
]);

describe('llvmToSummary', () => {
  it('rewrites absolute paths to repo-relative ones', () => {
    const s = llvmToSummary(SAMPLE, { repoRoot: '/repo/' });
    expect(Object.keys(s.files).sort()).toEqual([
      'src-tauri/src/adblock.rs',
      'src-tauri/src/linux_layout.rs',
      'src-tauri/src/vault.rs',
    ]);
  });

  it('leaves paths alone when no repoRoot is given', () => {
    const s = llvmToSummary(SAMPLE);
    expect(Object.keys(s.files)[0]).toBe('/repo/src-tauri/src/adblock.rs');
  });

  it('re-sums the totals from the files instead of trusting llvm `totals`', () => {
    const s = llvmToSummary(SAMPLE, { repoRoot: '/repo/' });
    // 100+50+100 = 250 lines, 90+0+50 = 140 covered. llvm's own `totals` in the
    // fixture is 1/0, so a pass here PROVES the field is not being read.
    expect(s.total.lines).toEqual({ count: 250, covered: 140, percent: 0 });
    expect(s.total.regions.count).toBe(480);
    expect(s.total.functions.count).toBe(24);
  });

  it('honours an honest `totals` field only because it is never consulted', () => {
    const honest = exportWith(SAMPLE.data[0].files, {
      lines: metric(250, 140),
      regions: metric(480, 280),
      functions: metric(24, 14),
    });
    const a = llvmToSummary(honest, { repoRoot: '/repo/' });
    const b = llvmToSummary(SAMPLE, { repoRoot: '/repo/' });
    expect(a.total).toEqual(b.total);
  });

  it('rejects a non-object, an empty data array, and a missing data array', () => {
    expect(() => llvmToSummary(null)).toThrow(/must be an object/);
    expect(() => llvmToSummary({ data: [] })).toThrow(/no `data` array/);
    expect(() => llvmToSummary({})).toThrow(/no `data` array/);
  });
});

describe('the exclusion list', () => {
  it('is justified: every entry has a real reason, a real platform, no duplicate', () => {
    expect(() => assertExclusionsJustified(EXCLUSIONS)).not.toThrow();
    expect(EXCLUSIONS.length).toBe(8);
  });

  it('names files that actually exist in the repo', () => {
    // A typo like `adblock_windows.rs` would make the exclusion a silent no-op:
    // the file stays in the report, uncovered, dragging the gate down forever.
    for (const e of EXCLUSIONS) {
      expect(existsSync(resolve(ROOT, 'src-tauri/src', e.file)), `${e.file} does not exist`).toBe(
        true,
      );
    }
  });

  it('rejects an entry with a label instead of a reason', () => {
    expect(() =>
      assertExclusionsJustified([{ file: 'a.rs', expectOn: 'linux', reason: 'x' }]),
    ).toThrow(/reason must be a sentence/);
  });

  it('rejects a missing reason, a bad platform, a duplicate, and a non-Rust path', () => {
    expect(() => assertExclusionsJustified([{ file: 'a.rs', expectOn: 'linux' }])).toThrow(
      /reason must be a sentence/,
    );
    expect(() =>
      assertExclusionsJustified([{ file: 'a.rs', expectOn: 'solaris', reason: 'y'.repeat(50) }]),
    ).toThrow(/expectOn must be one of/);
    expect(() =>
      assertExclusionsJustified([
        { file: 'a.rs', expectOn: 'linux', reason: 'y'.repeat(50) },
        { file: 'a.rs', expectOn: 'linux', reason: 'z'.repeat(50) },
      ]),
    ).toThrow(/listed twice/);
    expect(() =>
      assertExclusionsJustified([{ file: 'a.txt', expectOn: 'linux', reason: 'y'.repeat(50) }]),
    ).toThrow(/not a Rust source file/);
  });

  it('reports every problem at once, not just the first', () => {
    let msg = '';
    try {
      assertExclusionsJustified([
        { file: 'a.rs', expectOn: 'nope', reason: 'short' },
        { file: 'b.txt', expectOn: 'linux', reason: 'q'.repeat(50) },
      ]);
    } catch (e) {
      msg = e.message;
    }
    expect(msg).toMatch(/expectOn must be one of/);
    expect(msg).toMatch(/reason must be a sentence/);
    expect(msg).toMatch(/not a Rust source file/);
  });

  it('matches on the basename, so an absolute or Windows path both work', () => {
    expect(basename('/a/b/c.rs')).toBe('c.rs');
    expect(basename('C:\\src\\c.rs')).toBe('c.rs');
    expect(isExcluded('/x/src-tauri/src/linux_layout.rs')?.file).toBe('linux_layout.rs');
    expect(isExcluded('C:\\a\\zoom_win.rs')?.file).toBe('zoom_win.rs');
    expect(isExcluded('src-tauri/src/adblock.rs')).toBeNull();
  });

  it('excludes exactly the ONE file that is compiled on Linux', () => {
    // The other seven are #[cfg]-gated out of a Linux build, so they are not in
    // the export at all. If that ever changes the gate would silently start
    // measuring them — which this test would catch.
    const s = llvmToSummary(SAMPLE, { repoRoot: '/repo/' });
    const r = applyExclusions(s, EXCLUSIONS, 'linux');
    expect(r.excluded.map((e) => e.file)).toEqual(['linux_layout.rs']);
    expect(r.stale).toEqual([]);
    expect(r.notCompiledHere.map((e) => e.file)).toEqual([
      'adblock_win.rs',
      'find_win.rs',
      'nav_policy_win.rs',
      'nav_url_win.rs',
      'nav_url_mac.rs',
      'zoom_win.rs',
      'zoom_mac.rs',
    ]);
  });
});

describe('applyExclusions', () => {
  const s = llvmToSummary(SAMPLE, { repoRoot: '/repo/' });

  it('removes the excluded file from the measured set', () => {
    const r = applyExclusions(s, EXCLUSIONS, 'linux');
    expect(Object.keys(r.kept).sort()).toEqual([
      'src-tauri/src/adblock.rs',
      'src-tauri/src/vault.rs',
    ]);
  });

  it('changes the total, and changes it in the RIGHT direction', () => {
    // 0/50 uncovered lines must leave the denominator and leave `covered` alone.
    const before = s.total.lines;
    const after = applyExclusions(s, EXCLUSIONS, 'linux').total.lines;
    expect(after.count).toBe(before.count - 50);
    expect(after.covered).toBe(before.covered);
    expect(after.count).toBe(200);
    expect(after.covered).toBe(140);
  });

  it('carries the excluded file`s REAL numbers so the ratchet can print them', () => {
    const r = applyExclusions(s, EXCLUSIONS, 'linux');
    expect(r.excluded[0].summary.lines).toMatchObject({ count: 50, covered: 0 });
    expect(r.excluded[0].reason).toMatch(/WebKitGTK/);
  });

  it('flags a stale entry (expected on THIS platform, matches nothing) as a failure', () => {
    // linux_layout.rs is in the list and expectOn:linux — if the export stops
    // containing it, the file was deleted and the list is lying.
    const withoutIt = llvmToSummary(
      exportWith([
        fileRec('adblock.rs', { lines: [100, 90], regions: [200, 180], functions: [10, 9] }),
      ]),
      { repoRoot: '/repo/' },
    );
    const r = applyExclusions(withoutIt, EXCLUSIONS, 'linux');
    expect(r.stale.map((e) => e.file)).toEqual(['linux_layout.rs']);
    expect(r.notCompiledHere).toHaveLength(7);
  });

  it('separates "not built for this platform" from "the list is stale"', () => {
    // A macOS-shaped sample: no linux_layout.rs, and none of the mac/win files.
    const macSample = llvmToSummary(
      exportWith([
        fileRec('adblock.rs', { lines: [100, 90], regions: [200, 180], functions: [10, 9] }),
      ]),
      { repoRoot: '/repo/' },
    );
    const r = applyExclusions(macSample, EXCLUSIONS, 'macos');
    // expectOn:linux, so its absence on macOS is correct — informational only.
    expect(r.notCompiledHere.map((e) => e.file)).toContain('linux_layout.rs');
    // expectOn:macos but missing — that IS a lie and must fail the gate.
    expect(r.stale.map((e) => e.file).sort()).toEqual(['nav_url_mac.rs', 'zoom_mac.rs']);
  });

  it('still excludes a matched file whose expectOn is a different platform', () => {
    // SAMPLE contains linux_layout.rs; simulating a Windows run must not turn that
    // match back into a measurement — the entry applies wherever the file appears.
    // (A matched entry is never also `stale`: the two lists are disjoint by
    // construction, and "excluded" is the stronger claim.)
    const r = applyExclusions(s, EXCLUSIONS, 'windows');
    expect(r.excluded.map((e) => e.file)).toEqual(['linux_layout.rs']);
    expect(r.total.lines.count).toBe(200);
    expect(r.stale.map((e) => e.file)).not.toContain('linux_layout.rs');
    // The five Windows-only entries are absent from this Linux-shaped sample,
    // so on a Windows run they would be exactly what `stale` is for.
    expect(r.stale.map((e) => e.file).sort()).toEqual([
      'adblock_win.rs',
      'find_win.rs',
      'nav_policy_win.rs',
      'nav_url_win.rs',
      'zoom_win.rs',
    ]);
  });

  it('measures everything when the list is empty', () => {
    const r = applyExclusions(s, [], 'linux');
    expect(Object.keys(r.kept)).toHaveLength(3);
    expect(r.excluded).toEqual([]);
    expect(r.total.lines.count).toBe(250);
  });
});

describe('hostPlatform', () => {
  it('maps node platform names to the spelling the list uses', () => {
    expect(hostPlatform('win32')).toBe('windows');
    expect(hostPlatform('darwin')).toBe('macos');
    expect(hostPlatform('linux')).toBe('linux');
  });

  it('defaults to this host, and this host is linux', () => {
    expect(hostPlatform()).toBe(
      process.platform === 'win32'
        ? 'windows'
        : process.platform === 'darwin'
          ? 'macos'
          : process.platform,
    );
  });
});

describe('buildRustBaseline', () => {
  const baseline = (() => {
    const s = llvmToSummary(SAMPLE, { repoRoot: '/repo/' });
    const r = applyExclusions(s, EXCLUSIONS, 'linux');
    return buildRustBaseline({ total: r.total, files: r.kept }, { toolchain: '1.98.0' });
  })();

  it('maps llvm `regions` into the `statements` slot', () => {
    expect(METRIC_SOURCES.statements).toBe('regions');
    expect(baseline.total.statements).toEqual({ total: 400, covered: 280, pct: 70 });
  });

  it('leaves branches undefined instead of reporting a fake 0% or 100%', () => {
    // `pctOf` returns undefined for total 0. That matters: `coversLess` treats
    // 0/0 as "equal", so branches is not gated — whereas a `pct: 100` would look
    // like a perfect score that a nightly-only measurement would then have to beat.
    expect(baseline.total.branches).toEqual({ total: 0, covered: 0, pct: undefined });
    expect(coversLess({ total: 0, covered: 0 }, { total: 0, covered: 0 })).toBe(false);
  });

  it('records the toolchain, because a baseline from another compiler is not this baseline', () => {
    expect(baseline.toolchain).toBe('1.98.0');
  });

  it('commits the exclusion list WITH its reasons, so the baseline is self-describing', () => {
    expect(baseline.excluded).toHaveLength(8);
    expect(baseline.excluded[0]).toMatchObject({ file: 'linux_layout.rs' });
    expect(baseline.excluded[0].reason).toMatch(/display/);
  });

  it('says in its own $comment that statements is regions and branches is absent', () => {
    expect(baseline.$comment).toMatch(/regions/);
    expect(baseline.$comment).toMatch(/nightly/);
  });

  it('throws on a summary with no total, rather than writing a zero baseline', () => {
    expect(() => buildRustBaseline({ files: {} })).toThrow(/no `total`/);
  });

  it('survives a JSON round-trip with the undefined pct dropped, not turned into null', () => {
    const round = JSON.parse(JSON.stringify(baseline));
    expect(round.total.branches).toEqual({ total: 0, covered: 0 });
    expect(round.total.branches).not.toHaveProperty('pct');
    expect(round.total.lines).toEqual({ total: 200, covered: 140, pct: 70 });
  });
});

describe('the shared ratchet actually gates the Rust numbers', () => {
  const baseline = (() => {
    const s = llvmToSummary(SAMPLE, { repoRoot: '/repo/' });
    const r = applyExclusions(s, EXCLUSIONS, 'linux');
    return buildRustBaseline({ total: r.total, files: r.kept }, { toolchain: '1.98.0' });
  })();

  it('passes on an unchanged re-measurement', () => {
    expect(compareToBaseline(baseline, baseline).regressions).toEqual([]);
  });

  it('fails when covered lines drop', () => {
    const worse = JSON.parse(JSON.stringify(baseline));
    worse.total.lines.covered = 100;
    worse.total.lines.pct = 50;
    const { regressions } = compareToBaseline(baseline, worse);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatch(/total lines: 50% \(100\/200\) < baseline 70%/);
  });

  it('fails when a measured file disappears from the report', () => {
    const fewer = JSON.parse(JSON.stringify(baseline));
    delete fewer.files['src-tauri/src/vault.rs'];
    const { regressions } = compareToBaseline(baseline, fewer);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toMatch(/file dropped out of the report: src-tauri\/src\/vault\.rs/);
  });

  it('reports a newly measured file without failing', () => {
    const more = JSON.parse(JSON.stringify(baseline));
    more.files['src-tauri/src/new.rs'] = { lines: { total: 10, covered: 10, pct: 100 } };
    const { newFiles, regressions } = compareToBaseline(baseline, more);
    expect(newFiles).toEqual(['src-tauri/src/new.rs']);
    expect(regressions).toEqual([]);
  });
});

describe('the committed baseline is a real measurement of this repo', () => {
  const committed = JSON.parse(
    readFileSync(resolve(ROOT, 'src-tauri/coverage-baseline.json'), 'utf8'),
  );

  it('was measured with the pinned stable toolchain', () => {
    const pinned = readFileSync(resolve(ROOT, 'rust-toolchain.toml'), 'utf8').match(
      /channel\s*=\s*"([^"]+)"/,
    )[1];
    expect(committed.toolchain).toBe(pinned);
  });

  it('covers more than 30 modules and every recorded file exists on disk', () => {
    const files = Object.keys(committed.files);
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) expect(existsSync(resolve(ROOT, f)), `${f} is not on disk`).toBe(true);
  });

  it('does NOT contain any excluded file — the list is applied, not just documented', () => {
    for (const e of committed.excluded) {
      expect(committed.files[`src-tauri/src/${e.file}`]).toBeUndefined();
    }
  });

  it('has consistent per-file arithmetic: every file pct is covered/total', () => {
    for (const [path, rec] of Object.entries(committed.files)) {
      for (const m of ['lines', 'statements', 'functions']) {
        expect(rec[m].covered, `${path} ${m}`).toBeLessThanOrEqual(rec[m].total);
        if (rec[m].total > 0) {
          expect(rec[m].pct, `${path} ${m} pct`).toBe(
            Number(((rec[m].covered / rec[m].total) * 100).toFixed(2)),
          );
        }
      }
    }
  });

  it('has a total that is at least the sum of its files (llvm counts per-file, totals round up)', () => {
    for (const m of ['lines', 'statements', 'functions']) {
      const sum = Object.values(committed.files).reduce((n, f) => n + f[m].covered, 0);
      expect(committed.total[m].covered).toBeGreaterThanOrEqual(sum);
    }
  });
});
