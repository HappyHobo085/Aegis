import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { FavoritesRepo } from './favoritesRepo';

describe('favoritesRepo', () => {
  let db: Database.Database;
  let repo: FavoritesRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new FavoritesRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('list / add', () => {
    it('starts empty', () => {
      expect(repo.list()).toEqual([]);
    });

    it('adds a favorite, assigning position 0 to the first row', () => {
      const list = repo.add({ name: 'Example', url: 'https://example.com/' });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        name: 'Example',
        url: 'https://example.com/',
        position: 0,
      });
      expect(typeof list[0].id).toBe('number');
    });

    it('assigns the next position (max+1) to each new row', () => {
      repo.add({ name: 'A', url: 'https://a.test/' });
      repo.add({ name: 'B', url: 'https://b.test/' });
      const list = repo.list();
      expect(list.map((f) => f.position)).toEqual([0, 1]);
    });

    it('orders by position then id', () => {
      repo.add({ name: 'A', url: 'https://a.test/' });
      repo.add({ name: 'B', url: 'https://b.test/' });
      repo.add({ name: 'C', url: 'https://c.test/' });
      expect(repo.list().map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('update', () => {
    it('patches name/url and leaves unspecified fields intact', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/' })[0].id;
      repo.update(id, { name: 'A2' });
      let f = repo.list()[0];
      expect(f).toMatchObject({ name: 'A2', url: 'https://a.test/' });

      repo.update(id, { url: 'https://a2.test/' });
      f = repo.list()[0];
      expect(f).toMatchObject({ name: 'A2', url: 'https://a2.test/' });
    });

    it('returns the updated list', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/' })[0].id;
      const list = repo.update(id, { name: 'A2' });
      expect(list[0].name).toBe('A2');
    });
  });

  describe('remove', () => {
    it('removes a favorite and returns the remaining list', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/' })[0].id;
      repo.add({ name: 'B', url: 'https://b.test/' });
      const list = repo.remove(id);
      expect(list.map((f) => f.name)).toEqual(['B']);
    });
  });

  describe('reorder', () => {
    it('sets position by index of the provided id order', () => {
      repo.add({ name: 'A', url: 'https://a.test/' });
      repo.add({ name: 'B', url: 'https://b.test/' });
      repo.add({ name: 'C', url: 'https://c.test/' });
      const all = repo.list();
      const a = all.find((f) => f.name === 'A')!.id;
      const b = all.find((f) => f.name === 'B')!.id;
      const c = all.find((f) => f.name === 'C')!.id;
      const list = repo.reorder([c, a, b]);
      expect(list.map((f) => f.name)).toEqual(['C', 'A', 'B']);
      expect(list.map((f) => f.position)).toEqual([0, 1, 2]);
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.add({ name: 'A', url: 'https://a.test/' });
    const repo2 = new FavoritesRepo(db);
    expect(repo2.list()[0]).toMatchObject({ name: 'A' });
  });

  describe('clear', () => {
    it('removes every favorite (replace-import support)', () => {
      repo.add({ name: 'A', url: 'https://a.test/' });
      repo.add({ name: 'B', url: 'https://b.test/' });
      repo.clear();
      expect(repo.list()).toEqual([]);
    });

    it('is a no-op on an already-empty table', () => {
      repo.clear();
      expect(repo.list()).toEqual([]);
    });

    it('lets a freshly-added favorite start again at position 0 after clear', () => {
      repo.add({ name: 'A', url: 'https://a.test/' });
      repo.clear();
      const list = repo.add({ name: 'C', url: 'https://c.test/' });
      expect(list).toHaveLength(1);
      expect(list[0].position).toBe(0);
    });
  });
});
