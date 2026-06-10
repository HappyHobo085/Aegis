// electron/main/adblock/engine.ts
import { createHash } from 'node:crypto';
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron';

/**
 * Single source for the default `$redirect` resources (ublock-origin resources.json).
 * Hardcoded per contract §1; the list URL set comes from `adsAndTrackingLists`.
 */
export const RESOURCES_URL =
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';

/**
 * Derive a stable, persistable list id from a default source URL. The id is the
 * filename (sans extension), used as the PK in `filter_subscriptions` and as the
 * per-list raw-cache filename.
 */
function listIdFromUrl(url: string): string {
  const last = url.split('/').filter(Boolean).pop() ?? url;
  return last.replace(/\.txt$/i, '');
}

/**
 * The default list URL set, derived from the engine's own `adsAndTrackingLists`
 * constant so the seed and runtime always agree on sources. Each entry pairs a
 * stable `listId` (for persistence/caching) with its HTTPS source `url`.
 */
export const DEFAULT_LIST_URLS: { listId: string; url: string }[] = adsAndTrackingLists.map(
  (url) => ({ listId: listIdFromUrl(url), url }),
);

/**
 * Build a runtime `ElectronBlocker` from already-fetched list text (NOT via
 * `fromLists`, which would re-fetch). When `resources` (resources.json content)
 * is provided, load it so `$redirect` rules serve neutered stubs.
 *
 * Passes NO custom config: the library defaults enable network + cosmetic +
 * scriptlet layers (contract §1).
 */
export function buildEngine(listTexts: string[], resources: string | null): ElectronBlocker {
  const engine = ElectronBlocker.parse(listTexts.join('\n'));
  if (resources !== null) {
    const checksum = createHash('sha1').update(resources).digest('hex');
    engine.updateResources(resources, checksum);
  }
  return engine;
}
