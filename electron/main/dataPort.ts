// electron/main/dataPort.ts
import type { Favorite, HistoryEntry, SavedItem, Settings, ImportMode } from '../../shared/types';

/**
 * The export/import file shape (version 1) and pure validate/plan helpers
 * (unit-tested). The impure apply (dialogs/fs/repos) lives in ipc/data.ts.
 */
export interface ExportPayload {
  version: 1;
  favorites: Favorite[];
  history: HistoryEntry[];
  saved: SavedItem[];
  settings: Settings;
}

export type ValidateResult =
  | { ok: true; payload: ExportPayload }
  | { ok: false; error: string };

/** Validate parsed JSON is a version-1 export with the four collections + settings. */
export function validateExport(json: unknown): ValidateResult {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'not an object' };
  const o = json as Record<string, unknown>;
  if (o.version !== 1) return { ok: false, error: 'unsupported version' };
  for (const key of ['favorites', 'history', 'saved'] as const) {
    if (!Array.isArray(o[key])) return { ok: false, error: `missing array: ${key}` };
  }
  if (typeof o.settings !== 'object' || o.settings === null) {
    return { ok: false, error: 'missing settings' };
  }
  return { ok: true, payload: json as ExportPayload };
}

export interface ExistingData {
  favorites: Favorite[];
  saved: SavedItem[];
  historyUrls: Set<string>;
}

export interface ImportPlan {
  replace: boolean;
  favorites: Favorite[];
  history: HistoryEntry[];
  saved: SavedItem[];
  settings: Settings;
  counts: { favorites: number; history: number; saved: number };
}

/**
 * Compute the rows to insert for a given mode. replace = every imported row
 * (the caller clears the stores first); merge = only rows whose url is not already
 * present. settings is carried through verbatim (the caller does set()).
 */
export function planImport(
  payload: ExportPayload,
  existing: ExistingData,
  mode: ImportMode,
): ImportPlan {
  const replace = mode === 'replace';
  if (replace) {
    return {
      replace: true,
      favorites: payload.favorites,
      history: payload.history,
      saved: payload.saved,
      settings: payload.settings,
      counts: {
        favorites: payload.favorites.length,
        history: payload.history.length,
        saved: payload.saved.length,
      },
    };
  }
  const haveFav = new Set(existing.favorites.map((f) => f.url));
  const haveSaved = new Set(existing.saved.map((s) => s.url));
  const favorites = payload.favorites.filter((f) => !haveFav.has(f.url));
  const history = payload.history.filter((h) => !existing.historyUrls.has(h.url));
  const saved = payload.saved.filter((s) => !haveSaved.has(s.url));
  return {
    replace: false,
    favorites,
    history,
    saved,
    settings: payload.settings,
    counts: { favorites: favorites.length, history: history.length, saved: saved.length },
  };
}
