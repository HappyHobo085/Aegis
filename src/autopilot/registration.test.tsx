// src/autopilot/registration.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Reuse the App test's mock by importing it is not possible; mock minimally here.
vi.mock('../lib/ipcClient', async () => (await import('../testFixtures/aegisMock')).aegisMockModule());

beforeEach(() => { vi.stubEnv('VITE_AEGIS_AUTOPILOT', '1'); });
afterEach(() => { delete (window as Record<string, unknown>).__aegisAutopilot; vi.unstubAllEnvs(); vi.resetModules(); });

describe('control surface registration', () => {
  it('registers window.__aegisAutopilot when dev + flag set', async () => {
    const { render } = await import('@testing-library/react');
    const { App } = await import('../App');
    render(<App />);
    expect((window as Record<string, unknown>).__aegisAutopilot).toBeDefined();
  });
});
