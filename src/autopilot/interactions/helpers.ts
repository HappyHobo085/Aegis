// src/autopilot/interactions/helpers.ts
// Internal helpers shared across the per-domain interaction spec files.
import type { NavState, ViewId } from '../../../shared/types';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import type { InteractionCtx } from './types';
import { AdaptiveTimeout } from '../timeout';

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
  const proto =
    el instanceof HTMLSelectElement
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

// ---------------------------------------------------------------------------
// Live-only helpers
//
// On the live run every ctx.emit* seeding helper is undefined (a no-op via ?.),
// so a spec that needs UI state must (1) really mutate the core via ctx.aegis.*
// and (2) nudge the owning hook to re-fetch — the same signal useSync relays on a
// merge. These helpers make that pattern uniform. They are only ever called from
// the `ctx.layer === 'live'` branch of a spec (never in jsdom/vitest).
// ---------------------------------------------------------------------------

/** The autopilot fixture base URL — a real, locally-served page that always loads
 *  (unlike example.com / *.test / *.example, which are network/DNS-dependent on live).
 *  Use this (with a distinct ?marker= per spec) for any URL a live spec navigates to. */
export function fixtureBase(): string {
  return (import.meta.env.VITE_AEGIS_AUTOPILOT_FIXTURE as string) || 'http://127.0.0.1:8137/';
}

/** Live-only: build a fixture URL with a unique query marker (host-independent, so the
 *  assertion can match on the marker regardless of the configured fixture host). */
export function fixtureUrl(marker: string): string {
  const base = fixtureBase();
  return base + (base.includes('?') ? '&' : '?') + 'ap=' + encodeURIComponent(marker);
}

/** Live-only: poll `fn` until it returns a truthy value or `timeoutMs` elapses.
 *  Returns the value, or throws `live: timed out waiting for <label>`. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  label: string,
  timeoutMs = 8000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + AdaptiveTimeout.ms(timeoutMs);
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`live: timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Live-only: nudge a domain hook (favorites/saved/allowlist) to re-fetch from the real
 *  core after a programmatic ctx.aegis.* mutation — the exact signal useSync publishes on
 *  a merge. Without this the chrome UI never re-renders for a local programmatic mutation,
 *  so the seeded chip/row/host never appears for the gesture to target. */
export async function nudgeSync(namespace: 'favorites' | 'saved' | 'allowlist'): Promise<void> {
  const { publishSyncChange } = await import('../../lib/syncBus');
  publishSyncChange(namespace, []);
}

/** Live-only: the id of the view the chrome is currently driving. App binds
 *  `useNav(tabs.activeId)`, so the address bar AND the favorites/saved/history "open"
 *  handlers all navigate the ACTIVE view — which is NOT PRIMARY_VIEW_ID once the
 *  tab-interaction specs have switched tabs. Any live nav setup/assert must target this
 *  id, not a hard-coded view 1, or it drives/reads a stale background view (the bug behind
 *  the favorites/saved/history "url never changed" failures). */
export async function activeViewId(ctx: InteractionCtx): Promise<ViewId> {
  return (await ctx.aegis.tabs.list()).activeId;
}

/** Live-only: navigate the ACTIVE content view to `url` and wait until the page has
 *  actually committed AND finished loading. Matching is on the ?ap= marker when present
 *  (so two same-host fixture URLs that differ only by query are distinguished — host-only
 *  matching would return early), else the host. Waiting for isLoading=false guarantees the
 *  load finished, so the core has recorded the visit in history before we navigate away. */
export async function liveNavigate(
  ctx: InteractionCtx,
  url: string,
  timeoutMs = 8000,
): Promise<void> {
  const vid = await activeViewId(ctx);
  await ctx.aegis.nav.navigate(vid, url);
  let token = url;
  const marker = url.match(/[?&]ap=([^&]+)/);
  if (marker) token = 'ap=' + marker[1];
  else {
    try {
      token = new URL(url).host;
    } catch {
      /* keep raw url as the match token */
    }
  }
  await waitFor(
    async () => {
      const s = await ctx.aegis.nav.getState(vid);
      return s.url.includes(token) && !s.isLoading;
    },
    `nav → ${url}`,
    timeoutMs,
  );
}
