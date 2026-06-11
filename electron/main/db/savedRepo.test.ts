import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { SavedRepo } from './savedRepo';

describe('savedRepo', () => {
  let db: Database.Database;
  let repo: SavedRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new SavedRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('list / add', () => {
    it('starts empty', () => {
      expect(repo.list()).toEqual([]);
    });

    it('adds an item with the provided timestamp and returns the list', () => {
      const list = repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ url: 'https://a.test/', title: 'A', savedAt: 1000 });
      expect(typeof list[0].id).toBe('number');
    });

    it('orders by savedAt DESC (newest first)', () => {
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.add({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.add({ url: 'https://c.test/', title: 'C' }, () => 3000);
      expect(repo.list().map((s) => s.url)).toEqual([
        'https://c.test/',
        'https://b.test/',
        'https://a.test/',
      ]);
    });
  });

  describe('remove', () => {
    it('removes one item by id and returns the remaining list', () => {
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.add({ url: 'https://b.test/', title: 'B' }, () => 2000);
      const id = repo.list().find((s) => s.url === 'https://a.test/')!.id;
      const list = repo.remove(id);
      expect(list.map((s) => s.url)).toEqual(['https://b.test/']);
    });
  });

  describe('has', () => {
    it('is true exactly when an item with that url is saved', () => {
      expect(repo.has('https://a.test/')).toBe(false);
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      expect(repo.has('https://a.test/')).toBe(true);
      const id = repo.list()[0].id;
      repo.remove(id);
      expect(repo.has('https://a.test/')).toBe(false);
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
    const repo2 = new SavedRepo(db);
    expect(repo2.has('https://a.test/')).toBe(true);
  });

  describe('update', () => {
    it('updates the title of an existing item and returns the updated list', () => {
      repo.add({ url: 'https://a.test/', title: 'Old Title' }, () => 1000);
      const id = repo.list()[0].id;
      const list = repo.update(id, { title: 'New Title' });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id, url: 'https://a.test/', title: 'New Title', savedAt: 1000 });
    });

    it('is a no-op for a non-existent id (returns list unchanged)', () => {
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      const before = repo.list();
      const list = repo.update(9999, { title: 'Ghost' });
      expect(list).toHaveLength(1);
      expect(list[0].title).toBe('A');
      expect(list).toEqual(before);
    });
  });

  describe('clear', () => {
    it('removes every saved item (replace-import support)', () => {
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.add({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.clear();
      expect(repo.list()).toEqual([]);
      expect(repo.has('https://a.test/')).toBe(false);
    });

    it('is a no-op on an already-empty table', () => {
      repo.clear();
      expect(repo.list()).toEqual([]);
    });
  });
});
