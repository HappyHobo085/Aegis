// electron/main/db/subsRepo.ts
import type Database from 'better-sqlite3';
import { listIdFromUrl } from '../adblock/engine';

export interface Subscription {
  listId: string;
  url: string;
  enabled: boolean;
  lastUpdated: number | null;
  etag: string | null;
  hash: string | null;
}

/**
 * Reads/writes the `filter_subscriptions` table: one row per filter list,
 * tracking its source url and refresh metadata (lastUpdated/etag/hash). Default
 * lists are seeded idempotently (INSERT OR IGNORE) so re-seeding never clobbers
 * recorded metadata.
 */
export class SubsRepo {
  private readonly selectAll: Database.Statement;
  private readonly insertIgnore: Database.Statement;
  private readonly updateMetaStmt: Database.Statement;
  private readonly setEnabledStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare(
      'SELECT listId, url, enabled, lastUpdated, etag, hash FROM filter_subscriptions ORDER BY listId',
    );
    this.insertIgnore = db.prepare(
      'INSERT OR IGNORE INTO filter_subscriptions (listId, url, enabled) VALUES (@listId, @url, 1)',
    );
    this.updateMetaStmt = db.prepare(
      'UPDATE filter_subscriptions SET lastUpdated = @lastUpdated, etag = @etag, hash = @hash WHERE listId = @listId',
    );
    this.setEnabledStmt = db.prepare(
      'UPDATE filter_subscriptions SET enabled = @enabled WHERE listId = @listId',
    );
    this.deleteStmt = db.prepare('DELETE FROM filter_subscriptions WHERE listId = @listId');
  }

  /** Idempotently seed the default subscriptions (enabled, null metadata). */
  seedDefaults(defaults: { listId: string; url: string }[]): void {
    const seed = this.db.transaction((rows: { listId: string; url: string }[]) => {
      for (const r of rows) this.insertIgnore.run({ listId: r.listId, url: r.url });
    });
    seed(defaults);
  }

  /** All subscriptions, ordered by listId. */
  all(): Subscription[] {
    const rows = this.selectAll.all() as Array<{
      listId: string;
      url: string;
      enabled: number;
      lastUpdated: number | null;
      etag: string | null;
      hash: string | null;
    }>;
    return rows.map((r) => ({
      listId: r.listId,
      url: r.url,
      enabled: r.enabled === 1,
      lastUpdated: r.lastUpdated,
      etag: r.etag,
      hash: r.hash,
    }));
  }

  /** Record a successful refresh's metadata for one list. */
  updateMeta(listId: string, meta: { lastUpdated: number; etag: string | null; hash: string }): void {
    this.updateMetaStmt.run({
      listId,
      lastUpdated: meta.lastUpdated,
      etag: meta.etag,
      hash: meta.hash,
    });
  }

  /** Enable or disable a single subscription by listId. */
  setEnabled(listId: string, enabled: boolean): void {
    this.setEnabledStmt.run({ listId, enabled: enabled ? 1 : 0 });
  }

  /**
   * Add a custom subscription. The listId is derived from the url's filename;
   * INSERT OR IGNORE so re-adding an existing list never clobbers its metadata.
   * Returns the full subscription set after the insert.
   */
  add(url: string): Subscription[] {
    const listId = listIdFromUrl(url);
    this.insertIgnore.run({ listId, url });
    return this.all();
  }

  /** Remove a subscription by listId. No-op if absent. Returns the new set. */
  remove(listId: string): Subscription[] {
    this.deleteStmt.run({ listId });
    return this.all();
  }
}
