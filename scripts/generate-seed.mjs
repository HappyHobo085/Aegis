// scripts/generate-seed.mjs
// Dev-only: build the default-list ElectronBlocker via fromLists (fetches the
// library's `adsAndTrackingLists` PLUS the curated EXTRA_LIST_URLS — uBlock
// filters/badware/resource-abuse/privacy + AdGuard Base + Peter Lowe's — AND
// the $redirect resources.json), serialize it, and write the committed snapshot
// the app ships for never-zero first-run blocking. Run with
// `npm run generate-seed`. Regenerate on engine-version bumps or any change to
// the default list set (the seed-compat test fails on an engine-version
// mismatch otherwise). EXTRA_LIST_URLS is shared with engine.ts via
// ./extraLists.mjs so the seed and runtime build from the SAME source set.
// Uses Node 22 global fetch (no cross-fetch).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron';
import { EXTRA_LIST_URLS } from '../electron/main/adblock/extraLists.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'electron', 'main', 'adblock', 'seed', 'engine-seed.bin');

async function main() {
  // fromLists takes string URLs; map the extra { listId, url } entries to url.
  const urls = [...adsAndTrackingLists, ...EXTRA_LIST_URLS.map((e) => e.url)];
  console.log(
    `[generate-seed] fetching ${urls.length} default lists ` +
      `(${adsAndTrackingLists.length} library + ${EXTRA_LIST_URLS.length} extra) + resources…`,
  );
  // fromLists fetches lists AND $redirect resources, then parse + updateResources.
  // Pass NO custom config → library defaults (network + cosmetic + scriptlet layers).
  const engine = await ElectronBlocker.fromLists(fetch, urls);
  const bytes = engine.serialize();
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, bytes);
  console.log(`[generate-seed] wrote ${bytes.length} bytes to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[generate-seed] failed:', err);
  process.exitCode = 1;
});
