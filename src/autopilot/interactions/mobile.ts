// src/autopilot/interactions/mobile.ts
import type { InteractionSpec } from './types';
import { BASE_NAV } from './helpers';
import type { TabsState } from '../../../shared/types';

export const MOBILE_INTERACTIONS: InteractionSpec[] = [
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
      if (!sheet)
        throw new Error('Saved sheet (dialog aria-label="Saved") not found after clicking Saved');
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
      if (!sheet)
        throw new Error(
          'History sheet (dialog aria-label="History") not found after clicking History',
        );
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
      if (!btn)
        throw new Error(
          'Tabs button not found in MobileBottomBar (expected aria-label "Tabs (N open)")',
        );
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      // The tab switcher renders a dialog with aria-label="Tabs".
      const sheet = ctx.bySelector('[role="dialog"][aria-label="Tabs"]');
      if (!sheet)
        throw new Error(
          'Tabs sheet (dialog aria-label="Tabs") not found after clicking Tabs button',
        );
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
      if (!sheet)
        throw new Error('Menu sheet (dialog aria-label="Menu") not found after clicking Menu');
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
        throw new Error(
          'saved.add not called after clicking "Bookmark this page" in MobileMenuSheet',
        );
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
      if (!modal)
        throw new Error(
          'Downloads modal (.downloads-modal) not found after clicking Downloads in MobileMenuSheet',
        );
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
      if (!modal)
        throw new Error(
          'Settings modal (.settings-modal) not found after clicking Settings in MobileMenuSheet',
        );
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
      if (!tabsBtn)
        throw new Error(
          'Tabs button not found in MobileBottomBar — emitTabsState may not have updated the count yet',
        );
      await ctx.click(tabsBtn);
      // Click "Switch to Tab 2" in the switcher.
      const switchBtn = ctx.byRole('button', /^Switch to Tab 2$/);
      if (!switchBtn) throw new Error('"Switch to Tab 2" button not found in MobileTabSwitcher');
      await ctx.click(switchBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('tabs.activate'))
        throw new Error(
          'tabs.activate not called after clicking Switch to Tab 2 in MobileTabSwitcher',
        );
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
    id: 'mobile.menu.find',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click "Find in page" → FindBar appears',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Open the menu sheet.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Click the "Find in page" item.
      const findBtn = ctx.byRole('button', /^Find in page$/);
      if (!findBtn) throw new Error('"Find in page" button not found in MobileMenuSheet');
      await ctx.click(findBtn);
    },
    assert: async (ctx) => {
      // The FindBar renders an input with aria-label="Find in page".
      const input = ctx.bySelector('input[aria-label="Find in page"]');
      if (!input)
        throw new Error(
          'FindBar input (aria-label="Find in page") not found after tapping "Find in page" in menu',
        );
      return 'MobileMenuSheet "Find in page" → FindBar visible';
    },
  },

  {
    id: 'mobile.menu.zoomIn',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click "Zoom in" → zoom.set called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Open the menu sheet.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Click the "Zoom in" button in the zoom controls row.
      const zoomInBtn = ctx.byRole('button', /^Zoom in$/);
      if (!zoomInBtn) throw new Error('"Zoom in" button not found in MobileMenuSheet');
      await ctx.click(zoomInBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('zoom.set'))
        throw new Error('zoom.set not called after clicking "Zoom in" in MobileMenuSheet');
      return 'MobileMenuSheet "Zoom in" → zoom.set()';
    },
  },

  {
    id: 'mobile.menu.zoomOut',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click "Zoom out" → zoom.set called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Open the menu sheet.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Click the "Zoom out" button in the zoom controls row.
      const zoomOutBtn = ctx.byRole('button', /^Zoom out$/);
      if (!zoomOutBtn) throw new Error('"Zoom out" button not found in MobileMenuSheet');
      await ctx.click(zoomOutBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('zoom.set'))
        throw new Error('zoom.set not called after clicking "Zoom out" in MobileMenuSheet');
      return 'MobileMenuSheet "Zoom out" → zoom.set()';
    },
  },

  {
    id: 'mobile.menu.zoomReset',
    domain: 'mobile.menu',
    description: 'Open menu sheet → click "Reset zoom" → zoom.reset called',
    screen: 'home',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      // Open the menu sheet.
      const menuBtn = ctx.byRole('button', /^Menu$/);
      if (!menuBtn) throw new Error('Menu button not found in MobileBottomBar');
      await ctx.click(menuBtn);
      // Click the "Reset zoom" button in the zoom controls row.
      const resetBtn = ctx.byRole('button', /^Reset zoom$/);
      if (!resetBtn) throw new Error('"Reset zoom" button not found in MobileMenuSheet');
      await ctx.click(resetBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('zoom.reset'))
        throw new Error('zoom.reset not called after clicking "Reset zoom" in MobileMenuSheet');
      return 'MobileMenuSheet "Reset zoom" → zoom.reset()';
    },
  },

  {
    id: 'mobile.topBar.hideToolbar',
    domain: 'mobile.topBar',
    description:
      'Click "Hide toolbar" toggle in MobileTopBar → toolbar toggles (setBottomBarHidden called)',
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
      if (!showBtn)
        throw new Error(
          '"Show toolbar" button not found after hiding toolbar — toggle did not work',
        );
      return 'MobileTopBar "Hide toolbar" → bottom bar hidden, button changed to "Show toolbar"';
    },
  },
];
