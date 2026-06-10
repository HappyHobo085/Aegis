import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { HistoryRepo } from './historyRepo';

describe('historyRepo', () => {
  let db: Database.Database;
  let repo: HistoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new HistoryRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('record', () => {
    it('inserts a new entry with the provided timestamp', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      const list = repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ url: 'https://a.test/', title: 'A', visitedAt: 1000 });
      expect(typeof list[0].id).toBe('number');
    });

    it('dedups vs the most-recent row: same url updates visitedAt instead of inserting', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 2000);
      const list = repo.list();
      expect(list).toHaveLength(1);
      expect(list[0].visitedAt).toBe(2000);
    });

    it('updates the most-recent title on dedup only when the new title is non-empty', () => {
      repo.record({ url: 'https://a.test/', title: 'Old' }, () => 1000);
      repo.record({ url: 'https://a.test/', title: '' }, () => 2000);
      expect(repo.mostRecent()?.title).toBe('Old');
      repo.record({ url: 'https://a.test/', title: 'New' }, () => 3000);
      expect(repo.mostRecent()?.title).toBe('New');
    });

    it('inserts a new row when the url differs from the most-recent', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      const list = repo.list();
      expect(list).toHaveLength(2);
      // newest first
      expect(list[0]).toMatchObject({ url: 'https://b.test/', visitedAt: 2000 });
      expect(list[1]).toMatchObject({ url: 'https://a.test/', visitedAt: 1000 });
    });

    it('re-records a url that is no longer the most-recent as a new row', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 3000);
      expect(repo.list()).toHaveLength(3);
    });

    it('trims to the newest 500 rows after insert', () => {
      for (let i = 0; i < 505; i++) {
        repo.record({ url: `https://site${i}.test/`, title: `T${i}` }, () => 1000 + i);
      }
      const list = repo.list({ limit: 1000 });
      expect(list).toHaveLength(500);
      // newest kept; oldest trimmed
      expect(list[0].url).toBe('https://site504.test/');
      expect(list.some((e) => e.url === 'https://site0.test/')).toBe(false);
      expect(list.some((e) => e.url === 'https://site4.test/')).toBe(false);
      expect(list.some((e) => e.url === 'https://site5.test/')).toBe(true);
    });
  });

  describe('setMostRecentTitle', () => {
    it('updates the most-recent row title when its url matches and the title is non-empty', () => {
      repo.record({ url: 'https://a.test/', title: '' }, () => 1000);
      repo.setMostRecentTitle('https://a.test/', 'Later Title', () => 2000);
      expect(repo.mostRecent()?.title).toBe('Later Title');
    });

    it('is a no-op when the url does not match the most-recent row', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.setMostRecentTitle('https://b.test/', 'B', () => 2000);
      expect(repo.mostRecent()?.title).toBe('A');
    });

    it('is a no-op when the title is empty', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.setMostRecentTitle('https://a.test/', '', () => 2000);
      expect(repo.mostRecent()?.title).toBe('A');
    });
  });

  describe('list', () => {
    it('orders by visitedAt DESC and applies limit/offset', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.record({ url: 'https://c.test/', title: 'C' }, () => 3000);
      expect(repo.list().map((e) => e.url)).toEqual([
        'https://c.test/',
        'https://b.test/',
        'https://a.test/',
      ]);
      expect(repo.list({ limit: 2 }).map((e) => e.url)).toEqual([
        'https://c.test/',
        'https://b.test/',
      ]);
      expect(repo.list({ limit: 2, offset: 1 }).map((e) => e.url)).toEqual([
        'https://b.test/',
        'https://a.test/',
      ]);
    });
  });

  describe('search', () => {
    it('matches url or title (case-insensitive LIKE), newest first', () => {
      repo.record({ url: 'https://example.com/news', title: 'Daily News' }, () => 1000);
      repo.record({ url: 'https://other.test/', title: 'Recipes' }, () => 2000);
      repo.record({ url: 'https://example.com/sport', title: 'Sport' }, () => 3000);
      expect(repo.search('example').map((e) => e.url)).toEqual([
        'https://example.com/sport',
        'https://example.com/news',
      ]);
      expect(repo.search('news').map((e) => e.title)).toEqual(['Daily News']);
    });
  });

  describe('remove / clear', () => {
    it('removes a single row by id', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      const id = repo.list()[0].id; // b.test
      repo.remove(id);
      expect(repo.list().map((e) => e.url)).toEqual(['https://a.test/']);
    });

    it('clears all rows', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.clear();
      expect(repo.list()).toEqual([]);
    });
  });

  describe('mostRecent', () => {
    it('returns undefined when empty and the newest row otherwise', () => {
      expect(repo.mostRecent()).toBeUndefined();
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      expect(repo.mostRecent()).toMatchObject({ url: 'https://b.test/', visitedAt: 2000 });
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
    const repo2 = new HistoryRepo(db);
    expect(repo2.mostRecent()).toMatchObject({ url: 'https://a.test/' });
  });
});
