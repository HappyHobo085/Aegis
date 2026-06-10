// electron/main/windowOpen.ts
import type { HandlerDetails } from 'electron'; // type-only — keeps this module node-pure
import { isAllowedNavigationUrl } from '../lib/schemes';

export type WindowOpenDecision = { action: 'deny' } | { action: 'deny'; loadInPlace: string };

/**
 * Pure popup/new-window policy (extracted from ViewController.wireSecurity so it is
 * unit-testable in isolation). Electron 42.4.0 HandlerDetails exposes NO user-gesture
 * bit, so the policy is disposition + scheme based only (documented limitation).
 *
 *  - 'background-tab' / 'other'  → deny (popunder / unknown intent), never route.
 *  - otherwise, allowed scheme   → deny the popup but route the single content view
 *                                  in-place to the requested URL.
 *  - otherwise                   → deny.
 *
 * Note: the real disposition enum is default|foreground-tab|background-tab|new-window|other.
 * There is NO 'save-to-disk' member, so no such branch exists here.
 */
export function decideWindowOpen(
  details: Pick<HandlerDetails, 'url' | 'disposition'>,
): WindowOpenDecision {
  if (details.disposition === 'background-tab' || details.disposition === 'other') {
    return { action: 'deny' };
  }
  if (isAllowedNavigationUrl(details.url)) {
    return { action: 'deny', loadInPlace: details.url };
  }
  return { action: 'deny' };
}
