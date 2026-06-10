// electron/main/db/downloadsRepo.ts
import type Database from 'better-sqlite3';
import type { DownloadEntry } from '../../../shared/types';

const COLUMNS = 'id, url, filename, savePath, state, receivedBytes, totalBytes, startedAt';

/**
 * Reads/writes the `downloads` table (the persisted download log). `record`
 * inserts a fresh row and returns it (with its assigned id); `update` patches
 * progress/state in place (only the supplied fields). The will-download pipeline
 * (`electron/main/downloads.ts`) drives record/update; the IPC layer drives
 * list/remove/clear/get.
 */
export class DownloadsRepo {
  private readonly selectAll: Database.Statement;
  private readonly selectOne: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare(
      `SELECT ${COLUMNS} FROM downloads ORDER BY startedAt DESC, id DESC`,
    );
    this.selectOne = db.prepare(`SELECT ${COLUMNS} FROM downloads WHERE id = @id`);
    this.insertStmt = db.prepare(
      'INSERT INTO downloads (url, filename, savePath, state, receivedBytes, totalBytes, startedAt) ' +
        'VALUES (@url, @filename, @savePath, @state, @receivedBytes, @totalBytes, @startedAt)',
    );
    this.deleteStmt = db.prepare('DELETE FROM downloads WHERE id = @id');
    this.clearStmt = db.prepare('DELETE FROM downloads');
  }

  /** All downloads, newest first. */
  list(): DownloadEntry[] {
    return this.selectAll.all() as DownloadEntry[];
  }

  /** One download by id, or undefined when absent. */
  get(id: number): DownloadEntry | undefined {
    return this.selectOne.get({ id }) as DownloadEntry | undefined;
  }

  /** Insert a fresh download row; returns it with its assigned id. */
  record(input: Omit<DownloadEntry, 'id'>): DownloadEntry {
    const info = this.insertStmt.run({
      url: input.url,
      filename: input.filename,
      savePath: input.savePath,
      state: input.state,
      receivedBytes: input.receivedBytes,
      totalBytes: input.totalBytes,
      startedAt: input.startedAt,
    });
    return { id: Number(info.lastInsertRowid), ...input };
  }

  /** Patch progress/state on one row (only the supplied fields change). */
  update(id: number, partial: Partial<DownloadEntry>): void {
    const keys = (Object.keys(partial) as Array<keyof DownloadEntry>).filter(
      (k) => k !== 'id' && partial[k] !== undefined,
    );
    if (keys.length === 0) return;
    const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
    const bind: Record<string, unknown> = { id };
    for (const k of keys) bind[k] = partial[k];
    this.db.prepare(`UPDATE downloads SET ${setClause} WHERE id = @id`).run(bind);
  }

  /** Remove one download row by id. */
  remove(id: number): void {
    this.deleteStmt.run({ id });
  }

  /** Remove every download row. */
  clear(): void {
    this.clearStmt.run();
  }
}
