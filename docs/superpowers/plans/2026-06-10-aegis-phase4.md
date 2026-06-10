# Aegis Phase 4 — Settings · Filter-List Manager · My-Filters · Allowlist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Cross-module names/signatures are pinned by the
> contract `docs/superpowers/plans/2026-06-10-aegis-phase4-contract.md`; the spec is
> `docs/superpowers/specs/2026-06-10-aegis-phase4-design.md`.

**Goal:** Make Aegis fully configurable without code — a tabbed Settings modal, a functional filter-list manager
(toggle + add/remove custom URLs, closing the `runRefresh`→`SubsRepo` wiring gap), a my-filters custom-rules box
(network + cosmetic, merged into the `@ghostery` engine rebuild), and allowlist management.

**Architecture:** New main-side `CustomFiltersRepo` + `SubsRepo`/`AdblockController` methods + sender-guarded IPC;
two engine-rebuild paths (`runRefresh` fetch-rebuild reading `subsRepo.all()` enabled + appending custom filters;
`rebuildEngineFromCache` for toggle/remove/customFilters with no re-fetch); a Settings modal (`useDialog` +
tablist) mounted via a `settingsOpen` gate + a Toolbar gear slot; new renderer hooks. Engine rebuilds apply on
the next navigation. Local commits only on branch `phase-4`.

**Tech Stack:** Electron 42 · `@ghostery/adblocker-electron` 2.18.0 · better-sqlite3 · React 19 + TS ·
electron-vite · Vitest 4 (node + jsdom) · Playwright `_electron`. Dual-ABI: DB unit tests → `npm run
rebuild:node && npx vitest run <f>`; pure tests → `npx vitest run <f>`; e2e → `npm run rebuild:electron && npm
run build && npx playwright test <f>`.

---

## Review-driven corrections (AUTHORITATIVE — apply these during execution; they override any conflicting task text below)

The plan passed adversarial review **APPROVE WITH CHANGES**. Apply these before/while executing:

1. **`__aegisTest.phase4` registry is defined ONCE, in Task 9 (boot wiring).** Its final shape is:
   `phase4: { settingsRepo, subsRepo, customFiltersRepo, rebuildFromCache: rebuildEngineFromCache, updateNow,
   navHome: () => vc.navigate(settingsRepo.get().homeUrl) }` — the registry KEY is `rebuildFromCache` (aliasing
   the boot-local `rebuildEngineFromCache` function), and `navHome` is included here. **Task 23 must NOT re-edit
   `electron/main/index.ts`** — it only CONSUMES `__aegisTest.phase4.{settingsRepo,subsRepo,customFiltersRepo,
   rebuildFromCache,updateNow,navHome}`. Tasks 24/25 already use `rebuildFromCache`. (Block-B/E footers reflect
   this single name.)

2. **Task 25 network my-filter test:** the fixture `easylist.txt` does NOT block `banner.js`, so on the baseline
   nav `banner.js` runs and sets `window.__adLoaded = true`. DROP the stray first
   `expect(adLoaded(...)).toBe(false)` baseline + its confused comments. Assert: baseline nav → `__adLoaded ===
   true`; then set the custom rule `/ads/banner.js^` + `rebuildFromCache` + nav → `__adLoaded === false`. (If
   `banner.js` does not already set `window.__adLoaded = true`, add that one line to the fixture in this task.)

3. **Task 23 homeUrl test:** remove the dead `app.evaluate(() => { reg.adblock.controller; reg.primary.view.
   webContents.send; /* no-op guard */ })` block — it asserts nothing.

**Accepted (non-blocking) limitations — documented, not defects:**
- **Default-search-engine switch (spec §11.3):** `SearchTab` "set default" persists `defaultSearchTemplate`
  (the mechanism). `useNav` reads `defaultSearchTemplate` on mount, so a changed default drives the address bar
  on next mount/launch (no live refresh this phase). Proven at the write-path/unit level.
- **Allowlist reconcile (spec §11.8):** `removeAllowlist`/`clearAllowlist` defer re-blocking to the next-nav
  `reconcile` (the existing Phase-1 mechanism), unit-proven in Task 4; the e2e asserts the returned
  `AdblockState`. No new reconcile logic.
- **Scriptlet my-filters:** the cache-rebuild path passes `resources=null`, so `##+js(...)` user rules resolve
  only after a full `updateNow` (which loads resources). No scriptlet my-filter is promised/tested this phase.

---

All facts verified. `listIdFromUrl` is private to engine.ts with no external usages, `Subscription` is only defined in subsRepo.ts, and there's no existing customFilters code. I have everything needed to write the four tasks.

### Task 1: shared/types — new IPC channels, AegisApi additions, re-export Subscription

**Files:**
- Modify: `shared/types.ts:7-48` (extend the `IPC` const), `shared/types.ts:119-187` (re-export `Subscription`, extend `AegisApi`)
- Test: `shared/types.test.ts`

- [ ] **Step 1: Write the failing test**

Append this block to the end of `shared/types.test.ts` (after the closing `});` of the Phase-3 describe at line 96):

```ts

describe('shared/types — Phase 4 additions', () => {
  it('exposes the subscriptions IPC channel constants', () => {
    expect(IPC.subsList).toBe('subs.list');
    expect(IPC.subsSetEnabled).toBe('subs.setEnabled');
    expect(IPC.subsAdd).toBe('subs.add');
    expect(IPC.subsRemove).toBe('subs.remove');
  });

  it('exposes the custom-filters IPC channel constants', () => {
    expect(IPC.customFiltersGet).toBe('customFilters.get');
    expect(IPC.customFiltersSet).toBe('customFilters.set');
  });

  it('exposes the allowlist remove/clear IPC channel constants', () => {
    expect(IPC.adblockRemoveAllowlist).toBe('adblock.removeAllowlist');
    expect(IPC.adblockClearAllowlist).toBe('adblock.clearAllowlist');
  });

  it('re-exports the Subscription shape', () => {
    const sub: Subscription = {
      listId: 'easylist',
      url: 'https://example.test/easylist.txt',
      enabled: true,
      lastUpdated: 123,
      etag: null,
      hash: 'abc',
    };
    expect(sub.listId).toBe('easylist');
    expect(sub.enabled).toBe(true);
  });

  it('types the Phase-4 AegisApi members (compile-only shape check)', () => {
    type SubsApi = AegisApi['subs'];
    type CustomFiltersApi = AegisApi['customFilters'];
    const subsShape: Record<keyof SubsApi, true> = {
      list: true,
      setEnabled: true,
      add: true,
      remove: true,
    };
    const cfShape: Record<keyof CustomFiltersApi, true> = { get: true, set: true };
    expect(Object.keys(subsShape).sort()).toEqual(['add', 'list', 'remove', 'setEnabled']);
    expect(Object.keys(cfShape).sort()).toEqual(['get', 'set']);
  });
});
```

Also extend the existing top import of types in `shared/types.test.ts` (lines 3-12) to bring in the new types. Replace:

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

with:

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
  Subscription,
  AegisApi,
} from './types';
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run shared/types.test.ts`
Expected: FAIL — TypeScript/runtime errors: `Property 'subsList' does not exist on type` (the `IPC` const) and `Module '"./types"' has no exported member 'Subscription'` / `'AegisApi'` is exported but `subs`/`customFilters` members are missing.

- [ ] **Step 3: Implement**

In `shared/types.ts`, extend the `IPC` const. Replace the events block at the end of the const (lines 42-48):

```ts
  // events (main -> chrome renderer)
  evtNavState: 'nav.state',
  evtNavFailed: 'nav.failed',
  evtNavCrashed: 'nav.crashed',
  evtAdblockBlockedCount: 'adblock.blockedCount',
  evtHistoryChanged: 'history.changed',
} as const;
```

with:

```ts
  // subscriptions (chrome -> main, Phase 4)
  subsList: 'subs.list',
  subsSetEnabled: 'subs.setEnabled',
  subsAdd: 'subs.add',
  subsRemove: 'subs.remove',
  // custom filters (chrome -> main, Phase 4)
  customFiltersGet: 'customFilters.get',
  customFiltersSet: 'customFilters.set',
  // allowlist management (chrome -> main, Phase 4)
  adblockRemoveAllowlist: 'adblock.removeAllowlist',
  adblockClearAllowlist: 'adblock.clearAllowlist',
  // events (main -> chrome renderer)
  evtNavState: 'nav.state',
  evtNavFailed: 'nav.failed',
  evtNavCrashed: 'nav.crashed',
  evtAdblockBlockedCount: 'adblock.blockedCount',
  evtHistoryChanged: 'history.changed',
} as const;
```

Re-export `Subscription` from `shared/types.ts`. Insert this block immediately before the `SearchEngine` interface (before line 119 `export interface SearchEngine`):

```ts
/**
 * One filter-list subscription row. Canonical shape lives in
 * `electron/main/db/subsRepo.ts`; re-declared here so the preload + renderer can
 * type the `subs.*` IPC surface without importing main-process modules.
 */
export interface Subscription {
  listId: string;
  url: string;
  enabled: boolean;
  lastUpdated: number | null;
  etag: string | null;
  hash: string | null;
}

```

Extend `AegisApi`. Replace the `lists` member block at the end of `AegisApi` (lines 184-187):

```ts
  lists: {
    updateNow(): Promise<ListUpdateResult>;
  };
}
```

with:

```ts
  lists: {
    updateNow(): Promise<ListUpdateResult>;
  };
  subs: {
    list(): Promise<Subscription[]>;
    setEnabled(listId: string, enabled: boolean): Promise<Subscription[]>;
    add(url: string): Promise<Subscription[]>;
    remove(listId: string): Promise<Subscription[]>;
  };
  customFilters: {
    get(): Promise<string>;
    set(text: string): Promise<string>;
  };
}
```

Add the two allowlist methods to the `adblock` member. Replace (lines 178-183):

```ts
  adblock: {
    setEnabled(enabled: boolean): Promise<AdblockState>;
    toggleAllowlist(host: string): Promise<AdblockState>;
    getState(): Promise<AdblockState>;
    onBlockedCount(cb: (c: BlockedCount) => void): () => void;
  };
```

with:

```ts
  adblock: {
    setEnabled(enabled: boolean): Promise<AdblockState>;
    toggleAllowlist(host: string): Promise<AdblockState>;
    removeAllowlist(host: string): Promise<AdblockState>;
    clearAllowlist(): Promise<AdblockState>;
    getState(): Promise<AdblockState>;
    onBlockedCount(cb: (c: BlockedCount) => void): () => void;
  };
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run shared/types.test.ts`
Expected: PASS (all describe blocks, including the new "Phase 4 additions").

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts shared/types.test.ts
git commit -m "feat(types): add Phase-4 IPC channels, AegisApi subs/customFilters/allowlist, re-export Subscription"
```

---

### Task 2: SubsRepo.setEnabled/add/remove + export listIdFromUrl

**Files:**
- Modify: `electron/main/adblock/engine.ts:18-21` (export `listIdFromUrl`)
- Modify: `electron/main/db/subsRepo.ts:19-34` (add prepared statements), `:36-72` (add `setEnabled`/`add`/`remove`)
- Test: `electron/main/db/subsRepo.test.ts`

- [ ] **Step 1: Write the failing test**

Add the import of `listIdFromUrl` and three new `describe` blocks to `electron/main/db/subsRepo.test.ts`. First extend the imports at the top (replace lines 1-4):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { SubsRepo } from './subsRepo';
import { listIdFromUrl } from '../adblock/engine';
```

Then append these describe blocks just before the final closing `});` of the top-level `describe('subsRepo', …)` (i.e. after the `updateMeta` block, before line 79's closing brace):

```ts

  describe('setEnabled', () => {
    it('flips a list enabled flag, reflected by all()', () => {
      repo.seedDefaults(DEFAULTS);
      repo.setEnabled('easylist', false);
      const easylist = repo.all().find((s) => s.listId === 'easylist')!;
      expect(easylist.enabled).toBe(false);
      repo.setEnabled('easylist', true);
      expect(repo.all().find((s) => s.listId === 'easylist')!.enabled).toBe(true);
    });

    it('leaves other lists untouched', () => {
      repo.seedDefaults(DEFAULTS);
      repo.setEnabled('easylist', false);
      const ep = repo.all().find((s) => s.listId === 'easyprivacy')!;
      expect(ep.enabled).toBe(true);
    });

    it('persists across repo instances on the same db', () => {
      repo.seedDefaults(DEFAULTS);
      repo.setEnabled('easylist', false);
      const repo2 = new SubsRepo(db);
      expect(repo2.all().find((s) => s.listId === 'easylist')!.enabled).toBe(false);
    });
  });

  describe('add', () => {
    it('inserts a custom list (enabled, listId derived from url) and returns all()', () => {
      const all = repo.add('https://lists.test/my-custom-list.txt');
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual({
        listId: 'my-custom-list',
        url: 'https://lists.test/my-custom-list.txt',
        enabled: true,
        lastUpdated: null,
        etag: null,
        hash: null,
      });
      expect(all[0].listId).toBe(listIdFromUrl('https://lists.test/my-custom-list.txt'));
    });

    it('is INSERT OR IGNORE on duplicate listId (no clobber of metadata)', () => {
      repo.add('https://lists.test/dup.txt');
      repo.updateMeta('dup', { lastUpdated: 99, etag: 'e', hash: 'h' });
      const all = repo.add('https://lists.test/dup.txt'); // same derived listId
      expect(all).toHaveLength(1);
      expect(all[0].lastUpdated).toBe(99);
      expect(all[0].hash).toBe('h');
    });
  });

  describe('remove', () => {
    it('deletes a list by listId and returns all()', () => {
      repo.seedDefaults(DEFAULTS);
      const all = repo.remove('easylist');
      expect(all).toHaveLength(1);
      expect(all.map((s) => s.listId)).toEqual(['easyprivacy']);
    });

    it('removing an unknown listId is a no-op', () => {
      repo.seedDefaults(DEFAULTS);
      const all = repo.remove('does-not-exist');
      expect(all).toHaveLength(2);
    });
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/subsRepo.test.ts`
Expected: FAIL — `Module '"../adblock/engine"' has no exported member 'listIdFromUrl'` and `repo.setEnabled is not a function` / `repo.add is not a function` / `repo.remove is not a function`.

- [ ] **Step 3: Implement**

First, export `listIdFromUrl` from `engine.ts`. In `electron/main/adblock/engine.ts`, replace lines 13-21:

```ts
/**
 * Derive a stable, persistable list id from a default source URL. The id is the
 * filename (sans extension), used as the PK in `filter_subscriptions` and as the
 * per-list raw-cache filename.
 */
function listIdFromUrl(url: string): string {
  const last = url.split('/').filter(Boolean).pop() ?? url;
  return last.replace(/\.txt$/i, '');
}
```

with (only `function` → `export function`):

```ts
/**
 * Derive a stable, persistable list id from a source URL. The id is the
 * filename (sans extension), used as the PK in `filter_subscriptions` and as the
 * per-list raw-cache filename. Exported for the subscriptions repo (custom adds).
 */
export function listIdFromUrl(url: string): string {
  const last = url.split('/').filter(Boolean).pop() ?? url;
  return last.replace(/\.txt$/i, '');
}
```

Now extend `SubsRepo`. In `electron/main/db/subsRepo.ts`, replace the import + prepared-statement declarations + constructor (lines 1-34):

```ts
// electron/main/db/subsRepo.ts
import type Database from 'better-sqlite3';

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
```

Then add the three methods. Import `listIdFromUrl` at the top of `subsRepo.ts` — replace the first two lines:

```ts
// electron/main/db/subsRepo.ts
import type Database from 'better-sqlite3';
```

with:

```ts
// electron/main/db/subsRepo.ts
import type Database from 'better-sqlite3';
import { listIdFromUrl } from '../adblock/engine';
```

And add the new methods immediately before the closing brace of the class (after `updateMeta`, currently lines 64-72 / before the final `}`):

```ts

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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/subsRepo.test.ts`
Expected: PASS (original 6 tests plus the new setEnabled/add/remove tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/engine.ts electron/main/db/subsRepo.ts electron/main/db/subsRepo.test.ts
git commit -m "feat(subs): add SubsRepo.setEnabled/add/remove and export listIdFromUrl"
```

---

### Task 3: CustomFiltersRepo + custom_filters migration

**Files:**
- Create: `electron/main/db/customFiltersRepo.ts`
- Modify: `electron/main/db/sqlite.ts:20-65` (append the `custom_filters` table)
- Test: `electron/main/db/customFiltersRepo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/main/db/customFiltersRepo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { CustomFiltersRepo } from './customFiltersRepo';

describe('customFiltersRepo', () => {
  let db: Database.Database;
  let repo: CustomFiltersRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new CustomFiltersRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('get', () => {
    it('defaults to an empty string (seeded singleton row)', () => {
      expect(repo.get()).toBe('');
    });
  });

  describe('set', () => {
    it('persists the text and reads it back via get()', () => {
      repo.set('||ads.example^\nexample.com##.banner');
      expect(repo.get()).toBe('||ads.example^\nexample.com##.banner');
    });

    it('overwrites the previous value (singleton, never appends)', () => {
      repo.set('first');
      repo.set('second');
      expect(repo.get()).toBe('second');
    });

    it('round-trips an empty string', () => {
      repo.set('something');
      repo.set('');
      expect(repo.get()).toBe('');
    });

    it('persists across repo instances on the same db', () => {
      repo.set('||tracker.test^');
      const repo2 = new CustomFiltersRepo(db);
      expect(repo2.get()).toBe('||tracker.test^');
    });
  });

  describe('migration', () => {
    it('is idempotent: runMigrations again keeps the stored text', () => {
      repo.set('||keep.me^');
      runMigrations(db); // INSERT OR IGNORE must not reset
      expect(new CustomFiltersRepo(db).get()).toBe('||keep.me^');
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/customFiltersRepo.test.ts`
Expected: FAIL — `Cannot find module './customFiltersRepo'` (the file does not exist yet).

- [ ] **Step 3: Implement**

Append the `custom_filters` table to `runMigrations` in `electron/main/db/sqlite.ts`. Replace the `saved_list` block + closing of the `db.exec` template (lines 58-64):

```ts
    CREATE TABLE IF NOT EXISTS saved_list (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      url     TEXT    NOT NULL,
      title   TEXT    NOT NULL DEFAULT '',
      savedAt INTEGER NOT NULL
    );
  `);
```

with:

```ts
    CREATE TABLE IF NOT EXISTS saved_list (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      url     TEXT    NOT NULL,
      title   TEXT    NOT NULL DEFAULT '',
      savedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS custom_filters (
      id   INTEGER PRIMARY KEY CHECK (id = 1),
      text TEXT    NOT NULL DEFAULT ''
    );
    INSERT OR IGNORE INTO custom_filters (id, text) VALUES (1, '');
  `);
```

Create `electron/main/db/customFiltersRepo.ts`:

```ts
// electron/main/db/customFiltersRepo.ts
import type Database from 'better-sqlite3';

/**
 * Reads/writes the `custom_filters` singleton (row id = 1, seeded by
 * runMigrations): the user's my-filters blob (uBlock-syntax network + cosmetic
 * rules) stored as a single text value. Mirrors the adblock_config singleton
 * pattern so callers never reason about ids.
 */
export class CustomFiltersRepo {
  private readonly selectText: Database.Statement;
  private readonly setTextStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectText = db.prepare('SELECT text FROM custom_filters WHERE id = 1');
    this.setTextStmt = db.prepare('UPDATE custom_filters SET text = @text WHERE id = 1');
  }

  /** The stored my-filters text. Empty string when unset (seeded default). */
  get(): string {
    const row = this.selectText.get() as { text: string } | undefined;
    return row?.text ?? '';
  }

  /** Persist the my-filters text (overwrites; the store is a singleton). */
  set(text: string): void {
    this.setTextStmt.run({ text });
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/customFiltersRepo.test.ts`
Expected: PASS (get default, set/get round-trip, overwrite, empty, cross-instance, idempotent migration).

- [ ] **Step 5: Commit**

```bash
git add electron/main/db/customFiltersRepo.ts electron/main/db/customFiltersRepo.test.ts electron/main/db/sqlite.ts
git commit -m "feat(db): add CustomFiltersRepo and custom_filters singleton migration"
```

---

### Task 4: AdblockRepo.removeAllowlist/clearAllowlist + AdblockController.removeAllowlist/clearAllowlist

**Files:**
- Modify: `electron/main/db/adblockRepo.ts:46-54` (add `removeAllowlist`/`clearAllowlist`)
- Modify: `electron/main/adblock/controller.ts:58-66` (add `removeAllowlist`/`clearAllowlist`)
- Test: `electron/main/db/adblockRepo.test.ts`, `electron/main/adblock/controller.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `electron/main/db/adblockRepo.test.ts` — append these describe blocks immediately before the final closing `});` of the top-level `describe('adblockRepo', …)` (after the `isAllowlisted` block, before line 70):

```ts

  describe('removeAllowlist', () => {
    it('removes a single host, returning the new allowlist', () => {
      repo.toggleAllowlist('a.com');
      repo.toggleAllowlist('b.com');
      const next = repo.removeAllowlist('a.com');
      expect(next).toEqual(['b.com']);
      expect(repo.getState().allowlistedHosts).toEqual(['b.com']);
    });

    it('removing an absent host is a no-op', () => {
      repo.toggleAllowlist('a.com');
      const next = repo.removeAllowlist('not-there.com');
      expect(next).toEqual(['a.com']);
    });

    it('persists across repo instances on the same db', () => {
      repo.toggleAllowlist('a.com');
      repo.toggleAllowlist('b.com');
      repo.removeAllowlist('a.com');
      const repo2 = new AdblockRepo(db);
      expect(repo2.getState().allowlistedHosts).toEqual(['b.com']);
    });
  });

  describe('clearAllowlist', () => {
    it('empties the allowlist, returning []', () => {
      repo.toggleAllowlist('a.com');
      repo.toggleAllowlist('b.com');
      const next = repo.clearAllowlist();
      expect(next).toEqual([]);
      expect(repo.getState().allowlistedHosts).toEqual([]);
    });

    it('clearing an already-empty allowlist is a no-op', () => {
      const next = repo.clearAllowlist();
      expect(next).toEqual([]);
    });
  });
```

Add to `electron/main/adblock/controller.test.ts` — first extend the `makeRepo` fake so the controller's delegation can resolve. Replace the `makeRepo` factory (lines 61-75):

```ts
function makeRepo(initial: { enabled: boolean; allowlistedHosts: string[] }) {
  let enabled = initial.enabled;
  let hosts = [...initial.allowlistedHosts];
  return {
    getState: vi.fn(() => ({ enabled, allowlistedHosts: [...hosts] })),
    setEnabled: vi.fn((e: boolean) => {
      enabled = e;
    }),
    isAllowlisted: vi.fn((host: string) => hosts.includes(host)),
    toggleAllowlist: vi.fn((host: string) => {
      hosts = hosts.includes(host) ? hosts.filter((h) => h !== host) : [...hosts, host];
      return [...hosts];
    }),
  };
}
```

with:

```ts
function makeRepo(initial: { enabled: boolean; allowlistedHosts: string[] }) {
  let enabled = initial.enabled;
  let hosts = [...initial.allowlistedHosts];
  return {
    getState: vi.fn(() => ({ enabled, allowlistedHosts: [...hosts] })),
    setEnabled: vi.fn((e: boolean) => {
      enabled = e;
    }),
    isAllowlisted: vi.fn((host: string) => hosts.includes(host)),
    toggleAllowlist: vi.fn((host: string) => {
      hosts = hosts.includes(host) ? hosts.filter((h) => h !== host) : [...hosts, host];
      return [...hosts];
    }),
    removeAllowlist: vi.fn((host: string) => {
      hosts = hosts.filter((h) => h !== host);
      return [...hosts];
    }),
    clearAllowlist: vi.fn(() => {
      hosts = [];
      return [...hosts];
    }),
  };
}
```

Then append this describe block to the end of `controller.test.ts` (after the final closing `});` of the "engine swap" describe at line 289):

```ts

describe('AdblockController removeAllowlist / clearAllowlist (deferred reconcile)', () => {
  it('removeAllowlist persists via repo and returns the new AdblockState', () => {
    const counter = makeCounter({ session: 4 });
    const { controller, repo } = build({
      counter,
      repo: makeRepo({ enabled: true, allowlistedHosts: ['a.com', 'b.com'] }),
    });
    const state = controller.removeAllowlist('a.com');
    expect(repo.removeAllowlist).toHaveBeenCalledWith('a.com');
    expect(state).toEqual({ enabled: true, allowlistedHosts: ['b.com'], sessionBlocked: 4 });
  });

  it('clearAllowlist persists via repo and returns the new AdblockState', () => {
    const counter = makeCounter({ session: 6 });
    const { controller, repo } = build({
      counter,
      repo: makeRepo({ enabled: true, allowlistedHosts: ['a.com', 'b.com'] }),
    });
    const state = controller.clearAllowlist();
    expect(repo.clearAllowlist).toHaveBeenCalled();
    expect(state).toEqual({ enabled: true, allowlistedHosts: [], sessionBlocked: 6 });
  });

  it('removeAllowlist does NOT change session blocking until the next navigation', () => {
    const { controller, blocker, session } = build({
      repo: makeRepo({ enabled: true, allowlistedHosts: ['example.com'] }),
    });
    controller.primeFor('https://example.com/'); // allowlisted => blocking stays OFF
    expect(blocker.isBlockingEnabled(session)).toBe(false);
    controller.removeAllowlist('example.com'); // persisted, not reconciled directly
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(false);
    // next nav to the now-un-allowlisted host re-enables blocking
    (controller as any).reconcile('https://example.com/');
    expect(blocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(blocker.isBlockingEnabled(session)).toBe(true);
  });

  it('clearAllowlist does NOT change session blocking until the next navigation', () => {
    const { controller, blocker, session } = build({
      repo: makeRepo({ enabled: true, allowlistedHosts: ['example.com'] }),
    });
    controller.primeFor('https://example.com/'); // allowlisted => blocking OFF
    expect(blocker.isBlockingEnabled(session)).toBe(false);
    controller.clearAllowlist();
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(false);
    (controller as any).reconcile('https://example.com/');
    expect(blocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(blocker.isBlockingEnabled(session)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/adblockRepo.test.ts electron/main/adblock/controller.test.ts`
Expected: FAIL — `repo.removeAllowlist is not a function` / `repo.clearAllowlist is not a function` (adblockRepo) and `controller.removeAllowlist is not a function` / `controller.clearAllowlist is not a function` (controller).

- [ ] **Step 3: Implement**

Add the two repo methods. In `electron/main/db/adblockRepo.ts`, replace the `toggleAllowlist` method + class close (lines 46-55):

```ts
  /** Add `host` if absent, else remove it. Returns the new allowlist. */
  toggleAllowlist(host: string): string[] {
    const current = this.getState().allowlistedHosts;
    const next = current.includes(host)
      ? current.filter((h) => h !== host)
      : [...current, host];
    this.setAllowlistStmt.run({ allowlist: JSON.stringify(next) });
    return next;
  }
}
```

with:

```ts
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
```

Add the two controller methods. In `electron/main/adblock/controller.ts`, replace the `toggleAllowlist` method (lines 58-61):

```ts
  toggleAllowlist(host: string): AdblockState {
    this.opts.repo.toggleAllowlist(host);
    return this.getState();
  }
```

with:

```ts
  toggleAllowlist(host: string): AdblockState {
    this.opts.repo.toggleAllowlist(host);
    return this.getState();
  }

  /**
   * Remove `host` from the allowlist (DB-only). Re-blocking on `host` is deferred
   * to the next main-frame navigation's reconcile, consistent with toggleAllowlist.
   */
  removeAllowlist(host: string): AdblockState {
    this.opts.repo.removeAllowlist(host);
    return this.getState();
  }

  /**
   * Clear the entire allowlist (DB-only). Re-blocking on previously-allowlisted
   * hosts is deferred to their next navigation's reconcile (no direct reconcile).
   */
  clearAllowlist(): AdblockState {
    this.opts.repo.clearAllowlist();
    return this.getState();
  }
```

This requires `AdblockRepo` to expose `removeAllowlist`/`clearAllowlist` to type-check against `this.opts.repo` — already added above. The controller's `opts.repo` is typed `AdblockRepo`, so the new repo methods are visible.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/adblockRepo.test.ts electron/main/adblock/controller.test.ts`
Expected: PASS — adblockRepo (original getState/setEnabled/toggle/isAllowlisted plus removeAllowlist/clearAllowlist) and controller (all original tests plus the four deferred-reconcile tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/db/adblockRepo.ts electron/main/db/adblockRepo.test.ts electron/main/adblock/controller.ts electron/main/adblock/controller.test.ts
git commit -m "feat(adblock): add removeAllowlist/clearAllowlist on AdblockRepo and Controller (deferred reconcile)"
```

---

#### New names introduced (Block A)

- `IPC.subsList` (`'subs.list'`), `IPC.subsSetEnabled` (`'subs.setEnabled'`), `IPC.subsAdd` (`'subs.add'`), `IPC.subsRemove` (`'subs.remove'`) — shared/types.ts
- `IPC.customFiltersGet` (`'customFilters.get'`), `IPC.customFiltersSet` (`'customFilters.set'`) — shared/types.ts
- `IPC.adblockRemoveAllowlist` (`'adblock.removeAllowlist'`), `IPC.adblockClearAllowlist` (`'adblock.clearAllowlist'`) — shared/types.ts
- `Subscription` (re-exported interface) — shared/types.ts
- `AegisApi.subs` (`list`/`setEnabled`/`add`/`remove`), `AegisApi.customFilters` (`get`/`set`), `AegisApi.adblock.removeAllowlist`, `AegisApi.adblock.clearAllowlist` — shared/types.ts (members on the existing `AegisApi` interface)
- `listIdFromUrl` (now `export`) — electron/main/adblock/engine.ts
- `SubsRepo.setEnabled(listId, enabled)`, `SubsRepo.add(url)`, `SubsRepo.remove(listId)` — electron/main/db/subsRepo.ts
- `CustomFiltersRepo` (class with `get()` / `set(text)`) — electron/main/db/customFiltersRepo.ts (new file)
- `custom_filters` table (singleton, in `runMigrations`) — electron/main/db/sqlite.ts
- `AdblockRepo.removeAllowlist(host)`, `AdblockRepo.clearAllowlist()` — electron/main/db/adblockRepo.ts
- `AdblockController.removeAllowlist(host)`, `AdblockController.clearAllowlist()` — electron/main/adblock/controller.ts

I have all verified facts. Note Block B depends on Block A names (Task 1: IPC channels + AegisApi additions + re-exported `Subscription`; Task 2: `SubsRepo.setEnabled/add/remove` + exported `listIdFromUrl`; Task 3: `CustomFiltersRepo`; Task 4: `AdblockRepo.removeAllowlist/clearAllowlist` + `AdblockController.removeAllowlist/clearAllowlist`). These are produced by Block A drafters; I reference them by their pinned §3/§4 names. Now I'll write Tasks 5-10.

### Task 5: Extract pure refresh helpers (`resolveRefreshSubs` + enabled-texts assembly)

**Files:**
- Create: `electron/main/adblock/refreshHelpers.ts`
- Test: `electron/main/adblock/refreshHelpers.test.ts`

These are pure functions (no I/O, no engine, no DB) so they run under the plain `npx vitest run` ABI-free path. They capture the two mechanics §2.1 needs from both rebuild paths: the LIST_BASE per-row URL rewrite (used by `runRefresh`'s fetch list) and the engine-texts assembly that appends the custom-filters blob (used by BOTH `runRefresh` and `rebuildEngineFromCache`). `buildEngine` itself stays UNCHANGED — the merge is at the call site via these helpers.

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/adblock/refreshHelpers.test.ts
import { describe, it, expect } from 'vitest';
import type { Subscription } from '../../../shared/types';
import { resolveRefreshSubs, assembleEngineTexts } from './refreshHelpers';

function sub(partial: Partial<Subscription> & { listId: string; url: string }): Subscription {
  return {
    enabled: true,
    lastUpdated: null,
    etag: null,
    hash: null,
    ...partial,
  };
}

describe('resolveRefreshSubs', () => {
  it('keeps only enabled rows, mapped to {listId, url}', () => {
    const rows: Subscription[] = [
      sub({ listId: 'easylist', url: 'https://e.test/easylist.txt', enabled: true }),
      sub({ listId: 'easyprivacy', url: 'https://e.test/easyprivacy.txt', enabled: false }),
      sub({ listId: 'peter-lowe', url: 'https://e.test/peter-lowe.txt', enabled: true }),
    ];
    expect(resolveRefreshSubs(rows, undefined)).toEqual([
      { listId: 'easylist', url: 'https://e.test/easylist.txt' },
      { listId: 'peter-lowe', url: 'https://e.test/peter-lowe.txt' },
    ]);
  });

  it('rewrites each enabled row url to `${listBase}/${listId}.txt` when listBase is set', () => {
    const rows: Subscription[] = [
      sub({ listId: 'easylist', url: 'https://real.example/easylist.txt', enabled: true }),
      sub({ listId: 'off', url: 'https://real.example/off.txt', enabled: false }),
    ];
    expect(resolveRefreshSubs(rows, 'http://127.0.0.1:5055/lists')).toEqual([
      { listId: 'easylist', url: 'http://127.0.0.1:5055/lists/easylist.txt' },
    ]);
  });

  it('returns an empty array when no rows are enabled', () => {
    const rows: Subscription[] = [
      sub({ listId: 'a', url: 'https://e.test/a.txt', enabled: false }),
    ];
    expect(resolveRefreshSubs(rows, undefined)).toEqual([]);
  });
});

describe('assembleEngineTexts', () => {
  it('appends the custom-filters blob after the list texts', () => {
    expect(assembleEngineTexts(['||a.test^', '||b.test^'], 'x.com##.ad')).toEqual([
      '||a.test^',
      '||b.test^',
      'x.com##.ad',
    ]);
  });

  it('omits the custom-filters element when the blob is empty or whitespace-only', () => {
    expect(assembleEngineTexts(['||a.test^'], '')).toEqual(['||a.test^']);
    expect(assembleEngineTexts(['||a.test^'], '   \n  ')).toEqual(['||a.test^']);
  });

  it('includes a non-empty custom blob even when there are no list texts', () => {
    expect(assembleEngineTexts([], 'x.com##.ad')).toEqual(['x.com##.ad']);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/adblock/refreshHelpers.test.ts`
Expected: FAIL with `Failed to resolve import "./refreshHelpers"` (the module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/adblock/refreshHelpers.ts
import type { Subscription } from '../../../shared/types';

/**
 * Resolve the enabled subscription rows into the `{ listId, url }` source list that
 * `fetchAll` consumes. Only `enabled` rows are kept (this is what finally READS the
 * `filter_subscriptions.enabled` column — the wiring gap). When `listBase` is set
 * (e2e fixture override, from AEGIS_ADBLOCK_LIST_BASE) each row's url is rewritten
 * to `${listBase}/${listId}.txt` so refreshes hit the local fixture deterministically.
 */
export function resolveRefreshSubs(
  rows: Subscription[],
  listBase: string | undefined,
): { listId: string; url: string }[] {
  return rows
    .filter((r) => r.enabled)
    .map((r) => ({
      listId: r.listId,
      url: listBase ? `${listBase}/${r.listId}.txt` : r.url,
    }));
}

/**
 * Assemble the text blobs passed to `buildEngine` for BOTH rebuild paths: the
 * enabled list texts (fetched, or read from cache) followed by the user's
 * custom-filters blob. The custom element is appended only when it has
 * non-whitespace content, so an empty my-filters store adds nothing. `buildEngine`
 * itself is unchanged — the my-filters merge happens here, at the call site, by
 * concatenation (verified merge mechanism, contract §1.3).
 */
export function assembleEngineTexts(listTexts: string[], customFilters: string): string[] {
  return customFilters.trim().length > 0 ? [...listTexts, customFilters] : [...listTexts];
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/adblock/refreshHelpers.test.ts`
Expected: PASS (all 6 cases green).

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/refreshHelpers.ts electron/main/adblock/refreshHelpers.test.ts
git commit -m "feat(adblock): pure refresh helpers (resolveRefreshSubs + assembleEngineTexts)"
```

---

### Task 6: `electron/main/ipc/subs.ts` — `buildSubsHandlers` (+ HTTPS validation on add)

**Files:**
- Create: `electron/main/ipc/subs.ts`
- Test: `electron/main/ipc/subs.test.ts`

Pure logic over a fake repo + spies; no DB, no Electron, so the plain `npx vitest run` path. Per §4 the handler returns `subsRepo.all()` for every mutation; the engine-affecting mutations call the injected `rebuildFromCache()` (toggle/remove — no re-fetch) or `refresh()` (add — a new list must be fetched). Per §6/T6, the add-URL HTTPS guard runs in the handler BEFORE insert, reusing the exact `listManager` predicate (rejects non-`https:` unless `http:` + loopback host) so a bad URL throws and never reaches the DB.

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/ipc/subs.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { Subscription } from '../../../shared/types';
import { buildSubsHandlers } from './subs';

function makeRepo(initial: Subscription[]) {
  let rows = [...initial];
  return {
    rows: () => rows,
    all: vi.fn((): Subscription[] => rows),
    setEnabled: vi.fn((listId: string, enabled: boolean): void => {
      rows = rows.map((r) => (r.listId === listId ? { ...r, enabled } : r));
    }),
    add: vi.fn((url: string): Subscription[] => {
      rows = [...rows, { listId: 'added', url, enabled: true, lastUpdated: null, etag: null, hash: null }];
      return rows;
    }),
    remove: vi.fn((listId: string): void => {
      rows = rows.filter((r) => r.listId !== listId);
    }),
  };
}

const base: Subscription[] = [
  { listId: 'easylist', url: 'https://e.test/easylist.txt', enabled: true, lastUpdated: null, etag: null, hash: null },
];

describe('buildSubsHandlers', () => {
  it('registers exactly the four subs channels', () => {
    const repo = makeRepo(base);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh: vi.fn(async () => undefined) });
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.subsList, IPC.subsSetEnabled, IPC.subsAdd, IPC.subsRemove].sort(),
    );
  });

  it('subsList returns subsRepo.all()', () => {
    const repo = makeRepo(base);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh: vi.fn(async () => undefined) });
    const out = handlers[IPC.subsList]();
    expect(repo.all).toHaveBeenCalledTimes(1);
    expect(out).toEqual(base);
  });

  it('subsSetEnabled mutates, rebuilds from cache, and returns all()', () => {
    const repo = makeRepo(base);
    const rebuildFromCache = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache, refresh });
    const out = handlers[IPC.subsSetEnabled]('easylist', false);
    expect(repo.setEnabled).toHaveBeenCalledWith('easylist', false);
    expect(rebuildFromCache).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(out[0].enabled).toBe(false);
  });

  it('subsAdd validates+inserts an HTTPS url, kicks a refresh (not rebuild), and returns all()', () => {
    const repo = makeRepo(base);
    const rebuildFromCache = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache, refresh });
    const out = handlers[IPC.subsAdd]('https://new.test/list.txt');
    expect(repo.add).toHaveBeenCalledWith('https://new.test/list.txt');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(rebuildFromCache).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
  });

  it('subsAdd accepts an http loopback url (matches the listManager guard)', () => {
    const repo = makeRepo(base);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh: vi.fn(async () => undefined) });
    expect(() => handlers[IPC.subsAdd]('http://127.0.0.1:5055/lists/x.txt')).not.toThrow();
    expect(repo.add).toHaveBeenCalledWith('http://127.0.0.1:5055/lists/x.txt');
  });

  it('subsAdd rejects a non-HTTPS (non-loopback) url BEFORE touching the repo', () => {
    const repo = makeRepo(base);
    const refresh = vi.fn(async () => undefined);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh });
    expect(() => handlers[IPC.subsAdd]('http://evil.test/list.txt')).toThrow(/non-HTTPS/i);
    expect(repo.add).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('subsAdd rejects an unparseable url BEFORE touching the repo', () => {
    const repo = makeRepo(base);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh: vi.fn(async () => undefined) });
    expect(() => handlers[IPC.subsAdd]('not a url')).toThrow();
    expect(repo.add).not.toHaveBeenCalled();
  });

  it('subsRemove deletes, rebuilds from cache, and returns all()', () => {
    const repo = makeRepo(base);
    const rebuildFromCache = vi.fn();
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache, refresh: vi.fn(async () => undefined) });
    const out = handlers[IPC.subsRemove]('easylist');
    expect(repo.remove).toHaveBeenCalledWith('easylist');
    expect(rebuildFromCache).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/ipc/subs.test.ts`
Expected: FAIL with `Failed to resolve import "./subs"` (the module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/ipc/subs.ts
import { IPC } from '../../../shared/types';
import type { Subscription } from '../../../shared/types';
import type { SubsRepo } from '../db/subsRepo';

/**
 * Reuse the listManager HTTPS guard predicate: a list URL must be `https:`, unless
 * it is `http:` to a loopback host (127.0.0.1 / localhost / ::1 / [::1]) — the e2e
 * fixture case. Throws on a disallowed or unparseable URL so a bad add rejects
 * BEFORE the row is inserted (contract §6 T6). Mirrors fetchSource (listManager.ts).
 */
function assertListUrlAllowed(url: string): void {
  const parsed = new URL(url);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`Refusing non-HTTPS list URL: ${url}`);
  }
}

/**
 * Builds the subscriptions IPC handler map (channel -> handler). Handlers receive
 * the invoke args WITHOUT the event (the guard strips it). Every handler returns
 * the updated Subscription[] so the renderer syncs from the result.
 *
 * Engine-affecting mutations rebuild the live engine on the NEXT navigation:
 *  - setEnabled / remove rebuild from the on-disk list cache (no re-fetch needed).
 *  - add kicks a full refresh() because the new list must be fetched first.
 */
export function buildSubsHandlers(
  subsRepo: SubsRepo,
  opts: { rebuildFromCache(): void; refresh(): Promise<unknown> },
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.subsList]: (): Subscription[] => subsRepo.all(),
    [IPC.subsSetEnabled]: (listId: string, enabled: boolean): Subscription[] => {
      subsRepo.setEnabled(listId, enabled);
      opts.rebuildFromCache();
      return subsRepo.all();
    },
    [IPC.subsAdd]: (url: string): Subscription[] => {
      assertListUrlAllowed(url);
      subsRepo.add(url);
      void opts.refresh();
      return subsRepo.all();
    },
    [IPC.subsRemove]: (listId: string): Subscription[] => {
      subsRepo.remove(listId);
      opts.rebuildFromCache();
      return subsRepo.all();
    },
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/ipc/subs.test.ts`
Expected: PASS (all 9 cases green).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/subs.ts electron/main/ipc/subs.test.ts
git commit -m "feat(ipc): buildSubsHandlers with add-URL HTTPS guard + rebuild/refresh wiring"
```

---

### Task 7: `electron/main/ipc/customFilters.ts` — `buildCustomFiltersHandlers`

**Files:**
- Create: `electron/main/ipc/customFilters.ts`
- Test: `electron/main/ipc/customFilters.test.ts`

Pure logic over a fake repo + spy; plain `npx vitest run`. Per §4 `customFiltersGet → repo.get()`; `customFiltersSet → repo.set(text); opts.rebuildFromCache(); return repo.get()` (returns the stored text — the rebuild folds the new blob in on the next nav via `assembleEngineTexts`).

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/ipc/customFilters.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import { buildCustomFiltersHandlers } from './customFilters';

function makeRepo(initial: string) {
  let text = initial;
  return {
    get: vi.fn((): string => text),
    set: vi.fn((t: string): void => {
      text = t;
    }),
  };
}

describe('buildCustomFiltersHandlers', () => {
  it('registers exactly the two customFilters channels', () => {
    const repo = makeRepo('');
    const handlers = buildCustomFiltersHandlers(repo as any, { rebuildFromCache: vi.fn() });
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.customFiltersGet, IPC.customFiltersSet].sort(),
    );
  });

  it('customFiltersGet returns repo.get()', () => {
    const repo = makeRepo('x.com##.ad');
    const handlers = buildCustomFiltersHandlers(repo as any, { rebuildFromCache: vi.fn() });
    const out = handlers[IPC.customFiltersGet]();
    expect(repo.get).toHaveBeenCalledTimes(1);
    expect(out).toBe('x.com##.ad');
  });

  it('customFiltersSet persists, rebuilds from cache, and returns the stored text', () => {
    const repo = makeRepo('');
    const rebuildFromCache = vi.fn();
    const handlers = buildCustomFiltersHandlers(repo as any, { rebuildFromCache });
    const out = handlers[IPC.customFiltersSet]('||ads.test^\nx.com##.ad');
    expect(repo.set).toHaveBeenCalledWith('||ads.test^\nx.com##.ad');
    expect(rebuildFromCache).toHaveBeenCalledTimes(1);
    expect(out).toBe('||ads.test^\nx.com##.ad');
  });

  it('customFiltersSet calls set BEFORE rebuildFromCache', () => {
    const order: string[] = [];
    const repo = {
      get: vi.fn((): string => 'stored'),
      set: vi.fn((): void => {
        order.push('set');
      }),
    };
    const rebuildFromCache = vi.fn(() => {
      order.push('rebuild');
    });
    const handlers = buildCustomFiltersHandlers(repo as any, { rebuildFromCache });
    handlers[IPC.customFiltersSet]('whatever');
    expect(order).toEqual(['set', 'rebuild']);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/ipc/customFilters.test.ts`
Expected: FAIL with `Failed to resolve import "./customFilters"` (the module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/ipc/customFilters.ts
import { IPC } from '../../../shared/types';
import type { CustomFiltersRepo } from '../db/customFiltersRepo';

/**
 * Builds the custom-filters (my-filters) IPC handler map (channel -> handler).
 * Handlers receive the invoke args WITHOUT the event (the guard strips it).
 * Saving persists the blob then rebuilds the engine from the on-disk list cache
 * (the new blob is folded in by assembleEngineTexts) so the rules take effect on
 * the NEXT navigation. set returns the stored text so the renderer syncs.
 */
export function buildCustomFiltersHandlers(
  repo: CustomFiltersRepo,
  opts: { rebuildFromCache(): void },
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.customFiltersGet]: (): string => repo.get(),
    [IPC.customFiltersSet]: (text: string): string => {
      repo.set(text);
      opts.rebuildFromCache();
      return repo.get();
    },
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/ipc/customFilters.test.ts`
Expected: PASS (all 4 cases green).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/customFilters.ts electron/main/ipc/customFilters.test.ts
git commit -m "feat(ipc): buildCustomFiltersHandlers (get/set + rebuild-from-cache on save)"
```

---

### Task 8: Extend `buildAdblockHandlers` with `removeAllowlist` / `clearAllowlist`

**Files:**
- Modify: `electron/main/ipc/adblock.ts:11-19`
- Test: `electron/main/ipc/adblock.test.ts` (extend existing)

Pure logic over a fake controller; plain `npx vitest run`. Per §4: `adblockRemoveAllowlist → c.removeAllowlist(host)`, `adblockClearAllowlist → c.clearAllowlist()`, each returning `AdblockState`. The controller methods (Block A T4) delegate to the repo and return `getState()` with NO direct reconcile — re-blocking is deferred to the next-nav reconcile (§2.3). I must not regress the existing three-channel test, so the "exactly N channels" assertion is updated to five.

- [ ] **Step 1: Write the failing test**

Edit the existing `makeController` factory to add the two new spies, update the channel-count assertion to five, and add two new cases. Replace the `makeController` function and the first `it` block, then append two new cases before the closing `});` of the describe.

Replace the existing `makeController` (lines 7-16) with:

```ts
function makeController(state: AdblockState) {
  return {
    setEnabled: vi.fn((enabled: boolean): AdblockState => ({ ...state, enabled })),
    toggleAllowlist: vi.fn((host: string): AdblockState => ({
      ...state,
      allowlistedHosts: [...state.allowlistedHosts, host],
    })),
    getState: vi.fn((): AdblockState => state),
    removeAllowlist: vi.fn((host: string): AdblockState => ({
      ...state,
      allowlistedHosts: state.allowlistedHosts.filter((h) => h !== host),
    })),
    clearAllowlist: vi.fn((): AdblockState => ({ ...state, allowlistedHosts: [] })),
  };
}
```

Replace the existing "registers exactly the three adblock channels" case (lines 21-26) with:

```ts
  it('registers exactly the five adblock channels', () => {
    const handlers = buildAdblockHandlers(makeController(base) as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC.adblockSetEnabled,
        IPC.adblockToggleAllowlist,
        IPC.adblockGetState,
        IPC.adblockRemoveAllowlist,
        IPC.adblockClearAllowlist,
      ].sort(),
    );
  });
```

Append these two cases immediately before the closing `});` of the `describe('buildAdblockHandlers', …)` block:

```ts
  it('adblockRemoveAllowlist forwards the host and returns the new state', () => {
    const seeded: AdblockState = { enabled: true, allowlistedHosts: ['a.test', 'b.test'], sessionBlocked: 5 };
    const c = makeController(seeded);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockRemoveAllowlist]('a.test');
    expect(c.removeAllowlist).toHaveBeenCalledWith('a.test');
    expect(result.allowlistedHosts).toEqual(['b.test']);
  });

  it('adblockClearAllowlist clears and returns the new state', () => {
    const seeded: AdblockState = { enabled: true, allowlistedHosts: ['a.test'], sessionBlocked: 5 };
    const c = makeController(seeded);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockClearAllowlist]();
    expect(c.clearAllowlist).toHaveBeenCalledTimes(1);
    expect(result.allowlistedHosts).toEqual([]);
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/ipc/adblock.test.ts`
Expected: FAIL — the "registers exactly the five adblock channels" case fails because `buildAdblockHandlers` still returns only three keys (and `IPC.adblockRemoveAllowlist` / `IPC.adblockClearAllowlist` resolve, since those channel constants were added in Block A T1).

- [ ] **Step 3: Implement**

Replace the body of `buildAdblockHandlers` in `electron/main/ipc/adblock.ts` (the `return { … };` of lines 14-18) so the file reads:

```ts
// electron/main/ipc/adblock.ts
import { IPC } from '../../../shared/types';
import type { AdblockState } from '../../../shared/types';
import type { AdblockController } from '../adblock/controller';

/**
 * Builds the adblock IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). All mutators return the new
 * AdblockState so the renderer syncs from the result. removeAllowlist/clearAllowlist
 * mutate the persisted allowlist only; re-blocking is deferred to the next-nav
 * reconcile (contract §2.3) — no direct session reconcile here.
 */
export function buildAdblockHandlers(
  c: AdblockController,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.adblockSetEnabled]: (enabled: boolean): AdblockState => c.setEnabled(enabled),
    [IPC.adblockToggleAllowlist]: (host: string): AdblockState => c.toggleAllowlist(host),
    [IPC.adblockGetState]: (): AdblockState => c.getState(),
    [IPC.adblockRemoveAllowlist]: (host: string): AdblockState => c.removeAllowlist(host),
    [IPC.adblockClearAllowlist]: (): AdblockState => c.clearAllowlist(),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/ipc/adblock.test.ts`
Expected: PASS (the three original cases + the two new allowlist cases + the updated five-channel case all green).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/adblock.ts electron/main/ipc/adblock.test.ts
git commit -m "feat(ipc): adblock removeAllowlist/clearAllowlist handlers"
```

---

### Task 9: Boot wiring in `index.ts` — `CustomFiltersRepo` + `rebuildEngineFromCache()` + `runRefresh` rewrite + register handlers + `__aegisTest`

**Files:**
- Modify: `electron/main/index.ts` (imports; construct `customFiltersRepo`; define `rebuildEngineFromCache`; rewrite `runRefresh`; merge new handlers into `registerGuardedHandlers`; extend `__aegisTest`)

This is a boot-wiring task: not naturally red-green (it cannot be exercised without a live Electron app). It composes already-tested units — `resolveRefreshSubs` + `assembleEngineTexts` (T5), `buildSubsHandlers` (T6), `buildCustomFiltersHandlers` (T7), `CustomFiltersRepo` (Block A T3), `SubsRepo.setEnabled/add/remove` (Block A T2). Per §2.1 there are two rebuild paths:
- `runRefresh()` (fetch-rebuild): URLs now come from `resolveRefreshSubs(subsRepo.all(), LIST_BASE)` (NOT the constant), and the engine texts are `assembleEngineTexts(usable.map(s=>s.text), customFiltersRepo.get())`.
- `rebuildEngineFromCache()` (cache-rebuild, no network): read each ENABLED sub's cached `<listId>.txt` via `readFileSafe`, skip empties, `assembleEngineTexts(..., customFiltersRepo.get())`, `buildEngine`, `controller.setPendingBlocker`, `serializeEngine`. The swap is deferred to the next nav.

Show the FULL edited code, then verify via `npm run build` + `tsc --noEmit` (grep the production file for the new boot symbols), then commit.

- [ ] **Step 1: Edit the imports**

Add `readFileSafe` and the new repo / IPC-builder / helper imports. After the existing import block (lines 1-37), the import region must include the following. Replace the `import { fetchAll, RefreshScheduler } …` line and add the new imports adjacent to the existing ones.

Add this import (the repo) right after `import { SubsRepo } from './db/subsRepo';` (line 11):

```ts
import { CustomFiltersRepo } from './db/customFiltersRepo';
```

Add these imports right after `import { buildSavedHandlers } from './ipc/saved';` (line 24):

```ts
import { buildSubsHandlers } from './ipc/subs';
import { buildCustomFiltersHandlers } from './ipc/customFilters';
```

Add this import right after the `buildEngine, …, RESOURCES_URL` block (lines 27-34):

```ts
import { resolveRefreshSubs, assembleEngineTexts } from './adblock/refreshHelpers';
```

Replace the atomicFile-free listManager import (line 35) and add `readFileSafe`. Change:

```ts
import { fetchAll, RefreshScheduler } from './adblock/listManager';
```

to:

```ts
import { fetchAll, RefreshScheduler } from './adblock/listManager';
import { readFileSafe } from '../lib/atomicFile';
```

- [ ] **Step 2: Construct `customFiltersRepo` at boot**

Add the repo construction right after `const subsRepo = new SubsRepo(db);` + its seed (lines 69-70):

Change:

```ts
  const subsRepo = new SubsRepo(db);
  subsRepo.seedDefaults(DEFAULT_LIST_URLS);
  const favoritesRepo = new FavoritesRepo(db);
```

to:

```ts
  const subsRepo = new SubsRepo(db);
  subsRepo.seedDefaults(DEFAULT_LIST_URLS);
  const customFiltersRepo = new CustomFiltersRepo(db);
  const favoritesRepo = new FavoritesRepo(db);
```

- [ ] **Step 3: Rewrite `runRefresh` + add `rebuildEngineFromCache`**

Replace the `refreshSubs` constant and the whole `runRefresh` function (current lines 173-201) with the version below. Note: `refreshSubs` is removed (URLs now come live from `subsRepo.all()` via `resolveRefreshSubs`); `refreshFetch` and `refreshResourcesUrl` (lines 172, 176) are unchanged and stay.

Change this region (lines 172-201):

```ts
  const refreshFetch = OFFLINE ? () => Promise.reject(new Error('offline')) : globalThis.fetch;
  const refreshSubs = LIST_BASE
    ? DEFAULT_LIST_URLS.map((s) => ({ listId: s.listId, url: `${LIST_BASE}/${s.listId}.txt` }))
    : DEFAULT_LIST_URLS;
  const refreshResourcesUrl = LIST_BASE ? `${LIST_BASE}/resources.json` : RESOURCES_URL;

  async function runRefresh(): Promise<ListUpdateResult> {
    const lastUpdated = Date.now();
    const { sources, resources } = await fetchAll(refreshSubs, {
      cacheDir: listsCacheDir,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
      resourcesUrl: refreshResourcesUrl,
      fetchImpl: refreshFetch as typeof fetch,
    });
    const usable = sources.filter((s) => s.ok && s.text.length > 0);
    if (usable.length > 0) {
      const engine = buildEngine(usable.map((s) => s.text), resources);
      controller.setPendingBlocker(engine);
      serializeEngine(engine, cachePath);
      for (const s of usable) {
        subsRepo.updateMeta(s.listId, { lastUpdated, etag: s.etag, hash: s.hash });
      }
    }
    return {
      perSource: sources.map((s) => ({ listId: s.listId, ok: s.ok, error: s.error })),
      lastUpdated,
    };
  }
  const updateNow = (): Promise<ListUpdateResult> => runRefresh();
```

to:

```ts
  const refreshFetch = OFFLINE ? () => Promise.reject(new Error('offline')) : globalThis.fetch;
  const refreshResourcesUrl = LIST_BASE ? `${LIST_BASE}/resources.json` : RESOURCES_URL;

  /**
   * Fetch-rebuild path (network). Sources the ENABLED subscription rows live from
   * subsRepo.all() (this is what finally reads filter_subscriptions.enabled — the
   * wiring gap) via resolveRefreshSubs, applying the LIST_BASE per-row override for
   * e2e. Builds the engine from the fetched list texts + the user's custom-filters
   * blob (assembleEngineTexts), swaps it in on the next nav, persists the cache, and
   * records per-source refresh metadata. Used by lists.updateNow, the 24h scheduler,
   * the boot kick, and subs.add (a new list must be fetched).
   */
  async function runRefresh(): Promise<ListUpdateResult> {
    const lastUpdated = Date.now();
    const refreshSubs = resolveRefreshSubs(subsRepo.all(), LIST_BASE);
    const { sources, resources } = await fetchAll(refreshSubs, {
      cacheDir: listsCacheDir,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
      resourcesUrl: refreshResourcesUrl,
      fetchImpl: refreshFetch as typeof fetch,
    });
    const usable = sources.filter((s) => s.ok && s.text.length > 0);
    if (usable.length > 0) {
      const texts = assembleEngineTexts(usable.map((s) => s.text), customFiltersRepo.get());
      const engine = buildEngine(texts, resources);
      controller.setPendingBlocker(engine);
      serializeEngine(engine, cachePath);
      for (const s of usable) {
        subsRepo.updateMeta(s.listId, { lastUpdated, etag: s.etag, hash: s.hash });
      }
    }
    return {
      perSource: sources.map((s) => ({ listId: s.listId, ok: s.ok, error: s.error })),
      lastUpdated,
    };
  }

  /**
   * Cache-rebuild path (NO network). Reads the on-disk raw cache for each ENABLED
   * subscription (lists/<listId>.txt), skipping missing/empty files, appends the
   * user's custom-filters blob (assembleEngineTexts), rebuilds the engine, swaps it
   * in on the next nav, and re-serializes the cache. Used by subs.setEnabled,
   * subs.remove, and customFilters.set — none of which need a re-fetch. On a fresh
   * profile with no caches yet this yields a near-empty engine; the active engine
   * (cache/snapshot) stays until a successful runRefresh (documented caveat §2.1).
   */
  function rebuildEngineFromCache(): void {
    const listTexts: string[] = [];
    for (const sub of subsRepo.all()) {
      if (!sub.enabled) continue;
      const text = readFileSafe(join(listsCacheDir, `${sub.listId}.txt`));
      if (text !== null && text.length > 0) listTexts.push(text);
    }
    const texts = assembleEngineTexts(listTexts, customFiltersRepo.get());
    const engine = buildEngine(texts, null);
    controller.setPendingBlocker(engine);
    serializeEngine(engine, cachePath);
  }
  const updateNow = (): Promise<ListUpdateResult> => runRefresh();
```

- [ ] **Step 4: Merge the new handler maps into `registerGuardedHandlers`**

Change the `registerGuardedHandlers` call (lines 203-212):

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

to:

```ts
  registerGuardedHandlers(chromeWc.id, {
    ...buildNavHandlers(vc, settingsRepo),
    ...buildSettingsHandlers(settingsRepo),
    ...buildAdblockHandlers(controller),
    ...buildListsHandlers(updateNow),
    ...buildSubsHandlers(subsRepo, { rebuildFromCache: rebuildEngineFromCache, refresh: updateNow }),
    ...buildCustomFiltersHandlers(customFiltersRepo, { rebuildFromCache: rebuildEngineFromCache }),
    ...buildFavoritesHandlers(favoritesRepo),
    ...buildHistoryHandlers(historyRepo),
    ...buildSavedHandlers(savedRepo),
    ...buildViewLayoutHandlers(setContentInset),
  });
```

- [ ] **Step 5: Extend the `__aegisTest` registry (e2e)**

Per §4, expose `settingsRepo`, `subsRepo`, `customFiltersRepo`, the cache-rebuild fn (registry key
`rebuildFromCache`), `updateNow`, and `navHome` for e2e via a new `phase4` registry (Block-E specs drive
settings/list/my-filters/allowlist/home through this — this is the ONLY place the registry is defined). Change the
`__aegisTest` block (lines 215-231):

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

to:

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
      phase4: {
        settingsRepo,
        subsRepo,
        customFiltersRepo,
        rebuildFromCache: rebuildEngineFromCache,
        updateNow,
        navHome: () => vc.navigate(settingsRepo.get().homeUrl),
      },
    };
  }
```

This is the SINGLE definition of `__aegisTest.phase4` (registry KEY `rebuildFromCache` aliases the boot-local
`rebuildEngineFromCache`; `navHome` mirrors the production main-side home handler). Tasks 23–26 CONSUME it and do
NOT re-edit `index.ts`.

- [ ] **Step 6: Verify the build + types**

Run: `npm run build`
Expected: build succeeds (electron-vite emits `out/main/index.js` with no error).

Run: `npx tsc --noEmit 2>&1 | grep -E 'electron/main/index\.ts|electron/main/ipc/subs\.ts|electron/main/ipc/customFilters\.ts|electron/main/adblock/refreshHelpers\.ts' || echo "no production errors in Block-B main files"`
Expected: prints `no production errors in Block-B main files` (the known pre-existing test-file `tsc` baseline is accepted; no NEW production-file error is introduced).

Run: `grep -nE 'rebuildEngineFromCache|resolveRefreshSubs|customFiltersRepo|buildSubsHandlers|buildCustomFiltersHandlers' electron/main/index.ts`
Expected: prints the boot wiring (import + construction + the two rebuild paths + both handler-map spreads + the `phase4` registry entries), confirming the symbols are present in the production file.

- [ ] **Step 7: Run the full main-side unit suite to confirm no regression**

Run: `npm run rebuild:node && npx vitest run electron/main`
Expected: PASS — all main-side unit tests green (the refresh helpers, subs/customFilters/adblock IPC builders, and the unchanged repo/controller/listManager suites).

- [ ] **Step 8: Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(main): boot wiring — CustomFiltersRepo, rebuildEngineFromCache, runRefresh from subsRepo.all() + custom filters, register subs/customFilters handlers, phase4 __aegisTest"
```

---

### Task 10: `chromePreload.ts` — `subs`, `customFilters`, and `adblock` allowlist namespaces

**Files:**
- Modify: `electron/preload/chromePreload.ts` (imports `Subscription`; extend the `adblock` namespace; add `subs` + `customFilters` namespaces)
- Test: `electron/preload/chromePreload.test.ts` (extend existing)

Pure renderer/preload logic with the mocked `electron` module; plain `npx vitest run`. Thin `ipcRenderer.invoke` wrappers in namespaces on the `aegis` object, matching the established pattern. The `AegisApi` members + IPC channel constants + the re-exported `Subscription` were added in Block A T1, so the typed namespace compiles.

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to the end of `electron/preload/chromePreload.test.ts` (after the Phase-3 block's closing `});`). Add `Subscription` to the test's type import as well.

Change the existing test type import (line 4):

```ts
import type { AegisApi, NavState, BlockedCount } from '../../shared/types';
```

to:

```ts
import type { AegisApi, NavState, BlockedCount, Subscription } from '../../shared/types';
```

Append this block at the end of the file:

```ts
describe('chromePreload subs + customFilters + allowlist (Phase 4)', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  it('exposes the subs and customFilters namespaces + the adblock allowlist methods', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.subs.list).toBe('function');
    expect(typeof api.subs.setEnabled).toBe('function');
    expect(typeof api.subs.add).toBe('function');
    expect(typeof api.subs.remove).toBe('function');
    expect(typeof api.customFilters.get).toBe('function');
    expect(typeof api.customFilters.set).toBe('function');
    expect(typeof api.adblock.removeAllowlist).toBe('function');
    expect(typeof api.adblock.clearAllowlist).toBe('function');
  });

  it('subs.list invokes IPC.subsList and returns the resolved subscriptions', async () => {
    const subs: Subscription[] = [
      { listId: 'easylist', url: 'https://e.test/easylist.txt', enabled: true, lastUpdated: null, etag: null, hash: null },
    ];
    h.invoke = vi.fn(async () => subs);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.subs.list();
    expect(h.invoke).toHaveBeenCalledWith(IPC.subsList);
    expect(out).toEqual(subs);
  });

  it('subs.setEnabled invokes IPC.subsSetEnabled with (listId, enabled)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.subs.setEnabled('easylist', false);
    expect(h.invoke).toHaveBeenCalledWith(IPC.subsSetEnabled, 'easylist', false);
  });

  it('subs.add invokes IPC.subsAdd with the url', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.subs.add('https://new.test/list.txt');
    expect(h.invoke).toHaveBeenCalledWith(IPC.subsAdd, 'https://new.test/list.txt');
  });

  it('subs.remove invokes IPC.subsRemove with the listId', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.subs.remove('easylist');
    expect(h.invoke).toHaveBeenCalledWith(IPC.subsRemove, 'easylist');
  });

  it('customFilters.get invokes IPC.customFiltersGet and returns the resolved text', async () => {
    h.invoke = vi.fn(async () => 'x.com##.ad');
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.customFilters.get();
    expect(h.invoke).toHaveBeenCalledWith(IPC.customFiltersGet);
    expect(out).toBe('x.com##.ad');
  });

  it('customFilters.set invokes IPC.customFiltersSet with the text and returns the stored text', async () => {
    h.invoke = vi.fn(async () => '||ads.test^');
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.customFilters.set('||ads.test^');
    expect(h.invoke).toHaveBeenCalledWith(IPC.customFiltersSet, '||ads.test^');
    expect(out).toBe('||ads.test^');
  });

  it('adblock.removeAllowlist invokes IPC.adblockRemoveAllowlist with the host', async () => {
    const state = { enabled: true, allowlistedHosts: [], sessionBlocked: 1 };
    h.invoke = vi.fn(async () => state);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.adblock.removeAllowlist('a.test');
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockRemoveAllowlist, 'a.test');
    expect(out).toEqual(state);
  });

  it('adblock.clearAllowlist invokes IPC.adblockClearAllowlist and returns the resolved state', async () => {
    const state = { enabled: true, allowlistedHosts: [], sessionBlocked: 1 };
    h.invoke = vi.fn(async () => state);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.adblock.clearAllowlist();
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockClearAllowlist);
    expect(out).toEqual(state);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/preload/chromePreload.test.ts`
Expected: FAIL — the new Phase-4 cases fail (`api.subs is undefined` / `api.customFilters is undefined` / `api.adblock.removeAllowlist is not a function`), since the preload does not yet expose those namespaces/methods.

- [ ] **Step 3: Implement**

Add `Subscription` to the preload's type import. Change the import block (lines 4-8):

```ts
import type {
  AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings,
  AdblockState, BlockedCount, ListUpdateResult,
  Favorite, HistoryEntry, SavedItem, ContentInset,
} from '../../shared/types';
```

to:

```ts
import type {
  AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings,
  AdblockState, BlockedCount, ListUpdateResult,
  Favorite, HistoryEntry, SavedItem, ContentInset, Subscription,
} from '../../shared/types';
```

Extend the `adblock` namespace with the two allowlist wrappers. Change the `adblock` block (lines 39-47):

```ts
  adblock: {
    setEnabled: (enabled: boolean): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockSetEnabled, enabled),
    toggleAllowlist: (host: string): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockToggleAllowlist, host),
    getState: (): Promise<AdblockState> => ipcRenderer.invoke(IPC.adblockGetState),
    onBlockedCount: (cb: (c: BlockedCount) => void) =>
      subscribe<BlockedCount>(IPC.evtAdblockBlockedCount, cb),
  },
```

to:

```ts
  adblock: {
    setEnabled: (enabled: boolean): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockSetEnabled, enabled),
    toggleAllowlist: (host: string): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockToggleAllowlist, host),
    getState: (): Promise<AdblockState> => ipcRenderer.invoke(IPC.adblockGetState),
    removeAllowlist: (host: string): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockRemoveAllowlist, host),
    clearAllowlist: (): Promise<AdblockState> => ipcRenderer.invoke(IPC.adblockClearAllowlist),
    onBlockedCount: (cb: (c: BlockedCount) => void) =>
      subscribe<BlockedCount>(IPC.evtAdblockBlockedCount, cb),
  },
```

Add the `subs` and `customFilters` namespaces right after the `lists` block (lines 48-50). Change:

```ts
  lists: {
    updateNow: (): Promise<ListUpdateResult> => ipcRenderer.invoke(IPC.listsUpdateNow),
  },
  favorites: {
```

to:

```ts
  lists: {
    updateNow: (): Promise<ListUpdateResult> => ipcRenderer.invoke(IPC.listsUpdateNow),
  },
  subs: {
    list: (): Promise<Subscription[]> => ipcRenderer.invoke(IPC.subsList),
    setEnabled: (listId: string, enabled: boolean): Promise<Subscription[]> =>
      ipcRenderer.invoke(IPC.subsSetEnabled, listId, enabled),
    add: (url: string): Promise<Subscription[]> => ipcRenderer.invoke(IPC.subsAdd, url),
    remove: (listId: string): Promise<Subscription[]> => ipcRenderer.invoke(IPC.subsRemove, listId),
  },
  customFilters: {
    get: (): Promise<string> => ipcRenderer.invoke(IPC.customFiltersGet),
    set: (text: string): Promise<string> => ipcRenderer.invoke(IPC.customFiltersSet, text),
  },
  favorites: {
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/preload/chromePreload.test.ts`
Expected: PASS — all prior preload cases (nav/view/settings/adblock/lists/favorites/history/saved/inset) plus the new Phase-4 subs/customFilters/allowlist cases green.

- [ ] **Step 5: Commit**

```bash
git add electron/preload/chromePreload.ts electron/preload/chromePreload.test.ts
git commit -m "feat(preload): subs + customFilters namespaces + adblock removeAllowlist/clearAllowlist"
```

---

#### New names introduced (Block B)

- `resolveRefreshSubs` (exported fn, `electron/main/adblock/refreshHelpers.ts`)
- `assembleEngineTexts` (exported fn, `electron/main/adblock/refreshHelpers.ts`)
- `buildSubsHandlers` (exported fn, `electron/main/ipc/subs.ts`)
- `buildCustomFiltersHandlers` (exported fn, `electron/main/ipc/customFilters.ts`)
- `rebuildEngineFromCache` (boot-local fn, `electron/main/index.ts`; exposed for e2e under `__aegisTest.phase4`)
- `__aegisTest.phase4` (e2e registry namespace, defined ONCE in Task 9: `{ settingsRepo, subsRepo, customFiltersRepo, rebuildFromCache (aliases the boot-local rebuildEngineFromCache fn), updateNow, navHome }`, `electron/main/index.ts`)
- `aegis.subs` preload namespace: `subs.list` / `subs.setEnabled` / `subs.add` / `subs.remove` (`electron/preload/chromePreload.ts`)
- `aegis.customFilters` preload namespace: `customFilters.get` / `customFilters.set` (`electron/preload/chromePreload.ts`)
- `aegis.adblock.removeAllowlist` / `aegis.adblock.clearAllowlist` preload wrappers (`electron/preload/chromePreload.ts`)

(Note: `assertListUrlAllowed` is a file-private helper inside `subs.ts`, not exported. The IPC channel constants `IPC.subs*` / `IPC.customFilters*` / `IPC.adblockRemoveAllowlist` / `IPC.adblockClearAllowlist`, the `AegisApi` members, and the re-exported `Subscription` type are introduced by Block A Task 1 and only consumed here.)

I have everything needed. The contract specifies `Subscription` is re-exported from `shared/types.ts` (Block A Task 1, which I depend on but don't write). My hooks import `Subscription` from `../../shared/types`. I now have all the as-built patterns confirmed. Let me write the Block C task markdown.

### Task 11: `useSettings` hook (shared get/set + live theme + document.title)

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useSettings.ts`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useSettings.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/useSettings.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Settings } from '../../shared/types';

const get = vi.fn();
const set = vi.fn();
const applyTheme = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    settings: {
      get: (...a: any[]) => get(...a),
      set: (...a: any[]) => set(...a),
    },
  },
}));

vi.mock('../lib/theme', () => ({
  applyTheme: (...a: any[]) => applyTheme(...a),
}));

import { useSettings } from './useSettings';

const baseSettings: Settings = {
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [{ id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' }],
  hideChromeByDefault: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  document.title = '';
  get.mockResolvedValue(baseSettings);
  set.mockResolvedValue(baseSettings);
});

describe('useSettings', () => {
  it('seeds settings from aegis.settings.get on mount', async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.current.settings.primaryColor).toBe('#7c5cff');
  });

  it('sets document.title from siteName on mount', async () => {
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    expect(document.title).toBe('Aegis');
  });

  it('update() calls aegis.settings.set with the partial and syncs returned state', async () => {
    set.mockResolvedValue({ ...baseSettings, homeUrl: 'https://example.com/' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    await act(async () => {
      await result.current.update({ homeUrl: 'https://example.com/' });
    });
    expect(set).toHaveBeenCalledWith({ homeUrl: 'https://example.com/' });
    expect(result.current.settings.homeUrl).toBe('https://example.com/');
  });

  it('re-applies the theme when update changes primaryColor', async () => {
    set.mockResolvedValue({ ...baseSettings, primaryColor: '#ff0000' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    await act(async () => {
      await result.current.update({ primaryColor: '#ff0000' });
    });
    expect(applyTheme).toHaveBeenCalledWith({ primaryColor: '#ff0000' });
  });

  it('does NOT re-apply the theme when update omits primaryColor', async () => {
    set.mockResolvedValue({ ...baseSettings, homeUrl: 'https://example.com/' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    await act(async () => {
      await result.current.update({ homeUrl: 'https://example.com/' });
    });
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it('updates document.title when update changes siteName', async () => {
    set.mockResolvedValue({ ...baseSettings, siteName: 'My Browser' });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings.siteName).toBe('Aegis'));
    await act(async () => {
      await result.current.update({ siteName: 'My Browser' });
    });
    expect(document.title).toBe('My Browser');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/hooks/useSettings.test.tsx`
Expected: FAIL with `Failed to resolve import "./useSettings"` (module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// src/hooks/useSettings.ts
import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { applyTheme } from '../lib/theme';

const emptySettings: Settings = {
  siteName: '',
  homeUrl: '',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: '',
  searchEngines: [],
  hideChromeByDefault: false,
};

export function useSettings(): {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
} {
  const [settings, setSettings] = useState<Settings>(emptySettings);

  useEffect(() => {
    let active = true;
    void aegis.settings.get().then((s) => {
      if (!active) return;
      setSettings(s);
      document.title = s.siteName;
    });
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback(async (partial: Partial<Settings>): Promise<void> => {
    const next = await aegis.settings.set(partial);
    setSettings(next);
    // Theme re-applies live only when the accent color was part of this edit.
    if (partial.primaryColor !== undefined) {
      applyTheme({ primaryColor: next.primaryColor });
    }
    // Keep the document title in sync when the site name was part of this edit.
    if (partial.siteName !== undefined) {
      document.title = next.siteName;
    }
  }, []);

  return { settings, update };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/hooks/useSettings.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSettings.ts src/hooks/useSettings.test.tsx
git commit -m "feat(renderer): add useSettings hook with live theme + document.title sync"
```

---

### Task 12: `useSubscriptions` hook (list/setEnabled/add/remove/updateNow)

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useSubscriptions.ts`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useSubscriptions.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/useSubscriptions.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Subscription, ListUpdateResult } from '../../shared/types';

const list = vi.fn();
const setEnabled = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const updateNow = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    subs: {
      list: (...a: any[]) => list(...a),
      setEnabled: (...a: any[]) => setEnabled(...a),
      add: (...a: any[]) => add(...a),
      remove: (...a: any[]) => remove(...a),
    },
    lists: { updateNow: (...a: any[]) => updateNow(...a) },
  },
}));

import { useSubscriptions } from './useSubscriptions';

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  listId: 'easylist',
  url: 'https://example.com/easylist.txt',
  enabled: true,
  lastUpdated: 1000,
  etag: null,
  hash: null,
  ...over,
});

const seed: Subscription[] = [
  sub({ listId: 'easylist', url: 'https://example.com/easylist.txt', enabled: true }),
  sub({ listId: 'easyprivacy', url: 'https://example.com/easyprivacy.txt', enabled: false }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  setEnabled.mockResolvedValue(seed);
  add.mockResolvedValue(seed);
  remove.mockResolvedValue(seed);
  updateNow.mockResolvedValue({ perSource: [], lastUpdated: 123 } as ListUpdateResult);
});

describe('useSubscriptions', () => {
  it('seeds subs from aegis.subs.list on mount', async () => {
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.subs.map((s) => s.listId)).toEqual(['easylist', 'easyprivacy']);
  });

  it('setEnabled() calls aegis with id + enabled and refreshes from the result', async () => {
    const flipped = [seed[0], sub({ listId: 'easyprivacy', url: 'https://example.com/easyprivacy.txt', enabled: true })];
    setEnabled.mockResolvedValue(flipped);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.setEnabled('easyprivacy', true);
    });
    expect(setEnabled).toHaveBeenCalledWith('easyprivacy', true);
    expect(result.current.subs[1].enabled).toBe(true);
  });

  it('add() calls aegis with the url and refreshes from the result', async () => {
    const added = [...seed, sub({ listId: 'custom', url: 'https://lists.example/custom.txt', enabled: true })];
    add.mockResolvedValue(added);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.add('https://lists.example/custom.txt');
    });
    expect(add).toHaveBeenCalledWith('https://lists.example/custom.txt');
    expect(result.current.subs).toHaveLength(3);
    expect(result.current.subs[2].listId).toBe('custom');
  });

  it('remove() calls aegis with the listId and refreshes from the result', async () => {
    remove.mockResolvedValue([seed[0]]);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.remove('easyprivacy');
    });
    expect(remove).toHaveBeenCalledWith('easyprivacy');
    expect(result.current.subs.map((s) => s.listId)).toEqual(['easylist']);
  });

  it('updateNow() delegates to aegis.lists.updateNow and returns its result', async () => {
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    let res: ListUpdateResult | undefined;
    await act(async () => {
      res = await result.current.updateNow();
    });
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ perSource: [], lastUpdated: 123 });
  });

  it('refreshes the subscription list after updateNow', async () => {
    const refreshed = seed.map((s) => sub({ ...s, lastUpdated: 9999 }));
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.updateNow();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.subs.every((s) => s.lastUpdated === 9999)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/hooks/useSubscriptions.test.tsx`
Expected: FAIL with `Failed to resolve import "./useSubscriptions"` (module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// src/hooks/useSubscriptions.ts
import { useCallback, useEffect, useState } from 'react';
import type { Subscription, ListUpdateResult } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useSubscriptions(): {
  subs: Subscription[];
  setEnabled(listId: string, enabled: boolean): Promise<void>;
  add(url: string): Promise<void>;
  remove(listId: string): Promise<void>;
  updateNow(): Promise<ListUpdateResult>;
} {
  const [subs, setSubs] = useState<Subscription[]>([]);

  useEffect(() => {
    let active = true;
    void aegis.subs.list().then((items) => {
      if (active) setSubs(items);
    });
    return () => {
      active = false;
    };
  }, []);

  const setEnabled = useCallback(async (listId: string, enabled: boolean): Promise<void> => {
    setSubs(await aegis.subs.setEnabled(listId, enabled));
  }, []);

  const add = useCallback(async (url: string): Promise<void> => {
    setSubs(await aegis.subs.add(url));
  }, []);

  const remove = useCallback(async (listId: string): Promise<void> => {
    setSubs(await aegis.subs.remove(listId));
  }, []);

  const updateNow = useCallback(async (): Promise<ListUpdateResult> => {
    const result = await aegis.lists.updateNow();
    // A force-update mutates last-updated/etag/hash on every fetched row, so
    // re-read the list to reflect the fresh metadata in any open manager.
    setSubs(await aegis.subs.list());
    return result;
  }, []);

  return { subs, setEnabled, add, remove, updateNow };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/hooks/useSubscriptions.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSubscriptions.ts src/hooks/useSubscriptions.test.tsx
git commit -m "feat(renderer): add useSubscriptions hook (list/setEnabled/add/remove/updateNow)"
```

---

### Task 13: `useCustomFilters` hook (get/save the my-filters blob)

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useCustomFilters.ts`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useCustomFilters.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/useCustomFilters.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const get = vi.fn();
const set = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    customFilters: {
      get: (...a: any[]) => get(...a),
      set: (...a: any[]) => set(...a),
    },
  },
}));

import { useCustomFilters } from './useCustomFilters';

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue('||ads.example.com^');
  set.mockResolvedValue('||ads.example.com^');
});

describe('useCustomFilters', () => {
  it('seeds text from aegis.customFilters.get on mount', async () => {
    const { result } = renderHook(() => useCustomFilters());
    await waitFor(() => expect(result.current.text).toBe('||ads.example.com^'));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('starts with empty text before the get resolves', () => {
    const { result } = renderHook(() => useCustomFilters());
    expect(result.current.text).toBe('');
  });

  it('save() calls aegis.customFilters.set with the text and syncs the returned blob', async () => {
    set.mockResolvedValue('example.com##.ad-banner');
    const { result } = renderHook(() => useCustomFilters());
    await waitFor(() => expect(result.current.text).toBe('||ads.example.com^'));
    await act(async () => {
      await result.current.save('example.com##.ad-banner');
    });
    expect(set).toHaveBeenCalledWith('example.com##.ad-banner');
    expect(result.current.text).toBe('example.com##.ad-banner');
  });

  it('save() persists an empty string when the user clears the box', async () => {
    set.mockResolvedValue('');
    const { result } = renderHook(() => useCustomFilters());
    await waitFor(() => expect(result.current.text).toBe('||ads.example.com^'));
    await act(async () => {
      await result.current.save('');
    });
    expect(set).toHaveBeenCalledWith('');
    expect(result.current.text).toBe('');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/hooks/useCustomFilters.test.tsx`
Expected: FAIL with `Failed to resolve import "./useCustomFilters"` (module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// src/hooks/useCustomFilters.ts
import { useCallback, useEffect, useState } from 'react';
import { aegis } from '../lib/ipcClient';

export function useCustomFilters(): {
  text: string;
  save(text: string): Promise<void>;
} {
  const [text, setText] = useState<string>('');

  useEffect(() => {
    let active = true;
    void aegis.customFilters.get().then((stored) => {
      if (active) setText(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(async (next: string): Promise<void> => {
    // set returns the stored blob; mirror it back so the box reflects what
    // actually persisted (and what the engine rebuilt from).
    setText(await aegis.customFilters.set(next));
  }, []);

  return { text, save };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/hooks/useCustomFilters.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useCustomFilters.ts src/hooks/useCustomFilters.test.tsx
git commit -m "feat(renderer): add useCustomFilters hook (get/save my-filters blob)"
```

---

### Task 14: Extend `useAdblock` with `removeAllowlist` + `clearAllowlist`

**Files:**
- Modify: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useAdblock.ts:22-73`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useAdblock.test.tsx` (add cases + mock members; do not regress existing)

- [ ] **Step 1: Write the failing test**

Extend the existing mock to expose the two new IPC members, register their spies, seed them in `beforeEach`, and add two new test cases. Apply these three edits to `src/hooks/useAdblock.test.tsx`.

Edit 1 — add the two spies alongside the existing ones (after the `updateNow` declaration near the top):

```tsx
const getState = vi.fn();
const setEnabled = vi.fn();
const toggleAllowlist = vi.fn();
const onBlockedCount = vi.fn();
const updateNow = vi.fn();
const removeAllowlist = vi.fn();
const clearAllowlist = vi.fn();
```

Edit 2 — expose the two members on the mocked `aegis.adblock`:

```tsx
vi.mock('../lib/ipcClient', () => ({
  aegis: {
    adblock: {
      getState: (...a: any[]) => getState(...a),
      setEnabled: (...a: any[]) => setEnabled(...a),
      toggleAllowlist: (...a: any[]) => toggleAllowlist(...a),
      onBlockedCount: (cb: (c: BlockedCount) => void) => onBlockedCount(cb),
      removeAllowlist: (...a: any[]) => removeAllowlist(...a),
      clearAllowlist: (...a: any[]) => clearAllowlist(...a),
    },
    lists: { updateNow: (...a: any[]) => updateNow(...a) },
  },
}));
```

Edit 3 — seed the two new spies in `beforeEach` (after the `updateNow.mockResolvedValue(...)` line):

```tsx
beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(baseState);
  setEnabled.mockResolvedValue({ ...baseState, enabled: false });
  toggleAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: ['example.com'] });
  onBlockedCount.mockReturnValue(() => {});
  updateNow.mockResolvedValue({ perSource: [], lastUpdated: 123 } as ListUpdateResult);
  removeAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
  clearAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
});
```

Edit 4 — add two test cases at the end of the `describe('useAdblock', ...)` block (before its closing `});`):

```tsx
  it('removeAllowlist calls aegis with the host and syncs returned state', async () => {
    removeAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: ['kept.com'] });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.removeAllowlist('drop.com'));
    expect(removeAllowlist).toHaveBeenCalledWith('drop.com');
    expect(result.current.state.allowlistedHosts).toEqual(['kept.com']);
  });

  it('clearAllowlist calls aegis and syncs returned (emptied) state', async () => {
    clearAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.clearAllowlist());
    expect(clearAllowlist).toHaveBeenCalledTimes(1);
    expect(result.current.state.allowlistedHosts).toEqual([]);
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/hooks/useAdblock.test.tsx`
Expected: FAIL — the two new cases error because `result.current.removeAllowlist`/`result.current.clearAllowlist` are `undefined` (`TypeError: result.current.removeAllowlist is not a function`). The existing 9 cases still pass.

- [ ] **Step 3: Implement**

Apply two edits to `src/hooks/useAdblock.ts`.

Edit 1 — add the two methods to the return-type signature:

```ts
export function useAdblock(
  viewId: ViewId,
  currentUrl: string,
): {
  state: AdblockState;
  page: number;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
  removeAllowlist(host: string): void;
  clearAllowlist(): void;
  updateNow(): Promise<ListUpdateResult>;
} {
```

Edit 2 — add the two callbacks and include them in the returned object (place them after the existing `toggleAllowlist` callback and before `updateNow`):

```ts
  const removeAllowlist = useCallback((host: string) => {
    void aegis.adblock.removeAllowlist(host).then((s) => setState(s));
  }, []);

  const clearAllowlist = useCallback(() => {
    void aegis.adblock.clearAllowlist().then((s) => setState(s));
  }, []);

  const updateNow = useCallback((): Promise<ListUpdateResult> => {
    return aegis.lists.updateNow();
  }, []);

  return { state, page, setEnabled, toggleAllowlist, removeAllowlist, clearAllowlist, updateNow };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/hooks/useAdblock.test.tsx`
Expected: PASS (11 tests — the original 9 plus the 2 new allowlist cases).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useAdblock.ts src/hooks/useAdblock.test.tsx
git commit -m "feat(renderer): extend useAdblock with removeAllowlist/clearAllowlist"
```

---

#### New names introduced (Block C)
- `useSettings` (exported function, `src/hooks/useSettings.ts`)
- `useSubscriptions` (exported function, `src/hooks/useSubscriptions.ts`)
- `useCustomFilters` (exported function, `src/hooks/useCustomFilters.ts`)
- `useAdblock` return additions: `removeAllowlist(host: string): void`, `clearAllowlist(): void` (extends existing export, no new module)

I have all the patterns I need. The Block-C hooks (`useSettings`, `useSubscriptions`, `useCustomFilters`, extended `useAdblock`) are defined upstream in tasks T11-T14 with signatures pinned in §4. The tab components in Block D consume these hooks' return values as props (the App wires them). Let me check the AddressBar aria-label name and confirm the `useSettings` shape one more time from §4, then write the tasks.

The hook return signatures from §4 are:
- `useSettings(): { settings: Settings; update(partial): Promise<void> }`
- `useSubscriptions(): { subs: Subscription[]; setEnabled(id,en): Promise<void>; add(url): Promise<void>; remove(id): Promise<void>; updateNow(): Promise<ListUpdateResult> }`
- `useCustomFilters(): { text: string; save(text): Promise<void> }`
- `useAdblock` extended with `removeAllowlist(host): void; clearAllowlist(): void`

I'll design the tab components as presentational (props-driven), with `SettingsModal` orchestrating the hooks internally so App only needs `onClose`. Now I have everything. Writing the Block D tasks.

### Task 15: `SettingsModal` shell — `useDialog` + tablist tab-switching

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SettingsModal.tsx`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SettingsModal.test.tsx`

- [ ] **Step 1: Write the failing test**

This task builds only the modal shell: the `useDialog`-wired dialog and the six-tab tablist with panel switching. The tab panels are passed in as `ReactNode` props (the real tab components are wired in by `SettingsModal`'s consumer in later tasks; here the shell is purely a dialog + tablist that renders whichever panel is active). The shell mocks nothing — it is presentational.

```tsx
// src/components/SettingsModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsModal } from './SettingsModal';

const panels = () => ({
  appearance: <div data-testid="panel-appearance">APPEARANCE</div>,
  search: <div data-testid="panel-search">SEARCH</div>,
  home: <div data-testid="panel-home">HOME</div>,
  filterLists: <div data-testid="panel-filterLists">FILTER LISTS</div>,
  myFilters: <div data-testid="panel-myFilters">MY FILTERS</div>,
  allowlist: <div data-testid="panel-allowlist">ALLOWLIST</div>,
});

const props = (over: Partial<React.ComponentProps<typeof SettingsModal>> = {}) => ({
  onClose: vi.fn(),
  ...panels(),
  ...over,
});

describe('SettingsModal', () => {
  it('renders as a modal dialog named Settings', () => {
    render(<SettingsModal {...props()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/settings/i);
  });

  it('renders a tablist with the six tabs', () => {
    render(<SettingsModal {...props()} />);
    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    expect(tablist).toBeInTheDocument();
    for (const name of [/appearance/i, /search/i, /^home$/i, /filter lists/i, /my filters/i, /allowlist/i]) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('shows the Appearance panel by default and marks its tab selected', () => {
    render(<SettingsModal {...props()} />);
    expect(screen.getByRole('tab', { name: /appearance/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('panel-appearance')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-search')).not.toBeInTheDocument();
  });

  it('switches to another tab on click', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /filter lists/i }));
    expect(screen.getByRole('tab', { name: /filter lists/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('panel-filterLists')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-appearance')).not.toBeInTheDocument();
  });

  it('the active tabpanel is labelled by its tab', async () => {
    render(<SettingsModal {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /my filters/i }));
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAccessibleName(/my filters/i);
  });

  it('closes on the Close button and on Escape', async () => {
    const p = props();
    render(<SettingsModal {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    p.onClose.mockClear();
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/SettingsModal.test.tsx`
Expected: FAIL — `Failed to resolve import "./SettingsModal"` (the module does not exist yet).

- [ ] **Step 3: Implement**

```tsx
// src/components/SettingsModal.tsx
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useDialog } from '../hooks/useDialog';

type SettingsTab =
  | 'appearance'
  | 'search'
  | 'home'
  | 'filterLists'
  | 'myFilters'
  | 'allowlist';

const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  search: 'Search',
  home: 'Home',
  filterLists: 'Filter Lists',
  myFilters: 'My Filters',
  allowlist: 'Allowlist',
};

const TAB_ORDER: SettingsTab[] = [
  'appearance',
  'search',
  'home',
  'filterLists',
  'myFilters',
  'allowlist',
];

export interface SettingsModalProps {
  onClose(): void;
  appearance: ReactNode;
  search: ReactNode;
  home: ReactNode;
  filterLists: ReactNode;
  myFilters: ReactNode;
  allowlist: ReactNode;
}

export function SettingsModal({
  onClose,
  appearance,
  search,
  home,
  filterLists,
  myFilters,
  allowlist,
}: SettingsModalProps) {
  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const [tab, setTab] = useState<SettingsTab>('appearance');

  // Stable id pairs (tab control id + panel id) per section, for aria wiring.
  const appearanceTabId = useId();
  const searchTabId = useId();
  const homeTabId = useId();
  const filterListsTabId = useId();
  const myFiltersTabId = useId();
  const allowlistTabId = useId();
  const panelId = useId();

  const tabIds: Record<SettingsTab, string> = {
    appearance: appearanceTabId,
    search: searchTabId,
    home: homeTabId,
    filterLists: filterListsTabId,
    myFilters: myFiltersTabId,
    allowlist: allowlistTabId,
  };

  const panels: Record<SettingsTab, ReactNode> = {
    appearance,
    search,
    home,
    filterLists,
    myFilters,
    allowlist,
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="settings-modal"
    >
      <div className="settings-modal__header">
        <h2 id={titleId} className="settings-modal__title">
          Settings
        </h2>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="settings-modal__body">
        <div className="settings-modal__tabs" role="tablist" aria-label="Settings sections">
          {TAB_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={tabIds[t]}
              aria-controls={panelId}
              aria-selected={tab === t}
              className="settings-modal__tab"
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabIds[tab]}
          className="settings-modal__panel"
        >
          {panels[tab]}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/SettingsModal.test.tsx`
Expected: PASS (all 6 tests green).

- [ ] **Step 5: Commit**

```bash
git -C /home/happyhobo/Documents/AI_Apps/Aegis add src/components/SettingsModal.tsx src/components/SettingsModal.test.tsx
git -C /home/happyhobo/Documents/AI_Apps/Aegis commit -m "feat(settings): SettingsModal shell with useDialog + six-tab tablist"
```

---

### Task 16: `AppearanceTab` — accent color (live theme) + site name

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/AppearanceTab.tsx`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/AppearanceTab.test.tsx`

The tab is presentational: it receives the current `settings` and an `update(partial)` callback (the `useSettings` return shape from §4). `update` is what re-applies the theme and sets the title — the tab just calls it. The accent color is a native color input; site name is a text input.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/AppearanceTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../../shared/types';
import { AppearanceTab } from './AppearanceTab';

const settings = (over: Partial<Settings> = {}): Settings => ({
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  ...over,
});

describe('AppearanceTab', () => {
  it('shows the current accent color in the color input', () => {
    render(<AppearanceTab settings={settings({ primaryColor: '#112233' })} update={vi.fn(async () => {})} />);
    expect(screen.getByLabelText(/accent color/i)).toHaveValue('#112233');
  });

  it('updates primaryColor when the color input changes', async () => {
    const update = vi.fn(async () => {});
    render(<AppearanceTab settings={settings()} update={update} />);
    const input = screen.getByLabelText(/accent color/i);
    await userEvent.clear(input);
    await userEvent.type(input, '#00ff00');
    expect(update).toHaveBeenLastCalledWith({ primaryColor: '#00ff00' });
  });

  it('shows the current site name and saves an edited value', async () => {
    const update = vi.fn(async () => {});
    render(<AppearanceTab settings={settings({ siteName: 'Aegis' })} update={update} />);
    const field = screen.getByRole('textbox', { name: /site name/i });
    expect(field).toHaveValue('Aegis');
    await userEvent.clear(field);
    await userEvent.type(field, 'My Browser');
    await userEvent.click(screen.getByRole('button', { name: /save site name/i }));
    expect(update).toHaveBeenCalledWith({ siteName: 'My Browser' });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/AppearanceTab.test.tsx`
Expected: FAIL — `Failed to resolve import "./AppearanceTab"`.

- [ ] **Step 3: Implement**

```tsx
// src/components/AppearanceTab.tsx
import { useState } from 'react';
import type { Settings } from '../../shared/types';

export interface AppearanceTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function AppearanceTab({ settings, update }: AppearanceTabProps) {
  const [siteName, setSiteName] = useState(settings.siteName);

  return (
    <div className="appearance-tab">
      <label className="appearance-tab__field">
        <span>Accent color</span>
        <input
          type="color"
          aria-label="Accent color"
          value={settings.primaryColor}
          onChange={(e) => void update({ primaryColor: e.target.value })}
        />
      </label>

      <div className="appearance-tab__field" role="group" aria-label="Site name">
        <label htmlFor="appearance-tab-site-name">Site name</label>
        <input
          id="appearance-tab-site-name"
          type="text"
          aria-label="Site name"
          value={siteName}
          onChange={(e) => setSiteName(e.target.value)}
        />
        <button
          type="button"
          aria-label="Save site name"
          onClick={() => void update({ siteName })}
        >
          Save
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/AppearanceTab.test.tsx`
Expected: PASS (3 tests green).

- [ ] **Step 5: Commit**

```bash
git -C /home/happyhobo/Documents/AI_Apps/Aegis add src/components/AppearanceTab.tsx src/components/AppearanceTab.test.tsx
git -C /home/happyhobo/Documents/AI_Apps/Aegis commit -m "feat(settings): AppearanceTab with accent color (live theme) and site name"
```

---

### Task 17: `SearchTab` — search engines CRUD + set default → `defaultSearchTemplate`

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SearchTab.tsx`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SearchTab.test.tsx`

Presentational, props `{ settings, update }`. Engines are identified by `id` (per §6 spec). "Set default" writes BOTH `searchEngines` (unchanged list) AND `defaultSearchTemplate` (the chosen engine's `template`) in one `update` call — this is what makes the dead `searchEngines` field functional via the already-consumed `defaultSearchTemplate`. Add/remove mutate the `searchEngines` array.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/SearchTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings, SearchEngine } from '../../shared/types';
import { SearchTab } from './SearchTab';

const engines: SearchEngine[] = [
  { id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
  { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
];

const settings = (over: Partial<Settings> = {}): Settings => ({
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: engines,
  hideChromeByDefault: false,
  ...over,
});

describe('SearchTab', () => {
  it('lists the configured search engines by name', () => {
    render(<SearchTab settings={settings()} update={vi.fn(async () => {})} />);
    expect(screen.getByText('DuckDuckGo')).toBeInTheDocument();
    expect(screen.getByText('Google')).toBeInTheDocument();
  });

  it('marks the engine whose template matches defaultSearchTemplate as default', () => {
    render(<SearchTab settings={settings()} update={vi.fn(async () => {})} />);
    expect(screen.getByRole('radio', { name: /default search engine duckduckgo/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /default search engine google/i })).not.toBeChecked();
  });

  it('setting a new default writes searchEngines + defaultSearchTemplate', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    await userEvent.click(screen.getByRole('radio', { name: /default search engine google/i }));
    expect(update).toHaveBeenCalledWith({
      searchEngines: engines,
      defaultSearchTemplate: 'https://www.google.com/search?q=%s',
    });
  });

  it('adds a new engine from the add form', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    const form = screen.getByRole('group', { name: /add search engine/i });
    await userEvent.type(within(form).getByRole('textbox', { name: /engine id/i }), 'bing');
    await userEvent.type(within(form).getByRole('textbox', { name: /engine name/i }), 'Bing');
    await userEvent.type(
      within(form).getByRole('textbox', { name: /engine template/i }),
      'https://www.bing.com/search?q=%s',
    );
    await userEvent.click(within(form).getByRole('button', { name: /^add engine$/i }));
    expect(update).toHaveBeenCalledWith({
      searchEngines: [
        ...engines,
        { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
      ],
    });
  });

  it('removes an engine via its row Remove button', async () => {
    const update = vi.fn(async () => {});
    render(<SearchTab settings={settings()} update={update} />);
    await userEvent.click(screen.getByRole('button', { name: /remove engine google/i }));
    expect(update).toHaveBeenCalledWith({ searchEngines: [engines[0]] });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/SearchTab.test.tsx`
Expected: FAIL — `Failed to resolve import "./SearchTab"`.

- [ ] **Step 3: Implement**

```tsx
// src/components/SearchTab.tsx
import { useState } from 'react';
import type { Settings, SearchEngine } from '../../shared/types';

export interface SearchTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function SearchTab({ settings, update }: SearchTabProps) {
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('');

  const engines = settings.searchEngines;

  const setDefault = (engine: SearchEngine): void => {
    void update({ searchEngines: engines, defaultSearchTemplate: engine.template });
  };

  const remove = (id: string): void => {
    void update({ searchEngines: engines.filter((e) => e.id !== id) });
  };

  const handleAdd = (): void => {
    const id = newId.trim();
    const name = newName.trim();
    const template = newTemplate.trim();
    if (id.length === 0 || name.length === 0 || template.length === 0) return;
    void update({ searchEngines: [...engines, { id, name, template }] });
    setNewId('');
    setNewName('');
    setNewTemplate('');
  };

  return (
    <div className="search-tab">
      <ul className="search-tab__list">
        {engines.map((e) => (
          <li key={e.id} className="search-tab__row">
            <label className="search-tab__default">
              <input
                type="radio"
                name="search-tab-default"
                aria-label={`Default search engine ${e.name}`}
                checked={e.template === settings.defaultSearchTemplate}
                onChange={() => setDefault(e)}
              />
              <span className="search-tab__name">{e.name}</span>
            </label>
            <span className="search-tab__template">{e.template}</span>
            <button
              type="button"
              aria-label={`Remove engine ${e.name}`}
              onClick={() => remove(e.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="search-tab__add" role="group" aria-label="Add search engine">
        <input
          type="text"
          aria-label="Engine id"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
        />
        <input
          type="text"
          aria-label="Engine name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          type="text"
          aria-label="Engine template"
          value={newTemplate}
          onChange={(e) => setNewTemplate(e.target.value)}
        />
        <button type="button" onClick={handleAdd}>
          Add engine
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/SearchTab.test.tsx`
Expected: PASS (5 tests green).

- [ ] **Step 5: Commit**

```bash
git -C /home/happyhobo/Documents/AI_Apps/Aegis add src/components/SearchTab.tsx src/components/SearchTab.test.tsx
git -C /home/happyhobo/Documents/AI_Apps/Aegis commit -m "feat(settings): SearchTab engine CRUD; default writes defaultSearchTemplate"
```

---

### Task 18: `HomeTab` — `homeUrl` editor (already-functional consumer)

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/HomeTab.tsx`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/HomeTab.test.tsx`

Per contract §1.1: `homeUrl` is ALREADY functional (the main-side `nav.home` reads `settingsRepo.get().homeUrl` live). So this tab is ONLY an editor — `update({ homeUrl })`. No consumer wiring.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/HomeTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '../../shared/types';
import { HomeTab } from './HomeTab';

const settings = (over: Partial<Settings> = {}): Settings => ({
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  ...over,
});

describe('HomeTab', () => {
  it('shows the current home URL', () => {
    render(<HomeTab settings={settings({ homeUrl: 'https://example.com/' })} update={vi.fn(async () => {})} />);
    expect(screen.getByRole('textbox', { name: /home url/i })).toHaveValue('https://example.com/');
  });

  it('saves an edited home URL', async () => {
    const update = vi.fn(async () => {});
    render(<HomeTab settings={settings()} update={update} />);
    const field = screen.getByRole('textbox', { name: /home url/i });
    await userEvent.clear(field);
    await userEvent.type(field, 'https://start.example/');
    await userEvent.click(screen.getByRole('button', { name: /save home url/i }));
    expect(update).toHaveBeenCalledWith({ homeUrl: 'https://start.example/' });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/HomeTab.test.tsx`
Expected: FAIL — `Failed to resolve import "./HomeTab"`.

- [ ] **Step 3: Implement**

```tsx
// src/components/HomeTab.tsx
import { useState } from 'react';
import type { Settings } from '../../shared/types';

export interface HomeTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function HomeTab({ settings, update }: HomeTabProps) {
  const [homeUrl, setHomeUrl] = useState(settings.homeUrl);

  return (
    <div className="home-tab" role="group" aria-label="Home URL">
      <label htmlFor="home-tab-url">Home URL</label>
      <input
        id="home-tab-url"
        type="text"
        aria-label="Home URL"
        value={homeUrl}
        onChange={(e) => setHomeUrl(e.target.value)}
      />
      <button
        type="button"
        aria-label="Save home URL"
        onClick={() => void update({ homeUrl: homeUrl.trim() })}
      >
        Save
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/HomeTab.test.tsx`
Expected: PASS (2 tests green).

- [ ] **Step 5: Commit**

```bash
git -C /home/happyhobo/Documents/AI_Apps/Aegis add src/components/HomeTab.tsx src/components/HomeTab.test.tsx
git -C /home/happyhobo/Documents/AI_Apps/Aegis commit -m "feat(settings): HomeTab editor for homeUrl (already-functional consumer)"
```

---

### Task 19: `FilterListsTab` — list + toggle + add-URL + remove + force-update-all

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/FilterListsTab.tsx`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/FilterListsTab.test.tsx`

Presentational, consuming the `useSubscriptions` return shape from §4: `{ subs, setEnabled(id,en), add(url), remove(id), updateNow() }`. `updateNow(): Promise<ListUpdateResult>` is shown per-source after a force update. HTTPS validation lives in the IPC handler (T6); the tab just submits the URL and surfaces failures via the next `ListUpdateResult`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/FilterListsTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Subscription, ListUpdateResult } from '../../shared/types';
import { FilterListsTab } from './FilterListsTab';

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  listId: 'easylist',
  url: 'https://lists.example/easylist.txt',
  enabled: true,
  lastUpdated: 1700000000000,
  etag: null,
  hash: null,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof FilterListsTab>> = {}) => ({
  subs: [
    sub({ listId: 'easylist', url: 'https://lists.example/easylist.txt', enabled: true }),
    sub({ listId: 'easyprivacy', url: 'https://lists.example/easyprivacy.txt', enabled: false }),
  ],
  setEnabled: vi.fn(async () => {}),
  add: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  updateNow: vi.fn<[], Promise<ListUpdateResult>>(async () => ({ perSource: [], lastUpdated: 0 })),
  ...over,
});

describe('FilterListsTab', () => {
  it('lists each subscription by listId and url', () => {
    render(<FilterListsTab {...props()} />);
    expect(screen.getByText('easylist')).toBeInTheDocument();
    expect(screen.getByText('https://lists.example/easylist.txt')).toBeInTheDocument();
    expect(screen.getByText('easyprivacy')).toBeInTheDocument();
  });

  it('reflects the enabled state of each list in its switch', () => {
    render(<FilterListsTab {...props()} />);
    expect(screen.getByRole('switch', { name: /enable list easylist/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /enable list easyprivacy/i })).not.toBeChecked();
  });

  it('toggling a list calls setEnabled with the inverted value', async () => {
    const p = props();
    render(<FilterListsTab {...p} />);
    await userEvent.click(screen.getByRole('switch', { name: /enable list easylist/i }));
    expect(p.setEnabled).toHaveBeenCalledWith('easylist', false);
  });

  it('adds a custom list URL from the add form', async () => {
    const p = props();
    render(<FilterListsTab {...p} />);
    const form = screen.getByRole('group', { name: /add filter list/i });
    await userEvent.type(within(form).getByRole('textbox', { name: /list url/i }), 'https://lists.example/custom.txt');
    await userEvent.click(within(form).getByRole('button', { name: /^add list$/i }));
    expect(p.add).toHaveBeenCalledWith('https://lists.example/custom.txt');
  });

  it('removes a list via its row Remove button', async () => {
    const p = props();
    render(<FilterListsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove list easyprivacy/i }));
    expect(p.remove).toHaveBeenCalledWith('easyprivacy');
  });

  it('force-update-all calls updateNow and renders the per-source results', async () => {
    const updateNow = vi.fn<[], Promise<ListUpdateResult>>(async () => ({
      perSource: [
        { listId: 'easylist', ok: true },
        { listId: 'easyprivacy', ok: false, error: 'timeout' },
      ],
      lastUpdated: 1700000001000,
    }));
    render(<FilterListsTab {...props({ updateNow })} />);
    await userEvent.click(screen.getByRole('button', { name: /update all/i }));
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/easyprivacy.*timeout/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/FilterListsTab.test.tsx`
Expected: FAIL — `Failed to resolve import "./FilterListsTab"`.

- [ ] **Step 3: Implement**

```tsx
// src/components/FilterListsTab.tsx
import { useState } from 'react';
import type { Subscription, ListUpdateResult, ListSourceResult } from '../../shared/types';

export interface FilterListsTabProps {
  subs: Subscription[];
  setEnabled(listId: string, enabled: boolean): Promise<void>;
  add(url: string): Promise<void>;
  remove(listId: string): Promise<void>;
  updateNow(): Promise<ListUpdateResult>;
}

export function FilterListsTab({ subs, setEnabled, add, remove, updateNow }: FilterListsTabProps) {
  const [newUrl, setNewUrl] = useState('');
  const [results, setResults] = useState<ListSourceResult[]>([]);
  const [updating, setUpdating] = useState(false);

  const handleAdd = (): void => {
    const url = newUrl.trim();
    if (url.length === 0) return;
    void add(url);
    setNewUrl('');
  };

  const handleUpdateAll = (): void => {
    setUpdating(true);
    void updateNow()
      .then((r) => setResults(r.perSource))
      .finally(() => setUpdating(false));
  };

  return (
    <div className="filter-lists-tab">
      <div className="filter-lists-tab__actions">
        <button type="button" disabled={updating} onClick={handleUpdateAll}>
          Update all
        </button>
      </div>

      <ul className="filter-lists-tab__list">
        {subs.map((s) => (
          <li key={s.listId} className="filter-lists-tab__row">
            <button
              type="button"
              role="switch"
              aria-checked={s.enabled}
              aria-label={`Enable list ${s.listId}`}
              onClick={() => void setEnabled(s.listId, !s.enabled)}
            >
              {s.enabled ? 'On' : 'Off'}
            </button>
            <span className="filter-lists-tab__id">{s.listId}</span>
            <span className="filter-lists-tab__url">{s.url}</span>
            <button
              type="button"
              aria-label={`Remove list ${s.listId}`}
              onClick={() => void remove(s.listId)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="filter-lists-tab__add" role="group" aria-label="Add filter list">
        <input
          type="text"
          aria-label="List URL"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
        />
        <button type="button" onClick={handleAdd}>
          Add list
        </button>
      </div>

      {results.length > 0 && (
        <ul className="filter-lists-tab__results" aria-label="Update results">
          {results.map((r) => (
            <li key={r.listId}>
              {r.listId}: {r.ok ? 'updated' : `failed — ${r.error ?? 'error'}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/FilterListsTab.test.tsx`
Expected: PASS (6 tests green).

- [ ] **Step 5: Commit**

```bash
git -C /home/happyhobo/Documents/AI_Apps/Aegis add src/components/FilterListsTab.tsx src/components/FilterListsTab.test.tsx
git -C /home/happyhobo/Documents/AI_Apps/Aegis commit -m "feat(settings): FilterListsTab list/toggle/add/remove + force-update-all"
```

---

### Task 20: `MyFiltersTab` — textarea + save + line-count

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/MyFiltersTab.tsx`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/MyFiltersTab.test.tsx`

Per contract §2.2: the "rules" figure is a CLIENT-COMPUTED count of non-empty, non-`!comment` lines (no engine-verified parsed/ignored API exists). Props are the `useCustomFilters` return shape from §4: `{ text, save(text) }`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/MyFiltersTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MyFiltersTab } from './MyFiltersTab';

describe('MyFiltersTab', () => {
  it('shows the current custom-filter text in the textarea', () => {
    render(<MyFiltersTab text={'||ads.example^\n example.com##.banner'} save={vi.fn(async () => {})} />);
    expect(screen.getByRole('textbox', { name: /custom filters/i })).toHaveValue(
      '||ads.example^\n example.com##.banner',
    );
  });

  it('counts non-empty, non-comment lines as rules', () => {
    render(
      <MyFiltersTab
        text={'! a comment\n||ads.example^\n\n example.com##.banner\n   \n! another'}
        save={vi.fn(async () => {})}
      />,
    );
    expect(screen.getByText(/2 rules/i)).toBeInTheDocument();
  });

  it('recomputes the rule count as the textarea is edited', async () => {
    render(<MyFiltersTab text="" save={vi.fn(async () => {})} />);
    expect(screen.getByText(/0 rules/i)).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: /custom filters/i }), '||a.example^\n||b.example^');
    expect(screen.getByText(/2 rules/i)).toBeInTheDocument();
  });

  it('saves the edited text on Save', async () => {
    const save = vi.fn(async () => {});
    render(<MyFiltersTab text="" save={save} />);
    await userEvent.type(screen.getByRole('textbox', { name: /custom filters/i }), '||ads.example^');
    await userEvent.click(screen.getByRole('button', { name: /save filters/i }));
    expect(save).toHaveBeenCalledWith('||ads.example^');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/MyFiltersTab.test.tsx`
Expected: FAIL — `Failed to resolve import "./MyFiltersTab"`.

- [ ] **Step 3: Implement**

```tsx
// src/components/MyFiltersTab.tsx
import { useState } from 'react';

export interface MyFiltersTabProps {
  text: string;
  save(text: string): Promise<void>;
}

/** Counts non-empty, non-`!comment` lines (the client-side "rules" figure). */
export function countRules(text: string): number {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('!')).length;
}

export function MyFiltersTab({ text, save }: MyFiltersTabProps) {
  const [draft, setDraft] = useState(text);

  return (
    <div className="my-filters-tab">
      <label htmlFor="my-filters-tab-text">Custom filters</label>
      <textarea
        id="my-filters-tab-text"
        aria-label="Custom filters"
        className="my-filters-tab__textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={12}
      />
      <div className="my-filters-tab__footer">
        <span className="my-filters-tab__count">{countRules(draft)} rules</span>
        <button type="button" aria-label="Save filters" onClick={() => void save(draft)}>
          Save
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/MyFiltersTab.test.tsx`
Expected: PASS (4 tests green).

- [ ] **Step 5: Commit**

```bash
git -C /home/happyhobo/Documents/AI_Apps/Aegis add src/components/MyFiltersTab.tsx src/components/MyFiltersTab.test.tsx
git -C /home/happyhobo/Documents/AI_Apps/Aegis commit -m "feat(settings): MyFiltersTab textarea + save + non-comment line count"
```

---

### Task 21: `AllowlistTab` — list hosts + remove + clear-all

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/AllowlistTab.tsx`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/AllowlistTab.test.tsx`

Presentational. Per contract §1.4/§2.3: `removeAllowlist`/`clearAllowlist` are DB-only; re-blocking is deferred to the next nav. The tab consumes the extended `useAdblock` shape (`state.allowlistedHosts`, `removeAllowlist(host)`, `clearAllowlist()`).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/AllowlistTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AllowlistTab } from './AllowlistTab';

const props = (over: Partial<React.ComponentProps<typeof AllowlistTab>> = {}) => ({
  hosts: ['news.example', 'shop.example'],
  removeAllowlist: vi.fn(),
  clearAllowlist: vi.fn(),
  ...over,
});

describe('AllowlistTab', () => {
  it('lists each allowlisted host', () => {
    render(<AllowlistTab {...props()} />);
    expect(screen.getByText('news.example')).toBeInTheDocument();
    expect(screen.getByText('shop.example')).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no hosts', () => {
    render(<AllowlistTab {...props({ hosts: [] })} />);
    expect(screen.getByText(/no allowlisted hosts/i)).toBeInTheDocument();
  });

  it('removes a host via its Remove button', async () => {
    const p = props();
    render(<AllowlistTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove news\.example from allowlist/i }));
    expect(p.removeAllowlist).toHaveBeenCalledWith('news.example');
  });

  it('clears all hosts via the Clear all button', async () => {
    const p = props();
    render(<AllowlistTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(p.clearAllowlist).toHaveBeenCalledTimes(1);
  });

  it('disables Clear all when the allowlist is empty', () => {
    render(<AllowlistTab {...props({ hosts: [] })} />);
    expect(screen.getByRole('button', { name: /clear all/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/AllowlistTab.test.tsx`
Expected: FAIL — `Failed to resolve import "./AllowlistTab"`.

- [ ] **Step 3: Implement**

```tsx
// src/components/AllowlistTab.tsx
export interface AllowlistTabProps {
  hosts: string[];
  removeAllowlist(host: string): void;
  clearAllowlist(): void;
}

export function AllowlistTab({ hosts, removeAllowlist, clearAllowlist }: AllowlistTabProps) {
  return (
    <div className="allowlist-tab">
      <div className="allowlist-tab__actions">
        <button type="button" disabled={hosts.length === 0} onClick={() => clearAllowlist()}>
          Clear all
        </button>
      </div>
      {hosts.length === 0 ? (
        <p className="allowlist-tab__empty">No allowlisted hosts.</p>
      ) : (
        <ul className="allowlist-tab__list">
          {hosts.map((host) => (
            <li key={host} className="allowlist-tab__row">
              <span className="allowlist-tab__host">{host}</span>
              <button
                type="button"
                aria-label={`Remove ${host} from allowlist`}
                onClick={() => removeAllowlist(host)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/AllowlistTab.test.tsx`
Expected: PASS (5 tests green).

- [ ] **Step 5: Commit**

```bash
git -C /home/happyhobo/Documents/AI_Apps/Aegis add src/components/AllowlistTab.tsx src/components/AllowlistTab.test.tsx
git -C /home/happyhobo/Documents/AI_Apps/Aegis commit -m "feat(settings): AllowlistTab list hosts + remove + clear-all"
```

---

### Task 22: App wiring — Toolbar `gear` slot + `settingsOpen` + mounted `SettingsModal` + `siteName`→`document.title` + live re-theme

**Files:**
- Modify: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Toolbar.tsx` (add `gear?: ReactNode` slot, lines ~12-33 props + ~52-56 render)
- Modify: `/home/happyhobo/Documents/AI_Apps/Aegis/src/App.tsx` (imports, `settingsOpen` state, `useSettings` for title effect, gear button into Toolbar, mounted `<SettingsModal>` wired to the hooks)
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Toolbar.test.tsx` (add a gear-slot test), `/home/happyhobo/Documents/AI_Apps/Aegis/src/App.test.tsx` (add open-settings + title + mocks for the new hooks' IPC)

This is a renderer-mount/wiring task (not naturally red-green): show the FULL edited code, verify via the component/App tests, then commit. The `SettingsModal` is wired here to all four Block-C hooks (`useSettings`, `useSubscriptions`, `useCustomFilters`, and the extended `useAdblock` allowlist methods). Because `useSettings.update` already re-applies the theme and sets `document.title` from `siteName` (per §4), App's only extra responsibility is the **initial** `document.title = settings.siteName` effect; the existing mount-time `applyTheme` stays.

- [ ] **Step 1: Add the failing Toolbar gear-slot test**

Append this test to `src/components/Toolbar.test.tsx` (inside the existing `describe('Toolbar', …)` block, after the bookmark-slot test):

```tsx
  it('renders the optional gear slot when provided', () => {
    render(
      <Toolbar
        state={state}
        {...handlers()}
        gear={<button type="button">Open settings</button>}
      />,
    );
    expect(screen.getByRole('button', { name: /open settings/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the Toolbar test, verify the new case fails**

Run: `npx vitest run src/components/Toolbar.test.tsx`
Expected: FAIL on "renders the optional gear slot when provided" — the `gear` prop does not exist, so the button is never rendered (`Unable to find an accessible element with the role "button" and name /open settings/i`). The pre-existing Toolbar cases still pass.

- [ ] **Step 3: Implement the Toolbar `gear` slot (full edited file)**

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
  /** Optional toolbar slot for the Settings gear button (Phase 4). */
  gear?: ReactNode;
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
  gear,
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
      {gear}
    </div>
  );
}
```

- [ ] **Step 4: Run the Toolbar test, verify it passes**

Run: `npx vitest run src/components/Toolbar.test.tsx`
Expected: PASS (all prior cases + the new gear-slot case green).

- [ ] **Step 5: Wire App — full edited `src/App.tsx`**

Adds: `useSettings` import + a title effect (`document.title = settings.siteName`), the `useSubscriptions`/`useCustomFilters` hooks + the extended `useAdblock` allowlist methods, a `settingsOpen` state, a gear button passed into the Toolbar `gear` slot, and the mounted `SettingsModal` wired to all tabs. The existing `applyTheme`-at-mount effect stays; live re-theme is handled by `useSettings.update`.

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
import { useSettings } from './hooks/useSettings';
import { useSubscriptions } from './hooks/useSubscriptions';
import { useCustomFilters } from './hooks/useCustomFilters';
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
import { SettingsModal } from './components/SettingsModal';
import { AppearanceTab } from './components/AppearanceTab';
import { SearchTab } from './components/SearchTab';
import { HomeTab } from './components/HomeTab';
import { FilterListsTab } from './components/FilterListsTab';
import { MyFiltersTab } from './components/MyFiltersTab';
import { AllowlistTab } from './components/AllowlistTab';

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
  const settings = useSettings();
  const subscriptions = useSubscriptions();
  const customFilters = useCustomFilters();
  const [failed, setFailed] = useState<NavFailed | null>(null);
  const [crashed, setCrashed] = useState<NavCrashed | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Favorites bar is always-on in Phase 3; only the sidebar toggles the inset.
  useContentInset(PRIMARY_VIEW_ID, { sidebarOpen });

  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
  }, []);

  // Make `siteName` functional: reflect it as the document title. `useSettings`
  // also sets it on every update; this effect covers the initial load + edits.
  useEffect(() => {
    document.title = settings.settings.siteName;
  }, [settings.settings.siteName]);

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
        gear={
          <button
            type="button"
            className="toolbar__gear"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            {'⚙'}
          </button>
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
        saved={
          <SavedPanel
            items={saved.items}
            remove={(id) => void saved.remove(id)}
            onOpen={(url) => void nav.navigate(url)}
          />
        }
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
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          appearance={<AppearanceTab settings={settings.settings} update={settings.update} />}
          search={<SearchTab settings={settings.settings} update={settings.update} />}
          home={<HomeTab settings={settings.settings} update={settings.update} />}
          filterLists={
            <FilterListsTab
              subs={subscriptions.subs}
              setEnabled={subscriptions.setEnabled}
              add={subscriptions.add}
              remove={subscriptions.remove}
              updateNow={subscriptions.updateNow}
            />
          }
          myFilters={<MyFiltersTab text={customFilters.text} save={customFilters.save} />}
          allowlist={
            <AllowlistTab
              hosts={adblock.state.allowlistedHosts}
              removeAllowlist={adblock.removeAllowlist}
              clearAllowlist={adblock.clearAllowlist}
            />
          }
        />
      )}
      <WelcomeHint />
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
```

- [ ] **Step 6: Extend the App test — IPC mocks for the new hooks + open-settings + title cases**

The App test mocks `./lib/ipcClient`; the new hooks (`useSettings`, `useSubscriptions`, `useCustomFilters`) call `aegis.settings.*`, `aegis.subs.*`, `aegis.customFilters.*`, and the extended `useAdblock` calls `aegis.adblock.removeAllowlist/clearAllowlist`. Extend the existing mock object and add three new test cases.

First, extend the mock. In `src/App.test.tsx`, replace the existing `settings:` mock line and the `adblock:` mock block, and add `subs`/`customFilters` namespaces. Apply these three edits:

Edit 1 — replace the settings mock line:
```tsx
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
```
with:
```tsx
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
    subs: {
      list: vi.fn(async () => []),
      setEnabled: vi.fn(async () => []),
      add: vi.fn(async () => []),
      remove: vi.fn(async () => []),
    },
    customFilters: {
      get: vi.fn(async () => ''),
      set: vi.fn(async () => ''),
    },
```

Edit 2 — replace the adblock mock block:
```tsx
    adblock: {
      getState: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      setEnabled: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      toggleAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      onBlockedCount: vi.fn().mockReturnValue(() => {}),
    },
```
with:
```tsx
    adblock: {
      getState: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      setEnabled: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      toggleAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      removeAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      clearAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      onBlockedCount: vi.fn().mockReturnValue(() => {}),
    },
```

Edit 3 — add these three cases at the end of the `describe('App', …)` block (before its closing `});`):
```tsx
  it('opens the Settings modal from the toolbar gear button', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /open settings/i }));
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument();
  });

  it('does not mount the Settings modal until the gear is clicked', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: /open settings/i })).toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: /settings/i })).not.toBeInTheDocument();
  });

  it('reflects the configured siteName in the document title', async () => {
    render(<App />);
    await waitFor(() => expect(document.title).toBe('Aegis'));
  });
```

- [ ] **Step 7: Run the App test, verify it passes**

Run: `npx vitest run src/App.test.tsx`
Expected: PASS (all prior App cases + the three new cases green). The new hooks resolve their IPC against the extended mock; the gear opens the dialog; `document.title` is `'Aegis'` from `baseSettings.siteName`.

- [ ] **Step 8: Verify the whole renderer suite + production typecheck**

Run: `npx vitest run src/`
Expected: PASS — no regression across the renderer unit suite (all tab components, `SettingsModal`, `Toolbar`, `App`, and the Block-C hooks).

Run: `npx tsc --noEmit 2>&1 | grep -E "src/App.tsx|src/components/(Toolbar|SettingsModal|AppearanceTab|SearchTab|HomeTab|FilterListsTab|MyFiltersTab|AllowlistTab)\.tsx" || echo "no production-file errors in Block-D files"`
Expected: `no production-file errors in Block-D files` (the known pre-existing test-file baseline noted in the contract is accepted; this grep confirms no NEW production-file error was introduced by the wiring).

- [ ] **Step 9: Commit**

```bash
git -C /home/happyhobo/Documents/AI_Apps/Aegis add src/App.tsx src/App.test.tsx src/components/Toolbar.tsx src/components/Toolbar.test.tsx
git -C /home/happyhobo/Documents/AI_Apps/Aegis commit -m "feat(settings): wire SettingsModal into App via toolbar gear + siteName title effect"
```

---

#### New names introduced (Block D)

- `SettingsModal` (component), `SettingsModalProps` (interface) — `src/components/SettingsModal.tsx`
- `AppearanceTab` (component), `AppearanceTabProps` (interface) — `src/components/AppearanceTab.tsx`
- `SearchTab` (component), `SearchTabProps` (interface) — `src/components/SearchTab.tsx`
- `HomeTab` (component), `HomeTabProps` (interface) — `src/components/HomeTab.tsx`
- `FilterListsTab` (component), `FilterListsTabProps` (interface) — `src/components/FilterListsTab.tsx`
- `MyFiltersTab` (component), `MyFiltersTabProps` (interface), `countRules` (function) — `src/components/MyFiltersTab.tsx`
- `AllowlistTab` (component), `AllowlistTabProps` (interface) — `src/components/AllowlistTab.tsx`
- `ToolbarProps.gear` (new optional `gear?: ReactNode` member on the existing `ToolbarProps` interface) — `src/components/Toolbar.tsx`

I now have all verified facts. Key constraints for my e2e specs:

- For my-filters network blocking I'll reuse `ad-page-b.html` + `/ads/tracker.js^` rule, but it requires caches to exist (cache-rebuild appends customFilters). The cleanest hermetic approach per the contract caveat: run an `updateNow` against `LIST_BASE` first so caches exist, then set custom filters and `rebuildEngineFromCache`. But the LIST_BASE fixture (`easylist.txt`) already blocks `/ads/tracker.js`. So for the my-filters network test I need a target NOT already blocked by the fixture list. I'll use the cosmetic sentinel fixture for the my-filters proof (cosmetic rule `127.0.0.1##.aegis-ad-sentinel`), which is clean and the fixture list has no cosmetic rules. For the network proof I'll set a custom network filter that blocks `/ads/banner.js^` against `ad-page.html` (the fixture `easylist.txt` only blocks tracker.js, so banner.js proves the custom rule took effect via cache-rebuild + customFilters append).

Let me confirm the contract's `rebuildFromCache`/`updateNow`/`customFiltersRepo`/`subsRepo`/`settingsRepo` registry naming under `phase4`, and whether `adblock.controller.removeAllowlist` is the path. The contract §4/Task 9 says expose under a `phase4` registry. I'll write the e2e to use `__aegisTest.phase4.{settingsRepo,subsRepo,customFiltersRepo,rebuildFromCache,updateNow}` and `__aegisTest.adblock.controller.{toggleAllowlist,removeAllowlist,clearAllowlist,getState}`.

Now I'll produce the markdown for Tasks 23-26.

### Task 23: e2e — settings round-trip, persistence across relaunch, and homeUrl→nav.home

**Files:**
- Create: `electron/test/e2e/settings.spec.ts`
- Test: `electron/test/e2e/settings.spec.ts`

This is an e2e task: show the FULL spec, then run via the Electron-ABI commands. It drives the main process exclusively through the `__aegisTest` registry (the `phase4` entry added in Task 9 — `settingsRepo`, `subsRepo`, `customFiltersRepo`, `rebuildFromCache`, `updateNow` — plus the existing `primary` and `adblock`), with NO chrome-DOM, mirroring `persistence.spec.ts`.

- [ ] **Step 1: Write the failing test (the full spec)**

```ts
// electron/test/e2e/settings.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { Settings, Subscription, NavState } from '../../../shared/types';

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

/** Launch the built app with the test-only registry on, then wait for first nav to settle. */
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

function settingsGet(app: ElectronApplication): Promise<Settings> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.settingsRepo.get());
}

function settingsSet(
  app: ElectronApplication,
  partial: Partial<Settings>,
): Promise<Settings> {
  return app.evaluate(
    (_e, p) => (globalThis as any).__aegisTest.phase4.settingsRepo.set(p),
    partial,
  );
}

function subsAdd(app: ElectronApplication, url: string): Promise<Subscription[]> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.phase4.subsRepo.add(u);
    return (globalThis as any).__aegisTest.phase4.subsRepo.all();
  }, url);
}

function subsAll(app: ElectronApplication): Promise<Subscription[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.subsRepo.all());
}

function customFiltersGet(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.customFiltersRepo.get());
}

function customFiltersSet(app: ElectronApplication, text: string): Promise<string> {
  return app.evaluate((_e, t) => {
    (globalThis as any).__aegisTest.phase4.customFiltersRepo.set(t);
    return (globalThis as any).__aegisTest.phase4.customFiltersRepo.get();
  }, text);
}

/** Trigger a top-frame navigation (used to apply the engine swap + exercise nav.home). */
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

test('settings round-trip: accent color, custom list, my-filters survive an app restart (Phase-4 §11.9)', async () => {
  // ONE userData dir reused across two launches (persistence proof, spec §11.9).
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-settings-persist-'));
  const customUrl = `${fixtures.baseUrl}/lists/custom-e2e.txt`;
  const accent = '#00ff88';
  const myFilters = '! e2e my-filters blob\n127.0.0.1##.aegis-ad-sentinel\n/ads/banner.js^';

  // app1: write an accent color, add a custom list URL, and save a my-filters blob.
  const app1 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Accent color edit (Appearance tab → settings.set({ primaryColor })).
    await settingsSet(app1, { primaryColor: accent });
    expect((await settingsGet(app1)).primaryColor).toBe(accent);

    // Add a custom HTTPS-equivalent (loopback http allowed by the guard) list URL.
    const afterAdd = await subsAdd(app1, customUrl);
    expect(afterAdd.some((s) => s.url === customUrl)).toBe(true);

    // Save a my-filters blob.
    const savedText = await customFiltersSet(app1, myFilters);
    expect(savedText).toBe(myFilters);
  } finally {
    await app1.close();
  }

  // app2: SAME userData dir → every value must restore from SQLite.
  const app2 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await settingsGet(app2)).primaryColor, { timeout: 15000 })
      .toBe(accent);

    await expect
      .poll(async () => (await subsAll(app2)).some((s) => s.url === customUrl), { timeout: 15000 })
      .toBe(true);

    await expect
      .poll(async () => await customFiltersGet(app2), { timeout: 15000 })
      .toBe(myFilters);
  } finally {
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing homeUrl makes nav.home navigate to the configured URL (spec §11.4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-settings-home-'));
  const homeTarget = `${fixtures.baseUrl}/spa.html`;
  // Boot to about:blank so the configured homeUrl is provably what nav.home resolves.
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Edit homeUrl via the settings repo (Home tab editor).
    await settingsSet(app, { homeUrl: homeTarget });
    expect((await settingsGet(app)).homeUrl).toBe(homeTarget);

    // nav.home resolves settingsRepo.get().homeUrl live (contract §1.1). Invoke it via the
    // phase4 registry's navHome (defined once in Task 9) and assert the top frame navigates.
    await app.evaluate(() => {
      (globalThis as any).__aegisTest.phase4.navHome();
    });
    await expect.poll(async () => (await state(app)).url, { timeout: 15000 }).toBe(homeTarget);
    await expect.poll(async () => (await state(app)).isLoading, { timeout: 15000 }).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test (registry exists from Task 9 — expect PASS directly)**

Run (Electron ABI; build first since this is the first Block-E e2e):
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/settings.spec.ts
```
Expected: PASS. The `__aegisTest.phase4` registry (`settingsRepo`/`subsRepo`/`customFiltersRepo`/`rebuildFromCache`/`updateNow`/`navHome`) is defined once in Task 9 (boot wiring), and the settings/subs/customFilters IPC + preload exist from Blocks A–B. This is a pure e2e task exercising that wiring.

- [ ] **Step 3: Implement — none (consume-only)**

No production code in this task. Do NOT edit `electron/main/index.ts` — the `phase4` registry is owned by Task 9 (review-driven correction #1). This spec only CONSUMES `__aegisTest.phase4.{settingsRepo,subsRepo,customFiltersRepo,rebuildFromCache,updateNow,navHome}` + `__aegisTest.primary`. If a registry field is missing, fix Task 9, not here.

- [ ] **Step 4: Run the test, verify it passes**

Run (build already done in Step 2; rebuild only if the ABI was switched since):
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/settings.spec.ts
```
Expected: PASS — both tests green (round-trip + persistence across relaunch; homeUrl→nav.home navigates to the configured target).

- [ ] **Step 5: Commit**

```
cd /home/happyhobo/Documents/AI_Apps/Aegis && git add electron/test/e2e/settings.spec.ts electron/main/index.ts && git commit -m "test(e2e): settings round-trip, cross-relaunch persistence, homeUrl->nav.home"
```

---

### Task 24: e2e — filter-lists toggle rebuilds-from-cache + add/remove custom list

**Files:**
- Create: `electron/test/e2e/filterlists.spec.ts`
- Test: `electron/test/e2e/filterlists.spec.ts`

e2e task: full spec. Proves (1) after a real `updateNow` against the `LIST_BASE` fixture the caches populate and the fixture list (`/ads/tracker.js^`) blocks ad B; (2) disabling that list then `rebuildEngineFromCache()` + nav stops blocking ad B (the `enabled` column is now READ — the wiring gap is closed); (3) `subsRepo.add(url)` / `subsRepo.remove(listId)` reflect in `subsRepo.all()`. Drives via `__aegisTest.phase4` + `__aegisTest.adblock`.

- [ ] **Step 1: Write the failing test (the full spec)**

```ts
// electron/test/e2e/filterlists.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, Subscription, ListUpdateResult } from '../../../shared/types';

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
          return '';
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

function adLoaded(app: ElectronApplication, prop: string): Promise<boolean> {
  return app.evaluate(
    (_e, p) =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        `window.${p}`,
        true,
      ),
    prop,
  );
}

function updateNow(app: ElectronApplication): Promise<ListUpdateResult> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.updateNow());
}

function subsAll(app: ElectronApplication): Promise<Subscription[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.subsRepo.all());
}

function subsSetEnabled(
  app: ElectronApplication,
  listId: string,
  enabled: boolean,
): Promise<Subscription[]> {
  return app.evaluate(
    (_e, a) => {
      (globalThis as any).__aegisTest.phase4.subsRepo.setEnabled(a.listId, a.enabled);
      return (globalThis as any).__aegisTest.phase4.subsRepo.all();
    },
    { listId, enabled },
  );
}

function subsAdd(app: ElectronApplication, url: string): Promise<Subscription[]> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.phase4.subsRepo.add(u);
    return (globalThis as any).__aegisTest.phase4.subsRepo.all();
  }, url);
}

function subsRemove(app: ElectronApplication, listId: string): Promise<Subscription[]> {
  return app.evaluate((_e, id) => {
    (globalThis as any).__aegisTest.phase4.subsRepo.remove(id);
    return (globalThis as any).__aegisTest.phase4.subsRepo.all();
  }, listId);
}

function rebuildFromCache(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    (globalThis as any).__aegisTest.phase4.rebuildFromCache();
  });
}

test('disabling a list rebuilds-from-cache WITHOUT its rules (the enabled column is now read)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-filterlists-toggle-'));
  // LIST_BASE serves the fixture easylist (blocks /ads/tracker.js^). No TEST_FILTER, so
  // the initial engine is the bundled snapshot; updateNow fetches the fixture list and
  // populates the per-listId caches that rebuildEngineFromCache reads.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_LIST_BASE: `${fixtures.baseUrl}/lists`,
  });
  try {
    // 1) Real fetch: every default source resolves ok (fixtureServer aliases <id>.txt).
    const result = await updateNow(app);
    expect(result.perSource.length).toBeGreaterThan(0);
    expect(result.perSource.every((s) => s.ok === true)).toBe(true);

    // After the swap (applied on next nav) ad B is blocked by the fetched fixture list.
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(false); // blocked

    // 2) Disable EVERY subscription, then cache-rebuild. With no enabled rows the
    //    rebuilt engine has only custom filters (empty) → ad B is no longer blocked.
    const rows = await subsAll(app);
    for (const r of rows) {
      await subsSetEnabled(app, r.listId, false);
    }
    expect((await subsAll(app)).every((s) => s.enabled === false)).toBe(true);
    await rebuildFromCache(app);

    // The cache-rebuilt engine swaps in on the next navigation (deferred swap, §1.2).
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(true); // NOT blocked anymore

    // 3) Re-enable, cache-rebuild, navigate → blocking returns from cache (no re-fetch).
    for (const r of rows) {
      await subsSetEnabled(app, r.listId, true);
    }
    await rebuildFromCache(app);
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(false); // blocked again
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adding then removing a custom list URL reflects in subsRepo.all()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-filterlists-addremove-'));
  const customUrl = `${fixtures.baseUrl}/lists/my-custom-list.txt`;
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_OFFLINE: '1', // no auto-refresh needed; we only mutate the repo
  });
  try {
    const before = await subsAll(app);
    expect(before.some((s) => s.url === customUrl)).toBe(false);

    // add → present in all(), enabled by default.
    const afterAdd = await subsAdd(app, customUrl);
    const added = afterAdd.find((s) => s.url === customUrl);
    expect(added).toBeDefined();
    expect(added!.enabled).toBe(true);

    // remove (by the derived listId) → gone from all().
    const afterRemove = await subsRemove(app, added!.listId);
    expect(afterRemove.some((s) => s.url === customUrl)).toBe(false);
    // The original defaults are untouched.
    expect(afterRemove.length).toBe(before.length);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run (ABI is already Electron from Task 23; no rebuild needed unless a Node-ABI step ran in between):
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/filterlists.spec.ts
```
Expected: FAIL — the first test's re-navigation after disabling still blocks ad B (`expect(__trackerLoaded).toBe(true)` fails, received `false`) UNLESS `runRefresh`/`rebuildEngineFromCache` read `subsRepo.all().filter(enabled)`; and `subsRepo.setEnabled`/`add`/`remove` are `undefined` until Task 2 + Task 9 land — `TypeError: ...setEnabled is not a function`.

- [ ] **Step 3: Implement**

No new code is introduced by this task beyond what Blocks A–B–D already deliver (Task 2 `SubsRepo.setEnabled/add/remove`, Task 5 enabled-only refresh helpers, Task 9 `rebuildEngineFromCache` + the `phase4` registry from Task 23). This spec is the integration assertion that those pieces are wired correctly end-to-end. If Step 2 still fails after those tasks are merged, the failure is a genuine wiring defect (e.g. `runRefresh` still sourcing `DEFAULT_LIST_URLS` instead of `subsRepo.all()`, or `rebuildEngineFromCache` ignoring the `enabled` flag) and must be fixed in the relevant Block-A/B file rather than here. No code change is made inside this task's file beyond the spec itself.

- [ ] **Step 4: Run the test, verify it passes**

Run:
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/filterlists.spec.ts
```
Expected: PASS — toggling rebuilds-from-cache (ad B blocked → unblocked → blocked again), and add/remove reflect in `subsRepo.all()`.

- [ ] **Step 5: Commit**

```
cd /home/happyhobo/Documents/AI_Apps/Aegis && git add electron/test/e2e/filterlists.spec.ts && git commit -m "test(e2e): filter-lists toggle rebuilds-from-cache + add/remove custom list"
```

---

### Task 25: e2e — my-filters (cosmetic + network) take effect + allowlist remove/clear in AdblockState

**Files:**
- Create: `electron/test/e2e/myfilters.spec.ts`
- Test: `electron/test/e2e/myfilters.spec.ts`

e2e task: full spec. Proves (1) a custom **cosmetic** my-filter (`127.0.0.1##.aegis-ad-sentinel`) hides a fixture element after `customFiltersRepo.set` + `rebuildEngineFromCache` + nav (the merge path `buildEngine([...listTexts, customFilters], resources)`); (2) a custom **network** my-filter (`/ads/banner.js^`) blocks a request `ad-page.html` issues, that the fixture list does NOT block; (3) `controller.removeAllowlist`/`clearAllowlist` reflect in the returned `AdblockState`. Reuses the Phase-2 cosmetic poll approach. Per the contract caveat, caches must exist first, so we run a real `updateNow` against `LIST_BASE` before cache-rebuilding.

- [ ] **Step 1: Write the failing test (the full spec)**

```ts
// electron/test/e2e/myfilters.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, AdblockState, ListUpdateResult } from '../../../shared/types';

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
          return '';
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

/** Read a JS expression in the content view's MAIN world. */
function readContent<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(
    (_e, e) =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(e, true),
    expr,
  );
}

function adLoaded(app: ElectronApplication, prop: string): Promise<boolean> {
  return app.evaluate(
    (_e, p) =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        `window.${p}`,
        true,
      ),
    prop,
  );
}

function updateNow(app: ElectronApplication): Promise<ListUpdateResult> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.updateNow());
}

function setCustomFilters(app: ElectronApplication, text: string): Promise<string> {
  return app.evaluate((_e, t) => {
    (globalThis as any).__aegisTest.phase4.customFiltersRepo.set(t);
    return (globalThis as any).__aegisTest.phase4.customFiltersRepo.get();
  }, text);
}

function rebuildFromCache(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    (globalThis as any).__aegisTest.phase4.rebuildFromCache();
  });
}

test('a custom COSMETIC my-filter hides a fixture element after rebuild (merge path proven)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-myfilters-cosmetic-'));
  // LIST_BASE so updateNow populates caches; the fixture list has NO cosmetic rules,
  // so any hiding must come from the merged custom-filters text.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_LIST_BASE: `${fixtures.baseUrl}/lists`,
  });
  try {
    // Populate the per-listId caches (rebuildEngineFromCache reads them).
    const result = await updateNow(app);
    expect(result.perSource.every((s) => s.ok === true)).toBe(true);

    // Baseline: with no custom filters the sentinel is visible (300x250 red block).
    await navigateAndSettle(app, `${fixtures.baseUrl}/cosmetic/sentinel.html`);
    const baselineDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('.aegis-ad-sentinel')).display",
    );
    expect(baselineDisplay).not.toBe('none');

    // Save a domain-scoped cosmetic my-filter (domain-scoped, NOT generic — contract §1.3
    // caveat: generic bare ##.x depends on loadGenericCosmeticsFilters; 127.0.0.1##.x is
    // unaffected). Then cache-rebuild → engine = [cached list texts, customFilters].
    await setCustomFilters(app, '127.0.0.1##.aegis-ad-sentinel');
    await rebuildFromCache(app);

    // The rebuilt engine swaps on the next nav; cosmetic CSS injects asynchronously.
    await navigateAndSettle(app, `${fixtures.baseUrl}/cosmetic/sentinel.html`);
    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('.aegis-ad-sentinel')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('none');

    // The non-ad content marker stays visible (rule is scoped, not a blanket hide).
    const markerDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#content-marker')).display",
    );
    expect(markerDisplay).not.toBe('none');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a custom NETWORK my-filter blocks a request the fixture list allows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-myfilters-network-'));
  // The fixture easylist blocks /ads/tracker.js^ only — it does NOT block /ads/banner.js.
  // So blocking banner.js after a my-filters save proves the custom rule was merged in.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_LIST_BASE: `${fixtures.baseUrl}/lists`,
  });
  try {
    const result = await updateNow(app);
    expect(result.perSource.every((s) => s.ok === true)).toBe(true);

    // Baseline: ad-page.html sets window.__adLoaded=false then loads /ads/banner.js, which
    // sets window.__adLoaded=true when it runs. The fixture easylist blocks /ads/tracker.js
    // only — NOT banner.js — so banner.js loads and the marker becomes true.
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    expect(await adLoaded(app, '__adLoaded')).toBe(true); // NOT blocked by the fixture list

    // Save a custom network my-filter that blocks banner.js, then cache-rebuild.
    await setCustomFilters(app, '/ads/banner.js^');
    await rebuildFromCache(app);

    // The merged engine swaps on the next nav → banner.js is blocked → marker stays false.
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    expect(await adLoaded(app, '__adLoaded')).toBe(false); // blocked by the custom rule
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowlist removeAllowlist/clearAllowlist are reflected in AdblockState', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-myfilters-allowlist-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_OFFLINE: '1',
  });
  try {
    // Seed three allowlisted hosts via the existing toggle (add half).
    const hosts = ['a.example', 'b.example', 'c.example'];
    for (const h of hosts) {
      await app.evaluate(
        (_e, host) => (globalThis as any).__aegisTest.adblock.controller.toggleAllowlist(host),
        h,
      );
    }
    let st: AdblockState = await app.evaluate(() =>
      (globalThis as any).__aegisTest.adblock.controller.getState(),
    );
    for (const h of hosts) expect(st.allowlistedHosts).toContain(h);

    // removeAllowlist(one host) → returns AdblockState without that host; others remain.
    st = await app.evaluate(
      (_e, host) => (globalThis as any).__aegisTest.adblock.controller.removeAllowlist(host),
      'b.example',
    );
    expect(st.allowlistedHosts).not.toContain('b.example');
    expect(st.allowlistedHosts).toContain('a.example');
    expect(st.allowlistedHosts).toContain('c.example');

    // clearAllowlist() → returns AdblockState with an empty allowlist.
    st = await app.evaluate(() =>
      (globalThis as any).__aegisTest.adblock.controller.clearAllowlist(),
    );
    expect(st.allowlistedHosts).toEqual([]);
    expect(st.enabled).toBe(true); // global enabled state untouched by allowlist ops
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run:
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/myfilters.spec.ts
```
Expected: FAIL — `__aegisTest.phase4.customFiltersRepo`/`rebuildFromCache` undefined, and `controller.removeAllowlist`/`clearAllowlist` are not functions, until Block A (Task 4) + Block B (Task 9) land. After those, if a my-filter still does not take effect the failure is a real merge defect in `rebuildEngineFromCache` (must append `customFiltersRepo.get()` to the `buildEngine` text list).

- [ ] **Step 3: Implement**

No new production code in this task. The cosmetic/network merge (`buildEngine([...cachedListTexts, customFiltersRepo.get()], resources)` in `rebuildEngineFromCache`), the `customFiltersRepo`/`rebuildFromCache` registry exposure, and `AdblockController.removeAllowlist/clearAllowlist` are delivered by Tasks 4 and 9. This spec is the integration assertion. If a sub-assertion fails, fix the responsible Block-A/B file (e.g. `electron/main/index.ts` `rebuildEngineFromCache`, or `electron/main/adblock/controller.ts`), not this spec. The only edits inside this task are to the spec file itself.

Note on the fixture assumption: the network test asserts `banner.js` sets `window.__adLoaded = true` when it executes. Confirm the fixture before relying on it:
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && grep -n "__adLoaded" electron/test/fixtures/ads/banner.js electron/test/fixtures/ad-page.html
```
If `banner.js` does not set `__adLoaded = true`, add that single line to `electron/test/fixtures/ads/banner.js` (`window.__adLoaded = true;`) as part of this commit so the "loaded vs blocked" probe is real, mirroring how `tracker.js` sets `window.__trackerLoaded = true`.

- [ ] **Step 4: Run the test, verify it passes**

Run:
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx playwright test electron/test/e2e/myfilters.spec.ts
```
Expected: PASS — cosmetic hide lands, custom network rule blocks banner.js, allowlist remove/clear reflected in `AdblockState`.

- [ ] **Step 5: Commit**

```
cd /home/happyhobo/Documents/AI_Apps/Aegis && git add electron/test/e2e/myfilters.spec.ts electron/test/fixtures/ads/banner.js && git commit -m "test(e2e): my-filters cosmetic+network merge take effect; allowlist remove/clear in AdblockState"
```

(If `banner.js` already set `__adLoaded = true`, drop it from the `git add` and commit only the spec.)

---

### Task 26: full dual-ABI regression gate (all Phase 0–4 unit + e2e green)

**Files:**
- (No source files created/modified — this task runs and records the full gate. A `tsc --noEmit` baseline check is included.)

This is a gate task: run the complete Node-ABI unit suite, then the Electron-ABI build + e2e suite, and confirm everything (Phases 0–3 + all Phase-4 additions) is green with no regression. Per the contract §1.5 the two ABIs require separate rebuilds, so they run in sequence.

- [ ] **Step 1: Establish the verification commands (no test code to write)**

The gate is the project's own scripts (contract §1.5):
- Unit (Node ABI): `npm test` (its `pretest` runs `npm run rebuild:node`, then `vitest run`).
- e2e (Electron ABI): `npm run build && npm run test:e2e` (its `pretest:e2e` runs `npm run rebuild:electron && npm run build`; `test:e2e` runs `playwright test`).
- Type baseline: `npx tsc --noEmit` must introduce no NEW production-file error (the known test-file baseline established in Task 22 is accepted).

- [ ] **Step 2: Run the unit gate, verify it passes (Node ABI)**

Run:
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm test 2>&1 | tail -40
```
Expected: PASS — the full vitest suite green, including the Phase-4 additions (SubsRepo `setEnabled/add/remove`, `CustomFiltersRepo` + `custom_filters` migration, `AdblockRepo`/`AdblockController` `removeAllowlist/clearAllowlist`, the refresh helpers, the IPC builders, the renderer hooks, `SettingsModal` + tabs, the `Toolbar` gear slot). Read the final `Test Files … passed` / `Tests … passed` line and confirm `0 failed`.

- [ ] **Step 3: Run the type-baseline check**

Run:
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npx tsc --noEmit 2>&1 | grep -E '\.(ts|tsx)\(' | grep -v -E 'test\.(ts|tsx)|\.spec\.ts' || echo "NO NEW PRODUCTION TS ERRORS"
```
Expected: prints `NO NEW PRODUCTION TS ERRORS` (no production `.ts`/`.tsx` diagnostics; the accepted baseline is test-file-only, per Task 22).

- [ ] **Step 4: Run the e2e gate, verify it passes (Electron ABI)**

Run (this rebuilds for Electron and builds before running all specs, including the three new Phase-4 specs):
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npm run test:e2e 2>&1 | tail -50
```
Expected: PASS — every spec in `electron/test/e2e/` green, including `settings.spec.ts`, `filterlists.spec.ts`, `myfilters.spec.ts`, and all Phase 0–3 specs (`sandbox`, `nav`, `boot`, `window`, `adblock`, `adblockLists`, `adblockToggle`, `cosmetic`, `antiadblock`, `popup`, `chromeLockdown`, `sidebar`, `favorites`, `history`, `saved`, `persistence`). Read the Playwright summary line and confirm `N passed` with `0 failed`.

If any spec fails, STOP and fix the responsible source (do not weaken a test); re-run the affected suite before re-running the full gate.

- [ ] **Step 5: Commit (gate-pass marker, only after BOTH suites are observed green)**

Only commit after Steps 2 and 4 have both been run and their real output shows zero failures. There is no source change in this task; record the gate pass with an empty commit so the branch history marks the Phase-4 exit:
```
cd /home/happyhobo/Documents/AI_Apps/Aegis && git commit --allow-empty -m "test: Phase-4 full dual-ABI regression gate green (unit + e2e)"
```

(LOCAL commit on branch `phase-4` only — never push/remote/branch-rename.)

---

#### New names introduced (Block E)

- `electron/test/e2e/settings.spec.ts` (e2e spec file)
- `electron/test/e2e/filterlists.spec.ts` (e2e spec file)
- `electron/test/e2e/myfilters.spec.ts` (e2e spec file)
- `__aegisTest.phase4` registry entry (in `electron/main/index.ts`): `{ settingsRepo, subsRepo, customFiltersRepo, rebuildFromCache, updateNow, navHome }` — where `rebuildFromCache` aliases `rebuildEngineFromCache` and `navHome: () => vc.navigate(settingsRepo.get().homeUrl)`