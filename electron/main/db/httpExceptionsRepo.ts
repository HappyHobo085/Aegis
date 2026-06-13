// electron/main/db/httpExceptionsRepo.ts
import type Database from 'better-sqlite3';

/**
 * Per-host "load this site over HTTP" exceptions for HTTPS-Only. A host is added
 * when the user clicks "Continue to HTTP" on the HTTPS-failed interstitial.
 * Mirrors the prepared-statement repo pattern (see permissionsRepo.ts).
 */
export class HttpExceptionsRepo {
  private readonly selectOne;
  private readonly insert;
  private readonly deleteStmt;
  private readonly selectAll;

  constructor(private readonly db: Database.Database) {
    this.selectOne = db.prepare('SELECT 1 FROM http_exceptions WHERE host = @host');
    this.insert = db.prepare(
      'INSERT OR IGNORE INTO http_exceptions (host, createdAt) VALUES (@host, @createdAt)',
    );
    this.deleteStmt = db.prepare('DELETE FROM http_exceptions WHERE host = @host');
    this.selectAll = db.prepare('SELECT host FROM http_exceptions ORDER BY createdAt DESC');
  }

  has(host: string): boolean {
    return this.selectOne.get({ host }) !== undefined;
  }

  add(host: string): void {
    this.insert.run({ host, createdAt: Date.now() });
  }

  remove(host: string): void {
    this.deleteStmt.run({ host });
  }

  list(): string[] {
    return (this.selectAll.all() as { host: string }[]).map((r) => r.host);
  }
}
