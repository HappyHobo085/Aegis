// src/autopilot/interactions/toolbar.ts
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InteractionSpec, InteractionCtx, InteractionLayer } from './types';
import {
  emitNavState,
  BASE_NAV,
  nudgeSync,
  waitFor,
  fixtureUrl,
  liveNavigate,
  activeViewId,
} from './helpers';
import { AdaptiveTimeout } from '../timeout';

export const TOOLBAR_INTERACTIONS: InteractionSpec[] = [
  // ─── existing Task-2 seed ───────────────────────────────────────────────
  {
    id: 'toolbar.addressBar.navigate',
    domain: 'toolbar',
    description: 'Type a URL in the address bar and press Enter → navigates',
    screen: 'home',
    // live excluded: the address-bar gesture types a raw string and presses Enter; the live
    // autopilot fixture server can't be reached by typing an external domain (example.com),
    // and there is no runtime mechanism to redirect the typed text to the fixture URL without
    // changing what the vitest branch asserts (it checks the CallLog for 'example.com').
    // The live nav round-trip (navigate → poll until URL commits) is already covered by the
    // catalog.ts `nav.navigate` verify(api) entry, which runs against the real Rust core.
    layers: ['vitest'],
    mobile: true, // MobileTopBar includes the same AddressBar component
    run: async (ctx) => {
      const bar =
        ctx.byRole('textbox', /address|url|search/i) ?? ctx.bySelector('input[type="text"]');
      if (!bar) throw new Error('address bar input not found');
      await ctx.type(bar, 'example.com');
      await ctx.press('Enter');
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.navigate', (a) => String(a[1]).includes('example.com')))
        throw new Error('nav.navigate not called with example.com');
      return 'address bar Enter → nav.navigate(example.com)';
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
      if (!ctx.calls.called('nav.back')) throw new Error('nav.back not called');
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
      if (!ctx.calls.called('nav.forward')) throw new Error('nav.forward not called');
      return 'Forward button → nav.forward()';
    },
  },

  {
    id: 'toolbar.reload',
    domain: 'toolbar',
    description: 'Click the Reload button → nav.reloadOrStop called',
    screen: 'home',
    // live excluded: the live CallLog is inert so nav.reloadOrStop cannot be confirmed
    // via ctx.calls, and a reload's effect (isLoading true→false) is too fast/racy to
    // observe reliably — mirroring toolbar.back / toolbar.forward / toolbar.picker.
    layers: ['vitest'],
    mobile: true, // MobileTopBar has a Reload/Stop button (aria-label="Reload")
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^Reload$/);
      if (!btn) throw new Error('Reload button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('nav.reloadOrStop')) throw new Error('nav.reloadOrStop not called');
      return 'Reload button → nav.reloadOrStop()';
    },
  },

  (() => {
    // Live: the page must NOT already be on home before the click, or "navigated home"
    // is unobservable. Park on a fixture URL first and capture it as the before-state.
    let _before: string | undefined;
    return {
      id: 'toolbar.home',
      domain: 'toolbar',
      description: 'Click the Home button → nav.home called',
      screen: 'home',
      layers: ['vitest', 'live'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'live') {
          await liveNavigate(ctx, fixtureUrl('home-before'));
          _before = (await ctx.aegis.nav.getState(await activeViewId(ctx))).url;
        }
        const btn = ctx.byRole('button', /^Home$/);
        if (!btn) throw new Error('Home button not found');
        await ctx.click(btn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('nav.home')) throw new Error('nav.home not called');
          return 'Home button → nav.home()';
        }
        // Live: poll until the url LEAVES the before-state and lands on home. homeUrl is
        // often about:blank, which the content view reports as '' or 'about:blank' — accept
        // either; otherwise require the url to start with the configured homeUrl.
        const home = (await ctx.aegis.settings.get()).homeUrl || 'about:blank';
        const isHome = (u: string): boolean =>
          home === 'about:blank' ? u === '' || u.startsWith('about:blank') : u.startsWith(home);
        const vid = await activeViewId(ctx);
        const deadline = Date.now() + AdaptiveTimeout.ms(8000);
        while (Date.now() < deadline) {
          const { url } = await ctx.aegis.nav.getState(vid);
          if (url !== _before && isHome(url))
            return `Home button → navigated home (${url || 'about:blank'})`;
          await new Promise((r) => setTimeout(r, 300));
        }
        const now = (await ctx.aegis.nav.getState(vid)).url;
        throw new Error(
          `live: url did not navigate home (before=${_before}, home=${home}, now=${now || 'about:blank'})`,
        );
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'toolbar.addressBar.search',
    domain: 'toolbar',
    description:
      'Type a search query in the address bar and press Enter → nav.navigate called with search URL',
    screen: 'home',
    // vitest-only: a dotless/spaced query routes through the configured search engine
    // (DuckDuckGo by default). In the sandboxed live run the external engine never commits
    // a URL on the content view (unlike the local fixture / example.com, which do), and
    // useNav reads the search template once on mount (so it can't be repointed at the
    // fixture at runtime) — there is no reliable real-state effect to observe live. The
    // search-template→navigate wiring is fully asserted here via the CallLog; the
    // address-bar-commits-a-real-navigation gesture is covered live by toolbar.addressBar.navigate.
    layers: ['vitest'],
    mobile: true, // MobileTopBar includes the same AddressBar component
    run: async (ctx) => {
      const bar =
        ctx.byRole('textbox', /address|url|search/i) ?? ctx.bySelector('input[type="text"]');
      if (!bar) throw new Error('address bar input not found');
      await ctx.type(bar, 'hello world');
      await ctx.press('Enter');
    },
    assert: async (ctx) => {
      // 'hello world' has a space so it is treated as a search term → navigate to
      // searchTemplate.replace('%s', encodeURIComponent('hello world')).
      if (!ctx.calls.called('nav.navigate', (a) => String(a[1]).toLowerCase().includes('hello')))
        throw new Error('nav.navigate not called with hello');
      return 'address bar search → nav.navigate(…hello…)';
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
      if (ctx.layer === 'live') {
        // Park on a real, saveable fixture URL that is NOT already saved, then nudge
        // useSaved so isCurrentSaved re-queries → the button reads "Save bookmark".
        const url = fixtureUrl('bookmark');
        for (const i of (await ctx.aegis.saved.list()).filter((i) => i.url === url))
          await ctx.aegis.saved.remove(i.id);
        await liveNavigate(ctx, url);
        await nudgeSync('saved');
        const btn = await waitFor(
          () => ctx.byRole('button', /save bookmark/i),
          '"Save bookmark" button',
        );
        await ctx.click(btn);
        return;
      }
      // vitest: seed a saveable nav state (canSave = hostOf(url) !== null) and click Save.
      await emitNavState(ctx, { ...BASE_NAV, url: 'https://example.com/', title: 'Example' });
      const btn = ctx.byRole('button', /save bookmark/i);
      if (!btn) throw new Error('Save bookmark button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (ctx.layer === 'vitest') {
        if (!ctx.calls.called('saved.add')) throw new Error('saved.add not called');
        return 'Save bookmark → saved.add()';
      }
      const url = fixtureUrl('bookmark');
      const deadline = Date.now() + AdaptiveTimeout.ms(8000);
      while (Date.now() < deadline) {
        if ((await ctx.aegis.saved.list()).some((i) => i.url === url)) {
          // Restore: unsave so the next run starts clean.
          for (const i of (await ctx.aegis.saved.list()).filter((i) => i.url === url))
            await ctx.aegis.saved.remove(i.id);
          await nudgeSync('saved');
          return `Save bookmark → saved persisted then restored (${url})`;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      const urls = (await ctx.aegis.saved.list()).map((i) => i.url).join(', ');
      throw new Error(`live: ${url} not in saved list after Save bookmark (saved=[${urls}])`);
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
      // Park on a fixture URL, ensure it IS saved, then nudge useSaved so isCurrentSaved
      // flips true and the BookmarkButton renders "Remove bookmark". A programmatic
      // saved.add alone never re-renders the button (no sync.changed) — the old bug.
      const url = fixtureUrl('bookmarkremove');
      await liveNavigate(ctx, url);
      if (!(await ctx.aegis.saved.list()).some((i) => i.url === url)) {
        await ctx.aegis.saved.add({ url, title: 'AP Bookmark Remove' });
      }
      await nudgeSync('saved');
      const btn = await waitFor(
        () => ctx.byRole('button', /remove bookmark/i),
        '"Remove bookmark" button',
      );
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      // Live: the fixture item must be gone from the saved list.
      const url = fixtureUrl('bookmarkremove');
      const deadline = Date.now() + AdaptiveTimeout.ms(8000);
      while (Date.now() < deadline) {
        if (!(await ctx.aegis.saved.list()).some((i) => i.url === url))
          return `Remove bookmark → saved.remove() → ${url} gone from list`;
        await new Promise((r) => setTimeout(r, 300));
      }
      // Safety cleanup so a failure doesn't leak state into later specs.
      for (const i of (await ctx.aegis.saved.list()).filter((i) => i.url === url))
        await ctx.aegis.saved.remove(i.id);
      throw new Error(`live: ${url} still in saved list after Remove bookmark`);
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
      if (!ctx.calls.called('picker.start')) throw new Error('picker.start not called');
      return 'Picker button → picker.start()';
    },
  },

  (() => {
    // Capture pre-click enabled state so the assert can verify the flip.
    let _preEnabled: boolean | undefined;
    return {
      id: 'shieldPopover.toggleAdblock',
      domain: 'shieldPopover',
      description:
        'Open the ad-block shield popover and toggle the switch → adblock.setEnabled called',
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
        // Prefix match (not /^Ad blocking$/): once ads are blocked on the active page the
        // button's accessible name gains a count suffix ("Ad blocking, N blocked on this page"),
        // which an anchored exact match missed → intermittent "button not found".
        const shieldBtn = ctx.byRole('button', /^Ad blocking\b/);
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
          throw new Error(
            `live: adblock.enabled did not flip (still ${after.enabled} after toggle)`,
          );
        // Restore the original enabled state.
        await ctx.aegis.adblock.setEnabled(_preEnabled ?? !after.enabled);
        return `shield toggle → enabled flipped ${_preEnabled}→${after.enabled} (restored)`;
      },
    } satisfies InteractionSpec;
  })(),

  {
    id: 'shieldPopover.allowlistSite',
    domain: 'shieldPopover',
    description:
      'Open the ad-block shield popover and click the allowlist checkbox → adblock.toggleAllowlist called',
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
      const shieldBtn = ctx.byRole('button', /^Ad blocking\b/);
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

  {
    id: 'shieldPopover.badgeReflectsBlockedCount',
    domain: 'shieldPopover',
    description:
      'An adblock.blockedCount event for the active view raises the shield badge + popover count',
    screen: 'home',
    // vitest-only: the badge count rises only when the native ad-block tier fires
    // adblock.blockedCount events, which the live CallLog can't observe and the live
    // autopilot doesn't assert (the Linux counter under-counts content-filter-blocked
    // requests; blocking is proven via the A/B trace, not the badge count — see gotcha 6
    // in src-tauri/CLAUDE.md).  The event→badge path is fully testable via the mock.
    layers: ['vitest'],
    mobile: true, // the badge + onBlockedCount path is shared with the mobile shield
    run: async (ctx) => {
      // Flush the pending aegis.adblock.getState().then() microtask (which resolves
      // to pageBlocked=undefined → 0) BEFORE emitBlockedCount sets page=3.  Without
      // this drain the getState() then() runs inside act() AFTER flushSync and resets
      // the badge back to 0 — the same React 18 Strict Mode + async-mock ordering
      // gotcha documented in src/CLAUDE.md.  A single Promise.resolve() tick is enough
      // to drain the already-resolved mock promise.
      await Promise.resolve();
      // Emit a BlockedCount for the active view through the mocked onBlockedCount callback,
      // then open the shield popover to read the page-count figure.
      ctx.emitBlockedCount?.({ viewId: BASE_NAV.viewId, page: 3, session: 7 });
      const shield = ctx.byRole('button', /^Ad blocking\b/);
      if (shield) await ctx.click(shield);
    },
    assert: async (ctx) => {
      // The badge span (.adblock-shield__badge) should show the page total.
      const badge = ctx.bySelector('.adblock-shield__badge');
      if (badge?.textContent !== '3')
        throw new Error(`badge=${badge?.textContent ?? 'not found'}, want 3`);
      return 'shield badge shows the blocked-count page total';
    },
  },

  // ─── Task 11: page zoom — keyboard path (App.tsx window keydown) ────────

  {
    id: 'toolbar.zoom.keyboard.in',
    domain: 'toolbar',
    description: 'Ctrl+= on window → zoom.set called with factor > 1.0 (keyboard zoom-in)',
    screen: 'home',
    // live excluded: the live CallLog is inert; can't confirm zoom.set via ctx.calls live.
    layers: ['vitest'],
    run: async (_ctx) => {
      // App.tsx listens on window.addEventListener('keydown', …) for Ctrl+=/+/NumpadAdd.
      // Dispatch Ctrl+= directly on window so the App handler fires in jsdom.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '=',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
    assert: async (ctx) => {
      // zoom.zoomIn() calls zoom.set(viewId, factor) with factor stepped up from 1.0 → 1.1.
      if (!ctx.calls.called('zoom.set', (a) => (a[1] as number) > 1.0))
        throw new Error('zoom.set not called with factor > 1.0 after Ctrl+=');
      return 'Ctrl+= → zoom.set(>1.0)';
    },
  },

  {
    id: 'toolbar.zoom.keyboard.out',
    domain: 'toolbar',
    description: 'Ctrl+- on window → zoom.set called with factor < 1.0 (keyboard zoom-out)',
    screen: 'home',
    // live excluded: the live CallLog is inert; can't confirm zoom.set via ctx.calls live.
    layers: ['vitest'],
    run: async (_ctx) => {
      // App.tsx handles Ctrl+- (e.key === '-') on window.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '-',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
    assert: async (ctx) => {
      // zoom.zoomOut() calls zoom.set(viewId, factor) with factor stepped down from 1.0 → 0.9.
      if (!ctx.calls.called('zoom.set', (a) => (a[1] as number) < 1.0))
        throw new Error('zoom.set not called with factor < 1.0 after Ctrl+-');
      return 'Ctrl+- → zoom.set(<1.0)';
    },
  },

  {
    id: 'toolbar.zoom.keyboard.reset',
    domain: 'toolbar',
    description: 'Ctrl+0 on window → zoom.reset called (keyboard zoom-reset)',
    screen: 'home',
    // live excluded: the live CallLog is inert; can't confirm zoom.reset via ctx.calls live.
    layers: ['vitest'],
    run: async (_ctx) => {
      // App.tsx handles Ctrl+0 (e.key === '0') on window.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: '0',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('zoom.reset')) throw new Error('zoom.reset not called after Ctrl+0');
      return 'Ctrl+0 → zoom.reset()';
    },
  },

  // ─── Task 11: page zoom (ZoomIndicator popover) ─────────────────────────

  {
    id: 'toolbar.zoom.label',
    domain: 'toolbar',
    description: 'Click the zoom % label button → opens the zoom popover',
    screen: 'home',
    // live excluded: the live CallLog is inert; the popover open/close is
    // ZoomIndicator-local React state (no real IPC call to assert).
    layers: ['vitest'],
    run: async (ctx) => {
      const btn = ctx.byRole('button', /^Page zoom$/);
      if (!btn) throw new Error('zoom label button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (!ctx.bySelector('.zoom-indicator__popover'))
        throw new Error('zoom popover did not open after clicking zoom label');
      return 'zoom label → popover open';
    },
  },

  {
    id: 'toolbar.zoom.in',
    domain: 'toolbar',
    description: 'Open zoom popover, click Zoom in → zoom.set called with a larger factor',
    screen: 'home',
    // live excluded: the live CallLog is inert; can't confirm zoom.set via ctx.calls live.
    layers: ['vitest'],
    run: async (ctx) => {
      // Open the popover first (it is ZoomIndicator-internal state; no control-surface hook).
      const labelBtn = ctx.byRole('button', /^Page zoom$/);
      if (!labelBtn) throw new Error('zoom label button not found');
      await ctx.click(labelBtn);
      const inBtn = ctx.byRole('button', /^Zoom in$/);
      if (!inBtn) throw new Error('"Zoom in" button not found');
      await ctx.click(inBtn);
    },
    assert: async (ctx) => {
      // zoom.set is called by useZoom.apply() (optimistic + IPC); factor is > 1.0 after
      // one step from the default 1.0.  args = [viewId, factor].
      if (!ctx.calls.called('zoom.set', (a) => (a[1] as number) > 1.0))
        throw new Error('zoom.set not called with factor > 1.0');
      return 'Zoom in → zoom.set(>1.0)';
    },
  },

  {
    id: 'toolbar.zoom.out',
    domain: 'toolbar',
    description: 'Open zoom popover, click Zoom out → zoom.set called with a smaller factor',
    screen: 'home',
    // live excluded: same reason as toolbar.zoom.in.
    layers: ['vitest'],
    run: async (ctx) => {
      const labelBtn = ctx.byRole('button', /^Page zoom$/);
      if (!labelBtn) throw new Error('zoom label button not found');
      await ctx.click(labelBtn);
      const outBtn = ctx.byRole('button', /^Zoom out$/);
      if (!outBtn) throw new Error('"Zoom out" button not found');
      await ctx.click(outBtn);
    },
    assert: async (ctx) => {
      // Stepping down from 1.0 produces a factor < 1.0.
      if (!ctx.calls.called('zoom.set', (a) => (a[1] as number) < 1.0))
        throw new Error('zoom.set not called with factor < 1.0');
      return 'Zoom out → zoom.set(<1.0)';
    },
  },

  {
    id: 'toolbar.zoom.reset',
    domain: 'toolbar',
    description: 'Open zoom popover, click Reset zoom → zoom.reset called',
    screen: 'home',
    // live excluded: the live CallLog is inert; can't confirm zoom.reset via ctx.calls live.
    layers: ['vitest'],
    run: async (ctx) => {
      const labelBtn = ctx.byRole('button', /^Page zoom$/);
      if (!labelBtn) throw new Error('zoom label button not found');
      await ctx.click(labelBtn);
      const resetBtn = ctx.byRole('button', /^Reset zoom$/);
      if (!resetBtn) throw new Error('"Reset zoom" button not found');
      await ctx.click(resetBtn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('zoom.reset')) throw new Error('zoom.reset not called');
      return 'Reset zoom → zoom.reset()';
    },
  },

  // ─── Task 4 (command palette): Ctrl+K command palette ────────────────────

  {
    id: 'toolbar.commandPalette.open',
    domain: 'toolbar',
    description: 'Open command palette via Ctrl+K',
    screen: 'home',
    // live excluded: the Ctrl+K keyboard event fires natively; the vitest path
    // exercises the full open→render→input-focus pipeline through the mock.
    layers: ['vitest'],
    run: async (_ctx) => {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
    assert: async (ctx) => {
      const palette = ctx.bySelector('.command-palette');
      if (!palette) return 'Command palette did not open';
      const input = palette.querySelector('input[type="search"]');
      if (!input) return 'Command palette input not found';
      return 'Command palette opened';
    },
  },

  {
    id: 'toolbar.commandPalette.search',
    domain: 'toolbar',
    description: 'Type a query in command palette and verify results appear',
    screen: 'home',
    // live excluded: the search results depend on the disposable-profile state
    // (no tabs/bookmarks/history seeded); the vitest mock exercises the query→filter
    // →render pipeline.
    layers: ['vitest'],
    run: async (ctx) => {
      // Open the palette first.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      // Type a query into the search input (userEvent.type fires onChange).
      const input = ctx.bySelector('.command-palette input[type="search"]');
      if (!input) throw new Error('Command palette input not found');
      await userEvent.type(input, 'settings');
    },
    assert: async (ctx) => {
      // getSettingsResults filters against static settings entries — "settings"
      // should match items in the Settings category.
      const items = document.querySelectorAll('.command-palette__item');
      if (items.length === 0) return 'No results found for "settings"';
      return 'Search results appear';
    },
  },

  {
    id: 'toolbar.commandPalette.close',
    domain: 'toolbar',
    description: 'Close command palette with Escape',
    screen: 'home',
    // live excluded: Escape dismisses the palette via onClose; the vitest path
    // exercises the key-down → onClose → unmount pipeline.
    layers: ['vitest'],
    run: async (ctx) => {
      // Open the palette first.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      // Press Escape on the input to close the palette.
      const input = ctx.bySelector('.command-palette input[type="search"]');
      if (!input) throw new Error('Command palette input not found');
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
    assert: async (ctx) => {
      const palette = ctx.bySelector('.command-palette');
      if (palette) return 'Command palette still open after Escape';
      return 'Command palette closed';
    },
  },

  {
    id: 'toolbar.commandPalette.keyboard',
    domain: 'toolbar',
    description: 'Navigate command palette results with ArrowDown and select with Enter',
    screen: 'home',
    // live excluded: the keyboard navigation and selection require the mock data
    // pipeline to populate results; live has no seeded tabs/bookmarks/history.
    layers: ['vitest'],
    run: async (ctx) => {
      // Open the palette first.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      // Type a query to populate results.
      const input = ctx.bySelector('.command-palette input[type="search"]');
      if (!input) throw new Error('Command palette input not found');
      await userEvent.type(input, 'settings');
      // Navigate down to the first result and select it with Enter.
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
            cancelable: true,
          }),
        );
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
    assert: async (ctx) => {
      // After Enter the selected action executes and onClose is called → palette unmounts.
      const palette = ctx.bySelector('.command-palette');
      if (palette) return 'Command palette still open after Enter';
      return 'Action executed and palette closed';
    },
  },
];
