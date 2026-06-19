// src/autopilot/run.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runAutopilot } from './run';
import { CATALOG } from './catalog';
import { SCREENS } from './screens';
import type { AutopilotControl } from './control';

function fakeControl(): AutopilotControl {
  return Object.fromEntries(
    ['openSettings','closeSettings','openDownloads','closeDownloads','openManager','closeManager','setSidebar','setShield','enterFullscreen','exitFullscreen','showError','clearError','showCrash','clearCrash','openConfirm'].map((k) => [k, vi.fn()]),
  ) as unknown as AutopilotControl;
}

// Minimal faithful-shape fake of the api (returns shapes the catalog asserts).
const api = new Proxy({}, {
  get: () => new Proxy({}, { get: () => async () => [] }),
}) as never;

describe('runAutopilot', () => {
  it('produces a result per screen and per catalog entry', async () => {
    const screenshot = vi.fn(async () => {});
    const report = await runAutopilot({
      api, control: fakeControl(), screenshot, emitEvent: vi.fn(async () => {}),
      writeReport: vi.fn(async () => {}), done: vi.fn(async () => {}),
      hasDisplay: true, now: () => 0, navigateFixture: async () => null,
    });
    expect(report.results.length).toBeGreaterThanOrEqual(SCREENS.length + CATALOG.length);
    expect(report.summary.pass + report.summary.fail + report.summary.skip).toBe(report.results.length);
  });
  it('marks screenshots skipped when no display', async () => {
    const report = await runAutopilot({
      api, control: fakeControl(), screenshot: vi.fn(async () => {}), emitEvent: vi.fn(async () => {}),
      writeReport: vi.fn(async () => {}), done: vi.fn(async () => {}),
      hasDisplay: false, now: () => 0, navigateFixture: async () => null,
    });
    expect(report.results.some((r) => r.kind === 'visual' && r.status === 'skip')).toBe(true);
  });
});
