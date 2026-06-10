// electron/main/db/settingsRepo.ts
import type Database from 'better-sqlite3';
import type { Settings } from '../../../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [
    { id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
    { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
    { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  ],
  hideChromeByDefault: false,
  downloadDir: '',
};

/**
 * Reads/writes Settings as individual JSON-encoded rows in the `settings`
 * key/value table. `get()` merges any stored keys over DEFAULT_SETTINGS, so a
 * missing or partially-populated DB always yields a complete Settings object.
 */
export class SettingsRepo {
  private readonly selectAll: Database.Statement;
  private readonly upsert: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare('SELECT key, value FROM settings');
    this.upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (@key, @value) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
  }

  /** Merge stored settings over the defaults; always returns a full Settings. */
  get(): Settings {
    const rows = this.selectAll.all() as Array<{ key: string; value: string }>;
    const stored: Partial<Settings> = {};
    for (const { key, value } of rows) {
      try {
        (stored as Record<string, unknown>)[key] = JSON.parse(value);
      } catch {
        // Corrupt row: skip it; DEFAULT_SETTINGS provides the fallback value.
      }
    }
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  /** Persist a partial update (each key as its own JSON row); return merged. */
  set(partial: Partial<Settings>): Settings {
    const writeAll = this.db.transaction((entries: Array<[string, unknown]>) => {
      for (const [key, value] of entries) {
        if (value === undefined) continue; // never persist undefined
        this.upsert.run({ key, value: JSON.stringify(value) });
      }
    });
    writeAll(Object.entries(partial));
    return this.get();
  }
}
