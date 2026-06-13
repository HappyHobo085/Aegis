import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { HttpExceptionsRepo } from './httpExceptionsRepo';

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
});
afterEach(() => db.close());

describe('HttpExceptionsRepo', () => {
  it('has() is false for an unknown host', () => {
    expect(new HttpExceptionsRepo(db).has('example.com')).toBe(false);
  });

  it('add() makes has() true', () => {
    const repo = new HttpExceptionsRepo(db);
    repo.add('example.com');
    expect(repo.has('example.com')).toBe(true);
  });

  it('add() is idempotent', () => {
    const repo = new HttpExceptionsRepo(db);
    repo.add('example.com');
    repo.add('example.com');
    expect(repo.list()).toEqual(['example.com']);
  });

  it('remove() clears the exception', () => {
    const repo = new HttpExceptionsRepo(db);
    repo.add('example.com');
    repo.remove('example.com');
    expect(repo.has('example.com')).toBe(false);
  });

  it('list() returns hosts (newest first)', () => {
    const repo = new HttpExceptionsRepo(db);
    repo.add('a.com');
    repo.add('b.com');
    expect(repo.list()).toContain('a.com');
    expect(repo.list()).toContain('b.com');
    expect(repo.list().length).toBe(2);
  });

  it('persists across repo instances on the same db', () => {
    new HttpExceptionsRepo(db).add('example.com');
    expect(new HttpExceptionsRepo(db).has('example.com')).toBe(true);
  });
});
