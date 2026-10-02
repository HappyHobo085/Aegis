import { describe, it, expect } from 'vitest';
import {
  allowlistReadProblem,
  parseAllowlist,
  auditReportProblem,
  collectBlockingAdvisories,
  isAllowlisted,
  evaluateAudit,
} from './auditCheck.mjs';

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

// The gate used to FAIL OPEN. `npm audit --json` writes a *valid JSON* error object
// to stdout when it dies before auditing (a malformed `overrides` block did
// exactly this), so `JSON.parse` succeeded, no `vulnerabilities` key was found, and
// the CLI printed "OK — no blocking high/critical advisories" with exit 0. These
// tests pin the shape check that makes it fail closed instead.
describe('auditReportProblem', () => {
  it('accepts a real audit report, including a clean one with no vulnerabilities', () => {
    expect(auditReportProblem(REPORT)).toBeNull();
    expect(auditReportProblem({ auditReportVersion: 2, vulnerabilities: {} })).toBeNull();
  });

  it('rejects the `{"error":…}` object npm emits when the audit itself dies', () => {
    const problem = auditReportProblem({
      error: { code: 'EINVALIDOVERRIDE', summary: 'Override without name: //' },
    });
    expect(problem).toContain('EINVALIDOVERRIDE');
    expect(problem).toContain('Override without name');
  });

  it('rejects a report with no vulnerabilities object, and explains why', () => {
    expect(auditReportProblem({ auditReportVersion: 2 })).toContain('vulnerabilities');
    expect(auditReportProblem({ auditReportVersion: 2, vulnerabilities: [] })).toContain(
      'vulnerabilities',
    );
  });

  it('rejects a report with no auditReportVersion', () => {
    expect(auditReportProblem({ vulnerabilities: {} })).toContain('auditReportVersion');
  });

  it('rejects non-objects and null', () => {
    for (const bad of [null, undefined, 42, 'nope', []]) {
      expect(auditReportProblem(bad)).toBeTruthy();
    }
  });
});

// ── the allowlist-read decision ────────────────────────────────────────────
//
// These two used to live inline in `check-npm-audit.mjs`, which is a subprocess entry point:
// v8 earns no coverage credit for it, so a decision that can silently EMPTY the allowlist
// had no unit test at all and only ever ran through `cliGates.test.mjs`'s sandboxed `npm` and
// `git` shims. Moving them here is what makes each direction assertable on its own.

describe('allowlistReadProblem', () => {
  it('treats a missing file as "nothing is allowed", the one benign read failure', () => {
    // ENOENT is the ordinary case: the operator has not allowlisted anything.
    expect(allowlistReadProblem({ code: 'ENOENT' })).toBeNull();
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(allowlistReadProblem(enoent)).toBeNull();
  });

  it('refuses every OTHER read failure, because they are not an empty allowlist', () => {
    // Each of these used to collapse into `{ allow: [] }`.
    for (const code of ['EACCES', 'EISDIR', 'ELOOP', 'EPERM']) {
      const problem = allowlistReadProblem(Object.assign(new Error(code), { code }));
      expect(problem).toBeTruthy();
    }
    expect(allowlistReadProblem(new Error('permission denied'))).toContain('permission denied');
  });

  it('still reports something for a thrown non-Error', () => {
    expect(allowlistReadProblem('a string')).toBe('a string');
    expect(allowlistReadProblem(undefined)).toBe('undefined');
  });
});

describe('parseAllowlist', () => {
  it('returns the parsed value for a well-formed allowlist', () => {
    expect(parseAllowlist('{"allow":[1,2]}')).toEqual({ value: { allow: [1, 2] } });
  });

  it('names the problem for a one-character typo instead of reading as empty', () => {
    // A stray comma is the realistic case: it used to be read as "no advisories allowed".
    const bad = parseAllowlist('{"allow":[1,2,]}');
    expect(bad.value).toBeUndefined();
    expect(bad.problem).toBeTruthy();
  });

  it('reports a problem for a file that is not JSON at all', () => {
    // `'null'` is deliberately NOT here: it is valid JSON, and the case below pins that it
    // parses. Putting it in this list is how I wrote a test that contradicted the next one.
    for (const text of ['', 'not json', '[1,2', '{"allow":', '  ']) {
      expect(parseAllowlist(text).problem).toBeTruthy();
    }
  });

  it('does NOT treat a JSON null or an array as a usable allowlist without complaint', () => {
    // These PARSE, so they are the caller's problem, not the parser's — but they must not
    // silently look like an empty allowlist either. `evaluateAudit` copes with a missing
    // `allow`, so this documents that the parse layer passes them through rather than
    // inventing a shape of its own.
    expect(parseAllowlist('null')).toEqual({ value: null });
    expect(parseAllowlist('[]')).toEqual({ value: [] });
  });
});
