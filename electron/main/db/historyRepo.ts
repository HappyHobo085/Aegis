// electron/main/db/historyRepo.ts
import type Database from 'better-sqlite3';
import type { HistoryEntry } from '../../../shared/types';

/** Keep at most the newest N rows in the history table. */
const HISTORY_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 200;

/**
 * Reads/writes the `history` table (auto-recorded timeline). `record` dedups
 * against the most-recent row (same url → bump visitedAt, refresh title if the
 * new one is non-empty) and trims to the newest 500 rows. Timestamps are
 * injectable per call (default Date.now) so tests get deterministic ordering.
 */
export class HistoryRepo {
  private readonly selectList: Database.Statement;
  private readonly selectListOffset: Database.Statement;
  private readonly searchStmt: Database.Statement;
  private readonly selectMostRecent: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly updateVisitedStmt: Database.Statement;
  private readonly updateVisitedAndTitleStmt: Database.Statement;
  private readonly updateTitleStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;
  private readonly trimStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectList = db.prepare(
      'SELECT id, url, title, visitedAt FROM history ORDER BY visitedAt DESC, id DESC LIMIT @limit',
    );
    this.selectListOffset = db.prepare(
      'SELECT id, url, title, visitedAt FROM history ORDER BY visitedAt DESC, id DESC LIMIT @limit OFFSET @offset',
    );
    this.searchStmt = db.prepare(
      'SELECT id, url, title, visitedAt FROM history ' +
        'WHERE url LIKE @q OR title LIKE @q ORDER BY visitedAt DESC, id DESC',
    );
    this.selectMostRecent = db.prepare(
      'SELECT id, url, title, visitedAt FROM history ORDER BY visitedAt DESC, id DESC LIMIT 1',
    );
    this.insertStmt = db.prepare(
      'INSERT INTO history (url, title, visitedAt) VALUES (@url, @title, @visitedAt)',
    );
    this.updateVisitedStmt = db.prepare('UPDATE history SET visitedAt = @visitedAt WHERE id = @id');
    this.updateVisitedAndTitleStmt = db.prepare(
      'UPDATE history SET visitedAt = @visitedAt, title = @title WHERE id = @id',
    );
    this.updateTitleStmt = db.prepare('UPDATE history SET title = @title WHERE id = @id');
    this.deleteStmt = db.prepare('DELETE FROM history WHERE id = @id');
    this.clearStmt = db.prepare('DELETE FROM history');
    this.trimStmt = db.prepare(
      'DELETE FROM history WHERE id NOT IN ' +
        '(SELECT id FROM history ORDER BY visitedAt DESC, id DESC LIMIT @limit)',
    );
  }

  /** The newest row, or undefined when the table is empty. */
  mostRecent(): HistoryEntry | undefined {
    return this.selectMostRecent.get() as HistoryEntry | undefined;
  }

  /**
   * Record a visit. If the most-recent row has the same url, bump its
   * visitedAt (and title, if the new title is non-empty) instead of inserting;
   * otherwise insert a fresh row. Trims to the newest HISTORY_LIMIT rows.
   */
  record(input: { url: string; title: string }, now: () => number = Date.now): void {
    const visitedAt = now();
    const recent = this.mostRecent();
    if (recent && recent.url === input.url) {
      if (input.title) {
        this.updateVisitedAndTitleStmt.run({ id: recent.id, visitedAt, title: input.title });
      } else {
        this.updateVisitedStmt.run({ id: recent.id, visitedAt });
      }
      return;
    }
    this.insertStmt.run({ url: input.url, title: input.title, visitedAt });
    this.trimStmt.run({ limit: HISTORY_LIMIT });
  }

  /**
   * Update the most-recent row's title iff its url === `url` and the title is
   * non-empty (a late page-title-updated for the page just navigated to). The
   * `now` arg is accepted for signature parity; it is unused here.
   */
  setMostRecentTitle(url: string, title: string, _now: () => number = Date.now): void {
    if (!title) return;
    const recent = this.mostRecent();
    if (recent && recent.url === url) {
      this.updateTitleStmt.run({ id: recent.id, title });
    }
  }

  /** Entries newest-first; default limit 200, optional offset. */
  list(opts?: { limit?: number; offset?: number }): HistoryEntry[] {
    const limit = opts?.limit ?? DEFAULT_LIST_LIMIT;
    if (opts?.offset !== undefined) {
      return this.selectListOffset.all({ limit, offset: opts.offset }) as HistoryEntry[];
    }
    return this.selectList.all({ limit }) as HistoryEntry[];
  }

  /** Entries whose url or title match `q` (LIKE), newest-first. */
  search(q: string): HistoryEntry[] {
    return this.searchStmt.all({ q: `%${q}%` }) as HistoryEntry[];
  }

  /** Remove one row by id. */
  remove(id: number): void {
    this.deleteStmt.run({ id });
  }

  /** Remove every row. */
  clear(): void {
    this.clearStmt.run();
  }
}
