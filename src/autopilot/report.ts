export type StepStatus = 'pass' | 'fail' | 'skip';

export interface StepResult {
  id: string;
  kind: 'core' | 'visual' | 'interaction'; // core = asserted against the backend; visual = UI state shown for a screenshot; interaction = real gesture driven through the chrome UI
  title: string;
  status: StepStatus;
  detail?: string;
  screenshot?: string; // filename relative to the report dir
}

export interface Report {
  startedAt: number;
  finishedAt: number;
  display: boolean; // false => screenshots were skipped
  results: StepResult[];
  summary: { pass: number; fail: number; skip: number };
}

export function summarize(results: StepResult[]): Report['summary'] {
  return {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export function renderReportHtml(report: Report): string {
  const { summary } = report;
  const rows = report.results
    .map((r) => {
      const shot = r.screenshot ? `<img src="shots/${esc(r.screenshot)}" loading="lazy" width="320">` : '';
      const detail = r.detail ? `<div class="detail">${esc(r.detail)}</div>` : '';
      return `<tr class="${esc(r.status)}"><td>${esc(r.status)}</td><td>${esc(r.kind)}</td><td>${esc(r.title)}${detail}</td><td>${shot}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Aegis autopilot report</title>
<style>body{font:14px system-ui;background:#111;color:#eee;margin:24px}
h1{margin:0 0 8px}.bar{margin-bottom:16px}.pass{color:#4ade80}.fail{color:#f87171}.skip{color:#fbbf24}
table{border-collapse:collapse;width:100%}td{border-top:1px solid #333;padding:8px;vertical-align:top}
.detail{color:#f87171;font-family:monospace;white-space:pre-wrap;margin-top:4px}
tr.fail{background:#2a1414}img{border:1px solid #333;border-radius:4px}</style>
<h1>Aegis autopilot</h1>
<div class="bar"><b class="pass">${summary.pass} passed</b> · <b class="fail">${summary.fail} failed</b> · <b class="skip">${summary.skip} skipped</b>${report.display ? '' : ' · <i>screenshots skipped (no display)</i>'}</div>
<table><tr><th>status</th><th>kind</th><th>step</th><th>shot</th></tr>
${rows}
</table>`;
}
