// src/components/mobile/MobileApp.test.tsx
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NavState, Settings } from '../../../shared/types';
import { PRIMARY_VIEW_ID } from '../../../shared/types';

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
  httpsOnly: true,
  tabIdleTimeout: 30,
  webrtcPolicy: 'public-only',
  themeMode: 'system',
  antiFingerprint: 'off',
};

// Spy on applyTheme so mount tests can assert it was called with the full settings.
const applyThemeSpy = vi.fn();
const watchSystemThemeCleanup = vi.fn();
vi.mock('../../lib/theme', () => ({
  applyTheme: (...a: unknown[]) => applyThemeSpy(...a),
  watchSystemTheme: (_cb: () => void) => watchSystemThemeCleanup,
}));

vi.mock('../../lib/ipcClient', () => ({
  aegis: {
    nav: {
      navigate: vi.fn(async () => {}),
      back: vi.fn(async () => {}),
      forward: vi.fn(async () => {}),
      reloadOrStop: vi.fn(async () => {}),
      home: vi.fn(async () => {}),
      getState: vi.fn(async () => baseState),
      onState: vi.fn().mockReturnValue(() => {}),
      onFailed: vi.fn().mockReturnValue(() => {}),
      onCrashed: vi.fn().mockReturnValue(() => {}),
    },
    view: {
      setContentVisible: vi.fn(async () => {}),
      setContentInset: vi.fn(async () => {}),
      setChromeOverlay: vi.fn(async () => {}),
      setFullscreen: vi.fn(async () => {}),
    },
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
    subs: {
      list: vi.fn(async () => []),
      setEnabled: vi.fn(async () => []),
      add: vi.fn(async () => []),
      remove: vi.fn(async () => []),
      onChanged: vi.fn(() => () => undefined),
    },
    picker: { onPicked: vi.fn(() => () => undefined) },
    customFilters: {
      get: vi.fn(async () => ''),
      set: vi.fn(async () => ''),
    },
    adblock: {
      getState: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      setEnabled: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      toggleAllowlist: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      removeAllowlist: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      clearAllowlist: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      onBlockedCount: vi.fn().mockReturnValue(() => {}),
    },
    lists: { updateNow: vi.fn().mockResolvedValue({ perSource: [], lastUpdated: 0 }) },
    sync: {
      getState: vi.fn().mockResolvedValue({
        enabled: false,
        status: 'disabled',
        serverUrl: '',
        lastSyncMs: 0,
        lastError: '',
        deviceId: '',
        accountId: '',
        vaultBacking: 'none',
        hasStoredRoot: false,
      }),
      enableNew: vi.fn().mockResolvedValue({ recoveryPhrase: '' }),
      enableFromPhrase: vi.fn().mockResolvedValue({}),
      unlock: vi.fn().mockResolvedValue({}),
      disable: vi.fn().mockResolvedValue({}),
      syncNow: vi.fn().mockResolvedValue({}),
      getRecoveryPhrase: vi.fn().mockResolvedValue({ recoveryPhrase: '' }),
      listDevices: vi.fn().mockResolvedValue([]),
      removeDevice: vi.fn().mockResolvedValue([]),
      onState: vi.fn().mockReturnValue(() => {}),
      onChanged: vi.fn().mockReturnValue(() => {}),
      // `useSync` subscribes to this on mount, so a partial mock that omits it makes the
      // hook's cleanup throw and every test in this file fails for an unrelated reason.
      // `.mockReturnValue(() => {})` is a real unsubscribe, not a bare `vi.fn()` — a bare one
      // returns `undefined` and the hook calls it as a function.
      onVaultQuarantined: vi.fn().mockReturnValue(() => {}),
    },
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
      removeForOrigin: vi.fn().mockResolvedValue(0),
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
    find: {
      start: vi.fn().mockResolvedValue(undefined),
      next: vi.fn().mockResolvedValue(undefined),
      prev: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      onState: vi.fn().mockReturnValue(() => {}),
    },
    vault: {
      getState: vi.fn().mockResolvedValue({ exists: false, unlocked: false, count: 0 }),
      create: vi.fn().mockResolvedValue({ exists: true, unlocked: true, count: 0 }),
      unlock: vi.fn().mockResolvedValue({ exists: true, unlocked: true, count: 0 }),
      lock: vi.fn().mockResolvedValue({ exists: true, unlocked: false, count: 0 }),
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      onState: vi.fn().mockReturnValue(() => {}),
    },
    zoom: {
      get: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
      set: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
      reset: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    safety: {
      getState: vi.fn().mockResolvedValue(null),
      proceed: vi.fn(),
      listExceptions: vi.fn().mockResolvedValue([]),
      removeException: vi.fn(),
      onInterstitial: vi.fn(() => () => {}),
    },
    fingerprint: {
      getState: vi.fn().mockResolvedValue({ level: 'off', allowlistedHosts: [] }),
      toggleAllowlist: vi.fn().mockResolvedValue({ level: 'off', allowlistedHosts: [] }),
      removeAllowlist: vi.fn().mockResolvedValue({ level: 'off', allowlistedHosts: [] }),
      clearAllowlist: vi.fn().mockResolvedValue({ level: 'off', allowlistedHosts: [] }),
    },
    // A SEPARATE namespace from `fingerprint`, mirroring the real client: the WebRTC
    // exemption list is its own never-synced store, and a test that let one stand in for
    // the other is exactly how the ad-block allowlist came to double as the WebRTC escape
    // hatch in the first place.
    webrtc: {
      getExemptHosts: vi.fn().mockResolvedValue({ exemptHosts: [] }),
      toggleExempt: vi.fn().mockResolvedValue({ exemptHosts: [] }),
      removeExempt: vi.fn().mockResolvedValue({ exemptHosts: [] }),
      clearExempt: vi.fn().mockResolvedValue({ exemptHosts: [] }),
    },
    proxy: {
      getState: vi.fn().mockResolvedValue({
        mode: 'off',
        scheme: 'http',
        host: '',
        port: 8080,
        bypassHosts: [],
        active: false,
        uri: null,
      }),
      setConfig: vi.fn().mockResolvedValue({
        mode: 'off',
        scheme: 'http',
        host: '',
        port: 8080,
        bypassHosts: [],
        active: false,
        uri: null,
      }),
      clear: vi.fn().mockResolvedValue({
        mode: 'off',
        scheme: 'http',
        host: '',
        port: 8080,
        bypassHosts: [],
        active: false,
        uri: null,
      }),
      testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
      onState: vi.fn().mockReturnValue(() => {}),
    },
    tabs: {
      list: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      create: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      close: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      activate: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      reorder: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      setPinned: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      reopenClosed: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      setTitle: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      recordNav: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      onState: vi.fn(() => () => {}),
      onShortcut: vi.fn(() => () => {}),
    },
  },
  setBackInterceptActive: vi.fn(),
  setBottomBarHidden: vi.fn(),
  setFullscreen: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  discardTab: vi.fn(),
}));

import { aegis, setBackInterceptActive } from '../../lib/ipcClient';
import { MobileApp } from './MobileApp';
import { subscribeToasts, __resetToasts, type ToastItem } from '../../lib/toast';
import { ONBOARDING_STORAGE_KEY } from '../Onboarding';

beforeEach(() => {
  vi.clearAllMocks();
  __resetToasts();
});

describe('MobileApp', () => {
  it('renders the top bar + bottom bar (no desktop Toolbar)', async () => {
    render(<MobileApp />);
    expect(await screen.findByRole('navigation', { name: /browser actions/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/toggle sidebar/i)).toBeNull();
  });
  it('opens the menu sheet from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /menu/i }));
    expect(await screen.findByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
  });
  it('opens History from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /history/i }));
    expect(await screen.findByRole('dialog', { name: 'History' })).toBeInTheDocument();
  });
  it('opens the tab switcher from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /tabs/i }));
    expect(await screen.findByRole('dialog', { name: 'Tabs' })).toBeInTheDocument();
  });
  it('opens Saved directly from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /saved/i }));
    expect(await screen.findByRole('dialog', { name: 'Saved' })).toBeInTheDocument();
  });
  it('hides the bottom bar via the top-bar toggle', async () => {
    render(<MobileApp />);
    expect(await screen.findByRole('navigation', { name: /browser actions/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /hide toolbar/i }));
    expect(screen.queryByRole('navigation', { name: /browser actions/i })).toBeNull();
  });
  it('enters fullscreen from the bottom bar, hiding all chrome', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /enter fullscreen/i }));
    expect(screen.queryByRole('navigation', { name: /browser actions/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /enter fullscreen/i })).toBeNull();
  });

  it('calls applyTheme with the full settings (incl. themeMode) on mount', async () => {
    applyThemeSpy.mockClear();
    render(<MobileApp />);
    // Wait for the mount effect to fire: settings.get resolves and applyTheme is called.
    await waitFor(() => expect(applyThemeSpy).toHaveBeenCalled());
    const [called] = applyThemeSpy.mock.calls[0] as [Record<string, unknown>];
    expect(called).toMatchObject({ primaryColor: '#4f8cff', themeMode: 'system' });
  });

  it('records mobile native nav state back into the persistent tab registry', async () => {
    render(<MobileApp />);
    await waitFor(() =>
      expect(aegis.tabs.recordNav).toHaveBeenCalledWith(1, 'https://example.com/', 'Example'),
    );
  });

  // "Clear remembered data" used to loop over `history.entries` calling
  // `history.remove(entry.id)` once per row the renderer happened to hold, then toast
  // success. `useHistory` loads `aegis.history.list()` with no options, so the core's
  // default cap of 200 (against MAX_ENTRIES 5000) meant a site visited more than 200
  // times kept most of its history on disk while the UI claimed otherwise — and
  // `history.search` filters the FULL snapshot, so the user could search the
  // "erased" rows straight back up. The removal has to be a core operation.
  it('clears a site history through the core, not by deleting the rows it happens to hold', async () => {
    // A full page: 200 rows, all on the site's origin. If the shell looped over these
    // (the old behaviour) it would make 200 `history.remove` calls and still be wrong.
    const page = Array.from({ length: 200 }, (_, n) => ({
      id: n + 1,
      url: `https://example.com/page/${n}`,
      title: `Page ${n}`,
      visitedAt: n,
    }));
    (aegis.history.list as ReturnType<typeof vi.fn>).mockResolvedValue(page);
    (aegis.permissions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { origin: 'https://example.com', permission: 'geolocation', decision: 'deny' },
    ]);
    (aegis.history.removeForOrigin as ReturnType<typeof vi.fn>).mockResolvedValue(431);

    const toasts: ToastItem[] = [];
    const unsubscribe = subscribeToasts((next) => toasts.splice(0, toasts.length, ...next));

    try {
      render(<MobileApp />);
      fireEvent.click(await screen.findByRole('button', { name: /site information/i }));
      const clear = await screen.findByRole('button', { name: /clear remembered data/i });
      expect(clear).not.toBeDisabled();
      fireEvent.click(clear);

      // ONE core call for the whole origin, with the origin the URL actually has.
      await waitFor(() =>
        expect(aegis.history.removeForOrigin).toHaveBeenCalledWith('https://example.com'),
      );
      expect(aegis.history.removeForOrigin).toHaveBeenCalledTimes(1);

      // The per-row loop is gone: with 200 rows loaded it would have fired 200 times.
      expect(aegis.history.remove).not.toHaveBeenCalled();

      // The permissions half was already correct and must stay correct — it was never
      // paginated, so a renderer-side loop was the right shape there.
      await waitFor(() =>
        expect(aegis.permissions.remove).toHaveBeenCalledWith('https://example.com', 'geolocation'),
      );

      await waitFor(() =>
        expect(
          toasts.some((t) => /Cleared Aegis history and remembered permissions/i.test(t.message)),
        ).toBe(true),
      );
    } finally {
      unsubscribe();
    }
  });

  // `places.rs`'s `favorites.add` refuses a url that normalizes onto a live bookmark, and a
  // second tap on the favourites-bar "+" is exactly that (the same page, possibly reached
  // with a different `#fragment` or trailing slash). The refusal used to escape a floating
  // promise: an unhandled rejection and a button that appeared dead. It must reach the
  // user, and the reason must be the CORE's sentence — a Rust `Err(String)` rejects with a
  // bare string, which `err instanceof Error` would discard (see lib/saveError.ts).
  it('toasts the core reason when the favourites-bar add is refused', async () => {
    (aegis.favorites.add as ReturnType<typeof vi.fn>).mockRejectedValue(
      'that page is already bookmarked',
    );

    const toasts: ToastItem[] = [];
    const unsubscribe = subscribeToasts((next) => toasts.splice(0, toasts.length, ...next));

    try {
      render(<MobileApp />);
      fireEvent.click(await screen.findByRole('button', { name: /add bookmark/i }));
      await waitFor(() =>
        expect(
          toasts.some((t) => t.kind === 'error' && /already bookmarked/i.test(t.message)),
        ).toBe(true),
      );
    } finally {
      unsubscribe();
    }
  });

  // The same obligation for `permissions.remove`. The core refuses a revoke whose save did
  // not land, and the mobile shell's `forgetSitePermissions` / `clearRememberedSiteData`
  // fire-and-forgot it — so the "Cleared Aegis history and remembered permissions" toast
  // printed the SUCCESS wording over a refusal, and the grant came back on the next start.
  it('does not claim a site-data clear succeeded when the core refused a revoke', async () => {
    (aegis.history.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (aegis.permissions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { origin: 'https://example.com', permission: 'camera', decision: 'allow' },
    ]);
    (aegis.history.removeForOrigin as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    // A Rust `Err(String)` rejects with a bare string; `err instanceof Error` would discard
    // it, which is why the toast must go through saveErrorText.
    (aegis.permissions.remove as ReturnType<typeof vi.fn>).mockRejectedValue(
      'could not write the permissions store',
    );

    const toasts: ToastItem[] = [];
    const unsubscribe = subscribeToasts((next) => toasts.splice(0, toasts.length, ...next));

    try {
      render(<MobileApp />);
      fireEvent.click(await screen.findByRole('button', { name: /site information/i }));
      fireEvent.click(await screen.findByRole('button', { name: /clear remembered data/i }));

      await waitFor(() =>
        expect(
          toasts.some(
            (t) => t.kind === 'error' && /could not write the permissions store/i.test(t.message),
          ),
        ).toBe(true),
      );
      expect(
        toasts.some((t) => /Cleared Aegis history and remembered permissions/i.test(t.message)),
        'the success wording must NOT be printed over a refusal',
      ).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  // The OTHER half of the same obligation: the per-site "forget permissions" path, which
  // the test above only reaches through `clearRememberedSiteData`. It is a different code
  // path — `Promise.allSettled` over the permissions for one origin, reporting the FIRST
  // refusal and returning early when there is nothing to revoke — and it is the one the
  // site-information panel's own button uses.
  it('reports a REFUSED per-site permission revoke instead of dropping it', async () => {
    (aegis.history.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (aegis.permissions.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { origin: 'https://example.com', permission: 'geolocation', decision: 'allow' },
    ]);
    (aegis.permissions.remove as ReturnType<typeof vi.fn>).mockRejectedValue(
      'could not write the permissions store',
    );

    const toasts: ToastItem[] = [];
    const unsubscribe = subscribeToasts((next) => toasts.splice(0, toasts.length, ...next));

    try {
      render(<MobileApp />);
      fireEvent.click(await screen.findByRole('button', { name: /site information/i }));
      fireEvent.click(await screen.findByRole('button', { name: /forget permissions/i }));

      await waitFor(() =>
        expect(
          toasts.some(
            (t) => t.kind === 'error' && /could not write the permissions store/i.test(t.message),
          ),
        ).toBe(true),
      );
      expect(aegis.permissions.remove).toHaveBeenCalledWith('https://example.com', 'geolocation');
    } finally {
      unsubscribe();
    }
  });

  // The mobile content WebView is a NATIVE view stacked ON TOP of the chrome WebView,
  // so a full-window surface only becomes visible/tappable once the shell tells the
  // core to lower it. Surfaces that register through `useChromeSurface` (onboarding,
  // the permission prompt, the command palette) were silently not lowering it,
  // because the mobile shell mounted no `ChromeSurfaceProvider`: `useChromeSurface`
  // falls back to a no-op registry outside one. First-run onboarding was therefore
  // rendered but invisible, and the button that is the only way past it untappable.
  //
  // These drive the REAL Onboarding through the REAL provider rather than stubbing
  // the count, so they cover the registration AND the provider wiring.
  it('lowers the content view for a full-window surface that registers itself', async () => {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    render(<MobileApp />);

    // A fresh install always shows onboarding (its gate is the storage key).
    expect(await screen.findByRole('dialog', { name: /welcome|get started/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(aegis.view.setChromeOverlay).toHaveBeenCalledWith(PRIMARY_VIEW_ID, true),
    );
  });

  it('keeps the content view up when no surface is registered', async () => {
    // Onboarding completed, so nothing registers and the content WebView stays on top.
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    render(<MobileApp />);

    // Let every effect and subscription settle before concluding nothing opened.
    await screen.findByRole('navigation', { name: /browser actions/i });
    expect(aegis.view.setChromeOverlay).not.toHaveBeenCalledWith(PRIMARY_VIEW_ID, true);
  });
});

// The mobile find bar sat UNDER the fixed topbar.
//
// `.mobile-topbar` is `position: fixed`, so it is out of flow, and `.find-bar` — the
// next in-flow sibling — laid out at y=0, inside the topbar's own band: behind its
// glass, blurred by its backdrop-filter, taking no pointer events, while FindBar
// focuses the input on mount so the soft keyboard opened onto an invisible field.
//
// jsdom has no layout, so the CSS half cannot be observed here. What IS observable
// is the second half of the same defect: the find bar is a full-window surface over
// the content, and the back gesture did not know about it, so BACK could not close
// the one thing it was needed for.
describe('find in page on mobile', () => {
  // Open the find bar the way a user does: bottom-bar Menu -> "Find in page". The
  // handler calls `find.show()` and then `setSheet(null)`, so afterwards the only
  // thing that could justify intercepting BACK is the find bar itself. That is what
  // makes the assertion about the find bar rather than about the sheet.
  async function openFindFromTheMenu() {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'Menu' }));
    fireEvent.click(await screen.findByRole('button', { name: /find in page/i }));
    return screen.findByRole('textbox', { name: /find/i });
  }

  it('renders the find bar and keeps BACK able to close it', async () => {
    // Onboarding done, so no surface noise.
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    await openFindFromTheMenu();

    // The bar really is on screen, not merely state that says it is.
    expect(await screen.findByRole('button', { name: /close find/i })).toBeInTheDocument();

    // BACK must be intercepted, and it must be intercepted for the FIND BAR's sake:
    // the sheet was already closed by the time the bar opened, so an implementation
    // that only considered the sheet would pass `false` here.
    await waitFor(() => expect(setBackInterceptActive).toHaveBeenLastCalledWith(true));
  });

  it('releases BACK once the find bar is closed', async () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    await openFindFromTheMenu();
    fireEvent.click(screen.getByRole('button', { name: /close find/i }));

    // Closing it must hand BACK back to the browser, or the user is trapped: the bar
    // is gone and BACK still does nothing.
    await waitFor(() => expect(setBackInterceptActive).toHaveBeenLastCalledWith(false));
    expect(screen.queryByRole('button', { name: /close find/i })).not.toBeInTheDocument();
  });

  it('closes the find bar when the Android BACK gesture arrives', async () => {
    // The menu route above can never isolate this: opening find always also changes
    // `sheet`, so an effect that ignored `find.open` entirely would still re-run. This
    // drives the NATIVE back handler directly instead, which is the only way to reach
    // the find branch on its own.
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    await openFindFromTheMenu();

    const back = (window as unknown as { __aegisMobileBack?: () => void }).__aegisMobileBack;
    expect(typeof back).toBe('function');
    // `act` because this calls the handler the way the NATIVE side does — a plain
    // function call, not a dispatched event — and it drives React state.
    act(() => back!());

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /close find/i })).not.toBeInTheDocument(),
    );
    // And the gesture is handed back to the browser, so BACK is not swallowed.
    await waitFor(() => expect(setBackInterceptActive).toHaveBeenLastCalledWith(false));
  });
});
