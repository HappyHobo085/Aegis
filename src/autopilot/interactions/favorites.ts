// src/autopilot/interactions/favorites.ts
import type { InteractionSpec, InteractionCtx, InteractionLayer } from './types';
import type { Favorite } from '../../../shared/types';
import { nudgeSync, waitFor, fixtureUrl, activeViewId } from './helpers';
import { AdaptiveTimeout } from '../timeout';

export const FAVORITES_INTERACTIONS: InteractionSpec[] = [
  // ─── Task 5: favorites bar/manager + sidebar history ────────────────────

  (() => {
    // Vitest seeding: open the manager, mock favorites.add to return a seeded list,
    // fill the Add form, close the manager — the hook's setFavorites fires and the
    // FavBar gets the chip.  No external emit helper needed.
    type MockFn = { mockResolvedValue(v: Favorite[]): void };
    // A fixture URL (loads reliably on live) marked with ?ap=favopen so the assert can
    // match the marker host-independently — unlike a *.test domain that never commits.
    const FAV_URL = fixtureUrl('favopen');
    const SEED: Favorite = { id: 1, name: 'Autopilot Test', url: FAV_URL, position: 0 };
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
          // Live: really add the favorite, nudge useFavorites to re-fetch (a local add
          // doesn't emit sync.changed), then wait for the chip to render before clicking.
          await ctx.aegis.favorites.add({ name: SEED.name, url: SEED.url });
          await nudgeSync('favorites');
          await waitFor(
            () => ctx.byLabel(/^Open Autopilot Test$/),
            'favorite chip "Autopilot Test"',
          );
        }
        const chip = ctx.byLabel(/^Open Autopilot Test$/);
        if (!chip) throw new Error('Favorite chip "Autopilot Test" not found in favorites bar');
        await ctx.click(chip);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('nav.navigate', (a) => String(a[1]).includes('ap=favopen')))
            throw new Error('nav.navigate not called with the favorite url');
          return 'favbar chip → nav.navigate(favorite url)';
        }
        // Live: poll the ACTIVE view (the one the chip's nav.navigate targets) until its url
        // carries the favorite's ?ap=favopen marker; then clean up.
        const vid = await activeViewId(ctx);
        const deadline = Date.now() + AdaptiveTimeout.ms(8000);
        while (Date.now() < deadline) {
          const { url } = await ctx.aegis.nav.getState(vid);
          if (url.includes('ap=favopen')) {
            const list = await ctx.aegis.favorites.list();
            for (const f of list.filter((f) => f.url.includes('ap=favopen'))) {
              await ctx.aegis.favorites.remove(f.id);
            }
            await nudgeSync('favorites');
            return `favbar chip → nav navigated to ${url} (favorite cleaned up)`;
          }
          await new Promise((r) => setTimeout(r, 400));
        }
        const now = (await ctx.aegis.nav.getState(vid)).url;
        throw new Error(
          `live: url never carried ?ap=favopen after clicking favorite chip (now ${now})`,
        );
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
          if (!ctx.calls.called('favorites.add')) throw new Error('favorites.add not called');
          return 'favManager add → favorites.add()';
        }
        // Live: list length must have increased by 1 from baseline.
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.favorites.list();
        if (_baseLength === undefined) throw new Error('live: _baseLength was never captured');
        if (list.length !== _baseLength + 1)
          throw new Error(
            `live: expected ${_baseLength + 1} favorites after add, got ${list.length}`,
          );
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
    const SEED: Favorite = {
      id: 10,
      name: 'Original Name',
      url: 'https://rename-test.test/',
      position: 0,
    };
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
          // Nudge useFavorites to re-fetch so the open manager renders the new row.
          await nudgeSync('favorites');
          await waitFor(
            () => ctx.byLabel(new RegExp(`^Name for ${SEED.name}$`)),
            `manager row for "${SEED.name}"`,
          );
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
          if (!ctx.calls.called('favorites.update')) throw new Error('favorites.update not called');
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
        await nudgeSync('favorites');
        return `favManager rename → name changed to "Renamed Favorite" (restored + cleaned up)`;
      },
    } satisfies InteractionSpec;
  })(),

  (() => {
    // Capture list length BEFORE deletion so assert can verify it shrank by 1.
    let _baseLength: number | undefined;
    type MockFn = { mockResolvedValue(v: Favorite[]): void };
    const SEED: Favorite = {
      id: 20,
      name: 'To Delete',
      url: 'https://delete-test.test/',
      position: 0,
    };
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
          // Live: add a dedicated favorite to delete, nudge the manager to render it,
          // then snapshot the baseline length after the row is present.
          await ctx.aegis.favorites.add({ name: SEED.name, url: SEED.url });
          await nudgeSync('favorites');
          await waitFor(
            () => ctx.byRole('button', /^Remove favorite To Delete$/),
            'manager "Remove favorite To Delete" button',
          );
          _baseLength = (await ctx.aegis.favorites.list()).length;
        }
        const removeBtn = ctx.byRole('button', /^Remove favorite To Delete$/);
        if (!removeBtn) throw new Error('Remove favorite "To Delete" button not found');
        await ctx.click(removeBtn);
      },
      assert: async (ctx: InteractionCtx) => {
        if (ctx.layer === 'vitest') {
          if (!ctx.calls.called('favorites.remove')) throw new Error('favorites.remove not called');
          return 'favManager delete → favorites.remove()';
        }
        // Live: list length must have decreased by exactly 1 from baseline.
        await new Promise((r) => setTimeout(r, 500));
        const list = await ctx.aegis.favorites.list();
        if (_baseLength === undefined) throw new Error('live: _baseLength was never captured');
        if (list.length !== _baseLength - 1)
          throw new Error(
            `live: expected ${_baseLength - 1} favorites after delete, got ${list.length}`,
          );
        return `favManager delete → list shrank from ${_baseLength} to ${list.length}`;
      },
    } satisfies InteractionSpec;
  })(),
];
