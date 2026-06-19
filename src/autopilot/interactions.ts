// src/autopilot/interactions.ts
import type { AegisApi } from '../../shared/types';
import type { ScreenId } from './screens';

export type InteractionLayer = 'vitest' | 'live';

/** Recorded mock-call inspection (vitest); inert on live (asserts via real state instead). */
export interface CallLog {
  /** Call-argument arrays for a dotted aegis path, e.g. of('favorites.add'). [] on live. */
  of(path: string): unknown[][];
  /** True if `path` was called (optionally with a predicate on the first call's args). */
  called(path: string, match?: (args: unknown[]) => boolean): boolean;
  /** Clear recorded calls (the tour calls this before each interaction's run). */
  reset(): void;
}

export interface InteractionCtx {
  layer: InteractionLayer;
  click(el: Element): Promise<void>;
  type(el: Element, text: string): Promise<void>;
  press(key: 'Enter' | 'Escape' | 'ctrl+t' | 'ctrl+w' | 'ctrl+shift+t'): Promise<void>;
  byRole(role: string, name?: string | RegExp): HTMLElement | null;
  byText(text: string | RegExp): HTMLElement | null;
  byLabel(label: string | RegExp): HTMLElement | null;
  bySelector(sel: string): HTMLElement | null;
  aegis: AegisApi;
  calls: CallLog;
  reach(screen: ScreenId): Promise<void>;
}

export interface InteractionSpec {
  id: string;
  domain: string;
  description: string;
  screen: ScreenId;
  layers: InteractionLayer[];
  run(ctx: InteractionCtx): Promise<void>;
  assert(ctx: InteractionCtx): Promise<string>;
}

/** Filled in per-domain by later tasks. */
export const INTERACTIONS: InteractionSpec[] = [];

/** Documented registry of every interactive control id; the drift guard asserts each has
 *  an INTERACTIONS entry. Filled in per-domain by later tasks (mirrors UNTESTED_CHANNELS). */
export const INTERACTIVE_CONTROLS = new Set<string>([]);
