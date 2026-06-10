import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { DownloadsRepo } from './downloadsRepo';

function sampleInput(over: Partial<Parameters<DownloadsRepo['record']>[0]> = {}) {
  return {
    url: 'https://a.test/file.zip',
    filename: 'file.zip',
    savePath: '/home/u/Downloads/file.zip',
    state: 'progressing' as const,
    receivedBytes: 0,
    totalBytes: 1000,
    startedAt: 1000,
    ...over,
  };
}

describe('downloadsRepo', () => {
  let db: Database.Database;
  let repo: DownloadsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new DownloadsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('list / record', () => {
    it('starts empty', () => {
      expect(repo.list()).toEqual([]);
    });

    it('records a download and returns the inserted row with a numeric id', () => {
      const row = repo.record(sampleInput());
      expect(typeof row.id).toBe('number');
      expect(row).toMatchObject({
        url: 'https://a.test/file.zip',
        filename: 'file.zip',
        savePath: '/home/u/Downloads/file.zip',
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: 1000,
        startedAt: 1000,
      });
    });

    it('lists newest first (startedAt DESC, id DESC)', () => {
      repo.record(sampleInput({ url: 'https://a.test/1', startedAt: 1000 }));
      repo.record(sampleInput({ url: 'https://a.test/2', startedAt: 2000 }));
      repo.record(sampleInput({ url: 'https://a.test/3', startedAt: 3000 }));
      expect(repo.list().map((d) => d.url)).toEqual([
        'https://a.test/3',
        'https://a.test/2',
        'https://a.test/1',
      ]);
    });
  });

  describe('get', () => {
    it('returns the row by id, or undefined when absent', () => {
      const row = repo.record(sampleInput());
      expect(repo.get(row.id)).toMatchObject({ id: row.id, filename: 'file.zip' });
      expect(repo.get(9999)).toBeUndefined();
    });
  });

  describe('update', () => {
    it('patches only the supplied fields, leaving the rest intact', () => {
      const row = repo.record(sampleInput());
      repo.update(row.id, { receivedBytes: 500, totalBytes: 1000, state: 'progressing' });
      expect(repo.get(row.id)).toMatchObject({
        receivedBytes: 500,
        totalBytes: 1000,
        state: 'progressing',
        filename: 'file.zip',
      });
      repo.update(row.id, { state: 'completed', receivedBytes: 1000 });
      const after = repo.get(row.id)!;
      expect(after.state).toBe('completed');
      expect(after.receivedBytes).toBe(1000);
      expect(after.totalBytes).toBe(1000);
    });

    it('is a no-op patch when called with an empty partial', () => {
      const row = repo.record(sampleInput());
      repo.update(row.id, {});
      expect(repo.get(row.id)).toMatchObject({ state: 'progressing', receivedBytes: 0 });
    });
  });

  describe('remove / clear', () => {
    it('removes one row by id', () => {
      const a = repo.record(sampleInput({ url: 'https://a.test/a' }));
      repo.record(sampleInput({ url: 'https://a.test/b' }));
      repo.remove(a.id);
      expect(repo.list().map((d) => d.url)).toEqual(['https://a.test/b']);
    });

    it('clears every row', () => {
      repo.record(sampleInput({ url: 'https://a.test/a' }));
      repo.record(sampleInput({ url: 'https://a.test/b' }));
      repo.clear();
      expect(repo.list()).toEqual([]);
    });
  });

  it('persists across repo instances on the same db', () => {
    const row = repo.record(sampleInput());
    const repo2 = new DownloadsRepo(db);
    expect(repo2.get(row.id)).toMatchObject({ filename: 'file.zip' });
  });
});
