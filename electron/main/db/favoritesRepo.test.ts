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
      const list = repo.add({ name: 'Example', url: 'https://example.com/', tags: ['news'] });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        name: 'Example',
        url: 'https://example.com/',
        tags: ['news'],
        position: 0,
      });
      expect(typeof list[0].id).toBe('number');
    });

    it('assigns the next position (max+1) to each new row', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: [] });
      const list = repo.list();
      expect(list.map((f) => f.position)).toEqual([0, 1]);
    });

    it('orders by position then id', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: [] });
      repo.add({ name: 'C', url: 'https://c.test/', tags: [] });
      expect(repo.list().map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });

    it('persists tags as JSON and round-trips them', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['x', 'y'] });
      expect(repo.list()[0].tags).toEqual(['x', 'y']);
    });

    it('falls back to [] for a corrupt tags column', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['x'] });
      const id = repo.list()[0].id;
      db.prepare('UPDATE favorites SET tags = ? WHERE id = ?').run('not json', id);
      expect(repo.list()[0].tags).toEqual([]);
    });
  });

  describe('update', () => {
    it('patches name/url/tags and leaves unspecified fields intact', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/', tags: ['x'] })[0].id;
      repo.update(id, { name: 'A2' });
      let f = repo.list()[0];
      expect(f).toMatchObject({ name: 'A2', url: 'https://a.test/', tags: ['x'] });

      repo.update(id, { url: 'https://a2.test/', tags: ['y', 'z'] });
      f = repo.list()[0];
      expect(f).toMatchObject({ name: 'A2', url: 'https://a2.test/', tags: ['y', 'z'] });
    });

    it('returns the updated list', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/', tags: [] })[0].id;
      const list = repo.update(id, { name: 'A2' });
      expect(list[0].name).toBe('A2');
    });
  });

  describe('remove', () => {
    it('removes a favorite and returns the remaining list', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/', tags: [] })[0].id;
      repo.add({ name: 'B', url: 'https://b.test/', tags: [] });
      const list = repo.remove(id);
      expect(list.map((f) => f.name)).toEqual(['B']);
    });
  });

  describe('reorder', () => {
    it('sets position by index of the provided id order', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: [] });
      repo.add({ name: 'C', url: 'https://c.test/', tags: [] });
      const all = repo.list();
      const a = all.find((f) => f.name === 'A')!.id;
      const b = all.find((f) => f.name === 'B')!.id;
      const c = all.find((f) => f.name === 'C')!.id;
      const list = repo.reorder([c, a, b]);
      expect(list.map((f) => f.name)).toEqual(['C', 'A', 'B']);
      expect(list.map((f) => f.position)).toEqual([0, 1, 2]);
    });
  });

  describe('tagUnion', () => {
    it('returns the distinct sorted union of all tags', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['news', 'tech'] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: ['tech', 'fun'] });
      expect(repo.tagUnion()).toEqual(['fun', 'news', 'tech']);
    });

    it('is empty when no favorite has tags', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      expect(repo.tagUnion()).toEqual([]);
    });
  });

  describe('renameTag', () => {
    it('renames the tag in every favorite that has it', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['news', 'tech'] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: ['tech'] });
      repo.add({ name: 'C', url: 'https://c.test/', tags: ['fun'] });
      const list = repo.renameTag('tech', 'technology');
      const byName = Object.fromEntries(list.map((f) => [f.name, f.tags]));
      expect(byName.A).toEqual(['news', 'technology']);
      expect(byName.B).toEqual(['technology']);
      expect(byName.C).toEqual(['fun']);
    });

    it('does not duplicate when the new tag already exists on a row', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['old', 'new'] });
      const list = repo.renameTag('old', 'new');
      expect(list[0].tags).toEqual(['new']);
    });
  });

  describe('deleteTag', () => {
    it('removes the tag from every favorite that has it', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['news', 'tech'] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: ['tech'] });
      const list = repo.deleteTag('tech');
      const byName = Object.fromEntries(list.map((f) => [f.name, f.tags]));
      expect(byName.A).toEqual(['news']);
      expect(byName.B).toEqual([]);
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.add({ name: 'A', url: 'https://a.test/', tags: ['x'] });
    const repo2 = new FavoritesRepo(db);
    expect(repo2.list()[0]).toMatchObject({ name: 'A', tags: ['x'] });
  });
});
