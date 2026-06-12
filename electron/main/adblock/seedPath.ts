// electron/main/adblock/seedPath.ts
import { join } from 'node:path';

/**
 * Resolve the bundled filter-seed blob at runtime.
 * - Packaged: shipped via electron-builder `extraResources` → `process.resourcesPath/engine-seed.bin`.
 * - Dev/e2e: the `aegis-copy-seed` Vite plugin copies it next to the main bundle,
 *   so it's `out/main/adblock/seed/engine-seed.bin` (mainDir = __dirname).
 */
export function resolveSeedPath(opts: {
  isPackaged: boolean;
  mainDir: string;
  resourcesPath: string;
}): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, 'engine-seed.bin')
    : join(opts.mainDir, 'adblock/seed/engine-seed.bin');
}
