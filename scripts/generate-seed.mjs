// scripts/generate-seed.mjs
// Dev-only: build the default-list ElectronBlocker via fromLists (fetches the
// 14 default ad/tracking lists AND the $redirect resources.json), serialize it,
// and write the committed snapshot the app ships for never-zero first-run
// blocking. Run with `npm run generate-seed`. Regenerate on engine-version bumps
// (the seed-compat test fails otherwise). Uses Node 22 global fetch (no cross-fetch).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'electron', 'main', 'adblock', 'seed', 'engine-seed.bin');

async function main() {
  console.log(`[generate-seed] fetching ${adsAndTrackingLists.length} default lists + resources…`);
  // fromLists fetches lists AND $redirect resources, then parse + updateResources.
  // Pass NO custom config → library defaults (network + cosmetic + scriptlet layers).
  const engine = await ElectronBlocker.fromLists(fetch, adsAndTrackingLists);
  const bytes = engine.serialize();
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, bytes);
  console.log(`[generate-seed] wrote ${bytes.length} bytes to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[generate-seed] failed:', err);
  process.exitCode = 1;
});
