// src/autopilot/interactions/find.ts
// Interaction specs for the find-in-page feature (FindBar, useFind, Ctrl+F).
import { act } from '@testing-library/react';
import type { InteractionSpec } from './types';

export const FIND_INTERACTIONS: InteractionSpec[] = [
  // ─── Task 9: find-in-page ───────────────────────────────────────────────

  {
    id: 'find.open',
    domain: 'find',
    description: 'Ctrl+F opens the find bar',
    screen: 'home',
    layers: ['vitest'],
    run: async (_ctx) => {
      // App.tsx listens on window.addEventListener('keydown', …) for Ctrl+F.
      // Dispatch directly on window so the App handler fires in jsdom.
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'f',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    },
    assert: async (ctx) => {
      if (!ctx.bySelector('input[aria-label="Find in page"]'))
        throw new Error('find bar not shown after Ctrl+F');
      return 'Ctrl+F → find bar visible';
    },
  },

  {
    id: 'find.type',
    domain: 'find',
    description: 'Typing a term calls find.start',
    screen: 'findBar',
    layers: ['vitest'],
    run: async (ctx) => {
      const input = ctx.bySelector('input[aria-label="Find in page"]');
      if (!input) throw new Error('find bar input not found');
      await ctx.type(input, 'lorem');
      // Wait for the 120 ms debounce in useFind.setQuery to flush.
      await new Promise((r) => setTimeout(r, 200));
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('find.start', (a) => String(a[1]).includes('lorem')))
        throw new Error('find.start not called with lorem');
      return 'type → find.start(lorem)';
    },
  },

  {
    id: 'find.next',
    domain: 'find',
    description: 'Find-next button calls find.next',
    screen: 'findBar',
    layers: ['vitest'],
    run: async (ctx) => {
      // The "Find next" button is disabled when matchCount === 0 (which is the mock state).
      // Seed a non-zero matchCount via ctx.emitFindState (captures the useFind subscriber
      // before calls.reset() wipes it) so the button is enabled before we click it.
      await ctx.emitFindState?.({ viewId: 1, query: 'lorem', matchCount: 3, activeMatchIndex: 1 });
      const btn = ctx.byRole('button', /Find next/);
      if (!btn) throw new Error('"Find next" button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('find.next')) throw new Error('find.next not called');
      return 'next → find.next';
    },
  },

  {
    id: 'find.prev',
    domain: 'find',
    description: 'Find-previous button calls find.prev',
    screen: 'findBar',
    layers: ['vitest'],
    run: async (ctx) => {
      // Same: seed matchCount > 0 so the "Find previous" button is enabled.
      await ctx.emitFindState?.({ viewId: 1, query: 'lorem', matchCount: 3, activeMatchIndex: 1 });
      const btn = ctx.byRole('button', /Find previous/);
      if (!btn) throw new Error('"Find previous" button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('find.prev')) throw new Error('find.prev not called');
      return 'prev → find.prev';
    },
  },

  {
    id: 'find.close',
    domain: 'find',
    description: 'Close button closes the find bar + calls find.close',
    screen: 'findBar',
    layers: ['vitest'],
    run: async (ctx) => {
      const btn = ctx.byRole('button', /Close find/);
      if (!btn) throw new Error('"Close find" button not found');
      await ctx.click(btn);
    },
    assert: async (ctx) => {
      if (ctx.bySelector('input[aria-label="Find in page"]'))
        throw new Error('find bar still shown after close');
      if (!ctx.calls.called('find.close')) throw new Error('find.close not called');
      return 'Close button → bar hidden + find.close';
    },
  },
];
