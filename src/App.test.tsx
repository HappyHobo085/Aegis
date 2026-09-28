// src/App.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fireEvent, render, screen, act, waitFor, within } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavState, NavFailed, NavCrashed, SavedItem } from '../shared/types';

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
const stateCb = (s: NavState): void => {
  stateCbs.forEach((cb) => cb(s));
};

vi.mock('./lib/ipcClient', async () =>
  (await import('./testFixtures/aegisMock')).aegisMockModule(),
);

// Spy on applyTheme so mount tests can assert it was called with the full settings.
const applyThemeSpy = vi.fn();
const watchSystemThemeCleanup = vi.fn();
vi.mock('./lib/theme', () => ({
  applyTheme: (...a: unknown[]) => applyThemeSpy(...a),
  watchSystemTheme: (_cb: () => void) => watchSystemThemeCleanup,
}));

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
  (aegis.view.setContentVisible as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) =>
    setContentVisible(...(a as Parameters<typeof setContentVisible>)),
  );
  (aegis.view.setContentInset as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) =>
    setContentInset(...(a as Parameters<typeof setContentInset>)),
  );
  (aegis.view.setChromeOverlay as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) =>
    setChromeOverlay(...(a as Parameters<typeof setChromeOverlay>)),
  );
  (aegis.view.setLayout as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) =>
    setLayout(...(a as Parameters<typeof setLayout>)),
  );
  (aegis.view.setFullscreen as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) =>
    setFullscreen(...(a as Parameters<typeof setFullscreen>)),
  );

  // Nav reloadOrStop alias.
  (aegis.nav.reloadOrStop as ReturnType<typeof vi.fn>).mockImplementation((...a: unknown[]) =>
    reloadOrStop(...(a as Parameters<typeof reloadOrStop>)),
  );

  // Callback capture: onState fans out to stateCbs; onFailed/onCrashed capture the cb.
  (aegis.nav.onState as ReturnType<typeof vi.fn>).mockImplementation(
    (cb: (s: NavState) => void) => {
      stateCbs.push(cb);
      return () => {
        const i = stateCbs.indexOf(cb);
        if (i !== -1) stateCbs.splice(i, 1);
      };
    },
  );
  (aegis.nav.onFailed as ReturnType<typeof vi.fn>).mockImplementation(
    (cb: (f: NavFailed) => void) => {
      failedCb = cb;
      return () => {};
    },
  );
  (aegis.nav.onCrashed as ReturnType<typeof vi.fn>).mockImplementation(
    (cb: (c: NavCrashed) => void) => {
      crashedCb = cb;
      return () => {};
    },
  );
});

describe('App', () => {
  it('renders the toolbar address bar', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /address/i })).toBeInTheDocument(),
    );
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

  // `openSettings` was a plain function, and it is the SOLE dep of the effect that
  // registers the four `aegis:*` shell CustomEvents. A plain function is a new identity on
  // every render, so the effect tore down and re-registered all four listeners on every
  // single App render — and App re-renders on every nav state, tab state, zoom, adblock
  // count and settings change. The dep array was a lie: it claimed to depend on
  // `openSettings` while in practice re-running constantly.
  it('registers the four shell CustomEvent listeners ONCE, not on every render', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    try {
      render(<App />);
      await waitFor(() => expect(crashedCb).toBeTypeOf('function'));
      const aegisAdds = () =>
        addSpy.mock.calls.map((c) => String(c[0])).filter((n) => n.startsWith('aegis:'));
      // Sanity: the four ARE registered on mount, or the assertion below is vacuous.
      expect([...aegisAdds()].sort()).toEqual([
        'aegis:openSettings',
        'aegis:openSidebar',
        'aegis:toggleFavoritesBar',
        'aegis:toggleSidebar',
      ]);
      const onMount = aegisAdds().length;
      const removesOnMount = removeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((n) => n.startsWith('aegis:')).length;

      // Three separate re-renders, each from a different live subscription.
      act(() => stateCb!({ ...baseState, isLoading: true, title: 'One' }));
      act(() => stateCb!({ ...baseState, isLoading: false, title: 'Two' }));
      act(() => crashedCb!({ viewId: PRIMARY_VIEW_ID, reason: 'oom' }));

      // The listeners must be the SAME registrations, not churned copies.
      expect(aegisAdds().length).toBe(onMount);
      const aegisRemoves = removeSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((n) => n.startsWith('aegis:')).length;
      expect(aegisRemoves).toBe(removesOnMount);
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  // A production `console.log` on every launch. The performance marks/measure stay — a
  // named entry in the browser's own performance timeline is real instrumentation and
  // costs nothing — but printing to the console in a shipped build is debug output.
  //
  // The `aegis-react-start` mark has to be planted here: in the app `main.tsx` sets it
  // before `createRoot`, and this test renders `<App/>` directly. Without it the code
  // under test takes the `entries.length > 0` early-out and the assertion below would
  // pass against code that logs on every single launch — a vacuous guard.
  it('does not console.log on mount', async () => {
    performance.mark('aegis-react-start');
    expect(performance.getEntriesByName('aegis-mount')).toHaveLength(0);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      render(<App />);
      await waitFor(() => expect(crashedCb).toBeTypeOf('function'));
      // The measure really did run, so the log is reachable — otherwise this proves nothing.
      expect(performance.getEntriesByName('aegis-mount').length).toBeGreaterThan(0);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      performance.clearMarks('aegis-react-start');
      performance.clearMeasures('aegis-mount');
    }
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

  it('reports the constant top inset on mount (workspace bar + tab strip + toolbar + favbar, no left inset)', async () => {
    render(<App />);
    await waitFor(() => expect(setContentInset).toHaveBeenCalled());
    // 32 (workspace bar) + 40 (tab strip) + 56 (toolbar) + 36 (favbar) = 164
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 164, left: 0 });
    // The FindBar is NOT in that number, so the pre-measure fallback cannot be quietly
    // reserving for a bar that isn't there.
    expect(setContentInset).not.toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 204, left: 0 });
  });

  it('re-reserves the FindBar height when it opens, exactly ONCE (no double count)', async () => {
    // `useChromeHeights` now re-measures on a presence change, so `.find-bar` is part of
    // `chrome.topInset`. `App` must therefore NOT also add FIND_BAR_H on top — that would
    // reserve 80px for a 40px bar and push the page 40px too low.
    render(<App />);
    await waitFor(() =>
      expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 164, left: 0 }),
    );
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });

    // 164 + FIND_BAR_H (40) = 204. 244 would be the double count.
    await waitFor(() =>
      expect(setContentInset).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, { top: 204, left: 0 }),
    );
    expect(setContentInset).not.toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 244, left: 0 });
  });

  it('drives view.setChromeOverlay false on mount (no overlay active)', async () => {
    render(<App />);
    await waitFor(() =>
      expect(setLayout).toHaveBeenCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: false }),
      ),
    );
  });

  it('brings chrome on top when the sidebar opens', async () => {
    render(<App />);
    await waitFor(() =>
      expect(setLayout).toHaveBeenCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: false }),
      ),
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: true }),
      ),
    );
  });

  it('brings chrome on top when the Settings modal opens', async () => {
    render(<App />);
    await waitFor(() =>
      expect(setLayout).toHaveBeenCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: false }),
      ),
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /open settings/i }));
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: true }),
      ),
    );
  });

  it('brings chrome on top when the favorites manager opens', async () => {
    render(<App />);
    await waitFor(() =>
      expect(setLayout).toHaveBeenCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: false }),
      ),
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /new bookmark/i }));
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: true }),
      ),
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
    await waitFor(() =>
      expect(setLayout).toHaveBeenCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: false }),
      ),
    );
    act(() =>
      promptCb!({ requestId: 1, origin: 'https://example.com', permission: 'geolocation' }),
    );
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: true }),
      ),
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
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /open settings/i })).toBeInTheDocument(),
    );
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
    await waitFor(() =>
      expect(setLayout).toHaveBeenCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: false }),
      ),
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /^downloads$/i }));
    await waitFor(() =>
      expect(setLayout).toHaveBeenLastCalledWith(
        PRIMARY_VIEW_ID,
        expect.objectContaining({ overlay: true }),
      ),
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
    await userEvent.click(screen.getByRole('button', { name: /^always allow$/i }));
    expect(aegis.permissions.resolve).toHaveBeenCalledWith(1, 'allow');
  });

  it('drives view.setFullscreen false on mount', async () => {
    render(<App />);
    await waitFor(() => expect(setFullscreen).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false));
  });

  it('entering fullscreen hides the chrome and shows the corner exit button; exiting restores it', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');

    // Normal chrome is present.
    const enter = await screen.findByRole('button', { name: /enter fullscreen/i });
    expect(screen.getByRole('combobox', { name: /address/i })).toBeInTheDocument();

    // Enter fullscreen.
    await userEvent.click(enter);
    await waitFor(() => expect(setFullscreen).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, true));

    // Chrome (toolbar/favbar) is gone; only the corner exit button renders.
    expect(screen.queryByRole('combobox', { name: /address/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enter fullscreen/i })).not.toBeInTheDocument();
    const exit = screen.getByRole('button', { name: /exit fullscreen/i });
    expect(exit).toBeInTheDocument();

    // Exit fullscreen restores the normal chrome.
    await userEvent.click(exit);
    await waitFor(() => expect(setFullscreen).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, false));
    expect(screen.getByRole('combobox', { name: /address/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enter fullscreen/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /exit fullscreen/i })).not.toBeInTheDocument();
  });

  it('calls applyTheme with the full settings (incl. themeMode) on mount', async () => {
    applyThemeSpy.mockClear();
    render(<App />);
    // Wait for the mount effect to fire: settings.get resolves and applyTheme is called.
    await waitFor(() => expect(applyThemeSpy).toHaveBeenCalled());
    const [called] = applyThemeSpy.mock.calls[0] as [Record<string, unknown>];
    expect(called).toMatchObject({ primaryColor: '#4f8cff', themeMode: 'system' });
  });

  // BUG(F27): `setSidebarInitialTab` had no call site, so the sidebar could only ever open on
  // "Saved" — History was unreachable. The palette's "Open history" action dispatches
  // `aegis:openSidebar`; this asserts the shell honours it.
  describe('opening the sidebar on a specific tab', () => {
    it('opens on History when asked, and on Saved when asked', async () => {
      render(<App />);
      const sidebar = await screen
        .findByRole('complementary', { name: /sidebar/i })
        .catch(() => null);
      expect(sidebar).toBeNull();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('aegis:openSidebar', { detail: { tab: 'history' } }));
      });
      expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();
      // The History tab is the selected one, not Saved.
      expect(screen.getByRole('tab', { name: /history/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );

      await act(async () => {
        window.dispatchEvent(new CustomEvent('aegis:openSidebar', { detail: { tab: 'saved' } }));
      });
      expect(screen.getByRole('tab', { name: /saved/i })).toHaveAttribute('aria-selected', 'true');
    });

    it('ignores an unrecognised tab rather than opening a bogus one', async () => {
      render(<App />);
      await act(async () => {
        window.dispatchEvent(new CustomEvent('aegis:openSidebar', { detail: { tab: 'nope' } }));
      });
      expect(screen.queryByRole('complementary', { name: /sidebar/i })).not.toBeInTheDocument();
    });
  });

  // BUG(F7): the 250 ms re-assert timer only checked that the ORIGIN was unchanged, never
  // that it was still the newest pending navigation. Two chrome navigations inside that
  // window (here: two same-origin saved pages, the second click landing within 250 ms) meant
  // the FIRST timer saw an unchanged origin and re-navigated to the first URL, undoing the
  // newer navigation.
  //
  // Fake timers, because the window is 250 ms and a real `userEvent.click` on a full-App
  // re-render can take longer than that on its own — which would silently stop exercising the
  // race. `fireEvent` is synchronous, so both clicks provably land inside the window.
  describe('the 250 ms chrome-nav re-assert', () => {
    const CHROME_NAV_REASSERT_MS = 250;
    let nav: ReturnType<typeof vi.fn>;

    /**
     * Seed the FAVORITES BAR, because a saved-page row closes the sidebar when opened, so two
     * of them cannot be clicked back-to-back. A favourite chip leaves the chrome in place,
     * which is exactly what lets two navigations land inside one 250 ms window.
     */
    async function openFavoritesBar(items: { id: number; name: string; url: string }[]) {
      const { aegis } = await import('./lib/ipcClient');
      (aegis.favorites.list as ReturnType<typeof vi.fn>).mockResolvedValue(items);
      render(<App />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: `Open ${items[0].name}` })).toBeInTheDocument(),
      );
      nav = aegis.nav.navigate as ReturnType<typeof vi.fn>;
      nav.mockClear();
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('a superseded chrome navigation is never re-asserted', async () => {
      const first = { id: 1, name: 'A', url: 'https://saved.example/a' };
      const second = { id: 2, name: 'B', url: 'https://saved.example/b' };
      await openFavoritesBar([first, second]);

      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button', { name: `Open ${first.name}` }));
      fireEvent.click(screen.getByRole('button', { name: `Open ${second.name}` }));
      expect(nav).toHaveBeenCalledTimes(2);

      act(() => {
        vi.advanceTimersByTime(CHROME_NAV_REASSERT_MS + 10);
      });

      // The newest navigation re-asserts itself once; the superseded one does not.
      expect(nav).toHaveBeenCalledTimes(3);
      expect(nav).toHaveBeenNthCalledWith(1, PRIMARY_VIEW_ID, first.url);
      expect(nav).toHaveBeenNthCalledWith(2, PRIMARY_VIEW_ID, second.url);
      expect(nav).toHaveBeenNthCalledWith(3, PRIMARY_VIEW_ID, second.url);
      // The precise regression: the first URL was navigated exactly once, not re-asserted.
      expect(nav.mock.calls.filter((c) => c[1] === first.url)).toHaveLength(1);
    });

    it('re-asserts a lone chrome navigation when the origin has not moved', async () => {
      // The behaviour the re-assert exists for: a page still on the old origin 250 ms later
      // gets the navigation pushed again, because its own late redirect can cancel the first.
      const only = { id: 1, name: 'Only', url: 'https://saved.example/only' };
      await openFavoritesBar([only]);

      vi.useFakeTimers();
      fireEvent.click(screen.getByRole('button', { name: `Open ${only.name}` }));
      expect(nav).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(CHROME_NAV_REASSERT_MS + 10);
      });
      expect(nav).toHaveBeenCalledTimes(2);
      expect(nav).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, only.url);
    });
  });

  // ── The three shell CustomEvents whose LISTENERS were the fix but whose BEHAVIOUR was never tested ──
  // `App.tsx`'s own comment above the effect names the defect this registration fixed: those
  // three events "were dispatched and dropped on the floor, which silently no-op'd both toggles
  // and ALL FIFTEEN 'open settings…' palette entries". The only test that mentions them
  // (see "registers the four shell CustomEvent listeners ONCE") asserts they are REGISTERED —
  // it dispatches none of them. So emptying any of the three handler bodies left the suite
  // green, which is the same blindness that made the original defect invisible.
  // `aegis:openSidebar` is excluded here: it has two dispatch tests of its own.
  describe('the three untested shell CustomEvents', () => {
    it('aegis:toggleSidebar opens the sidebar and a second dispatch closes it', async () => {
      render(<App />);
      // Precondition: it starts CLOSED, or "it opened" below is vacuous.
      expect(screen.queryByRole('complementary', { name: /sidebar/i })).not.toBeInTheDocument();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('aegis:toggleSidebar'));
      });
      expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();

      // The second dispatch is the half that matters: a handler that only ever opened (or one
      // wired straight to `true`) would satisfy the assertion above and fail here.
      await act(async () => {
        window.dispatchEvent(new CustomEvent('aegis:toggleSidebar'));
      });
      expect(screen.queryByRole('complementary', { name: /sidebar/i })).not.toBeInTheDocument();
    });

    it('aegis:toggleFavoritesBar toggles the bookmarks bar', async () => {
      render(<App />);
      // It starts OPEN — `favBarOpen` is `useState(true)` — so the first dispatch CLOSES it.
      // I originally asserted the opposite and the precondition failed, which is how the
      // default is established rather than assumed.
      expect(screen.getByRole('navigation', { name: 'Bookmarks' })).toBeInTheDocument();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('aegis:toggleFavoritesBar'));
      });
      expect(screen.queryByRole('navigation', { name: 'Bookmarks' })).not.toBeInTheDocument();

      // …and the second dispatch brings it back, so this is a TOGGLE and not a one-way close.
      await act(async () => {
        window.dispatchEvent(new CustomEvent('aegis:toggleFavoritesBar'));
      });
      expect(screen.getByRole('navigation', { name: 'Bookmarks' })).toBeInTheDocument();
    });

    it('aegis:openSettings opens the settings dialog', async () => {
      render(<App />);
      // Precondition: settings starts CLOSED, so "it opened" below is not vacuous.
      expect(screen.queryByRole('dialog', { name: /settings/i })).not.toBeInTheDocument();

      // The named-tab form, which is what the command palette's entries all dispatch.
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('aegis:openSettings', { detail: { tab: 'downloads' } }),
        );
      });
      expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument();

      // And the no-detail form. `App.tsx` maps that to `appearance`; a handler that threw on
      // a missing `detail` would pass the case above and fail here, which is the point.
      await act(async () => {
        window.dispatchEvent(new CustomEvent('aegis:openSettings'));
      });
      expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument();
    });
  });
});
