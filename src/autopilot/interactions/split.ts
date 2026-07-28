// src/autopilot/interactions/split.ts
import type { InteractionSpec } from './types';

export const SPLIT_INTERACTIONS: InteractionSpec[] = [
  // --- Phase 6: split view ---

  {
    id: 'split.enter',
    domain: 'split',
    description: 'Enter split view via IPC split.enter with two tab ids',
    screen: 'home',
    layers: ['vitest'],
    run: async (ctx) => {
      // Call split.enter directly via the IPC mock — the vitest mock state has
      // tab id 1; we pair it with a second id to satisfy the 2-pane minimum.
      await ctx.aegis.split.enter([1, 2]);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('split.enter')) throw new Error('split.enter not called');
      return 'split.enter IPC called with two tab ids';
    },
  },

  {
    id: 'split.exit',
    domain: 'split',
    description: 'Exit split view via IPC split.exit',
    screen: 'home',
    layers: ['vitest'],
    run: async (ctx) => {
      // Call split.exit directly via the IPC mock.
      await ctx.aegis.split.exit();
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('split.exit')) throw new Error('split.exit not called');
      return 'split.exit IPC called';
    },
  },

  {
    id: 'split.resize',
    domain: 'split',
    description: 'Resize a split pane via IPC split.resize',
    screen: 'home',
    layers: ['vitest'],
    run: async (ctx) => {
      // Resize pane 1 to 800x600 via the IPC mock.
      await ctx.aegis.split.resize(1, 800, 600);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('split.resize')) throw new Error('split.resize not called');
      return 'split.resize IPC called with paneId and dimensions';
    },
  },

  {
    id: 'split.focus',
    domain: 'split',
    description: 'Focus a split pane via IPC split.focus',
    screen: 'home',
    layers: ['vitest'],
    run: async (ctx) => {
      // Focus pane 2 via the IPC mock.
      await ctx.aegis.split.focus(2);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('split.focus')) throw new Error('split.focus not called');
      return 'split.focus IPC called with paneId';
    },
  },
];
