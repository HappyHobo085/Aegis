// src/autopilot/interactions/tabs.ts
import type { InteractionSpec, InteractionCtx, InteractionLayer } from './types';
import type { TabsState } from '../../../shared/types';
import { waitFor, fixtureUrl } from './helpers';

export const TABS_INTERACTIONS: InteractionSpec[] = [
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
          // Create a BACKGROUND tab so activeId stays on the original — clicking the new
          // tab is then an observable switch. (Bug: a foreground create() already activates
          // the new tab, so the old code's click on the *unselected* tab switched AWAY from
          // it → activeId went to the old tab, never the new one.)
          const before = await ctx.aegis.tabs.list();
          await ctx.aegis.tabs.create(fixtureUrl('tab-activate'), true);
          const after = await waitFor(async () => {
            const s = await ctx.aegis.tabs.list();
            return s.tabs.length > before.tabs.length ? s : null;
          }, 'second tab to appear in the list');
          const newTab = after.tabs.find((t) => !before.tabs.some((b) => b.id === t.id));
          if (!newTab) throw new Error('live: newly created tab not found in list');
          _newTabId = newTab.id;
          // The new tab renders LAST in the strip; click that tab element to activate it.
          const tabEl = await waitFor(() => {
            const tabs = Array.from(document.querySelectorAll('[role="tab"]')) as HTMLElement[];
            return tabs.length > before.tabs.length ? tabs[tabs.length - 1] : null;
          }, 'newest tab element in the strip');
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
];
