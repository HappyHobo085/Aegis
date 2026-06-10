import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { SubsRepo } from './subsRepo';
import { listIdFromUrl } from '../adblock/engine';

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

  describe('setEnabled', () => {
    it('flips a list enabled flag, reflected by all()', () => {
      repo.seedDefaults(DEFAULTS);
      repo.setEnabled('easylist', false);
      const easylist = repo.all().find((s) => s.listId === 'easylist')!;
      expect(easylist.enabled).toBe(false);
      repo.setEnabled('easylist', true);
      expect(repo.all().find((s) => s.listId === 'easylist')!.enabled).toBe(true);
    });

    it('leaves other lists untouched', () => {
      repo.seedDefaults(DEFAULTS);
      repo.setEnabled('easylist', false);
      const ep = repo.all().find((s) => s.listId === 'easyprivacy')!;
      expect(ep.enabled).toBe(true);
    });

    it('persists across repo instances on the same db', () => {
      repo.seedDefaults(DEFAULTS);
      repo.setEnabled('easylist', false);
      const repo2 = new SubsRepo(db);
      expect(repo2.all().find((s) => s.listId === 'easylist')!.enabled).toBe(false);
    });
  });

  describe('add', () => {
    it('inserts a custom list (enabled, listId derived from url) and returns all()', () => {
      const all = repo.add('https://lists.test/my-custom-list.txt');
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual({
        listId: 'my-custom-list',
        url: 'https://lists.test/my-custom-list.txt',
        enabled: true,
        lastUpdated: null,
        etag: null,
        hash: null,
      });
      expect(all[0].listId).toBe(listIdFromUrl('https://lists.test/my-custom-list.txt'));
    });

    it('is INSERT OR IGNORE on duplicate listId (no clobber of metadata)', () => {
      repo.add('https://lists.test/dup.txt');
      repo.updateMeta('dup', { lastUpdated: 99, etag: 'e', hash: 'h' });
      const all = repo.add('https://lists.test/dup.txt'); // same derived listId
      expect(all).toHaveLength(1);
      expect(all[0].lastUpdated).toBe(99);
      expect(all[0].hash).toBe('h');
    });
  });

  describe('remove', () => {
    it('deletes a list by listId and returns all()', () => {
      repo.seedDefaults(DEFAULTS);
      const all = repo.remove('easylist');
      expect(all).toHaveLength(1);
      expect(all.map((s) => s.listId)).toEqual(['easyprivacy']);
    });

    it('removing an unknown listId is a no-op', () => {
      repo.seedDefaults(DEFAULTS);
      const all = repo.remove('does-not-exist');
      expect(all).toHaveLength(2);
    });
  });
});
