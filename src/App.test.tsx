// src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavState, NavFailed, NavCrashed, Settings } from '../shared/types';

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
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#4f8cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
};

const reloadOrStop = vi.fn(async () => {});
const setContentVisible = vi.fn(async () => {});
const setContentInset = vi.fn(async () => {});
let failedCb: ((f: NavFailed) => void) | undefined;
let crashedCb: ((c: NavCrashed) => void) | undefined;
let stateCb: ((s: NavState) => void) | undefined;

vi.mock('./lib/ipcClient', () => ({
  aegis: {
    nav: {
      navigate: vi.fn(async () => {}),
      back: vi.fn(async () => {}),
      forward: vi.fn(async () => {}),
      reloadOrStop: (...a: any[]) => reloadOrStop(...a),
      home: vi.fn(async () => {}),
      getState: vi.fn(async () => baseState),
      onState: (cb: (s: NavState) => void) => {
        stateCb = cb;
        return () => {};
      },
      onFailed: (cb: (f: NavFailed) => void) => {
        failedCb = cb;
        return () => {};
      },
      onCrashed: (cb: (c: NavCrashed) => void) => {
        crashedCb = cb;
        return () => {};
      },
    },
    view: {
      setContentVisible: (...a: any[]) => setContentVisible(...a),
      setContentInset: (...a: any[]) => setContentInset(...a),
    },
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
    subs: {
      list: vi.fn(async () => []),
      setEnabled: vi.fn(async () => []),
      add: vi.fn(async () => []),
      remove: vi.fn(async () => []),
    },
    customFilters: {
      get: vi.fn(async () => ''),
      set: vi.fn(async () => ''),
    },
    adblock: {
      getState: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      setEnabled: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      toggleAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      removeAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      clearAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      onBlockedCount: vi.fn().mockReturnValue(() => {}),
    },
    lists: { updateNow: vi.fn().mockResolvedValue({ perSource: [], lastUpdated: 0 }) },
    favorites: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      reorder: vi.fn().mockResolvedValue([]),
      renameTag: vi.fn().mockResolvedValue([]),
      deleteTag: vi.fn().mockResolvedValue([]),
      tagUnion: vi.fn().mockResolvedValue([]),
    },
    history: {
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    saved: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      has: vi.fn().mockResolvedValue(false),
    },
  },
}));

import { App } from './App';

beforeEach(() => {
  vi.clearAllMocks();
  failedCb = undefined;
  crashedCb = undefined;
  stateCb = undefined;
});

describe('App', () => {
  it('renders the toolbar address bar', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /address/i })).toBeInTheDocument());
  });

  it('shows the ErrorOverlay when a nav.failed event arrives', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Retry on the overlay calls aegis.nav.reloadOrStop', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(reloadOrStop).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });

  it('shows the overlay on nav.crashed and clears it on a fresh nav.state', async () => {
    render(<App />);
    await waitFor(() => expect(crashedCb).toBeTypeOf('function'));
    act(() => crashedCb!({ viewId: PRIMARY_VIEW_ID, reason: 'oom' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => stateCb!({ ...baseState, isLoading: true, crashed: false }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does NOT call setContentVisible for the error/crash overlay', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    expect(setContentVisible).not.toHaveBeenCalled();
  });

  it('renders the AdblockShield in the toolbar', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /ad blocking/i })).toBeInTheDocument(),
    );
  });

  it('mounts the favorites bar and the sidebar toggle', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /toggle sidebar/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();
  });

  it('reports the content inset on mount (favorites bar always-on, sidebar closed)', async () => {
    render(<App />);
    await waitFor(() => expect(setContentInset).toHaveBeenCalled());
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 96, left: 0 });
  });

  it('toggling the sidebar re-reports the inset with the sidebar width on the left', async () => {
    render(<App />);
    await waitFor(() => expect(setContentInset).toHaveBeenCalled());
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    await waitFor(() =>
      expect(setContentInset).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, { top: 96, left: 280 }),
    );
  });

  it('opens the Settings modal from the toolbar gear button', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /open settings/i }));
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument();
  });

  it('does not mount the Settings modal until the gear is clicked', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /open settings/i })).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: /settings/i })).not.toBeInTheDocument();
  });

  it('reflects the configured siteName in the document title', async () => {
    render(<App />);
    await waitFor(() => expect(document.title).toBe('Aegis'));
  });
});
