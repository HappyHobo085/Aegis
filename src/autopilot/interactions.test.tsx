// src/autopilot/interactions.test.tsx
// Vitest interaction tour: renders <App/> with the mocked aegis, reaches each
// interaction's target screen via the shared reachScreen helper, runs the
// gesture, and asserts the effect via the CallLog (no real core needed).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { INTERACTIONS } from './interactions';
import { makeVitestCtx } from './interactionCtx';
import { reachScreen } from './reach';
import { getAutopilotControl } from './control';
import { SCREENS, type ScreenId } from './screens';

vi.mock('../lib/ipcClient', async () => (await import('../testFixtures/aegisMock')).aegisMockModule());

const screenById = (id: ScreenId) => SCREENS.find((s) => s.id === id)!;

beforeEach(() => { vi.stubEnv('VITE_AEGIS_AUTOPILOT', '1'); vi.spyOn(window, 'confirm').mockReturnValue(true); });
afterEach(() => { cleanup(); delete (window as Record<string, unknown>).__aegisAutopilot; vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules(); });

describe('desktop interaction tour', () => {
  // Exclude mobile-only specs (domain 'mobile.*'): those run in interactions.mobile.test.tsx
  // against the MobileApp shell. Cross-platform specs (mobile: true on desktop-domain specs)
  // ARE included here because their controls exist in both shells.
  for (const spec of INTERACTIONS.filter((s) => s.layers.includes('vitest') && !s.domain.startsWith('mobile.'))) {
    it(`interaction: ${spec.id}`, async () => {
      const { App } = await import('../App');
      const { aegis } = await import('../lib/ipcClient');
      const { container } = render(<App />);
      const control = getAutopilotControl()!;
      const ctx = makeVitestCtx(container, aegis, (s) => reachScreen(control, screenById(s), { emitEvent: vi.fn() }));
      await act(async () => { await ctx.reach(spec.screen); });
      ctx.calls.reset();
      await act(async () => { await spec.run(ctx); });
      await expect(spec.assert(ctx), spec.id).resolves.toBeTruthy();
    });
  }
});
