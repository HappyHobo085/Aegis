// src/autopilot/compositor.test.tsx
// Drift guard: opening ANY full-window overlay must lower the content webview, i.e.
// call aegis.view.setLayout with overlay:true. A new overlay that forgets to register
// (useChromeSurface) fails here — the structural backstop to the self-registration.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
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
  delete (window as Record<string, unknown>).__aegisAutopilot;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('compositor drift guard: overlays lower the content', () => {
  // Each entry: a human label + how the autopilot control opens that overlay.
  const overlays: Array<
    [string, (c: NonNullable<ReturnType<typeof getAutopilotControl>>) => void]
  > = [
    ['settings', (c) => c.openSettings()],
    ['downloads', (c) => c.openDownloads()],
    ['favoritesManager', (c) => c.openManager()],
    ['confirmDialog', (c) => c.openConfirm('are you sure?')],
    // Real NavFailed shape: viewId, validatedURL, errorCode, errorDescription, kind
    [
      'errorOverlay',
      (c) =>
        c.showError({
          viewId: 1,
          validatedURL: 'https://x',
          errorCode: 0,
          errorDescription: 'fail',
          kind: 'load' as const,
        }),
    ],
    // Real NavCrashed shape: viewId, reason
    ['crashOverlay', (c) => c.showCrash({ viewId: 1, reason: 'crash' })],
  ];

  it.each(overlays)(
    'opening %s lowers the content (setLayout overlay:true)',
    async (_label, open) => {
      const { App } = await import('../App');
      const { aegis } = await import('../lib/ipcClient');
      render(<App />);
      // Let DesktopApp mount + register its autopilot control.
      const control = await vi.waitFor(() => {
        const c = getAutopilotControl();
        if (!c) throw new Error('control not installed yet');
        return c;
      });
      vi.clearAllMocks();
      act(() => open(control));
      const calls = (aegis.view.setLayout as unknown as { mock: { calls: unknown[][] } }).mock
        .calls;
      const last = calls[calls.length - 1];
      const opts = last?.[1] as { overlay: boolean } | undefined;
      expect(opts?.overlay).toBe(true);
    },
  );
});
