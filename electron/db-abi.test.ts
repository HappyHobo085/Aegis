import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('better-sqlite3 Node ABI', () => {
  it('loads under Vitest (Node ABI) and round-trips a value through :memory:', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('hello', 'world');
    const row = db.prepare('SELECT v FROM t WHERE k = ?').get('hello') as { v: string } | undefined;
    expect(row?.v).toBe('world');
    db.close();
  });
});
