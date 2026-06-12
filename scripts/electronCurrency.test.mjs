import { describe, it, expect } from 'vitest';
import {
  SECURITY_SUPPORT_WINDOW_MAJORS,
  parseSemver,
  compareSemver,
  classifyElectronCurrency,
} from './electronCurrency.mjs';

describe('parseSemver', () => {
  it('parses major/minor/patch', () => {
    expect(parseSemver('42.4.0')).toEqual({ major: 42, minor: 4, patch: 0 });
  });
  it('tolerates a leading v', () => {
    expect(parseSemver('v41.10.2')).toEqual({ major: 41, minor: 10, patch: 2 });
  });
  it('throws on garbage', () => {
    expect(() => parseSemver('not-a-version')).toThrow();
  });
  it('throws on an incomplete (two-segment) version', () => {
    expect(() => parseSemver('1.2')).toThrow();
  });
});

describe('compareSemver', () => {
  it('orders by major then minor then patch', () => {
    expect(compareSemver('42.0.0', '43.0.0')).toBe(-1);
    expect(compareSemver('42.3.0', '42.4.0')).toBe(-1);
    expect(compareSemver('42.4.0', '42.3.9')).toBe(1);
    expect(compareSemver('42.4.0', '42.4.0')).toBe(0);
  });
});

describe('classifyElectronCurrency', () => {
  it('ok when on the latest stable', () => {
    const r = classifyElectronCurrency('42.4.0', '42.4.0');
    expect(r.status).toBe('ok');
    expect(r.behindMajors).toBe(0);
  });

  it('ok when the installed patch is ahead of the npm latest', () => {
    expect(classifyElectronCurrency('42.5.0', '42.4.0').status).toBe('ok');
  });

  it('ok when installed is a full major ahead of the npm latest', () => {
    const r = classifyElectronCurrency('43.0.0', '42.4.0');
    expect(r.status).toBe('ok');
    expect(r.behindMajors).toBe(-1);
  });

  it('warn when a newer patch/minor exists in the same major', () => {
    const r = classifyElectronCurrency('42.3.0', '42.4.0');
    expect(r.status).toBe('warn');
    expect(r.behindMajors).toBe(0);
  });

  it('warn when 1 major behind (within support window)', () => {
    expect(classifyElectronCurrency('41.0.0', '42.4.0').status).toBe('warn');
  });

  it('warn when 2 majors behind (still within window)', () => {
    expect(classifyElectronCurrency('40.0.0', '42.4.0').status).toBe('warn');
  });

  it('fail when exactly 3 majors behind (outside the security-support window)', () => {
    const r = classifyElectronCurrency('39.0.0', '42.4.0');
    expect(r.status).toBe('fail');
    expect(r.behindMajors).toBe(3);
  });

  it('fail when many majors behind', () => {
    expect(classifyElectronCurrency('30.0.0', '42.4.0').status).toBe('fail');
  });

  it('exposes the support window constant as 3', () => {
    expect(SECURITY_SUPPORT_WINDOW_MAJORS).toBe(3);
  });
});
