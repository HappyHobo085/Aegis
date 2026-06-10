// electron/main/db/savedRepo.ts
import type Database from 'better-sqlite3';
import type { SavedItem } from '../../../shared/types';

/**
 * Reads/writes the `saved_list` table (the manually curated reading list,
 * distinct from auto-recorded history). `add` stamps savedAt (injectable for
 * test determinism); mutating methods return the full list (newest first) so
 * the IPC layer can push fresh state to the renderer.
 */
export class SavedRepo {
  private readonly selectAll: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly hasStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare(
      'SELECT id, url, title, savedAt FROM saved_list ORDER BY savedAt DESC, id DESC',
    );
    this.insertStmt = db.prepare(
      'INSERT INTO saved_list (url, title, savedAt) VALUES (@url, @title, @savedAt)',
    );
    this.deleteStmt = db.prepare('DELETE FROM saved_list WHERE id = @id');
    this.hasStmt = db.prepare('SELECT 1 FROM saved_list WHERE url = @url LIMIT 1');
    this.clearStmt = db.prepare('DELETE FROM saved_list');
  }

  /** All saved items, newest first. */
  list(): SavedItem[] {
    return this.selectAll.all() as SavedItem[];
  }

  /** Add a saved item stamped with savedAt = now(). Returns the new list. */
  add(input: { url: string; title: string }, now: () => number = Date.now): SavedItem[] {
    this.insertStmt.run({ url: input.url, title: input.title, savedAt: now() });
    return this.list();
  }

  /** Remove one saved item by id. Returns the remaining list. */
  remove(id: number): SavedItem[] {
    this.deleteStmt.run({ id });
    return this.list();
  }

  /** True iff some saved item has this url. */
  has(url: string): boolean {
    return this.hasStmt.get({ url }) !== undefined;
  }

  /** Remove every saved item (used by replace-import). */
  clear(): void {
    this.clearStmt.run();
  }
}
