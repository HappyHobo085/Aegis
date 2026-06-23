import { describe, it, expect } from 'vitest';
import { summarize, renderReportHtml, type StepResult } from './report';

const results: StepResult[] = [
  { id: 'a', kind: 'core', title: 'A', status: 'pass' },
  { id: 'b', kind: 'core', title: 'B', status: 'fail', detail: 'boom' },
  {
    id: 'c',
    kind: 'visual',
    title: 'C',
    status: 'skip',
    detail: 'no display',
    screenshot: 'c.png',
  },
];

describe('report', () => {
  it('summarizes counts', () => {
    expect(summarize(results)).toEqual({ pass: 1, fail: 1, skip: 1 });
  });
  it('renders html with counts, failure detail, and screenshot refs', () => {
    const html = renderReportHtml({
      startedAt: 0,
      finishedAt: 1,
      display: true,
      results,
      summary: summarize(results),
    });
    expect(html).toContain('1 passed');
    expect(html).toContain('1 failed');
    expect(html).toContain('boom');
    expect(html).toContain('c.png');
    expect(html).not.toContain('screenshots skipped');
  });
  it('shows the "screenshots skipped" indicator when display is false', () => {
    const html = renderReportHtml({
      startedAt: 0,
      finishedAt: 1,
      display: false,
      results,
      summary: summarize(results),
    });
    expect(html).toContain('screenshots skipped');
  });
});
