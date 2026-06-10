import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { PermissionsRepo } from './permissionsRepo';

describe('permissionsRepo', () => {
  let db: Database.Database;
  let repo: PermissionsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new PermissionsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('get / set', () => {
    it('returns undefined for an unknown (origin, permission)', () => {
      expect(repo.get('https://a.test', 'geolocation')).toBeUndefined();
    });

    it('stores and reads back a decision', () => {
      repo.set('https://a.test', 'geolocation', 'allow');
      expect(repo.get('https://a.test', 'geolocation')).toBe('allow');
    });

    it('keys by both origin and permission independently', () => {
      repo.set('https://a.test', 'geolocation', 'allow');
      repo.set('https://a.test', 'notifications', 'deny');
      repo.set('https://b.test', 'geolocation', 'deny');
      expect(repo.get('https://a.test', 'geolocation')).toBe('allow');
      expect(repo.get('https://a.test', 'notifications')).toBe('deny');
      expect(repo.get('https://b.test', 'geolocation')).toBe('deny');
    });

    it('upserts: re-setting the same key overwrites the decision', () => {
      repo.set('https://a.test', 'geolocation', 'deny');
      repo.set('https://a.test', 'geolocation', 'allow');
      expect(repo.get('https://a.test', 'geolocation')).toBe('allow');
      expect(repo.list()).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('lists all rows ordered by origin then permission', () => {
      repo.set('https://b.test', 'media', 'allow');
      repo.set('https://a.test', 'notifications', 'deny');
      repo.set('https://a.test', 'geolocation', 'allow');
      expect(repo.list()).toEqual([
        { origin: 'https://a.test', permission: 'geolocation', decision: 'allow' },
        { origin: 'https://a.test', permission: 'notifications', decision: 'deny' },
        { origin: 'https://b.test', permission: 'media', decision: 'allow' },
      ]);
    });
  });

  describe('remove / clear', () => {
    it('removes one (origin, permission) row, leaving others', () => {
      repo.set('https://a.test', 'geolocation', 'allow');
      repo.set('https://a.test', 'notifications', 'deny');
      repo.remove('https://a.test', 'geolocation');
      expect(repo.get('https://a.test', 'geolocation')).toBeUndefined();
      expect(repo.get('https://a.test', 'notifications')).toBe('deny');
    });

    it('clears every row', () => {
      repo.set('https://a.test', 'geolocation', 'allow');
      repo.set('https://b.test', 'media', 'deny');
      repo.clear();
      expect(repo.list()).toEqual([]);
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.set('https://a.test', 'geolocation', 'allow');
    const repo2 = new PermissionsRepo(db);
    expect(repo2.get('https://a.test', 'geolocation')).toBe('allow');
  });
});
