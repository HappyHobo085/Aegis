// src/autopilot/tour.mobile.test.tsx
// Mobile autopilot tour: sets the .aegis-mobile class BEFORE dynamically importing
// App so that isMobile is computed correctly at module load, then verifies that
// MobileApp renders without crashing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../lib/ipcClient', async () => (await import('../testFixtures/aegisMock')).aegisMockModule());

beforeEach(() => { document.documentElement.classList.add('aegis-mobile'); });
afterEach(() => { cleanup(); document.documentElement.classList.remove('aegis-mobile'); vi.resetModules(); });

describe('mobile autopilot tour', () => {
  it('renders MobileApp without crashing when .aegis-mobile is set', async () => {
    // App computes isMobile at module load, so import AFTER setting the class.
    const { App } = await import('../App');
    const { container } = render(<App />);
    expect(container.querySelector('.mobile-bottombar, .aegis-mobile, .app')).toBeTruthy();
  });
});
