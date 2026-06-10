// electron/main/db/sqlite.ts
import Database from 'better-sqlite3';

/**
 * Open (or create) a better-sqlite3 database at `dbPath`. Pass ':memory:' in
 * tests. WAL is enabled for durable, concurrent-friendly writes in the app.
 */
export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Create the Phase-0 schema. Idempotent: uses IF NOT EXISTS so re-running on an
 * existing DB neither throws nor drops data. Phase 0 only needs `settings`
 * (key/value JSON store); later phases add tables here.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS adblock_config (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      enabled   INTEGER NOT NULL DEFAULT 1,
      allowlist TEXT    NOT NULL DEFAULT '[]'
    );
    INSERT OR IGNORE INTO adblock_config (id, enabled, allowlist) VALUES (1, 1, '[]');

    CREATE TABLE IF NOT EXISTS filter_subscriptions (
      listId      TEXT PRIMARY KEY,
      url         TEXT    NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      lastUpdated INTEGER,
      etag        TEXT,
      hash        TEXT
    );
  `);
}
