// src/autopilot/interactions/edge.ts
import type { InteractionSpec, InteractionCtx, InteractionLayer } from './types';
import { emitNavState, fireInputChange, BASE_NAV } from './helpers';
import type { SavedItem } from '../../../shared/types';

export const EDGE_INTERACTIONS: InteractionSpec[] = [
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
        throw new Error(
          'nav.navigate was not called after empty Enter — expected empty search navigation',
        );
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
        throw new Error(
          'nav.navigate not called after malformed-URL Enter — expected search navigation',
        );
      // Additionally verify it was NOT treated as a navigate-to-literal-URL (that would
      // be a security/crash risk if the scheme were truly malformed).  The call should
      // include encoded form of the input, not the raw 'ht!tp://x' as a literal URL.
      const calledWithRaw = ctx.calls
        .of('nav.navigate')
        .some((args) => String(args[1]) === 'ht!tp://x');
      if (calledWithRaw)
        throw new Error(
          'nav.navigate was called with the raw malformed URL — expected search encoding',
        );
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
      description:
        'Type a whitespace-only tag and Enter → tag rejected/trimmed, no empty tag in item',
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
    let _resolveFirst: ((v: import('../../../shared/types').SavedItem[]) => void) | undefined;
    return {
      id: 'edge.bookmark.doubleClick',
      domain: 'edge',
      description:
        'Click the bookmark star twice rapidly → exactly ONE saved.add dispatched (in-flight guard)',
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
          () =>
            new Promise<import('../../../shared/types').SavedItem[]>((res) => {
              _resolveFirst = res;
            }),
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
          throw new Error(
            'saved.add was never called on double-click — bookmark button appears broken',
          );
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
];
