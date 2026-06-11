// electron/main/adblock/extraLists.mjs
// Single source of truth for the EXTRA default filter lists layered on top of
// the library's `adsAndTrackingLists`. Plain ESM (.mjs) so the dev-only
// `scripts/generate-seed.mjs` can import it directly, AND `engine.ts` (TS) can
// import it via its named export — both stay in lock-step on the source set.
//
// These lists were measured to materially improve coverage on streaming/piracy
// sites (rotating .cfd/.cyou ad domains eliminated, third-party resource count
// roughly halved on streamex.sh). They are the standard uBlock Origin / AdGuard
// default sets (low breakage risk). `listId` is a stable, human-readable id used
// as the filter_subscriptions PK and the per-list raw-cache filename — do NOT
// derive it from the URL for these (some have query strings / non-.txt paths).

/** @type {{ listId: string; url: string }[]} */
export const EXTRA_LIST_URLS = [
  {
    listId: 'ublock-filters',
    url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt',
  },
  {
    listId: 'ublock-badware',
    url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt',
  },
  {
    listId: 'ublock-resource-abuse',
    url: 'https://ublockorigin.github.io/uAssets/filters/resource-abuse.txt',
  },
  {
    listId: 'ublock-privacy',
    url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
  },
  {
    listId: 'adguard-base',
    url: 'https://filters.adtidy.org/extension/ublock/filters/2.txt',
  },
  {
    listId: 'peter-lowe',
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
  },
];
