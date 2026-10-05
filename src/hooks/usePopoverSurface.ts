// src/hooks/usePopoverSurface.ts
//
// Place the popover surface over one popover, and close it again.
//
// This is the chrome half of the surface contract and it owns three decisions the surface
// must not: WHICH popover is showing, HOW MANY items it is showing, and WHICH actions it
// accepts. Rust validates every pick the surface reports against exactly those three
// declarations (`popover.rs::validate_pick`), which is why they are sent with the payload
// rather than inferred on the other side — Rust cannot count rows in a payload it does not
// interpret.
//
// One `popover.set` per change, in BOTH directions: an open popover sends its rect and
// payload, and a closed one sends the same rect with `payload: null`, which is the close
// signal. There is deliberately no separate hide channel — a popover that forgets to hide
// itself would then stay open forever, over the page.
//
// `actions` is the popover's ALLOWLIST, not a description: a panel's button that reports an
// action the chrome did not declare here is dropped in Rust. That is what makes
// attacker-influenceable suggestion titles safe (they can only ever ask the chrome to pick an
// index it already had).
import { useEffect } from 'react';
import { aegis } from '../lib/ipcClient';
import type { MeasuredRect } from './useMeasuredRect';
import { EMPTY_RECT } from './useMeasuredRect';
import type { PopoverId, PopoverKind } from '../../shared/types';

export interface UsePopoverSurfaceArgs {
  /** Which popover this is. Part of the identity: a pick names an id, and Rust drops a pick
   *  whose id is not the one currently open. */
  id: PopoverId;
  /** Whether a popover is open at all. `false` sends the close signal. */
  active: boolean;
  /** The popover's measured rectangle. `EMPTY_RECT` while closed. */
  rect: MeasuredRect;
  /** How many rows/options the popover is rendering. Bounds-checks a reported `index`. */
  itemCount: number;
  /** The action names this popover accepts. A reported action outside this list is dropped. */
  actions: readonly string[];
  /** The rendered payload. `null` closes the surface regardless of `active` — the two are
   *  kept separate so "open with nothing to show" cannot paint an empty box over the page. */
  payload: Record<string, unknown> | null;
}

/**
 * @returns nothing. Every effect here is a one-shot send; nothing is read back.
 */
export function usePopoverSurface({
  id,
  active,
  rect,
  itemCount,
  actions,
  payload,
}: UsePopoverSurfaceArgs): void {
  // Serialised so the effect re-fires on a CONTENT change and not on a fresh array identity:
  // a caller building `actions={['a']}` inline would otherwise re-send on every render.
  const actionKey = JSON.stringify(actions);
  const payloadKey = payload === null ? '' : JSON.stringify(payload);

  useEffect(() => {
    const open = active && payload !== null;
    // A popover with no measured size cannot be placed, so an open-but-unmeasured popover is
    // treated as closed. Sending a 0x0 rect would park a webview of no size in the middle of
    // the window and, on some toolkits, size 0 is not a no-op.
    const measurable = rect.width > 0 && rect.height > 0;
    // An open-but-unmeasured popover is skipped ENTIRELY — no `popover.set` at all — rather
    // than sent with an empty rect. That is deliberate and it has a visible consequence worth
    // stating rather than leaving to inference: the surface keeps whatever frame it already
    // holds. Sending an empty rect would park a zero-sized webview and clear the payload,
    // which reads as "the popover blinked out and came back" as the user types the first
    // character. Holding the last frame is the lesser artefact, and the surface only ever
    // shows one popover at a time, so the stale frame is bounded by the next measurement.
    // The residual case is a popover that measures 0x0 twice in a row (e.g. a `display: none`
    // host): then the previous popover's rectangle stays on screen until the next non-empty
    // measure. Closing a popover always sends, so this cannot outlive the interaction.
    if (open && !measurable) return;

    void aegis.popover.set({
      id,
      rect: open ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : EMPTY_RECT,
      payload: open ? { kind: id as PopoverKind, ...payload } : null,
      itemCount: open ? itemCount : 0,
      actions: open ? [...actions] : [],
    });
  }, [id, active, rect.x, rect.y, rect.width, rect.height, itemCount, actionKey, payloadKey]);
}
