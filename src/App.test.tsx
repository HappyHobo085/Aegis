// src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavState, NavFailed, NavCrashed } from '../shared/types';

const baseState: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const reloadOrStop = vi.fn(async () => {});
const setContentVisible = vi.fn(async () => {});
const setContentInset = vi.fn(async () => {});
const setChromeOverlay = vi.fn(async () => {});
const setLayout = vi.fn(async () => {});
const setFullscreen = vi.fn(async () => {});
let failedCb: ((f: NavFailed) => void) | undefined;
let crashedCb: ((c: NavCrashed) => void) | undefined;
// Multiple hooks (useNav) subscribe to onState.
// We fan out to all registered callbacks so firing stateCb drives all of them.
const stateCbs: Array<(s: NavState) => void> = [];
const stateCb = (s: NavState): void => { stateCbs.forEach((cb) => cb(s)); };

vi.mock('./lib/ipcClient', async () => (await import('./testFixtures/aegisMock')).aegisMockModule());

import { App } from './App';

beforeEach(async () => {
  vi.clearAllMocks();
  failedCb = undefined;
  crashedCb = undefined;
  stateCbs.length = 0;

  // Wire the file-local spy aliases and captured-callback references into the
  // shared mock fns that aegisMockModule() returned.
  const { aegis } = await import('./lib/ipcClient');

  // View spy aliases — point our file-level fns at the mock fns so assertions work.
  (aegis.view.setContentVisible as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) => setContentVisible(...(a as Parameters<typeof setContentVisible>)));
  (aegis.view.setContentInset as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) => setContentInset(...(a as Parameters<typeof setContentInset>)));
  (aegis.view.setChromeOverlay as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) => setChromeOverlay(...(a as Parameters<typeof setChromeOverlay>)));
  (aegis.view.setLayout as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) => setLayout(...(a as Parameters<typeof setLayout>)));
  (aegis.view.setFullscreen as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) => setFullscreen(...(a as Parameters<typeof setFullscreen>)));

  // Nav reloadOrStop alias.
  (aegis.nav.reloadOrStop as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) => reloadOrStop(...(a as Parameters<typeof reloadOrStop>)));

  // Callback capture: onState fans out to stateCbs; onFailed/onCrashed capture the cb.
  (aegis.nav.onState as ReturnType<typeof vi.fn>).mockImplementation((cb: (s: NavState) => void) => {
    stateCbs.push(cb);
    return () => { const i = stateCbs.indexOf(cb); if (i !== -1) stateCbs.splice(i, 1); };
  });
  (aegis.nav.onFailed as ReturnType<typeof vi.fn>).mockImplementation((cb: (f: NavFailed) => void) => {
    failedCb = cb;
    return () => {};
  });
  (aegis.nav.onCrashed as ReturnType<typeof vi.fn>).mockImplementation((cb: (c: NavCrashed) => void) => {
    crashedCb = cb;
    return () => {};
  });
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

  it('reports the constant top inset on mount (tab strip + toolbar + favbar, no left inset)', async () => {
    render(<App />);
    await waitFor(() => expect(setContentInset).toHaveBeenCalled());
    // 56 (toolbar) + 40 (favbar) + 36 (tab strip, desktop) = 132
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 132, left: 0 });
  });

  it('drives view.setChromeOverlay false on mount (no overlay active)', async () => {
    render(<App />);
    await waitFor(() =>
      expect(setLayout).toHaveBeenCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: false })),
    );
  });

  it('brings chrome on top when the sidebar opens', async () => {
    render(<App />);
    await waitFor(() => expect(setLayout).toHaveBeenCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: false })));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: true })),
    );
  });

  it('brings chrome on top when the Settings modal opens', async () => {
    render(<App />);
    await waitFor(() => expect(setLayout).toHaveBeenCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: false })));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /open settings/i }));
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: true })),
    );
  });

  it('brings chrome on top when the favorites manager opens', async () => {
    render(<App />);
    await waitFor(() => expect(setLayout).toHaveBeenCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: false })));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /manage favorites/i }));
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: true })),
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
    await waitFor(() => expect(setLayout).toHaveBeenCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: false })));
    act(() =>
      promptCb!({ requestId: 1, origin: 'https://example.com', permission: 'geolocation' }),
    );
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: true })),
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
    await waitFor(() => expect(setLayout).toHaveBeenCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: false })));
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /^downloads$/i }));
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, expect.objectContaining({ overlay: true })),
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
