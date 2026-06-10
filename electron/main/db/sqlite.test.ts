// electron/main/db/sqlite.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';

describe('sqlite', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    if (db) {
      db.close();
      db = undefined;
    }
  });

  describe('openDb', () => {
    it('opens an in-memory database that round-trips a value', () => {
      db = openDb(':memory:');
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('hi');
      const row = db.prepare('SELECT v FROM t').get() as { v: string };
      expect(row.v).toBe('hi');
    });
  });

  describe('runMigrations', () => {
    it('creates the settings table', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('settings');
    });

    it('settings table has key (PK) and value columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const cols = (db.prepare('PRAGMA table_info(settings)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('key');
      expect(cols).toHaveProperty('value');
      expect(cols.key).toBe(1); // key is the primary key
    });

    it('is idempotent (running twice does not throw and preserves data)', () => {
      db = openDb(':memory:');
      runMigrations(db);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('siteName', '"Aegis"');
      expect(() => runMigrations(db!)).not.toThrow();
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('siteName') as
        | { value: string }
        | undefined;
      expect(row?.value).toBe('"Aegis"');
    });

    it('creates the adblock_config table with a seeded singleton row', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='adblock_config'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('adblock_config');
      const row = db.prepare('SELECT enabled, allowlist FROM adblock_config WHERE id = 1').get() as
        | { enabled: number; allowlist: string }
        | undefined;
      expect(row?.enabled).toBe(1);
      expect(JSON.parse(row!.allowlist)).toEqual([]);
    });

    it('creates the filter_subscriptions table with the expected columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='filter_subscriptions'",
        )
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('filter_subscriptions');
      const cols = (db.prepare('PRAGMA table_info(filter_subscriptions)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('listId');
      expect(cols).toHaveProperty('url');
      expect(cols).toHaveProperty('enabled');
      expect(cols).toHaveProperty('lastUpdated');
      expect(cols).toHaveProperty('etag');
      expect(cols).toHaveProperty('hash');
      expect(cols.listId).toBe(1); // listId is the primary key
    });

    it('creates the favorites table with the expected columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='favorites'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('favorites');
      const cols = (db.prepare('PRAGMA table_info(favorites)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('id');
      expect(cols).toHaveProperty('name');
      expect(cols).toHaveProperty('url');
      expect(cols).toHaveProperty('tags');
      expect(cols).toHaveProperty('position');
      expect(cols.id).toBe(1); // id is the primary key
    });

    it('creates the history table with the expected columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('history');
      const cols = (db.prepare('PRAGMA table_info(history)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('id');
      expect(cols).toHaveProperty('url');
      expect(cols).toHaveProperty('title');
      expect(cols).toHaveProperty('visitedAt');
      expect(cols.id).toBe(1); // id is the primary key
    });

    it('creates the saved_list table with the expected columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_list'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('saved_list');
      const cols = (db.prepare('PRAGMA table_info(saved_list)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('id');
      expect(cols).toHaveProperty('url');
      expect(cols).toHaveProperty('title');
      expect(cols).toHaveProperty('savedAt');
      expect(cols.id).toBe(1); // id is the primary key
    });
  });
});
