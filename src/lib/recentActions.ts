// src/lib/recentActions.ts
//
// Tracks the last N executed command-palette action IDs in localStorage.
// Used by CommandPalette to show a "Recent" section when the query is empty.

const STORAGE_KEY = 'aegis-recent-actions';
const MAX_RECENT = 5;

function readRaw(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRaw(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage unavailable (SSR, private mode quota, etc.) */
  }
}

/** Return the last 5 executed action IDs (most-recent first). */
export function getRecent(): string[] {
  return readRaw().slice(0, MAX_RECENT);
}

/**
 * Record an action as recently executed.
 * Moves it to the front, deduplicates, and caps at MAX_RECENT.
 */
export function addRecent(id: string): void {
  const prev = readRaw();
  const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECENT);
  writeRaw(next);
}

/** Empty the recent list. */
export function clearRecent(): void {
  writeRaw([]);
}
