// electron/main/db/customFiltersRepo.ts
import type Database from 'better-sqlite3';

/**
 * Reads/writes the `custom_filters` singleton (row id = 1, seeded by
 * runMigrations): the user's my-filters blob (uBlock-syntax network + cosmetic
 * rules) stored as a single text value. Mirrors the adblock_config singleton
 * pattern so callers never reason about ids.
 */
export class CustomFiltersRepo {
  private readonly selectText: Database.Statement;
  private readonly setTextStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectText = db.prepare('SELECT text FROM custom_filters WHERE id = 1');
    this.setTextStmt = db.prepare('UPDATE custom_filters SET text = @text WHERE id = 1');
  }

  /** The stored my-filters text. Empty string when unset (seeded default). */
  get(): string {
    const row = this.selectText.get() as { text: string } | undefined;
    return row?.text ?? '';
  }

  /** Persist the my-filters text (overwrites; the store is a singleton). */
  set(text: string): void {
    this.setTextStmt.run({ text });
  }
}
