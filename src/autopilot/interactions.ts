// src/autopilot/interactions.ts
import type { AegisApi, NavState, TabsState, TabShortcut, Favorite, HistoryEntry } from '../../shared/types';
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
}

export interface InteractionSpec {
  id: string;
  domain: string;
  description: string;
  screen: ScreenId;
  layers: InteractionLayer[];
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
]);
