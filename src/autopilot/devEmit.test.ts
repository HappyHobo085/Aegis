// src/autopilot/devEmit.test.ts
import { describe, it, expect, vi } from 'vitest';
const invoke = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { screenshot, emitEvent, writeReport, done } from './devEmit';
import type { Report } from './report';

describe('devEmit', () => {
  it('screenshot invokes the dev command', async () => {
    await screenshot('home');
    expect(invoke).toHaveBeenCalledWith('autopilot_screenshot', { name: 'home' });
  });
  it('emitEvent invokes the dev command', async () => {
    await emitEvent('nav.failed', { viewId: 1 });
    expect(invoke).toHaveBeenCalledWith('autopilot_emit_event', {
      name: 'nav.failed',
      payload: { viewId: 1 },
    });
  });
  it('writeReport invokes the dev command', async () => {
    const minimalReport: Report = {
      startedAt: 0,
      finishedAt: 1,
      display: true,
      results: [],
      summary: { pass: 0, fail: 0, skip: 0 },
    };
    const html = '<html></html>';
    invoke.mockClear();
    await writeReport(minimalReport, html);
    expect(invoke).toHaveBeenCalledWith('autopilot_write_report', {
      reportJson: JSON.stringify(minimalReport, null, 2),
      html,
    });
  });
  it('done invokes the dev command', async () => {
    invoke.mockClear();
    await done();
    expect(invoke).toHaveBeenCalledWith('autopilot_done');
  });
});
