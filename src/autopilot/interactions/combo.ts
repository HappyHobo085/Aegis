// src/autopilot/interactions/combo.ts
import type { InteractionSpec } from './types';
import type { TabsState } from '../../../shared/types';

export const COMBO_INTERACTIONS: InteractionSpec[] = [
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
        throw new Error(
          'view.setLayout not called — overlay/sidebar state was not reported to the core',
        );
      return 'sidebar + Settings open together → modal present, view.setLayout called, App mounted';
    },
  },

  (() => {
    // Tab switch while the downloads modal is open.  We inject a 2-tab state to have
    // a second tab to switch to, then verify the modal is still in the DOM (the
    // DownloadsModal is not closed by a tab switch — it is a persistent chrome overlay).
    return {
      id: 'combo.tabSwitchWithModal',
      domain: 'combo',
      description:
        'Open the downloads modal, then switch to a second tab → modal state consistent, no crash',
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
            {
              id: 1,
              pinned: false,
              live: true,
              title: 'Tab 1',
              url: 'https://example.com/',
              private: false,
            },
            {
              id: 2,
              pinned: false,
              live: true,
              title: 'Tab 2',
              url: 'https://example.org/',
              private: false,
            },
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
        if (!modal)
          throw new Error(
            'Downloads modal not found after tab switch — modal was unexpectedly closed',
          );
        // tabs.activate must have been called (the tab click fired).
        if (!ctx.calls.called('tabs.activate'))
          throw new Error(
            'tabs.activate not called after clicking second tab with downloads modal open',
          );
        // App must still be mounted.
        if (!document.querySelector('.app'))
          throw new Error('App is no longer mounted after tabSwitch+modal combo (crash?)');
        return 'downloads modal open + tab switch → modal still present, tabs.activate called, App mounted';
      },
    } satisfies InteractionSpec;
  })(),
];
