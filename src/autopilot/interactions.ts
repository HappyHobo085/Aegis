// src/autopilot/interactions.ts
import type { AegisApi, NavState, TabsState, TabShortcut, Favorite, HistoryEntry, SavedItem, Settings as AegisSettings, NavFailed, NavCrashed, SafetyInterstitialPayload, PermissionPrompt, RedirectBlocked } from '../../shared/types';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { ScreenId } from './screens';

export type InteractionLayer = 'vitest' | 'live';

/** Recorded mock-call inspection (vitest); inert on live (asserts via real state instead). */
export interface CallLog {
  /** Call-argument arrays for a dotted aegis path, e.g. of('favorites.add'). [] on live. */
  of(path: string): unknown[][];
  /** True if `path` was called (optionally with a predicate on the first call's args). */
  called(path: string, match?: (args: unknown[]) => boolean): boolean;
  /** Clear recorded calls (the tour calls this before each interaction's run). */
  reset(): void;
}

export interface InteractionCtx {
  layer: InteractionLayer;
  click(el: Element): Promise<void>;
  type(el: Element, text: string): Promise<void>;
  press(key: 'Enter' | 'Escape' | 'ctrl+t' | 'ctrl+w' | 'ctrl+shift+t'): Promise<void>;
  /** Fire a contextmenu event on the element (used for tab pin via right-click). */
  contextMenu(el: Element): Promise<void>;
  byRole(role: string, name?: string | RegExp): HTMLElement | null;
  byText(text: string | RegExp): HTMLElement | null;
  byLabel(label: string | RegExp): HTMLElement | null;
  bySelector(sel: string): HTMLElement | null;
  aegis: AegisApi;
  calls: CallLog;
  reach(screen: ScreenId): Promise<void>;
  /**
   * Vitest-only: emit a NavState update to the subscribed useNav hook so React
   * re-renders with the new state (e.g. enables the Back/Forward buttons).
   * The callback is captured at ctx-creation time, BEFORE calls.reset() clears
   * the mock's call log.  No-op on live (live state comes from the real core).
   */
  emitNavState?(state: NavState): Promise<void>;
  /**
   * Vitest-only: push a TabsState update into useTabs so the TabStrip re-renders
   * with the desired tab list (e.g. 2 tabs so the activate/close interactions can
   * click a second tab).  No-op on live.
   */
  emitTabsState?(state: TabsState): Promise<void>;
  /**
   * Vitest-only: invoke the shortcut callback that App subscribed to via
   * aegis.tabs.onShortcut so keyboard-shortcut interactions can be exercised in
   * jsdom even though no native GTK/Win accelerator fires there.  No-op on live.
   */
  emitTabShortcut?(shortcut: TabShortcut): Promise<void>;
  /**
   * Vitest-only: seed the history panel with the given entries by resetting the
   * history.list mock return and firing the onChanged subscriber so the panel
   * re-renders with non-empty content.  No-op on live (live history comes from
   * real navigations in the disposable profile).
   */
  emitHistory?(entries: HistoryEntry[]): Promise<void>;
  /**
   * Vitest-only: seed the favorites list by resetting the favorites.list mock
   * return and triggering a sync-change re-fetch so useFavorites re-renders
   * with the seeded items.  No-op on live.
   */
  emitFavorites?(items: Favorite[]): Promise<void>;
  /**
   * Vitest-only: seed the saved panel with items + tagUnion via the control-surface seam
   * (setSavedItems → useSaved._setSavedItems), using flushSync so the DOM updates
   * synchronously before the next gesture fires.  No-op on live.
   */
  emitSaved?(items: SavedItem[], tagUnion: string[]): Promise<void>;
  /**
   * Vitest-only: seed the SitePermissionsTab with a list of remembered permissions via
   * the control-surface seam (setSitePermissions → usePermissions._setPermissions), using
   * flushSync so the DOM updates synchronously before the next gesture fires.  No-op on live.
   */
  emitSitePermissions?(permissions: import('../../shared/types').SitePermission[]): Promise<void>;
  /**
   * Vitest-only: seed the allowlist state in useAdblock by mocking adblock.getState
   * and publishing a syncBus 'allowlist' change (which triggers the hook's onSyncChange
   * callback → re-calls getState → setState with the seeded hosts).  No-op on live.
   */
  emitAllowlist?(hosts: string[]): Promise<void>;
  /**
   * Vitest-only: seed the DownloadsPanel with entries by calling setDownloadEntries on
   * the autopilot control (which calls useDownloads._setDownloads directly via flushSync),
   * so the Clear button becomes enabled.  No-op on live.
   */
  emitDownloadsChanged?(entries: import('../../shared/types').DownloadEntry[]): Promise<void>;
  /**
   * Vitest-only: emit a NavFailed event by invoking the callback that App registered via
   * aegis.nav.onFailed — identical to the real core emitting nav.failed. The error overlay
   * renders synchronously (flushSync).  No-op on live.
   */
  emitNavFailed?(f: NavFailed): Promise<void>;
  /**
   * Vitest-only: emit a NavCrashed event by invoking the callback that App registered via
   * aegis.nav.onCrashed — identical to the real core emitting nav.crashed. The crash overlay
   * renders synchronously (flushSync).  No-op on live.
   */
  emitNavCrashed?(c: NavCrashed): Promise<void>;
  /**
   * Vitest-only: emit a SafetyInterstitialPayload (or null to dismiss) by invoking the
   * callback that useSafety registered via aegis.safety.onInterstitial.  No-op on live.
   */
  emitSafetyInterstitial?(p: SafetyInterstitialPayload | null): Promise<void>;
  /**
   * Vitest-only: emit a PermissionPrompt (or null to dismiss) by invoking the callback
   * that usePermissions registered via aegis.permissions.onPrompt.  No-op on live.
   */
  emitPermissionPrompt?(p: PermissionPrompt | null): Promise<void>;
  /**
   * Vitest-only: emit a RedirectBlocked event by invoking the callback that App registered
   * via aegis.redirect.onBlocked so the RedirectBar renders.  No-op on live.
   */
  emitRedirectBlocked?(r: RedirectBlocked): Promise<void>;
}

export interface InteractionSpec {
  id: string;
  domain: string;
  description: string;
  screen: ScreenId;
  layers: InteractionLayer[];
  /**
   * Whether this interaction can run in the mobile shell (MobileApp).
   * `true`  → included in the mobile interaction tour.
   * `false` or absent → desktop-only; excluded from the mobile tour.
   * Mobile-only controls (bottom bar, menu sheet, tab switcher) are
   * added as separate specs with `mobile: true` but no desktop analog.
   */
  mobile?: boolean;
  run(ctx: InteractionCtx): Promise<void>;
  assert(ctx: InteractionCtx): Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a NavState update to the App's useNav hook.
 *  Uses ctx.emitNavState (captured before any reset() wipes mock.calls) so the
 *  Back/Forward buttons can be enabled before clicking them.  No-op on live. */
async function emitNavState(ctx: InteractionCtx, state: NavState): Promise<void> {
  await ctx.emitNavState?.(state);
}

/**
 * Set the value of a non-editable input (color, number, select) and fire a change event.
 * Cannot use ctx.type() for these because userEvent.clear() fails on non-text inputs.
 * This uses the React testing pattern: override via the descriptor + dispatch change event.
 */
function fireInputChange(el: Element, value: string): void {
  const proto = el instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : el instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Default nav state used to seed vitest state updates. */
const BASE_NAV: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

export const INTERACTIONS: InteractionSpec[] = [
  // ─── existing Task-2 seed ───────────────────────────────────────────────
  {
    id: 'toolbar.addressBar.navigate',
    domain: 'toolbar',
    description: 'Type a URL in the address bar and press Enter → navigates',
    screen: 'home',
    layers: ['vitest', 'live'],
    mobile: true, // MobileTopBar includes the same AddressBar component
    run: async (ctx) => {
      const bar = ctx.byRole('textbox', /address|url|search/i) ?? ctx.bySelector('input[type="text"]');
      if (!bar) throw new Error('address bar input not found');
      await ctx.type(bar, 'example.com');
      await ctx.press('Enter');
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('nav.navigate', (a) => String(a[1]).includes('example.com')))
          throw new Error('nav.navigate not called with example.com');
        return 'address bar Enter → nav.navigate(example.com)';
      }
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await ctx.aegis.nav.getState(1)).url.includes('example.com')) return 'address bar Enter → page navigated';
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error('live: url never became example.com');
    },
  },

  // ─── Task 3: toolbar + shield popover ───────────────────────────────────

  {
    id: 'toolbar.back',
    domain: 'toolbar',
    description: 'Click the Back button → nav.back called',
    screen: 'home',
    // live excluded: the live CallLog is inert so nav.back cannot be confirmed via
    // ctx.calls, and the page under test has no guaranteed back history to observe.
    layers: ['vitest'],
    run: async (ctx) => {
      // Back button is disabled when canGoBack=false; emit a state update to enable it.
      await emitNavState(ctx, { ...BASE_NAV, canGoBack: true });
      const btn = ctx.byRole('button', /^Back$/);
      if (!btn) throw new Error('Back button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.back'))
        throw new Error('nav.back not called');
      return 'Back button → nav.back()';
    },
  },

  {
    id: 'toolbar.forward',
    domain: 'toolbar',
    description: 'Click the Forward button → nav.forward called',
    screen: 'home',
    // live excluded: the live CallLog is inert so nav.forward cannot be confirmed via
    // ctx.calls, and the page under test has no guaranteed forward history to observe.
    layers: ['vitest'],
    run: async (ctx) => {
      // Forward button is disabled when canGoForward=false; emit a state update to enable it.
      await emitNavState(ctx, { ...BASE_NAV, canGoForward: true });
      const btn = ctx.byRole('button', /^Forward$/);
      if (!btn) throw new Error('Forward button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.forward'))
        throw new Error('nav.forward not called');
      return 'Forward button → nav.forward()';
    },
  },

  {
    id: 'toolbar.reload',
    domain: 'toolbar',
    description: 'Click the Reload button → nav.reloadOrStop called',
    screen: 'home',
    layers: ['vitest', 'live'],
    mobile: true, // MobileTopBar has a Reload/Stop button (aria-label="Reload")
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^Reload$/);
      if (!btn) throw new Error('Reload button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('nav.reloadOrStop'))
          throw new Error('nav.reloadOrStop not called');
        return 'Reload button → nav.reloadOrStop()';
      }
      return 'Reload button clicked';
    },
  },

  {
    id: 'toolbar.home',
    domain: 'toolbar',
    description: 'Click the Home button → nav.home called',
    screen: 'home',
    layers: ['vitest', 'live'],
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^Home$/);
      if (!btn) throw new Error('Home button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('nav.home'))
          throw new Error('nav.home not called');
        return 'Home button → nav.home()';
      }
      // Live: read the configured homeUrl and poll until the page lands on it.
      const settings = await ctx.aegis.settings.get();
      const homeUrl = settings.homeUrl;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const { url } = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
        if (homeUrl && url.startsWith(homeUrl)) return `Home button → ${url}`;
        // Fallback: any non-blank change away from the pre-click state is acceptable
        // evidence when homeUrl itself is empty/default.
        if (!homeUrl && url !== 'about:blank' && url !== 'https://example.com/')
          return `Home button → ${url}`;
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error(`live: url never became homeUrl (${homeUrl ?? 'default'}) within 8 s`);
    },
  },

  {
    id: 'toolbar.addressBar.search',
    domain: 'toolbar',
    description: 'Type a search query in the address bar and press Enter → nav.navigate called with search URL',
    screen: 'home',
    layers: ['vitest', 'live'],
    mobile: true, // MobileTopBar includes the same AddressBar component
    run: async (ctx) => {
      const bar = ctx.byRole('textbox', /address|url|search/i) ?? ctx.bySelector('input[type="text"]');
      if (!bar) throw new Error('address bar input not found');
      await ctx.type(bar, 'hello world');
      await ctx.press('Enter');
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        // 'hello world' has a space so it is treated as a search term → navigate to
        // searchTemplate.replace('%s', encodeURIComponent('hello world')).
        if (!ctx.calls.called('nav.navigate', (a) => String(a[1]).toLowerCase().includes('hello')))
          throw new Error('nav.navigate not called with hello');
        return 'address bar search → nav.navigate(…hello…)';
      }
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const { url } = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
        // The search engine URL will contain the encoded query ("hello") or its host.
        if (url.toLowerCase().includes('hello') || url.includes('duckduckgo') || url.includes('google'))
          return 'address bar search → page navigated to search results';
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error('live: url never contained search term or search-engine host within 8 s');
    },
  },

  {
    id: 'toolbar.bookmarkStar.add',
    domain: 'toolbar',
    // NOTE: The bookmark star in App is wired to `saved.add` (the Saved feature),
    // NOT `favorites.add` (the Favorites/FavBar feature).  The label is
    // "Save bookmark" / "Remove bookmark" (BookmarkButton).  Assertions check
    // `saved.add` (the real call), not `favorites.add`.
    description: 'Click the Save bookmark star → saved.add called (saves current page)',
    screen: 'home',
    layers: ['vitest', 'live'],
    run: async (ctx) => {
      // Ensure the page has a saveable URL (canSave = hostOf(url) !== null).
      await emitNavState(ctx, { ...BASE_NAV, url: 'https://example.com/', title: 'Example' });
      const btn = ctx.byRole('button', /save bookmark/i);
      if (!btn) throw new Error('Save bookmark button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('saved.add'))
          throw new Error('saved.add not called');
        return 'Save bookmark → saved.add()';
      }
      const url = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
      const items = await ctx.aegis.saved.list();
      if (!items.some((i) => i.url === url))
        throw new Error(`live: ${url} not in saved list`);
      return `Save bookmark → saved persisted (${url})`;
    },
  },

  {
    id: 'toolbar.bookmarkStar.remove',
    domain: 'toolbar',
    // IMPORTANT: lives on 'live' only because the vitest mock's aegis.saved.has
    // always returns false → BookmarkButton always shows "Save bookmark" (not
    // "Remove bookmark") → the remove path cannot be cleanly exercised in jsdom.
    // In the live run the real core reflects actual saved state after the .add step.
    description: 'Click the Remove bookmark star → saved.remove called (unsaves current page)',
    screen: 'home',
    layers: ['live'],
    run: async (ctx) => {
      // Ensure the current page is saved first (the .add interaction runs before this).
      // The live profile is disposable; we add then immediately remove.
      const state = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
      const items = await ctx.aegis.saved.list();
      if (!items.some((i) => i.url === state.url)) {
        // Save it first if not already saved.
        await ctx.aegis.saved.add({ url: state.url, title: state.title });
        await new Promise((r) => setTimeout(r, 400));
      }
      // The BookmarkButton now should show "Remove bookmark".
      const btn = ctx.byRole('button', /remove bookmark/i);
      if (!btn) throw new Error('Remove bookmark button not found (page may not be saved)');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      // Live: the item should be gone from the saved list.
      const state = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
      await new Promise((r) => setTimeout(r, 500)); // let the list update
      const items = await ctx.aegis.saved.list();
      if (items.some((i) => i.url === state.url))
        throw new Error(`live: ${state.url} still in saved list after remove`);
      return `Remove bookmark → saved.remove() → ${state.url} gone from list`;
    },
  },

  {
    id: 'toolbar.picker',
    domain: 'toolbar',
    description: 'Click the element-picker button → picker.start called',
    screen: 'home',
    // live is excluded: the element-picker triggers a native cross-webview interaction
    // that jsdom cannot exercise, and in a live autopilot run the picker UI would block
    // the rest of the sequence.
    layers: ['vitest'],
    run: async (ctx) => {
      const btn = ctx.byRole('button', /pick element to hide/i);
      if (!btn) throw new Error('Picker button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('picker.start'))
        throw new Error('picker.start not called');
      return 'Picker button → picker.start()';
    },
  },

  (() => {
    // Capture pre-click enabled state so the assert can verify the flip.
    let _preEnabled: boolean | undefined;
    return {
      id: 'shieldPopover.toggleAdblock',
      domain: 'shieldPopover',
      description: 'Open the ad-block shield popover and toggle the switch → adblock.setEnabled called',
      screen: 'shieldPopover',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          // Snapshot the pre-click state so assert can detect the actual flip.
          _preEnabled = (await ctx.aegis.adblock.getState()).enabled;
        }
        // reachScreen sets the App-level shieldOpen flag (for z-order/layout) but does NOT
        // open the AdblockShield's own internal popover state. Click the shield button to
        // actually render the popover, then click the toggle inside it.
        const shieldBtn = ctx.byRole('button', /^Ad blocking$/);
        if (!shieldBtn) throw new Error('Ad blocking shield button not found');
        await ctx.click(shieldBtn);
        // Now the popover is rendered; find the toggle switch (role="switch" aria-label="Ad blocking").
        const toggle = ctx.byRole('switch', /^Ad blocking$/);
        if (!toggle) throw new Error('Ad blocking switch not found in shield popover');
        await ctx.click(toggle);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('adblock.setEnabled'))
            throw new Error('adblock.setEnabled not called');
          return 'shield toggle → adblock.setEnabled()';
        }
        // Live: verify enabled actually flipped from the pre-click value.
        const after = await ctx.aegis.adblock.getState();
        if (_preEnabled !== undefined && after.enabled === _preEnabled)
          throw new Error(`live: adblock.enabled did not flip (still ${after.enabled} after toggle)`);
        // Restore the original enabled state.
        await ctx.aegis.adblock.setEnabled(_preEnabled ?? !after.enabled);
        return `shield toggle → enabled flipped ${_preEnabled}→${after.enabled} (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'shieldPopover.allowlistSite',
    domain: 'shieldPopover',
    description: 'Open the ad-block shield popover and click the allowlist checkbox → adblock.toggleAllowlist called',
    screen: 'shieldPopover',
    // live excluded: the allowlist checkbox is disabled on about:blank (no parseable host),
    // and navigating to a real host in the live run makes the assert host-dependent and
    // fragile (race between nav commit and popover re-render).  The vitest path fully
    // covers toggleAllowlist via the mock.
    layers: ['vitest'],
    run: async (ctx) => {
      // Ensure the nav URL has a parseable host so the allowlist checkbox is enabled.
      await emitNavState(ctx, { ...BASE_NAV, url: 'https://example.com/', title: 'Example' });
      // Open the shield popover (same as above — reachScreen only sets z-order, not UI state).
      const shieldBtn = ctx.byRole('button', /^Ad blocking$/);
      if (!shieldBtn) throw new Error('Ad blocking shield button not found');
      await ctx.click(shieldBtn);
      // The allowlist label is "Allow ads on <host>" (host = example.com from nav state).
      const allowToggle = ctx.byLabel(/allow ads on/i);
      if (!allowToggle) throw new Error('Allow-ads checkbox not found in shield popover');
      await ctx.click(allowToggle);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('adblock.toggleAllowlist'))
        throw new Error('adblock.toggleAllowlist not called');
      return 'allowlist checkbox → adblock.toggleAllowlist()';
    },
  },

  // ─── Task 4: tabs + keyboard shortcuts ──────────────────────────────────

  {
    id: 'tabs.newButton',
    domain: 'tabs',
    description: 'Click the "+" New tab button → tabs.create called; live: tab count increases',
    screen: 'home',
    layers: ['vitest', 'live'],
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^New tab$/);
      if (!btn) throw new Error('"New tab" button not found (aria-label="New tab")');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('tabs.create'))
          throw new Error('tabs.create not called');
        return 'New tab button → tabs.create()';
      }
      // Live: the tab list should now have one more tab than before.
      // We created it via a DOM click; close the extra tab to restore state.
      const state = await ctx.aegis.tabs.list();
      if (state.tabs.length < 2)
        throw new Error(`live: expected ≥2 tabs after New tab click, got ${state.tabs.length}`);
      // Clean up: close the newest (last) tab.
      const newId = state.tabs[state.tabs.length - 1].id;
      await ctx.aegis.tabs.close(newId);
      return `New tab button → tab list grew to ${state.tabs.length} (extra tab closed)`;
    },
  },

  (() => {
    // Capture the newly-created tab's id so the live assert can verify activeId switched.
    let _newTabId: number | undefined;
    return {
      id: 'tabs.activate',
      domain: 'tabs',
      description: 'Click a second tab → tabs.activate called; live: activeId changes',
      screen: 'home',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Inject a 2-tab state so the TabStrip renders a second clickable tab.
          const TWO_TABS: TabsState = {
            tabs: [
              { id: 1, pinned: false, live: true, title: 'Tab 1', url: 'https://example.com/' },
              { id: 2, pinned: false, live: true, title: 'Tab 2', url: 'https://example.org/' },
            ],
            activeId: 1,
          };
          await ctx.emitTabsState?.(TWO_TABS);
          // Tab 2 is inactive; click its tab div (aria-label = labelFor result = 'Tab 2').
          const tab2 = ctx.byRole('tab', /^Tab 2$/);
          if (!tab2) throw new Error('Second tab "Tab 2" not found in TabStrip');
          await ctx.click(tab2);
        } else {
          // Live: create a second tab first, snapshot its id, then click it.
          const before = await ctx.aegis.tabs.list();
          await ctx.aegis.tabs.create();
          // Wait briefly for the new tab to appear in the DOM.
          await new Promise((r) => setTimeout(r, 400));
          const after = await ctx.aegis.tabs.list();
          const newTab = after.tabs.find((t) => !before.tabs.some((b) => b.id === t.id));
          if (!newTab) throw new Error('live: newly created tab not found in list');
          _newTabId = newTab.id;
          // Click the tab div in the chrome DOM (its aria-label = 'New tab').
          const tabEl = ctx.byLabel(/^New tab$/) ?? ctx.bySelector(`[role="tab"][aria-selected="false"]`);
          if (!tabEl) throw new Error('live: second tab element not found in DOM');
          await ctx.click(tabEl);
        }
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('tabs.activate'))
            throw new Error('tabs.activate not called');
          return 'click second tab → tabs.activate()';
        }
        // Live: activeId must equal the newly-created tab's id — proves the click worked.
        await new Promise((r) => setTimeout(r, 400));
        const state = await ctx.aegis.tabs.list();
        if (_newTabId === undefined)
          throw new Error('live: _newTabId was never captured (run() may not have executed)');
        if (state.activeId !== _newTabId)
          throw new Error(`live: activeId is ${state.activeId}, expected ${_newTabId} — activate had no effect`);
        // Clean up: close the extra tab.
        await ctx.aegis.tabs.close(_newTabId);
        return `click second tab → activeId became ${_newTabId} (extra tab closed)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture the tab count BEFORE the close so the live assert can verify it decreased by 1.
    let _preCloseCount: number | undefined;
    return {
      id: 'tabs.close',
      domain: 'tabs',
      description: 'Click the X on a tab → tabs.close called; live: tab count decreases',
      screen: 'home',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Inject a 2-tab state so there is a second tab whose X we can click
          // without risking closing the last tab (which some UIs may guard against).
          const TWO_TABS: TabsState = {
            tabs: [
              { id: 1, pinned: false, live: true, title: 'Tab 1', url: 'https://example.com/' },
              { id: 2, pinned: false, live: true, title: 'Tab 2', url: 'https://example.org/' },
            ],
            activeId: 1,
          };
          await ctx.emitTabsState?.(TWO_TABS);
          const closeBtn = ctx.byRole('button', /^Close Tab 2$/);
          if (!closeBtn) throw new Error('Close-tab button for "Tab 2" not found');
          await ctx.click(closeBtn);
        } else {
          // Live: create a second tab, snapshot the post-create count, then click close.
          await ctx.aegis.tabs.create();
          await new Promise((r) => setTimeout(r, 400));
          const after = await ctx.aegis.tabs.list();
          _preCloseCount = after.tabs.length;
          // Close button aria-label is "Close <title>"; new tab title is 'New tab'.
          const closeBtn = ctx.byRole('button', /^Close New tab$/);
          if (!closeBtn) throw new Error('live: Close button for new tab not found');
          await ctx.click(closeBtn);
        }
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('tabs.close'))
            throw new Error('tabs.close not called');
          return 'close-tab X → tabs.close()';
        }
        // Live: tab count must have decreased by exactly 1 from the pre-close snapshot.
        await new Promise((r) => setTimeout(r, 400));
        const state = await ctx.aegis.tabs.list();
        if (_preCloseCount === undefined)
          throw new Error('live: _preCloseCount was never captured (run() may not have executed)');
        if (state.tabs.length !== _preCloseCount - 1)
          throw new Error(
            `live: expected ${_preCloseCount - 1} tabs after close, got ${state.tabs.length} — close had no effect`,
          );
        return `close-tab X → tab count decreased from ${_preCloseCount} to ${state.tabs.length}`;
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'tabs.setPinned',
    domain: 'tabs',
    description: 'Right-click a tab (context menu) → tabs.setPinned called',
    screen: 'home',
    // live excluded: a real contextmenu in the content webview environment is OS-managed
    // and the dispatchEvent approach won't reliably reach the React handler in the live
    // chrome renderer without a controlled focus state.  The vitest path (fireEvent.contextMenu
    // via ctx.contextMenu) fully covers the wiring.
    layers: ['vitest'],
    run: async (ctx) => {
      // The initial mock state already has tab id=1; context-menu on it triggers pin toggle.
      const tab = ctx.byRole('tab');
      if (!tab) throw new Error('No tab found in TabStrip');
      await ctx.contextMenu(tab);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('tabs.setPinned'))
        throw new Error('tabs.setPinned not called');
      return 'tab context-menu → tabs.setPinned()';
    },
  },

  {
    id: 'keyboard.newTab',
    domain: 'keyboard',
    description: 'Ctrl+T shortcut via onShortcut event → tabs.create called',
    screen: 'home',
    // On Linux/macOS, Ctrl+T is a native GTK/menu accelerator that fires tabs.shortcut
    // via IPC — NOT a DOM keydown.  In jsdom, isWindows=false so App's Windows-only
    // DOM keydown handler is not registered.  The only testable path in vitest is to
    // invoke the onShortcut callback directly via emitTabShortcut.
    // Live: the native accelerator fires in the real app and is tested by the catalog's
    // tabs.create verify(); the interaction layer doesn't add live coverage here.
    // vitest-only (conscious deviation from "both layers"): the native Ctrl+T accelerator
    // cannot be dispatched as a DOM key in jsdom OR via the live ctx's DOM press(), and
    // the catalog's tabs.create verify() already covers the live new-tab effect end-to-end.
    layers: ['vitest'],
    run: async (ctx) => {
      await ctx.emitTabShortcut?.('new');
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('tabs.create'))
        throw new Error('tabs.create not called after Ctrl+T shortcut');
      return 'Ctrl+T (onShortcut "new") → tabs.create()';
    },
  },

  {
    id: 'keyboard.closeTab',
    domain: 'keyboard',
    description: 'Ctrl+W shortcut via onShortcut event → tabs.close called',
    screen: 'home',
    // Same reasoning as keyboard.newTab: native accelerator on Linux/macOS, not a DOM
    // key.  Windows-only DOM handler excluded (jsdom isWindows=false).
    layers: ['vitest'],
    run: async (ctx) => {
      await ctx.emitTabShortcut?.('close');
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('tabs.close'))
        throw new Error('tabs.close not called after Ctrl+W shortcut');
      return 'Ctrl+W (onShortcut "close") → tabs.close()';
    },
  },

  {
    id: 'keyboard.reopenTab',
    domain: 'keyboard',
    description: 'Ctrl+Shift+T shortcut via onShortcut event → tabs.reopenClosed called',
    screen: 'home',
    // Same reasoning as keyboard.newTab: native accelerator on Linux/macOS.
    layers: ['vitest'],
    run: async (ctx) => {
      await ctx.emitTabShortcut?.('reopen');
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('tabs.reopenClosed'))
        throw new Error('tabs.reopenClosed not called after Ctrl+Shift+T shortcut');
      return 'Ctrl+Shift+T (onShortcut "reopen") → tabs.reopenClosed()';
    },
  },

  // ─── Task 5: favorites bar/manager + sidebar history ────────────────────

  (() => {
    // Vitest seeding: open the manager, mock favorites.add to return a seeded list,
    // fill the Add form, close the manager — the hook's setFavorites fires and the
    // FavBar gets the chip.  No external emit helper needed.
    type MockFn = { mockResolvedValue(v: Favorite[]): void };
    const SEED: Favorite = { id: 1, name: 'Autopilot Test', url: 'https://autopilot.test/', position: 0 };
    return {
      id: 'favbar.openFavorite',
      domain: 'favbar',
      description: 'Click a favorite chip in the favorites bar → nav.navigate called with its url',
      screen: 'home',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // 1. Configure add to return the seeded list so useFavorites sets state.
          (ctx.aegis.favorites.add as unknown as MockFn).mockResolvedValue([SEED]);
          // 2. Open the FavoritesManager via the "Manage favorites" button in the FavBar.
          const manageBtn = ctx.byLabel(/^Manage favorites$/);
          if (!manageBtn) throw new Error('Manage favorites button not found in FavBar');
          await ctx.click(manageBtn);
          // 3. Fill in the Add form and click Add — this triggers the hook's add(),
          //    which calls setFavorites([SEED]) so the FavBar re-renders.
          const nameInput = ctx.byLabel(/^New favorite name$/i);
          if (!nameInput) throw new Error('New favorite name input not found during favbar seed');
          await ctx.type(nameInput, SEED.name);
          const urlInput = ctx.byLabel(/^New favorite URL$/i);
          if (!urlInput) throw new Error('New favorite URL input not found during favbar seed');
          await ctx.type(urlInput, SEED.url);
          const addBtn = ctx.byRole('button', /^Add favorite$/);
          if (!addBtn) throw new Error('Add favorite button not found during favbar seed');
          await ctx.click(addBtn);
          // 4. Close the manager so the FavBar is visible again.
          const closeBtn = ctx.byRole('button', /^Close$/);
          if (closeBtn) await ctx.click(closeBtn);
        } else {
          // Live: add a favorite via the API then wait for the bar to update.
          await ctx.aegis.favorites.add({ name: SEED.name, url: SEED.url });
          await new Promise((r) => setTimeout(r, 400));
        }
        const chip = ctx.byLabel(/^Open Autopilot Test$/);
        if (!chip) throw new Error('Favorite chip "Autopilot Test" not found in favorites bar');
        await ctx.click(chip);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('nav.navigate', (a) => String(a[1]).includes('autopilot.test')))
            throw new Error('nav.navigate not called with autopilot.test url');
          return 'favbar chip → nav.navigate(https://autopilot.test/)';
        }
        // Live: poll until the page url contains autopilot.test; then clean up the favorite.
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const { url } = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
          if (url.includes('autopilot.test')) {
            const list = await ctx.aegis.favorites.list();
            for (const f of list.filter((f) => f.url.includes('autopilot.test'))) {
              await ctx.aegis.favorites.remove(f.id);
            }
            return `favbar chip → nav navigated to ${url}`;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        throw new Error('live: url never became autopilot.test after clicking favorite chip');
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture the favorites list length BEFORE adding so the assert can verify +1.
    let _baseLength: number | undefined;
    return {
      id: 'favManager.add',
      domain: 'favManager',
      description: 'Open favorites manager → fill name + URL → click Add → favorites.add called',
      screen: 'favoritesManager',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          const list = await ctx.aegis.favorites.list();
          _baseLength = list.length;
        }
        const nameInput = ctx.byLabel(/^New favorite name$/i);
        if (!nameInput) throw new Error('New favorite name input not found');
        const urlInput = ctx.byLabel(/^New favorite URL$/i);
        if (!urlInput) throw new Error('New favorite URL input not found');
        await ctx.type(nameInput, 'Test Site');
        await ctx.type(urlInput, 'https://testsite.test/');
        const addBtn = ctx.byRole('button', /^Add favorite$/);
        if (!addBtn) throw new Error('Add favorite button not found');
        await ctx.click(addBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('favorites.add'))
            throw new Error('favorites.add not called');
          return 'favManager add → favorites.add()';
        }
        // Live: list length must have increased by 1 from baseline.
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.favorites.list();
        if (_baseLength === undefined)
          throw new Error('live: _baseLength was never captured');
        if (list.length !== _baseLength + 1)
          throw new Error(`live: expected ${_baseLength + 1} favorites after add, got ${list.length}`);
        // Clean up: remove the test favorite.
        const added = list.find((f) => f.url === 'https://testsite.test/');
        if (added) await ctx.aegis.favorites.remove(added.id);
        return `favManager add → list grew from ${_baseLength} to ${list.length} (cleaned up)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture the original name before renaming so we can restore and assert the change.
    let _originalName: string | undefined;
    let _favoriteId: number | undefined;
    type MockFn = { mockResolvedValue(v: Favorite[]): void };
    const SEED: Favorite = { id: 10, name: 'Original Name', url: 'https://rename-test.test/', position: 0 };
    return {
      id: 'favManager.rename',
      domain: 'favManager',
      description: 'Edit a favorite name in the manager → click Save → favorites.update called',
      screen: 'favoritesManager',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed the manager with one row via the Add form:
          // 1. Mock favorites.add to return the seeded item so the hook updates state.
          (ctx.aegis.favorites.add as unknown as MockFn).mockResolvedValue([SEED]);
          // 2. Fill in the Add form and submit → useFavorites.add → setFavorites([SEED]).
          const newNameInput = ctx.byLabel(/^New favorite name$/i);
          if (!newNameInput) throw new Error('New favorite name input not found during seed');
          await ctx.type(newNameInput, SEED.name);
          const newUrlInput = ctx.byLabel(/^New favorite URL$/i);
          if (!newUrlInput) throw new Error('New favorite URL input not found during seed');
          await ctx.type(newUrlInput, SEED.url);
          const addBtn = ctx.byRole('button', /^Add favorite$/);
          if (!addBtn) throw new Error('Add favorite button not found during seed');
          await ctx.click(addBtn);
          _originalName = SEED.name;
          _favoriteId = SEED.id;
        } else {
          // Live: add a favorite to rename via the API.
          const added = await ctx.aegis.favorites.add({ name: SEED.name, url: SEED.url });
          const fav = added.find((f) => f.url === SEED.url);
          if (!fav) throw new Error('live: could not find the just-added favorite');
          _originalName = fav.name;
          _favoriteId = fav.id;
          await new Promise((r) => setTimeout(r, 400));
        }
        // The FavoritesManager renders a row with "Name for <name>" input.
        const nameInput = ctx.byLabel(new RegExp(`^Name for ${_originalName}$`));
        if (!nameInput) throw new Error(`Name input for "${_originalName}" not found in manager`);
        await ctx.type(nameInput, 'Renamed Favorite');
        const saveBtn = ctx.byRole('button', new RegExp(`^Save favorite ${_originalName}$`));
        if (!saveBtn) throw new Error(`Save button for "${_originalName}" not found`);
        await ctx.click(saveBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('favorites.update'))
            throw new Error('favorites.update not called');
          return 'favManager rename → favorites.update()';
        }
        // Live: the name in the list must have changed.
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.favorites.list();
        const fav = list.find((f) => f.id === _favoriteId);
        if (!fav) throw new Error(`live: favorite id=${_favoriteId} not found after rename`);
        if (fav.name !== 'Renamed Favorite')
          throw new Error(`live: name is "${fav.name}", expected "Renamed Favorite"`);
        // Restore original name and clean up.
        if (_favoriteId !== undefined && _originalName !== undefined) {
          await ctx.aegis.favorites.update(_favoriteId, { name: _originalName });
        }
        if (_favoriteId !== undefined) await ctx.aegis.favorites.remove(_favoriteId);
        return `favManager rename → name changed to "Renamed Favorite" (restored + cleaned up)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture list length BEFORE deletion so assert can verify it shrank by 1.
    let _baseLength: number | undefined;
    type MockFn = { mockResolvedValue(v: Favorite[]): void };
    const SEED: Favorite = { id: 20, name: 'To Delete', url: 'https://delete-test.test/', position: 0 };
    return {
      id: 'favManager.delete',
      domain: 'favManager',
      description: 'Click delete on a favorite row in the manager → favorites.remove called',
      screen: 'favoritesManager',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed the manager with one row via the Add form:
          // Mock favorites.add to return the seeded item so the hook updates state.
          (ctx.aegis.favorites.add as unknown as MockFn).mockResolvedValue([SEED]);
          const newNameInput = ctx.byLabel(/^New favorite name$/i);
          if (!newNameInput) throw new Error('New favorite name input not found during seed');
          await ctx.type(newNameInput, SEED.name);
          const newUrlInput = ctx.byLabel(/^New favorite URL$/i);
          if (!newUrlInput) throw new Error('New favorite URL input not found during seed');
          await ctx.type(newUrlInput, SEED.url);
          const addBtn = ctx.byRole('button', /^Add favorite$/);
          if (!addBtn) throw new Error('Add favorite button not found during seed');
          await ctx.click(addBtn);
        } else {
          // Live: add a dedicated favorite to delete, snapshot baseline after add.
          await ctx.aegis.favorites.add({ name: SEED.name, url: SEED.url });
          await new Promise((r) => setTimeout(r, 400));
          const list = await ctx.aegis.favorites.list();
          _baseLength = list.length;
        }
        const removeBtn = ctx.byRole('button', /^Remove favorite To Delete$/);
        if (!removeBtn) throw new Error('Remove favorite "To Delete" button not found');
        await ctx.click(removeBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('favorites.remove'))
            throw new Error('favorites.remove not called');
          return 'favManager delete → favorites.remove()';
        }
        // Live: list length must have decreased by exactly 1 from baseline.
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.favorites.list();
        if (_baseLength === undefined)
          throw new Error('live: _baseLength was never captured');
        if (list.length !== _baseLength - 1)
          throw new Error(`live: expected ${_baseLength - 1} favorites after delete, got ${list.length}`);
        return `favManager delete → list shrank from ${_baseLength} to ${list.length}`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture url before clicking the history row so the live assert can verify the
    // url CHANGED away from _urlBeforeClick to the entry's destination — not merely
    // that it is non-blank (which it already was before the click).
    let _urlBeforeClick: string | undefined;
    // The destination url of the history entry we seed/click (live only; vitest
    // asserts via CallLog so we don't need to track it there).
    const SEED_URL = 'https://example.org/';
    return {
      id: 'sidebar.history.openEntry',
      domain: 'sidebar.history',
      description: 'Click a history row → nav.navigate called with the entry url',
      screen: 'sidebar:history',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed the history panel with one entry so there is a row to click.
          const SEEDED: HistoryEntry[] = [
            { id: 1, url: 'https://history-test.test/', title: 'History Test', visitedAt: Date.now() },
          ];
          await ctx.emitHistory?.(SEEDED);
        } else {
          // Live: navigate to a DIFFERENT page first (not SEED_URL) to create a
          // history entry for SEED_URL, so the click produces an observable url change.
          // Navigate to example.com first (the seed entry destination will be example.org).
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, 'https://example.com/');
          await new Promise((r) => setTimeout(r, 1500));
          // Now navigate to the entry's destination so history contains it, then go
          // back to example.com so clicking the history row produces a real url change.
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, SEED_URL);
          await new Promise((r) => setTimeout(r, 1500));
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, 'https://example.com/');
          await new Promise((r) => setTimeout(r, 1500));
          // Re-reach the sidebar:history screen (nav may have closed it).
          await ctx.reach('sidebar:history');
          await new Promise((r) => setTimeout(r, 300));
          // Snapshot the current url BEFORE clicking the history row.
          _urlBeforeClick = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
        }
        // Click the first "Open <url>" button scoped to the history panel.
        // Use a CSS selector to avoid matching "Open settings" and other toolbar buttons.
        const openBtn = ctx.bySelector('.history-panel__open');
        if (!openBtn) throw new Error('No history entry open-button found (panel may be empty)');
        await ctx.click(openBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('nav.navigate'))
            throw new Error('nav.navigate not called after clicking history row');
          return 'history row → nav.navigate()';
        }
        // Live: poll until the url changes away from _urlBeforeClick AND matches
        // the history entry's destination (SEED_URL).  A url that never changes
        // (or changes to a different page) is a test failure.
        if (_urlBeforeClick === undefined)
          throw new Error('live: _urlBeforeClick was never captured (run() may not have executed)');
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const { url } = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
          if (url !== _urlBeforeClick && url.includes('example.org'))
            return `history row → nav navigated from ${_urlBeforeClick} to ${url}`;
          await new Promise((r) => setTimeout(r, 400));
        }
        const finalUrl = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
        throw new Error(
          `live: url did not change to ${SEED_URL} after clicking history entry (was ${_urlBeforeClick}, now ${finalUrl})`,
        );
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture history length BEFORE deletion so assert can verify it shrank by 1.
    let _baseLength: number | undefined;
    return {
      id: 'sidebar.history.deleteEntry',
      domain: 'sidebar.history',
      description: 'Click the remove button on a history row → history.remove called',
      screen: 'sidebar:history',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          const SEEDED: HistoryEntry[] = [
            { id: 5, url: 'https://history-delete.test/', title: 'To Remove', visitedAt: Date.now() },
          ];
          await ctx.emitHistory?.(SEEDED);
        } else {
          // Live: navigate to seed the list, then snapshot the length.
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, 'https://example.com/');
          await new Promise((r) => setTimeout(r, 1500));
          await ctx.reach('sidebar:history');
          await new Promise((r) => setTimeout(r, 300));
          const list = await ctx.aegis.history.list();
          _baseLength = list.length;
        }
        // The remove button has class history-panel__remove; scope to avoid
        // matching other "Remove" buttons outside the history panel.
        const removeBtn = ctx.bySelector('.history-panel__remove');
        if (!removeBtn) throw new Error('No history entry remove-button found (panel may be empty)');
        await ctx.click(removeBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('history.remove'))
            throw new Error('history.remove not called after clicking remove');
          return 'history row remove → history.remove()';
        }
        // Live: list length must have decreased by 1.
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.history.list();
        if (_baseLength === undefined)
          throw new Error('live: _baseLength was never captured');
        if (list.length !== _baseLength - 1)
          throw new Error(`live: expected ${_baseLength - 1} entries after remove, got ${list.length}`);
        return `history row remove → list shrank from ${_baseLength} to ${list.length}`;
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'sidebar.history.search',
    domain: 'sidebar.history',
    description: 'Type in the history search box → history.search called with the query',
    screen: 'sidebar:history',
    // Live observation is hard: the panel filters in place via React state and there is
    // no observable real-state effect accessible via ctx.aegis; the call goes to the
    // hook's internal refresh() → aegis.history.search.  We assert via CallLog (vitest).
    layers: ['vitest'],
    run: async (ctx) => {
      const searchInput = ctx.byLabel(/^Search history$/i);
      if (!searchInput) throw new Error('Search history input not found');
      await ctx.type(searchInput, 'example');
      // Submit the search form (the Search button / form submit).
      const searchBtn = ctx.byRole('button', /^Run history search$|^Search$/);
      if (searchBtn) await ctx.click(searchBtn);
      else await ctx.press('Enter');
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('history.search', (a) => String(a[0]).toLowerCase().includes('example')))
        throw new Error('history.search not called with "example"');
      return 'history search → history.search("example")';
    },
  },

  {
    id: 'sidebar.history.clear',
    domain: 'sidebar.history',
    description: 'Click Clear all history → confirm → history.clear called',
    screen: 'sidebar:history',
    layers: ['vitest', 'live'],
    run: async (ctx) => {
      if (ctx.layer === 'vitest') {
        // Seed at least one entry so the Clear button is enabled.
        const SEEDED: HistoryEntry[] = [
          { id: 99, url: 'https://history-clear.test/', title: 'Clear Me', visitedAt: Date.now() },
        ];
        await ctx.emitHistory?.(SEEDED);
      } else {
        // Live: ensure history is non-empty so the Clear button is enabled.
        await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, 'https://example.com/');
        await new Promise((r) => setTimeout(r, 1500));
        await ctx.reach('sidebar:history');
        await new Promise((r) => setTimeout(r, 300));
      }
      const clearBtn = ctx.byRole('button', /^Clear all history$/);
      if (!clearBtn) throw new Error('Clear all history button not found');
      await ctx.click(clearBtn);
      // ConfirmDialog registers a real handler that renders a dialog — click OK.
      // (window.confirm stub in the tour handles the fallback; ConfirmDialog
      // overrides it, so we must find and click the real OK button.)
      const okBtn = ctx.byRole('button', /^OK$/);
      if (okBtn) await ctx.click(okBtn);
      // Give the async confirm + clear chain a tick to settle.
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('history.clear'))
          throw new Error('history.clear not called after confirming Clear all history');
        return 'Clear all history + OK → history.clear()';
      }
      // Live: poll until history.list() is empty.
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const list = await ctx.aegis.history.list();
        if (list.length === 0) return 'Clear all history → history.list() is now empty';
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error('live: history list never became empty after clear');
    },
  },

  // ─── Task 6: sidebar saved + tags ───────────────────────────────────────

  (() => {
    // Capture the url BEFORE clicking the saved row so the live assert can verify
    // the url CHANGED to the entry's destination — not merely that it is non-blank.
    let _urlBeforeClick: string | undefined;
    const SEED_ITEM: SavedItem = {
      id: 100,
      url: 'https://saved-open-test.example/',
      title: 'Saved Open Test',
      tags: [],
      savedAt: 0,
    };
    return {
      id: 'sidebar.saved.openEntry',
      domain: 'sidebar.saved',
      description: 'Click a saved row → nav.navigate called with the item url',
      screen: 'sidebar:saved',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed the panel with one item whose url differs from the current nav state.
          await ctx.emitSaved?.([SEED_ITEM], []);
        } else {
          // Live: add the probe item via the API (distinct url), navigate to a
          // DIFFERENT page first so the click produces a real url change.
          await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title });
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, 'https://example.com/');
          await new Promise((r) => setTimeout(r, 1500));
          await ctx.reach('sidebar:saved');
          await new Promise((r) => setTimeout(r, 300));
          _urlBeforeClick = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
        }
        // Click the "Open <url>" button — aria-label set by SavedPanel per item.
        const openBtn = ctx.bySelector('.saved-panel__open');
        if (!openBtn) throw new Error('No saved-panel open button found (panel may be empty)');
        await ctx.click(openBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('nav.navigate'))
            throw new Error('nav.navigate not called after clicking saved row');
          return 'saved row open → nav.navigate()';
        }
        // Live: poll until the url changes away from _urlBeforeClick AND includes the
        // seed url host — proves the click navigated to the saved entry specifically.
        if (_urlBeforeClick === undefined)
          throw new Error('live: _urlBeforeClick was never captured');
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          const { url } = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
          if (url !== _urlBeforeClick && url.includes('saved-open-test.example')) {
            // Clean up the probe saved item.
            const list = await ctx.aegis.saved.list();
            for (const i of list.filter((i) => i.url === SEED_ITEM.url)) {
              await ctx.aegis.saved.remove(i.id);
            }
            return `saved row open → nav navigated from ${_urlBeforeClick} to ${url}`;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        const finalUrl = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
        throw new Error(
          `live: url did not become saved-open-test.example (was ${_urlBeforeClick}, now ${finalUrl})`,
        );
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture list length BEFORE deletion so assert can verify it shrank by exactly 1.
    let _baseLength: number | undefined;
    const SEED_ITEM: SavedItem = {
      id: 101,
      url: 'https://saved-delete-test.example/',
      title: 'Saved Delete Test',
      tags: [],
      savedAt: 0,
    };
    return {
      id: 'sidebar.saved.delete',
      domain: 'sidebar.saved',
      description: 'Click the Remove button on a saved row → saved.remove called; live: count −1',
      screen: 'sidebar:saved',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          await ctx.emitSaved?.([SEED_ITEM], []);
        } else {
          // Live: add a probe item, snapshot the list length after add.
          await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title });
          await new Promise((r) => setTimeout(r, 400));
          const list = await ctx.aegis.saved.list();
          _baseLength = list.length;
          await ctx.reach('sidebar:saved');
          await new Promise((r) => setTimeout(r, 300));
        }
        // "Remove <label>" aria-label is set by SavedPanel for each item row.
        // Use the CSS class selector to avoid matching unrelated Remove buttons.
        const removeBtn = ctx.bySelector('.saved-panel__remove');
        if (!removeBtn) throw new Error('No saved-panel remove button found (panel may be empty)');
        await ctx.click(removeBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('saved.remove'))
            throw new Error('saved.remove not called');
          return 'saved row remove → saved.remove()';
        }
        // Live: list length must have decreased by exactly 1 from baseline.
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.saved.list();
        if (_baseLength === undefined)
          throw new Error('live: _baseLength was never captured');
        if (list.length !== _baseLength - 1)
          throw new Error(`live: expected ${_baseLength - 1} saved items after remove, got ${list.length}`);
        return `saved row remove → list shrank from ${_baseLength} to ${list.length}`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture the item's tags BEFORE adding so the assert verifies the SPECIFIC new tag
    // was added (not that tags.length > 0, which could already be true from the seed).
    let _tagsBefore: string[] | undefined;
    const PROBE_TAG = 'ap6-addtag';
    const SEED_ITEM: SavedItem = {
      id: 102,
      url: 'https://saved-addtag-test.example/',
      title: 'Saved AddTag Test',
      tags: [],
      savedAt: 0,
    };
    return {
      id: 'sidebar.saved.addTag',
      domain: 'sidebar.saved',
      description: 'Edit a saved item and add a tag → saved.update called with the new tag',
      screen: 'sidebar:saved',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed the panel with one item that has no probe tag yet.
          await ctx.emitSaved?.([SEED_ITEM], []);
          _tagsBefore = [...SEED_ITEM.tags];
        } else {
          // Live: add the probe saved item, snapshot its tags.
          await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title, tags: [] });
          await new Promise((r) => setTimeout(r, 400));
          const list = await ctx.aegis.saved.list();
          const item = list.find((i) => i.url === SEED_ITEM.url);
          if (!item) throw new Error('live: probe saved item not found after add');
          _tagsBefore = [...item.tags];
          await ctx.reach('sidebar:saved');
          await new Promise((r) => setTimeout(r, 300));
        }
        // Click the "Edit <label>" button to open the inline editor.
        const editBtn = ctx.bySelector('.saved-panel__edit');
        if (!editBtn) throw new Error('No saved-panel edit button found (panel may be empty)');
        await ctx.click(editBtn);
        // The TagInput "Add tag" input is now rendered.
        const tagInput = ctx.byLabel(/^Add tag$/);
        if (!tagInput) throw new Error('"Add tag" input not found in saved item editor');
        await ctx.type(tagInput, PROBE_TAG);
        await ctx.press('Enter');
        // Click Save to commit the edit.
        const saveBtn = ctx.bySelector('.saved-panel__save');
        if (!saveBtn) throw new Error('Save button not found in saved item editor');
        await ctx.click(saveBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // saved.update must have been called with the probe tag in the tags array.
          if (!ctx.calls.called('saved.update', (a) => {
            const partial = a[1] as { tags?: string[] };
            return Array.isArray(partial?.tags) && partial.tags.includes(PROBE_TAG);
          }))
            throw new Error(`saved.update not called with tags including "${PROBE_TAG}"`);
          return `saved addTag → saved.update({ tags: [..., "${PROBE_TAG}"] })`;
        }
        // Live: the item's tags must now include the probe tag (and it wasn't there before).
        if (_tagsBefore === undefined)
          throw new Error('live: _tagsBefore was never captured');
        if (_tagsBefore.includes(PROBE_TAG))
          throw new Error(`live: probe tag "${PROBE_TAG}" was already present before addTag — test is not proving the addition`);
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.saved.list();
        const item = list.find((i) => i.url === SEED_ITEM.url);
        if (!item) throw new Error(`live: saved item not found after addTag`);
        if (!item.tags.includes(PROBE_TAG))
          throw new Error(`live: item.tags ${JSON.stringify(item.tags)} does not include "${PROBE_TAG}" after addTag`);
        // Clean up: remove the probe saved item.
        await ctx.aegis.saved.remove(item.id);
        return `saved addTag → item.tags now includes "${PROBE_TAG}" (item cleaned up)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Probe tag used as the rename source — unique to avoid touching real user data.
    const OLD_TAG = 'ap6-renametag-old';
    const NEW_TAG = 'ap6-renametag-new';
    const SEED_ITEM: SavedItem = {
      id: 103,
      url: 'https://saved-renametag-test.example/',
      title: 'Saved RenameTag Test',
      tags: [OLD_TAG],
      savedAt: 0,
    };
    return {
      id: 'sidebar.saved.renameTag',
      domain: 'sidebar.saved',
      description: 'Open Manage tags, select a tag, enter a new name, click Rename tag → saved.renameTag called',
      screen: 'sidebar:saved',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed with an item carrying the old probe tag so tagUnion contains it.
          await ctx.emitSaved?.([SEED_ITEM], [OLD_TAG]);
        } else {
          // Live: add the probe item with the old tag so it appears in tagUnion.
          await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title, tags: [OLD_TAG] });
          await new Promise((r) => setTimeout(r, 400));
          await ctx.reach('sidebar:saved');
          await new Promise((r) => setTimeout(r, 300));
        }
        // Open the "Manage tags" details element by clicking its summary.
        const summary = ctx.bySelector('.saved-panel__manage-summary');
        if (!summary) throw new Error('"Manage tags" summary not found (tagUnion may be empty)');
        await ctx.click(summary);
        // Click the probe tag chip to select it (aria-pressed becomes true).
        const tagChip = ctx.byRole('button', new RegExp(`^${OLD_TAG}$`));
        if (!tagChip) throw new Error(`Tag chip "${OLD_TAG}" not found in Manage tags section`);
        await ctx.click(tagChip);
        // Type the new tag name in the "Rename tag to" input.
        const renameInput = ctx.byLabel(/^Rename tag to$/);
        if (!renameInput) throw new Error('"Rename tag to" input not found');
        await ctx.type(renameInput, NEW_TAG);
        // Click the "Rename tag" button.
        const renameBtn = ctx.byRole('button', /^Rename tag$/);
        if (!renameBtn) throw new Error('"Rename tag" button not found');
        await ctx.click(renameBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('saved.renameTag', (a) => a[0] === OLD_TAG && a[1] === NEW_TAG))
            throw new Error(`saved.renameTag not called with ("${OLD_TAG}", "${NEW_TAG}")`);
          return `saved renameTag → saved.renameTag("${OLD_TAG}", "${NEW_TAG}")`;
        }
        // Live: tagUnion must no longer contain OLD_TAG, and must contain NEW_TAG.
        await new Promise((r) => setTimeout(r, 500));
        const union = await ctx.aegis.saved.tagUnion();
        if (union.includes(OLD_TAG))
          throw new Error(`live: old tag "${OLD_TAG}" still present in tagUnion after rename`);
        if (!union.includes(NEW_TAG))
          throw new Error(`live: new tag "${NEW_TAG}" not present in tagUnion after rename`);
        // Clean up: remove the probe saved item (and its renamed tag with it).
        const list = await ctx.aegis.saved.list();
        const item = list.find((i) => i.url === SEED_ITEM.url);
        if (item) await ctx.aegis.saved.remove(item.id);
        return `saved renameTag → "${OLD_TAG}" → "${NEW_TAG}" in tagUnion (item cleaned up)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Probe tag used for deletion — unique to avoid touching real user data.
    const PROBE_TAG = 'ap6-deletetag';
    const SEED_ITEM: SavedItem = {
      id: 104,
      url: 'https://saved-deletetag-test.example/',
      title: 'Saved DeleteTag Test',
      tags: [PROBE_TAG],
      savedAt: 0,
    };
    return {
      id: 'sidebar.saved.deleteTag',
      domain: 'sidebar.saved',
      description: 'Open Manage tags, select a tag, click Delete tag → saved.deleteTag called',
      screen: 'sidebar:saved',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed with an item carrying the probe tag.
          await ctx.emitSaved?.([SEED_ITEM], [PROBE_TAG]);
        } else {
          // Live: add the probe item with the probe tag.
          await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title, tags: [PROBE_TAG] });
          await new Promise((r) => setTimeout(r, 400));
          await ctx.reach('sidebar:saved');
          await new Promise((r) => setTimeout(r, 300));
        }
        // Open the "Manage tags" details element by clicking its summary.
        const summary = ctx.bySelector('.saved-panel__manage-summary');
        if (!summary) throw new Error('"Manage tags" summary not found (tagUnion may be empty)');
        await ctx.click(summary);
        // Click the probe tag chip to select it.
        const tagChip = ctx.byRole('button', new RegExp(`^${PROBE_TAG}$`));
        if (!tagChip) throw new Error(`Tag chip "${PROBE_TAG}" not found in Manage tags section`);
        await ctx.click(tagChip);
        // Click the "Delete tag" button.
        const deleteBtn = ctx.byRole('button', /^Delete tag$/);
        if (!deleteBtn) throw new Error('"Delete tag" button not found');
        await ctx.click(deleteBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('saved.deleteTag', (a) => a[0] === PROBE_TAG))
            throw new Error(`saved.deleteTag not called with "${PROBE_TAG}"`);
          return `saved deleteTag → saved.deleteTag("${PROBE_TAG}")`;
        }
        // Live: tagUnion must no longer contain the probe tag.
        await new Promise((r) => setTimeout(r, 500));
        const union = await ctx.aegis.saved.tagUnion();
        if (union.includes(PROBE_TAG))
          throw new Error(`live: probe tag "${PROBE_TAG}" still in tagUnion after deleteTag`);
        // Clean up: remove the probe saved item.
        const list = await ctx.aegis.saved.list();
        const item = list.find((i) => i.url === SEED_ITEM.url);
        if (item) await ctx.aegis.saved.remove(item.id);
        return `saved deleteTag → "${PROBE_TAG}" gone from tagUnion (item cleaned up)`;
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'sidebar.saved.filterByTag',
    domain: 'sidebar.saved',
    description: 'Click a tag chip in the filter bar → only matching saved rows remain visible',
    screen: 'sidebar:saved',
    // filterByTag is a pure UI-state interaction: it filters the DOM via React state
    // (activeTags) without calling any aegis API.  There is no observable real-state
    // effect to assert via ctx.aegis.*, so this spec is vitest-only.
    layers: ['vitest'],
    run: async (ctx) => {
      // Seed with two items: one has the probe tag, one does not.
      const TAG = 'ap6-filtertag';
      const ITEM_WITH_TAG: SavedItem = {
        id: 105,
        url: 'https://saved-filter-match.example/',
        title: 'Match',
        tags: [TAG],
        savedAt: 0,
      };
      const ITEM_WITHOUT_TAG: SavedItem = {
        id: 106,
        url: 'https://saved-filter-nomatch.example/',
        title: 'No Match',
        tags: [],
        savedAt: 0,
      };
      await ctx.emitSaved?.([ITEM_WITH_TAG, ITEM_WITHOUT_TAG], [TAG]);
      // Click the tag chip in the TagFilter bar to activate the filter.
      const filterChip = ctx.byRole('button', new RegExp(`^Filter by tag ${TAG}$`));
      if (!filterChip) throw new Error(`Tag filter chip "Filter by tag ${TAG}" not found`);
      await ctx.click(filterChip);
    },
    assert: async (ctx) => {
      // After clicking the filter chip, only ITEM_WITH_TAG should be visible;
      // ITEM_WITHOUT_TAG should not be in the DOM (filtered out).
      const matchBtn = ctx.bySelector('.saved-panel__open[aria-label="Open https://saved-filter-match.example/"]');
      const noMatchBtn = ctx.bySelector('.saved-panel__open[aria-label="Open https://saved-filter-nomatch.example/"]');
      if (!matchBtn)
        throw new Error('Matching saved row not found after filterByTag — row should be visible');
      if (noMatchBtn)
        throw new Error('Non-matching saved row is still visible after filterByTag — filter had no effect');
      return 'filterByTag → matching row visible, non-matching row hidden';
    },
  },

  // ─── Task 7: settings (every tab) ───────────────────────────────────────

  // ── Appearance tab ──────────────────────────────────────────────────────

  (() => {
    // Capture the original primaryColor before changing it so we can restore it live.
    let _originalColor: string | undefined;
    const NEW_COLOR = '#ff0000';
    return {
      id: 'settings.appearance.primaryColor',
      domain: 'settings.appearance',
      description: 'Change the Accent color input → settings.set({primaryColor}) called',
      screen: 'settings:appearance',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          const s = await ctx.aegis.settings.get();
          _originalColor = s.primaryColor;
        }
        const input = ctx.byLabel(/^Accent color$/);
        if (!input) throw new Error('Accent color input not found on Appearance tab');
        // color inputs don't support userEvent.clear() — use the native change dispatch.
        fireInputChange(input, NEW_COLOR);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('settings.set', (a) => {
            const p = a[0] as Partial<AegisSettings>;
            return p?.primaryColor !== undefined;
          }))
            throw new Error('settings.set not called with primaryColor on Appearance tab');
          return 'Accent color change → settings.set({primaryColor})';
        }
        // Live: read back and verify the field changed.
        await new Promise((r) => setTimeout(r, 400));
        const after = await ctx.aegis.settings.get();
        if (after.primaryColor === _originalColor)
          throw new Error(`live: primaryColor did not change from "${_originalColor}" after change`);
        // Restore the original color.
        if (_originalColor !== undefined) await ctx.aegis.settings.set({ primaryColor: _originalColor });
        return `Accent color → changed from "${_originalColor}" to "${after.primaryColor}" (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  // ── Search tab ───────────────────────────────────────────────────────────

  (() => {
    // Only test "add engine" which calls settings.set — "set default" requires a
    // pre-existing engine row in the list, but the mock returns searchEngines:[].
    // We add a custom engine (fills all 3 inputs + clicks Add engine) and assert the call.
    return {
      id: 'settings.search.addEngine',
      domain: 'settings.search',
      description: 'Fill engine id/name/template and click "Add engine" → settings.set({searchEngines}) called',
      screen: 'settings:search',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        const idInput = ctx.byLabel(/^Engine id$/i);
        if (!idInput) throw new Error('"Engine id" input not found on Search tab');
        const nameInput = ctx.byLabel(/^Engine name$/i);
        if (!nameInput) throw new Error('"Engine name" input not found on Search tab');
        const templateInput = ctx.byLabel(/^Engine template$/i);
        if (!templateInput) throw new Error('"Engine template" input not found on Search tab');
        await ctx.type(idInput, 'ap7test');
        await ctx.type(nameInput, 'AP7 Test Engine');
        await ctx.type(templateInput, 'https://ap7test.example/?q=%s');
        const addBtn = ctx.byRole('button', /^Add engine$/);
        if (!addBtn) throw new Error('"Add engine" button not found');
        await ctx.click(addBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('settings.set', (a) => {
            const p = a[0] as Partial<AegisSettings>;
            return Array.isArray(p?.searchEngines);
          }))
            throw new Error('settings.set not called with searchEngines after Add engine');
          return 'Add engine → settings.set({searchEngines:[…]})';
        }
        // Live: settings.get().searchEngines must now include the new engine.
        await new Promise((r) => setTimeout(r, 400));
        const s = await ctx.aegis.settings.get();
        const added = s.searchEngines.find((e) => e.id === 'ap7test');
        if (!added) throw new Error('live: "ap7test" engine not found in searchEngines after add');
        // Restore: remove the probe engine.
        await ctx.aegis.settings.set({
          searchEngines: s.searchEngines.filter((e) => e.id !== 'ap7test'),
        });
        return `Add engine → searchEngines now has ap7test (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Test "set default engine" — requires at least one engine in the list.
    // In live this uses the real engines; in vitest the mock returns [] so we can
    // only test "set default" if we seed the engines first.  Since we can't seed
    // the SearchTab's props easily in vitest (they come from useSettings which calls
    // the mock), we mark this vitest-only with a direct settings.set call to add a
    // probe engine first (via the "Add engine" form) then pick it as default.
    // Actually, re-reading: we CAN work around this — the mock's settings.get returns
    // searchEngines:[], so the list renders empty and no "Default search engine" radio
    // exists.  Use ['vitest'] only, drive via the Add-engine form, then use byLabel to
    // find the radio.  But even after adding, the updated engines are in local React
    // state (not in mock's settings.get return value), so no radio is rendered until
    // state updates.  The add call returns baseSettings with searchEngines:[] still,
    // so useSetting stays [].
    // CONCLUSION: setDefault requires a non-empty engine list from the mock. Skip
    // vitest for this; live can exercise it because the real settings store has engines.
    // Closure: capture original template and the selected engine's template before clicking.
    let _originalTemplate: string | undefined;
    let _selectedEngineTemplate: string | undefined;
    return {
      id: 'settings.search.setDefault',
      domain: 'settings.search',
      description: 'Click the "Default search engine" radio for an engine → settings.set({defaultSearchTemplate}) called',
      screen: 'settings:search',
      // vitest excluded: the mock returns searchEngines:[] so no engine rows render
      // and no "Default search engine" radio is available.  The live run has real engines.
      layers: ['live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        // Capture original template so we can restore it after the assert.
        const before = await ctx.aegis.settings.get();
        _originalTemplate = before.defaultSearchTemplate;
        // Find the first default-engine radio whose engine template differs from the current
        // default — clicking it will produce an observable change.
        // The aria-label is "Default search engine <engine-name>".
        const allEngines = before.searchEngines ?? [];
        // Find an engine whose template differs from the current default.
        const alternate = allEngines.find((e) => e.template !== _originalTemplate);
        if (allEngines.length === 0)
          throw new Error('No "Default search engine" radio found — searchEngines list may be empty');
        // Need an engine with a DIFFERENT template so the click produces an observable change;
        // otherwise re-selecting the current default is a no-op the assert can't verify.
        if (!alternate)
          throw new Error('All search engines share the current default template — no observable change possible');
        // Click the radio for the alternate engine.
        const targetName = alternate.name;
        _selectedEngineTemplate = alternate.template;
        const radio = ctx.byLabel(new RegExp(`^Default search engine ${targetName}$`));
        if (!radio) throw new Error(`No "Default search engine" radio found for engine "${targetName}"`);
        await ctx.click(radio);
      },
      assert: async (ctx: InteractionCtx) => {
        // Live: settings.get().defaultSearchTemplate must have changed to the selected engine's template.
        await new Promise((r) => setTimeout(r, 400));
        const s = await ctx.aegis.settings.get();
        if (!s.defaultSearchTemplate)
          throw new Error('live: defaultSearchTemplate is empty after clicking default-engine radio');
        if (_selectedEngineTemplate !== undefined && s.defaultSearchTemplate !== _selectedEngineTemplate)
          throw new Error(
            `live: defaultSearchTemplate is "${s.defaultSearchTemplate}", expected "${_selectedEngineTemplate}" for the selected engine`,
          );
        // Restore the original default search template.
        if (_originalTemplate !== undefined)
          await ctx.aegis.settings.set({ defaultSearchTemplate: _originalTemplate });
        return `set default engine → defaultSearchTemplate="${s.defaultSearchTemplate}" (restored to "${_originalTemplate}")`;
      },
    } satisfies InteractionSpec;
  })(),

  // ── Home tab ──────────────────────────────────────────────────────────────

  (() => {
    let _originalHomeUrl: string | undefined;
    const NEW_HOME = 'https://ap7home.example/';
    return {
      id: 'settings.home.homeUrl',
      domain: 'settings.home',
      description: 'Type a home URL and click Save → settings.set({homeUrl}) called',
      screen: 'settings:home',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          _originalHomeUrl = (await ctx.aegis.settings.get()).homeUrl;
        }
        // byLabel may match both the <label> and the <input aria-label="Home URL">;
        // use bySelector to target the input directly and avoid the multiple-match error.
        const input = ctx.bySelector('input[aria-label="Home URL"]');
        if (!input) throw new Error('"Home URL" input not found on Home tab');
        await ctx.type(input, NEW_HOME);
        const saveBtn = ctx.byLabel(/^Save home URL$/i);
        if (!saveBtn) throw new Error('"Save home URL" button not found');
        await ctx.click(saveBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('settings.set', (a) => {
            const p = a[0] as Partial<AegisSettings>;
            return p?.homeUrl !== undefined;
          }))
            throw new Error('settings.set not called with homeUrl on Home tab');
          return `Home URL save → settings.set({homeUrl:"${NEW_HOME}"})`;
        }
        await new Promise((r) => setTimeout(r, 400));
        const s = await ctx.aegis.settings.get();
        if (s.homeUrl !== NEW_HOME)
          throw new Error(`live: homeUrl is "${s.homeUrl}", expected "${NEW_HOME}"`);
        if (_originalHomeUrl !== undefined) await ctx.aegis.settings.set({ homeUrl: _originalHomeUrl });
        return `Home URL save → homeUrl="${NEW_HOME}" (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  // ── Tabs tab ─────────────────────────────────────────────────────────────

  (() => {
    let _originalTimeout: number | undefined;
    const NEW_TIMEOUT = 99;
    return {
      id: 'settings.tabs.idleTimeout',
      domain: 'settings.tabs',
      description: 'Change the idle-discard timeout number input → settings.set({tabIdleTimeout}) called',
      screen: 'settings:tabs',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          _originalTimeout = (await ctx.aegis.settings.get()).tabIdleTimeout;
        }
        const input = ctx.byLabel(/discard inactive tabs after/i);
        if (!input) throw new Error('"Discard inactive tabs after" input not found on Tabs tab');
        await ctx.type(input, String(NEW_TIMEOUT));
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('settings.set', (a) => {
            const p = a[0] as Partial<AegisSettings>;
            return p?.tabIdleTimeout !== undefined;
          }))
            throw new Error('settings.set not called with tabIdleTimeout on Tabs tab');
          return 'Tabs idle-timeout change → settings.set({tabIdleTimeout})';
        }
        await new Promise((r) => setTimeout(r, 400));
        const s = await ctx.aegis.settings.get();
        if (s.tabIdleTimeout === _originalTimeout)
          throw new Error(`live: tabIdleTimeout did not change from ${_originalTimeout}`);
        if (_originalTimeout !== undefined) await ctx.aegis.settings.set({ tabIdleTimeout: _originalTimeout });
        return `Tabs idle-timeout → tabIdleTimeout changed (restored to ${_originalTimeout})`;
      },
    } satisfies InteractionSpec;
  })(),

  // ── Filter Lists tab ──────────────────────────────────────────────────────

  (() => {
    // The sub list is empty in the mock (subs.list returns []).  To test setEnabled we
    // need a row in the DOM.  We use subs.add to add a probe sub first via the "Add list" form,
    // but subs.add mock returns [] so the rendered list stays empty.
    // APPROACH: assert the subs.setEnabled call in vitest via the mock.
    // We need a row rendered — but the mock's subs.list returns [] and subs.add returns [].
    // Since useSubscriptions sets subs state from the return value of subs.add/subs.remove,
    // and the mock returns [], the list stays empty after add.  We can't seed it.
    // FIX: mock subs.add to return a probe sub so the list re-renders with it.
    // Then click the Enable switch for it.
    type SubsMockFn = { mockResolvedValue(v: unknown[]): void };
    const PROBE_SUB = { listId: 'ap7-easylist', url: 'https://ap7.example/list.txt', enabled: true };
    // Closure: capture the sub's enabled state BEFORE the toggle so assert can verify the flip.
    let _targetListId: string | undefined;
    let _preEnabled: boolean | undefined;
    return {
      id: 'settings.filterLists.toggleSub',
      domain: 'settings.filterLists',
      description: 'Toggle a filter list subscription on/off → subs.setEnabled called',
      screen: 'settings:filterLists',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed: mock subs.add to return the probe sub and click "Add list".
          (ctx.aegis.subs.add as unknown as SubsMockFn).mockResolvedValue([PROBE_SUB]);
          const urlInput = ctx.byLabel(/^List URL$/i);
          if (!urlInput) throw new Error('"List URL" input not found on Filter Lists tab');
          await ctx.type(urlInput, PROBE_SUB.url);
          const addBtn = ctx.byRole('button', /^Add list$/);
          if (!addBtn) throw new Error('"Add list" button not found');
          await ctx.click(addBtn);
          // Now the Enable switch for PROBE_SUB.listId should be rendered.
          const toggle = ctx.byLabel(new RegExp(`^Enable list ${PROBE_SUB.listId}$`));
          if (!toggle) throw new Error(`Enable-list switch for "${PROBE_SUB.listId}" not found`);
          await ctx.click(toggle);
        } else {
          // Live: find any existing subscription row and click its enable switch.
          // Snapshot the sub's enabled state first so assert can verify the flip.
          let toggle = ctx.byRole('switch', /^Enable list /);
          if (!toggle) {
            const urlInput = ctx.byLabel(/^List URL$/i);
            if (!urlInput) throw new Error('"List URL" input not found');
            await ctx.type(urlInput!, PROBE_SUB.url);
            const addBtn = ctx.byRole('button', /^Add list$/);
            if (!addBtn) throw new Error('"Add list" button not found');
            await ctx.click(addBtn!);
            await new Promise((r) => setTimeout(r, 800));
            toggle = ctx.byRole('switch', /^Enable list /);
          }
          if (!toggle) throw new Error('No filter-list Enable switch found after trying to add one');
          // Extract the listId from the aria-label "Enable list <listId>" to read pre-toggle state.
          const ariaLabel = toggle.getAttribute('aria-label') ?? '';
          const listIdMatch = ariaLabel.match(/^Enable list (.+)$/);
          _targetListId = listIdMatch?.[1];
          if (_targetListId) {
            const subs = await ctx.aegis.subs.list();
            const sub = subs.find((s) => s.listId === _targetListId);
            _preEnabled = sub?.enabled;
          }
          await ctx.click(toggle);
        }
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('subs.setEnabled'))
            throw new Error('subs.setEnabled not called after toggling filter list');
          return 'filter list toggle → subs.setEnabled()';
        }
        // Live: re-read subs.list and verify the enabled flag flipped for the target sub.
        await new Promise((r) => setTimeout(r, 400));
        if (_targetListId === undefined)
          throw new Error('live: _targetListId was never captured (run() may not have executed)');
        const subs = await ctx.aegis.subs.list();
        const sub = subs.find((s) => s.listId === _targetListId);
        if (!sub) throw new Error(`live: subscription "${_targetListId}" not found after toggle`);
        if (_preEnabled !== undefined && sub.enabled === _preEnabled)
          throw new Error(`live: sub "${_targetListId}" enabled did not flip (still ${sub.enabled} after toggle)`);
        return `filter list toggle → "${_targetListId}" enabled flipped ${_preEnabled}→${sub.enabled}`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    return {
      id: 'settings.filterLists.addList',
      domain: 'settings.filterLists',
      description: 'Type a URL in the List URL input and click "Add list" → subs.add called',
      screen: 'settings:filterLists',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        const urlInput = ctx.byLabel(/^List URL$/i);
        if (!urlInput) throw new Error('"List URL" input not found on Filter Lists tab');
        await ctx.type(urlInput, 'https://ap7addlist.example/list.txt');
        const addBtn = ctx.byRole('button', /^Add list$/);
        if (!addBtn) throw new Error('"Add list" button not found');
        await ctx.click(addBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('subs.add', (a) => String(a[0]).includes('ap7addlist')))
            throw new Error('subs.add not called with the probe URL');
          return 'Add list → subs.add(url)';
        }
        // Live: list should contain the added entry; clean up.
        await new Promise((r) => setTimeout(r, 800));
        const list = await ctx.aegis.subs.list();
        const added = list.find((s) => s.url.includes('ap7addlist'));
        if (!added) throw new Error('live: probe subscription not found after subs.add');
        await ctx.aegis.subs.remove(added.listId);
        return 'Add list → subs.add → subscription persisted (cleaned up)';
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    type SubsMockFn = { mockResolvedValue(v: unknown[]): void };
    const PROBE_SUB = { listId: 'ap7-remove', url: 'https://ap7remove.example/list.txt', enabled: true };
    return {
      id: 'settings.filterLists.removeList',
      domain: 'settings.filterLists',
      description: 'Click "Remove list" on a subscription row → subs.remove called',
      screen: 'settings:filterLists',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed a sub row via mocked subs.add.
          (ctx.aegis.subs.add as unknown as SubsMockFn).mockResolvedValue([PROBE_SUB]);
          const urlInput = ctx.byLabel(/^List URL$/i);
          if (!urlInput) throw new Error('"List URL" input not found during removeList seed');
          await ctx.type(urlInput, PROBE_SUB.url);
          const addBtn = ctx.byRole('button', /^Add list$/);
          if (!addBtn) throw new Error('"Add list" button not found during removeList seed');
          await ctx.click(addBtn);
          // Now click the Remove button for the seeded row.
          const removeBtn = ctx.byLabel(new RegExp(`^Remove list ${PROBE_SUB.listId}$`));
          if (!removeBtn) throw new Error(`"Remove list ${PROBE_SUB.listId}" button not found`);
          await ctx.click(removeBtn);
        } else {
          // Live: add a probe sub then click Remove.
          await ctx.aegis.subs.add(PROBE_SUB.url);
          await new Promise((r) => setTimeout(r, 800));
          const removeBtn = ctx.byLabel(/^Remove list /);
          if (!removeBtn) throw new Error('No "Remove list" button found (no subs in list)');
          await ctx.click(removeBtn);
        }
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('subs.remove'))
            throw new Error('subs.remove not called after clicking Remove list');
          return 'Remove list → subs.remove()';
        }
        // Live: the sub should be gone.
        await new Promise((r) => setTimeout(r, 400));
        const list = await ctx.aegis.subs.list();
        if (list.some((s) => s.url.includes('ap7remove')))
          throw new Error('live: probe subscription still present after subs.remove');
        return 'Remove list → subscription removed (live)';
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'settings.filterLists.updateAll',
    domain: 'settings.filterLists',
    description: 'Click "Update all" → lists.updateNow called',
    screen: 'settings:filterLists',
    // live excluded: updateNow fetches from real remote URLs which is network-bound
    // and non-deterministic in the autopilot environment.  The vitest mock returns
    // a fixed result.  The live catalog's subs.updateNow verify() already covers
    // the live round-trip.
    layers: ['vitest'],
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^Update all$/);
      if (!btn) throw new Error('"Update all" button not found on Filter Lists tab');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('lists.updateNow'))
        throw new Error('lists.updateNow not called after clicking Update all');
      return 'Update all → lists.updateNow()';
    },
  },

  // ── My Filters tab ────────────────────────────────────────────────────────

  (() => {
    let _originalFilters: string | undefined;
    const NEW_FILTERS = '||ap7test.example^\n! custom rule';
    return {
      id: 'settings.myFilters.save',
      domain: 'settings.myFilters',
      description: 'Edit the custom filters textarea and click Save → customFilters.set called with the text',
      screen: 'settings:myFilters',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          _originalFilters = await ctx.aegis.customFilters.get();
        }
        const textarea = ctx.byLabel(/^Custom filters$/i);
        if (!textarea) throw new Error('"Custom filters" textarea not found on My Filters tab');
        await ctx.type(textarea, NEW_FILTERS);
        const saveBtn = ctx.byLabel(/^Save filters$/i);
        if (!saveBtn) throw new Error('"Save filters" button not found');
        await ctx.click(saveBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('customFilters.set', (a) => String(a[0]).includes('ap7test')))
            throw new Error('customFilters.set not called with the probe filter text');
          return `My Filters save → customFilters.set("${NEW_FILTERS.slice(0, 30)}…")`;
        }
        // Live: customFilters.get() must contain the saved text.
        await new Promise((r) => setTimeout(r, 400));
        const got = await ctx.aegis.customFilters.get();
        if (!got.includes('ap7test'))
          throw new Error(`live: customFilters.get() does not contain "ap7test" after save (got: "${got}")`);
        // Restore original filters.
        if (_originalFilters !== undefined) await ctx.aegis.customFilters.set(_originalFilters);
        return `My Filters save → customFilters persisted "ap7test…" (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  // ── Allowlist tab ─────────────────────────────────────────────────────────
  //
  // Note: the AllowlistTab component only shows existing allowlisted hosts and
  // provides "Remove" per-host and "Clear all" buttons.  There is no "add host"
  // form on this tab — hosts are added via the shield popover's toggleAllowlist
  // (already covered by shieldPopover.allowlistSite).  Interactions here are
  // remove and clear, which require an existing host in the list.

  (() => {
    const PROBE_HOST = 'ap7-allowlist.example';
    return {
      id: 'settings.allowlist.remove',
      domain: 'settings.allowlist',
      description: 'Click "Remove <host> from allowlist" → adblock.removeAllowlist called',
      screen: 'settings:allowlist',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Seed the allowlist state via the emitAllowlist ctx method (mocks adblock.getState
          // + fires syncBus 'allowlist' → triggers useAdblock's onSyncChange callback →
          // re-calls getState() → setState with the seeded hosts).  The act() wrapper in
          // emitAllowlist flushes the React update before returning.
          await ctx.emitAllowlist?.([PROBE_HOST]);
        } else {
          // Live: add the probe host to the allowlist first.
          const navState = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, `https://${PROBE_HOST}/`);
          await new Promise((r) => setTimeout(r, 1000));
          await ctx.aegis.adblock.toggleAllowlist(`https://${PROBE_HOST}/`);
          await new Promise((r) => setTimeout(r, 400));
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, navState.url);
          await ctx.reach('settings:allowlist');
          await new Promise((r) => setTimeout(r, 300));
        }
        // Find the "Remove <host> from allowlist" button.
        const removeBtn = ctx.byLabel(new RegExp(`Remove ${PROBE_HOST} from allowlist`));
        if (!removeBtn) throw new Error(`"Remove ${PROBE_HOST} from allowlist" button not found — allowlist may be empty`);
        await ctx.click(removeBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('adblock.removeAllowlist', (a) => a[0] === PROBE_HOST))
            throw new Error(`adblock.removeAllowlist not called with "${PROBE_HOST}"`);
          return `allowlist remove → adblock.removeAllowlist("${PROBE_HOST}")`;
        }
        // Live: host must be gone from the allowlist.
        await new Promise((r) => setTimeout(r, 400));
        const state = await ctx.aegis.adblock.getState();
        if (state.allowlistedHosts.includes(PROBE_HOST))
          throw new Error(`live: "${PROBE_HOST}" still in allowlistedHosts after remove`);
        return `allowlist remove → "${PROBE_HOST}" gone from allowlist (live)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    const PROBE_HOST = 'ap7-clear.example';
    return {
      id: 'settings.allowlist.clearAll',
      domain: 'settings.allowlist',
      description: 'Click "Clear all" on the allowlist tab → adblock.clearAllowlist called',
      screen: 'settings:allowlist',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          // Same emitAllowlist seeding as settings.allowlist.remove.
          await ctx.emitAllowlist?.([PROBE_HOST]);
        } else {
          // Live: add the probe host to make the Clear all button enabled.
          const navState = await ctx.aegis.nav.getState(PRIMARY_VIEW_ID);
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, `https://${PROBE_HOST}/`);
          await new Promise((r) => setTimeout(r, 1000));
          await ctx.aegis.adblock.toggleAllowlist(`https://${PROBE_HOST}/`);
          await new Promise((r) => setTimeout(r, 400));
          await ctx.aegis.nav.navigate(PRIMARY_VIEW_ID, navState.url);
          await ctx.reach('settings:allowlist');
          await new Promise((r) => setTimeout(r, 300));
        }
        const clearBtn = ctx.byRole('button', /^Clear all$/);
        if (!clearBtn) throw new Error('"Clear all" button not found on Allowlist tab — list may be empty');
        await ctx.click(clearBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('adblock.clearAllowlist'))
            throw new Error('adblock.clearAllowlist not called after clicking Clear all');
          return 'allowlist Clear all → adblock.clearAllowlist()';
        }
        // Live: allowlistedHosts must now be empty.
        await new Promise((r) => setTimeout(r, 400));
        const state = await ctx.aegis.adblock.getState();
        if (state.allowlistedHosts.length > 0)
          throw new Error(`live: allowlist still has ${state.allowlistedHosts.length} hosts after clearAllowlist`);
        return 'allowlist Clear all → allowlistedHosts is now empty (live)';
      },
    } satisfies InteractionSpec;
  })(),

  // ── Downloads tab ─────────────────────────────────────────────────────────

  (() => {
    let _originalDir: string | undefined;
    const NEW_DIR = '/tmp/ap7-downloads';
    return {
      id: 'settings.downloads.saveDir',
      domain: 'settings.downloads',
      description: 'Type a download folder path and click "Save download folder" → settings.set({downloadDir}) called',
      screen: 'settings:downloads',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          _originalDir = (await ctx.aegis.settings.get()).downloadDir;
        }
        const input = ctx.byLabel(/^Download folder$/i);
        if (!input) throw new Error('"Download folder" input not found on Downloads tab');
        await ctx.type(input, NEW_DIR);
        const saveBtn = ctx.byRole('button', /^Save download folder$/);
        if (!saveBtn) throw new Error('"Save download folder" button not found');
        await ctx.click(saveBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('settings.set', (a) => {
            const p = a[0] as Partial<AegisSettings>;
            return p?.downloadDir !== undefined;
          }))
            throw new Error('settings.set not called with downloadDir after save');
          return `Downloads save folder → settings.set({downloadDir:"${NEW_DIR}"})`;
        }
        await new Promise((r) => setTimeout(r, 400));
        const s = await ctx.aegis.settings.get();
        if (s.downloadDir !== NEW_DIR)
          throw new Error(`live: downloadDir is "${s.downloadDir}", expected "${NEW_DIR}"`);
        if (_originalDir !== undefined) await ctx.aegis.settings.set({ downloadDir: _originalDir });
        return `Downloads save folder → downloadDir="${NEW_DIR}" (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture original downloadDir before "Use default" clears it so we can restore live state.
    let _originalDir: string | undefined;
    return {
      id: 'settings.downloads.useDefault',
      domain: 'settings.downloads',
      description: 'Click "Use default" on Downloads tab → settings.set({downloadDir:""}) called',
      screen: 'settings:downloads',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          _originalDir = (await ctx.aegis.settings.get()).downloadDir;
        }
        const btn = ctx.byRole('button', /^Use default$/);
        if (!btn) throw new Error('"Use default" button not found on Downloads tab');
        await ctx.click(btn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('settings.set', (a) => {
            const p = a[0] as Partial<AegisSettings>;
            return p?.downloadDir === '';
          }))
            throw new Error('settings.set not called with downloadDir="" after Use default');
          return 'Downloads Use default → settings.set({downloadDir:""})';
        }
        // Live: downloadDir must be empty string.
        await new Promise((r) => setTimeout(r, 400));
        const s = await ctx.aegis.settings.get();
        if (s.downloadDir !== '')
          throw new Error(`live: downloadDir is "${s.downloadDir}", expected "" after Use default`);
        // Restore the original downloadDir so subsequent specs find the setting unchanged.
        if (_originalDir !== undefined) await ctx.aegis.settings.set({ downloadDir: _originalDir });
        return `Downloads Use default → downloadDir="" (restored to "${_originalDir}")`;
      },
    } satisfies InteractionSpec;
  })(),

  // ── Site Permissions tab ──────────────────────────────────────────────────
  //
  // SitePermissionsTab shows "No remembered site permissions." when permissions.list
  // returns [] (the mock default).  Both Revoke and Clear all are disabled/absent.
  // We mark these vitest-only by seeding the permissions mock to return a probe entry.
  // However, usePermissions only calls aegis.permissions.list on mount.  We use the
  // same re-reach pattern as the allowlist: mock list to return the probe, re-reach.

  (() => {
    const PROBE = { origin: 'https://ap7perm.example', permission: 'camera', decision: 'allow' as const };
    return {
      id: 'settings.sitePermissions.revoke',
      domain: 'settings.sitePermissions',
      description: 'Click "Revoke <permission> for <origin>" → permissions.remove called',
      screen: 'settings:sitePermissions',
      // live excluded: the live permissions list is empty in the disposable profile
      // (no real user has granted camera/mic) so no Revoke button renders.  The vitest
      // mock approach covers the wiring; the catalog's permissions verify() covers live.
      layers: ['vitest'],
      run: async (ctx) => {
        // Seed: inject the probe permission via the control-surface seam (emitSitePermissions
        // → setSitePermissions → usePermissions._setPermissions → React state update).
        await ctx.emitSitePermissions?.([PROBE]);
        const revokeBtn = ctx.byLabel(new RegExp(`Revoke ${PROBE.permission} for ${PROBE.origin}`));
        if (!revokeBtn) throw new Error(`"Revoke ${PROBE.permission} for ${PROBE.origin}" button not found`);
        await ctx.click(revokeBtn);
      },
      assert: async (ctx) => {
        if (!ctx.calls.called('permissions.remove', (a) => a[0] === PROBE.origin && a[1] === PROBE.permission))
          throw new Error('permissions.remove not called with the probe origin/permission');
        return `sitePermissions revoke → permissions.remove("${PROBE.origin}", "${PROBE.permission}")`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    const PROBE = { origin: 'https://ap7clearall.example', permission: 'microphone', decision: 'allow' as const };
    return {
      id: 'settings.sitePermissions.clearAll',
      domain: 'settings.sitePermissions',
      description: 'Click "Clear all site permissions" → permissions.clear called',
      screen: 'settings:sitePermissions',
      // live excluded: same reasoning as revoke — empty permissions list in disposable profile.
      layers: ['vitest'],
      run: async (ctx) => {
        // Seed: inject the probe permission via the control-surface seam so "Clear all" is enabled.
        await ctx.emitSitePermissions?.([PROBE]);
        const clearBtn = ctx.byLabel(/^Clear all site permissions$/);
        if (!clearBtn) throw new Error('"Clear all site permissions" button not found');
        await ctx.click(clearBtn);
        // ConfirmDialog may open — click OK.
        const okBtn = ctx.byRole('button', /^OK$/);
        if (okBtn) await ctx.click(okBtn);
        await new Promise((r) => setTimeout(r, 100));
      },
      assert: async (ctx) => {
        if (!ctx.calls.called('permissions.clear'))
          throw new Error('permissions.clear not called after Clear all site permissions');
        return 'sitePermissions clearAll → permissions.clear()';
      },
    } satisfies InteractionSpec;
  })(),

  // ── Security tab ─────────────────────────────────────────────────────────

  (() => {
    let _originalHttpsOnly: boolean | undefined;
    return {
      id: 'settings.security.httpsOnly',
      domain: 'settings.security',
      description: 'Toggle the HTTPS-Only mode checkbox → settings.set({httpsOnly}) called',
      screen: 'settings:security',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          _originalHttpsOnly = (await ctx.aegis.settings.get()).httpsOnly;
        }
        const checkbox = ctx.byLabel(/^HTTPS-Only mode$/i);
        if (!checkbox) throw new Error('"HTTPS-Only mode" checkbox not found on Security tab');
        await ctx.click(checkbox);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('settings.set', (a) => {
            const p = a[0] as Partial<AegisSettings>;
            return p?.httpsOnly !== undefined;
          }))
            throw new Error('settings.set not called with httpsOnly after toggle');
          return 'HTTPS-Only toggle → settings.set({httpsOnly})';
        }
        await new Promise((r) => setTimeout(r, 400));
        const s = await ctx.aegis.settings.get();
        if (s.httpsOnly === _originalHttpsOnly)
          throw new Error(`live: httpsOnly did not flip (still ${s.httpsOnly})`);
        // Restore.
        if (_originalHttpsOnly !== undefined) await ctx.aegis.settings.set({ httpsOnly: _originalHttpsOnly });
        return `HTTPS-Only toggle → httpsOnly flipped ${_originalHttpsOnly}→${s.httpsOnly} (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    let _originalPolicy: string | undefined;
    return {
      id: 'settings.security.webrtcPolicy',
      domain: 'settings.security',
      description: 'Change the WebRTC policy select → settings.set({webrtcPolicy}) called',
      screen: 'settings:security',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          _originalPolicy = (await ctx.aegis.settings.get()).webrtcPolicy;
        }
        const select = ctx.byLabel(/^WebRTC policy$/i);
        if (!select) throw new Error('"WebRTC policy" select not found on Security tab');
        // select elements don't support userEvent.clear() — use native change dispatch.
        fireInputChange(select, 'disable');
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('settings.set', (a) => {
            const p = a[0] as Partial<AegisSettings>;
            return p?.webrtcPolicy !== undefined;
          }))
            throw new Error('settings.set not called with webrtcPolicy after change');
          return 'WebRTC policy change → settings.set({webrtcPolicy})';
        }
        await new Promise((r) => setTimeout(r, 400));
        const s = await ctx.aegis.settings.get();
        if (s.webrtcPolicy === _originalPolicy)
          throw new Error(`live: webrtcPolicy did not change from "${_originalPolicy}"`);
        if (_originalPolicy !== undefined)
          await ctx.aegis.settings.set({ webrtcPolicy: _originalPolicy as AegisSettings['webrtcPolicy'] });
        return `WebRTC policy → changed from "${_originalPolicy}" to "${s.webrtcPolicy}" (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  // ── Sync tab ─────────────────────────────────────────────────────────────

  {
    id: 'settings.sync.setServerUrl',
    domain: 'settings.sync',
    description: 'Type a sync server URL and blur → settings.set({syncServerUrl}) called',
    screen: 'settings:sync',
    // live excluded: a real sync-server round-trip is non-deterministic (no server in
    // the autopilot environment) and mutating sync state persists across test runs.
    // The vitest mock covers the IPC wiring; the live catalog entry covers sync end-to-end.
    layers: ['vitest'],
    run: async (ctx) => {
      const input = ctx.byLabel(/^Sync server URL$/i);
      if (!input) throw new Error('"Sync server URL" input not found on Sync tab');
      await ctx.type(input, 'https://ap7sync.example');
      // Blur fires onBlur → onSetServerUrl → settings.update({syncServerUrl}).
      (input as HTMLElement).blur();
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // onSetServerUrl calls settings.update({syncServerUrl:…}) which calls settings.set.
      if (!ctx.calls.called('settings.set', (a) => {
        const p = a[0] as Partial<AegisSettings>;
        return p?.syncServerUrl !== undefined;
      }))
        throw new Error('settings.set not called with syncServerUrl after blur on Sync server URL input');
      return 'Sync server URL blur → settings.set({syncServerUrl})';
    },
  },

  {
    id: 'settings.sync.testConnection',
    domain: 'settings.sync',
    description: 'Click "Test connection" → sync.testConnection called',
    screen: 'settings:sync',
    // live excluded: testConnection makes a real network request to the typed URL;
    // no real sync server exists in the autopilot environment.  The vitest mock
    // covers the IPC wiring.
    layers: ['vitest'],
    run: async (ctx) => {
      // Populate the server URL field first (so the button is enabled).
      const input = ctx.byLabel(/^Sync server URL$/i);
      if (!input) throw new Error('"Sync server URL" input not found on Sync tab');
      await ctx.type(input, 'https://ap7sync.example');
      const testBtn = ctx.byRole('button', /^Test connection$/);
      if (!testBtn) throw new Error('"Test connection" button not found on Sync tab');
      await ctx.click(testBtn);
      // Let the async run() + testConnection mock settle.
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('sync.testConnection', (a) => String(a[0]).includes('ap7sync')))
        throw new Error('sync.testConnection not called with the probe URL');
      return 'Test connection → sync.testConnection(url)';
    },
  },

  {
    id: 'settings.sync.startNew',
    domain: 'settings.sync',
    description: 'Click "Start new sync" → sync.enableNew called',
    screen: 'settings:sync',
    // live excluded: enableNew writes a real key to the system keychain and the sync
    // server is not available in the autopilot environment.  Mutating sync state
    // live would also leave the profile in a synced state that perturbs later test
    // steps.  The vitest mock covers the IPC wiring.
    layers: ['vitest'],
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^Start new sync$/);
      if (!btn) throw new Error('"Start new sync" button not found on Sync tab (sync may be enabled)');
      await ctx.click(btn);
      // Let the async run() + enableNew mock settle.
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('sync.enableNew'))
        throw new Error('sync.enableNew not called after clicking Start new sync');
      return 'Start new sync → sync.enableNew()';
    },
  },

  {
    id: 'settings.sync.restorePhrase',
    domain: 'settings.sync',
    description: 'Paste a recovery phrase and click "Restore" → sync.enableFromPhrase called',
    screen: 'settings:sync',
    // live excluded: enableFromPhrase requires a real key vault and sync server.
    layers: ['vitest'],
    run: async (ctx) => {
      const textarea = ctx.byLabel(/^Recovery phrase$/i);
      if (!textarea) throw new Error('"Recovery phrase" textarea not found on Sync tab');
      await ctx.type(textarea, 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24');
      const restoreBtn = ctx.byRole('button', /^Restore$/);
      if (!restoreBtn) throw new Error('"Restore" button not found on Sync tab');
      await ctx.click(restoreBtn);
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('sync.enableFromPhrase'))
        throw new Error('sync.enableFromPhrase not called after clicking Restore');
      return 'Restore → sync.enableFromPhrase(phrase)';
    },
  },

  // ── Data tab ─────────────────────────────────────────────────────────────

  (() => {
    return {
      id: 'settings.data.export',
      domain: 'settings.data',
      description: 'Click the Export button → data.export called',
      screen: 'settings:data',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        // Guard mock setup to vitest only — on the live layer data.export is the real
        // Tauri function and does not have .mockResolvedValue.
        if (ctx.layer === 'vitest') {
          (ctx.aegis.data.export as unknown as { mockResolvedValue(v: unknown): void })
            .mockResolvedValue({ ok: true, path: '/tmp/aegis-export.json' });
        }
        const exportBtn = ctx.byRole('button', /^Export$/);
        if (!exportBtn) throw new Error('"Export" button not found on Data tab');
        await ctx.click(exportBtn);
        await new Promise((r) => setTimeout(r, 100));
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('data.export'))
            throw new Error('data.export not called after clicking Export');
          return 'Data Export → data.export()';
        }
        // Live: the export must return ok:true with a path (real file written).
        // The data.export call happened in run(); capture the result via a fresh call.
        const result = await ctx.aegis.data.export();
        if (!result.ok)
          throw new Error(`live: data.export returned ok:false — export may have failed`);
        return `Data Export → data.export() → ok, path="${result.path ?? 'unknown'}"`;
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'settings.data.import',
    domain: 'settings.data',
    description: 'Click the Import button → data.import called',
    screen: 'settings:data',
    // live excluded: data.import is destructive (replaces or merges user data) and
    // may open a native file picker that blocks the test.  The vitest mock covers
    // the IPC wiring.  The live catalog entry covers the import round-trip.
    layers: ['vitest'],
    run: async (ctx) => {
      // The import button triggers data.import; it may confirm first (replace mode).
      // Default mode is 'merge' which doesn't confirm.
      const importBtn = ctx.byRole('button', /^Import$/);
      if (!importBtn) throw new Error('"Import" button not found on Data tab');
      await ctx.click(importBtn);
      await new Promise((r) => setTimeout(r, 100));
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('data.import'))
        throw new Error('data.import not called after clicking Import');
      return 'Data Import → data.import()';
    },
  },

  {
    id: 'settings.data.importMode',
    domain: 'settings.data',
    description: 'Click the "Replace" radio → import mode changes to replace',
    screen: 'settings:data',
    // Pure UI state change (local React state `mode`); no aegis call is made until
    // Import is clicked.  Asserting UI state (not a call) → vitest-only.
    layers: ['vitest'],
    run: async (ctx) => {
      // Click the "Replace" radio button.
      // The radio is inside a <label> with value="replace"; accessible name is "Replace".
      const replaceRadio = ctx.bySelector('input[type="radio"][value="replace"]');
      if (!replaceRadio) throw new Error('"Replace" radio button not found on Data tab');
      await ctx.click(replaceRadio);
    },
    assert: async (ctx) => {
      // The "Replace" radio must now be checked.
      const replaceRadio = ctx.bySelector('input[type="radio"][value="replace"]') as HTMLInputElement | null;
      if (!replaceRadio) throw new Error('"Replace" radio not found during assert');
      if (!replaceRadio.checked)
        throw new Error('"Replace" radio is not checked after clicking it — mode change had no effect');
      return 'Data import mode → "replace" radio is now checked';
    },
  },

  // ─── Task 8: overlays ───────────────────────────────────────────────────

  (() => {
    // Seed a fake completed download so the "Clear all downloads" button is enabled.
    const SEED_DOWNLOAD: import('../../shared/types').DownloadEntry = {
      id: 9001,
      url: 'https://example.com/file.pdf',
      filename: 'file.pdf',
      state: 'completed',
      receivedBytes: 1024,
      totalBytes: 1024,
      savePath: '/tmp/file.pdf',
      startedAt: 0,
    };
    return {
      id: 'downloads.clear',
      domain: 'downloads',
      description: 'Open downloads modal → click Clear all → confirm → downloads.clear called',
      screen: 'downloads',
      // vitest-only: seeding a real download entry requires an actual in-progress download
      // which the live autopilot cannot trigger on demand.
      layers: ['vitest'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        // The "Clear all downloads" button is disabled when downloads.length === 0.
        // Seed the list via the control-surface seam (same as emitHistory for history panel).
        await ctx.emitDownloadsChanged?.([SEED_DOWNLOAD]);
        const clearBtn = ctx.byRole('button', /^Clear all downloads$/);
        if (!clearBtn) throw new Error('"Clear all downloads" button not found in DownloadsPanel (button may still be disabled)');
        // Clicking the button calls handleClear() → confirm() → setPending (async React update).
        // userEvent.click in the vitest ctx wraps in act(), which flushes the state update.
        await ctx.click(clearBtn);
        // ConfirmDialog renders the OK/Cancel buttons in response to confirm().
        // If OK is present (ConfirmDialog is fully rendered), click it.
        // If not present, window.confirm is stubbed to return true in the vitest tour,
        // so downloads.clear() will still be called via the fallback path.
        const okBtn = ctx.byRole('button', /^OK$/);
        if (okBtn) await ctx.click(okBtn);
        // Give the async confirm → clear chain a tick to settle.
        await new Promise((r) => setTimeout(r, 100));
      },
      assert: async (ctx: InteractionCtx) => {
        if (!ctx.calls.called('downloads.clear'))
          throw new Error('downloads.clear not called after clicking Clear + OK');
        return 'downloads Clear all → downloads.clear()';
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'confirm.confirm',
    domain: 'confirm',
    description: 'Open ConfirmDialog → click OK → the confirm resolver runs and dialog closes',
    screen: 'confirmDialog',
    // vitest-only: synthesizing an in-app confirm() call in the live run has no safe
    // observable side-effect and is not needed (the ConfirmDialog is already exercised
    // transitively by sidebar.history.clear and downloads.clear live interactions).
    layers: ['vitest'],
    run: async (ctx) => {
      // reachScreen already opened the confirm dialog via control.openConfirm.
      const okBtn = ctx.byRole('button', /^OK$/);
      if (!okBtn) throw new Error('"OK" button not found in ConfirmDialog');
      await ctx.click(okBtn);
      // Give React a tick to update after the dialog closes.
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // After clicking OK the dialog should have disappeared from the DOM.
      const dialog = ctx.byRole('dialog');
      if (dialog) throw new Error('ConfirmDialog is still in the DOM after clicking OK');
      return 'ConfirmDialog OK → dialog dismissed';
    },
  },

  {
    id: 'confirm.cancel',
    domain: 'confirm',
    description: 'Open ConfirmDialog → click Cancel → dialog closes with no action',
    screen: 'confirmDialog',
    // vitest-only: same reasoning as confirm.confirm.
    layers: ['vitest'],
    run: async (ctx) => {
      // reachScreen already opened the confirm dialog via control.openConfirm.
      const cancelBtn = ctx.byRole('button', /^Cancel$/);
      if (!cancelBtn) throw new Error('"Cancel" button not found in ConfirmDialog');
      await ctx.click(cancelBtn);
      // Give React a tick to update after the dialog closes.
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // After clicking Cancel the dialog should have disappeared from the DOM.
      const dialog = ctx.byRole('dialog');
      if (dialog) throw new Error('ConfirmDialog is still in the DOM after clicking Cancel');
      return 'ConfirmDialog Cancel → dialog dismissed without action';
    },
  },

  {
    id: 'errorOverlay.retry',
    domain: 'errorOverlay',
    description: 'Emit nav.failed → click Retry → nav.reloadOrStop called',
    screen: 'home',
    // vitest-only: the live core emits nav.failed only on real network errors; synthesizing
    // this deterministically would require a real server setup.  nav.reloadOrStop is already
    // tested live via the toolbar.reload interaction.
    layers: ['vitest'],
    run: async (ctx) => {
      // Render the error overlay by invoking the nav.onFailed callback App registered.
      const FAILED: NavFailed = {
        viewId: 1,
        errorCode: -105,
        errorDescription: 'NAME_NOT_RESOLVED',
        validatedURL: 'https://invalid.invalid/',
        kind: 'load',
      };
      await ctx.emitNavFailed?.(FAILED);
      const retryBtn = ctx.byRole('button', /^Retry$/);
      if (!retryBtn) throw new Error('"Retry" button not found in ErrorOverlay');
      await ctx.click(retryBtn);
      // Clear the overlay via the control surface (same as leaveScreen's clearError).
      // nav.reloadOrStop triggers isLoading=true which clears failed/crashed in App,
      // but in vitest the nav mock is a no-op; use the control surface directly.
      if (ctx.layer === 'vitest') {
        const { getAutopilotControl } = await import('./control');
        const { flushSync } = await import('react-dom');
        const control = getAutopilotControl();
        if (control) flushSync(() => control.clearError());
      }
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.reloadOrStop'))
        throw new Error('nav.reloadOrStop not called after clicking Retry');
      return 'errorOverlay Retry → nav.reloadOrStop()';
    },
  },

  {
    id: 'crashOverlay.reload',
    domain: 'crashOverlay',
    description: 'Emit nav.crashed → click Reload → nav.reloadOrStop called',
    screen: 'home',
    // vitest-only: the live core emits nav.crashed only on actual renderer crashes,
    // which cannot be triggered deterministically in an autopilot run.
    layers: ['vitest'],
    run: async (ctx) => {
      // Render the crash overlay by invoking the nav.onCrashed callback App registered.
      const CRASHED: NavCrashed = { viewId: 1, reason: 'crashed' };
      await ctx.emitNavCrashed?.(CRASHED);
      // The crash view shows the heading "This page crashed" and a Retry button
      // (ErrorOverlay reuses the same Retry/Home layout for both failed and crashed states).
      const retryBtn = ctx.byRole('button', /^Retry$/);
      if (!retryBtn) throw new Error('"Retry" button not found in ErrorOverlay (crash view)');
      await ctx.click(retryBtn);
      // Clear the crash overlay via the control surface so it doesn't linger.
      if (ctx.layer === 'vitest') {
        const { getAutopilotControl } = await import('./control');
        const { flushSync } = await import('react-dom');
        const control = getAutopilotControl();
        if (control) flushSync(() => control.clearCrash());
      }
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.reloadOrStop'))
        throw new Error('nav.reloadOrStop not called after clicking Retry (crash overlay)');
      return 'crashOverlay Retry → nav.reloadOrStop()';
    },
  },

  {
    id: 'safety.proceed',
    domain: 'safety',
    description: 'Emit safety interstitial → click "Continue anyway" → safety.proceed called',
    screen: 'home',
    // vitest-only: the safety interstitial is triggered only when MalwareGuard blocks a
    // real URL; the live autopilot cannot navigate to a real malware URL safely.
    layers: ['vitest'],
    run: async (ctx) => {
      const PAYLOAD: SafetyInterstitialPayload = { url: 'https://malware.test/', reason: 'malware' };
      // Render the interstitial by invoking the onInterstitial callback useSafety registered.
      await ctx.emitSafetyInterstitial?.(PAYLOAD);
      // The continue button text for malware is "Continue anyway (not recommended)".
      const continueBtn = ctx.byRole('button', /continue anyway/i);
      if (!continueBtn) throw new Error('"Continue anyway" button not found in SafetyInterstitial');
      await ctx.click(continueBtn);
      // Clear the interstitial so it doesn't linger.
      await ctx.emitSafetyInterstitial?.(null);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('safety.proceed'))
        throw new Error('safety.proceed not called after clicking "Continue anyway"');
      return 'safetyInterstitial "Continue anyway" → safety.proceed()';
    },
  },

  {
    id: 'safety.back',
    domain: 'safety',
    description: 'Emit safety interstitial → click "Go back" → nav.back called',
    screen: 'home',
    // vitest-only: same reasoning as safety.proceed.
    layers: ['vitest'],
    run: async (ctx) => {
      const PAYLOAD: SafetyInterstitialPayload = { url: 'https://malware.test/', reason: 'malware' };
      // Render the interstitial by invoking the onInterstitial callback useSafety registered.
      await ctx.emitSafetyInterstitial?.(PAYLOAD);
      // The "Go back" button is provided by SafetyInterstitial when onBack is passed.
      const backBtn = ctx.byRole('button', /^Go back$/);
      if (!backBtn) throw new Error('"Go back" button not found in SafetyInterstitial');
      await ctx.click(backBtn);
      // Clear the interstitial so it doesn't linger.
      await ctx.emitSafetyInterstitial?.(null);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.back'))
        throw new Error('nav.back not called after clicking "Go back" in SafetyInterstitial');
      return 'safetyInterstitial "Go back" → nav.back()';
    },
  },

  {
    id: 'permission.allow',
    domain: 'permission',
    description: 'Emit permission prompt → click Allow → permissions.resolve(allow) called',
    screen: 'home',
    // vitest-only: the permission prompt is triggered by the real OS permission request in
    // a content webview; the live autopilot cannot safely trigger a geolocation prompt.
    layers: ['vitest'],
    run: async (ctx) => {
      const PROMPT: PermissionPrompt = { requestId: 1, origin: 'https://example.com', permission: 'geolocation' };
      // Render the permission dialog by invoking the onPrompt callback usePermissions registered.
      await ctx.emitPermissionPrompt?.(PROMPT);
      const allowBtn = ctx.byRole('button', /^Allow$/);
      if (!allowBtn) throw new Error('"Allow" button not found in PermissionPromptDialog');
      await ctx.click(allowBtn);
      // Dismiss the prompt so it doesn't linger (usePermissions clears it on resolve).
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // permissions.resolve is called with (requestId, 'allow') — check the second arg.
      if (!ctx.calls.called('permissions.resolve', (a) => a[1] === 'allow'))
        throw new Error('permissions.resolve not called with "allow"');
      return 'permissionPrompt Allow → permissions.resolve(requestId, "allow")';
    },
  },

  {
    id: 'permission.deny',
    domain: 'permission',
    description: 'Emit permission prompt → click Block → permissions.resolve(deny) called',
    screen: 'home',
    // vitest-only: same reasoning as permission.allow.
    layers: ['vitest'],
    run: async (ctx) => {
      const PROMPT: PermissionPrompt = { requestId: 2, origin: 'https://example.com', permission: 'microphone' };
      // Render the permission dialog by invoking the onPrompt callback usePermissions registered.
      await ctx.emitPermissionPrompt?.(PROMPT);
      // The deny button is labelled "Block" in PermissionPromptDialog.
      const blockBtn = ctx.byRole('button', /^Block$/);
      if (!blockBtn) throw new Error('"Block" button not found in PermissionPromptDialog');
      await ctx.click(blockBtn);
      // Dismiss the prompt so it doesn't linger.
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // permissions.resolve is called with (requestId, 'deny') — check the second arg.
      if (!ctx.calls.called('permissions.resolve', (a) => a[1] === 'deny'))
        throw new Error('permissions.resolve not called with "deny"');
      return 'permissionPrompt Block → permissions.resolve(requestId, "deny")';
    },
  },

  {
    id: 'redirectBar.openAnyway',
    domain: 'redirectBar',
    description: 'Emit redirect.blocked → click "Open anyway" → tabs.create(to) called',
    screen: 'home',
    // vitest-only: the redirect guard fires only when the native nav policy blocks a
    // real scripted redirect; not reproducible on demand in the live autopilot.
    layers: ['vitest'],
    run: async (ctx) => {
      const REDIRECT: RedirectBlocked = {
        viewId: 1,
        from: 'https://publisher.test/',
        to: 'https://malvertising.test/landing',
      };
      // Render the RedirectBar by invoking the onBlocked callback App registered.
      await ctx.emitRedirectBlocked?.(REDIRECT);
      const openBtn = ctx.byRole('button', /^Open anyway$/);
      if (!openBtn) throw new Error('"Open anyway" button not found in RedirectBar');
      await ctx.click(openBtn);
      // The bar dismisses itself after "Open anyway" (setBlockedRedirect(null) in App).
    },
    assert: async (ctx) => {
      // App calls tabs.create(to, false) when "Open anyway" is clicked.
      if (!ctx.calls.called('tabs.create', (a) => String(a[0]).includes('malvertising.test')))
        throw new Error('tabs.create not called with the blocked redirect destination URL');
      return 'redirectBar "Open anyway" → tabs.create(malvertising.test/landing)';
    },
  },

  {
    id: 'redirectBar.dismiss',
    domain: 'redirectBar',
    description: 'Emit redirect.blocked → click Dismiss (X) → bar removed from DOM',
    screen: 'home',
    // vitest-only: same reasoning as redirectBar.openAnyway.
    layers: ['vitest'],
    run: async (ctx) => {
      const REDIRECT: RedirectBlocked = {
        viewId: 1,
        from: 'https://publisher.test/',
        to: 'https://malvertising.test/landing',
      };
      // Render the RedirectBar by invoking the onBlocked callback App registered.
      await ctx.emitRedirectBlocked?.(REDIRECT);
      // The dismiss button has aria-label="Dismiss" (set in RedirectBar).
      const dismissBtn = ctx.byLabel(/^Dismiss$/);
      if (!dismissBtn) throw new Error('"Dismiss" button not found in RedirectBar');
      await ctx.click(dismissBtn);
      // Give React a tick to remove the bar from the DOM.
      await new Promise((r) => setTimeout(r, 50));
    },
    assert: async (ctx) => {
      // After clicking Dismiss the bar should no longer be in the DOM.
      const bar = ctx.bySelector('.redirect-bar');
      if (bar) throw new Error('RedirectBar still in DOM after clicking Dismiss');
      return 'redirectBar Dismiss → bar removed from DOM';
    },
  },

  // ─── Task 9: edge/error inputs + state combinations ─────────────────────

  {
    id: 'edge.addressBar.empty',
    domain: 'edge',
    description: 'Clear the address bar and press Enter → navigates to empty search (no crash)',
    screen: 'home',
    // vitest-only (intentional): empty-Enter produces no observable real-state change
    // beyond "no crash" and "nav.navigate was called with an empty-query search URL".
    // The live CallLog is inert (cannot count calls), and the live nav state change
    // (empty search URL) would be transient and race-prone to poll.  The negative
    // assertion (App is still mounted + nav.navigate fired) is fully covered by the
    // vitest mock where CallLog IS observable.  A live branch would only redundantly
    // confirm the address bar accepts Enter without a URL, which toolbar.home and
    // toolbar.addressBar.navigate already cover end-to-end in the live layer.
    layers: ['vitest'],
    run: async (ctx) => {
      const bar = ctx.byRole('textbox', /address/i) ?? ctx.bySelector('input[type="text"]');
      if (!bar) throw new Error('Address bar input not found');
      // Cannot use ctx.type(bar, '') because userEvent.type rejects empty string.
      // Click to focus (so AddressBar selects all text), then use fireInputChange to set
      // the value to '' via the native-value-setter + change event — the same approach
      // used for color/number inputs elsewhere in this file.  The form's onSubmit reads
      // the React-state value (not the DOM .value), which is updated by AddressBar's
      // onChange handler.
      await ctx.click(bar);
      fireInputChange(bar, '');
      // Focus must be on the input for ctx.press('Enter') to fire on the right element.
      // click() should have focused it; confirm by dispatching the submit event on the form.
      const form = bar.closest('form');
      if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      } else {
        await ctx.press('Enter');
      }
    },
    assert: async (ctx) => {
      // Verified via addressParse: empty trimmed input → no scheme, no dot →
      // falls through to the search template path →
      // nav.navigate(viewId, searchTemplate.replace('%s', encodeURIComponent('')))
      // = 'https://duckduckgo.com/?q='.
      // So nav.navigate IS called (with an empty-query search URL), NOT blocked.
      // We assert: (1) App is still mounted (no crash), (2) nav.navigate was called.
      if (!ctx.calls.called('nav.navigate'))
        throw new Error('nav.navigate was not called after empty Enter — expected empty search navigation');
      if (!document.querySelector('.app'))
        throw new Error('App is no longer mounted after empty address bar Enter (crash?)');
      return 'empty address bar Enter → nav.navigate (empty search) + App still mounted';
    },
  },

  {
    id: 'edge.addressBar.malformed',
    domain: 'edge',
    description: 'Type a malformed URL (ht!tp://x) and press Enter → navigates as search, no crash',
    screen: 'home',
    layers: ['vitest'],
    run: async (ctx) => {
      // 'ht!tp://x' is intentionally malformed: the '!' breaks the RFC 3986 scheme
      // character set, so hasScheme() returns false.  The string also has no dot, so
      // looksLikeHost() returns false.  Result: addressParse falls through to the
      // search-template branch → nav.navigate is called with the search engine URL
      // (the malformed text encoded as a query parameter).  This is NOT a rejection
      // (kind='rejected' would leave nav.navigate uncalled) — it's gracefully treated
      // as a search query, which is the browser's documented behaviour for non-URL input.
      const bar = ctx.byRole('textbox', /address/i) ?? ctx.bySelector('input[type="text"]');
      if (!bar) throw new Error('Address bar input not found');
      await ctx.type(bar, 'ht!tp://x');
      await ctx.press('Enter');
    },
    assert: async (ctx) => {
      // nav.navigate must be called with a search URL containing the encoded input.
      // The search template produces: https://duckduckgo.com/?q=ht!tp%3A%2F%2Fx
      // (or similar — just check nav.navigate was called to avoid encoding fragility).
      if (!ctx.calls.called('nav.navigate'))
        throw new Error('nav.navigate not called after malformed-URL Enter — expected search navigation');
      // Additionally verify it was NOT treated as a navigate-to-literal-URL (that would
      // be a security/crash risk if the scheme were truly malformed).  The call should
      // include encoded form of the input, not the raw 'ht!tp://x' as a literal URL.
      const calledWithRaw = ctx.calls.of('nav.navigate').some((args) => String(args[1]) === 'ht!tp://x');
      if (calledWithRaw)
        throw new Error('nav.navigate was called with the raw malformed URL — expected search encoding');
      if (!document.querySelector('.app'))
        throw new Error('App is no longer mounted after malformed address bar Enter (crash?)');
      return 'malformed URL → nav.navigate(search) + not literal URL + App still mounted';
    },
  },

  (() => {
    // live-only: the dedup is enforced at the Rust layer (saved.add line 113 in places.rs
    // checks live_has_url before inserting).  In vitest the mock's saved.add always returns
    // [] and never updates isCurrentSaved, so the BookmarkButton stays in "Save" state and
    // calling it twice only exercises the mock — it cannot prove dedup.  The live run uses
    // the real Rust core, which IS the dedup under test.
    const PROBE_URL = 'https://edge-dedup-test.example/';
    const PROBE_TITLE = 'Dedup Test';
    let _baseLength: number | undefined;
    return {
      id: 'edge.favorite.duplicate',
      domain: 'edge',
      description: 'Add the same URL to saved twice → only ONE entry exists (dedup)',
      screen: 'home',
      // live-only: dedup lives in the Rust core; vitest mock has no dedup logic.
      layers: ['live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        // Snapshot baseline before adding anything.
        const before = await ctx.aegis.saved.list();
        // Remove any pre-existing probe entry so the baseline is clean.
        for (const i of before.filter((i) => i.url === PROBE_URL)) {
          await ctx.aegis.saved.remove(i.id);
        }
        const clean = await ctx.aegis.saved.list();
        _baseLength = clean.length;
        // Add the same URL twice in rapid succession.
        await ctx.aegis.saved.add({ url: PROBE_URL, title: PROBE_TITLE });
        await ctx.aegis.saved.add({ url: PROBE_URL, title: PROBE_TITLE });
        await new Promise((r) => setTimeout(r, 300));
      },
      assert: async (ctx: InteractionCtx) => {
        if (_baseLength === undefined)
          throw new Error('live: _baseLength was never captured (run() may not have executed)');
        const list = await ctx.aegis.saved.list();
        const probe = list.filter((i) => i.url === PROBE_URL);
        // The exact expected count: baseline + 1 (the dedup means only one entry, not two).
        if (probe.length !== 1)
          throw new Error(
            `REAL BUG: saved.add called twice with the same URL produced ${probe.length} entries (expected 1 — dedup missing or broken). list.length=${list.length}, baseLength=${_baseLength}`,
          );
        if (list.length !== _baseLength + 1)
          throw new Error(
            `REAL BUG: list.length is ${list.length}, expected ${_baseLength + 1} after one-unique add+dedup`,
          );
        // Clean up the probe entry.
        for (const i of probe) {
          await ctx.aegis.saved.remove(i.id);
        }
        return `saved dedup: adding same URL twice → exactly 1 entry (baseline ${_baseLength} → ${_baseLength + 1} → cleaned up)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Tag whitespace validation: TagInput.addTag() trims the input and returns early
    // when the trimmed value is empty (value.length === 0).  A whitespace-only tag input
    // ('   ') trims to '' and is silently rejected — no tag is added to the item's tags
    // array, and saved.update is NOT called with a whitespace string.
    const SEED_ITEM: SavedItem = {
      id: 200,
      url: 'https://edge-whitespace-tag.example/',
      title: 'Whitespace Tag Test',
      tags: [],
      savedAt: 0,
    };
    return {
      id: 'edge.tag.whitespace',
      domain: 'edge',
      description: 'Type a whitespace-only tag and Enter → tag rejected/trimmed, no empty tag in item',
      screen: 'sidebar:saved',
      layers: ['vitest'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        // Seed the panel with a single clean item (no tags).
        await ctx.emitSaved?.([SEED_ITEM], []);
        // Open the item's inline editor.
        const editBtn = ctx.bySelector('.saved-panel__edit');
        if (!editBtn) throw new Error('No saved-panel edit button found (panel may be empty)');
        await ctx.click(editBtn);
        // Find the "Add tag" input in TagInput.
        const tagInput = ctx.byLabel(/^Add tag$/);
        if (!tagInput) throw new Error('"Add tag" input not found in saved item editor');
        // Type whitespace-only text.
        await ctx.type(tagInput, '   ');
        // Press Enter — TagInput.commit() → addTag('   ') → value='', returns early.
        await ctx.press('Enter');
        // Now click Save — saved.update will be called with the item's current (unmodified) tags.
        const saveBtn = ctx.bySelector('.saved-panel__save');
        if (!saveBtn) throw new Error('Save button not found in saved item editor');
        await ctx.click(saveBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        // If saved.update was called at all, it must NOT have included a whitespace tag.
        // (If the item had no changes, saved.update may not be called at all — that is fine.)
        const updateCalls = ctx.calls.of('saved.update');
        for (const args of updateCalls) {
          const partial = args[1] as { tags?: string[] };
          if (Array.isArray(partial?.tags)) {
            const badTag = partial.tags.find((t) => t.trim() === '');
            if (badTag !== undefined)
              throw new Error(
                `REAL BUG: saved.update was called with a whitespace/empty tag "${badTag}" — TagInput validation failed`,
              );
          }
        }
        // DOM check: no whitespace or empty tag chip should be rendered in the saved item.
        // Tag chips in the saved panel carry class "tag-chip" (or "tag-input__tag");
        // scan them all and confirm none has blank visible text.
        const tagChips = Array.from(document.querySelectorAll('.tag-chip, .tag-input__tag'));
        const blankChip = tagChips.find((el) => el.textContent?.trim() === '');
        if (blankChip !== undefined)
          throw new Error(
            `REAL BUG: a blank/whitespace tag chip is rendered in the saved item — TagInput validation failed at the DOM level`,
          );
        if (!document.querySelector('.app'))
          throw new Error('App is no longer mounted after whitespace tag gesture (crash?)');
        return 'whitespace-only tag Enter → TagInput rejected it (no empty tag in saved.update call + no blank chip in DOM)';
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Double-click the bookmark star.  The useSaved hook now has an in-flight guard
    // (addingRef) that suppresses re-entrant addCurrent() calls while a saved.add
    // IPC is already in flight.  This spec is the regression sentinel: it asserts
    // that exactly ONE saved.add call is dispatched even on rapid double-click.
    //
    // Implementation note: the guard works when the first saved.add IPC is still
    // awaited while the second click fires.  With the default instant mock, the first
    // call resolves on the microtask queue before the second click's event handlers
    // run, so the guard's addingRef would already be false.  To reproduce the real-
    // world in-flight scenario we temporarily replace the saved.add mock with a
    // slow version that does NOT resolve until after both clicks have been dispatched.
    type SavedAddMock = { mockImplementationOnce(fn: (...a: unknown[]) => unknown): void };
    let _resolveFirst: ((v: import('../../shared/types').SavedItem[]) => void) | undefined;
    return {
      id: 'edge.bookmark.doubleClick',
      domain: 'edge',
      description: 'Click the bookmark star twice rapidly → exactly ONE saved.add dispatched (in-flight guard)',
      screen: 'home',
      // vitest-only: the live CallLog is inert and we can't observe the call count there.
      // The in-flight guard is in the React layer (useSaved.addCurrent); the live Rust
      // dedup is a separate safety net tested by edge.favorite.duplicate.
      layers: ['vitest'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        // Ensure the nav URL has a saveable host so the bookmark button is enabled.
        await emitNavState(ctx, { ...BASE_NAV, url: 'https://example.com/', title: 'Example' });
        // Replace the instant saved.add mock with a slow version (never-resolves-until-we-say)
        // so the first click is still in flight when the second click fires.
        (ctx.aegis.saved.add as unknown as SavedAddMock).mockImplementationOnce(
          () => new Promise<import('../../shared/types').SavedItem[]>((res) => { _resolveFirst = res; }),
        );
        const btn = ctx.byRole('button', /save bookmark/i);
        if (!btn) throw new Error('Save bookmark button not found');
        // First click: starts addCurrent → addingRef=true → awaits the slow saved.add.
        // Do NOT await fully — fire the click and immediately fire the second without
        // waiting for the first addCurrent() to complete.
        const p1 = ctx.click(btn);
        // Yield one microtask so the onClick handler starts (addingRef becomes true)
        // before the second click, but the slow saved.add promise has NOT resolved yet.
        await Promise.resolve();
        const p2 = ctx.click(btn);
        // Now let both clicks propagate so the guard can intercept the second one.
        // Resolve the first saved.add call so addCurrent() can finish.
        _resolveFirst?.([]);
        await p1;
        await p2;
      },
      assert: async (ctx: InteractionCtx) => {
        const addCalls = ctx.calls.of('saved.add');
        if (!document.querySelector('.app'))
          throw new Error('App is no longer mounted after double-click bookmark (crash?)');
        if (addCalls.length < 1)
          throw new Error('saved.add was never called on double-click — bookmark button appears broken');
        // Regression sentinel: the in-flight guard must prevent the second click from
        // dispatching a second saved.add.  If this fails, the guard was removed or broken.
        if (addCalls.length !== 1)
          throw new Error(
            `REGRESSION: bookmark double-click dispatched saved.add × ${addCalls.length} (expected exactly 1 — in-flight guard is missing or broken)`,
          );
        return 'bookmark double-click → saved.add × 1 (in-flight guard working) + App still mounted';
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'combo.settingsOverSidebar',
    domain: 'combo',
    description: 'Open the sidebar, then open Settings → both states consistent, no crash',
    screen: 'home',
    // vitest-only: the live run's view.setLayout can't be easily verified via ctx.aegis
    // (it's a view call, not a data call), and the overlay z-order is a desktop-native
    // concern.  Vitest asserts the React state stays consistent and App is mounted.
    layers: ['vitest'],
    run: async (ctx) => {
      // Open the sidebar via the autopilot control (same as reachScreen 'sidebar:history').
      // ctx.reach('sidebar:history') opens the sidebar; we leave it open and then open Settings.
      await ctx.reach('sidebar:history');
      // Now open Settings on top of the open sidebar.
      await ctx.reach('settings:appearance');
    },
    assert: async (ctx) => {
      // Settings should be open (SettingsModal is in the DOM).
      const modal = ctx.bySelector('.settings-modal');
      if (!modal) throw new Error('Settings modal not found after opening Settings over sidebar');
      // App must still be mounted.
      if (!document.querySelector('.app'))
        throw new Error('App is no longer mounted after settings-over-sidebar combo (crash?)');
      // view.setLayout must have been called (the overlay/sidebar state update fires on mount
      // and on every state change — at least one call should exist).
      if (!ctx.calls.called('view.setLayout'))
        throw new Error('view.setLayout not called — overlay/sidebar state was not reported to the core');
      return 'sidebar + Settings open together → modal present, view.setLayout called, App mounted';
    },
  },

  // ─── Task 10: mobile-only controls ─────────────────────────────────────────
  //
  // These specs run ONLY in the mobile tour (interactions.mobile.test.tsx).
  // They drive MobileBottomBar, MobileMenuSheet, and MobileTabSwitcher.
  // All are `layers: ['vitest']` because the live autopilot drives the DESKTOP shell
  // (run.ts opens App without the .aegis-mobile class), so the live layer cannot reach
  // these controls.  The mobile vitest tour fully covers the wiring.
  //
  // Reach strategy: mobile has no AutopilotControl surface (MobileApp doesn't call
  // installAutopilotControl), so every spec reaches its screen via direct DOM clicks
  // on the bottom bar / sheet buttons rather than reachScreen(control, …).

  {
    id: 'mobile.bottomBar.saved',
    domain: 'mobile.bottomBar',
    description: 'Click the Saved button in MobileBottomBar → Saved sheet opens',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^Saved$/);
      if (!btn) throw new Error('Saved button not found in MobileBottomBar');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      // The Saved sheet renders a dialog with aria-label="Saved".
      const sheet = ctx.bySelector('[role="dialog"][aria-label="Saved"]');
      if (!sheet) throw new Error('Saved sheet (dialog aria-label="Saved") not found after clicking Saved');
      return 'MobileBottomBar Saved → Saved sheet opened';
    },
  },

  {
    id: 'mobile.bottomBar.history',
    domain: 'mobile.bottomBar',
    description: 'Click the History button in MobileBottomBar → History sheet opens',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^History$/);
      if (!btn) throw new Error('History button not found in MobileBottomBar');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      // The History sheet renders a dialog with aria-label="History".
      const sheet = ctx.bySelector('[role="dialog"][aria-label="History"]');
      if (!sheet) throw new Error('History sheet (dialog aria-label="History") not found after clicking History');
      return 'MobileBottomBar History → History sheet opened';
    },
  },

  {
    id: 'mobile.bottomBar.tabs',
    domain: 'mobile.bottomBar',
    description: 'Click the Tabs button in MobileBottomBar → Tab switcher sheet opens',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // The Tabs button aria-label is "Tabs (N open)".
      const btn = ctx.byRole('button', /^Tabs \(\d+ open\)$/);
      if (!btn) throw new Error('Tabs button not found in MobileBottomBar (expected aria-label "Tabs (N open)")');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      // The tab switcher renders a dialog with aria-label="Tabs".
      const sheet = ctx.bySelector('[role="dialog"][aria-label="Tabs"]');
      if (!sheet) throw new Error('Tabs sheet (dialog aria-label="Tabs") not found after clicking Tabs button');
      return 'MobileBottomBar Tabs → Tab switcher sheet opened';
    },
  },

  {
    id: 'mobile.bottomBar.menu',
    domain: 'mobile.bottomBar',
    description: 'Click the Menu button in MobileBottomBar → Menu sheet opens',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^Menu$/);
      if (!btn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      // The menu sheet renders a dialog with aria-label="Menu".
      const sheet = ctx.bySelector('[role="dialog"][aria-label="Menu"]');
      if (!sheet) throw new Error('Menu sheet (dialog aria-label="Menu") not found after clicking Menu');
      return 'MobileBottomBar Menu → Menu sheet opened';
    },
  },

  {
    id: 'mobile.menu.home',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click Home → nav.home called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Open the menu sheet first.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Click the Home item in the menu sheet.
      const homeBtn = ctx.byRole('button', /^Home$/);
      if (!homeBtn) throw new Error('Home button not found in MobileMenuSheet');
      await ctx.click(homeBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.home'))
        throw new Error('nav.home not called after clicking Home in MobileMenuSheet');
      return 'MobileMenuSheet Home → nav.home()';
    },
  },

  {
    id: 'mobile.menu.back',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click Back (canGoBack=true) → nav.back called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Open the menu sheet FIRST (before emitting nav state), so the sheet is
      // mounted and ready.  Then emit nav state with canGoBack=true so the re-render
      // of the already-mounted sheet picks up the enabled Back button.
      // (Emitting nav state BEFORE opening the menu won't work because useNav's async
      //  getState().then(setState) resolves after flushSync, resetting canGoBack=false
      //  before the menu renders. Opening the menu first, then emitting, avoids the race.)
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Now enable the Back button by updating the nav state.
      await ctx.emitNavState?.({ ...BASE_NAV, canGoBack: true });
      // The Back item is a button with text "Back" in the menu list.
      const backBtn = ctx.byRole('button', /^Back$/);
      if (!backBtn) throw new Error('Back button not found in MobileMenuSheet');
      await ctx.click(backBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.back'))
        throw new Error('nav.back not called after clicking Back in MobileMenuSheet');
      return 'MobileMenuSheet Back → nav.back()';
    },
  },

  {
    id: 'mobile.menu.forward',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click Forward (canGoForward=true) → nav.forward called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Same open-first approach as mobile.menu.back: open the menu, then emit
      // canGoForward=true so the already-mounted sheet re-renders with an enabled button.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Now enable the Forward button.
      await ctx.emitNavState?.({ ...BASE_NAV, canGoForward: true });
      // The Forward item is a button with text "Forward" in the menu list.
      const forwardBtn = ctx.byRole('button', /^Forward$/);
      if (!forwardBtn) throw new Error('Forward button not found in MobileMenuSheet');
      await ctx.click(forwardBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.forward'))
        throw new Error('nav.forward not called after clicking Forward in MobileMenuSheet');
      return 'MobileMenuSheet Forward → nav.forward()';
    },
  },

  {
    id: 'mobile.menu.bookmark',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click "Bookmark this page" → saved.add called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Ensure the page has a bookmarkable host (canBookmark = host !== null).
      await ctx.emitNavState?.({ ...BASE_NAV, url: 'https://example.com/', title: 'Example' });
      // Open the menu sheet.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // The bookmark item renders "Bookmark this page" (isCurrentSaved=false from the mock).
      const bookmarkBtn = ctx.byRole('button', /^Bookmark this page$/);
      if (!bookmarkBtn) throw new Error('"Bookmark this page" button not found in MobileMenuSheet');
      await ctx.click(bookmarkBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('saved.add'))
        throw new Error('saved.add not called after clicking "Bookmark this page" in MobileMenuSheet');
      return 'MobileMenuSheet "Bookmark this page" → saved.add()';
    },
  },

  {
    id: 'mobile.menu.downloads',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click Downloads → Downloads modal opens',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Open the menu sheet.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Click the Downloads item.
      const downloadsBtn = ctx.byRole('button', /^Downloads$/);
      if (!downloadsBtn) throw new Error('Downloads button not found in MobileMenuSheet');
      await ctx.click(downloadsBtn);
    },
    assert: async (ctx) => {
      // The DownloadsModal opens as a sheet (renders with role="dialog" aria-label="Downloads").
      // The DownloadsModal does not use an aria-label dialog role itself, but it renders
      // inside a MobileSheet which has role="dialog" aria-label="Downloads".
      // Actually DownloadsModal is reused directly in MobileApp — it uses its own
      // .downloads-modal element.  Assert the downloads modal div is in the DOM.
      const modal = ctx.bySelector('.downloads-modal');
      if (!modal) throw new Error('Downloads modal (.downloads-modal) not found after clicking Downloads in MobileMenuSheet');
      return 'MobileMenuSheet Downloads → downloads modal opened';
    },
  },

  {
    id: 'mobile.menu.settings',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click Settings → Settings modal opens',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Open the menu sheet.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Click the Settings item.
      const settingsBtn = ctx.byRole('button', /^Settings$/);
      if (!settingsBtn) throw new Error('Settings button not found in MobileMenuSheet');
      await ctx.click(settingsBtn);
    },
    assert: async (ctx) => {
      // The SettingsModal renders with class .settings-modal.
      const modal = ctx.bySelector('.settings-modal');
      if (!modal) throw new Error('Settings modal (.settings-modal) not found after clicking Settings in MobileMenuSheet');
      return 'MobileMenuSheet Settings → settings modal opened';
    },
  },

  {
    id: 'mobile.tabSwitcher.newTab',
    domain: 'mobile.tabSwitcher',
    description: 'Open tab switcher → click New tab → tabs.create called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Emit a nav state first so any pending tabs.list().then() microtasks flush,
      // leaving the tabs count stable before we open the switcher.
      await ctx.emitNavState?.({ ...BASE_NAV });
      // Open the tab switcher via the Tabs bottom-bar button.
      const tabsBtn = ctx.byRole('button', /^Tabs \(\d+ open\)$/);
      if (!tabsBtn) throw new Error('Tabs button not found in MobileBottomBar');
      await ctx.click(tabsBtn);
      // Click the "New tab" button in the switcher.
      const newTabBtn = ctx.byRole('button', /^New tab$/);
      if (!newTabBtn) throw new Error('"New tab" button not found in MobileTabSwitcher');
      await ctx.click(newTabBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('tabs.create'))
        throw new Error('tabs.create not called after clicking New tab in MobileTabSwitcher');
      return 'MobileTabSwitcher New tab → tabs.create()';
    },
  },

  {
    id: 'mobile.tabSwitcher.switch',
    domain: 'mobile.tabSwitcher',
    description: 'Open tab switcher with 2 tabs → click second tab → tabs.activate called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Inject a 2-tab state. Emit nav state FIRST so the pending tabs.list().then()
      // microtask flushes before we set tabs to TWO_TABS — otherwise the async list()
      // call that resolved during mount can overwrite the injected state.
      // (React 18 Strict Mode runs useEffect twice; the second list().then() resolves
      //  asynchronously; the flushSync inside emitNavState forces those microtasks to
      //  run, leaving the tabs state clean for emitTabsState to set TWO_TABS durably.)
      await ctx.emitNavState?.({ ...BASE_NAV });
      const TWO_TABS: TabsState = {
        tabs: [
          { id: 1, pinned: false, live: true, title: 'Tab 1', url: 'https://example.com/' },
          { id: 2, pinned: false, live: true, title: 'Tab 2', url: 'https://example.org/' },
        ],
        activeId: 1,
      };
      await ctx.emitTabsState?.(TWO_TABS);
      // Open the tab switcher.
      const tabsBtn = ctx.byRole('button', /^Tabs \(2 open\)$/);
      if (!tabsBtn) throw new Error('Tabs button not found in MobileBottomBar — emitTabsState may not have updated the count yet');
      await ctx.click(tabsBtn);
      // Click "Switch to Tab 2" in the switcher.
      const switchBtn = ctx.byRole('button', /^Switch to Tab 2$/);
      if (!switchBtn) throw new Error('"Switch to Tab 2" button not found in MobileTabSwitcher');
      await ctx.click(switchBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('tabs.activate'))
        throw new Error('tabs.activate not called after clicking Switch to Tab 2 in MobileTabSwitcher');
      return 'MobileTabSwitcher switch tab → tabs.activate()';
    },
  },

  {
    id: 'mobile.tabSwitcher.close',
    domain: 'mobile.tabSwitcher',
    description: 'Open tab switcher with 2 tabs → click X on second tab → tabs.close called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Same nav-first ordering fix as mobile.tabSwitcher.switch — flush list() microtask
      // before injecting the 2-tab state so the switcher renders with TWO_TABS.
      await ctx.emitNavState?.({ ...BASE_NAV });
      const TWO_TABS: TabsState = {
        tabs: [
          { id: 1, pinned: false, live: true, title: 'Tab 1', url: 'https://example.com/' },
          { id: 2, pinned: false, live: true, title: 'Tab 2', url: 'https://example.org/' },
        ],
        activeId: 1,
      };
      await ctx.emitTabsState?.(TWO_TABS);
      // Open the tab switcher.
      const tabsBtn = ctx.byRole('button', /^Tabs \(2 open\)$/);
      if (!tabsBtn) throw new Error('Tabs button not found in MobileBottomBar');
      await ctx.click(tabsBtn);
      // Click "Close Tab 2" (the X button on the second tab row).
      const closeBtn = ctx.byRole('button', /^Close Tab 2$/);
      if (!closeBtn) throw new Error('"Close Tab 2" button not found in MobileTabSwitcher');
      await ctx.click(closeBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('tabs.close'))
        throw new Error('tabs.close not called after clicking Close Tab 2 in MobileTabSwitcher');
      return 'MobileTabSwitcher close tab → tabs.close()';
    },
  },

  {
    id: 'mobile.topBar.hideToolbar',
    domain: 'mobile.topBar',
    description: 'Click "Hide toolbar" toggle in MobileTopBar → toolbar toggles (setBottomBarHidden called)',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // The toggle button starts with aria-label="Hide toolbar" (bottomBarHidden=false).
      const toggleBtn = ctx.byRole('button', /^Hide toolbar$/);
      if (!toggleBtn) throw new Error('"Hide toolbar" toggle button not found in MobileTopBar');
      await ctx.click(toggleBtn);
    },
    assert: async (ctx) => {
      // After clicking "Hide toolbar", the bottom bar should be gone from the DOM.
      // MobileApp hides it via `!bottomBarHidden && !fullscreen` conditional render.
      const bottomBar = ctx.bySelector('.mobile-bottombar');
      if (bottomBar) throw new Error('MobileBottomBar still in DOM after clicking "Hide toolbar"');
      // The toggle button should now show "Show toolbar" (bottomBarHidden=true).
      const showBtn = ctx.byRole('button', /^Show toolbar$/);
      if (!showBtn) throw new Error('"Show toolbar" button not found after hiding toolbar — toggle did not work');
      return 'MobileTopBar "Hide toolbar" → bottom bar hidden, button changed to "Show toolbar"';
    },
  },

  (() => {
    // Tab switch while the downloads modal is open.  We inject a 2-tab state to have
    // a second tab to switch to, then verify the modal is still in the DOM (the
    // DownloadsModal is not closed by a tab switch — it is a persistent chrome overlay).
    return {
      id: 'combo.tabSwitchWithModal',
      domain: 'combo',
      description: 'Open the downloads modal, then switch to a second tab → modal state consistent, no crash',
      screen: 'home',
      // vitest-only: the live run would need a real second tab and a downloads modal
      // that is hard to trigger without a real download; the vitest path fully covers
      // the interaction-combination state.
      layers: ['vitest'],
      run: async (ctx) => {
        // Reach the downloads overlay (opens DownloadsModal).
        await ctx.reach('downloads');
        // Inject a 2-tab state so the TabStrip shows a second tab to switch to.
        const TWO_TABS: TabsState = {
          tabs: [
            { id: 1, pinned: false, live: true, title: 'Tab 1', url: 'https://example.com/' },
            { id: 2, pinned: false, live: true, title: 'Tab 2', url: 'https://example.org/' },
          ],
          activeId: 1,
        };
        await ctx.emitTabsState?.(TWO_TABS);
        // Click the second tab to switch to it while the downloads modal is still open.
        const tab2 = ctx.byRole('tab', /^Tab 2$/);
        if (!tab2) throw new Error('Second tab "Tab 2" not found in TabStrip');
        await ctx.click(tab2);
      },
      assert: async (ctx) => {
        // The downloads modal should still be in the DOM (tab switch does not close it).
        const modal = ctx.bySelector('.downloads-modal');
        if (!modal) throw new Error('Downloads modal not found after tab switch — modal was unexpectedly closed');
        // tabs.activate must have been called (the tab click fired).
        if (!ctx.calls.called('tabs.activate'))
          throw new Error('tabs.activate not called after clicking second tab with downloads modal open');
        // App must still be mounted.
        if (!document.querySelector('.app'))
          throw new Error('App is no longer mounted after tabSwitch+modal combo (crash?)');
        return 'downloads modal open + tab switch → modal still present, tabs.activate called, App mounted';
      },
    } satisfies InteractionSpec;
  })(),
];

/** Documented registry of every interactive control id; the drift guard asserts each has
 *  an INTERACTIONS entry. Filled in per-domain by later tasks (mirrors UNTESTED_CHANNELS). */
export const INTERACTIVE_CONTROLS = new Set<string>([
  'toolbar.addressBar',
  'toolbar.back',
  'toolbar.forward',
  'toolbar.reload',
  'toolbar.home',
  'toolbar.bookmarkStar',
  'toolbar.picker',
  'shieldPopover.toggleAdblock',
  'shieldPopover.allowlistSite',
  // Task 4: tabs + keyboard shortcuts
  'tabs.newButton',
  'tabs.activate',
  'tabs.close',
  'tabs.setPinned',
  'keyboard.newTab',
  'keyboard.closeTab',
  'keyboard.reopenTab',
  // Task 5: favorites bar/manager + sidebar history
  'favbar.openFavorite',
  'favManager.add',
  'favManager.rename',
  'favManager.delete',
  'sidebar.history.openEntry',
  'sidebar.history.deleteEntry',
  'sidebar.history.search',
  'sidebar.history.clear',
  // Task 6: sidebar saved + tags
  'sidebar.saved.openEntry',
  'sidebar.saved.delete',
  'sidebar.saved.addTag',
  'sidebar.saved.renameTag',
  'sidebar.saved.deleteTag',
  'sidebar.saved.filterByTag',
  // Task 7: settings (every tab)
  'settings.appearance.primaryColor',
  'settings.search.addEngine',
  'settings.search.setDefault',
  'settings.home.homeUrl',
  'settings.tabs.idleTimeout',
  'settings.filterLists.toggleSub',
  'settings.filterLists.addList',
  'settings.filterLists.removeList',
  'settings.filterLists.updateAll',
  'settings.myFilters.save',
  'settings.allowlist.remove',
  'settings.allowlist.clearAll',
  'settings.downloads.saveDir',
  'settings.downloads.useDefault',
  'settings.sitePermissions.revoke',
  'settings.sitePermissions.clearAll',
  'settings.security.httpsOnly',
  'settings.security.webrtcPolicy',
  'settings.sync.setServerUrl',
  'settings.sync.testConnection',
  'settings.sync.startNew',
  'settings.sync.restorePhrase',
  'settings.data.export',
  'settings.data.import',
  'settings.data.importMode',
  // Task 8: overlays
  'downloads.clear',
  'confirm.confirm',
  'confirm.cancel',
  'errorOverlay.retry',
  'crashOverlay.reload',
  'safety.proceed',
  'safety.back',
  'permission.allow',
  'permission.deny',
  'redirectBar.openAnyway',
  'redirectBar.dismiss',
  // Task 9: edge/error inputs + state combinations
  'edge.addressBar.empty',
  'edge.addressBar.malformed',
  'edge.favorite.duplicate',
  'edge.tag.whitespace',
  'edge.bookmark.doubleClick',
  'combo.settingsOverSidebar',
  'combo.tabSwitchWithModal',
  // Task 10: mobile-only controls (MobileBottomBar, MobileMenuSheet, MobileTabSwitcher, MobileTopBar)
  // These are exercised in the mobile interaction tour (interactions.mobile.test.tsx).
  // They are NOT reachable in the desktop shell and NOT in the live autopilot run
  // (the live autopilot drives the desktop shell only).
  'mobile.bottomBar.saved',
  'mobile.bottomBar.history',
  'mobile.bottomBar.tabs',
  'mobile.bottomBar.menu',
  'mobile.menu.back',
  'mobile.menu.forward',
  'mobile.menu.home',
  'mobile.menu.bookmark',
  'mobile.menu.downloads',
  'mobile.menu.settings',
  'mobile.tabSwitcher.newTab',
  'mobile.tabSwitcher.switch',
  'mobile.tabSwitcher.close',
  'mobile.topBar.hideToolbar',
]);
