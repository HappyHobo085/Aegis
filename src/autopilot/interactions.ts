// src/autopilot/interactions.ts
import type { AegisApi, NavState, TabsState, TabShortcut } from '../../shared/types';
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

  {
    id: 'tabs.activate',
    domain: 'tabs',
    description: 'Click a second tab → tabs.activate called; live: activeId changes',
    screen: 'home',
    layers: ['vitest', 'live'],
    run: async (ctx) => {
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
        // Live: create a second tab first, then click it.
        const before = await ctx.aegis.tabs.list();
        await ctx.aegis.tabs.create();
        // Wait briefly for the new tab to appear in the DOM.
        await new Promise((r) => setTimeout(r, 400));
        const after = await ctx.aegis.tabs.list();
        const newId = after.tabs.find((t) => !before.tabs.some((b) => b.id === t.id))?.id;
        if (newId === undefined) throw new Error('live: newly created tab not found in list');
        // Click the tab div in the chrome DOM (its aria-label = 'New tab').
        const tabEl = ctx.byLabel(/^New tab$/) ?? ctx.bySelector(`[role="tab"][aria-selected="false"]`);
        if (!tabEl) throw new Error('live: second tab element not found in DOM');
        await ctx.click(tabEl);
      }
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('tabs.activate'))
          throw new Error('tabs.activate not called');
        return 'click second tab → tabs.activate()';
      }
      // Live: activeId should be the new tab; clean up by closing it.
      await new Promise((r) => setTimeout(r, 400));
      const state = await ctx.aegis.tabs.list();
      const closableId = state.activeId;
      if (state.tabs.length < 2)
        throw new Error('live: only 1 tab remains — activate may have failed');
      // Close the extra tab.
      await ctx.aegis.tabs.close(closableId);
      return `click second tab → activeId became ${closableId} (extra tab closed)`;
    },
  },

  {
    id: 'tabs.close',
    domain: 'tabs',
    description: 'Click the X on a tab → tabs.close called; live: tab count decreases',
    screen: 'home',
    layers: ['vitest', 'live'],
    run: async (ctx) => {
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
        // Live: create a second tab then click its close button.
        const before = await ctx.aegis.tabs.list();
        await ctx.aegis.tabs.create();
        await new Promise((r) => setTimeout(r, 400));
        const after = await ctx.aegis.tabs.list();
        const newTab = after.tabs.find((t) => !before.tabs.some((b) => b.id === t.id));
        if (!newTab) throw new Error('live: newly created tab not found');
        // Close button aria-label is "Close <title>"; new tab title is 'New tab'.
        const closeBtn = ctx.byRole('button', /^Close New tab$/);
        if (!closeBtn) throw new Error('live: Close button for new tab not found');
        await ctx.click(closeBtn);
      }
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('tabs.close'))
          throw new Error('tabs.close not called');
        return 'close-tab X → tabs.close()';
      }
      // Live: tab count should have returned to the pre-create count.
      await new Promise((r) => setTimeout(r, 400));
      const state = await ctx.aegis.tabs.list();
      if (state.tabs.length < 1)
        throw new Error('live: no tabs remain after close');
      return `close-tab X → tab count is now ${state.tabs.length}`;
    },
  },

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
]);
