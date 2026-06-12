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
const setChromeOverlay = vi.fn(async () => {});
const setFullscreen = vi.fn(async () => {});
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
      setChromeOverlay: (...a: any[]) => setChromeOverlay(...a),
      setFullscreen: (...a: any[]) => setFullscreen(...a),
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
      update: vi.fn().mockResolvedValue([]),
      renameTag: vi.fn().mockResolvedValue([]),
      deleteTag: vi.fn().mockResolvedValue([]),
      tagUnion: vi.fn().mockResolvedValue([]),
    },
    downloads: {
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue([]),
      openFile: vi.fn().mockResolvedValue(undefined),
      showInFolder: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    permissions: {
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue([]),
      resolve: vi.fn().mockResolvedValue(undefined),
      onPrompt: vi.fn().mockReturnValue(() => {}),
    },
    data: {
      export: vi.fn().mockResolvedValue({ ok: false }),
      import: vi.fn().mockResolvedValue({ ok: false }),
    },
    picker: {
      start: vi.fn().mockResolvedValue({ ok: false }),
    },
    update: {
      getState: vi.fn().mockResolvedValue({ status: 'idle', version: null, percent: 0, error: null }),
      checkNow: vi.fn().mockResolvedValue(undefined),
      restartToInstall: vi.fn().mockResolvedValue(undefined),
      onState: vi.fn().mockReturnValue(() => {}),
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

  it('mounts the sidebar toggle in the toolbar and hides the sidebar overlay by default', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /toggle sidebar/i })).toBeInTheDocument(),
    );
    // Overlay model: the sidebar panel is not rendered until opened.
    expect(screen.queryByRole('complementary', { name: /sidebar/i })).not.toBeInTheDocument();
  });

  it('clicking the toolbar toggle opens the sidebar overlay', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /toggle sidebar/i }));
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();
  });

  it('reports the constant top inset on mount (favorites bar always-on, no left inset)', async () => {
    render(<App />);
    await waitFor(() => expect(setContentInset).toHaveBeenCalled());
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 96, left: 0 });
  });

  it('drives view.setChromeOverlay false on mount (no overlay active)', async () => {
    render(<App />);
    await waitFor(() =>
      expect(setChromeOverlay).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false),
    );
  });

  it('brings chrome on top when the sidebar opens', async () => {
    render(<App />);
    await waitFor(() => expect(setChromeOverlay).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    await waitFor(() =>
      expect(setChromeOverlay).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, true),
    );
  });

  it('brings chrome on top when the Settings modal opens', async () => {
    render(<App />);
    await waitFor(() => expect(setChromeOverlay).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /open settings/i }));
    await waitFor(() =>
      expect(setChromeOverlay).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, true),
    );
  });

  it('brings chrome on top when the favorites manager opens', async () => {
    render(<App />);
    await waitFor(() => expect(setChromeOverlay).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /manage favorites/i }));
    await waitFor(() =>
      expect(setChromeOverlay).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, true),
    );
  });

  it('brings chrome on top when a permission prompt appears', async () => {
    const { aegis } = await import('./lib/ipcClient');
    let promptCb: ((p: import('../shared/types').PermissionPrompt) => void) | undefined;
    (aegis.permissions.onPrompt as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (p: import('../shared/types').PermissionPrompt) => void) => {
        promptCb = cb;
        return () => {};
      },
    );
    render(<App />);
    await waitFor(() => expect(promptCb).toBeTypeOf('function'));
    await waitFor(() => expect(setChromeOverlay).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false));
    act(() =>
      promptCb!({ requestId: 1, origin: 'https://example.com', permission: 'geolocation' }),
    );
    await waitFor(() =>
      expect(setChromeOverlay).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, true),
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

  it('mounts the toolbar downloads indicator', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /downloads/i })).toBeInTheDocument(),
    );
  });

  it('mounts the element-picker action button', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /pick element to hide/i })).toBeInTheDocument(),
    );
  });

  it('the sidebar no longer exposes a Downloads tab', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /toggle sidebar/i }));
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /downloads/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /saved/i })).toBeInTheDocument();
  });

  it('clicking the downloads indicator opens the Downloads modal, not the sidebar', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /^downloads$/i }));
    expect(screen.getByRole('dialog', { name: /downloads/i })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: /sidebar/i })).not.toBeInTheDocument();
  });

  it('brings chrome on top when the Downloads modal opens', async () => {
    render(<App />);
    await waitFor(() => expect(setChromeOverlay).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /^downloads$/i }));
    await waitFor(() =>
      expect(setChromeOverlay).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, true),
    );
  });

  it('mounts the Downloads, Site permissions and Data Settings tabs', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /open settings/i }));
    expect(screen.getByRole('tab', { name: /^downloads$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /site permissions/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^data$/i })).toBeInTheDocument();
  });

  it('shows the permission-prompt dialog when usePermissions surfaces an active prompt', async () => {
    const { aegis } = await import('./lib/ipcClient');
    let promptCb: ((p: import('../shared/types').PermissionPrompt) => void) | undefined;
    (aegis.permissions.onPrompt as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (p: import('../shared/types').PermissionPrompt) => void) => {
        promptCb = cb;
        return () => {};
      },
    );
    render(<App />);
    await waitFor(() => expect(promptCb).toBeTypeOf('function'));
    act(() =>
      promptCb!({ requestId: 1, origin: 'https://example.com', permission: 'geolocation' }),
    );
    expect(screen.getByRole('dialog', { name: undefined })).toBeInTheDocument();
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));
    expect(aegis.permissions.resolve).toHaveBeenCalledWith(1, 'allow');
  });

  it('drives view.setFullscreen false on mount', async () => {
    render(<App />);
    await waitFor(() =>
      expect(setFullscreen).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false),
    );
  });

  it('entering fullscreen hides the chrome and shows the corner exit button; exiting restores it', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');

    // Normal chrome is present.
    const enter = await screen.findByRole('button', { name: /enter fullscreen/i });
    expect(screen.getByRole('textbox', { name: /address/i })).toBeInTheDocument();

    // Enter fullscreen.
    await userEvent.click(enter);
    await waitFor(() =>
      expect(setFullscreen).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, true),
    );

    // Chrome (toolbar/favbar) is gone; only the corner exit button renders.
    expect(screen.queryByRole('textbox', { name: /address/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enter fullscreen/i })).not.toBeInTheDocument();
    const exit = screen.getByRole('button', { name: /exit fullscreen/i });
    expect(exit).toBeInTheDocument();

    // Exit fullscreen restores the normal chrome.
    await userEvent.click(exit);
    await waitFor(() =>
      expect(setFullscreen).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, false),
    );
    expect(screen.getByRole('textbox', { name: /address/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enter fullscreen/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /exit fullscreen/i })).not.toBeInTheDocument();
  });
});
