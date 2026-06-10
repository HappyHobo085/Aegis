// electron/main/db/adblockRepo.ts
import type Database from 'better-sqlite3';

/**
 * Reads/writes the `adblock_config` singleton (row id = 1, seeded by
 * runMigrations): the global on/off toggle and the allowlist (JSON host[]).
 * All accessors target the single row so callers never reason about ids.
 */
export class AdblockRepo {
  private readonly selectRow: Database.Statement;
  private readonly setEnabledStmt: Database.Statement;
  private readonly setAllowlistStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectRow = db.prepare('SELECT enabled, allowlist FROM adblock_config WHERE id = 1');
    this.setEnabledStmt = db.prepare('UPDATE adblock_config SET enabled = @enabled WHERE id = 1');
    this.setAllowlistStmt = db.prepare(
      'UPDATE adblock_config SET allowlist = @allowlist WHERE id = 1',
    );
  }

  /** The current global toggle + allowlist. allowlist parse failure → []. */
  getState(): { enabled: boolean; allowlistedHosts: string[] } {
    const row = this.selectRow.get() as { enabled: number; allowlist: string } | undefined;
    if (!row) return { enabled: true, allowlistedHosts: [] };
    let allowlistedHosts: string[] = [];
    try {
      const parsed = JSON.parse(row.allowlist);
      if (Array.isArray(parsed)) allowlistedHosts = parsed.filter((h): h is string => typeof h === 'string');
    } catch {
      // Corrupt JSON: fall back to an empty allowlist (blocking stays on).
    }
    return { enabled: row.enabled === 1, allowlistedHosts };
  }

  /** Persist the global on/off toggle. */
  setEnabled(enabled: boolean): void {
    this.setEnabledStmt.run({ enabled: enabled ? 1 : 0 });
  }

  /** True if `host` is currently allowlisted (blocking suppressed there). */
  isAllowlisted(host: string): boolean {
    return this.getState().allowlistedHosts.includes(host);
  }

  /** Add `host` if absent, else remove it. Returns the new allowlist. */
  toggleAllowlist(host: string): string[] {
    const current = this.getState().allowlistedHosts;
    const next = current.includes(host)
      ? current.filter((h) => h !== host)
      : [...current, host];
    this.setAllowlistStmt.run({ allowlist: JSON.stringify(next) });
    return next;
  }

  /** Unconditionally remove `host` from the allowlist. Returns the new array. */
  removeAllowlist(host: string): string[] {
    const next = this.getState().allowlistedHosts.filter((h) => h !== host);
    this.setAllowlistStmt.run({ allowlist: JSON.stringify(next) });
    return next;
  }

  /** Remove every host from the allowlist. Returns the (empty) new array. */
  clearAllowlist(): string[] {
    const next: string[] = [];
    this.setAllowlistStmt.run({ allowlist: JSON.stringify(next) });
    return next;
  }
}
