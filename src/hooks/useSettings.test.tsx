// src/hooks/useSettings.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Settings } from '../../shared/types';

const get = vi.fn();
const set = vi.fn();
const applyTheme = vi.fn();
let watchSystemThemeCallback: (() => void) | null = null;
const watchSystemTheme = vi.fn((cb: () => void) => {
  watchSystemThemeCallback = cb;
  return () => {
    watchSystemThemeCallback = null;
  };
});

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    settings: {
      get: (...a: any[]) => get(...a),
      set: (...a: any[]) => set(...a),
    },
  },
}));

vi.mock('../lib/theme', () => ({
  applyTheme: (...a: any[]) => applyTheme(...a),
  watchSystemTheme: (...a: any[]) => watchSystemTheme(...a),
}));

import { useSettings } from './useSettings';

const baseSettings: Settings = {
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#3b82f6',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [{ id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' }],
  hideChromeByDefault: false,
  downloadDir: '',
  httpsOnly: true,
  tabIdleTimeout: 30,
  webrtcPolicy: 'public-only',
  themeMode: 'system',
  syncServerUrl: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  watchSystemThemeCallback = null;
  document.title = '';
  get.mockResolvedValue(baseSettings);
  set.mockResolvedValue(baseSettings);
});

describe('useSettings', () => {
  it('seeds settings from aegis.settings.get on mount', async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.primaryColor).toBe('#3b82f6'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.settings.primaryColor).toBe('#3b82f6');
  });

  it('update() calls aegis.settings.set with the partial and syncs returned state', async () => {
    set.mockResolvedValue({ ...baseSettings, homeUrl: 'https://example.com/' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.primaryColor).toBe('#3b82f6'));
    await act(async () => {
      await result.current.update({ homeUrl: 'https://example.com/' });
    });
    expect(set).toHaveBeenCalledWith({ homeUrl: 'https://example.com/' });
    expect(result.current.settings.homeUrl).toBe('https://example.com/');
  });

  it('re-applies the full theme when update changes primaryColor', async () => {
    const updated = { ...baseSettings, primaryColor: '#ff0000' };
    set.mockResolvedValue(updated);
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.primaryColor).toBe('#3b82f6'));
    await act(async () => {
      await result.current.update({ primaryColor: '#ff0000' });
    });
    expect(applyTheme).toHaveBeenCalledWith(updated);
  });

  it('re-applies the full theme when update changes themeMode', async () => {
    const updated = { ...baseSettings, themeMode: 'dark' as const };
    set.mockResolvedValue(updated);
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.primaryColor).toBe('#3b82f6'));
    await act(async () => {
      await result.current.update({ themeMode: 'dark' });
    });
    expect(applyTheme).toHaveBeenCalledWith(updated);
  });

  it('does NOT re-apply the theme when update omits primaryColor and themeMode', async () => {
    set.mockResolvedValue({ ...baseSettings, homeUrl: 'https://example.com/' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.primaryColor).toBe('#3b82f6'));
    await act(async () => {
      await result.current.update({ homeUrl: 'https://example.com/' });
    });
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it('subscribes to watchSystemTheme on mount and cleans up on unmount', async () => {
    const { unmount } = renderHook(() => useSettings());
    await waitFor(() => expect(watchSystemTheme).toHaveBeenCalled());
    expect(watchSystemThemeCallback).not.toBeNull();
    unmount();
    // After unmount the cleanup fn ran, so watchSystemThemeCallback is null
    expect(watchSystemThemeCallback).toBeNull();
  });

  it('re-applies the theme when the OS preference changes (system mode)', async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.primaryColor).toBe('#3b82f6'));
    // Simulate OS preference change
    act(() => {
      watchSystemThemeCallback?.();
    });
    expect(applyTheme).toHaveBeenCalledWith(baseSettings);
  });
});
