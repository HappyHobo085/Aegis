// electron/main/db/permissionsRepo.ts
import type Database from 'better-sqlite3';
import type { SitePermission } from '../../../shared/types';

/**
 * Reads/writes the `site_permissions` table (remembered per-(origin,permission)
 * allow/deny decisions). The permission handlers in `electron/main/permissions.ts`
 * consult `get` on every request/check; the Site-permissions Settings tab drives
 * list/remove/clear. PRIMARY KEY (origin, permission) makes `set` an upsert.
 */
export class PermissionsRepo {
  private readonly selectOne: Database.Statement;
  private readonly upsert: Database.Statement;
  private readonly selectAll: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly clearStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectOne = db.prepare(
      'SELECT decision FROM site_permissions WHERE origin = @origin AND permission = @permission',
    );
    this.upsert = db.prepare(
      'INSERT INTO site_permissions (origin, permission, decision) ' +
        'VALUES (@origin, @permission, @decision) ' +
        'ON CONFLICT(origin, permission) DO UPDATE SET decision = excluded.decision',
    );
    this.selectAll = db.prepare(
      'SELECT origin, permission, decision FROM site_permissions ORDER BY origin, permission',
    );
    this.deleteStmt = db.prepare(
      'DELETE FROM site_permissions WHERE origin = @origin AND permission = @permission',
    );
    this.clearStmt = db.prepare('DELETE FROM site_permissions');
  }

  /** The remembered decision for (origin, permission), or undefined if none. */
  get(origin: string, permission: string): 'allow' | 'deny' | undefined {
    const row = this.selectOne.get({ origin, permission }) as { decision: string } | undefined;
    return row ? (row.decision as 'allow' | 'deny') : undefined;
  }

  /** Remember a decision for (origin, permission) (upsert). */
  set(origin: string, permission: string, decision: 'allow' | 'deny'): void {
    this.upsert.run({ origin, permission, decision });
  }

  /** All remembered rows, ordered by origin then permission. */
  list(): SitePermission[] {
    return this.selectAll.all() as SitePermission[];
  }

  /** Forget one (origin, permission) row. */
  remove(origin: string, permission: string): void {
    this.deleteStmt.run({ origin, permission });
  }

  /** Forget every remembered decision. */
  clear(): void {
    this.clearStmt.run();
  }
}
