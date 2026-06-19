import { describe, it, expect, vi, afterEach } from 'vitest';
import { installAutopilotControl, getAutopilotControl, type AutopilotControl } from './control';

function fake(): AutopilotControl {
  return {
    openSettings: vi.fn(), closeSettings: vi.fn(), openDownloads: vi.fn(), closeDownloads: vi.fn(),
    openManager: vi.fn(), closeManager: vi.fn(), setSidebar: vi.fn(), setShield: vi.fn(),
    enterFullscreen: vi.fn(), exitFullscreen: vi.fn(), showError: vi.fn(), clearError: vi.fn(),
    showCrash: vi.fn(), clearCrash: vi.fn(), openConfirm: vi.fn(),
    setHistoryEntries: vi.fn(),
    setSavedItems: vi.fn(),
    setSitePermissions: vi.fn(),
    setAllowlistedHosts: vi.fn(),
  };
}

afterEach(() => { delete (window as Record<string, unknown>).__aegisAutopilot; });

describe('autopilot control surface', () => {
  it('install exposes the control on window and getter returns it', () => {
    const c = fake();
    const off = installAutopilotControl(c);
    expect(getAutopilotControl()).toBe(c);
    off();
    expect(getAutopilotControl()).toBeUndefined();
  });
});
