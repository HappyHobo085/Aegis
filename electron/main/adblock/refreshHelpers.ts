// electron/main/adblock/refreshHelpers.ts
import type { Subscription } from '../../../shared/types';

/**
 * Resolve the enabled subscription rows into the `{ listId, url }` source list that
 * `fetchAll` consumes. Only `enabled` rows are kept (this is what finally READS the
 * `filter_subscriptions.enabled` column — the wiring gap). When `listBase` is set
 * (e2e fixture override, from AEGIS_ADBLOCK_LIST_BASE) each row's url is rewritten
 * to `${listBase}/${listId}.txt` so refreshes hit the local fixture deterministically.
 */
export function resolveRefreshSubs(
  rows: Subscription[],
  listBase: string | undefined,
): { listId: string; url: string }[] {
  return rows
    .filter((r) => r.enabled)
    .map((r) => ({
      listId: r.listId,
      url: listBase ? `${listBase}/${r.listId}.txt` : r.url,
    }));
}

/**
 * Assemble the text blobs passed to `buildEngine` for BOTH rebuild paths: the
 * enabled list texts (fetched, or read from cache) followed by the user's
 * custom-filters blob. The custom element is appended only when it has
 * non-whitespace content, so an empty my-filters store adds nothing. `buildEngine`
 * itself is unchanged — the my-filters merge happens here, at the call site, by
 * concatenation (verified merge mechanism, contract §1.3).
 */
export function assembleEngineTexts(listTexts: string[], customFilters: string): string[] {
  return customFilters.trim().length > 0 ? [...listTexts, customFilters] : [...listTexts];
}
