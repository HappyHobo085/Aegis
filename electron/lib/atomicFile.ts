// electron/lib/atomicFile.ts
import { writeFileSync, renameSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Atomically write `data` to `filePath`: write to a pid-suffixed temp file in
 * the same directory, then rename over the target (rename is atomic on the same
 * filesystem). Avoids a torn/partial file if the process dies mid-write.
 * Creates the parent directory if it does not exist (e.g. a fresh profile's
 * lists/ cache dir), so callers never have to pre-create it.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
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

/**
 * Atomically write raw bytes (e.g. a serialized adblock engine blob) to
 * `filePath` using the same temp-write + rename crash-safe pattern as
 * `writeFileAtomic`, but without a UTF-8 encoding.
 */
export function writeFileAtomicBytes(filePath: string, data: Uint8Array): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}

/**
 * Read `filePath` as raw bytes. Returns a Buffer on success, or null on ENOENT
 * or any read error (e.g. EISDIR), mirroring `readFileSafe` for binary blobs.
 */
export function readBytesSafe(filePath: string): Buffer | null {
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}
