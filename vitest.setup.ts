import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Mock Tauri API for DOM tests
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// The first-run onboarding modal is localStorage-gated; default it to "completed" for
// every test so the full-app tours/specs don't get the welcome overlay. Onboarding's
// own test opts back in via the `forceOpen` prop.
beforeEach(() => {
  try {
    localStorage.setItem('aegis.onboarding.completed.v1', '1');
  } catch {
    /* jsdom localStorage may be unavailable in some node-project tests */
  }
});

afterEach(() => cleanup());
