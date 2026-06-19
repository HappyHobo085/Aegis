// Tests for the autopilot run summarizer's ad-block blocking verdict. The sample
// trace below is verbatim from a real run (target/autopilot/20260619-201912/app.log):
// the OFF pass logs the 5 ad subresources firing; the ON pass shows only the document.
import { describe, it, expect } from 'vitest';
import { adblockVerdictFromLog, summarize } from './summarize.mjs';

const REAL_TRACE = [
  '[aegis-count] block=false page=https://example.org/ url=https://example.org/',
  '[aegis-count] block=false page=about:blank url=http://127.0.0.1:8137/?ab=off',
  '[aegis-count] block=false page=http://127.0.0.1:8137/?ab=off url=https://ib.adnxs.com/pixel.gif?cb=1-0',
  '[aegis-count] block=false page=http://127.0.0.1:8137/?ab=off url=https://www.googletagmanager.com/gtag/js?id=AP-TEST&cb=1-1',
  '[aegis-count] block=false page=http://127.0.0.1:8137/?ab=off url=https://static.doubleclick.net/instream/ad_status.js?cb=1-2',
  '[aegis-count] block=false page=http://127.0.0.1:8137/?ab=off url=https://www.google-analytics.com/collect?v=1&cb=1-3',
  '[aegis-count] block=false page=http://127.0.0.1:8137/?ab=off url=https://securepubads.g.doubleclick.net/gpt/pubads_impl.js?cb=1-4',
  '[aegis-count] block=false page=http://127.0.0.1:8137/?ab=on url=http://127.0.0.1:8137/?ab=on',
].join('\n');

describe('adblockVerdictFromLog', () => {
  it('PASSES when ads load with ad-block OFF and none with it ON (the real trace)', () => {
    const v = adblockVerdictFromLog(REAL_TRACE);
    expect(v).toMatchObject({ status: 'pass', off: 5, on: 0 });
  });

  it('FAILS when ad subresources still load in the ON phase (a real regression)', () => {
    const leaky = REAL_TRACE + '\n[aegis-count] block=true page=http://127.0.0.1:8137/?ab=on url=https://ib.adnxs.com/pixel.gif?cb=2-0';
    expect(adblockVerdictFromLog(leaky)).toMatchObject({ status: 'fail', off: 5, on: 1 });
  });

  it('SKIPS when the OFF phase shows no ad traffic (markers absent / vacuous)', () => {
    const noOff = '[aegis-count] block=false page=http://127.0.0.1:8137/ url=http://127.0.0.1:8137/';
    expect(adblockVerdictFromLog(noOff)).toMatchObject({ status: 'skip', off: 0 });
  });

  it('returns null when there is no trace at all (non-Linux / trace disabled)', () => {
    expect(adblockVerdictFromLog('some other log output\nno markers here')).toBeNull();
  });

  it('honors a non-default fixture origin', () => {
    const t = REAL_TRACE.replaceAll('127.0.0.1:8137', '127.0.0.1:9001');
    expect(adblockVerdictFromLog(t, 'http://127.0.0.1:9001/')).toMatchObject({ status: 'pass', off: 5, on: 0 });
  });
});

describe('summarize', () => {
  const report = {
    summary: { pass: 54, fail: 0, skip: 1 },
    results: [{ id: 'x', title: 'X', status: 'pass' }],
  };

  it('exit 0 and includes a PASS blocking line when the run is clean', () => {
    const { lines, exitCode } = summarize(report, REAL_TRACE, undefined, '/out/report.html');
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('ad-block blocking (trace): PASS');
    expect(lines.join('\n')).toContain('54 passed, 0 failed, 1 skipped');
  });

  it('exit 1 when blocking regresses even if report.json has no failures', () => {
    const leaky = REAL_TRACE + '\n[aegis-count] block=true page=http://127.0.0.1:8137/?ab=on url=https://ib.adnxs.com/x?cb=9';
    const { exitCode } = summarize(report, leaky, undefined, '/out/report.html');
    expect(exitCode).toBe(1);
  });

  it('exit 1 when report.json has a failure', () => {
    const failing = { summary: { pass: 1, fail: 1, skip: 0 }, results: [{ id: 'y', title: 'Y', status: 'fail', detail: 'boom' }] };
    const { exitCode, lines } = summarize(failing, REAL_TRACE, undefined, '/out/report.html');
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('FAIL Y: boom');
  });
});
