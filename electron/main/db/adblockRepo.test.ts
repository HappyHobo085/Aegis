import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { AdblockRepo } from './adblockRepo';

describe('adblockRepo', () => {
  let db: Database.Database;
  let repo: AdblockRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new AdblockRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('getState', () => {
    it('defaults to enabled=true and an empty allowlist (seeded singleton)', () => {
      expect(repo.getState()).toEqual({ enabled: true, allowlistedHosts: [] });
    });
  });

  describe('setEnabled', () => {
    it('persists the global toggle', () => {
      repo.setEnabled(false);
      expect(repo.getState().enabled).toBe(false);
      repo.setEnabled(true);
      expect(repo.getState().enabled).toBe(true);
    });

    it('persists across repo instances on the same db', () => {
      repo.setEnabled(false);
      const repo2 = new AdblockRepo(db);
      expect(repo2.getState().enabled).toBe(false);
    });
  });

  describe('toggleAllowlist', () => {
    it('adds a host then removes it, returning the new allowlist each time', () => {
      const added = repo.toggleAllowlist('example.com');
      expect(added).toEqual(['example.com']);
      expect(repo.getState().allowlistedHosts).toEqual(['example.com']);

      const removed = repo.toggleAllowlist('example.com');
      expect(removed).toEqual([]);
      expect(repo.getState().allowlistedHosts).toEqual([]);
    });

    it('accumulates multiple distinct hosts', () => {
      repo.toggleAllowlist('a.com');
      const list = repo.toggleAllowlist('b.com');
      expect(list).toContain('a.com');
      expect(list).toContain('b.com');
      expect(list).toHaveLength(2);
    });
  });

  describe('isAllowlisted', () => {
    it('reflects toggleAllowlist state', () => {
      expect(repo.isAllowlisted('example.com')).toBe(false);
      repo.toggleAllowlist('example.com');
      expect(repo.isAllowlisted('example.com')).toBe(true);
      repo.toggleAllowlist('example.com');
      expect(repo.isAllowlisted('example.com')).toBe(false);
    });
  });

  describe('removeAllowlist', () => {
    it('removes a single host, returning the new allowlist', () => {
      repo.toggleAllowlist('a.com');
      repo.toggleAllowlist('b.com');
      const next = repo.removeAllowlist('a.com');
      expect(next).toEqual(['b.com']);
      expect(repo.getState().allowlistedHosts).toEqual(['b.com']);
    });

    it('removing an absent host is a no-op', () => {
      repo.toggleAllowlist('a.com');
      const next = repo.removeAllowlist('not-there.com');
      expect(next).toEqual(['a.com']);
    });

    it('persists across repo instances on the same db', () => {
      repo.toggleAllowlist('a.com');
      repo.toggleAllowlist('b.com');
      repo.removeAllowlist('a.com');
      const repo2 = new AdblockRepo(db);
      expect(repo2.getState().allowlistedHosts).toEqual(['b.com']);
    });
  });

  describe('clearAllowlist', () => {
    it('empties the allowlist, returning []', () => {
      repo.toggleAllowlist('a.com');
      repo.toggleAllowlist('b.com');
      const next = repo.clearAllowlist();
      expect(next).toEqual([]);
      expect(repo.getState().allowlistedHosts).toEqual([]);
    });

    it('clearing an already-empty allowlist is a no-op', () => {
      const next = repo.clearAllowlist();
      expect(next).toEqual([]);
    });
  });
});
