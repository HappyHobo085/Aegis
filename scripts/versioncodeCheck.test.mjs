// Pure-logic tests for the Android versionCode gate. The logic used to live inline in
// `check-android-versioncode.mjs`, which is a subprocess entry point: v8 earns no coverage
// credit for it, and the one behaviour it got wrong — reading the wrong `version` string
// out of the file — had no unit test of its own, only an end-to-end pass through
// `cliGates.test.mjs`'s sandboxed `git`.
import { describe, it, expect } from 'vitest';
import { compareVersions, versionCodeOf, versionOf } from './versioncodeCheck.mjs';

describe('versionOf', () => {
  it('reads the top-level version', () => {
    expect(versionOf('{"version":"1.2.3","productName":"Aegis"}')).toEqual({ version: '1.2.3' });
  });

  it('is NOT fooled by a nested "version" key that comes first', () => {
    // This is the whole reason the regex was replaced. `/"version"\s*:\s*"([^"]+)"/`
    // matches the FIRST occurrence at ANY depth, so this file yielded "0.0.9" and the gate
    // compared — and enforced — the wrong string, silently.
    const conf = '{"plugins":{"x":{"version":"0.0.9"}},"version":"1.2.3"}';
    expect(versionOf(conf).version).toBe('1.2.3');
  });

  it('reports a parse failure rather than inventing a version', () => {
    const bad = versionOf('{ not json');
    expect(bad.version).toBeUndefined();
    // A CODE, not prose: the operator-facing wording lives in the CLI wrapper, which
    // `cliGates.test.mjs` pins.
    expect(bad.problem).toBe('not-json');
    expect(bad.detail).toBeTruthy();
  });

  it('reports a file that is valid JSON but has no top-level version string', () => {
    for (const conf of ['{}', '{"version":9}', '{"version":null}', '{"plugins":{}}']) {
      const r = versionOf(conf);
      expect(r.version).toBeUndefined();
      expect(r.problem).toBeTruthy();
    }
  });

  it('reports a non-object document', () => {
    // `null`, a bare array and a number all PARSE, so this is a different failure from a
    // parse error and must not be reported as one.
    for (const conf of ['null', '[]', '42', '"1.2.3"']) {
      const r = versionOf(conf);
      expect(r.version).toBeUndefined();
      expect(r.problem).toBeTruthy();
    }
  });
});

describe('versionCodeOf', () => {
  it('encodes major*1_000_000 + minor*1_000 + patch', () => {
    expect(versionCodeOf('0.1.0')).toBe(1000);
    expect(versionCodeOf('1.2.3')).toBe(1002003);
  });

  it('returns null for anything that is not MAJOR.MINOR.PATCH', () => {
    for (const v of ['', '1', '1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta', 'a.b.c']) {
      expect(versionCodeOf(v)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders by segment, numerically and not lexically', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('reports an UNCHANGED version as equal, which is how a non-release PR passes', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });

  it('returns null when either side is not comparable', () => {
    expect(compareVersions('1.2', '1.2.3')).toBeNull();
    expect(compareVersions('1.2.3', 'nightly')).toBeNull();
  });
});
