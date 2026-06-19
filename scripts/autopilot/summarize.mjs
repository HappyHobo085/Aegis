// scripts/autopilot/summarize.mjs
// Summarize an autopilot run: the report.json pass/fail/skip tally PLUS the
// authoritative ad-block BLOCKING verdict derived from the `[aegis-count]` trace.
//
// Why the trace and not the shield count: on Linux, ads are blocked by the WebKit
// content filter (WKContentRuleList), which cancels a matched request BEFORE
// `resource-load-started` fires — so the in-app shield COUNTER (which runs on that
// signal) never sees a filter-blocked ad and cannot prove blocking for well-known
// hosts. Blocking is proven instead by an A/B navigation: the fixture is loaded with
// ad-block OFF (`?ab=off`, filter removed) and then ON (`?ab=on`, filter active). With
// the trace enabled (AEGIS_AUTOPILOT_TRACE=1, set by the launcher), the OFF pass logs
// the ad subresources firing and the ON pass shows them gone — that disappearance is
// the proof. Usage: node summarize.mjs <output-dir> [fixture-origin]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Derive the ad-block blocking verdict from the captured `[aegis-count]` trace text.
 * A line looks like: `[aegis-count] block=false page=<pageUrl> url=<loadedUrl>`.
 * An "ad subresource" is a load whose url is NOT on the fixture origin (i.e. one of the
 * external ad hosts the fixture references), tagged to a phase by the `?ab=` page marker.
 * @returns null when no trace is present (non-Linux / trace disabled), else
 *   `{ status: 'pass'|'fail'|'skip', off, on, detail }`.
 */
export function adblockVerdictFromLog(logText, fixtureOrigin = 'http://127.0.0.1:8137/') {
  const lines = (logText || '').split('\n').filter((l) => l.includes('[aegis-count]'));
  if (lines.length === 0) return null;
  const adSubresources = (phase) =>
    lines.filter((l) => {
      const page = (l.match(/page=(\S+)/) || [])[1] || '';
      const url = (l.match(/ url=(\S+)/) || [])[1] || '';
      return page.includes(`?ab=${phase}`) && !url.startsWith(fixtureOrigin);
    }).length;
  const off = adSubresources('off');
  const on = adSubresources('on');
  if (off === 0)
    return { status: 'skip', off, on, detail: 'no ad traffic observed in the OFF phase (trace markers absent)' };
  if (on === 0)
    return { status: 'pass', off, on, detail: `${off} ad subresource(s) loaded with ad-block OFF, ${on} with ad-block ON` };
  return { status: 'fail', off, on, detail: `ads still loaded with ad-block ON (off=${off}, on=${on})` };
}

/** Build the printable lines + exit code for a run. Pure: takes the parsed report + raw log. */
export function summarize(report, logText, fixtureOrigin, galleryPath) {
  const s = report.summary;
  const out = [`\n==> RESULT: ${s.pass} passed, ${s.fail} failed, ${s.skip} skipped`];
  for (const x of report.results.filter((x) => x.status === 'fail')) out.push(`   FAIL ${x.title}: ${x.detail || ''}`);
  const v = adblockVerdictFromLog(logText, fixtureOrigin);
  out.push(
    v
      ? `==> ad-block blocking (trace): ${v.status.toUpperCase()} — ${v.detail}`
      : '==> ad-block blocking (trace): SKIP — no [aegis-count] trace (non-Linux or trace disabled)',
  );
  out.push(`\n==> gallery: ${galleryPath}`);
  const exitCode = s.fail > 0 || (v && v.status === 'fail') ? 1 : 0;
  return { lines: out, exitCode };
}

// CLI entry (skipped when imported by the test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  const fixtureOrigin = process.argv[3] || 'http://127.0.0.1:8137/';
  if (!outDir) {
    console.error('usage: node summarize.mjs <output-dir> [fixture-origin]');
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(resolve(outDir, 'report.json'), 'utf8'));
  let logText = '';
  try {
    logText = readFileSync(resolve(outDir, 'app.log'), 'utf8');
  } catch {
    /* no app.log — verdict falls back to SKIP */
  }
  const { lines, exitCode } = summarize(report, logText, fixtureOrigin, resolve(outDir, 'report.html'));
  console.log(lines.join('\n'));
  process.exit(exitCode);
}
