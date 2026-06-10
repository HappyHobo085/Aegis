# Aegis Phase 3 — Favorites/Tags, History, Saved-list, Sidebar + Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the local "places" features — a favorites bar + manager with freeform tags, an auto-recorded history timeline, a manually-curated saved-list, surfaced in a toggleable inset sidebar — all persisted in SQLite and surviving an app restart.

**Architecture:** 3 additive SQLite stores + repos (favorites/history/saved) on the existing better-sqlite3 foundation; main-side automatic history recording (dedup vs most-recent, trim 500) on the content view's nav events; a toggleable inset sidebar that repositions the content `WebContentsView` via a new `view.setContentInset` IPC + inset-driven `layout()`; new IPC namespaces + a `chromePreload` bridge; React chrome (favorites bar, manager modal, tag UI, history/saved panels, sidebar, bookmark button) over the existing Toolbar.

**Tech Stack:** Electron 42.4.0 · better-sqlite3 12.10.0 · React 19 + TS · Vitest 4 (`node`+`jsdom`) · Playwright `_electron`. Branch `phase-3` (off `main`; LOCAL commits only).

**Companion contract (authoritative reference):** `docs/superpowers/plans/2026-06-10-aegis-phase3-contract.md` — §1 as-built integration facts (verified from the code), §2 the content-inset layout mechanism, §3 `shared/types.ts` additions, §4 interface ledger, §5 conventions, §6 task skeleton, **§8 + §9 review-driven corrections (override §1–§7)**.

---

## §0 — How this plan was built + corrections applied (already incorporated below)

Drafted by 5 parallel block-drafters against the source-grounded contract, then adversarially reviewed twice. Review #1 (REQUEST CHANGES) caught cross-block defects — the `__aegisTest.places` test-registry gap every e2e depended on; a `now`-injection model that diverged between the history repo (Task 3) and its recorder test (Task 5); App-wiring prop contracts that didn't match the Block-C/D components + a missing bookmark-unsave path; a duplicated `layout.ts` — all encoded as contract **§8** and regenerated. Review #2 (APPROVE WITH CHANGES) approved Blocks A–D and flagged the Block-E e2e (it drove the chrome React DOM via the unreliable `app.firstWindow()`/`getByRole` path); encoded as **§9** (drive e2e via `__aegisTest` like all 12 existing specs) and **Block E was regenerated** against it. Review #3 approved the regenerated Block E (all §9 corrections verified) with one noted gap, fixed during assembly:
- **persistence.spec.ts** now also records + asserts **history** across the relaunch (spec §11.5 requires favorites, history, AND saved to survive restart; §9.3 had de-scoped it to favorites+saved). app1 performs a real nav (recording history) before close; app2 asserts the entry is still in `historyRepo.list()`.

Lower-severity timing notes from review #3 (the dedup test's `visitedAt`-strictly-greater poll; same-millisecond DESC ordering ties) are practical-only flake risks, recorded as follow-ups — if the build surfaces flake, tighten the poll.

---

I now have all the patterns I need. I have full visibility into the as-built code: the `IPC` map ends at line 26 (`evtAdblockBlockedCount`) before the closing `} as const;`, the `view` namespace in `AegisApi` currently has only `setContentVisible`, repos use `private readonly` prepared statements with JSON `[]` fallback, transactions via `this.db.transaction(...)`, and the sqlite test's `describe('runMigrations', …)` closes at line 100.

Now I'll write Block A (Tasks 1-4).

### Task 1: `shared/types.ts` Phase-3 additions (types, IPC channels, AegisApi)

**Files:**
- Modify: `shared/types.ts` (add `Favorite`/`HistoryEntry`/`SavedItem`/`ContentInset` interfaces; extend the `IPC` map; extend `AegisApi`)
- Test: `shared/types.test.ts` (append Phase-3 assertions)

- [ ] **Step 1: Write the failing test**

Append the following block to `shared/types.test.ts`. First extend the type-only import on line 3, then add the new `describe` block before the final closing line of the file.

Change line 3 from:
```ts
import type { AdblockState, BlockedCount, ListUpdateResult, ListSourceResult } from './types';
```
to:
```ts
import type {
  AdblockState,
  BlockedCount,
  ListUpdateResult,
  ListSourceResult,
  Favorite,
  HistoryEntry,
  SavedItem,
  ContentInset,
} from './types';
```

Then append this `describe` block (after the existing `describe('shared/types', …)` block, at the end of the file):
```ts
describe('shared/types — Phase 3 additions', () => {
  it('exposes the favorites IPC channel constants', () => {
    expect(IPC.favoritesList).toBe('favorites.list');
    expect(IPC.favoritesAdd).toBe('favorites.add');
    expect(IPC.favoritesUpdate).toBe('favorites.update');
    expect(IPC.favoritesRemove).toBe('favorites.remove');
    expect(IPC.favoritesReorder).toBe('favorites.reorder');
    expect(IPC.favoritesRenameTag).toBe('favorites.renameTag');
    expect(IPC.favoritesDeleteTag).toBe('favorites.deleteTag');
    expect(IPC.favoritesTagUnion).toBe('favorites.tagUnion');
  });

  it('exposes the history IPC channel constants (incl. the changed event)', () => {
    expect(IPC.historyList).toBe('history.list');
    expect(IPC.historySearch).toBe('history.search');
    expect(IPC.historyRemove).toBe('history.remove');
    expect(IPC.historyClear).toBe('history.clear');
    expect(IPC.evtHistoryChanged).toBe('history.changed');
  });

  it('exposes the saved-list IPC channel constants', () => {
    expect(IPC.savedList).toBe('saved.list');
    expect(IPC.savedAdd).toBe('saved.add');
    expect(IPC.savedRemove).toBe('saved.remove');
    expect(IPC.savedHas).toBe('saved.has');
  });

  it('exposes the view.setContentInset channel constant', () => {
    expect(IPC.viewSetContentInset).toBe('view.setContentInset');
  });

  it('admits the Phase-3 data-model shapes', () => {
    const fav: Favorite = { id: 1, name: 'Example', url: 'https://example.com/', tags: ['news'], position: 0 };
    expect(fav.tags).toEqual(['news']);

    const entry: HistoryEntry = { id: 2, url: 'https://a.test/', title: 'A', visitedAt: 1234 };
    expect(entry.visitedAt).toBe(1234);

    const saved: SavedItem = { id: 3, url: 'https://b.test/', title: 'B', savedAt: 5678 };
    expect(saved.savedAt).toBe(5678);

    const inset: ContentInset = { top: 96, left: 280 };
    expect(inset).toEqual({ top: 96, left: 280 });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run shared/types.test.ts`

Expected: FAIL — TypeScript compile / runtime errors: `Module './types' has no exported member 'Favorite'` (and `HistoryEntry`/`SavedItem`/`ContentInset`), plus assertion failures like `expected undefined to be 'favorites.list'` for `IPC.favoritesList`, `IPC.historyList`, `IPC.savedList`, `IPC.viewSetContentInset`, `IPC.evtHistoryChanged`.

- [ ] **Step 3: Implement**

Edit `shared/types.ts`. Extend the `IPC` map (insert the new channel keys before the closing `} as const;`, after the `evtAdblockBlockedCount` line):
```ts
export const IPC = {
  navNavigate: 'nav.navigate',
  navBack: 'nav.back',
  navForward: 'nav.forward',
  navReloadOrStop: 'nav.reloadOrStop',
  navHome: 'nav.home',
  navGetState: 'nav.getState',
  viewSetContentVisible: 'view.setContentVisible',
  viewSetContentInset: 'view.setContentInset',
  settingsGet: 'settings.get',
  settingsSet: 'settings.set',
  // adblock + lists (chrome -> main)
  adblockSetEnabled: 'adblock.setEnabled',
  adblockToggleAllowlist: 'adblock.toggleAllowlist',
  adblockGetState: 'adblock.getState',
  listsUpdateNow: 'lists.updateNow',
  // favorites (chrome -> main)
  favoritesList: 'favorites.list',
  favoritesAdd: 'favorites.add',
  favoritesUpdate: 'favorites.update',
  favoritesRemove: 'favorites.remove',
  favoritesReorder: 'favorites.reorder',
  favoritesRenameTag: 'favorites.renameTag',
  favoritesDeleteTag: 'favorites.deleteTag',
  favoritesTagUnion: 'favorites.tagUnion',
  // history (chrome -> main)
  historyList: 'history.list',
  historySearch: 'history.search',
  historyRemove: 'history.remove',
  historyClear: 'history.clear',
  // saved list (chrome -> main)
  savedList: 'saved.list',
  savedAdd: 'saved.add',
  savedRemove: 'saved.remove',
  savedHas: 'saved.has',
  // events (main -> chrome renderer)
  evtNavState: 'nav.state',
  evtNavFailed: 'nav.failed',
  evtNavCrashed: 'nav.crashed',
  evtAdblockBlockedCount: 'adblock.blockedCount',
  evtHistoryChanged: 'history.changed',
} as const;
```

Add the new data-model interfaces. Insert them immediately after the `NavCrashed` interface (before the `// ---- adblock data model ----` comment):
```ts
// ---- places data model (Phase 3) ----
export interface Favorite {
  id: number;
  name: string;
  url: string;
  tags: string[];
  position: number;
}
export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
}
export interface SavedItem {
  id: number;
  url: string;
  title: string;
  savedAt: number;
}
export interface ContentInset {
  top: number;
  left: number;
}
```

Extend the `AegisApi` interface. Replace the existing `view:` namespace and add the `favorites`/`history`/`saved` namespaces. Change:
```ts
  view: {
    setContentVisible(viewId: ViewId, visible: boolean): Promise<void>;
  };
```
to:
```ts
  view: {
    setContentVisible(viewId: ViewId, visible: boolean): Promise<void>;
    setContentInset(viewId: ViewId, inset: ContentInset): Promise<void>;
  };
  favorites: {
    list(): Promise<Favorite[]>;
    add(input: { name: string; url: string; tags: string[] }): Promise<Favorite[]>;
    update(id: number, partial: { name?: string; url?: string; tags?: string[] }): Promise<Favorite[]>;
    remove(id: number): Promise<Favorite[]>;
    reorder(ids: number[]): Promise<Favorite[]>;
    renameTag(oldT: string, newT: string): Promise<Favorite[]>;
    deleteTag(tag: string): Promise<Favorite[]>;
    tagUnion(): Promise<string[]>;
  };
  history: {
    list(opts?: { limit?: number; offset?: number }): Promise<HistoryEntry[]>;
    search(q: string): Promise<HistoryEntry[]>;
    remove(id: number): Promise<void>;
    clear(): Promise<void>;
    onChanged(cb: () => void): () => void;
  };
  saved: {
    list(): Promise<SavedItem[]>;
    add(input: { url: string; title: string }): Promise<SavedItem[]>;
    remove(id: number): Promise<SavedItem[]>;
    has(url: string): Promise<boolean>;
  };
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run shared/types.test.ts`

Expected: PASS (all `describe('shared/types …')` + `describe('shared/types — Phase 3 additions')` tests green).

- [ ] **Step 5: Commit**
```bash
git add shared/types.ts shared/types.test.ts
git commit -m "feat(types): add Phase-3 places types, IPC channels, and AegisApi namespaces"
```

---

### Task 2: `favorites` table migration + `FavoritesRepo`

**Files:**
- Create: `electron/main/db/favoritesRepo.ts`
- Modify: `electron/main/db/sqlite.ts` (add `favorites` table to the single `db.exec` block)
- Test: `electron/main/db/favoritesRepo.test.ts`
- Test: `electron/main/db/sqlite.test.ts` (add a `favorites`-table migration `it`)

- [ ] **Step 1: Write the failing test**

Create `electron/main/db/favoritesRepo.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { FavoritesRepo } from './favoritesRepo';

describe('favoritesRepo', () => {
  let db: Database.Database;
  let repo: FavoritesRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new FavoritesRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('list / add', () => {
    it('starts empty', () => {
      expect(repo.list()).toEqual([]);
    });

    it('adds a favorite, assigning position 0 to the first row', () => {
      const list = repo.add({ name: 'Example', url: 'https://example.com/', tags: ['news'] });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        name: 'Example',
        url: 'https://example.com/',
        tags: ['news'],
        position: 0,
      });
      expect(typeof list[0].id).toBe('number');
    });

    it('assigns the next position (max+1) to each new row', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: [] });
      const list = repo.list();
      expect(list.map((f) => f.position)).toEqual([0, 1]);
    });

    it('orders by position then id', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: [] });
      repo.add({ name: 'C', url: 'https://c.test/', tags: [] });
      expect(repo.list().map((f) => f.name)).toEqual(['A', 'B', 'C']);
    });

    it('persists tags as JSON and round-trips them', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['x', 'y'] });
      expect(repo.list()[0].tags).toEqual(['x', 'y']);
    });

    it('falls back to [] for a corrupt tags column', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['x'] });
      const id = repo.list()[0].id;
      db.prepare('UPDATE favorites SET tags = ? WHERE id = ?').run('not json', id);
      expect(repo.list()[0].tags).toEqual([]);
    });
  });

  describe('update', () => {
    it('patches name/url/tags and leaves unspecified fields intact', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/', tags: ['x'] })[0].id;
      repo.update(id, { name: 'A2' });
      let f = repo.list()[0];
      expect(f).toMatchObject({ name: 'A2', url: 'https://a.test/', tags: ['x'] });

      repo.update(id, { url: 'https://a2.test/', tags: ['y', 'z'] });
      f = repo.list()[0];
      expect(f).toMatchObject({ name: 'A2', url: 'https://a2.test/', tags: ['y', 'z'] });
    });

    it('returns the updated list', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/', tags: [] })[0].id;
      const list = repo.update(id, { name: 'A2' });
      expect(list[0].name).toBe('A2');
    });
  });

  describe('remove', () => {
    it('removes a favorite and returns the remaining list', () => {
      const id = repo.add({ name: 'A', url: 'https://a.test/', tags: [] })[0].id;
      repo.add({ name: 'B', url: 'https://b.test/', tags: [] });
      const list = repo.remove(id);
      expect(list.map((f) => f.name)).toEqual(['B']);
    });
  });

  describe('reorder', () => {
    it('sets position by index of the provided id order', () => {
      const a = repo.add({ name: 'A', url: 'https://a.test/', tags: [] })[0].id;
      const b = repo.add({ name: 'B', url: 'https://b.test/', tags: [] })[0].id;
      const c = repo.add({ name: 'C', url: 'https://c.test/', tags: [] })[0].id;
      const list = repo.reorder([c, a, b]);
      expect(list.map((f) => f.name)).toEqual(['C', 'A', 'B']);
      expect(list.map((f) => f.position)).toEqual([0, 1, 2]);
    });
  });

  describe('tagUnion', () => {
    it('returns the distinct sorted union of all tags', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['news', 'tech'] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: ['tech', 'fun'] });
      expect(repo.tagUnion()).toEqual(['fun', 'news', 'tech']);
    });

    it('is empty when no favorite has tags', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      expect(repo.tagUnion()).toEqual([]);
    });
  });

  describe('renameTag', () => {
    it('renames the tag in every favorite that has it', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['news', 'tech'] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: ['tech'] });
      repo.add({ name: 'C', url: 'https://c.test/', tags: ['fun'] });
      const list = repo.renameTag('tech', 'technology');
      const byName = Object.fromEntries(list.map((f) => [f.name, f.tags]));
      expect(byName.A).toEqual(['news', 'technology']);
      expect(byName.B).toEqual(['technology']);
      expect(byName.C).toEqual(['fun']);
    });

    it('does not duplicate when the new tag already exists on a row', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['old', 'new'] });
      const list = repo.renameTag('old', 'new');
      expect(list[0].tags).toEqual(['new']);
    });
  });

  describe('deleteTag', () => {
    it('removes the tag from every favorite that has it', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: ['news', 'tech'] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: ['tech'] });
      const list = repo.deleteTag('tech');
      const byName = Object.fromEntries(list.map((f) => [f.name, f.tags]));
      expect(byName.A).toEqual(['news']);
      expect(byName.B).toEqual([]);
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.add({ name: 'A', url: 'https://a.test/', tags: ['x'] });
    const repo2 = new FavoritesRepo(db);
    expect(repo2.list()[0]).toMatchObject({ name: 'A', tags: ['x'] });
  });
});
```

Also add a migration `it` to `electron/main/db/sqlite.test.ts`, inserted immediately before the final `});` that closes the `describe('runMigrations', …)` block (after the `filter_subscriptions` test):
```ts
    it('creates the favorites table with the expected columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='favorites'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('favorites');
      const cols = (db.prepare('PRAGMA table_info(favorites)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('id');
      expect(cols).toHaveProperty('name');
      expect(cols).toHaveProperty('url');
      expect(cols).toHaveProperty('tags');
      expect(cols).toHaveProperty('position');
      expect(cols.id).toBe(1); // id is the primary key
    });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/favoritesRepo.test.ts electron/main/db/sqlite.test.ts`

Expected: FAIL — `favoritesRepo.test.ts` errors with `Failed to resolve import './favoritesRepo'` (module does not exist); the new `sqlite.test.ts` case fails with `expected undefined to be 'favorites'` (table not created).

- [ ] **Step 3: Implement**

Edit `electron/main/db/sqlite.ts` — add the `favorites` table to the SAME `db.exec` block (append after the `filter_subscriptions` table, inside the template literal, before the closing backtick):
```ts
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS adblock_config (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      enabled   INTEGER NOT NULL DEFAULT 1,
      allowlist TEXT    NOT NULL DEFAULT '[]'
    );
    INSERT OR IGNORE INTO adblock_config (id, enabled, allowlist) VALUES (1, 1, '[]');

    CREATE TABLE IF NOT EXISTS filter_subscriptions (
      listId      TEXT PRIMARY KEY,
      url         TEXT    NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      lastUpdated INTEGER,
      etag        TEXT,
      hash        TEXT
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      name     TEXT    NOT NULL,
      url      TEXT    NOT NULL,
      tags     TEXT    NOT NULL DEFAULT '[]',
      position INTEGER NOT NULL DEFAULT 0
    );
  `);
}
```

Create `electron/main/db/favoritesRepo.ts`:
```ts
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

  /** Add a favorite at position max+1 (0 for the first). Returns the new list. */
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/favoritesRepo.test.ts electron/main/db/sqlite.test.ts`

Expected: PASS (all `favoritesRepo` cases + the new `favorites`-table migration case + the pre-existing `sqlite` cases green).

- [ ] **Step 5: Commit**
```bash
git add electron/main/db/favoritesRepo.ts electron/main/db/favoritesRepo.test.ts electron/main/db/sqlite.ts electron/main/db/sqlite.test.ts
git commit -m "feat(favorites): add favorites table migration and FavoritesRepo"
```

---

### Task 3: `history` table migration + `HistoryRepo`

**Files:**
- Create: `electron/main/db/historyRepo.ts`
- Modify: `electron/main/db/sqlite.ts` (add `history` table to the single `db.exec` block)
- Test: `electron/main/db/historyRepo.test.ts`
- Test: `electron/main/db/sqlite.test.ts` (add a `history`-table migration `it`)

- [ ] **Step 1: Write the failing test**

Create `electron/main/db/historyRepo.test.ts`. Note the per-method injectable `now` (contract §8.2: `record(input, now=Date.now)` / `setMostRecentTitle(url, title, now=Date.now)`; `constructor(db)` only):
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { HistoryRepo } from './historyRepo';

describe('historyRepo', () => {
  let db: Database.Database;
  let repo: HistoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new HistoryRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('record', () => {
    it('inserts a new entry with the provided timestamp', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      const list = repo.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ url: 'https://a.test/', title: 'A', visitedAt: 1000 });
      expect(typeof list[0].id).toBe('number');
    });

    it('dedups vs the most-recent row: same url updates visitedAt instead of inserting', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 2000);
      const list = repo.list();
      expect(list).toHaveLength(1);
      expect(list[0].visitedAt).toBe(2000);
    });

    it('updates the most-recent title on dedup only when the new title is non-empty', () => {
      repo.record({ url: 'https://a.test/', title: 'Old' }, () => 1000);
      repo.record({ url: 'https://a.test/', title: '' }, () => 2000);
      expect(repo.mostRecent()?.title).toBe('Old');
      repo.record({ url: 'https://a.test/', title: 'New' }, () => 3000);
      expect(repo.mostRecent()?.title).toBe('New');
    });

    it('inserts a new row when the url differs from the most-recent', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      const list = repo.list();
      expect(list).toHaveLength(2);
      // newest first
      expect(list[0]).toMatchObject({ url: 'https://b.test/', visitedAt: 2000 });
      expect(list[1]).toMatchObject({ url: 'https://a.test/', visitedAt: 1000 });
    });

    it('re-records a url that is no longer the most-recent as a new row', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 3000);
      expect(repo.list()).toHaveLength(3);
    });

    it('trims to the newest 500 rows after insert', () => {
      for (let i = 0; i < 505; i++) {
        repo.record({ url: `https://site${i}.test/`, title: `T${i}` }, () => 1000 + i);
      }
      const list = repo.list({ limit: 1000 });
      expect(list).toHaveLength(500);
      // newest kept; oldest trimmed
      expect(list[0].url).toBe('https://site504.test/');
      expect(list.some((e) => e.url === 'https://site0.test/')).toBe(false);
      expect(list.some((e) => e.url === 'https://site4.test/')).toBe(false);
      expect(list.some((e) => e.url === 'https://site5.test/')).toBe(true);
    });
  });

  describe('setMostRecentTitle', () => {
    it('updates the most-recent row title when its url matches and the title is non-empty', () => {
      repo.record({ url: 'https://a.test/', title: '' }, () => 1000);
      repo.setMostRecentTitle('https://a.test/', 'Later Title', () => 2000);
      expect(repo.mostRecent()?.title).toBe('Later Title');
    });

    it('is a no-op when the url does not match the most-recent row', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.setMostRecentTitle('https://b.test/', 'B', () => 2000);
      expect(repo.mostRecent()?.title).toBe('A');
    });

    it('is a no-op when the title is empty', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.setMostRecentTitle('https://a.test/', '', () => 2000);
      expect(repo.mostRecent()?.title).toBe('A');
    });
  });

  describe('list', () => {
    it('orders by visitedAt DESC and applies limit/offset', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.record({ url: 'https://c.test/', title: 'C' }, () => 3000);
      expect(repo.list().map((e) => e.url)).toEqual([
        'https://c.test/',
        'https://b.test/',
        'https://a.test/',
      ]);
      expect(repo.list({ limit: 2 }).map((e) => e.url)).toEqual([
        'https://c.test/',
        'https://b.test/',
      ]);
      expect(repo.list({ limit: 2, offset: 1 }).map((e) => e.url)).toEqual([
        'https://b.test/',
        'https://a.test/',
      ]);
    });
  });

  describe('search', () => {
    it('matches url or title (case-insensitive LIKE), newest first', () => {
      repo.record({ url: 'https://example.com/news', title: 'Daily News' }, () => 1000);
      repo.record({ url: 'https://other.test/', title: 'Recipes' }, () => 2000);
      repo.record({ url: 'https://example.com/sport', title: 'Sport' }, () => 3000);
      expect(repo.search('example').map((e) => e.url)).toEqual([
        'https://example.com/sport',
        'https://example.com/news',
      ]);
      expect(repo.search('news').map((e) => e.title)).toEqual(['Daily News']);
    });
  });

  describe('remove / clear', () => {
    it('removes a single row by id', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      const id = repo.list()[0].id; // b.test
      repo.remove(id);
      expect(repo.list().map((e) => e.url)).toEqual(['https://a.test/']);
    });

    it('clears all rows', () => {
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.clear();
      expect(repo.list()).toEqual([]);
    });
  });

  describe('mostRecent', () => {
    it('returns undefined when empty and the newest row otherwise', () => {
      expect(repo.mostRecent()).toBeUndefined();
      repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.record({ url: 'https://b.test/', title: 'B' }, () => 2000);
      expect(repo.mostRecent()).toMatchObject({ url: 'https://b.test/', visitedAt: 2000 });
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.record({ url: 'https://a.test/', title: 'A' }, () => 1000);
    const repo2 = new HistoryRepo(db);
    expect(repo2.mostRecent()).toMatchObject({ url: 'https://a.test/' });
  });
});
```

Also add a migration `it` to `electron/main/db/sqlite.test.ts`, inserted immediately before the final `});` that closes the `describe('runMigrations', …)` block:
```ts
    it('creates the history table with the expected columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('history');
      const cols = (db.prepare('PRAGMA table_info(history)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('id');
      expect(cols).toHaveProperty('url');
      expect(cols).toHaveProperty('title');
      expect(cols).toHaveProperty('visitedAt');
      expect(cols.id).toBe(1); // id is the primary key
    });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/historyRepo.test.ts electron/main/db/sqlite.test.ts`

Expected: FAIL — `historyRepo.test.ts` errors with `Failed to resolve import './historyRepo'` (module does not exist); the new `sqlite.test.ts` case fails with `expected undefined to be 'history'` (table not created).

- [ ] **Step 3: Implement**

Edit `electron/main/db/sqlite.ts` — add the `history` table to the SAME `db.exec` block (append inside the template literal, after the `favorites` table from Task 2, before the closing backtick):
```ts
    CREATE TABLE IF NOT EXISTS history (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      url       TEXT    NOT NULL,
      title     TEXT    NOT NULL DEFAULT '',
      visitedAt INTEGER NOT NULL
    );
```

Create `electron/main/db/historyRepo.ts`:
```ts
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/historyRepo.test.ts electron/main/db/sqlite.test.ts`

Expected: PASS (all `historyRepo` cases + the new `history`-table migration case + the pre-existing `sqlite`/`favorites`-table cases green).

- [ ] **Step 5: Commit**
```bash
git add electron/main/db/historyRepo.ts electron/main/db/historyRepo.test.ts electron/main/db/sqlite.ts electron/main/db/sqlite.test.ts
git commit -m "feat(history): add history table migration and HistoryRepo with dedup/trim"
```

---

### Task 4: `saved_list` table migration + `SavedRepo`

**Files:**
- Create: `electron/main/db/savedRepo.ts`
- Modify: `electron/main/db/sqlite.ts` (add `saved_list` table to the single `db.exec` block)
- Test: `electron/main/db/savedRepo.test.ts`
- Test: `electron/main/db/sqlite.test.ts` (add a `saved_list`-table migration `it`)

- [ ] **Step 1: Write the failing test**

Create `electron/main/db/savedRepo.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { SavedRepo } from './savedRepo';

describe('savedRepo', () => {
  let db: Database.Database;
  let repo: SavedRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new SavedRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('list / add', () => {
    it('starts empty', () => {
      expect(repo.list()).toEqual([]);
    });

    it('adds an item with the provided timestamp and returns the list', () => {
      const list = repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ url: 'https://a.test/', title: 'A', savedAt: 1000 });
      expect(typeof list[0].id).toBe('number');
    });

    it('orders by savedAt DESC (newest first)', () => {
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.add({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.add({ url: 'https://c.test/', title: 'C' }, () => 3000);
      expect(repo.list().map((s) => s.url)).toEqual([
        'https://c.test/',
        'https://b.test/',
        'https://a.test/',
      ]);
    });
  });

  describe('remove', () => {
    it('removes one item by id and returns the remaining list', () => {
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.add({ url: 'https://b.test/', title: 'B' }, () => 2000);
      const id = repo.list().find((s) => s.url === 'https://a.test/')!.id;
      const list = repo.remove(id);
      expect(list.map((s) => s.url)).toEqual(['https://b.test/']);
    });
  });

  describe('has', () => {
    it('is true exactly when an item with that url is saved', () => {
      expect(repo.has('https://a.test/')).toBe(false);
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      expect(repo.has('https://a.test/')).toBe(true);
      const id = repo.list()[0].id;
      repo.remove(id);
      expect(repo.has('https://a.test/')).toBe(false);
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
    const repo2 = new SavedRepo(db);
    expect(repo2.has('https://a.test/')).toBe(true);
  });
});
```

Also add a migration `it` to `electron/main/db/sqlite.test.ts`, inserted immediately before the final `});` that closes the `describe('runMigrations', …)` block:
```ts
    it('creates the saved_list table with the expected columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_list'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('saved_list');
      const cols = (db.prepare('PRAGMA table_info(saved_list)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('id');
      expect(cols).toHaveProperty('url');
      expect(cols).toHaveProperty('title');
      expect(cols).toHaveProperty('savedAt');
      expect(cols.id).toBe(1); // id is the primary key
    });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/savedRepo.test.ts electron/main/db/sqlite.test.ts`

Expected: FAIL — `savedRepo.test.ts` errors with `Failed to resolve import './savedRepo'` (module does not exist); the new `sqlite.test.ts` case fails with `expected undefined to be 'saved_list'` (table not created).

- [ ] **Step 3: Implement**

Edit `electron/main/db/sqlite.ts` — add the `saved_list` table to the SAME `db.exec` block (append inside the template literal, after the `history` table from Task 3, before the closing backtick):
```ts
    CREATE TABLE IF NOT EXISTS saved_list (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      url     TEXT    NOT NULL,
      title   TEXT    NOT NULL DEFAULT '',
      savedAt INTEGER NOT NULL
    );
```

Create `electron/main/db/savedRepo.ts`:
```ts
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

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare(
      'SELECT id, url, title, savedAt FROM saved_list ORDER BY savedAt DESC, id DESC',
    );
    this.insertStmt = db.prepare(
      'INSERT INTO saved_list (url, title, savedAt) VALUES (@url, @title, @savedAt)',
    );
    this.deleteStmt = db.prepare('DELETE FROM saved_list WHERE id = @id');
    this.hasStmt = db.prepare('SELECT 1 FROM saved_list WHERE url = @url LIMIT 1');
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
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/savedRepo.test.ts electron/main/db/sqlite.test.ts`

Expected: PASS (all `savedRepo` cases + the new `saved_list`-table migration case + the pre-existing `sqlite`/`favorites`/`history` migration cases green).

- [ ] **Step 5: Commit**
```bash
git add electron/main/db/savedRepo.ts electron/main/db/savedRepo.test.ts electron/main/db/sqlite.ts electron/main/db/sqlite.test.ts
git commit -m "feat(saved): add saved_list table migration and SavedRepo"
```

---

#### New names introduced (Block A)

- **`shared/types.ts`** — interfaces: `Favorite`, `HistoryEntry`, `SavedItem`, `ContentInset`. `IPC` map keys: `viewSetContentInset`, `favoritesList`, `favoritesAdd`, `favoritesUpdate`, `favoritesRemove`, `favoritesReorder`, `favoritesRenameTag`, `favoritesDeleteTag`, `favoritesTagUnion`, `historyList`, `historySearch`, `historyRemove`, `historyClear`, `savedList`, `savedAdd`, `savedRemove`, `savedHas`, `evtHistoryChanged`. `AegisApi` namespaces: `favorites`, `history`, `saved` (plus `view.setContentInset`).
- **`electron/main/db/favoritesRepo.ts`** — `class FavoritesRepo` (methods: `list`, `add`, `update`, `remove`, `reorder`, `tagUnion`, `renameTag`, `deleteTag`).
- **`electron/main/db/historyRepo.ts`** — `class HistoryRepo` (methods: `record`, `setMostRecentTitle`, `list`, `search`, `remove`, `clear`, `mostRecent`).
- **`electron/main/db/savedRepo.ts`** — `class SavedRepo` (methods: `list`, `add`, `remove`, `has`).
- **DB tables** (in `runMigrations`): `favorites`, `history`, `saved_list`.

I have all the verified facts I need. Now I'll write the Block B tasks (5-11), applying all section-8 corrections.

A note on Task 1 (Block A): it adds the Phase-3 IPC channels and AegisApi additions to shared/types.ts. My tasks reference those exact names from contract §3.

Here is the markdown for Block B.

---

### Task 5: `historyRecorder.ts` — wire content WC nav/title events to HistoryRepo

**Files:**
- Create: `electron/main/historyRecorder.ts`
- Test: `electron/main/historyRecorder.test.ts`

- [ ] **Step 1: Write the failing test**

This test uses a **fake repo** (spy methods, per §8.2 — no real timestamps) and a **fake wc** (an object that captures the `.on` handlers and lets the test fire them). It asserts only the event wiring: `did-navigate` → `record`, `did-navigate-in-page` main-frame → `record`, non-main-frame ignored, `page-title-updated` → `setMostRecentTitle`, non-http(s) urls skipped, and `onChanged` fired. It does NOT assert timestamps, dedup, or trim (those are HistoryRepo's concern, in Task 3).

```ts
// electron/main/historyRecorder.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HistoryRecorder } from './historyRecorder';

type Handler = (...args: any[]) => void;

/** A fake WebContents that captures .on handlers and exposes a current title/url. */
function makeFakeWc(title = 'Page Title', url = 'https://example.com/') {
  const handlers = new Map<string, Handler[]>();
  return {
    title,
    url,
    on(event: string, fn: Handler) {
      const arr = handlers.get(event) ?? [];
      arr.push(fn);
      handlers.set(event, arr);
      return this;
    },
    getTitle() {
      return this.title;
    },
    getURL() {
      return this.url;
    },
    /** Fire every handler registered for an event (mimics EventEmitter emit). */
    fire(event: string, ...args: any[]) {
      for (const fn of handlers.get(event) ?? []) fn({}, ...args);
    },
    /** Number of handlers registered for an event. */
    count(event: string) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

/** A fake HistoryRepo: spy methods only (no DB, no timestamps). */
function makeFakeRepo() {
  return {
    record: vi.fn(),
    setMostRecentTitle: vi.fn(),
    mostRecent: vi.fn(),
  };
}

describe('HistoryRecorder', () => {
  it('subscribes to did-navigate, did-navigate-in-page, and page-title-updated', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged: vi.fn() });
    expect(wc.count('did-navigate')).toBe(1);
    expect(wc.count('did-navigate-in-page')).toBe(1);
    expect(wc.count('page-title-updated')).toBe(1);
  });

  it('records {url, current title} and fires onChanged on did-navigate', () => {
    const wc = makeFakeWc('Example Title');
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate', 'https://example.com/page');
    expect(repo.record).toHaveBeenCalledWith({ url: 'https://example.com/page', title: 'Example Title' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('records on a main-frame did-navigate-in-page (SPA)', () => {
    const wc = makeFakeWc('SPA Title');
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate-in-page', 'https://spa.test/route', true);
    expect(repo.record).toHaveBeenCalledWith({ url: 'https://spa.test/route', title: 'SPA Title' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-main-frame did-navigate-in-page', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate-in-page', 'https://spa.test/iframe', false);
    expect(repo.record).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('skips non-http(s) urls (about:blank, file:, app urls)', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate', 'about:blank');
    wc.fire('did-navigate', 'file:///home/x/out/renderer/index.html');
    wc.fire('did-navigate-in-page', 'about:blank', true);
    expect(repo.record).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('updates the most-recent title and fires onChanged on page-title-updated (after a nav)', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate', 'https://example.com/page');
    onChanged.mockClear();
    wc.fire('page-title-updated', 'Updated Title');
    expect(repo.setMostRecentTitle).toHaveBeenCalledWith('https://example.com/page', 'Updated Title');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores page-title-updated before any recordable nav (no lastUrl yet)', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('page-title-updated', 'Title With No Page');
    expect(repo.setMostRecentTitle).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('honors a custom isRecordable predicate', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const isRecordable = vi.fn((u: string) => u.includes('allowed'));
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged: vi.fn(), isRecordable });
    wc.fire('did-navigate', 'https://blocked.test/');
    expect(repo.record).not.toHaveBeenCalled();
    wc.fire('did-navigate', 'https://allowed.test/');
    expect(repo.record).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/historyRecorder.test.ts`

Expected: FAIL — `Failed to resolve import "./historyRecorder"` / `HistoryRecorder is not defined` (the module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/historyRecorder.ts
import type { WebContents } from 'electron';
import type { HistoryRepo } from './db/historyRepo';

/** The subset of WebContents the recorder needs (kept narrow so it is node-testable with a fake). */
type RecorderWc = Pick<WebContents, 'on' | 'getTitle' | 'getURL'>;

export interface HistoryRecorderOpts {
  wc: RecorderWc;
  repo: HistoryRepo;
  onChanged: () => void;
  /** Whether a committed url should be recorded. Defaults to http(s)-only. */
  isRecordable?: (url: string) => boolean;
}

/** Default scheme filter: only http(s) (excludes about:blank, file:, and app chrome urls). */
function defaultIsRecordable(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/**
 * Subscribes to the content WebContents' navigation + title events and records
 * page visits into HistoryRepo. Top-frame commits (`did-navigate`) and SPA
 * main-frame in-page navigations (`did-navigate-in-page`) record the current
 * url + title; a later `page-title-updated` for the most-recent url backfills
 * the title. Dedup/trim/timestamps are HistoryRepo's responsibility.
 */
export class HistoryRecorder {
  private readonly wc: RecorderWc;
  private readonly repo: HistoryRepo;
  private readonly onChanged: () => void;
  private readonly isRecordable: (url: string) => boolean;

  /** The url of the most-recent recordable nav, used to attribute late title updates. */
  private lastUrl: string | null = null;

  constructor(opts: HistoryRecorderOpts) {
    this.wc = opts.wc;
    this.repo = opts.repo;
    this.onChanged = opts.onChanged;
    this.isRecordable = opts.isRecordable ?? defaultIsRecordable;

    this.wc.on('did-navigate', (_event: unknown, url: string) => this.onNav(url));
    this.wc.on('did-navigate-in-page', (_event: unknown, url: string, isMainFrame: boolean) => {
      if (isMainFrame) this.onNav(url);
    });
    this.wc.on('page-title-updated', (_event: unknown, title: string) => {
      if (this.lastUrl) {
        this.repo.setMostRecentTitle(this.lastUrl, title);
        this.onChanged();
      }
    });
  }

  private onNav(url: string): void {
    if (!this.isRecordable(url)) return;
    this.lastUrl = url;
    this.repo.record({ url, title: this.wc.getTitle() });
    this.onChanged();
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/historyRecorder.test.ts`

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/historyRecorder.ts electron/main/historyRecorder.test.ts
git commit -m "feat(history): main-side HistoryRecorder wires nav/title events to HistoryRepo"
```

---

### Task 6: `ipc/favorites.ts` — `buildFavoritesHandlers`

**Files:**
- Create: `electron/main/ipc/favorites.ts`
- Test: `electron/main/ipc/favorites.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/ipc/favorites.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { Favorite } from '../../../shared/types';
import { buildFavoritesHandlers } from './favorites';

function fav(id: number, name: string, url: string, tags: string[], position: number): Favorite {
  return { id, name, url, tags, position };
}

function makeRepo() {
  const list: Favorite[] = [fav(1, 'A', 'https://a.test/', ['x'], 0)];
  return {
    list: vi.fn((): Favorite[] => list),
    add: vi.fn((): Favorite[] => list),
    update: vi.fn((): Favorite[] => list),
    remove: vi.fn((): Favorite[] => list),
    reorder: vi.fn((): Favorite[] => list),
    renameTag: vi.fn((): Favorite[] => list),
    deleteTag: vi.fn((): Favorite[] => list),
    tagUnion: vi.fn((): string[] => ['x', 'y']),
  };
}

describe('buildFavoritesHandlers', () => {
  it('registers exactly the eight favorites channels', () => {
    const handlers = buildFavoritesHandlers(makeRepo() as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC.favoritesList,
        IPC.favoritesAdd,
        IPC.favoritesUpdate,
        IPC.favoritesRemove,
        IPC.favoritesReorder,
        IPC.favoritesRenameTag,
        IPC.favoritesDeleteTag,
        IPC.favoritesTagUnion,
      ].sort(),
    );
  });

  it('favoritesList returns repo.list()', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    const result = handlers[IPC.favoritesList]();
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(result).toEqual(repo.list());
  });

  it('favoritesAdd forwards the input and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    const input = { name: 'B', url: 'https://b.test/', tags: ['y'] };
    const result = handlers[IPC.favoritesAdd](input);
    expect(repo.add).toHaveBeenCalledWith(input);
    expect(result).toEqual(repo.list());
  });

  it('favoritesUpdate forwards (id, partial)', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesUpdate](1, { name: 'Renamed' });
    expect(repo.update).toHaveBeenCalledWith(1, { name: 'Renamed' });
  });

  it('favoritesRemove forwards the id', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesRemove](1);
    expect(repo.remove).toHaveBeenCalledWith(1);
  });

  it('favoritesReorder forwards the id array', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesReorder]([3, 1, 2]);
    expect(repo.reorder).toHaveBeenCalledWith([3, 1, 2]);
  });

  it('favoritesRenameTag forwards (oldT, newT)', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesRenameTag]('x', 'z');
    expect(repo.renameTag).toHaveBeenCalledWith('x', 'z');
  });

  it('favoritesDeleteTag forwards the tag', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesDeleteTag]('x');
    expect(repo.deleteTag).toHaveBeenCalledWith('x');
  });

  it('favoritesTagUnion returns repo.tagUnion()', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    const result = handlers[IPC.favoritesTagUnion]();
    expect(repo.tagUnion).toHaveBeenCalledTimes(1);
    expect(result).toEqual(['x', 'y']);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/ipc/favorites.test.ts`

Expected: FAIL — `Failed to resolve import "./favorites"` (the builder does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/ipc/favorites.ts
import { IPC } from '../../../shared/types';
import type { Favorite } from '../../../shared/types';
import type { FavoritesRepo } from '../db/favoritesRepo';

/**
 * Builds the favorites IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). Every mutation returns the
 * updated Favorite[] (tagUnion returns the distinct sorted tag set) so the renderer
 * syncs from the result.
 */
export function buildFavoritesHandlers(
  repo: FavoritesRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.favoritesList]: (): Favorite[] => repo.list(),
    [IPC.favoritesAdd]: (input: { name: string; url: string; tags: string[] }): Favorite[] =>
      repo.add(input),
    [IPC.favoritesUpdate]: (
      id: number,
      partial: { name?: string; url?: string; tags?: string[] },
    ): Favorite[] => repo.update(id, partial),
    [IPC.favoritesRemove]: (id: number): Favorite[] => repo.remove(id),
    [IPC.favoritesReorder]: (ids: number[]): Favorite[] => repo.reorder(ids),
    [IPC.favoritesRenameTag]: (oldT: string, newT: string): Favorite[] => repo.renameTag(oldT, newT),
    [IPC.favoritesDeleteTag]: (tag: string): Favorite[] => repo.deleteTag(tag),
    [IPC.favoritesTagUnion]: (): string[] => repo.tagUnion(),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/ipc/favorites.test.ts`

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/favorites.ts electron/main/ipc/favorites.test.ts
git commit -m "feat(favorites): buildFavoritesHandlers IPC builder mapping channels to FavoritesRepo"
```

---

### Task 7: `ipc/history.ts` — `buildHistoryHandlers`

**Files:**
- Create: `electron/main/ipc/history.ts`
- Test: `electron/main/ipc/history.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/ipc/history.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { HistoryEntry } from '../../../shared/types';
import { buildHistoryHandlers } from './history';

function entry(id: number, url: string, title: string, visitedAt: number): HistoryEntry {
  return { id, url, title, visitedAt };
}

function makeRepo() {
  const all: HistoryEntry[] = [entry(2, 'https://b.test/', 'B', 200), entry(1, 'https://a.test/', 'A', 100)];
  return {
    list: vi.fn((): HistoryEntry[] => all),
    search: vi.fn((): HistoryEntry[] => [all[0]]),
    remove: vi.fn((): void => undefined),
    clear: vi.fn((): void => undefined),
  };
}

describe('buildHistoryHandlers', () => {
  it('registers exactly the four history channels', () => {
    const handlers = buildHistoryHandlers(makeRepo() as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.historyList, IPC.historySearch, IPC.historyRemove, IPC.historyClear].sort(),
    );
  });

  it('historyList forwards opts and returns repo.list(opts)', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    const result = handlers[IPC.historyList]({ limit: 50, offset: 10 });
    expect(repo.list).toHaveBeenCalledWith({ limit: 50, offset: 10 });
    expect(result).toEqual(repo.list({ limit: 50, offset: 10 }));
  });

  it('historyList works with no opts (undefined passed through)', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    handlers[IPC.historyList]();
    expect(repo.list).toHaveBeenCalledWith(undefined);
  });

  it('historySearch forwards the query and returns the matches', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    const result = handlers[IPC.historySearch]('b.test');
    expect(repo.search).toHaveBeenCalledWith('b.test');
    expect(result).toEqual([repo.list()[0]]);
  });

  it('historyRemove forwards the id', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    handlers[IPC.historyRemove](2);
    expect(repo.remove).toHaveBeenCalledWith(2);
  });

  it('historyClear calls repo.clear()', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    handlers[IPC.historyClear]();
    expect(repo.clear).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/ipc/history.test.ts`

Expected: FAIL — `Failed to resolve import "./history"` (the builder does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/ipc/history.ts
import { IPC } from '../../../shared/types';
import type { HistoryEntry } from '../../../shared/types';
import type { HistoryRepo } from '../db/historyRepo';

/**
 * Builds the history IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). Recording happens main-side
 * via HistoryRecorder; these handlers are read/mutate only (list/search/remove/clear).
 */
export function buildHistoryHandlers(
  repo: HistoryRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.historyList]: (opts?: { limit?: number; offset?: number }): HistoryEntry[] =>
      repo.list(opts),
    [IPC.historySearch]: (q: string): HistoryEntry[] => repo.search(q),
    [IPC.historyRemove]: (id: number): void => repo.remove(id),
    [IPC.historyClear]: (): void => repo.clear(),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/ipc/history.test.ts`

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/history.ts electron/main/ipc/history.test.ts
git commit -m "feat(history): buildHistoryHandlers IPC builder mapping channels to HistoryRepo"
```

---

### Task 8: `ipc/saved.ts` — `buildSavedHandlers`

**Files:**
- Create: `electron/main/ipc/saved.ts`
- Test: `electron/main/ipc/saved.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/ipc/saved.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { SavedItem } from '../../../shared/types';
import { buildSavedHandlers } from './saved';

function item(id: number, url: string, title: string, savedAt: number): SavedItem {
  return { id, url, title, savedAt };
}

function makeRepo() {
  const list: SavedItem[] = [item(1, 'https://a.test/', 'A', 100)];
  return {
    list: vi.fn((): SavedItem[] => list),
    add: vi.fn((): SavedItem[] => list),
    remove: vi.fn((): SavedItem[] => list),
    has: vi.fn((url: string): boolean => url === 'https://a.test/'),
  };
}

describe('buildSavedHandlers', () => {
  it('registers exactly the four saved channels', () => {
    const handlers = buildSavedHandlers(makeRepo() as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.savedList, IPC.savedAdd, IPC.savedRemove, IPC.savedHas].sort(),
    );
  });

  it('savedList returns repo.list()', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const result = handlers[IPC.savedList]();
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(result).toEqual(repo.list());
  });

  it('savedAdd forwards the input and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const input = { url: 'https://b.test/', title: 'B' };
    const result = handlers[IPC.savedAdd](input);
    expect(repo.add).toHaveBeenCalledWith(input);
    expect(result).toEqual(repo.list());
  });

  it('savedRemove forwards the id and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const result = handlers[IPC.savedRemove](1);
    expect(repo.remove).toHaveBeenCalledWith(1);
    expect(result).toEqual(repo.list());
  });

  it('savedHas forwards the url and returns the boolean', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    expect(handlers[IPC.savedHas]('https://a.test/')).toBe(true);
    expect(handlers[IPC.savedHas]('https://missing.test/')).toBe(false);
    expect(repo.has).toHaveBeenCalledWith('https://missing.test/');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/ipc/saved.test.ts`

Expected: FAIL — `Failed to resolve import "./saved"` (the builder does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/ipc/saved.ts
import { IPC } from '../../../shared/types';
import type { SavedItem } from '../../../shared/types';
import type { SavedRepo } from '../db/savedRepo';

/**
 * Builds the saved-list IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). add/remove return the updated
 * SavedItem[]; has(url) backs the toolbar bookmark fill-in.
 */
export function buildSavedHandlers(
  repo: SavedRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.savedList]: (): SavedItem[] => repo.list(),
    [IPC.savedAdd]: (input: { url: string; title: string }): SavedItem[] => repo.add(input),
    [IPC.savedRemove]: (id: number): SavedItem[] => repo.remove(id),
    [IPC.savedHas]: (url: string): boolean => repo.has(url),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/ipc/saved.test.ts`

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/saved.ts electron/main/ipc/saved.test.ts
git commit -m "feat(saved): buildSavedHandlers IPC builder mapping channels to SavedRepo"
```

---

### Task 9: Inset-driven `layout()` + `ipc/viewLayout.ts` + history-changed forwarder

**Files:**
- Modify: `electron/main/window.ts:46-61` (the `layout` function)
- Create: `electron/main/window.test.ts`
- Create: `electron/main/ipc/viewLayout.ts`
- Create: `electron/main/ipc/viewLayout.test.ts`
- Modify: `electron/main/ipc/nav.ts:31-39` (extend `buildViewEventForwarders` with `onHistoryChanged`)
- Modify: `electron/main/ipc/nav.test.ts` (assert the new forwarder) — see note below

This task delivers the three small main-side layout pieces: (a) `layout()` accepts an inset; (b) the `view.setContentInset` handler builder; (c) the `onHistoryChanged` forwarder (per §4 of the ledger, extend `buildViewEventForwarders`). It is naturally red-green for `viewLayout` and the forwarder; `window.ts`'s `layout` is exercised by a new `window.test.ts` with a fake `BaseWindow`/`WebContentsView`.

> Note on `nav.test.ts`: it is an existing file. The Step-1 below shows the FULL block to APPEND to it (a new `describe`). If the existing forwarder test asserts the exact key set of `buildViewEventForwarders` with `toEqual`, also update that assertion to include `onHistoryChanged` — verify by reading the file before editing.

- [ ] **Step 1: Write the failing tests**

`electron/main/window.test.ts` (CREATE — per §8.6 no such file exists):

```ts
// electron/main/window.test.ts
import { describe, it, expect, vi } from 'vitest';
import { layout } from './window';
import { CHROME_TOP_HEIGHT } from './constants';

/** A fake BaseWindow exposing only getContentBounds. */
function makeWin(width: number, height: number) {
  return { getContentBounds: () => ({ x: 0, y: 0, width, height }) } as any;
}

/** A fake WebContentsView capturing the last setBounds call. */
function makeView() {
  const calls: Array<{ x: number; y: number; width: number; height: number }> = [];
  return {
    calls,
    setBounds: vi.fn((b: { x: number; y: number; width: number; height: number }) => {
      calls.push(b);
    }),
  } as any;
}

describe('layout', () => {
  it('sets chrome to the full window bounds', () => {
    const win = makeWin(1000, 800);
    const chrome = makeView();
    layout(win, chrome);
    expect(chrome.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('defaults the content inset to { top: CHROME_TOP_HEIGHT, left: 0 } when none is given', () => {
    const win = makeWin(1000, 800);
    const chrome = makeView();
    const content = makeView();
    layout(win, chrome, content);
    expect(content.setBounds).toHaveBeenCalledWith({
      x: 0,
      y: CHROME_TOP_HEIGHT,
      width: 1000,
      height: 800 - CHROME_TOP_HEIGHT,
    });
  });

  it('positions content using a provided inset (top + left)', () => {
    const win = makeWin(1000, 800);
    const chrome = makeView();
    const content = makeView();
    layout(win, chrome, content, { top: 96, left: 280 });
    expect(content.setBounds).toHaveBeenCalledWith({
      x: 280,
      y: 96,
      width: 1000 - 280,
      height: 800 - 96,
    });
    // Chrome stays full-window regardless of the inset.
    expect(chrome.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('does not touch the content view when none is given', () => {
    const win = makeWin(640, 480);
    const chrome = makeView();
    expect(() => layout(win, chrome)).not.toThrow();
    expect(chrome.setBounds).toHaveBeenCalledTimes(1);
  });
});
```

`electron/main/ipc/viewLayout.test.ts` (CREATE):

```ts
// electron/main/ipc/viewLayout.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC, PRIMARY_VIEW_ID } from '../../../shared/types';
import { buildViewLayoutHandlers } from './viewLayout';

describe('buildViewLayoutHandlers', () => {
  it('registers exactly the view.setContentInset channel', () => {
    const handlers = buildViewLayoutHandlers(vi.fn());
    expect(Object.keys(handlers)).toEqual([IPC.viewSetContentInset]);
  });

  it('forwards (inset.top, inset.left) to setContentInset', () => {
    const setContentInset = vi.fn();
    const handlers = buildViewLayoutHandlers(setContentInset);
    handlers[IPC.viewSetContentInset](PRIMARY_VIEW_ID, { top: 96, left: 280 });
    expect(setContentInset).toHaveBeenCalledWith(96, 280);
  });

  it('forwards top with a zero left', () => {
    const setContentInset = vi.fn();
    const handlers = buildViewLayoutHandlers(setContentInset);
    handlers[IPC.viewSetContentInset](PRIMARY_VIEW_ID, { top: 56, left: 0 });
    expect(setContentInset).toHaveBeenCalledWith(56, 0);
  });
});
```

`electron/main/ipc/nav.test.ts` (APPEND this `describe` block):

```ts
describe('buildViewEventForwarders — history.changed', () => {
  it('exposes onHistoryChanged that sends IPC.evtHistoryChanged with no payload', () => {
    const send = vi.fn();
    const chromeWc = { send } as unknown as Electron.WebContents;
    const fwd = buildViewEventForwarders(chromeWc);
    expect(typeof fwd.onHistoryChanged).toBe('function');
    fwd.onHistoryChanged();
    expect(send).toHaveBeenCalledWith(IPC.evtHistoryChanged);
  });
});
```

> Before appending, confirm `nav.test.ts` already imports `{ describe, it, expect, vi }` from `vitest` and `{ IPC }` from `'../../../shared/types'`. If it does not import `vi`, add it to the existing import. (Read the file first.)

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run electron/main/window.test.ts electron/main/ipc/viewLayout.test.ts electron/main/ipc/nav.test.ts`

Expected: FAIL — `viewLayout` import unresolved (`buildViewLayoutHandlers` missing); `window.test.ts` "positions content using a provided inset" fails because `layout` ignores the 4th arg (current signature has no `inset`); the nav test fails because `fwd.onHistoryChanged` is `undefined`.

- [ ] **Step 3: Implement**

`electron/main/window.ts` — replace the `layout` function (lines 42-61) with:

```ts
/**
 * Positions the chrome view over the whole window and, if given, the content
 * view inset by `inset` (default { top: CHROME_TOP_HEIGHT, left: 0 } until the
 * renderer reports its computed inset — avoids a boot race). The renderer owns
 * chrome layout and reports the inset via view.setContentInset; index.ts holds
 * the latest inset and re-applies it on resize. Call on window resize.
 */
export function layout(
  win: BaseWindow,
  chromeView: WebContentsView,
  contentView?: WebContentsView,
  inset: { top: number; left: number } = { top: CHROME_TOP_HEIGHT, left: 0 },
): void {
  const { width, height } = win.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width, height });
  if (contentView) {
    contentView.setBounds({
      x: inset.left,
      y: inset.top,
      width: width - inset.left,
      height: height - inset.top,
    });
  }
}
```

`electron/main/ipc/viewLayout.ts` (CREATE):

```ts
// electron/main/ipc/viewLayout.ts
import { IPC } from '../../../shared/types';
import type { ViewId, ContentInset } from '../../../shared/types';

/**
 * Builds the view-layout IPC handler map (channel -> handler). The renderer
 * computes the content inset (top = toolbar + favorites-bar height; left =
 * sidebar width when open) from known layout constants and reports it here;
 * the handler forwards (top, left) to the supplied setContentInset closure,
 * which repositions the content WebContentsView in main (index.ts).
 */
export function buildViewLayoutHandlers(
  setContentInset: (top: number, left: number) => void,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.viewSetContentInset]: (_viewId: ViewId, inset: ContentInset) =>
      setContentInset(inset.top, inset.left),
  };
}
```

`electron/main/ipc/nav.ts` — replace `buildViewEventForwarders` (lines 31-39) with:

```ts
/**
 * Builds the main->chrome event forwarders that ViewController invokes (onState/
 * onFailed/onCrashed), plus onHistoryChanged which the HistoryRecorder's onChanged
 * is wired to in boot so an open history panel can refresh. Each forwarder sends the
 * matching push-event channel on the chrome WebContents.
 */
export function buildViewEventForwarders(
  chromeWc: Electron.WebContents,
): Pick<ViewControllerOpts, 'onState' | 'onFailed' | 'onCrashed'> & {
  onHistoryChanged: () => void;
} {
  return {
    onState: (s: NavState) => chromeWc.send(IPC.evtNavState, s),
    onFailed: (f: NavFailed) => chromeWc.send(IPC.evtNavFailed, f),
    onCrashed: (c: NavCrashed) => chromeWc.send(IPC.evtNavCrashed, c),
    onHistoryChanged: () => chromeWc.send(IPC.evtHistoryChanged),
  };
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run electron/main/window.test.ts electron/main/ipc/viewLayout.test.ts electron/main/ipc/nav.test.ts`

Expected: PASS (window.test.ts 4 tests; viewLayout.test.ts 3 tests; nav.test.ts existing + the new history.changed test all green).

- [ ] **Step 5: Commit**

```bash
git add electron/main/window.ts electron/main/window.test.ts electron/main/ipc/viewLayout.ts electron/main/ipc/viewLayout.test.ts electron/main/ipc/nav.ts electron/main/ipc/nav.test.ts
git commit -m "feat(sidebar): inset-driven layout(), buildViewLayoutHandlers, and onHistoryChanged forwarder"
```

---

### Task 10: Boot wiring in `index.ts` (repos + recorder + handlers + inset state + `__aegisTest.places`)

This is a boot-wiring task (not naturally red-green): show the FULL edited code, verify with `npm run build`, then commit. Runtime behavior is exercised by the Block-E e2e (Tasks 23-26), which depend on the `__aegisTest.places` registry added here (§8.1).

**Files:**
- Modify: `electron/main/index.ts` (imports; construct repos + recorder; inset state; register new handlers; `__aegisTest.places`)

- [ ] **Step 1: Apply the edits**

Add imports (after the existing repo imports, line 9-10 region — add three repo imports + the recorder + the three IPC builders + the viewLayout builder):

```ts
import { SettingsRepo } from './db/settingsRepo';
import { AdblockRepo } from './db/adblockRepo';
import { SubsRepo } from './db/subsRepo';
import { FavoritesRepo } from './db/favoritesRepo';
import { HistoryRepo } from './db/historyRepo';
import { SavedRepo } from './db/savedRepo';
import { HistoryRecorder } from './historyRecorder';
```

Add the IPC builder imports alongside the existing ones (line 13-16 region):

```ts
import { buildNavHandlers, buildViewEventForwarders } from './ipc/nav';
import { buildSettingsHandlers } from './ipc/settings';
import { buildAdblockHandlers } from './ipc/adblock';
import { buildListsHandlers } from './ipc/lists';
import { buildFavoritesHandlers } from './ipc/favorites';
import { buildHistoryHandlers } from './ipc/history';
import { buildSavedHandlers } from './ipc/saved';
import { buildViewLayoutHandlers } from './ipc/viewLayout';
```

Construct the three new repos in the persistence block (after `subsRepo.seedDefaults(...)`, around line 61):

```ts
  const settingsRepo = new SettingsRepo(db);
  const adblockRepo = new AdblockRepo(db);
  const subsRepo = new SubsRepo(db);
  subsRepo.seedDefaults(DEFAULT_LIST_URLS);
  const favoritesRepo = new FavoritesRepo(db);
  const historyRepo = new HistoryRepo(db);
  const savedRepo = new SavedRepo(db);
```

Replace the compose/layout block (current lines 89-92) with the inset-aware version that holds the inset, defines `setContentInset`, re-applies on resize, and constructs the recorder wired to the `onHistoryChanged` forwarder:

```ts
  // Compose: chrome added first by window.ts; index.ts adds the content view over it.
  win.contentView.addChildView(vc.view);

  // Content inset: the renderer reports { top, left } via view.setContentInset; main
  // holds the latest inset and re-applies it on resize (default top=56,left=0 until
  // the renderer reports — avoids a boot race).
  let contentInset = { top: CHROME_TOP_HEIGHT, left: 0 };
  const setContentInset = (top: number, left: number): void => {
    contentInset = { top, left };
    layout(win, chromeView, vc.view, contentInset);
  };
  layout(win, chromeView, vc.view, contentInset);
  win.on('resize', () => layout(win, chromeView, vc.view, contentInset));

  // History recording: main-side, on the content WebContents' nav/title events.
  // onChanged pushes history.changed so an open renderer history panel refreshes.
  new HistoryRecorder({
    wc: vc.contentWebContents,
    repo: historyRepo,
    onChanged: fwd.onHistoryChanged,
  });
```

This requires `CHROME_TOP_HEIGHT` + `layout` to be in scope. `layout` is already imported (line 5: `import { createMainWindow, layout } from './window';`). Add `CHROME_TOP_HEIGHT` to that import — change line 5 to:

```ts
import { createMainWindow, layout } from './window';
import { CHROME_TOP_HEIGHT } from './constants';
```

Register the new handlers in `registerGuardedHandlers` (current lines 174-179):

```ts
  registerGuardedHandlers(chromeWc.id, {
    ...buildNavHandlers(vc, settingsRepo),
    ...buildSettingsHandlers(settingsRepo),
    ...buildAdblockHandlers(controller),
    ...buildListsHandlers(updateNow),
    ...buildFavoritesHandlers(favoritesRepo),
    ...buildHistoryHandlers(historyRepo),
    ...buildSavedHandlers(savedRepo),
    ...buildViewLayoutHandlers(setContentInset),
  });
```

Extend the `__aegisTest` registry with the `places` key (§8.1 — exact names; current lines 182-197):

```ts
  // Test-only registry (never in production paths).
  if (process.env.AEGIS_E2E === '1') {
    (globalThis as any).__aegisTest = {
      primary: vc,
      chromeWcId: chromeWc.id,
      adblock: {
        controller,
        engineSource,
        snapshotCount: () => controller.snapshotCount(),
        isBlockingActive: () => controller.isBlockingActive(),
        setEnabled: (b: boolean) => controller.setEnabled(b),
        toggleAllowlist: (h: string) => controller.toggleAllowlist(h),
        getState: () => controller.getState(),
        updateNow,
      },
      places: { favoritesRepo, historyRepo, savedRepo, setContentInset },
    };
  }
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`

Expected: build succeeds with no TypeScript errors (the new imports resolve, the recorder/handlers/inset wiring typecheck, `__aegisTest.places` is well-typed).

- [ ] **Step 3: Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(history,sidebar): boot wiring — repos, HistoryRecorder, new IPC handlers, content inset, __aegisTest.places"
```

---

### Task 11: `chromePreload.ts` additions (favorites/history/saved + view.setContentInset + onHistoryChanged)

**Files:**
- Modify: `electron/preload/chromePreload.ts` (import the new types; add `favorites`/`history`/`saved` namespaces; add `view.setContentInset`)
- Modify: `electron/preload/chromePreload.test.ts` (assert the new bridge surface)

> `src/lib/ipcClient.ts` only re-exports `window.aegis` typed as `AegisApi` — it does NOT re-type the API, so it needs no change (verified: it is a single `export const aegis: AegisApi = window.aegis;`). The `AegisApi` additions land in Task 1 (Block A).

- [ ] **Step 1: Write the failing tests**

Append this `describe` block to `electron/preload/chromePreload.test.ts`:

```ts
describe('chromePreload favorites + history + saved + inset (Phase 3)', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  it('exposes favorites, history, and saved namespaces + view.setContentInset', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.favorites.list).toBe('function');
    expect(typeof api.favorites.add).toBe('function');
    expect(typeof api.favorites.update).toBe('function');
    expect(typeof api.favorites.remove).toBe('function');
    expect(typeof api.favorites.reorder).toBe('function');
    expect(typeof api.favorites.renameTag).toBe('function');
    expect(typeof api.favorites.deleteTag).toBe('function');
    expect(typeof api.favorites.tagUnion).toBe('function');
    expect(typeof api.history.list).toBe('function');
    expect(typeof api.history.search).toBe('function');
    expect(typeof api.history.remove).toBe('function');
    expect(typeof api.history.clear).toBe('function');
    expect(typeof api.history.onChanged).toBe('function');
    expect(typeof api.saved.list).toBe('function');
    expect(typeof api.saved.add).toBe('function');
    expect(typeof api.saved.remove).toBe('function');
    expect(typeof api.saved.has).toBe('function');
    expect(typeof api.view.setContentInset).toBe('function');
  });

  it('favorites.add invokes IPC.favoritesAdd with the input', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const input = { name: 'A', url: 'https://a.test/', tags: ['x'] };
    await api.favorites.add(input);
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesAdd, input);
  });

  it('favorites.update invokes IPC.favoritesUpdate with (id, partial)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.favorites.update(7, { name: 'R' });
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesUpdate, 7, { name: 'R' });
  });

  it('favorites.reorder invokes IPC.favoritesReorder with the id array', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.favorites.reorder([3, 1, 2]);
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesReorder, [3, 1, 2]);
  });

  it('favorites.renameTag and deleteTag invoke their channels with args', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.favorites.renameTag('old', 'new');
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesRenameTag, 'old', 'new');
    await api.favorites.deleteTag('old');
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesDeleteTag, 'old');
  });

  it('favorites.tagUnion invokes IPC.favoritesTagUnion and returns the resolved set', async () => {
    h.invoke = vi.fn(async () => ['a', 'b']);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const result = await api.favorites.tagUnion();
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesTagUnion);
    expect(result).toEqual(['a', 'b']);
  });

  it('history.list invokes IPC.historyList with opts', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.history.list({ limit: 50 });
    expect(h.invoke).toHaveBeenCalledWith(IPC.historyList, { limit: 50 });
  });

  it('history.search invokes IPC.historySearch with the query', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.history.search('q');
    expect(h.invoke).toHaveBeenCalledWith(IPC.historySearch, 'q');
  });

  it('history.remove and clear invoke their channels', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.history.remove(9);
    expect(h.invoke).toHaveBeenCalledWith(IPC.historyRemove, 9);
    await api.history.clear();
    expect(h.invoke).toHaveBeenCalledWith(IPC.historyClear);
  });

  it('history.onChanged registers on IPC.evtHistoryChanged and delivers (no payload)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    api.history.onChanged(cb);
    const arr = h.listeners.get(IPC.evtHistoryChanged)!;
    expect(arr).toHaveLength(1);
    arr[0]({}, undefined);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('history.onChanged returns an unsubscriber that removes the listener', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    const off = api.history.onChanged(cb);
    const registered = h.listeners.get(IPC.evtHistoryChanged)![0];
    off();
    expect(h.removed).toEqual([{ channel: IPC.evtHistoryChanged, fn: registered }]);
  });

  it('saved.add invokes IPC.savedAdd with the input', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const input = { url: 'https://a.test/', title: 'A' };
    await api.saved.add(input);
    expect(h.invoke).toHaveBeenCalledWith(IPC.savedAdd, input);
  });

  it('saved.has invokes IPC.savedHas with the url and returns the boolean', async () => {
    h.invoke = vi.fn(async () => true);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const result = await api.saved.has('https://a.test/');
    expect(h.invoke).toHaveBeenCalledWith(IPC.savedHas, 'https://a.test/');
    expect(result).toBe(true);
  });

  it('saved.remove invokes IPC.savedRemove with the id', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.saved.remove(4);
    expect(h.invoke).toHaveBeenCalledWith(IPC.savedRemove, 4);
  });

  it('view.setContentInset invokes IPC.viewSetContentInset with (viewId, inset)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.view.setContentInset(PRIMARY_VIEW_ID, { top: 96, left: 280 });
    expect(h.invoke).toHaveBeenCalledWith(IPC.viewSetContentInset, PRIMARY_VIEW_ID, { top: 96, left: 280 });
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run electron/preload/chromePreload.test.ts`

Expected: FAIL — `api.favorites is undefined` / `api.history is undefined` / `api.saved is undefined` / `api.view.setContentInset is not a function` (the bridge object lacks these namespaces; the new `describe` block fails on the first `typeof` assertions).

- [ ] **Step 3: Implement**

Replace the imports (lines 4-7) to add the new types:

```ts
import type {
  AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings,
  AdblockState, BlockedCount, ListUpdateResult,
  Favorite, HistoryEntry, SavedItem, ContentInset,
} from '../../shared/types';
```

Add `view.setContentInset` to the existing `view` namespace (lines 28-31):

```ts
  view: {
    setContentVisible: (viewId: ViewId, visible: boolean) =>
      ipcRenderer.invoke(IPC.viewSetContentVisible, viewId, visible),
    setContentInset: (viewId: ViewId, inset: ContentInset) =>
      ipcRenderer.invoke(IPC.viewSetContentInset, viewId, inset),
  },
```

Add the three new namespaces to the `api` object (after the `lists` namespace, before the closing `};` at line 48):

```ts
  favorites: {
    list: (): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesList),
    add: (input: { name: string; url: string; tags: string[] }): Promise<Favorite[]> =>
      ipcRenderer.invoke(IPC.favoritesAdd, input),
    update: (
      id: number,
      partial: { name?: string; url?: string; tags?: string[] },
    ): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesUpdate, id, partial),
    remove: (id: number): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesRemove, id),
    reorder: (ids: number[]): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesReorder, ids),
    renameTag: (oldT: string, newT: string): Promise<Favorite[]> =>
      ipcRenderer.invoke(IPC.favoritesRenameTag, oldT, newT),
    deleteTag: (tag: string): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesDeleteTag, tag),
    tagUnion: (): Promise<string[]> => ipcRenderer.invoke(IPC.favoritesTagUnion),
  },
  history: {
    list: (opts?: { limit?: number; offset?: number }): Promise<HistoryEntry[]> =>
      ipcRenderer.invoke(IPC.historyList, opts),
    search: (q: string): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.historySearch, q),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.historyRemove, id),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),
    onChanged: (cb: () => void) => subscribe<unknown>(IPC.evtHistoryChanged, () => cb()),
  },
  saved: {
    list: (): Promise<SavedItem[]> => ipcRenderer.invoke(IPC.savedList),
    add: (input: { url: string; title: string }): Promise<SavedItem[]> =>
      ipcRenderer.invoke(IPC.savedAdd, input),
    remove: (id: number): Promise<SavedItem[]> => ipcRenderer.invoke(IPC.savedRemove, id),
    has: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.savedHas, url),
  },
```

The full edited `api` object now reads (for clarity — this is the complete object after the edits above):

```ts
const api: AegisApi = {
  nav: {
    navigate: (viewId: ViewId, url: string) => ipcRenderer.invoke(IPC.navNavigate, viewId, url),
    back: (viewId: ViewId) => ipcRenderer.invoke(IPC.navBack, viewId),
    forward: (viewId: ViewId) => ipcRenderer.invoke(IPC.navForward, viewId),
    reloadOrStop: (viewId: ViewId) => ipcRenderer.invoke(IPC.navReloadOrStop, viewId),
    home: (viewId: ViewId) => ipcRenderer.invoke(IPC.navHome, viewId),
    getState: (viewId: ViewId): Promise<NavState> => ipcRenderer.invoke(IPC.navGetState, viewId),
    onState: (cb: (s: NavState) => void) => subscribe<NavState>(IPC.evtNavState, cb),
    onFailed: (cb: (f: NavFailed) => void) => subscribe<NavFailed>(IPC.evtNavFailed, cb),
    onCrashed: (cb: (c: NavCrashed) => void) => subscribe<NavCrashed>(IPC.evtNavCrashed, cb),
  },
  view: {
    setContentVisible: (viewId: ViewId, visible: boolean) =>
      ipcRenderer.invoke(IPC.viewSetContentVisible, viewId, visible),
    setContentInset: (viewId: ViewId, inset: ContentInset) =>
      ipcRenderer.invoke(IPC.viewSetContentInset, viewId, inset),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (partial: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, partial),
  },
  adblock: {
    setEnabled: (enabled: boolean): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockSetEnabled, enabled),
    toggleAllowlist: (host: string): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockToggleAllowlist, host),
    getState: (): Promise<AdblockState> => ipcRenderer.invoke(IPC.adblockGetState),
    onBlockedCount: (cb: (c: BlockedCount) => void) =>
      subscribe<BlockedCount>(IPC.evtAdblockBlockedCount, cb),
  },
  lists: {
    updateNow: (): Promise<ListUpdateResult> => ipcRenderer.invoke(IPC.listsUpdateNow),
  },
  favorites: {
    list: (): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesList),
    add: (input: { name: string; url: string; tags: string[] }): Promise<Favorite[]> =>
      ipcRenderer.invoke(IPC.favoritesAdd, input),
    update: (
      id: number,
      partial: { name?: string; url?: string; tags?: string[] },
    ): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesUpdate, id, partial),
    remove: (id: number): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesRemove, id),
    reorder: (ids: number[]): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesReorder, ids),
    renameTag: (oldT: string, newT: string): Promise<Favorite[]> =>
      ipcRenderer.invoke(IPC.favoritesRenameTag, oldT, newT),
    deleteTag: (tag: string): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesDeleteTag, tag),
    tagUnion: (): Promise<string[]> => ipcRenderer.invoke(IPC.favoritesTagUnion),
  },
  history: {
    list: (opts?: { limit?: number; offset?: number }): Promise<HistoryEntry[]> =>
      ipcRenderer.invoke(IPC.historyList, opts),
    search: (q: string): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.historySearch, q),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.historyRemove, id),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),
    onChanged: (cb: () => void) => subscribe<unknown>(IPC.evtHistoryChanged, () => cb()),
  },
  saved: {
    list: (): Promise<SavedItem[]> => ipcRenderer.invoke(IPC.savedList),
    add: (input: { url: string; title: string }): Promise<SavedItem[]> =>
      ipcRenderer.invoke(IPC.savedAdd, input),
    remove: (id: number): Promise<SavedItem[]> => ipcRenderer.invoke(IPC.savedRemove, id),
    has: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.savedHas, url),
  },
};
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `npx vitest run electron/preload/chromePreload.test.ts`

Expected: PASS (the existing Phase-0/1 preload tests plus the new Phase-3 namespace/inset/onChanged tests all green).

- [ ] **Step 5: Commit**

```bash
git add electron/preload/chromePreload.ts electron/preload/chromePreload.test.ts
git commit -m "feat(places): expose favorites/history/saved + view.setContentInset + onHistoryChanged on window.aegis"
```

---

#### New names introduced (Block B)

- `HistoryRecorder` (class) — `electron/main/historyRecorder.ts`
- `HistoryRecorderOpts` (interface) — `electron/main/historyRecorder.ts`
- `buildFavoritesHandlers` (function) — `electron/main/ipc/favorites.ts`
- `buildHistoryHandlers` (function) — `electron/main/ipc/history.ts`
- `buildSavedHandlers` (function) — `electron/main/ipc/saved.ts`
- `buildViewLayoutHandlers` (function) — `electron/main/ipc/viewLayout.ts`
- `setContentInset` (boot-local closure `(top:number,left:number)=>void`) — `electron/main/index.ts` (also surfaced on `__aegisTest.places.setContentInset`)
- `onHistoryChanged` (new field on the `buildViewEventForwarders` return) — `electron/main/ipc/nav.ts`
- `__aegisTest.places` (e2e registry key `{ favoritesRepo, historyRepo, savedRepo, setContentInset }`) — `electron/main/index.ts`
- `layout`'s new 4th parameter `inset: { top: number; left: number }` (signature extension, not a new export) — `electron/main/window.ts`
- `aegis.favorites`, `aegis.history`, `aegis.saved` namespaces + `aegis.view.setContentInset` (preload bridge surface; `AegisApi` shape originates in Block A Task 1) — `electron/preload/chromePreload.ts`

I now have everything I need. I have verified: the hook pattern (`vi.mock('../lib/ipcClient', …)`, `renderHook`/`waitFor`/`act`), component pattern (`render`/`screen`/`userEvent`, a11y roles/names), `useDialog` reuse, `hostOf` helper, and the type contracts. Now I'll write the Block C task markdown for Tasks 12-17.

### Task 12: `useFavorites` hook + test

**Files:**
- Create: `src/hooks/useFavorites.ts`
- Test: `src/hooks/useFavorites.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/hooks/useFavorites.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Favorite } from '../../shared/types';

const list = vi.fn();
const add = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const reorder = vi.fn();
const renameTag = vi.fn();
const deleteTag = vi.fn();
const tagUnion = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    favorites: {
      list: (...a: any[]) => list(...a),
      add: (...a: any[]) => add(...a),
      update: (...a: any[]) => update(...a),
      remove: (...a: any[]) => remove(...a),
      reorder: (...a: any[]) => reorder(...a),
      renameTag: (...a: any[]) => renameTag(...a),
      deleteTag: (...a: any[]) => deleteTag(...a),
      tagUnion: (...a: any[]) => tagUnion(...a),
    },
  },
}));

import { useFavorites } from './useFavorites';

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Example',
  url: 'https://example.com/',
  tags: ['news'],
  position: 0,
  ...over,
});

const seedFavs: Favorite[] = [
  fav({ id: 1, name: 'A', url: 'https://a.example/', tags: ['news'], position: 0 }),
  fav({ id: 2, name: 'B', url: 'https://b.example/', tags: ['dev', 'news'], position: 1 }),
  fav({ id: 3, name: 'C', url: 'https://c.example/', tags: ['dev'], position: 2 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seedFavs);
  tagUnion.mockResolvedValue(['dev', 'news']);
  add.mockResolvedValue(seedFavs);
  update.mockResolvedValue(seedFavs);
  remove.mockResolvedValue(seedFavs);
  reorder.mockResolvedValue(seedFavs);
  renameTag.mockResolvedValue(seedFavs);
  deleteTag.mockResolvedValue(seedFavs);
});

describe('useFavorites', () => {
  it('seeds favorites and tagUnion on mount', async () => {
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    expect(list).toHaveBeenCalledTimes(1);
    expect(tagUnion).toHaveBeenCalledTimes(1);
    expect(result.current.tagUnion).toEqual(['dev', 'news']);
    expect(result.current.activeTags).toEqual([]);
  });

  it('with no active tags, favorites is the full list', async () => {
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    expect(result.current.favorites.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('filters favorites to those having ALL active tags', async () => {
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    act(() => result.current.setActiveTags(['dev']));
    expect(result.current.favorites.map((f) => f.id)).toEqual([2, 3]);
    act(() => result.current.setActiveTags(['dev', 'news']));
    expect(result.current.favorites.map((f) => f.id)).toEqual([2]);
  });

  it('add() calls aegis and refreshes favorites + tagUnion from results', async () => {
    const added: Favorite[] = [...seedFavs, fav({ id: 4, name: 'D', url: 'https://d.example/', tags: ['x'], position: 3 })];
    add.mockResolvedValue(added);
    tagUnion.mockResolvedValueOnce(['dev', 'news']).mockResolvedValue(['dev', 'news', 'x']);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.add({ name: 'D', url: 'https://d.example/', tags: ['x'] });
    });
    expect(add).toHaveBeenCalledWith({ name: 'D', url: 'https://d.example/', tags: ['x'] });
    expect(result.current.favorites).toHaveLength(4);
    expect(result.current.tagUnion).toEqual(['dev', 'news', 'x']);
  });

  it('update() calls aegis with id + partial and refreshes from the result', async () => {
    const updated = [fav({ id: 1, name: 'A2' }), seedFavs[1], seedFavs[2]];
    update.mockResolvedValue(updated);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.update(1, { name: 'A2' });
    });
    expect(update).toHaveBeenCalledWith(1, { name: 'A2' });
    expect(result.current.favorites[0].name).toBe('A2');
  });

  it('remove() calls aegis and refreshes the list', async () => {
    remove.mockResolvedValue([seedFavs[1], seedFavs[2]]);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.remove(1);
    });
    expect(remove).toHaveBeenCalledWith(1);
    expect(result.current.favorites.map((f) => f.id)).toEqual([2, 3]);
  });

  it('reorder() calls aegis with the id order and refreshes', async () => {
    reorder.mockResolvedValue([seedFavs[2], seedFavs[1], seedFavs[0]]);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.reorder([3, 2, 1]);
    });
    expect(reorder).toHaveBeenCalledWith([3, 2, 1]);
    expect(result.current.favorites.map((f) => f.id)).toEqual([3, 2, 1]);
  });

  it('renameTag() calls aegis and refreshes favorites + tagUnion', async () => {
    const renamed = seedFavs.map((f) => ({ ...f, tags: f.tags.map((t) => (t === 'dev' ? 'engineering' : t)) }));
    renameTag.mockResolvedValue(renamed);
    tagUnion.mockResolvedValueOnce(['dev', 'news']).mockResolvedValue(['engineering', 'news']);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.renameTag('dev', 'engineering');
    });
    expect(renameTag).toHaveBeenCalledWith('dev', 'engineering');
    expect(result.current.tagUnion).toEqual(['engineering', 'news']);
  });

  it('deleteTag() calls aegis and refreshes favorites + tagUnion', async () => {
    const purged = seedFavs.map((f) => ({ ...f, tags: f.tags.filter((t) => t !== 'dev') }));
    deleteTag.mockResolvedValue(purged);
    tagUnion.mockResolvedValueOnce(['dev', 'news']).mockResolvedValue(['news']);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.deleteTag('dev');
    });
    expect(deleteTag).toHaveBeenCalledWith('dev');
    expect(result.current.tagUnion).toEqual(['news']);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/hooks/useFavorites.test.tsx`
Expected: FAIL with `Failed to resolve import "./useFavorites"` (the hook module does not exist yet).

- [ ] **Step 3: Implement**
```ts
// src/hooks/useFavorites.ts
import { useCallback, useEffect, useState } from 'react';
import type { Favorite } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useFavorites(_currentUrl: string): {
  favorites: Favorite[];
  tagUnion: string[];
  activeTags: string[];
  setActiveTags(tags: string[]): void;
  add(input: { name: string; url: string; tags: string[] }): Promise<void>;
  update(id: number, partial: { name?: string; url?: string; tags?: string[] }): Promise<void>;
  remove(id: number): Promise<void>;
  reorder(ids: number[]): Promise<void>;
  renameTag(oldT: string, newT: string): Promise<void>;
  deleteTag(tag: string): Promise<void>;
} {
  const [all, setAll] = useState<Favorite[]>([]);
  const [tagUnion, setTagUnion] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);

  // Refresh the tag union after any mutation that can change tags.
  const refreshTagUnion = useCallback(async (): Promise<void> => {
    const union = await aegis.favorites.tagUnion();
    setTagUnion(union);
  }, []);

  useEffect(() => {
    let active = true;
    void aegis.favorites.list().then((items) => {
      if (active) setAll(items);
    });
    void aegis.favorites.tagUnion().then((union) => {
      if (active) setTagUnion(union);
    });
    return () => {
      active = false;
    };
  }, []);

  const add = useCallback(
    async (input: { name: string; url: string; tags: string[] }): Promise<void> => {
      setAll(await aegis.favorites.add(input));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  const update = useCallback(
    async (id: number, partial: { name?: string; url?: string; tags?: string[] }): Promise<void> => {
      setAll(await aegis.favorites.update(id, partial));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  const remove = useCallback(async (id: number): Promise<void> => {
    setAll(await aegis.favorites.remove(id));
  }, []);

  const reorder = useCallback(async (ids: number[]): Promise<void> => {
    setAll(await aegis.favorites.reorder(ids));
  }, []);

  const renameTag = useCallback(
    async (oldT: string, newT: string): Promise<void> => {
      setAll(await aegis.favorites.renameTag(oldT, newT));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  const deleteTag = useCallback(
    async (tag: string): Promise<void> => {
      setAll(await aegis.favorites.deleteTag(tag));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  // A favorite passes the filter when it carries EVERY active tag.
  const favorites =
    activeTags.length === 0
      ? all
      : all.filter((f) => activeTags.every((t) => f.tags.includes(t)));

  return {
    favorites,
    tagUnion,
    activeTags,
    setActiveTags,
    add,
    update,
    remove,
    reorder,
    renameTag,
    deleteTag,
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/hooks/useFavorites.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/hooks/useFavorites.ts src/hooks/useFavorites.test.tsx
git commit -m "feat(favorites): useFavorites hook (list/CRUD/tag ops + activeTags filter)"
```

---

### Task 13: `useSaved` hook + test

**Files:**
- Create: `src/hooks/useSaved.ts`
- Test: `src/hooks/useSaved.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/hooks/useSaved.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SavedItem } from '../../shared/types';

const list = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const has = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    saved: {
      list: (...a: any[]) => list(...a),
      add: (...a: any[]) => add(...a),
      remove: (...a: any[]) => remove(...a),
      has: (...a: any[]) => has(...a),
    },
  },
}));

import { useSaved } from './useSaved';

const item = (over: Partial<SavedItem> = {}): SavedItem => ({
  id: 1,
  url: 'https://example.com/',
  title: 'Example',
  savedAt: 1000,
  ...over,
});

const seed: SavedItem[] = [
  item({ id: 1, url: 'https://example.com/', title: 'Example', savedAt: 2000 }),
  item({ id: 2, url: 'https://other.example/', title: 'Other', savedAt: 1000 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  has.mockResolvedValue(false);
  add.mockResolvedValue(seed);
  remove.mockResolvedValue([seed[1]]);
});

describe('useSaved', () => {
  it('seeds items from aegis.saved.list on mount', async () => {
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('tracks isCurrentSaved via aegis.saved.has(currentUrl)', async () => {
    has.mockResolvedValue(true);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.isCurrentSaved).toBe(true));
    expect(has).toHaveBeenCalledWith('https://example.com/');
  });

  it('re-queries has() when currentUrl changes', async () => {
    has.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result, rerender } = renderHook(({ url }) => useSaved(url), {
      initialProps: { url: 'https://example.com/' },
    });
    await waitFor(() => expect(result.current.isCurrentSaved).toBe(true));
    rerender({ url: 'https://unsaved.example/' });
    await waitFor(() => expect(result.current.isCurrentSaved).toBe(false));
    expect(has).toHaveBeenLastCalledWith('https://unsaved.example/');
  });

  it('add(input) calls aegis.saved.add and refreshes items + isCurrentSaved', async () => {
    const fresh: SavedItem[] = [item({ id: 3, url: 'https://new.example/', title: 'New', savedAt: 3000 }), ...seed];
    add.mockResolvedValue(fresh);
    has.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { result } = renderHook(() => useSaved('https://new.example/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.add({ url: 'https://new.example/', title: 'New' });
    });
    expect(add).toHaveBeenCalledWith({ url: 'https://new.example/', title: 'New' });
    expect(result.current.items).toHaveLength(3);
    expect(result.current.isCurrentSaved).toBe(true);
  });

  it('addCurrent(title) saves the current url with the given title', async () => {
    add.mockResolvedValue(seed);
    has.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.addCurrent('Example Title');
    });
    expect(add).toHaveBeenCalledWith({ url: 'https://example.com/', title: 'Example Title' });
    expect(result.current.isCurrentSaved).toBe(true);
  });

  it('removeCurrent() removes the SavedItem whose url === currentUrl', async () => {
    has.mockResolvedValueOnce(true).mockResolvedValue(false);
    remove.mockResolvedValue([seed[1]]);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.isCurrentSaved).toBe(true));
    await act(async () => {
      await result.current.removeCurrent();
    });
    // id 1 is the item whose url === the current url
    expect(remove).toHaveBeenCalledWith(1);
    expect(result.current.items.map((i) => i.id)).toEqual([2]);
    expect(result.current.isCurrentSaved).toBe(false);
  });

  it('removeCurrent() is a no-op when the current url is not saved', async () => {
    has.mockResolvedValue(false);
    const { result } = renderHook(() => useSaved('https://nope.example/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.removeCurrent();
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('remove(id) removes by id and refreshes items + isCurrentSaved', async () => {
    remove.mockResolvedValue([seed[0]]);
    has.mockResolvedValue(true);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.remove(2);
    });
    expect(remove).toHaveBeenCalledWith(2);
    expect(result.current.items.map((i) => i.id)).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/hooks/useSaved.test.tsx`
Expected: FAIL with `Failed to resolve import "./useSaved"` (the hook module does not exist yet).

- [ ] **Step 3: Implement**
```ts
// src/hooks/useSaved.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedItem } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useSaved(currentUrl: string): {
  items: SavedItem[];
  isCurrentSaved: boolean;
  add(input: { url: string; title: string }): Promise<void>;
  addCurrent(title: string): Promise<void>;
  removeCurrent(): Promise<void>;
  remove(id: number): Promise<void>;
} {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [isCurrentSaved, setIsCurrentSaved] = useState<boolean>(false);

  // Read currentUrl + items at call time without re-binding callbacks on every
  // url/list change (mirrors useAdblock's urlRef pattern).
  const urlRef = useRef<string>(currentUrl);
  urlRef.current = currentUrl;
  const itemsRef = useRef<SavedItem[]>(items);
  itemsRef.current = items;

  const refreshHas = useCallback(async (): Promise<void> => {
    const saved = await aegis.saved.has(urlRef.current);
    setIsCurrentSaved(saved);
  }, []);

  useEffect(() => {
    let active = true;
    void aegis.saved.list().then((list) => {
      if (active) setItems(list);
    });
    return () => {
      active = false;
    };
  }, []);

  // Re-query the fill-in state whenever the current url changes.
  useEffect(() => {
    let active = true;
    void aegis.saved.has(currentUrl).then((saved) => {
      if (active) setIsCurrentSaved(saved);
    });
    return () => {
      active = false;
    };
  }, [currentUrl]);

  const add = useCallback(
    async (input: { url: string; title: string }): Promise<void> => {
      setItems(await aegis.saved.add(input));
      await refreshHas();
    },
    [refreshHas],
  );

  const addCurrent = useCallback(
    async (title: string): Promise<void> => {
      setItems(await aegis.saved.add({ url: urlRef.current, title }));
      await refreshHas();
    },
    [refreshHas],
  );

  const remove = useCallback(
    async (id: number): Promise<void> => {
      setItems(await aegis.saved.remove(id));
      await refreshHas();
    },
    [refreshHas],
  );

  const removeCurrent = useCallback(async (): Promise<void> => {
    const match = itemsRef.current.find((i) => i.url === urlRef.current);
    if (!match) return;
    setItems(await aegis.saved.remove(match.id));
    await refreshHas();
  }, [refreshHas]);

  return { items, isCurrentSaved, add, addCurrent, removeCurrent, remove };
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/hooks/useSaved.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/hooks/useSaved.ts src/hooks/useSaved.test.tsx
git commit -m "feat(saved): useSaved hook (list/add/addCurrent/remove/removeCurrent + has fill-in)"
```

---

### Task 14: `src/lib/layout.ts` constants + `useContentInset` hook + test

**Files:**
- Create: `src/lib/layout.ts`
- Create: `src/hooks/useContentInset.ts`
- Test: `src/hooks/useContentInset.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/hooks/useContentInset.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { TOOLBAR_H, FAVBAR_H, SIDEBAR_W } from '../lib/layout';

const setContentInset = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    view: {
      setContentInset: (...a: any[]) => setContentInset(...a),
    },
  },
}));

import { useContentInset } from './useContentInset';

beforeEach(() => {
  vi.clearAllMocks();
  setContentInset.mockResolvedValue(undefined);
});

describe('useContentInset', () => {
  it('exports the shared layout constants', () => {
    expect(TOOLBAR_H).toBe(56);
    expect(FAVBAR_H).toBe(40);
    expect(SIDEBAR_W).toBe(280);
  });

  it('on mount with the sidebar closed, reports top = TOOLBAR_H + FAVBAR_H, left = 0', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: false }));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: 0,
    });
  });

  it('on mount with the sidebar open, reports left = SIDEBAR_W', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: true }));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: SIDEBAR_W,
    });
  });

  it('re-reports the inset when sidebarOpen changes', () => {
    const { rerender } = renderHook(({ open }) => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: open }), {
      initialProps: { open: false },
    });
    expect(setContentInset).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: 0,
    });
    rerender({ open: true });
    expect(setContentInset).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: SIDEBAR_W,
    });
  });

  it('does not re-report when sidebarOpen is unchanged across a rerender', () => {
    const { rerender } = renderHook(({ open }) => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: open }), {
      initialProps: { open: true },
    });
    expect(setContentInset).toHaveBeenCalledTimes(1);
    rerender({ open: true });
    expect(setContentInset).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/hooks/useContentInset.test.tsx`
Expected: FAIL with `Failed to resolve import "../lib/layout"` (neither `src/lib/layout.ts` nor `src/hooks/useContentInset.ts` exists yet).

- [ ] **Step 3: Implement**
```ts
// src/lib/layout.ts
/**
 * Chrome layout constants shared between the renderer (which computes the
 * content inset) and the CSS. Kept in one place so the renderer can report a
 * deterministic inset to main WITHOUT measuring the DOM (§2 of the contract).
 *
 *   TOOLBAR_H  — the top toolbar band height (=== CHROME_TOP_HEIGHT in main).
 *   FAVBAR_H   — the always-on favorites bar height.
 *   SIDEBAR_W  — the inset sidebar width when open.
 */
export const TOOLBAR_H = 56;
export const FAVBAR_H = 40;
export const SIDEBAR_W = 280;
```

```ts
// src/hooks/useContentInset.ts
import { useEffect } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { TOOLBAR_H, FAVBAR_H, SIDEBAR_W } from '../lib/layout';

/**
 * Reports the content-view inset to main whenever the sidebar toggles (and once
 * on mount). The favorites bar is always-on in Phase 3, so the top inset is a
 * constant TOOLBAR_H + FAVBAR_H; the sidebar toggles only the left inset.
 */
export function useContentInset(viewId: ViewId, { sidebarOpen }: { sidebarOpen: boolean }): void {
  useEffect(() => {
    const top = TOOLBAR_H + FAVBAR_H;
    const left = sidebarOpen ? SIDEBAR_W : 0;
    void aegis.view.setContentInset(viewId, { top, left });
  }, [viewId, sidebarOpen]);
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/hooks/useContentInset.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/lib/layout.ts src/hooks/useContentInset.ts src/hooks/useContentInset.test.tsx
git commit -m "feat(sidebar): layout constants + useContentInset hook (reports inset on sidebar toggle)"
```

---

### Task 15: `FavoritesBar` (renders `TagFilter` internally) + `TagFilter` + tests

**Files:**
- Create: `src/components/TagFilter.tsx`
- Create: `src/components/TagFilter.test.tsx`
- Create: `src/components/FavoritesBar.tsx`
- Create: `src/components/FavoritesBar.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/components/TagFilter.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagFilter } from './TagFilter';

const props = (over: Partial<React.ComponentProps<typeof TagFilter>> = {}) => ({
  tagUnion: ['dev', 'news'],
  activeTags: [] as string[],
  setActiveTags: vi.fn(),
  ...over,
});

describe('TagFilter', () => {
  it('renders one pressable chip per tag in the union', () => {
    render(<TagFilter {...props()} />);
    expect(screen.getByRole('button', { name: /filter by tag dev/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter by tag news/i })).toBeInTheDocument();
  });

  it('marks active tags with aria-pressed=true', () => {
    render(<TagFilter {...props({ activeTags: ['dev'] })} />);
    expect(screen.getByRole('button', { name: /filter by tag dev/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /filter by tag news/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking an inactive chip adds it to activeTags', async () => {
    const p = props({ activeTags: ['news'] });
    render(<TagFilter {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /filter by tag dev/i }));
    expect(p.setActiveTags).toHaveBeenCalledWith(['news', 'dev']);
  });

  it('clicking an active chip removes it from activeTags', async () => {
    const p = props({ activeTags: ['dev', 'news'] });
    render(<TagFilter {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /filter by tag dev/i }));
    expect(p.setActiveTags).toHaveBeenCalledWith(['news']);
  });

  it('renders nothing when the tag union is empty', () => {
    const { container } = render(<TagFilter {...props({ tagUnion: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

```tsx
// src/components/FavoritesBar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Favorite } from '../../shared/types';
import { FavoritesBar } from './FavoritesBar';

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Example',
  url: 'https://example.com/',
  tags: ['news'],
  position: 0,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof FavoritesBar>> = {}) => ({
  favorites: [
    fav({ id: 1, name: 'Alpha', url: 'https://alpha.example/' }),
    fav({ id: 2, name: 'Beta', url: 'https://beta.example/' }),
  ],
  tagUnion: ['dev', 'news'],
  activeTags: [] as string[],
  setActiveTags: vi.fn(),
  onOpenFavorite: vi.fn(),
  onOpenManager: vi.fn(),
  ...over,
});

describe('FavoritesBar', () => {
  it('renders a chip per favorite labelled by name', () => {
    render(<FavoritesBar {...props()} />);
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument();
  });

  it('clicking a favorite chip calls onOpenFavorite with its url', async () => {
    const p = props();
    render(<FavoritesBar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(p.onOpenFavorite).toHaveBeenCalledWith('https://beta.example/');
  });

  it('exposes a Manage favorites button that calls onOpenManager', async () => {
    const p = props();
    render(<FavoritesBar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /manage favorites/i }));
    expect(p.onOpenManager).toHaveBeenCalledTimes(1);
  });

  it('renders the TagFilter internally (chips from the union)', () => {
    render(<FavoritesBar {...props()} />);
    expect(screen.getByRole('button', { name: /filter by tag dev/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter by tag news/i })).toBeInTheDocument();
  });

  it('clicking a tag chip delegates to setActiveTags', async () => {
    const p = props();
    render(<FavoritesBar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /filter by tag dev/i }));
    expect(p.setActiveTags).toHaveBeenCalledWith(['dev']);
  });

  it('uses a labelled toolbar/navigation landmark for the bar', () => {
    render(<FavoritesBar {...props()} />);
    expect(screen.getByRole('navigation', { name: /favorites/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/TagFilter.test.tsx src/components/FavoritesBar.test.tsx`
Expected: FAIL with `Failed to resolve import "./TagFilter"` / `"./FavoritesBar"` (neither component exists yet).

- [ ] **Step 3: Implement**
```tsx
// src/components/TagFilter.tsx
export interface TagFilterProps {
  tagUnion: string[];
  activeTags: string[];
  setActiveTags(tags: string[]): void;
}

export function TagFilter({ tagUnion, activeTags, setActiveTags }: TagFilterProps) {
  if (tagUnion.length === 0) return null;

  const toggle = (tag: string): void => {
    if (activeTags.includes(tag)) {
      setActiveTags(activeTags.filter((t) => t !== tag));
    } else {
      setActiveTags([...activeTags, tag]);
    }
  };

  return (
    <div className="tag-filter" role="group" aria-label="Filter favorites by tag">
      {tagUnion.map((tag) => {
        const active = activeTags.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            className="tag-filter__chip"
            aria-label={`Filter by tag ${tag}`}
            aria-pressed={active}
            onClick={() => toggle(tag)}
          >
            {tag}
          </button>
        );
      })}
    </div>
  );
}
```

```tsx
// src/components/FavoritesBar.tsx
import type { Favorite } from '../../shared/types';
import { TagFilter } from './TagFilter';

export interface FavoritesBarProps {
  favorites: Favorite[];
  tagUnion: string[];
  activeTags: string[];
  setActiveTags(tags: string[]): void;
  onOpenFavorite(url: string): void;
  onOpenManager(): void;
}

export function FavoritesBar({
  favorites,
  tagUnion,
  activeTags,
  setActiveTags,
  onOpenFavorite,
  onOpenManager,
}: FavoritesBarProps) {
  return (
    <nav className="favorites-bar" aria-label="Favorites">
      <div className="favorites-bar__chips">
        {favorites.map((f) => (
          <button
            key={f.id}
            type="button"
            className="favorites-bar__chip"
            title={f.url}
            onClick={() => onOpenFavorite(f.url)}
          >
            {f.name}
          </button>
        ))}
      </div>
      <TagFilter tagUnion={tagUnion} activeTags={activeTags} setActiveTags={setActiveTags} />
      <button
        type="button"
        className="favorites-bar__manage"
        aria-label="Manage favorites"
        onClick={onOpenManager}
      >
        {'\u2630'}
      </button>
    </nav>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/TagFilter.test.tsx src/components/FavoritesBar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/components/TagFilter.tsx src/components/TagFilter.test.tsx src/components/FavoritesBar.tsx src/components/FavoritesBar.test.tsx
git commit -m "feat(favorites): FavoritesBar (chips + Manage) rendering TagFilter internally"
```

---

### Task 16: `FavoritesManager` modal + `TagInput` autocomplete + tests

**Files:**
- Create: `src/components/TagInput.tsx`
- Create: `src/components/TagInput.test.tsx`
- Create: `src/components/FavoritesManager.tsx`
- Create: `src/components/FavoritesManager.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/components/TagInput.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagInput } from './TagInput';

const props = (over: Partial<React.ComponentProps<typeof TagInput>> = {}) => ({
  tags: ['news'] as string[],
  suggestions: ['dev', 'news', 'design'],
  onChange: vi.fn(),
  ...over,
});

describe('TagInput', () => {
  it('renders the current tags as removable chips', () => {
    render(<TagInput {...props()} />);
    expect(screen.getByText('news')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove tag news/i })).toBeInTheDocument();
  });

  it('typing a tag and pressing Enter adds it via onChange', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, 'dev{Enter}');
    expect(p.onChange).toHaveBeenCalledWith(['news', 'dev']);
  });

  it('does not add a duplicate tag', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, 'news{Enter}');
    expect(p.onChange).not.toHaveBeenCalled();
  });

  it('trims whitespace and ignores an empty entry', async () => {
    const p = props();
    render(<TagInput {...p} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    await userEvent.type(input, '   {Enter}');
    expect(p.onChange).not.toHaveBeenCalled();
    await userEvent.type(input, '  design  {Enter}');
    expect(p.onChange).toHaveBeenCalledWith(['news', 'design']);
  });

  it('removing a chip calls onChange without that tag', async () => {
    const p = props({ tags: ['news', 'dev'] });
    render(<TagInput {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove tag dev/i }));
    expect(p.onChange).toHaveBeenCalledWith(['news']);
  });

  it('offers autocomplete suggestions via a datalist (excluding already-added tags)', () => {
    render(<TagInput {...props()} />);
    const input = screen.getByRole('textbox', { name: /add tag/i });
    const listId = input.getAttribute('list');
    expect(listId).toBeTruthy();
    const datalist = document.getElementById(listId!) as HTMLDataListElement;
    const options = within(datalist).queryAllByRole('option', { hidden: true }).map((o) => o.getAttribute('value'));
    expect(options).toEqual(['dev', 'design']);
  });
});
```

```tsx
// src/components/FavoritesManager.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Favorite } from '../../shared/types';
import { FavoritesManager } from './FavoritesManager';

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Alpha',
  url: 'https://alpha.example/',
  tags: ['news'],
  position: 0,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof FavoritesManager>> = {}) => ({
  favorites: [
    fav({ id: 1, name: 'Alpha', url: 'https://alpha.example/', tags: ['news'] }),
    fav({ id: 2, name: 'Beta', url: 'https://beta.example/', tags: ['dev'] }),
  ],
  tagUnion: ['dev', 'news'],
  onClose: vi.fn(),
  add: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  renameTag: vi.fn(async () => {}),
  deleteTag: vi.fn(async () => {}),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FavoritesManager', () => {
  it('renders as a modal dialog with an accessible name', () => {
    render(<FavoritesManager {...props()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/favorites/i);
  });

  it('lists existing favorites by name', () => {
    render(<FavoritesManager {...props()} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('adds a favorite from the add form', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite name/i }), 'Gamma');
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite url/i }), 'https://gamma.example/');
    await userEvent.click(screen.getByRole('button', { name: /^add favorite$/i }));
    expect(p.add).toHaveBeenCalledWith({ name: 'Gamma', url: 'https://gamma.example/', tags: [] });
  });

  it('removes a favorite via its row Remove button', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove favorite alpha/i }));
    expect(p.remove).toHaveBeenCalledWith(1);
  });

  it('edits a favorite name via its row Save button', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    const nameField = screen.getByRole('textbox', { name: /name for alpha/i });
    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'Alpha 2');
    await userEvent.click(screen.getByRole('button', { name: /save favorite alpha/i }));
    expect(p.update).toHaveBeenCalledWith(1, { name: 'Alpha 2', url: 'https://alpha.example/', tags: ['news'] });
  });

  it('renames a tag globally via the tag-management controls', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    const section = screen.getByRole('group', { name: /manage tags/i });
    await userEvent.selectOptions(within(section).getByRole('combobox', { name: /tag to manage/i }), 'dev');
    await userEvent.type(within(section).getByRole('textbox', { name: /rename tag to/i }), 'engineering');
    await userEvent.click(within(section).getByRole('button', { name: /^rename tag$/i }));
    expect(p.renameTag).toHaveBeenCalledWith('dev', 'engineering');
  });

  it('deletes a tag globally via the tag-management controls', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    const section = screen.getByRole('group', { name: /manage tags/i });
    await userEvent.selectOptions(within(section).getByRole('combobox', { name: /tag to manage/i }), 'news');
    await userEvent.click(within(section).getByRole('button', { name: /^delete tag$/i }));
    expect(p.deleteTag).toHaveBeenCalledWith('news');
  });

  it('closes on Escape and on the Close button', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    p.onClose.mockClear();
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/TagInput.test.tsx src/components/FavoritesManager.test.tsx`
Expected: FAIL with `Failed to resolve import "./TagInput"` / `"./FavoritesManager"` (neither component exists yet).

- [ ] **Step 3: Implement**
```tsx
// src/components/TagInput.tsx
import { useId, useState } from 'react';

export interface TagInputProps {
  tags: string[];
  suggestions: string[];
  onChange(tags: string[]): void;
}

export function TagInput({ tags, suggestions, onChange }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const listId = useId();

  const commit = (): void => {
    const value = draft.trim();
    setDraft('');
    if (value.length === 0 || tags.includes(value)) return;
    onChange([...tags, value]);
  };

  const removeTag = (tag: string): void => {
    onChange(tags.filter((t) => t !== tag));
  };

  // Suggest only tags not already applied.
  const available = suggestions.filter((s) => !tags.includes(s));

  return (
    <div className="tag-input">
      <ul className="tag-input__chips">
        {tags.map((tag) => (
          <li key={tag} className="tag-input__chip">
            <span>{tag}</span>
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => removeTag(tag)}
            >
              {'\u00D7'}
            </button>
          </li>
        ))}
      </ul>
      <input
        type="text"
        aria-label="Add tag"
        list={listId}
        value={draft}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <datalist id={listId}>
        {available.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
```

```tsx
// src/components/FavoritesManager.tsx
import { useId, useState } from 'react';
import type { Favorite } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';
import { TagInput } from './TagInput';

export interface FavoritesManagerProps {
  favorites: Favorite[];
  tagUnion: string[];
  onClose(): void;
  add(input: { name: string; url: string; tags: string[] }): Promise<void>;
  update(id: number, partial: { name?: string; url?: string; tags?: string[] }): Promise<void>;
  remove(id: number): Promise<void>;
  renameTag(oldT: string, newT: string): Promise<void>;
  deleteTag(tag: string): Promise<void>;
}

function FavoriteRow({
  favorite,
  tagUnion,
  update,
  remove,
}: {
  favorite: Favorite;
  tagUnion: string[];
  update: FavoritesManagerProps['update'];
  remove: FavoritesManagerProps['remove'];
}) {
  const [name, setName] = useState(favorite.name);
  const [url, setUrl] = useState(favorite.url);
  const [tags, setTags] = useState<string[]>(favorite.tags);

  return (
    <li className="favorites-manager__row">
      <span className="favorites-manager__row-name">{favorite.name}</span>
      <input
        type="text"
        aria-label={`Name for ${favorite.name}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="text"
        aria-label={`URL for ${favorite.name}`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <TagInput tags={tags} suggestions={tagUnion} onChange={setTags} />
      <button
        type="button"
        aria-label={`Save favorite ${favorite.name}`}
        onClick={() => void update(favorite.id, { name, url, tags })}
      >
        Save
      </button>
      <button
        type="button"
        aria-label={`Remove favorite ${favorite.name}`}
        onClick={() => void remove(favorite.id)}
      >
        Remove
      </button>
    </li>
  );
}

export function FavoritesManager({
  favorites,
  tagUnion,
  onClose,
  add,
  update,
  remove,
  renameTag,
  deleteTag,
}: FavoritesManagerProps) {
  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newTags, setNewTags] = useState<string[]>([]);

  const [tagToManage, setTagToManage] = useState('');
  const [renameTo, setRenameTo] = useState('');

  const handleAdd = (): void => {
    if (newName.trim().length === 0 || newUrl.trim().length === 0) return;
    void add({ name: newName.trim(), url: newUrl.trim(), tags: newTags });
    setNewName('');
    setNewUrl('');
    setNewTags([]);
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="favorites-manager"
    >
      <div className="favorites-manager__header">
        <h2 id={titleId} className="favorites-manager__title">
          Manage favorites
        </h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <ul className="favorites-manager__list">
        {favorites.map((f) => (
          <FavoriteRow key={f.id} favorite={f} tagUnion={tagUnion} update={update} remove={remove} />
        ))}
      </ul>

      <div className="favorites-manager__add" role="group" aria-label="Add favorite">
        <input
          type="text"
          aria-label="New favorite name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          type="text"
          aria-label="New favorite URL"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
        />
        <TagInput tags={newTags} suggestions={tagUnion} onChange={setNewTags} />
        <button type="button" onClick={handleAdd}>
          Add favorite
        </button>
      </div>

      <div className="favorites-manager__tags" role="group" aria-label="Manage tags">
        <select
          aria-label="Tag to manage"
          value={tagToManage}
          onChange={(e) => setTagToManage(e.target.value)}
        >
          <option value="">Select a tag</option>
          {tagUnion.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="Rename tag to"
          value={renameTo}
          onChange={(e) => setRenameTo(e.target.value)}
        />
        <button
          type="button"
          disabled={tagToManage.length === 0 || renameTo.trim().length === 0}
          onClick={() => {
            void renameTag(tagToManage, renameTo.trim());
            setRenameTo('');
            setTagToManage('');
          }}
        >
          Rename tag
        </button>
        <button
          type="button"
          disabled={tagToManage.length === 0}
          onClick={() => {
            void deleteTag(tagToManage);
            setTagToManage('');
          }}
        >
          Delete tag
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/TagInput.test.tsx src/components/FavoritesManager.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/components/TagInput.tsx src/components/TagInput.test.tsx src/components/FavoritesManager.tsx src/components/FavoritesManager.test.tsx
git commit -m "feat(favorites): FavoritesManager modal (CRUD + global tag ops) + TagInput autocomplete"
```

---

### Task 17: `BookmarkButton` + tests

**Files:**
- Create: `src/components/BookmarkButton.tsx`
- Create: `src/components/BookmarkButton.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/components/BookmarkButton.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookmarkButton } from './BookmarkButton';

const props = (over: Partial<React.ComponentProps<typeof BookmarkButton>> = {}) => ({
  saved: false,
  canSave: true,
  onSave: vi.fn(),
  onUnsave: vi.fn(),
  ...over,
});

describe('BookmarkButton', () => {
  it('renders a button with an accessible bookmark name', () => {
    render(<BookmarkButton {...props()} />);
    expect(screen.getByRole('button', { name: /save|bookmark/i })).toBeInTheDocument();
  });

  it('when not saved, exposes aria-pressed=false and calls onSave on click', async () => {
    const p = props({ saved: false });
    render(<BookmarkButton {...p} />);
    const btn = screen.getByRole('button', { name: /save|bookmark/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(p.onSave).toHaveBeenCalledTimes(1);
    expect(p.onUnsave).not.toHaveBeenCalled();
  });

  it('when saved, exposes aria-pressed=true (filled-in) and calls onUnsave on click', async () => {
    const p = props({ saved: true });
    render(<BookmarkButton {...p} />);
    const btn = screen.getByRole('button', { name: /save|bookmark/i });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(p.onUnsave).toHaveBeenCalledTimes(1);
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it('is disabled when canSave is false (e.g. no parseable host)', () => {
    render(<BookmarkButton {...props({ canSave: false })} />);
    expect(screen.getByRole('button', { name: /save|bookmark/i })).toBeDisabled();
  });

  it('does not fire callbacks when disabled', async () => {
    const p = props({ canSave: false });
    render(<BookmarkButton {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /save|bookmark/i }));
    expect(p.onSave).not.toHaveBeenCalled();
    expect(p.onUnsave).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/BookmarkButton.test.tsx`
Expected: FAIL with `Failed to resolve import "./BookmarkButton"` (the component does not exist yet).

- [ ] **Step 3: Implement**
```tsx
// src/components/BookmarkButton.tsx
export interface BookmarkButtonProps {
  saved: boolean;
  canSave: boolean;
  onSave(): void;
  onUnsave(): void;
}

export function BookmarkButton({ saved, canSave, onSave, onUnsave }: BookmarkButtonProps) {
  const label = saved ? 'Remove bookmark' : 'Save bookmark';

  return (
    <button
      type="button"
      className="bookmark-button"
      aria-label={label}
      aria-pressed={saved}
      disabled={!canSave}
      onClick={() => (saved ? onUnsave() : onSave())}
    >
      <span aria-hidden="true" className="bookmark-button__icon">
        {saved ? '\u2605' : '\u2606'}
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/BookmarkButton.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/components/BookmarkButton.tsx src/components/BookmarkButton.test.tsx
git commit -m "feat(saved): BookmarkButton with fill-in state + save/unsave toggle"
```

---

#### New names introduced (Block C)
- `useFavorites` (exported function, `src/hooks/useFavorites.ts`)
- `useSaved` (exported function, `src/hooks/useSaved.ts`)
- `TOOLBAR_H`, `FAVBAR_H`, `SIDEBAR_W` (exported constants, `src/lib/layout.ts`)
- `useContentInset` (exported function, `src/hooks/useContentInset.ts`)
- `TagFilter`, `TagFilterProps` (exported component + props interface, `src/components/TagFilter.tsx`)
- `FavoritesBar`, `FavoritesBarProps` (exported component + props interface, `src/components/FavoritesBar.tsx`)
- `TagInput`, `TagInputProps` (exported component + props interface, `src/components/TagInput.tsx`)
- `FavoritesManager`, `FavoritesManagerProps` (exported component + props interface, `src/components/FavoritesManager.tsx`)
- `BookmarkButton`, `BookmarkButtonProps` (exported component + props interface, `src/components/BookmarkButton.tsx`)

I now have all the patterns I need. I have full grounding in: the `useAdblock` hook pattern (seed-on-mount + subscribe + unsubscribe), its test harness (`vi.mock('../lib/ipcClient')`, `renderHook`, `waitFor`, captured push callback), the component patterns (button `aria-label`, `useDialog` modal, `confirm()` for clear-all), the `App.tsx` structure and `App.test.tsx` mock shape, and the Block C contracts that Block D's App wiring must consume (`useFavorites`, `useSaved`, `BookmarkButton`, `FavoritesBar`, `FavoritesManager`, `useContentInset`, `src/lib/layout.ts`, `Toolbar` bookmark slot).

I'm confident in the cross-module names. Here is the Block D task markdown.

### Task 18: `useHistory` hook + test

**Files:**
- Create: src/hooks/useHistory.ts
- Test: src/hooks/useHistory.test.tsx

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/useHistory.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { HistoryEntry } from '../../shared/types';

const list = vi.fn();
const search = vi.fn();
const remove = vi.fn();
const clear = vi.fn();
const onChanged = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    history: {
      list: (...a: any[]) => list(...a),
      search: (...a: any[]) => search(...a),
      remove: (...a: any[]) => remove(...a),
      clear: (...a: any[]) => clear(...a),
      onChanged: (cb: () => void) => onChanged(cb),
    },
  },
}));

import { useHistory } from './useHistory';

const entry = (id: number, url: string, title: string, visitedAt: number): HistoryEntry => ({
  id,
  url,
  title,
  visitedAt,
});

const seed: HistoryEntry[] = [
  entry(2, 'https://b.example/', 'B', 2000),
  entry(1, 'https://a.example/', 'A', 1000),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  search.mockResolvedValue([entry(2, 'https://b.example/', 'B', 2000)]);
  remove.mockResolvedValue(undefined);
  clear.mockResolvedValue(undefined);
  onChanged.mockReturnValue(() => {});
});

describe('useHistory', () => {
  it('seeds entries from aegis.history.list on mount', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.entries[0].title).toBe('B');
  });

  it('exposes the query and setQuery for the search box', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    act(() => result.current.setQuery('b'));
    expect(result.current.query).toBe('b');
  });

  it('search(q) with a non-empty query calls aegis.history.search and replaces entries', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    await act(async () => {
      result.current.setQuery('b');
      await result.current.search();
    });
    expect(search).toHaveBeenCalledWith('b');
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].url).toBe('https://b.example/');
  });

  it('search() with an empty/whitespace query re-lists instead of searching', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    list.mockClear();
    await act(async () => {
      result.current.setQuery('   ');
      await result.current.search();
    });
    expect(search).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('remove(id) calls aegis.history.remove then re-lists', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    list.mockClear();
    list.mockResolvedValue([entry(2, 'https://b.example/', 'B', 2000)]);
    await act(async () => result.current.remove(1));
    expect(remove).toHaveBeenCalledWith(1);
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
  });

  it('clear() calls aegis.history.clear then re-lists', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    list.mockClear();
    list.mockResolvedValue([]);
    await act(async () => result.current.clear());
    expect(clear).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.entries).toHaveLength(0));
  });

  it('re-fetches when aegis.history.onChanged fires (respecting the active query)', async () => {
    let pushed: (() => void) | undefined;
    onChanged.mockImplementation((cb: () => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    list.mockClear();
    list.mockResolvedValue([entry(3, 'https://c.example/', 'C', 3000), ...seed]);
    act(() => pushed!());
    await waitFor(() => expect(result.current.entries).toHaveLength(3));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('onChanged re-runs the active search when a query is set', async () => {
    let pushed: (() => void) | undefined;
    onChanged.mockImplementation((cb: () => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    await act(async () => {
      result.current.setQuery('b');
      await result.current.search();
    });
    search.mockClear();
    list.mockClear();
    act(() => pushed!());
    await waitFor(() => expect(search).toHaveBeenCalledWith('b'));
    expect(list).not.toHaveBeenCalled();
  });

  it('unsubscribes from onChanged on unmount', async () => {
    const unsubscribe = vi.fn();
    onChanged.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useHistory());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/hooks/useHistory.test.tsx`
Expected: FAIL with `Failed to resolve import "./useHistory"` (the hook file does not exist yet).

- [ ] **Step 3: Implement**

```ts
// src/hooks/useHistory.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useHistory(): {
  entries: HistoryEntry[];
  query: string;
  setQuery(q: string): void;
  search(): Promise<void>;
  remove(id: number): Promise<void>;
  clear(): Promise<void>;
} {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [query, setQuery] = useState<string>('');

  // Read the live query inside refresh()/the onChanged subscription without
  // re-binding the subscription on every keystroke (mirrors useAdblock's urlRef).
  const queryRef = useRef<string>(query);
  queryRef.current = query;

  const refresh = useCallback(async (): Promise<void> => {
    const q = queryRef.current.trim();
    const next = q.length > 0 ? await aegis.history.search(q) : await aegis.history.list();
    setEntries(next);
  }, []);

  useEffect(() => {
    let active = true;
    void aegis.history.list().then((next) => {
      if (active) setEntries(next);
    });
    const unsubscribe = aegis.history.onChanged(() => {
      void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refresh]);

  const search = useCallback((): Promise<void> => refresh(), [refresh]);

  const remove = useCallback(
    async (id: number): Promise<void> => {
      await aegis.history.remove(id);
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(async (): Promise<void> => {
    await aegis.history.clear();
    await refresh();
  }, [refresh]);

  return { entries, query, setQuery, search, remove, clear };
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/hooks/useHistory.test.tsx`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useHistory.ts src/hooks/useHistory.test.tsx
git commit -m "feat(history): add useHistory hook (list/search/remove/clear + onChanged refresh)"
```

---

### Task 19: `HistoryPanel` + tests

**Files:**
- Create: src/components/HistoryPanel.tsx
- Test: src/components/HistoryPanel.test.tsx

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/HistoryPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HistoryEntry } from '../../shared/types';

const confirmMock = vi.fn();
vi.mock('../lib/toast', () => ({
  confirm: (...a: any[]) => confirmMock(...a),
}));

import { HistoryPanel } from './HistoryPanel';

const entries: HistoryEntry[] = [
  { id: 2, url: 'https://b.example/', title: 'Beta', visitedAt: 1_700_000_000_000 },
  { id: 1, url: 'https://a.example/', title: '', visitedAt: 1_600_000_000_000 },
];

function props() {
  return {
    entries,
    query: '',
    setQuery: vi.fn(),
    search: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    onOpen: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
});

describe('HistoryPanel', () => {
  it('renders a list of history entries with their titles', () => {
    render(<HistoryPanel {...props()} />);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('falls back to the URL as the label when an entry has no title', () => {
    render(<HistoryPanel {...props()} />);
    expect(screen.getByRole('button', { name: /open https:\/\/a\.example/i })).toBeInTheDocument();
  });

  it('shows a localized timestamp for each entry', () => {
    render(<HistoryPanel {...props()} />);
    const expected = new Date(1_700_000_000_000).toLocaleString();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('clicking an entry calls onOpen with its url', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /open https:\/\/b\.example/i }));
    expect(p.onOpen).toHaveBeenCalledWith('https://b.example/');
  });

  it('typing in the search box updates the query and submitting searches', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    const box = screen.getByRole('searchbox', { name: /search history/i });
    await userEvent.type(box, 'b{Enter}');
    expect(p.setQuery).toHaveBeenCalled();
    expect(p.search).toHaveBeenCalled();
  });

  it('clicking a row remove button calls remove with the entry id', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove beta/i }));
    expect(p.remove).toHaveBeenCalledWith(2);
  });

  it('Clear all asks for confirmation then calls clear', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all history/i }));
    expect(confirmMock).toHaveBeenCalled();
    expect(p.clear).toHaveBeenCalledTimes(1);
  });

  it('Clear all does NOT clear when confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false);
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all history/i }));
    expect(p.clear).not.toHaveBeenCalled();
  });

  it('shows an empty-state message when there are no entries', () => {
    render(<HistoryPanel {...props()} entries={[]} />);
    expect(screen.getByText(/no history/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/HistoryPanel.test.tsx`
Expected: FAIL with `Failed to resolve import "./HistoryPanel"` (the component file does not exist yet).

- [ ] **Step 3: Implement**

```tsx
// src/components/HistoryPanel.tsx
import { useId } from 'react';
import type { HistoryEntry } from '../../shared/types';
import { confirm } from '../lib/toast';

export interface HistoryPanelProps {
  entries: HistoryEntry[];
  query: string;
  setQuery(q: string): void;
  search(): Promise<void> | void;
  remove(id: number): Promise<void> | void;
  clear(): Promise<void> | void;
  onOpen(url: string): void;
}

export function HistoryPanel({
  entries,
  query,
  setQuery,
  search,
  remove,
  clear,
  onOpen,
}: HistoryPanelProps) {
  const searchId = useId();

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    void search();
  };

  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear all history? This cannot be undone.');
    if (ok) void clear();
  };

  return (
    <div className="history-panel" role="group" aria-label="History">
      <form className="history-panel__search" role="search" onSubmit={handleSubmit}>
        <label htmlFor={searchId} className="history-panel__search-label">
          Search history
        </label>
        <input
          id={searchId}
          type="search"
          role="searchbox"
          aria-label="Search history"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" aria-label="Run history search">
          Search
        </button>
      </form>
      <button
        type="button"
        className="history-panel__clear"
        aria-label="Clear all history"
        disabled={entries.length === 0}
        onClick={() => void handleClear()}
      >
        Clear all
      </button>
      {entries.length === 0 ? (
        <p className="history-panel__empty">No history yet.</p>
      ) : (
        <ul className="history-panel__list">
          {entries.map((entry) => {
            const label = entry.title.length > 0 ? entry.title : entry.url;
            return (
              <li key={entry.id} className="history-panel__row">
                <button
                  type="button"
                  className="history-panel__open"
                  aria-label={`Open ${label}`}
                  onClick={() => onOpen(entry.url)}
                >
                  <span className="history-panel__title">{label}</span>
                  <span className="history-panel__url">{entry.url}</span>
                  <span className="history-panel__time">
                    {new Date(entry.visitedAt).toLocaleString()}
                  </span>
                </button>
                <button
                  type="button"
                  className="history-panel__remove"
                  aria-label={`Remove ${label}`}
                  onClick={() => void remove(entry.id)}
                >
                  &times;
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/HistoryPanel.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/HistoryPanel.tsx src/components/HistoryPanel.test.tsx
git commit -m "feat(history): add HistoryPanel (list, localized timestamps, search, remove, clear-all)"
```

---

### Task 20: `SavedPanel` + tests

**Files:**
- Create: src/components/SavedPanel.tsx
- Test: src/components/SavedPanel.test.tsx

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/SavedPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SavedItem } from '../../shared/types';

import { SavedPanel } from './SavedPanel';

const items: SavedItem[] = [
  { id: 2, url: 'https://docs.example/', title: 'Docs', savedAt: 1_700_000_000_000 },
  { id: 1, url: 'https://blog.example/', title: '', savedAt: 1_600_000_000_000 },
];

function props() {
  return {
    items,
    remove: vi.fn(async () => [] as SavedItem[]),
    onOpen: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SavedPanel', () => {
  it('renders the saved items with their titles', () => {
    render(<SavedPanel {...props()} />);
    expect(screen.getByText('Docs')).toBeInTheDocument();
  });

  it('falls back to the URL as the label when an item has no title', () => {
    render(<SavedPanel {...props()} />);
    expect(screen.getByRole('button', { name: /open https:\/\/blog\.example/i })).toBeInTheDocument();
  });

  it('clicking an item calls onOpen with its url', async () => {
    const p = props();
    render(<SavedPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /open https:\/\/docs\.example/i }));
    expect(p.onOpen).toHaveBeenCalledWith('https://docs.example/');
  });

  it('clicking a row remove button calls remove with the item id', async () => {
    const p = props();
    render(<SavedPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove docs/i }));
    expect(p.remove).toHaveBeenCalledWith(2);
  });

  it('shows an empty-state message when there are no saved items', () => {
    render(<SavedPanel {...props()} items={[]} />);
    expect(screen.getByText(/nothing saved/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/SavedPanel.test.tsx`
Expected: FAIL with `Failed to resolve import "./SavedPanel"` (the component file does not exist yet).

- [ ] **Step 3: Implement**

```tsx
// src/components/SavedPanel.tsx
import type { SavedItem } from '../../shared/types';

export interface SavedPanelProps {
  items: SavedItem[];
  remove(id: number): Promise<SavedItem[]> | void;
  onOpen(url: string): void;
}

export function SavedPanel({ items, remove, onOpen }: SavedPanelProps) {
  return (
    <div className="saved-panel" role="group" aria-label="Saved">
      {items.length === 0 ? (
        <p className="saved-panel__empty">Nothing saved yet.</p>
      ) : (
        <ul className="saved-panel__list">
          {items.map((item) => {
            const label = item.title.length > 0 ? item.title : item.url;
            return (
              <li key={item.id} className="saved-panel__row">
                <button
                  type="button"
                  className="saved-panel__open"
                  aria-label={`Open ${label}`}
                  onClick={() => onOpen(item.url)}
                >
                  <span className="saved-panel__title">{label}</span>
                  <span className="saved-panel__url">{item.url}</span>
                </button>
                <button
                  type="button"
                  className="saved-panel__remove"
                  aria-label={`Remove ${label}`}
                  onClick={() => void remove(item.id)}
                >
                  &times;
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/SavedPanel.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/SavedPanel.tsx src/components/SavedPanel.test.tsx
git commit -m "feat(saved): add SavedPanel (list, open, remove, empty state)"
```

---

### Task 21: `Sidebar` (toggle + History/Saved tabs) + tests

**Files:**
- Create: src/components/Sidebar.tsx
- Test: src/components/Sidebar.test.tsx

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/Sidebar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';

function props(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return {
    open: true,
    onToggle: vi.fn(),
    history: <div data-testid="history-slot">history</div>,
    saved: <div data-testid="saved-slot">saved</div>,
    ...overrides,
  };
}

describe('Sidebar', () => {
  it('renders a toggle button reflecting the open state via aria-expanded', () => {
    render(<Sidebar {...props({ open: false })} />);
    expect(screen.getByRole('button', { name: /sidebar/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking the toggle calls onToggle', async () => {
    const p = props();
    render(<Sidebar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /sidebar/i }));
    expect(p.onToggle).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the panel body when closed', () => {
    render(<Sidebar {...props({ open: false })} />);
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('shows the History tab panel by default when open', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByTestId('history-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('saved-slot')).not.toBeInTheDocument();
  });

  it('exposes History/Saved as tabs with correct aria-selected', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByRole('tab', { name: /history/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /saved/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking the Saved tab switches to the saved panel', async () => {
    render(<Sidebar {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /saved/i }));
    expect(screen.getByTestId('saved-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /saved/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('the open sidebar region is labelled for assistive tech', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/Sidebar.test.tsx`
Expected: FAIL with `Failed to resolve import "./Sidebar"` (the component file does not exist yet).

- [ ] **Step 3: Implement**

```tsx
// src/components/Sidebar.tsx
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

type Tab = 'history' | 'saved';

export interface SidebarProps {
  open: boolean;
  onToggle(): void;
  history: ReactNode;
  saved: ReactNode;
}

export function Sidebar({ open, onToggle, history, saved }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('history');
  const historyTabId = useId();
  const savedTabId = useId();
  const historyPanelId = useId();
  const savedPanelId = useId();

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <button
        type="button"
        className="sidebar__toggle"
        aria-label="Toggle sidebar"
        aria-expanded={open}
        onClick={onToggle}
      >
        {'\u2630'}
      </button>
      {open && (
        <div className="sidebar__body">
          <div className="sidebar__tabs" role="tablist" aria-label="Sidebar panels">
            <button
              type="button"
              role="tab"
              id={historyTabId}
              aria-controls={historyPanelId}
              aria-selected={tab === 'history'}
              className="sidebar__tab"
              onClick={() => setTab('history')}
            >
              History
            </button>
            <button
              type="button"
              role="tab"
              id={savedTabId}
              aria-controls={savedPanelId}
              aria-selected={tab === 'saved'}
              className="sidebar__tab"
              onClick={() => setTab('saved')}
            >
              Saved
            </button>
          </div>
          {tab === 'history' ? (
            <div role="tabpanel" id={historyPanelId} aria-labelledby={historyTabId}>
              {history}
            </div>
          ) : (
            <div role="tabpanel" id={savedPanelId} aria-labelledby={savedTabId}>
              {saved}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
```

Note: the toggle button (`aria-label="Toggle sidebar"`) is rendered in both open and closed states so it always remains operable; the `complementary` landmark (`<aside aria-label="Sidebar">`) is always present, and the tablist/panels only mount when `open`.

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/Sidebar.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/components/Sidebar.test.tsx
git commit -m "feat(sidebar): add Sidebar shell (toggle + History/Saved tabs, a11y roles)"
```

---

### Task 22: `App.tsx` wiring + `App.test.tsx` mock additions + `Toolbar` bookmark slot + tests

This is a renderer-mount/wiring task (not naturally red-green): it composes Block-C and Block-D pieces into `App`, threads the bookmark button through `Toolbar`, mounts the favorites bar + sidebar, and wires `useContentInset`. Per contract §8.3/§8.4 the component prop contracts are PINNED — App MUST match them exactly (including the `saved.removeCurrent()` unsave path) and `src/lib/layout.ts` is only IMPORTED here (created in Task 14). Show the FULL edited files, verify with the component/App tests + `npx tsc --noEmit`, then commit.

**Files:**
- Modify: src/components/Toolbar.tsx (add the optional `bookmark` slot rendered after `AdblockShield`)
- Modify: src/components/Toolbar.test.tsx (assert the bookmark slot renders when provided)
- Modify: src/App.tsx (mount FavoritesBar + Sidebar + BookmarkButton; wire useFavorites/useHistory/useSaved/useContentInset; manager modal + sidebar/favorites toggle state)
- Modify: src/App.test.tsx (extend the ipcClient mock with favorites/history/saved + view.setContentInset; assert the new chrome renders)

- [ ] **Step 1: Extend the `Toolbar` to accept an optional bookmark slot**

Full edited `src/components/Toolbar.tsx`:

```tsx
// src/components/Toolbar.tsx
import type { ReactNode } from 'react';
import type { AdblockState, NavState } from '../../shared/types';
import { NavControls } from './NavControls';
import { AddressBar } from './AddressBar';
import { AdblockShield } from './AdblockShield';

export interface ToolbarAdblockProps {
  state: AdblockState;
  page: number;
  host: string | null;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
}

export interface ToolbarProps {
  state: NavState;
  navigate(raw: string): void;
  back(): void;
  forward(): void;
  reloadOrStop(): void;
  home(): void;
  adblock: ToolbarAdblockProps;
  /** Optional toolbar slot for the saved-list bookmark button (Phase 3). */
  bookmark?: ReactNode;
}

export function Toolbar({
  state,
  navigate,
  back,
  forward,
  reloadOrStop,
  home,
  adblock,
  bookmark,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <NavControls
        state={state}
        back={back}
        forward={forward}
        reloadOrStop={reloadOrStop}
        home={home}
      />
      <AddressBar url={state.url} onSubmit={navigate} />
      <AdblockShield
        state={adblock.state}
        page={adblock.page}
        host={adblock.host}
        setEnabled={adblock.setEnabled}
        toggleAllowlist={adblock.toggleAllowlist}
      />
      {bookmark}
    </div>
  );
}
```

Add one test to `src/components/Toolbar.test.tsx` (insert immediately before the final `});` that closes `describe('Toolbar', …)`):

```tsx
  it('renders the optional bookmark slot when provided', () => {
    render(
      <Toolbar
        state={state}
        {...handlers()}
        bookmark={<button type="button">Save page</button>}
      />,
    );
    expect(screen.getByRole('button', { name: /save page/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Verify Toolbar still green**
Run: `npx vitest run src/components/Toolbar.test.tsx`
Expected: PASS (existing 7 tests + the new bookmark-slot test = 8).

- [ ] **Step 3: Wire `App.tsx`**

Full edited `src/App.tsx`:

```tsx
// src/App.tsx
import { useEffect, useState } from 'react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavCrashed, NavFailed } from '../shared/types';
import { aegis } from './lib/ipcClient';
import { applyTheme } from './lib/theme';
import { useNav } from './hooks/useNav';
import { useAdblock } from './hooks/useAdblock';
import { useFavorites } from './hooks/useFavorites';
import { useHistory } from './hooks/useHistory';
import { useSaved } from './hooks/useSaved';
import { useContentInset } from './hooks/useContentInset';
import { Toolbar } from './components/Toolbar';
import { BookmarkButton } from './components/BookmarkButton';
import { FavoritesBar } from './components/FavoritesBar';
import { FavoritesManager } from './components/FavoritesManager';
import { Sidebar } from './components/Sidebar';
import { HistoryPanel } from './components/HistoryPanel';
import { SavedPanel } from './components/SavedPanel';
import { ErrorOverlay } from './components/ErrorOverlay';
import { SkipLink } from './components/SkipLink';
import { Toaster } from './components/Toaster';
import { ConfirmDialog } from './components/ConfirmDialog';
import { WelcomeHint } from './components/WelcomeHint';

const CONTENT_ANCHOR_ID = 'content-anchor';

/** Returns the hostname of `url`, or null when `url` has no parseable host. */
function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

export function App() {
  const nav = useNav(PRIMARY_VIEW_ID);
  const adblock = useAdblock(PRIMARY_VIEW_ID, nav.state.url);
  const favorites = useFavorites(nav.state.url);
  const history = useHistory();
  const saved = useSaved(nav.state.url);
  const [failed, setFailed] = useState<NavFailed | null>(null);
  const [crashed, setCrashed] = useState<NavCrashed | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Favorites bar is always-on in Phase 3; only the sidebar toggles the inset.
  useContentInset(PRIMARY_VIEW_ID, { sidebarOpen });

  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
  }, []);

  useEffect(() => {
    const offFailed = aegis.nav.onFailed((f) => {
      if (f.viewId !== PRIMARY_VIEW_ID) return;
      setCrashed(null);
      setFailed(f);
    });
    const offCrashed = aegis.nav.onCrashed((c) => {
      if (c.viewId !== PRIMARY_VIEW_ID) return;
      setFailed(null);
      setCrashed(c);
    });
    return () => {
      offFailed();
      offCrashed();
    };
  }, []);

  // Main owns content hide/show for failures and crashes. When a fresh
  // navigation reports loading state, clear any error/crash overlay. We do NOT
  // call aegis.view.setContentVisible here — main re-shows the content view.
  useEffect(() => {
    if (nav.state.isLoading && !nav.state.crashed) {
      setFailed(null);
      setCrashed(null);
    }
  }, [nav.state.isLoading, nav.state.crashed]);

  const handleRetry = (): void => {
    void aegis.nav.reloadOrStop(PRIMARY_VIEW_ID);
  };

  const handleHome = (): void => {
    nav.home();
  };

  return (
    <div className="app">
      <SkipLink targetId={CONTENT_ANCHOR_ID} />
      <Toolbar
        state={nav.state}
        navigate={nav.navigate}
        back={nav.back}
        forward={nav.forward}
        reloadOrStop={nav.reloadOrStop}
        home={nav.home}
        adblock={{
          state: adblock.state,
          page: adblock.page,
          host: hostOf(nav.state.url),
          setEnabled: adblock.setEnabled,
          toggleAllowlist: adblock.toggleAllowlist,
        }}
        bookmark={
          <BookmarkButton
            saved={saved.isCurrentSaved}
            canSave={hostOf(nav.state.url) !== null}
            onSave={() => void saved.addCurrent(nav.state.title)}
            onUnsave={() => void saved.removeCurrent()}
          />
        }
      />
      <FavoritesBar
        favorites={favorites.favorites}
        tagUnion={favorites.tagUnion}
        activeTags={favorites.activeTags}
        setActiveTags={favorites.setActiveTags}
        onOpenFavorite={(url) => void nav.navigate(url)}
        onOpenManager={() => setManagerOpen(true)}
      />
      <Sidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((v) => !v)}
        history={
          <HistoryPanel
            entries={history.entries}
            query={history.query}
            setQuery={history.setQuery}
            search={history.search}
            remove={history.remove}
            clear={history.clear}
            onOpen={(url) => void nav.navigate(url)}
          />
        }
        saved={<SavedPanel items={saved.items} remove={saved.remove} onOpen={(url) => void nav.navigate(url)} />}
      />
      <div id={CONTENT_ANCHOR_ID} className="content-anchor" tabIndex={-1} />
      <ErrorOverlay
        failed={failed}
        crashed={crashed}
        onRetry={handleRetry}
        onHome={handleHome}
      />
      {managerOpen && (
        <FavoritesManager
          favorites={favorites.favorites}
          tagUnion={favorites.tagUnion}
          onClose={() => setManagerOpen(false)}
          add={favorites.add}
          update={favorites.update}
          remove={favorites.remove}
          renameTag={favorites.renameTag}
          deleteTag={favorites.deleteTag}
        />
      )}
      <WelcomeHint />
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
```

- [ ] **Step 4: Extend the `App.test.tsx` ipcClient mock + assert the new chrome**

Full edited `src/App.test.tsx`:

```tsx
// src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavState, NavFailed, NavCrashed, Settings } from '../shared/types';

const baseState: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const baseSettings: Settings = {
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#4f8cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
};

const reloadOrStop = vi.fn(async () => {});
const setContentVisible = vi.fn(async () => {});
const setContentInset = vi.fn(async () => {});
let failedCb: ((f: NavFailed) => void) | undefined;
let crashedCb: ((c: NavCrashed) => void) | undefined;
let stateCb: ((s: NavState) => void) | undefined;

vi.mock('./lib/ipcClient', () => ({
  aegis: {
    nav: {
      navigate: vi.fn(async () => {}),
      back: vi.fn(async () => {}),
      forward: vi.fn(async () => {}),
      reloadOrStop: (...a: any[]) => reloadOrStop(...a),
      home: vi.fn(async () => {}),
      getState: vi.fn(async () => baseState),
      onState: (cb: (s: NavState) => void) => {
        stateCb = cb;
        return () => {};
      },
      onFailed: (cb: (f: NavFailed) => void) => {
        failedCb = cb;
        return () => {};
      },
      onCrashed: (cb: (c: NavCrashed) => void) => {
        crashedCb = cb;
        return () => {};
      },
    },
    view: {
      setContentVisible: (...a: any[]) => setContentVisible(...a),
      setContentInset: (...a: any[]) => setContentInset(...a),
    },
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
    adblock: {
      getState: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      setEnabled: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      toggleAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      onBlockedCount: vi.fn().mockReturnValue(() => {}),
    },
    lists: { updateNow: vi.fn().mockResolvedValue({ perSource: [], lastUpdated: 0 }) },
    favorites: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      reorder: vi.fn().mockResolvedValue([]),
      renameTag: vi.fn().mockResolvedValue([]),
      deleteTag: vi.fn().mockResolvedValue([]),
      tagUnion: vi.fn().mockResolvedValue([]),
    },
    history: {
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    saved: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      has: vi.fn().mockResolvedValue(false),
    },
  },
}));

import { App } from './App';

beforeEach(() => {
  vi.clearAllMocks();
  failedCb = undefined;
  crashedCb = undefined;
  stateCb = undefined;
});

describe('App', () => {
  it('renders the toolbar address bar', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /address/i })).toBeInTheDocument());
  });

  it('shows the ErrorOverlay when a nav.failed event arrives', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Retry on the overlay calls aegis.nav.reloadOrStop', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(reloadOrStop).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });

  it('shows the overlay on nav.crashed and clears it on a fresh nav.state', async () => {
    render(<App />);
    await waitFor(() => expect(crashedCb).toBeTypeOf('function'));
    act(() => crashedCb!({ viewId: PRIMARY_VIEW_ID, reason: 'oom' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    act(() => stateCb!({ ...baseState, isLoading: true, crashed: false }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does NOT call setContentVisible for the error/crash overlay', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    expect(setContentVisible).not.toHaveBeenCalled();
  });

  it('renders the AdblockShield in the toolbar', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /ad blocking/i })).toBeInTheDocument(),
    );
  });

  it('mounts the favorites bar and the sidebar toggle', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /toggle sidebar/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();
  });

  it('reports the content inset on mount (favorites bar always-on, sidebar closed)', async () => {
    render(<App />);
    await waitFor(() => expect(setContentInset).toHaveBeenCalled());
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 96, left: 0 });
  });

  it('toggling the sidebar re-reports the inset with the sidebar width on the left', async () => {
    render(<App />);
    await waitFor(() => expect(setContentInset).toHaveBeenCalled());
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /toggle sidebar/i }));
    await waitFor(() =>
      expect(setContentInset).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, { top: 96, left: 280 }),
    );
  });
});
```

- [ ] **Step 5: Verify the renderer tests pass + the whole project type-checks**
Run: `npx vitest run src/App.test.tsx src/components/Toolbar.test.tsx && npx tsc --noEmit`
Expected: PASS — `App.test.tsx` (9 tests) and `Toolbar.test.tsx` (8 tests) green; `npx tsc --noEmit` exits 0 (the pinned prop contracts from §8.3 — `BookmarkButtonProps {saved,canSave,onSave,onUnsave}`, `useSaved.addCurrent(title)`/`removeCurrent()`, six-prop `FavoritesBarProps`, `FavoritesManagerProps` with no `reorder` — all line up, and `src/lib/layout.ts` resolves via `useContentInset`).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/Toolbar.tsx src/components/Toolbar.test.tsx
git commit -m "feat(sidebar): wire favorites bar, sidebar, bookmark button and content inset into App"
```

---

#### New names introduced (Block D)

- `useHistory` — exported hook (`src/hooks/useHistory.ts`); returns `{ entries, query, setQuery, search, remove, clear }`.
- `HistoryPanel` — exported component (`src/components/HistoryPanel.tsx`).
- `HistoryPanelProps` — exported interface (`src/components/HistoryPanel.tsx`): `{ entries, query, setQuery, search, remove, clear, onOpen }`.
- `SavedPanel` — exported component (`src/components/SavedPanel.tsx`).
- `SavedPanelProps` — exported interface (`src/components/SavedPanel.tsx`): `{ items, remove, onOpen }`.
- `Sidebar` — exported component (`src/components/Sidebar.tsx`).
- `SidebarProps` — exported interface (`src/components/Sidebar.tsx`): `{ open, onToggle, history, saved }`.
- `Toolbar` `bookmark?: ReactNode` — new optional prop added to the existing `ToolbarProps` interface (`src/components/Toolbar.tsx`).

I now have all the as-built patterns confirmed: the `launchApp` poll, `navigate`/`state`/`navigateAndSettle` helpers, the `__aegisTest.places` registry shape (from §8.1), `mkdtempSync`/`AEGIS_USER_DATA`/`AEGIS_HOME_URL`, fixture server, titled fixtures (`spa.html`/`late-title.html`/`ad-page.html`), and `view.getBounds()` per §9.1. I have everything needed to write Tasks 23-26.

### Task 23: e2e `favorites.spec.ts` — favorites store end-to-end + chip→navigate (drive via `__aegisTest.places`)

**Files:**
- Create: `electron/test/e2e/favorites.spec.ts`
- Test: `electron/test/e2e/favorites.spec.ts` (this IS the e2e spec)

Per contract §9.1: drive the favorites store through the booted app via `__aegisTest.places.favoritesRepo` (the constructed repo instance wired in Task 10 / §8.1) and prove "a favorite navigates" via `__aegisTest.primary.navigate(url)` + `getState().url`. NO chrome-DOM, NO `firstWindow`. The chip-click / tag-filter UI is already covered by the Block-C FavoritesBar/TagFilter component tests.

- [ ] **Step 1: Write the failing test**

```ts
// electron/test/e2e/favorites.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, Favorite } from '../../../shared/types';

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launchApp(
  userDataDir: string,
  extraEnv?: Record<string, string>,
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, ...extraEnv },
  });
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(() => {
            const reg = (globalThis as any).__aegisTest;
            return reg?.primary ? reg.primary.getState().url : '';
          });
        } catch {
          return ''; // transient startup race (context not ready) — let expect.poll retry
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function state(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

function navigate(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.primary.navigate(u);
  }, url);
}

/** Drive the constructed FavoritesRepo inside the booted app (§9.1). */
function favAdd(
  app: ElectronApplication,
  input: { name: string; url: string; tags: string[] },
): Promise<Favorite[]> {
  return app.evaluate(
    (_e, i) => (globalThis as any).__aegisTest.places.favoritesRepo.add(i),
    input,
  );
}

function favList(app: ElectronApplication): Promise<Favorite[]> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.places.favoritesRepo.list(),
  );
}

function favTagUnion(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.places.favoritesRepo.tagUnion(),
  );
}

function favRenameTag(
  app: ElectronApplication,
  oldT: string,
  newT: string,
): Promise<Favorite[]> {
  return app.evaluate(
    (_e, args) =>
      (globalThis as any).__aegisTest.places.favoritesRepo.renameTag(
        args.oldT,
        args.newT,
      ),
    { oldT, newT },
  );
}

function favDeleteTag(app: ElectronApplication, tag: string): Promise<Favorite[]> {
  return app.evaluate(
    (_e, t) => (globalThis as any).__aegisTest.places.favoritesRepo.deleteTag(t),
    tag,
  );
}

test('favorites add → list/tagUnion reflect tags; renameTag/deleteTag span all rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-fav-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const aUrl = `${fixtures.baseUrl}/spa.html`;
    const bUrl = `${fixtures.baseUrl}/late-title.html`;

    // Add two favorites with overlapping + distinct tags.
    let list = await favAdd(app, { name: 'Alpha', url: aUrl, tags: ['news', 'work'] });
    expect(list.map((f) => f.name)).toEqual(['Alpha']);
    list = await favAdd(app, { name: 'Beta', url: bUrl, tags: ['work', 'fun'] });
    // Ordered by position (insertion order): Alpha first, Beta second.
    expect(list.map((f) => f.name)).toEqual(['Alpha', 'Beta']);
    expect(list[0].position).toBeLessThan(list[1].position);

    // tagUnion is the distinct, sorted set across all rows.
    expect(await favTagUnion(app)).toEqual(['fun', 'news', 'work']);

    // Global rename: 'work' → 'job' updates BOTH favorites.
    const renamed = await favRenameTag(app, 'work', 'job');
    expect(renamed.find((f) => f.name === 'Alpha')!.tags).toEqual(['news', 'job']);
    expect(renamed.find((f) => f.name === 'Beta')!.tags).toEqual(['job', 'fun']);
    expect(await favTagUnion(app)).toEqual(['fun', 'job', 'news']);

    // Global delete: 'job' is removed from EVERY favorite.
    const afterDelete = await favDeleteTag(app, 'job');
    expect(afterDelete.find((f) => f.name === 'Alpha')!.tags).toEqual(['news']);
    expect(afterDelete.find((f) => f.name === 'Beta')!.tags).toEqual(['fun']);
    expect(await favTagUnion(app)).toEqual(['fun', 'news']);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a favorite navigates the content view to its URL (chip → navigate wiring)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-fav-nav-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const favUrl = `${fixtures.baseUrl}/spa.html`;
    await favAdd(app, { name: 'Alpha', url: favUrl, tags: ['news'] });

    // FavoritesBar's chip onOpenFavorite === nav.navigate (component-tested);
    // here we prove the booted app navigates the content view to a favorite URL.
    const fav = (await favList(app))[0];
    await navigate(app, fav.url);
    await expect.poll(async () => (await state(app)).url, { timeout: 15000 }).toBe(favUrl);
    await expect
      .poll(async () => (await state(app)).isLoading, { timeout: 15000 })
      .toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/favorites.spec.ts`
Expected: FAIL — `__aegisTest.places` is `undefined` (or `places.favoritesRepo.add is not a function`) until Task 10 wires the `places` registry and the repo is constructed; the first test rejects in `app.evaluate` with a `TypeError: Cannot read properties of undefined (reading 'favoritesRepo')`.

- [ ] **Step 3: Implement**
No new production code in this task — the spec drives the favorites store and navigation already implemented in Blocks A–D (FavoritesRepo, Task 2) and exposed via the `__aegisTest.places` registry (Task 10 / §8.1). This is a pure e2e task; the "implementation" it exercises is the booted-app wiring. Nothing to add here beyond the spec itself.

- [ ] **Step 4: Run the test, verify it passes**
Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/favorites.spec.ts`
Expected: PASS — both tests green (add/list/tagUnion/renameTag/deleteTag round-trip through the live repo; a favorite URL navigates the content view).

- [ ] **Step 5: Commit**
```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/test/e2e/favorites.spec.ts
git commit -m "test(favorites): e2e favorites store + chip-navigate via __aegisTest.places"
```

---

### Task 24: e2e `history.spec.ts` — real-nav auto-record, search, dedup-on-revisit, remove, clear (drive via `__aegisTest.places.historyRepo`)

**Files:**
- Create: `electron/test/e2e/history.spec.ts`
- Test: `electron/test/e2e/history.spec.ts`

Per §9.1: history auto-recording is triggered by a REAL nav (`__aegisTest.primary.navigate(url)`) against the fixture server (the recorder is wired in Task 10 on the live content WC). Per §9.2: the same-URL revisit/dedup assertion MUST gate on a positive re-navigation signal — poll `historyRepo.mostRecent()` for the `visitedAt` to advance, NOT `navigateAndSettle` (which resolves instantly when already on the URL → racy). All reads/mutations go through `__aegisTest.places.historyRepo`. NO chrome-DOM.

- [ ] **Step 1: Write the failing test**

```ts
// electron/test/e2e/history.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, HistoryEntry } from '../../../shared/types';

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launchApp(
  userDataDir: string,
  extraEnv?: Record<string, string>,
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, ...extraEnv },
  });
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(() => {
            const reg = (globalThis as any).__aegisTest;
            return reg?.primary ? reg.primary.getState().url : '';
          });
        } catch {
          return ''; // transient startup race (context not ready) — let expect.poll retry
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function state(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

function navigate(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.primary.navigate(u);
  }, url);
}

async function navigateAndSettle(app: ElectronApplication, url: string): Promise<void> {
  await navigate(app, url);
  await expect.poll(async () => (await state(app)).url, { timeout: 15000 }).toBe(url);
  await expect.poll(async () => (await state(app)).isLoading, { timeout: 15000 }).toBe(false);
}

/** Reads through the constructed HistoryRepo inside the booted app (§9.1). */
function historyList(app: ElectronApplication): Promise<HistoryEntry[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.historyRepo.list());
}

function historySearch(app: ElectronApplication, q: string): Promise<HistoryEntry[]> {
  return app.evaluate(
    (_e, query) => (globalThis as any).__aegisTest.places.historyRepo.search(query),
    q,
  );
}

function historyMostRecent(
  app: ElectronApplication,
): Promise<HistoryEntry | undefined> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.places.historyRepo.mostRecent(),
  );
}

function historyRemove(app: ElectronApplication, id: number): Promise<void> {
  return app.evaluate(
    (_e, rowId) => (globalThis as any).__aegisTest.places.historyRepo.remove(rowId),
    id,
  );
}

function historyClear(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.historyRepo.clear());
}

/** Poll until a history row for `url` exists, return it. */
async function waitForEntry(
  app: ElectronApplication,
  url: string,
): Promise<HistoryEntry> {
  await expect
    .poll(async () => (await historyList(app)).some((e) => e.url === url), {
      timeout: 15000,
    })
    .toBe(true);
  return (await historyList(app)).find((e) => e.url === url)!;
}

test('a real top-frame navigation auto-records a history entry with url + title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-history-record-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const url = `${fixtures.baseUrl}/spa.html`;
    await navigateAndSettle(app, url);

    const entry = await waitForEntry(app, url);
    expect(entry.url).toBe(url);
    // page-title-updated → setMostRecentTitle fills in the document title.
    await expect
      .poll(async () => (await waitForEntry(app, url)).title, { timeout: 15000 })
      .toBe('SPA Fixture');

    // about:blank (non-http) is NOT recorded.
    expect((await historyList(app)).some((e) => e.url === 'about:blank')).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history search filters by url/title; remove drops a row; clear empties the list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-history-ops-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const aUrl = `${fixtures.baseUrl}/spa.html`;
    const bUrl = `${fixtures.baseUrl}/late-title.html`;
    await navigateAndSettle(app, aUrl);
    await waitForEntry(app, aUrl);
    await navigateAndSettle(app, bUrl);
    await waitForEntry(app, bUrl);

    // search: 'late-title' matches only the B url.
    const hits = await historySearch(app, 'late-title');
    expect(hits.map((e) => e.url)).toEqual([bUrl]);

    // list newest-first: B before A.
    const list = await historyList(app);
    expect(list.map((e) => e.url)).toEqual([bUrl, aUrl]);

    // remove the A row → only B remains.
    const aRow = list.find((e) => e.url === aUrl)!;
    await historyRemove(app, aRow.id);
    await expect
      .poll(async () => (await historyList(app)).map((e) => e.url), { timeout: 15000 })
      .toEqual([bUrl]);

    // clear → empty.
    await historyClear(app);
    await expect
      .poll(async () => (await historyList(app)).length, { timeout: 15000 })
      .toBe(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revisiting the most-recent URL dedups (updates visitedAt) instead of inserting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-history-dedup-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const aUrl = `${fixtures.baseUrl}/spa.html`;
    const bUrl = `${fixtures.baseUrl}/late-title.html`;

    // Visit A then B → two rows, B most-recent.
    await navigateAndSettle(app, aUrl);
    await waitForEntry(app, aUrl);
    await navigateAndSettle(app, bUrl);
    await waitForEntry(app, bUrl);
    expect((await historyList(app)).length).toBe(2);

    // Re-navigate to A (the view is NOT currently on A → this is a genuine nav,
    // recorded as a NEW most-recent A row distinct from the older A).
    await navigateAndSettle(app, aUrl);
    await expect
      .poll(async () => (await historyMostRecent(app))?.url, { timeout: 15000 })
      .toBe(aUrl);
    expect((await historyList(app)).length).toBe(3);

    // §9.2: same-URL reload of A. navigateAndSettle is racy here (already on A),
    // so capture the current most-recent visitedAt, force a reload, then gate on
    // the dedup signal: row count UNCHANGED + most-recent visitedAt ADVANCED.
    const beforeRow = await historyMostRecent(app);
    const beforeAt = beforeRow!.visitedAt;
    const beforeCount = (await historyList(app)).length;

    await app.evaluate(() => (globalThis as any).__aegisTest.primary.reloadOrStop());

    // Dedup vs most-recent: no new row inserted; the A row's visitedAt advances.
    await expect
      .poll(async () => (await historyMostRecent(app))?.visitedAt ?? 0, {
        timeout: 15000,
      })
      .toBeGreaterThan(beforeAt);
    expect((await historyMostRecent(app))?.url).toBe(aUrl);
    expect((await historyList(app)).length).toBe(beforeCount);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/history.spec.ts`
Expected: FAIL — `waitForEntry` times out / `__aegisTest.places.historyRepo` is undefined until Task 10 constructs the `HistoryRepo`, wires the `HistoryRecorder` to the live content WC, and exposes `places.historyRepo`; the first test fails its `expect.poll(... some(e=>e.url===url)).toBe(true)`.

- [ ] **Step 3: Implement**
No new production code in this task — the recorder (Task 5), `HistoryRepo` (Task 3), and boot wiring (Task 10) are already in place from Blocks A–B. This e2e exercises that live wiring (real nav → recorder → repo) and the `places.historyRepo` registry. Nothing to add beyond the spec.

- [ ] **Step 4: Run the test, verify it passes**
Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/history.spec.ts`
Expected: PASS — all three tests green (auto-record + title fill-in + non-http skip; search/remove/clear; dedup-on-revisit gated on the positive `mostRecent().visitedAt` signal per §9.2).

- [ ] **Step 5: Commit**
```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/test/e2e/history.spec.ts
git commit -m "test(history): e2e auto-record + search/remove/clear + dedup-on-revisit via __aegisTest.places"
```

---

### Task 25: e2e `saved.spec.ts` — saved-list add/has/remove/list end-to-end (drive via `__aegisTest.places.savedRepo`)

**Files:**
- Create: `electron/test/e2e/saved.spec.ts`
- Test: `electron/test/e2e/saved.spec.ts`

Per §9.1: drive `__aegisTest.places.savedRepo.add({url,title})` / `.has(url)` / `.remove(id)` / `.list()` and assert via the returned arrays/booleans. The bookmark-button fill-in (`saved.has(currentUrl)`) + toggle is BookmarkButton-component-tested (Task 17). NO chrome-DOM.

- [ ] **Step 1: Write the failing test**

```ts
// electron/test/e2e/saved.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { SavedItem } from '../../../shared/types';

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launchApp(
  userDataDir: string,
  extraEnv?: Record<string, string>,
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, ...extraEnv },
  });
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(() => {
            const reg = (globalThis as any).__aegisTest;
            return reg?.primary ? reg.primary.getState().url : '';
          });
        } catch {
          return ''; // transient startup race (context not ready) — let expect.poll retry
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

/** Drive the constructed SavedRepo inside the booted app (§9.1). */
function savedAdd(
  app: ElectronApplication,
  input: { url: string; title: string },
): Promise<SavedItem[]> {
  return app.evaluate(
    (_e, i) => (globalThis as any).__aegisTest.places.savedRepo.add(i),
    input,
  );
}

function savedList(app: ElectronApplication): Promise<SavedItem[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.savedRepo.list());
}

function savedHas(app: ElectronApplication, url: string): Promise<boolean> {
  return app.evaluate(
    (_e, u) => (globalThis as any).__aegisTest.places.savedRepo.has(u),
    url,
  );
}

function savedRemove(app: ElectronApplication, id: number): Promise<SavedItem[]> {
  return app.evaluate(
    (_e, rowId) => (globalThis as any).__aegisTest.places.savedRepo.remove(rowId),
    id,
  );
}

test('saved-list add → has(url) true; remove → has(url) false (the bookmark toggle path)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-saved-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const aUrl = `${fixtures.baseUrl}/spa.html`;
    const bUrl = `${fixtures.baseUrl}/late-title.html`;

    // Before save: not present.
    expect(await savedHas(app, aUrl)).toBe(false);

    // Add A and B (BookmarkButton onSave path → saved.addCurrent → savedRepo.add).
    let list = await savedAdd(app, { url: aUrl, title: 'Alpha' });
    expect(list.map((s) => s.url)).toEqual([aUrl]);
    list = await savedAdd(app, { url: bUrl, title: 'Beta' });
    // ORDER BY savedAt DESC → most-recently-saved first.
    expect(list.map((s) => s.url)).toEqual([bUrl, aUrl]);

    // has() fills-in the bookmark button for a saved page.
    expect(await savedHas(app, aUrl)).toBe(true);
    expect(await savedHas(app, bUrl)).toBe(true);
    expect(await savedHas(app, `${fixtures.baseUrl}/never-saved.html`)).toBe(false);

    // Remove A (onUnsave path → saved.removeCurrent → savedRepo.remove) → only B remains.
    const aRow = (await savedList(app)).find((s) => s.url === aUrl)!;
    const afterRemove = await savedRemove(app, aRow.id);
    expect(afterRemove.map((s) => s.url)).toEqual([bUrl]);
    expect(await savedHas(app, aUrl)).toBe(false);
    expect(await savedHas(app, bUrl)).toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/saved.spec.ts`
Expected: FAIL — `__aegisTest.places.savedRepo` is undefined (the `app.evaluate` rejects with `TypeError: Cannot read properties of undefined (reading 'savedRepo')`) until Task 10 constructs `SavedRepo` and exposes it under `places`.

- [ ] **Step 3: Implement**
No new production code — `SavedRepo` (Task 4) and the `places.savedRepo` registry (Task 10 / §8.1) already exist from Blocks A–B. This e2e exercises that wiring. Nothing to add beyond the spec.

- [ ] **Step 4: Run the test, verify it passes**
Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/saved.spec.ts`
Expected: PASS — add/has/remove/list round-trip through the live repo; `has` flips true→false across add/remove (the bookmark toggle data path).

- [ ] **Step 5: Commit**
```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/test/e2e/saved.spec.ts
git commit -m "test(saved): e2e saved-list add/has/remove/list via __aegisTest.places"
```

---

### Task 26: e2e `sidebar.spec.ts` (content-inset round-trip) + `persistence.spec.ts` (relaunch) + FULL regression gate — the Phase-3 exit

**Files:**
- Create: `electron/test/e2e/sidebar.spec.ts`
- Create: `electron/test/e2e/persistence.spec.ts`
- Test: `electron/test/e2e/sidebar.spec.ts`, `electron/test/e2e/persistence.spec.ts`

Per §9.1 + §8.5: `sidebar.spec.ts` drives `__aegisTest.places.setContentInset(top,left)` and asserts the content bounds via `__aegisTest.primary.view.getBounds()` (verified to exist in Electron 42 — `View.getBounds(): Rectangle`). Initial top bound === `TOOLBAR_H + FAVBAR_H` = 96 (favbar always-on); toggling the sidebar changes the `left` (x) bound by `SIDEBAR_W` = 280 and restores on close; window resize keeps the inset. Per §9.3: `persistence.spec.ts` seeds a favorite + saved item in app1, `await app1.close()`, relaunches app2 with the SAME `AEGIS_USER_DATA`, asserts they persisted. NO chrome-DOM. After both pass, run the full gate.

- [ ] **Step 1: Write the failing tests**

`electron/test/e2e/sidebar.spec.ts`:

```ts
// electron/test/e2e/sidebar.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirror src/lib/layout.ts (Task 14): the renderer computes the inset from these
// constants and the e2e asserts the resulting content WebContentsView bounds.
const TOOLBAR_H = 56;
const FAVBAR_H = 40;
const SIDEBAR_W = 280;
const TOP_INSET = TOOLBAR_H + FAVBAR_H; // 96, favbar always-on (§8.5)

async function launchApp(
  userDataDir: string,
  extraEnv?: Record<string, string>,
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, ...extraEnv },
  });
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(() => {
            const reg = (globalThis as any).__aegisTest;
            return reg?.primary ? reg.primary.getState().url : '';
          });
        } catch {
          return ''; // transient startup race (context not ready) — let expect.poll retry
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

interface Bounds { x: number; y: number; width: number; height: number; }

/** Content WebContentsView bounds (View.getBounds() exists on the base class — §9.1). */
function contentBounds(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.getBounds(),
  );
}

/** Drive the boot-side inset closure directly (§8.5 / §9.1). */
function setContentInset(
  app: ElectronApplication,
  top: number,
  left: number,
): Promise<void> {
  return app.evaluate(
    (_e, args) =>
      (globalThis as any).__aegisTest.places.setContentInset(args.top, args.left),
    { top, left },
  );
}

test('content top inset is TOOLBAR_H+FAVBAR_H on boot (favorites bar always-on)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-top-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // The renderer reports the favbar-inclusive top inset on mount; poll until applied.
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);
    // Sidebar closed on boot → left bound at 0.
    expect((await contentBounds(app)).x).toBe(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening the sidebar insets content left by SIDEBAR_W; closing restores it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-toggle-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);
    const closed = await contentBounds(app);
    expect(closed.x).toBe(0);

    // Open the sidebar (useContentInset reports left = SIDEBAR_W).
    await setContentInset(app, TOP_INSET, SIDEBAR_W);
    await expect
      .poll(async () => (await contentBounds(app)).x, { timeout: 15000 })
      .toBe(SIDEBAR_W);
    const open = await contentBounds(app);
    // Content shifts right by SIDEBAR_W and narrows by the same amount; top unchanged.
    expect(open.x).toBe(SIDEBAR_W);
    expect(open.width).toBe(closed.width - SIDEBAR_W);
    expect(open.y).toBe(TOP_INSET);

    // Close the sidebar → left inset restored to 0, full width back.
    await setContentInset(app, TOP_INSET, 0);
    await expect
      .poll(async () => (await contentBounds(app)).x, { timeout: 15000 })
      .toBe(0);
    const reclosed = await contentBounds(app);
    expect(reclosed.x).toBe(0);
    expect(reclosed.width).toBe(closed.width);
    expect(reclosed.y).toBe(TOP_INSET);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a window resize keeps the active inset (top/left preserved, width tracks the window)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-resize-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);

    // Open the sidebar, then resize the window: the stored inset must re-apply.
    await setContentInset(app, TOP_INSET, SIDEBAR_W);
    await expect
      .poll(async () => (await contentBounds(app)).x, { timeout: 15000 })
      .toBe(SIDEBAR_W);

    await app.evaluate(() => {
      const { BaseWindow } = require('electron');
      const win = BaseWindow.getAllWindows()[0];
      const [w, h] = win.getSize();
      win.setSize(w - 120, h - 80);
    });

    // After resize the inset is preserved: x still SIDEBAR_W, y still TOP_INSET,
    // width = newWindowWidth - SIDEBAR_W (content tracks the narrower window).
    await expect
      .poll(async () => (await contentBounds(app)).x, { timeout: 15000 })
      .toBe(SIDEBAR_W);
    const after = await contentBounds(app);
    expect(after.y).toBe(TOP_INSET);
    const winW = await app.evaluate(() => {
      const { BaseWindow } = require('electron');
      return BaseWindow.getAllWindows()[0].getContentBounds().width;
    });
    expect(after.width).toBe(winW - SIDEBAR_W);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

`electron/test/e2e/persistence.spec.ts`:

```ts
// electron/test/e2e/persistence.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { Favorite, SavedItem, HistoryEntry } from '../../../shared/types';

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launchApp(
  userDataDir: string,
  extraEnv?: Record<string, string>,
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, ...extraEnv },
  });
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(() => {
            const reg = (globalThis as any).__aegisTest;
            return reg?.primary ? reg.primary.getState().url : '';
          });
        } catch {
          return ''; // transient startup race (context not ready) — let expect.poll retry
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function favAdd(
  app: ElectronApplication,
  input: { name: string; url: string; tags: string[] },
): Promise<Favorite[]> {
  return app.evaluate(
    (_e, i) => (globalThis as any).__aegisTest.places.favoritesRepo.add(i),
    input,
  );
}

function favList(app: ElectronApplication): Promise<Favorite[]> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.places.favoritesRepo.list(),
  );
}

function savedAdd(
  app: ElectronApplication,
  input: { url: string; title: string },
): Promise<SavedItem[]> {
  return app.evaluate(
    (_e, i) => (globalThis as any).__aegisTest.places.savedRepo.add(i),
    input,
  );
}

function savedList(app: ElectronApplication): Promise<SavedItem[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.savedRepo.list());
}

/** Trigger a real top-frame navigation so the main-side recorder writes history. */
function navigate(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.primary.navigate(u);
  }, url);
}

function historyList(app: ElectronApplication): Promise<HistoryEntry[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.historyRepo.list());
}

test('favorites (with tags) + history + saved-list survive an app restart — the Phase-3 exit', async () => {
  // ONE userData dir reused across two launches (§9.3).
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-persist-'));
  const favUrl = `${fixtures.baseUrl}/spa.html`;
  const savedUrl = `${fixtures.baseUrl}/late-title.html`;

  // app1: seed a favorite (with tags) + a saved item, then close cleanly so the
  // first process releases the DB before app2 opens it (better-sqlite3 writes are
  // synchronous + WAL-durable; the await close() guarantees the release).
  const app1 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await favAdd(app1, { name: 'Persisted Fav', url: favUrl, tags: ['keep', 'me'] });
    await savedAdd(app1, { url: savedUrl, title: 'Persisted Saved' });
    // Sanity within app1.
    expect((await favList(app1)).map((f) => f.name)).toEqual(['Persisted Fav']);
    expect((await savedList(app1)).map((s) => s.title)).toEqual(['Persisted Saved']);
    // Record a real history entry (auto-recorded by the main-side recorder on a real
    // http nav) and confirm it landed BEFORE closing, so we know it was written to disk.
    await navigate(app1, favUrl);
    await expect
      .poll(async () => (await historyList(app1)).some((h) => h.url === favUrl), { timeout: 15000 })
      .toBe(true);
  } finally {
    await app1.close();
  }

  // app2: SAME userData dir → the SQLite store must restore both rows.
  const app2 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await favList(app2)).map((f) => f.name), { timeout: 15000 })
      .toEqual(['Persisted Fav']);
    const fav = (await favList(app2))[0];
    expect(fav.url).toBe(favUrl);
    expect(fav.tags).toEqual(['keep', 'me']); // tags persisted as JSON, re-parsed

    await expect
      .poll(async () => (await savedList(app2)).map((s) => s.title), { timeout: 15000 })
      .toEqual(['Persisted Saved']);
    expect((await savedList(app2))[0].url).toBe(savedUrl);

    // History (auto-recorded in app1) also survives the restart (spec §11.5).
    await expect
      .poll(async () => (await historyList(app2)).some((h) => h.url === favUrl), { timeout: 15000 })
      .toBe(true);
  } finally {
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests, verify they fail**
Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/sidebar.spec.ts electron/test/e2e/persistence.spec.ts`
Expected: FAIL — `sidebar.spec.ts` boot-top test fails its `expect.poll(... .y).toBe(96)` (content stays at the default `top=56` until Task 10 holds the inset state + Task 22's `useContentInset` reports `TOOLBAR_H+FAVBAR_H`, and `__aegisTest.places.setContentInset` is undefined); `persistence.spec.ts` rejects on `__aegisTest.places.favoritesRepo` being undefined.

- [ ] **Step 3: Implement**
No new production code in this task — the inset closure (`setContentInset`) + held inset state + resize re-apply (Task 10 boot, §8.1 `places.setContentInset`), the renderer's `useContentInset` reporting `top = TOOLBAR_H + FAVBAR_H` (Task 22 / §8.5), and the favorites/saved repos (Tasks 2/4) are all already in place from Blocks A–D. These two specs exercise that live wiring (content-inset round-trip + cross-launch SQLite persistence). Nothing to add beyond the specs.

- [ ] **Step 4: Run the tests, verify they pass — then the FULL Phase-3 regression gate**
Run (the two new specs):
`cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/sidebar.spec.ts electron/test/e2e/persistence.spec.ts`
Expected: PASS — sidebar boot top inset === 96; open/close toggles the left bound by 280 and restores; resize preserves the inset; favorite (with tags) + saved item survive the relaunch.

Then run the FULL gate (Phase-3 exit — all unit/component + all e2e must be green, no regression):
`cd /home/happyhobo/Documents/AI_Apps/Aegis && npm test && npm run build && npm run test:e2e`
Expected: PASS — the full Vitest suite (Phase-0+1+2 277 unit/component + all new Phase-3 unit/component) AND the full Playwright suite (the 31 prior e2e + the 5 new Phase-3 specs: favorites, history, saved, sidebar, persistence) all green. (`npm test` runs `pretest`→`rebuild:node`, restoring the Node ABI for the DB unit tests; the `npm run build` before `test:e2e` rebuilds for the Electron ABI.)

- [ ] **Step 5: Commit**
```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/test/e2e/sidebar.spec.ts electron/test/e2e/persistence.spec.ts
git commit -m "test(sidebar): e2e content-inset round-trip + persistence relaunch (Phase-3 exit)"
```

---

#### New names introduced (Block E)

- `electron/test/e2e/favorites.spec.ts` (new e2e spec; local helpers: `launchApp`, `state`, `navigate`, `favAdd`, `favList`, `favTagUnion`, `favRenameTag`, `favDeleteTag`)
- `electron/test/e2e/history.spec.ts` (new e2e spec; local helpers: `launchApp`, `state`, `navigate`, `navigateAndSettle`, `historyList`, `historySearch`, `historyMostRecent`, `historyRemove`, `historyClear`, `waitForEntry`)
- `electron/test/e2e/saved.spec.ts` (new e2e spec; local helpers: `launchApp`, `savedAdd`, `savedList`, `savedHas`, `savedRemove`)
- `electron/test/e2e/sidebar.spec.ts` (new e2e spec; local constants `TOOLBAR_H`/`FAVBAR_H`/`SIDEBAR_W`/`TOP_INSET`; local helpers: `launchApp`, `contentBounds`, `setContentInset`; local interface `Bounds`)
- `electron/test/e2e/persistence.spec.ts` (new e2e spec; local helpers: `launchApp`, `favAdd`, `favList`, `savedAdd`, `savedList`, `navigate`, `historyList`)

No new exported production symbols — Block E adds only e2e spec files (with file-local test helpers); it consumes the `__aegisTest.places = { favoritesRepo, historyRepo, savedRepo, setContentInset }` registry from Task 10 (§8.1) and `view.getBounds()`/`primary.navigate`/`primary.getState`/`primary.reloadOrStop` from the as-built ViewController.
