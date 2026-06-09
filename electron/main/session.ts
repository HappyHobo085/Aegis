// electron/main/session.ts
import { join } from 'node:path';
import { writeFileAtomic, readFileSafe } from '../lib/atomicFile';

interface LastSession {
  url: string;
  title: string;
}

function sessionPath(dataDir: string): string {
  return join(dataDir, 'session.json');
}

/**
 * Read the last persisted session ({ url, title }) from `<dataDir>/session.json`.
 * Returns null when the file is absent, unreadable, not valid JSON, or missing
 * the expected string fields (crash-safe: a corrupt file never throws).
 */
export function readLastSession(dataDir: string): LastSession | null {
  const raw = readFileSafe(sessionPath(dataDir));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).url === 'string' &&
    typeof (parsed as Record<string, unknown>).title === 'string'
  ) {
    const { url, title } = parsed as LastSession;
    return { url, title };
  }
  return null;
}

/** Persist the current session ({ url, title }) atomically to session.json. */
export function writeLastSession(dataDir: string, s: LastSession): void {
  writeFileAtomic(sessionPath(dataDir), JSON.stringify({ url: s.url, title: s.title }));
}
