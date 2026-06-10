import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { SubsRepo } from './subsRepo';

const DEFAULTS = [
  { listId: 'easylist', url: 'https://example.test/easylist.txt' },
  { listId: 'easyprivacy', url: 'https://example.test/easyprivacy.txt' },
];

describe('subsRepo', () => {
  let db: Database.Database;
  let repo: SubsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new SubsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('all (empty)', () => {
    it('returns [] before any seeding', () => {
      expect(repo.all()).toEqual([]);
    });
  });

  describe('seedDefaults', () => {
    it('inserts the defaults enabled with null metadata', () => {
      repo.seedDefaults(DEFAULTS);
      const all = repo.all();
      expect(all).toHaveLength(2);
      const byId = Object.fromEntries(all.map((s) => [s.listId, s]));
      expect(byId.easylist).toEqual({
        listId: 'easylist',
        url: 'https://example.test/easylist.txt',
        enabled: true,
        lastUpdated: null,
        etag: null,
        hash: null,
      });
    });

    it('is idempotent (INSERT OR IGNORE) — re-seeding does not duplicate or clobber', () => {
      repo.seedDefaults(DEFAULTS);
      repo.updateMeta('easylist', { lastUpdated: 111, etag: 'W/"x"', hash: 'abc' });
      repo.seedDefaults(DEFAULTS); // second seed must not reset metadata
      const all = repo.all();
      expect(all).toHaveLength(2);
      const easylist = all.find((s) => s.listId === 'easylist')!;
      expect(easylist.lastUpdated).toBe(111);
      expect(easylist.etag).toBe('W/"x"');
      expect(easylist.hash).toBe('abc');
    });
  });

  describe('updateMeta', () => {
    it('records lastUpdated/etag/hash for a list (etag may be null)', () => {
      repo.seedDefaults(DEFAULTS);
      repo.updateMeta('easyprivacy', { lastUpdated: 222, etag: null, hash: 'deadbeef' });
      const ep = repo.all().find((s) => s.listId === 'easyprivacy')!;
      expect(ep.lastUpdated).toBe(222);
      expect(ep.etag).toBeNull();
      expect(ep.hash).toBe('deadbeef');
    });

    it('persists across repo instances on the same db', () => {
      repo.seedDefaults(DEFAULTS);
      repo.updateMeta('easylist', { lastUpdated: 333, etag: 'e', hash: 'h' });
      const repo2 = new SubsRepo(db);
      const easylist = repo2.all().find((s) => s.listId === 'easylist')!;
      expect(easylist.lastUpdated).toBe(333);
      expect(easylist.hash).toBe('h');
    });
  });
});
