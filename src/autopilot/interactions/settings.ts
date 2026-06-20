// src/autopilot/interactions/settings.ts
import type { InteractionSpec, InteractionCtx, InteractionLayer } from './types';
import { fireInputChange, nudgeSync, waitFor } from './helpers';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import type { Settings as AegisSettings } from '../../../shared/types';

export const SETTINGS_INTERACTIONS: InteractionSpec[] = [
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
          // Live: add the probe host directly. toggleAllowlist takes a BARE host and adds
          // it when absent — the old code passed a full URL, which stores the wrong string
          // so the host never matches. Then nudge useAdblock to re-fetch the tab.
          const st = await ctx.aegis.adblock.getState();
          if (!st.allowlistedHosts.includes(PROBE_HOST)) await ctx.aegis.adblock.toggleAllowlist(PROBE_HOST);
          await nudgeSync('allowlist');
          await ctx.reach('settings:allowlist');
          await waitFor(
            () => ctx.byLabel(new RegExp(`Remove ${PROBE_HOST} from allowlist`)),
            `"Remove ${PROBE_HOST} from allowlist" button`,
          );
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
          // Live: add a bare probe host (see settings.allowlist.remove for the URL-vs-host
          // bug) so the list is non-empty, then nudge useAdblock and wait until the host
          // makes the "Clear all" button enabled (it is disabled on an empty list).
          const st = await ctx.aegis.adblock.getState();
          if (!st.allowlistedHosts.includes(PROBE_HOST)) await ctx.aegis.adblock.toggleAllowlist(PROBE_HOST);
          await nudgeSync('allowlist');
          await ctx.reach('settings:allowlist');
          await waitFor(() => {
            const b = ctx.byRole('button', /^Clear all$/) as HTMLButtonElement | null;
            return b && !b.disabled ? b : null;
          }, 'enabled "Clear all" button');
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
      // live excluded: the live wiring effect (file written on disk) isn't observable
      // from the renderer; the catalog's data.export exercise() already covers the IPC.
      layers: ['vitest'] as InteractionLayer[],
      run: async (ctx: InteractionCtx) => {
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
        if (!ctx.calls.called('data.export'))
          throw new Error('data.export not called after clicking Export');
        return 'Data Export → data.export()';
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
];
