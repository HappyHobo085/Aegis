// src/hooks/useNav.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { NavState, Settings } from '../../shared/types';

const navigate = vi.fn(async (..._args: any[]) => {});
const back = vi.fn(async (..._args: any[]) => {});
const forward = vi.fn(async (..._args: any[]) => {});
const reloadOrStop = vi.fn(async (..._args: any[]) => {});
const home = vi.fn(async (..._args: any[]) => {});
const getState = vi.fn();
const onState = vi.fn();
const settingsGet = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    nav: {
      navigate: (...a: any[]) => navigate(...a),
      back: (...a: any[]) => back(...a),
      forward: (...a: any[]) => forward(...a),
      reloadOrStop: (...a: any[]) => reloadOrStop(...a),
      home: (...a: any[]) => home(...a),
      getState: (...a: any[]) => getState(...a),
      onState: (cb: (s: NavState) => void) => onState(cb),
      onFailed: () => () => {},
      onCrashed: () => () => {},
    },
    view: { setContentVisible: vi.fn() },
    settings: { get: (...a: any[]) => settingsGet(...a), set: vi.fn() },
  },
}));

import { useNav } from './useNav';
import { publishSettings } from '../lib/settingsBus';

const baseState: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const baseSettings: Settings = {
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#4f8cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
  httpsOnly: false,
  tabIdleTimeout: 0,
  webrtcPolicy: 'public-only',
  themeMode: 'dark',
  antiFingerprint: 'off',
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(baseState);
  settingsGet.mockResolvedValue(baseSettings);
  onState.mockReturnValue(() => {});
});

describe('useNav', () => {
  it('loads the initial state from aegis.nav.getState', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    expect(getState).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });

  it('subscribes to onState and updates on push events', async () => {
    let pushed: ((s: NavState) => void) | undefined;
    onState.mockImplementation((cb: (s: NavState) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ ...baseState, url: 'https://changed.example/', isLoading: true }));
    expect(result.current.state.url).toBe('https://changed.example/');
    expect(result.current.state.isLoading).toBe(true);
  });

  it('navigate() with a full URL calls aegis.nav.navigate with the resolved URL', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    act(() => result.current.navigate('https://new.example.org/'));
    expect(navigate).toHaveBeenCalledWith(PRIMARY_VIEW_ID, 'https://new.example.org/');
  });

  it('navigate() with the current URL calls reloadOrStop, not navigate', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    act(() => result.current.navigate('https://example.com/'));
    expect(reloadOrStop).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigate() with a bare term searches using the settings template', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    act(() => result.current.navigate('cats'));
    expect(navigate).toHaveBeenCalledWith(PRIMARY_VIEW_ID, 'https://duckduckgo.com/?q=cats');
  });

  it('updates the search template live when settings change (no reload needed)', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    // User switches their default search engine in Settings → the bus publishes it.
    act(() =>
      publishSettings({
        ...baseSettings,
        defaultSearchTemplate: 'https://www.google.com/search?q=%s',
      }),
    );
    act(() => result.current.navigate('cats'));
    expect(navigate).toHaveBeenCalledWith(PRIMARY_VIEW_ID, 'https://www.google.com/search?q=cats');
  });

  it('back/forward/reloadOrStop/home delegate to aegis.nav', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    act(() => result.current.back());
    act(() => result.current.forward());
    act(() => result.current.reloadOrStop());
    act(() => result.current.home());
    expect(back).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(forward).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(reloadOrStop).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(home).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });
});
