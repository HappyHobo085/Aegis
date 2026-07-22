// src/autopilot/interactions.mobile.test.tsx
// Mobile vitest interaction tour: renders the MOBILE shell (<App/> with the
// .aegis-mobile class set so isMobile=true → MobileApp renders) and runs the
// subset of INTERACTIONS marked `mobile: true` (both cross-platform specs like
// address-bar + reload that share components with MobileTopBar, and mobile-only
// specs for MobileBottomBar / MobileMenuSheet / MobileTabSwitcher).
//
// Bootstrap pattern: mirrors tour.mobile.test.tsx — set `.aegis-mobile` on
// <html> BEFORE the dynamic `import('../App')` so isMobile is computed correctly
// at module-load time.
//
// Reach strategy: MobileApp does NOT call installAutopilotControl (that's
// DesktopApp only), so `reachScreen(control, …)` cannot be used.  Instead every
// mobile spec reaches its screen via direct DOM clicks on the bottom bar / sheet
// buttons — the spec's own `run()` body is the reach.  The `ctx.reach` function
// in makeVitestCtx is wired to a no-op reach for mobile (control is unavailable),
// which is fine because all mobile specs declare `screen: 'home'` (the initial
// render state) and include their own navigation gestures in `run()`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { INTERACTIONS } from './interactions';
import { makeVitestCtx } from './interactionCtx';

vi.mock('../lib/ipcClient', async () =>
  (await import('../testFixtures/aegisMock')).aegisMockModule(),
);

// Filter: mobile specs only (marked mobile: true) that run in vitest.
const MOBILE_SPECS = INTERACTIONS.filter((s) => s.mobile === true && s.layers.includes('vitest'));

beforeEach(() => {
  vi.stubEnv('VITE_AEGIS_AUTOPILOT', '1');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  // Set .aegis-mobile BEFORE the dynamic import so isMobile is computed correctly.
  document.documentElement.classList.add('aegis-mobile');
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('aegis-mobile');
  delete (window as unknown as Record<string, unknown>).__aegisAutopilot;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('mobile interaction tour', () => {
  for (const spec of MOBILE_SPECS) {
    it(`interaction: ${spec.id}`, async () => {
      // Dynamic import AFTER setting .aegis-mobile so isMobile is computed at load time.
      const { App } = await import('../App');
      const { aegis } = await import('../lib/ipcClient');
      const { container } = render(<App />);
      // Mobile has no AutopilotControl surface; reach is a no-op (all mobile specs
      // start from 'home' and include their reach gestures in run()).
      const ctx = makeVitestCtx(container, aegis, async () => {});
      // No reachScreen call needed: mobile specs start from the rendered home state.
      ctx.calls.reset();
      await act(async () => {
        await spec.run(ctx);
      });
      await expect(spec.assert(ctx), spec.id).resolves.toBeTruthy();
    });
  }
});
