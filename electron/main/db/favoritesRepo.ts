// electron/main/db/favoritesRepo.ts
import type Database from 'better-sqlite3';
import type { Favorite } from '../../../shared/types';

interface FavoriteRow {
  id: number;
  name: string;
  url: string;
  position: number;
}

/**
 * Reads/writes the `favorites` table (bookmarks bar + manager). Mutating methods
 * return the full ordered list so the IPC layer can push the fresh state to the
 * renderer. (Tagging lives on the saved list — see SavedRepo.)
 */
export class FavoritesRepo {
  private readonly selectAll: Database.Statement;
  private readonly selectMaxPosition: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly updateStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly setPositionStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare('SELECT id, name, url, position FROM favorites ORDER BY position, id');
    this.selectMaxPosition = db.prepare('SELECT MAX(position) AS maxPos FROM favorites');
    this.insertStmt = db.prepare(
      'INSERT INTO favorites (name, url, position) VALUES (@name, @url, @position)',
    );
    this.selectOne = db.prepare('SELECT id, name, url, position FROM favorites WHERE id = @id');
    this.updateStmt = db.prepare('UPDATE favorites SET name = @name, url = @url WHERE id = @id');
    this.deleteStmt = db.prepare('DELETE FROM favorites WHERE id = @id');
    this.setPositionStmt = db.prepare('UPDATE favorites SET position = @position WHERE id = @id');
    this.clearStmt = db.prepare('DELETE FROM favorites');
  }

  private toFavorite(row: FavoriteRow): Favorite {
    return { id: row.id, name: row.name, url: row.url, position: row.position };
  }

  /** All favorites, ordered by position then id. */
  list(): Favorite[] {
    return (this.selectAll.all() as FavoriteRow[]).map((r) => this.toFavorite(r));
  }

  /** Add a favorite at position max+1 (0 for the first). Returns the full updated list. */
  add(input: { name: string; url: string }): Favorite[] {
    const row = this.selectMaxPosition.get() as { maxPos: number | null };
    const position = row.maxPos === null ? 0 : row.maxPos + 1;
    this.insertStmt.run({ name: input.name, url: input.url, position });
    return this.list();
  }

  /** Patch name/url on one favorite (unspecified fields unchanged). */
  update(id: number, partial: { name?: string; url?: string }): Favorite[] {
    const existing = this.selectOne.get({ id }) as FavoriteRow | undefined;
    if (existing) {
      const current = this.toFavorite(existing);
      this.updateStmt.run({
        id,
        name: partial.name ?? current.name,
        url: partial.url ?? current.url,
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

  /** Remove every favorite (used by replace-import). */
  clear(): void {
    this.clearStmt.run();
  }
}
