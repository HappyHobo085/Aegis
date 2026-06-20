// src/autopilot/interactions/sidebar.ts
import type { InteractionSpec, InteractionCtx, InteractionLayer } from './types';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import type { HistoryEntry, SavedItem } from '../../../shared/types';
import { nudgeSync, waitFor, fixtureUrl, liveNavigate } from './helpers';

/** Live-only: remove every saved item whose url matches `url` — clears leftovers a prior
 *  (possibly failed) spec didn't clean up, so each spec starts from a known state. */
async function clearSavedProbe(ctx: InteractionCtx, url: string): Promise<void> {
  const list = await ctx.aegis.saved.list();
  for (const i of list.filter((i) => i.url === url)) await ctx.aegis.saved.remove(i.id);
}

export const SIDEBAR_INTERACTIONS: InteractionSpec[] = [
  (() => {
    // Capture url before clicking the history row so the live assert can verify the
    // url CHANGED away from _urlBeforeClick to the entry's destination — not merely
    // that it is non-blank (which it already was before the click).
    let _urlBeforeClick: string | undefined;
    // Live: two distinct fixture URLs that both load (so the core records history and the
    // panel re-renders via aegis.history.onChanged). ENTRY is the row we click; CURRENT is
    // where we are when we click, so the navigation produces an observable url change.
    const ENTRY_URL = fixtureUrl('histentry');
    const CURRENT_URL = fixtureUrl('histcurrent');
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
          // Click the first "Open <url>" button scoped to the history panel.
          const seededBtn = ctx.bySelector('.history-panel__open');
          if (!seededBtn) throw new Error('No history entry open-button found (panel may be empty)');
          await ctx.click(seededBtn);
          return;
        }
        // Live: visit ENTRY (recorded in history), then CURRENT (where we are now), so
        // clicking the ENTRY row later produces a real url change. Both load → the core
        // records them and aegis.history.onChanged re-renders the panel.
        await liveNavigate(ctx, ENTRY_URL);
        await liveNavigate(ctx, CURRENT_URL);
        // Re-reach the sidebar:history screen (nav may have closed it).
        await ctx.reach('sidebar:history');
        _urlBeforeClick = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
        // Click the ENTRY row specifically (NOT the first row — that is CURRENT, the page
        // we are already on, so it would produce no change). Scope by the ?ap=histentry marker.
        const openBtn = await waitFor(
          () => ctx.bySelector('.history-panel__open[aria-label*="ap=histentry"]'),
          'history row for ?ap=histentry',
        );
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
          if (url !== _urlBeforeClick && url.includes('ap=histentry'))
            return `history row → nav navigated from ${_urlBeforeClick} to ${url}`;
          await new Promise((r) => setTimeout(r, 400));
        }
        const finalUrl = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
        throw new Error(
          `live: url did not change to ${ENTRY_URL} after clicking history entry (was ${_urlBeforeClick}, now ${finalUrl})`,
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
    // Live: a loadable fixture URL (?ap=savedopen) so the nav commits and is matchable;
    // CURRENT is where we sit when clicking so the navigation is an observable change.
    const SEED_ITEM: SavedItem = {
      id: 100,
      url: fixtureUrl('savedopen'),
      title: 'Saved Open Test',
      tags: [],
      savedAt: 0,
    };
    const CURRENT_URL = fixtureUrl('savedcurrent');
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
          // Only the seeded item exists in vitest → first-match open button is it.
          const openBtn = ctx.bySelector('.saved-panel__open');
          if (!openBtn) throw new Error('No saved-panel open button found (panel may be empty)');
          await ctx.click(openBtn);
          return;
        }
        // Live: clear leftovers, add the probe, nudge the panel to re-fetch, sit on a
        // DIFFERENT page, then click the probe's OWN row (scoped — the real panel may hold
        // other items) so the navigation is an observable, item-specific change.
        await clearSavedProbe(ctx, SEED_ITEM.url);
        await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title });
        await nudgeSync('saved');
        await liveNavigate(ctx, CURRENT_URL);
        await ctx.reach('sidebar:saved');
        _urlBeforeClick = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
        const openBtn = await waitFor(
          () => ctx.bySelector(`.saved-panel__open[aria-label="Open ${SEED_ITEM.url}"]`),
          'saved row for the probe item',
        );
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
          if (url !== _urlBeforeClick && url.includes('ap=savedopen')) {
            // Clean up the probe saved item.
            await clearSavedProbe(ctx, SEED_ITEM.url);
            await nudgeSync('saved');
            return `saved row open → nav navigated from ${_urlBeforeClick} to ${url} (probe cleaned up)`;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        const finalUrl = (await ctx.aegis.nav.getState(PRIMARY_VIEW_ID)).url;
        await clearSavedProbe(ctx, SEED_ITEM.url);
        throw new Error(
          `live: url did not carry ?ap=savedopen after clicking saved row (was ${_urlBeforeClick}, now ${finalUrl})`,
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
          // Only the seeded item exists in vitest → first-match remove button is it.
          const removeBtn = ctx.bySelector('.saved-panel__remove');
          if (!removeBtn) throw new Error('No saved-panel remove button found (panel may be empty)');
          await ctx.click(removeBtn);
          return;
        }
        // Live: clear leftovers, add the probe, nudge the panel, then click the probe's
        // OWN remove button (scoped by title — the real panel may hold other items, so a
        // first-match would remove the wrong row and pass for the wrong reason).
        await clearSavedProbe(ctx, SEED_ITEM.url);
        await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title });
        await nudgeSync('saved');
        await ctx.reach('sidebar:saved');
        const removeBtn = await waitFor(
          () => ctx.bySelector(`.saved-panel__remove[aria-label="Remove ${SEED_ITEM.title}"]`),
          'remove button for the probe item',
        );
        _baseLength = (await ctx.aegis.saved.list()).length;
        await ctx.click(removeBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('saved.remove'))
            throw new Error('saved.remove not called');
          return 'saved row remove → saved.remove()';
        }
        // Live: the probe itself must be gone (precise — not merely count−1, which a
        // wrong-row removal would also satisfy).
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.saved.list();
        if (list.some((i) => i.url === SEED_ITEM.url))
          throw new Error(`live: probe ${SEED_ITEM.url} still in saved list after remove`);
        if (_baseLength !== undefined && list.length !== _baseLength - 1)
          throw new Error(`live: expected ${_baseLength - 1} saved items after remove, got ${list.length}`);
        return `saved row remove → probe removed (list ${_baseLength} → ${list.length})`;
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
          // Only the seeded item exists in vitest → first-match edit button is it.
          const editBtn = ctx.bySelector('.saved-panel__edit');
          if (!editBtn) throw new Error('No saved-panel edit button found (panel may be empty)');
          await ctx.click(editBtn);
        } else {
          // Live: clear leftovers, add the probe, nudge the panel, snapshot its tags, then
          // open the editor on the probe's OWN row (scoped by its title).
          await clearSavedProbe(ctx, SEED_ITEM.url);
          await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title, tags: [] });
          await nudgeSync('saved');
          const item = (await ctx.aegis.saved.list()).find((i) => i.url === SEED_ITEM.url);
          if (!item) throw new Error('live: probe saved item not found after add');
          _tagsBefore = [...item.tags];
          await ctx.reach('sidebar:saved');
          const editBtn = await waitFor(
            () => ctx.bySelector(`.saved-panel__edit[aria-label="Edit ${SEED_ITEM.title}"]`),
            'edit button for the probe item',
          );
          await ctx.click(editBtn);
        }
        // The TagInput "Add tag" input is now rendered (only one item edits at a time).
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
          // Live: add the probe item with the old tag so it enters tagUnion, then nudge
          // the panel to re-fetch so the "Manage tags" section renders.
          await clearSavedProbe(ctx, SEED_ITEM.url);
          await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title, tags: [OLD_TAG] });
          await nudgeSync('saved');
          await ctx.reach('sidebar:saved');
          await waitFor(() => ctx.bySelector('.saved-panel__manage-summary'), '"Manage tags" summary');
        }
        // Open the "Manage tags" details element by clicking its summary.
        const summary = ctx.bySelector('.saved-panel__manage-summary');
        if (!summary) throw new Error('"Manage tags" summary not found (tagUnion may be empty)');
        await ctx.click(summary);
        // Click the probe tag chip to select it (aria-pressed becomes true).
        const tagChip = await waitFor(
          () => ctx.byRole('button', new RegExp(`^${OLD_TAG}$`)),
          `tag chip "${OLD_TAG}" in Manage tags`,
        );
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
          // Live: add the probe item with the probe tag, then nudge the panel to re-fetch
          // so the "Manage tags" section renders the chip.
          await clearSavedProbe(ctx, SEED_ITEM.url);
          await ctx.aegis.saved.add({ url: SEED_ITEM.url, title: SEED_ITEM.title, tags: [PROBE_TAG] });
          await nudgeSync('saved');
          await ctx.reach('sidebar:saved');
          await waitFor(() => ctx.bySelector('.saved-panel__manage-summary'), '"Manage tags" summary');
        }
        // Open the "Manage tags" details element by clicking its summary.
        const summary = ctx.bySelector('.saved-panel__manage-summary');
        if (!summary) throw new Error('"Manage tags" summary not found (tagUnion may be empty)');
        await ctx.click(summary);
        // Click the probe tag chip to select it.
        const tagChip = await waitFor(
          () => ctx.byRole('button', new RegExp(`^${PROBE_TAG}$`)),
          `tag chip "${PROBE_TAG}" in Manage tags`,
        );
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
];
