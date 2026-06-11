// electron/main/db/savedRepo.ts
import type Database from 'better-sqlite3';
import type { SavedItem } from '../../../shared/types';

interface SavedRow {
  id: number;
  url: string;
  title: string;
  tags: string;
  savedAt: number;
}

/** Parse a JSON tags column to string[], falling back to [] on corrupt JSON. */
function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // Corrupt JSON: treat as no tags.
  }
  return [];
}

/**
 * Reads/writes the `saved_list` table (the manually curated reading list,
 * distinct from auto-recorded history). Tags are denormalized as a JSON string[]
 * per row, parsed with a []-fallback. `add` stamps savedAt (injectable for test
 * determinism); mutating methods return the full list (newest first), or for
 * tagUnion the distinct sorted tag set, so the IPC layer can push fresh state.
 */
export class SavedRepo {
  private readonly selectAll: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly hasStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly setTagsStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare(
      'SELECT id, url, title, tags, savedAt FROM saved_list ORDER BY savedAt DESC, id DESC',
    );
    this.selectOne = db.prepare('SELECT id, url, title, tags, savedAt FROM saved_list WHERE id = @id');
    this.insertStmt = db.prepare(
      'INSERT INTO saved_list (url, title, tags, savedAt) VALUES (@url, @title, @tags, @savedAt)',
    );
    this.deleteStmt = db.prepare('DELETE FROM saved_list WHERE id = @id');
    this.hasStmt = db.prepare('SELECT 1 FROM saved_list WHERE url = @url LIMIT 1');
    this.clearStmt = db.prepare('DELETE FROM saved_list');
    this.updateStmt = db.prepare('UPDATE saved_list SET title = @title, tags = @tags WHERE id = @id');
    this.setTagsStmt = db.prepare('UPDATE saved_list SET tags = @tags WHERE id = @id');
  }

  private toItem(row: SavedRow): SavedItem {
    return { id: row.id, url: row.url, title: row.title, tags: parseTags(row.tags), savedAt: row.savedAt };
  }

  /** All saved items, newest first. */
  list(): SavedItem[] {
    return (this.selectAll.all() as SavedRow[]).map((r) => this.toItem(r));
  }

  /** Add a saved item stamped with savedAt = now(). Returns the new list. */
  add(
    input: { url: string; title: string; tags?: string[] },
    now: () => number = Date.now,
  ): SavedItem[] {
    this.insertStmt.run({
      url: input.url,
      title: input.title,
      tags: JSON.stringify(input.tags ?? []),
      savedAt: now(),
    });
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

  /** Patch title and/or tags on one saved item (unspecified fields unchanged). */
  update(id: number, partial: { title?: string; tags?: string[] }): SavedItem[] {
    const existing = this.selectOne.get({ id }) as SavedRow | undefined;
    if (existing) {
      const current = this.toItem(existing);
      this.updateStmt.run({
        id,
        title: partial.title ?? current.title,
        tags: JSON.stringify(partial.tags ?? current.tags),
      });
    }
    return this.list();
  }

  /** Distinct, sorted union of every saved item's tags. */
  tagUnion(): string[] {
    const all = new Set<string>();
    for (const item of this.list()) for (const tag of item.tags) all.add(tag);
    return [...all].sort();
  }

  /** Replace `oldT` with `newT` in every saved item (deduped). Returns the new list. */
  renameTag(oldT: string, newT: string): SavedItem[] {
    const run = this.db.transaction(() => {
      for (const item of this.list()) {
        if (!item.tags.includes(oldT)) continue;
        const next = item.tags.map((t) => (t === oldT ? newT : t));
        const deduped = [...new Set(next)];
        this.setTagsStmt.run({ id: item.id, tags: JSON.stringify(deduped) });
      }
    });
    run();
    return this.list();
  }

  /** Remove `tag` from every saved item that has it. Returns the new list. */
  deleteTag(tag: string): SavedItem[] {
    const run = this.db.transaction(() => {
      for (const item of this.list()) {
        if (!item.tags.includes(tag)) continue;
        const next = item.tags.filter((t) => t !== tag);
        this.setTagsStmt.run({ id: item.id, tags: JSON.stringify(next) });
      }
    });
    run();
    return this.list();
  }

  /** Remove every saved item (used by replace-import). */
  clear(): void {
    this.clearStmt.run();
  }
}
