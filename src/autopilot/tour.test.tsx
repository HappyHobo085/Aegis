// src/autopilot/tour.test.tsx
// Exhaustive desktop autopilot tour: mounts the real <App/> with the mocked aegis,
// walks every SCREENS entry via the shared reachScreen helper, and exercises every
// CATALOG feature against the mock API.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { SCREENS } from './screens';
import { CATALOG } from './catalog';
import { reachScreen } from './reach';
import { getAutopilotControl } from './control';

vi.mock('../lib/ipcClient', async () =>
  (await import('../testFixtures/aegisMock')).aegisMockModule(),
);

beforeEach(() => {
  vi.stubEnv('VITE_AEGIS_AUTOPILOT', '1');
  vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__aegisAutopilot;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('desktop autopilot tour', () => {
  it('reaches every desktop screen without crashing', async () => {
    const { App } = await import('../App');
    render(<App />);
    const control = getAutopilotControl();
    expect(control).toBeDefined();
    for (const screen of SCREENS) {
      await act(async () => {
        await reachScreen(control!, screen, { emitEvent: vi.fn() });
      });
      // App still mounted (no throw / unmount) after reaching the screen.
      expect(document.querySelector('.app, .fullscreen-exit')).toBeTruthy();
    }
  });

  it('exercises every catalog feature against the mock api', async () => {
    const { aegis } = await import('../lib/ipcClient');
    for (const f of CATALOG) {
      await expect(f.exercise(aegis), `catalog ${f.id}`).resolves.toBeUndefined();
    }
  });
});
