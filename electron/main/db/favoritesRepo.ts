// electron/main/db/favoritesRepo.ts
import type Database from 'better-sqlite3';
import type { Favorite } from '../../../shared/types';

interface FavoriteRow {
  id: number;
  name: string;
  url: string;
  tags: string;
  position: number;
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
 * Reads/writes the `favorites` table (bookmarks bar + manager). Tags are
 * denormalized as a JSON string[] per row, parsed with a []-fallback. Mutating
 * methods return the full ordered list (or, for tagUnion, the distinct tag set)
 * so the IPC layer can push the fresh state to the renderer.
 */
export class FavoritesRepo {
  private readonly selectAll: Database.Statement;
  private readonly selectMaxPosition: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly setPositionStmt: Database.Statement;
  private readonly setTagsStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare(
      'SELECT id, name, url, tags, position FROM favorites ORDER BY position, id',
    );
    this.selectMaxPosition = db.prepare('SELECT MAX(position) AS maxPos FROM favorites');
    this.insertStmt = db.prepare(
      'INSERT INTO favorites (name, url, tags, position) VALUES (@name, @url, @tags, @position)',
    );
    this.selectOne = db.prepare(
      'SELECT id, name, url, tags, position FROM favorites WHERE id = @id',
    );
    this.updateStmt = db.prepare(
      'UPDATE favorites SET name = @name, url = @url, tags = @tags WHERE id = @id',
    );
    this.deleteStmt = db.prepare('DELETE FROM favorites WHERE id = @id');
    this.setPositionStmt = db.prepare('UPDATE favorites SET position = @position WHERE id = @id');
    this.setTagsStmt = db.prepare('UPDATE favorites SET tags = @tags WHERE id = @id');
  }

  private toFavorite(row: FavoriteRow): Favorite {
    return { id: row.id, name: row.name, url: row.url, tags: parseTags(row.tags), position: row.position };
  }

  /** All favorites, ordered by position then id. */
  list(): Favorite[] {
    return (this.selectAll.all() as FavoriteRow[]).map((r) => this.toFavorite(r));
  }

  /** Add a favorite at position max+1 (0 for the first). Returns the full updated list. */
  add(input: { name: string; url: string; tags: string[] }): Favorite[] {
    const row = this.selectMaxPosition.get() as { maxPos: number | null };
    const position = row.maxPos === null ? 0 : row.maxPos + 1;
    this.insertStmt.run({
      name: input.name,
      url: input.url,
      tags: JSON.stringify(input.tags),
      position,
    });
    return this.list();
  }

  /** Patch name/url/tags on one favorite (unspecified fields unchanged). */
  update(id: number, partial: { name?: string; url?: string; tags?: string[] }): Favorite[] {
    const existing = this.selectOne.get({ id }) as FavoriteRow | undefined;
    if (existing) {
      const current = this.toFavorite(existing);
      this.updateStmt.run({
        id,
        name: partial.name ?? current.name,
        url: partial.url ?? current.url,
        tags: JSON.stringify(partial.tags ?? current.tags),
      });
    }
    return this.list();
  }

  /** Remove one favorite. Returns the remaining list. */
  remove(id: number): Favorite[] {
    this.deleteStmt.run({ id });
    return this.list();
  }

  /** Set each favorite's position from its index in `ids`. Returns the new list. */
  reorder(ids: number[]): Favorite[] {
    const run = this.db.transaction((order: number[]) => {
      order.forEach((id, index) => this.setPositionStmt.run({ id, position: index }));
    });
    run(ids);
    return this.list();
  }

  /** Distinct, sorted union of every favorite's tags. */
  tagUnion(): string[] {
    const all = new Set<string>();
    for (const fav of this.list()) for (const tag of fav.tags) all.add(tag);
    return [...all].sort();
  }

  /** Replace `oldT` with `newT` in every favorite (deduped). Returns the new list. */
  renameTag(oldT: string, newT: string): Favorite[] {
    const run = this.db.transaction(() => {
      for (const fav of this.list()) {
        if (!fav.tags.includes(oldT)) continue;
        const next = fav.tags.map((t) => (t === oldT ? newT : t));
        const deduped = [...new Set(next)];
        this.setTagsStmt.run({ id: fav.id, tags: JSON.stringify(deduped) });
      }
    });
    run();
    return this.list();
  }

  /** Remove `tag` from every favorite that has it. Returns the new list. */
  deleteTag(tag: string): Favorite[] {
    const run = this.db.transaction(() => {
      for (const fav of this.list()) {
        if (!fav.tags.includes(tag)) continue;
        const next = fav.tags.filter((t) => t !== tag);
        this.setTagsStmt.run({ id: fav.id, tags: JSON.stringify(next) });
      }
    });
    run();
    return this.list();
  }
}
