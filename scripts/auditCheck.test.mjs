import { describe, it, expect } from 'vitest';
import { collectBlockingAdvisories, isAllowlisted, evaluateAudit } from './auditCheck.mjs';

// Realistic auditReportVersion-2 fixture: two high/critical advisories, one
// moderate (ignored), and one purely-transitive string `via` (ignored).
const REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: 'lodash',
      severity: 'high',
      via: [
        {
          source: 1065,
          name: 'lodash',
          dependency: 'lodash',
          title: 'Prototype Pollution in lodash',
          url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695',
          severity: 'high',
          range: '<4.17.12',
        },
      ],
    },
    minimist: {
      name: 'minimist',
      severity: 'critical',
      via: [
        {
          source: 1179,
          name: 'minimist',
          dependency: 'minimist',
          title: 'Prototype Pollution',
          url: 'https://github.com/advisories/GHSA-vh95-rmgr-6w4m',
          severity: 'critical',
          range: '<0.2.1',
        },
      ],
    },
    moderateThing: {
      name: 'moderate-thing',
      severity: 'moderate',
      via: [
        {
          source: 9999,
          name: 'moderate-thing',
          title: 'A moderate issue',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          severity: 'moderate',
          range: '<1.0.0',
        },
      ],
    },
    transitive: {
      name: 'transitive',
      severity: 'high',
      via: ['lodash'], // string pointer, not its own advisory
    },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 1, total: 3 } },
};

describe('collectBlockingAdvisories', () => {
  it('collects only high/critical advisory objects, deduped by source', () => {
    const sources = collectBlockingAdvisories(REPORT)
      .map((a) => a.source)
      .sort((x, y) => x - y);
    expect(sources).toEqual([1065, 1179]);
  });

  it('returns [] for a clean report', () => {
    expect(collectBlockingAdvisories({ vulnerabilities: {}, metadata: {} })).toEqual([]);
  });

  it('keeps multiple unidentifiable advisories (no source, no url) instead of deduping them away', () => {
    const report = {
      vulnerabilities: {
        a: { name: 'a', severity: 'high', via: [{ severity: 'high', name: 'a', title: 'one' }] },
        b: {
          name: 'b',
          severity: 'critical',
          via: [{ severity: 'critical', name: 'b', title: 'two' }],
        },
      },
    };
    expect(collectBlockingAdvisories(report).length).toBe(2);
  });
});

describe('isAllowlisted', () => {
  it('matches by numeric source', () => {
    expect(isAllowlisted({ source: 1065 }, [1065])).toBe(true);
  });
  it('matches by advisory url', () => {
    const url = 'https://github.com/advisories/GHSA-vh95-rmgr-6w4m';
    expect(isAllowlisted({ url }, [url])).toBe(true);
  });
  it('does not match an unrelated entry', () => {
    expect(isAllowlisted({ source: 1065 }, [1179])).toBe(false);
  });
});

describe('evaluateAudit', () => {
  it('blocks all high/critical when allowlist empty', () => {
    const { blocking, allowed } = evaluateAudit(REPORT, { allow: [] });
    expect(blocking.map((a) => a.source).sort((x, y) => x - y)).toEqual([1065, 1179]);
    expect(allowed).toEqual([]);
  });

  it('moves an allowlisted advisory (by source) out of blocking', () => {
    const { blocking, allowed } = evaluateAudit(REPORT, { allow: [1065] });
    expect(blocking.map((a) => a.source)).toEqual([1179]);
    expect(allowed.map((a) => a.source)).toEqual([1065]);
  });

  it('moves an allowlisted advisory (by url) out of blocking', () => {
    const { blocking } = evaluateAudit(REPORT, {
      allow: ['https://github.com/advisories/GHSA-vh95-rmgr-6w4m'],
    });
    expect(blocking.map((a) => a.source)).toEqual([1065]);
  });

  it('treats a missing allowlist as empty (all blocking)', () => {
    expect(evaluateAudit(REPORT, {}).blocking.length).toBe(2);
  });
});
