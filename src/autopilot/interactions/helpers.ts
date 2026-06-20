// src/autopilot/interactions/helpers.ts
// Internal helpers shared across the per-domain interaction spec files.
import type { NavState } from '../../../shared/types';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import type { InteractionCtx } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit a NavState update to the App's useNav hook.
 *  Uses ctx.emitNavState (captured before any reset() wipes mock.calls) so the
 *  Back/Forward buttons can be enabled before clicking them.  No-op on live. */
export async function emitNavState(ctx: InteractionCtx, state: NavState): Promise<void> {
  await ctx.emitNavState?.(state);
}

/**
 * Set the value of a non-editable input (color, number, select) and fire a change event.
 * Cannot use ctx.type() for these because userEvent.clear() fails on non-text inputs.
 * This uses the React testing pattern: override via the descriptor + dispatch change event.
 */
export function fireInputChange(el: Element, value: string): void {
  const proto = el instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : el instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Default nav state used to seed vitest state updates. */
export const BASE_NAV: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};
