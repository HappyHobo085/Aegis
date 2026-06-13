// electron/main/downloadsHelpers.ts
import { isAbsolute, resolve } from 'node:path';

/**
 * Pure download-path helpers (unit-tested). uniquifyFilename avoids clobbering an
 * existing file by inserting " (n)" before the extension; resolveDownloadDir picks
 * the configured dir or the OS default. Uses node:path (a Node builtin, not fs/electron)
 * so they still test under Node.
 */

/** Split a full path into [dir-with-trailing-slash, base, ext-with-dot]. */
function splitPath(fullPath: string): { dir: string; base: string; ext: string } {
  const slash = fullPath.lastIndexOf('/');
  const dir = slash >= 0 ? fullPath.slice(0, slash + 1) : '';
  const name = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;
  // A leading dot is part of the name (dotfile), not an extension boundary.
  // Use indexOf to capture compound extensions like .tar.gz from the first dot.
  const dot = name.indexOf('.');
  if (dot <= 0) return { dir, base: name, ext: '' };
  return { dir, base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Return `fullPath` if `exists(fullPath)` is false; otherwise insert " (1)",
 * " (2)", … before the extension until a free path is found.
 */
export function uniquifyFilename(fullPath: string, exists: (p: string) => boolean): string {
  if (!exists(fullPath)) return fullPath;
  const { dir, base, ext } = splitPath(fullPath);
  let n = 1;
  let candidate = `${dir}${base} (${n})${ext}`;
  while (exists(candidate)) {
    n += 1;
    candidate = `${dir}${base} (${n})${ext}`;
  }
  return candidate;
}

/**
 * The configured download dir if it's a safe absolute path, else the OS Downloads
 * dir. Rejects non-absolute dirs (would resolve against an unpredictable cwd) and
 * any `..`-bearing input (path traversal) — a crafted `downloadDir` setting must
 * not be able to write files outside an explicit absolute location.
 */
export function resolveDownloadDir(settingDir: string, osDir: string): string {
  const trimmed = settingDir.trim();
  if (trimmed.length === 0) return osDir;
  const hasTraversal = trimmed.split(/[\\/]+/).includes('..');
  if (!isAbsolute(trimmed) || hasTraversal) return osDir;
  return resolve(trimmed);
}
