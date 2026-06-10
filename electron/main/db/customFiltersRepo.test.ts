import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { CustomFiltersRepo } from './customFiltersRepo';

describe('customFiltersRepo', () => {
  let db: Database.Database;
  let repo: CustomFiltersRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new CustomFiltersRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('get', () => {
    it('defaults to an empty string (seeded singleton row)', () => {
      expect(repo.get()).toBe('');
    });
  });

  describe('set', () => {
    it('persists the text and reads it back via get()', () => {
      repo.set('||ads.example^\nexample.com##.banner');
      expect(repo.get()).toBe('||ads.example^\nexample.com##.banner');
    });

    it('overwrites the previous value (singleton, never appends)', () => {
      repo.set('first');
      repo.set('second');
      expect(repo.get()).toBe('second');
    });

    it('round-trips an empty string', () => {
      repo.set('something');
      repo.set('');
      expect(repo.get()).toBe('');
    });

    it('persists across repo instances on the same db', () => {
      repo.set('||tracker.test^');
      const repo2 = new CustomFiltersRepo(db);
      expect(repo2.get()).toBe('||tracker.test^');
    });
  });

  describe('migration', () => {
    it('is idempotent: runMigrations again keeps the stored text', () => {
      repo.set('||keep.me^');
      runMigrations(db); // INSERT OR IGNORE must not reset
      expect(new CustomFiltersRepo(db).get()).toBe('||keep.me^');
    });
  });
});
