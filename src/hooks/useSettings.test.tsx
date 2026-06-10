// src/hooks/useSettings.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Settings } from '../../shared/types';

const get = vi.fn();
const set = vi.fn();
const applyTheme = vi.fn();

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
}));

import { useSettings } from './useSettings';

const baseSettings: Settings = {
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [{ id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' }],
  hideChromeByDefault: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  document.title = '';
  get.mockResolvedValue(baseSettings);
  set.mockResolvedValue(baseSettings);
});

describe('useSettings', () => {
  it('seeds settings from aegis.settings.get on mount', async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.settings.primaryColor).toBe('#7c5cff');
  });

  it('sets document.title from siteName on mount', async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    expect(document.title).toBe('Aegis');
  });

  it('update() calls aegis.settings.set with the partial and syncs returned state', async () => {
    set.mockResolvedValue({ ...baseSettings, homeUrl: 'https://example.com/' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    await act(async () => {
      await result.current.update({ homeUrl: 'https://example.com/' });
    });
    expect(set).toHaveBeenCalledWith({ homeUrl: 'https://example.com/' });
    expect(result.current.settings.homeUrl).toBe('https://example.com/');
  });

  it('re-applies the theme when update changes primaryColor', async () => {
    set.mockResolvedValue({ ...baseSettings, primaryColor: '#ff0000' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    await act(async () => {
      await result.current.update({ primaryColor: '#ff0000' });
    });
    expect(applyTheme).toHaveBeenCalledWith({ primaryColor: '#ff0000' });
  });

  it('does NOT re-apply the theme when update omits primaryColor', async () => {
    set.mockResolvedValue({ ...baseSettings, homeUrl: 'https://example.com/' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    await act(async () => {
      await result.current.update({ homeUrl: 'https://example.com/' });
    });
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it('updates document.title when update changes siteName', async () => {
    set.mockResolvedValue({ ...baseSettings, siteName: 'My Browser' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    await act(async () => {
      await result.current.update({ siteName: 'My Browser' });
    });
    expect(document.title).toBe('My Browser');
  });
});
