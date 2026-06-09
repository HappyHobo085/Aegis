// electron/lib/atomicFile.ts
import { writeFileSync, renameSync, readFileSync } from 'node:fs';

/**
 * Atomically write `data` to `filePath`: write to a pid-suffixed temp file in
 * the same directory, then rename over the target (rename is atomic on the same
 * filesystem). Avoids a torn/partial file if the process dies mid-write.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, data, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Read `filePath` as UTF-8 text. Returns null on ENOENT or any read error
 * (e.g. EISDIR), so callers can treat "no usable file" uniformly.
 */
export function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
