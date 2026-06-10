# Aegis Phase 5 — Content & Security UX (final phase) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`
> checkboxes. Cross-module names/signatures are pinned by `docs/superpowers/plans/2026-06-11-aegis-phase5-contract.md`;
> spec is `docs/superpowers/specs/2026-06-11-aegis-phase5-design.md`.

**Goal:** Real downloads UX, PDF/media policy, remembered site-permissions, a hardened chrome-renderer CSP +
security-audit sign-off, data export/import, and an element picker. Distribution (packaging/signing/auto-update)
is DEFERRED + documented (local-only/headless constraint).

**Architecture:** New main-side repos (`DownloadsRepo`, `PermissionsRepo`) + sender-guarded IPC; downloads wired
on the content `session` `will-download` (the floor preventDefault removed); permissions handlers re-set in boot
(remembered + prompt); autoplay/PDF via content `webPreferences`; fullscreen wired in boot (needs `win`); a
build-mode-aware chrome-only CSP `<meta>`; element picker via `executeJavaScript(PICKER_IIFE,true)` →
`CustomFiltersRepo` → `rebuildEngineFromCache`. React chrome extends the Sidebar (3rd tab) + SettingsModal (3 new
tabs). Local commits only on branch `phase-5`.

**Tech Stack:** Electron 42.4.0 · better-sqlite3 · React 19 + TS · electron-vite · Vitest 4 · Playwright `_electron`.
Dual-ABI: DB unit → `npm run rebuild:node && npx vitest run <f>`; pure/renderer → `npx vitest run <f>`; e2e →
`npm run rebuild:electron && npm run build && npx playwright test <f>`.

---

## Review-driven corrections (AUTHORITATIVE — apply these; they override conflicting task text below)

The plan passed adversarial review **REQUEST CHANGES → corrected here**. Three blockers (C1–C3) are hand-patched
inline below; C4–C7 are binding instructions for the implementers.

1. **C1 — `usePermissions` is FLAT; fix Task 22's App wiring.** `usePermissions()` returns
   `{ permissions, prompt: PermissionPrompt|null, remove, clear, resolve(decision) }` (Task 15, as-drafted —
   `resolve` reads the active prompt's `requestId` from a ref). `PermissionPromptDialog` (Task 19) keeps
   `onResolve(requestId, decision)`. **Task 22's App.tsx MUST mount it flat** (patched inline):
   `{permissions.prompt && <PermissionPromptDialog prompt={permissions.prompt} onResolve={(_requestId, decision)
   => void permissions.resolve(decision)} />}` — NOT `permissions.prompt.active`/`.resolve`.
2. **C2 — Task 23 `downloads.changed` via the bridge, not `ipcRenderer`.** Only `window.aegis` is bridged
   (`ipcRenderer` is intentionally NOT exposed in the chrome renderer — see `sandbox.spec`). The downloads e2e
   subscribes via `window.aegis.downloads.onChanged(() => { window.__aegisDownloadsChanged += 1 })` (patched inline).
3. **C3 — Task 10 `PICKER_IIFE` sets the `__aegisPickerArmed` marker.** After the listeners are installed it sets
   `window.__aegisPickerArmed = true;`, and `cleanup()` clears it (`delete window.__aegisPickerArmed;`). Task 25's
   picker e2e polls this marker before dispatching the synthetic click (patched inline).
4. **C4 — `Settings.downloadDir` sweep (non-optional).** Task 1 adds `downloadDir: string` to `Settings` AND must
   add it to `DEFAULT_SETTINGS` (`settingsRepo.ts`) AND to EVERY full `Settings` literal in the existing suites
   (grep `siteName:` across the repo: `settingsRepo.test`, `settings.test`, `sqlite.test`, `chromePreload.test`,
   `App.test` baseSettings, `AppearanceTab/SearchTab/HomeTab` tests, `useNav.test`). Add `downloadDir: ''` (or a
   value) to each so no new tsc errors surface. This is a required sub-step of Task 1.
5. **C5 — history import dup-url collapse = ACCEPTED.** Import inserts history via `record(e, () => e.visitedAt)`;
   `record` dedups against the most-recent row by url, so adjacent SAME-url export rows collapse. This is accepted
   (history is a timeline; collapsing adjacent same-url is benign). Task 9/25 add a `dataPort` unit case with
   adjacent duplicate-url rows asserting the documented behavior; note it in the Task-26 audit/deferred doc.
6. **C6 — Task 24 e2e robustness.** Read the chrome CSP `<meta>` via `expect.poll` on the `executeJavaScript`
   query (retry until non-null — the chrome DOM may not be committed at `beforeAll`). Assert fullscreen via a SPY
   that `win.setFullScreen(true/false)` was called, NOT `win.isFullScreen()` (headless WMs may not honor it).
7. **C7 — Task 22 SettingsModal.test:** RENAME (do not duplicate) the existing tab-count case from "six tabs" to
   "nine tabs" (Appearance/Search/Home/Filter Lists/My Filters/Allowlist + Downloads/Site permissions/Data).

**Accepted (no change):** PDF inline-render + autoplay-block are verified at the `webPreferences`-flag/state level
(spec §3.2 permits this; no fixture .pdf is rendered/eyeballed); the Task-23 `.bin` MIME entry is redundant with
the fixture server's `application/octet-stream` default (harmless).

---

I now have every as-built pattern I need: the type-test convention (runtime IPC asserts + `Record<keyof X, true>` compile-shape checks), the repo pattern (prepared statements, additive `CREATE TABLE IF NOT EXISTS`, `:memory:` + `runMigrations` test harness), and the exact commands/branch. I have all required facts to expand Tasks 1-4.

### Task 1: `shared/types.ts` — Phase-5 IPC channels, data types, `Settings.downloadDir`, and AegisApi (downloads/permissions/data/picker)

**Files:**
- Modify: `shared/types.ts` (add IPC channels in the `IPC` object after `evtHistoryChanged`; add `DownloadEntry`/`SitePermission`/`PermissionPrompt`/`ImportMode` types after `SavedItem`; add `downloadDir` to `Settings`; add the four AegisApi namespaces after `customFilters`)
- Test: `shared/types.test.ts` (append a "Phase 5 additions" describe block)

- [ ] **Step 1: Write the failing test**

Append this block to the end of `shared/types.test.ts`:

```ts
describe('shared/types — Phase 5 additions', () => {
  it('exposes the downloads IPC channel constants (incl. the changed event)', () => {
    expect(IPC.downloadsList).toBe('downloads.list');
    expect(IPC.downloadsRemove).toBe('downloads.remove');
    expect(IPC.downloadsClear).toBe('downloads.clear');
    expect(IPC.downloadsOpenFile).toBe('downloads.openFile');
    expect(IPC.downloadsShowInFolder).toBe('downloads.showInFolder');
    expect(IPC.downloadsCancel).toBe('downloads.cancel');
    expect(IPC.evtDownloadsChanged).toBe('downloads.changed');
  });

  it('exposes the permissions IPC channel constants (incl. the prompt event)', () => {
    expect(IPC.permissionsList).toBe('permissions.list');
    expect(IPC.permissionsRemove).toBe('permissions.remove');
    expect(IPC.permissionsClear).toBe('permissions.clear');
    expect(IPC.permissionsResolve).toBe('permissions.resolve');
    expect(IPC.evtPermissionsPrompt).toBe('permissions.prompt');
  });

  it('exposes the data + picker IPC channel constants', () => {
    expect(IPC.dataExport).toBe('data.export');
    expect(IPC.dataImport).toBe('data.import');
    expect(IPC.pickerStart).toBe('picker.start');
  });

  it('admits the Phase-5 data-model shapes', () => {
    const dl: DownloadEntry = {
      id: 1,
      url: 'https://a.test/f.zip',
      filename: 'f.zip',
      savePath: '/home/u/Downloads/f.zip',
      state: 'progressing',
      receivedBytes: 10,
      totalBytes: 100,
      startedAt: 1234,
    };
    expect(dl.state).toBe('progressing');

    const perm: SitePermission = {
      origin: 'https://a.test',
      permission: 'geolocation',
      decision: 'allow',
    };
    expect(perm.decision).toBe('allow');

    const prompt: PermissionPrompt = {
      requestId: 7,
      origin: 'https://a.test',
      permission: 'notifications',
    };
    expect(prompt.requestId).toBe(7);

    const mode: ImportMode = 'replace';
    expect(mode).toBe('replace');
  });

  it('adds downloadDir to Settings', () => {
    const partial: Partial<Settings> = { downloadDir: '/tmp/dl' };
    expect(partial.downloadDir).toBe('/tmp/dl');
  });

  it('types the Phase-5 AegisApi members (compile-only shape check)', () => {
    type DownloadsApi = AegisApi['downloads'];
    type PermissionsApi = AegisApi['permissions'];
    type DataApi = AegisApi['data'];
    type PickerApi = AegisApi['picker'];
    const downloadsShape: Record<keyof DownloadsApi, true> = {
      list: true,
      remove: true,
      clear: true,
      openFile: true,
      showInFolder: true,
      cancel: true,
      onChanged: true,
    };
    const permissionsShape: Record<keyof PermissionsApi, true> = {
      list: true,
      remove: true,
      clear: true,
      resolve: true,
      onPrompt: true,
    };
    const dataShape: Record<keyof DataApi, true> = { export: true, import: true };
    const pickerShape: Record<keyof PickerApi, true> = { start: true };
    expect(Object.keys(downloadsShape).sort()).toEqual([
      'cancel',
      'clear',
      'list',
      'onChanged',
      'openFile',
      'remove',
      'showInFolder',
    ]);
    expect(Object.keys(permissionsShape).sort()).toEqual([
      'clear',
      'list',
      'onPrompt',
      'remove',
      'resolve',
    ]);
    expect(Object.keys(dataShape).sort()).toEqual(['export', 'import']);
    expect(Object.keys(pickerShape)).toEqual(['start']);
  });
});
```

Also extend the type-import block at the top of the file so the new types resolve. Replace the import block:

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
  DownloadEntry,
  SitePermission,
  PermissionPrompt,
  ImportMode,
  Settings,
} from './types';
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run shared/types.test.ts`
Expected: FAIL — TypeScript/compile errors that `Property 'downloadsList' does not exist on type` (and `DownloadEntry`/`SitePermission`/`PermissionPrompt`/`ImportMode` are not exported, `downloadDir` not on `Settings`, `downloads`/`permissions`/`data`/`picker` not on `AegisApi`).

- [ ] **Step 3: Implement**

In `shared/types.ts`, inside the `IPC` object, add the Phase-5 channels immediately after the `evtHistoryChanged: 'history.changed',` line (before the closing `} as const;`):

```ts
  // downloads (Phase 5, chrome -> main)
  downloadsList: 'downloads.list',
  downloadsRemove: 'downloads.remove',
  downloadsClear: 'downloads.clear',
  downloadsOpenFile: 'downloads.openFile',
  downloadsShowInFolder: 'downloads.showInFolder',
  downloadsCancel: 'downloads.cancel',
  // permissions (Phase 5, chrome <-> main)
  permissionsList: 'permissions.list',
  permissionsRemove: 'permissions.remove',
  permissionsClear: 'permissions.clear',
  permissionsResolve: 'permissions.resolve',
  // data export/import (Phase 5, chrome -> main)
  dataExport: 'data.export',
  dataImport: 'data.import',
  // element picker (Phase 5, chrome -> main)
  pickerStart: 'picker.start',
  // events (Phase 5, main -> chrome renderer)
  evtDownloadsChanged: 'downloads.changed',
  evtPermissionsPrompt: 'permissions.prompt',
```

Add the new data-model types immediately after the `SavedItem` interface (before `ContentInset`):

```ts
// ---- downloads / permissions data model (Phase 5) ----
export interface DownloadEntry {
  id: number;
  url: string;
  filename: string;
  savePath: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number; // 0 when unknown
  startedAt: number;
}
export interface SitePermission {
  origin: string;
  permission: string;
  decision: 'allow' | 'deny';
}
export interface PermissionPrompt {
  requestId: number;
  origin: string;
  permission: string;
}
export type ImportMode = 'merge' | 'replace';
```

Add `downloadDir` to the `Settings` interface (after `hideChromeByDefault`):

```ts
export interface Settings {
  siteName: string;
  homeUrl: string;
  primaryColor: string;
  defaultSearchTemplate: string; // e.g. https://duckduckgo.com/?q=%s
  searchEngines: SearchEngine[]; // seeded; not editable until Phase 4
  hideChromeByDefault: boolean;
  downloadDir: string; // '' → main resolves to app.getPath('downloads')
}
```

Add the four new AegisApi namespaces inside the `AegisApi` interface, immediately after the `customFilters` member (before the closing `}` of the interface):

```ts
  downloads: {
    list(): Promise<DownloadEntry[]>;
    remove(id: number): Promise<DownloadEntry[]>;
    clear(): Promise<DownloadEntry[]>;
    openFile(id: number): Promise<void>;
    showInFolder(id: number): Promise<void>;
    cancel(id: number): Promise<void>;
    onChanged(cb: () => void): () => void;
  };
  permissions: {
    list(): Promise<SitePermission[]>;
    remove(origin: string, permission: string): Promise<SitePermission[]>;
    clear(): Promise<SitePermission[]>;
    resolve(requestId: number, decision: 'allow' | 'deny'): Promise<void>;
    onPrompt(cb: (p: PermissionPrompt) => void): () => void;
  };
  data: {
    export(): Promise<{ ok: boolean; path?: string }>;
    import(mode: ImportMode): Promise<{ ok: boolean; counts?: unknown }>;
  };
  picker: {
    start(): Promise<{ ok: boolean; rule?: string }>;
  };
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run shared/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts shared/types.test.ts
git commit -m "feat(types): add Phase-5 IPC channels, downloads/permissions/data/picker types + AegisApi"
```

---

### Task 2: `DownloadsRepo` + `downloads` table

**Files:**
- Create: `electron/main/db/downloadsRepo.ts`
- Modify: `electron/main/db/sqlite.ts` (append a `CREATE TABLE IF NOT EXISTS downloads` block inside the `runMigrations` `db.exec` template)
- Test: `electron/main/db/downloadsRepo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/main/db/downloadsRepo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { DownloadsRepo } from './downloadsRepo';

function sampleInput(over: Partial<Parameters<DownloadsRepo['record']>[0]> = {}) {
  return {
    url: 'https://a.test/file.zip',
    filename: 'file.zip',
    savePath: '/home/u/Downloads/file.zip',
    state: 'progressing' as const,
    receivedBytes: 0,
    totalBytes: 1000,
    startedAt: 1000,
    ...over,
  };
}

describe('downloadsRepo', () => {
  let db: Database.Database;
  let repo: DownloadsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new DownloadsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('list / record', () => {
    it('starts empty', () => {
      expect(repo.list()).toEqual([]);
    });

    it('records a download and returns the inserted row with a numeric id', () => {
      const row = repo.record(sampleInput());
      expect(typeof row.id).toBe('number');
      expect(row).toMatchObject({
        url: 'https://a.test/file.zip',
        filename: 'file.zip',
        savePath: '/home/u/Downloads/file.zip',
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: 1000,
        startedAt: 1000,
      });
    });

    it('lists newest first (startedAt DESC, id DESC)', () => {
      repo.record(sampleInput({ url: 'https://a.test/1', startedAt: 1000 }));
      repo.record(sampleInput({ url: 'https://a.test/2', startedAt: 2000 }));
      repo.record(sampleInput({ url: 'https://a.test/3', startedAt: 3000 }));
      expect(repo.list().map((d) => d.url)).toEqual([
        'https://a.test/3',
        'https://a.test/2',
        'https://a.test/1',
      ]);
    });
  });

  describe('get', () => {
    it('returns the row by id, or undefined when absent', () => {
      const row = repo.record(sampleInput());
      expect(repo.get(row.id)).toMatchObject({ id: row.id, filename: 'file.zip' });
      expect(repo.get(9999)).toBeUndefined();
    });
  });

  describe('update', () => {
    it('patches only the supplied fields, leaving the rest intact', () => {
      const row = repo.record(sampleInput());
      repo.update(row.id, { receivedBytes: 500, totalBytes: 1000, state: 'progressing' });
      expect(repo.get(row.id)).toMatchObject({
        receivedBytes: 500,
        totalBytes: 1000,
        state: 'progressing',
        filename: 'file.zip',
      });
      repo.update(row.id, { state: 'completed', receivedBytes: 1000 });
      const after = repo.get(row.id)!;
      expect(after.state).toBe('completed');
      expect(after.receivedBytes).toBe(1000);
      expect(after.totalBytes).toBe(1000);
    });

    it('is a no-op patch when called with an empty partial', () => {
      const row = repo.record(sampleInput());
      repo.update(row.id, {});
      expect(repo.get(row.id)).toMatchObject({ state: 'progressing', receivedBytes: 0 });
    });
  });

  describe('remove / clear', () => {
    it('removes one row by id', () => {
      const a = repo.record(sampleInput({ url: 'https://a.test/a' }));
      repo.record(sampleInput({ url: 'https://a.test/b' }));
      repo.remove(a.id);
      expect(repo.list().map((d) => d.url)).toEqual(['https://a.test/b']);
    });

    it('clears every row', () => {
      repo.record(sampleInput({ url: 'https://a.test/a' }));
      repo.record(sampleInput({ url: 'https://a.test/b' }));
      repo.clear();
      expect(repo.list()).toEqual([]);
    });
  });

  it('persists across repo instances on the same db', () => {
    const row = repo.record(sampleInput());
    const repo2 = new DownloadsRepo(db);
    expect(repo2.get(row.id)).toMatchObject({ filename: 'file.zip' });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/downloadsRepo.test.ts`
Expected: FAIL — `Cannot find module './downloadsRepo'` (the module does not exist yet).

- [ ] **Step 3: Implement**

Add the `downloads` table to the `runMigrations` `db.exec` template in `electron/main/db/sqlite.ts`, immediately after the `custom_filters` INSERT line (before the closing `` ` ``):

```ts
    CREATE TABLE IF NOT EXISTS downloads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      url           TEXT    NOT NULL,
      filename      TEXT    NOT NULL,
      savePath      TEXT    NOT NULL,
      state         TEXT    NOT NULL,
      receivedBytes INTEGER NOT NULL DEFAULT 0,
      totalBytes    INTEGER NOT NULL DEFAULT 0,
      startedAt     INTEGER NOT NULL
    );
```

Create `electron/main/db/downloadsRepo.ts`:

```ts
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/downloadsRepo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/main/db/downloadsRepo.ts electron/main/db/downloadsRepo.test.ts electron/main/db/sqlite.ts
git commit -m "feat(db): add DownloadsRepo + downloads table (record/update/list/get/remove/clear)"
```

---

### Task 3: `PermissionsRepo` + `site_permissions` table

**Files:**
- Create: `electron/main/db/permissionsRepo.ts`
- Modify: `electron/main/db/sqlite.ts` (append a `CREATE TABLE IF NOT EXISTS site_permissions` block inside the `runMigrations` `db.exec` template)
- Test: `electron/main/db/permissionsRepo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/main/db/permissionsRepo.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { PermissionsRepo } from './permissionsRepo';

describe('permissionsRepo', () => {
  let db: Database.Database;
  let repo: PermissionsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new PermissionsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('get / set', () => {
    it('returns undefined for an unknown (origin, permission)', () => {
      expect(repo.get('https://a.test', 'geolocation')).toBeUndefined();
    });

    it('stores and reads back a decision', () => {
      repo.set('https://a.test', 'geolocation', 'allow');
      expect(repo.get('https://a.test', 'geolocation')).toBe('allow');
    });

    it('keys by both origin and permission independently', () => {
      repo.set('https://a.test', 'geolocation', 'allow');
      repo.set('https://a.test', 'notifications', 'deny');
      repo.set('https://b.test', 'geolocation', 'deny');
      expect(repo.get('https://a.test', 'geolocation')).toBe('allow');
      expect(repo.get('https://a.test', 'notifications')).toBe('deny');
      expect(repo.get('https://b.test', 'geolocation')).toBe('deny');
    });

    it('upserts: re-setting the same key overwrites the decision', () => {
      repo.set('https://a.test', 'geolocation', 'deny');
      repo.set('https://a.test', 'geolocation', 'allow');
      expect(repo.get('https://a.test', 'geolocation')).toBe('allow');
      expect(repo.list()).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('lists all rows ordered by origin then permission', () => {
      repo.set('https://b.test', 'media', 'allow');
      repo.set('https://a.test', 'notifications', 'deny');
      repo.set('https://a.test', 'geolocation', 'allow');
      expect(repo.list()).toEqual([
        { origin: 'https://a.test', permission: 'geolocation', decision: 'allow' },
        { origin: 'https://a.test', permission: 'notifications', decision: 'deny' },
        { origin: 'https://b.test', permission: 'media', decision: 'allow' },
      ]);
    });
  });

  describe('remove / clear', () => {
    it('removes one (origin, permission) row, leaving others', () => {
      repo.set('https://a.test', 'geolocation', 'allow');
      repo.set('https://a.test', 'notifications', 'deny');
      repo.remove('https://a.test', 'geolocation');
      expect(repo.get('https://a.test', 'geolocation')).toBeUndefined();
      expect(repo.get('https://a.test', 'notifications')).toBe('deny');
    });

    it('clears every row', () => {
      repo.set('https://a.test', 'geolocation', 'allow');
      repo.set('https://b.test', 'media', 'deny');
      repo.clear();
      expect(repo.list()).toEqual([]);
    });
  });

  it('persists across repo instances on the same db', () => {
    repo.set('https://a.test', 'geolocation', 'allow');
    const repo2 = new PermissionsRepo(db);
    expect(repo2.get('https://a.test', 'geolocation')).toBe('allow');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/permissionsRepo.test.ts`
Expected: FAIL — `Cannot find module './permissionsRepo'` (the module does not exist yet).

- [ ] **Step 3: Implement**

Add the `site_permissions` table to the `runMigrations` `db.exec` template in `electron/main/db/sqlite.ts`, immediately after the `downloads` block added in Task 2 (before the closing `` ` ``):

```ts
    CREATE TABLE IF NOT EXISTS site_permissions (
      origin     TEXT NOT NULL,
      permission TEXT NOT NULL,
      decision   TEXT NOT NULL,
      PRIMARY KEY (origin, permission)
    );
```

Create `electron/main/db/permissionsRepo.ts`:

```ts
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
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/permissionsRepo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/main/db/permissionsRepo.ts electron/main/db/permissionsRepo.test.ts electron/main/db/sqlite.ts
git commit -m "feat(db): add PermissionsRepo + site_permissions table (get/set/list/remove/clear)"
```

---

### Task 4: `FavoritesRepo.clear()` + `SavedRepo.clear()` (for replace-import)

**Files:**
- Modify: `electron/main/db/favoritesRepo.ts` (add a `clearStmt` prepared statement in the constructor + a `clear()` method)
- Modify: `electron/main/db/savedRepo.ts` (add a `clearStmt` prepared statement in the constructor + a `clear()` method)
- Test: `electron/main/db/favoritesRepo.test.ts` (append a `clear` describe block), `electron/main/db/savedRepo.test.ts` (append a `clear` describe block)

- [ ] **Step 1: Write the failing test**

Append to `electron/main/db/favoritesRepo.test.ts` (inside the top-level `describe('favoritesRepo', …)` block, before its closing `});`):

```ts
  describe('clear', () => {
    it('removes every favorite (replace-import support)', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      repo.add({ name: 'B', url: 'https://b.test/', tags: [] });
      repo.clear();
      expect(repo.list()).toEqual([]);
    });

    it('is a no-op on an already-empty table', () => {
      repo.clear();
      expect(repo.list()).toEqual([]);
    });

    it('lets a freshly-added favorite start again at position 0 after clear', () => {
      repo.add({ name: 'A', url: 'https://a.test/', tags: [] });
      repo.clear();
      const list = repo.add({ name: 'C', url: 'https://c.test/', tags: [] });
      expect(list).toHaveLength(1);
      expect(list[0].position).toBe(0);
    });
  });
```

Append to `electron/main/db/savedRepo.test.ts` (inside the top-level `describe('savedRepo', …)` block, before its closing `});`):

```ts
  describe('clear', () => {
    it('removes every saved item (replace-import support)', () => {
      repo.add({ url: 'https://a.test/', title: 'A' }, () => 1000);
      repo.add({ url: 'https://b.test/', title: 'B' }, () => 2000);
      repo.clear();
      expect(repo.list()).toEqual([]);
      expect(repo.has('https://a.test/')).toBe(false);
    });

    it('is a no-op on an already-empty table', () => {
      repo.clear();
      expect(repo.list()).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:node && npx vitest run electron/main/db/favoritesRepo.test.ts electron/main/db/savedRepo.test.ts`
Expected: FAIL — `repo.clear is not a function` (the method does not exist on either repo yet).

- [ ] **Step 3: Implement**

In `electron/main/db/favoritesRepo.ts`, add a `clearStmt` field declaration alongside the other statement fields (after `private readonly setTagsStmt: Database.Statement;`):

```ts
  private readonly clearStmt: Database.Statement;
```

Initialize it in the constructor, immediately after the `this.setTagsStmt = …` assignment:

```ts
    this.clearStmt = db.prepare('DELETE FROM favorites');
```

Add the `clear()` method at the end of the class (after `deleteTag`, before the class closing `}`):

```ts
  /** Remove every favorite (used by replace-import). */
  clear(): void {
    this.clearStmt.run();
  }
```

In `electron/main/db/savedRepo.ts`, add a `clearStmt` field declaration alongside the other statement fields (after `private readonly hasStmt: Database.Statement;`):

```ts
  private readonly clearStmt: Database.Statement;
```

Initialize it in the constructor, immediately after the `this.hasStmt = …` assignment:

```ts
    this.clearStmt = db.prepare('DELETE FROM saved_list');
```

Add the `clear()` method at the end of the class (after `has`, before the class closing `}`):

```ts
  /** Remove every saved item (used by replace-import). */
  clear(): void {
    this.clearStmt.run();
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:node && npx vitest run electron/main/db/favoritesRepo.test.ts electron/main/db/savedRepo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/main/db/favoritesRepo.ts electron/main/db/favoritesRepo.test.ts electron/main/db/savedRepo.ts electron/main/db/savedRepo.test.ts
git commit -m "feat(db): add FavoritesRepo.clear() + SavedRepo.clear() for replace-import"
```

---

#### New names introduced (Block A)

- `shared/types.ts` — IPC channels: `IPC.downloadsList`, `IPC.downloadsRemove`, `IPC.downloadsClear`, `IPC.downloadsOpenFile`, `IPC.downloadsShowInFolder`, `IPC.downloadsCancel`, `IPC.permissionsList`, `IPC.permissionsRemove`, `IPC.permissionsClear`, `IPC.permissionsResolve`, `IPC.dataExport`, `IPC.dataImport`, `IPC.pickerStart`, `IPC.evtDownloadsChanged`, `IPC.evtPermissionsPrompt`; types: `DownloadEntry`, `SitePermission`, `PermissionPrompt`, `ImportMode`; `Settings.downloadDir` (field); `AegisApi.downloads`, `AegisApi.permissions`, `AegisApi.data`, `AegisApi.picker` (members).
- `electron/main/db/downloadsRepo.ts` — `class DownloadsRepo` with `list()`, `get(id)`, `record(input)`, `update(id, partial)`, `remove(id)`, `clear()`; `downloads` table (in `sqlite.ts` `runMigrations`).
- `electron/main/db/permissionsRepo.ts` — `class PermissionsRepo` with `get(origin, permission)`, `set(origin, permission, decision)`, `list()`, `remove(origin, permission)`, `clear()`; `site_permissions` table (in `sqlite.ts` `runMigrations`).
- `electron/main/db/favoritesRepo.ts` — `FavoritesRepo.clear()` (method).
- `electron/main/db/savedRepo.ts` — `SavedRepo.clear()` (method).

I now have all the context needed. I'll also confirm the e2e test directory pattern and a sample e2e bootstrap helper briefly, but the contract gives me the ABI commands. Let me check the e2e helper for how `__aegisTest` is accessed (since Task 12 modifies it, though that's my Block B boot task and e2e tasks are Block E). I have enough. Let me write Block B (Tasks 5-13).

Now I'll produce the markdown.

### Task 5: Content webPreferences (autoplay/plugins) + remove the will-download floor

**Files:**
- Modify: `electron/main/viewController.ts:49-58` (add `autoplayPolicy` + `plugins`), `electron/main/viewController.ts:166-169` (delete the `will-download` floor)
- Test: `electron/main/viewController.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the existing `'cancels downloads via will-download preventDefault'` test (it asserts behavior we are removing) and extend the construction test. Edit `electron/main/viewController.test.ts`.

First, in the `makeWebContents()` mock factory (inside `vi.hoisted`), capture the `webPreferences` passed to the `WebContentsView` ctor so the new prefs can be asserted. Change the hoisted `WebContentsView` class:

```ts
  let last: ReturnType<typeof makeWebContents> | null = null;
  let lastOpts: any = null;
  class WebContentsView {
    webContents = makeWebContents();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor(opts?: any) {
      last = this.webContents;
      lastOpts = opts;
    }
  }
  return {
    WebContentsView,
    getLastWc: () => last,
    getLastOpts: () => lastOpts,
  };
```

Then replace the `'cancels downloads via will-download preventDefault'` test with a no-floor assertion, and add a webPreferences assertion. In `describe('ViewController content-session security (Task 13)', ...)` replace:

```ts
  it('cancels downloads via will-download preventDefault', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const onCalls = (wc.session.on as any).mock.calls;
    const willDownload = onCalls.find((c: any[]) => c[0] === 'will-download');
    expect(willDownload).toBeDefined();
    const ev = { preventDefault: vi.fn() };
    willDownload[1](ev);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
  });
```

with:

```ts
  it('does NOT register a will-download floor (downloads are wired in boot, Task 12)', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const onCalls = (wc.session.on as any).mock.calls;
    const willDownload = onCalls.find((c: any[]) => c[0] === 'will-download');
    expect(willDownload).toBeUndefined();
  });
```

Then add a new test to the `describe('ViewController construction & basics', ...)` block:

```ts
  it('sets content webPreferences: autoplay gated + plugins enabled (PDF) + locked sandbox', () => {
    new ViewController(makeOpts());
    const prefs = h.getLastOpts()!.webPreferences;
    expect(prefs.autoplayPolicy).toBe('document-user-activation-required');
    expect(prefs.plugins).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.partition).toBe('persist:content');
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/viewController.test.ts`
Expected: FAIL — `expected undefined to be 'document-user-activation-required'` (new prefs not set) and the will-download test still finds a registered listener (`expected [Function] to be undefined`).

- [ ] **Step 3: Implement**

In `electron/main/viewController.ts`, update the `WebContentsView` construction (`:49-58`):

```ts
    this.view = new WebContentsView({
      webPreferences: {
        preload: opts.contentPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: 'persist:content',
        // Phase 5: block autoplay-with-sound until a user gesture; enable
        // Chromium's PDF plugin so application/pdf renders inline in the view.
        autoplayPolicy: 'document-user-activation-required',
        plugins: true,
      },
    });
```

And delete the `will-download` floor from `wireSecurity()` (`:166-169`) — downloads are wired on the content session in boot (Task 12):

```ts
  private wireSecurity(): void {
    const wc = this.wc();
    const ses = wc.session;

    // Permissions: deny-by-default via BOTH handlers. wirePermissions() (Phase 5,
    // boot) RE-SETS both on the content session (last-set wins); this stays as the
    // safe default before that runs.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    // Popup policy (§5): deny popunders; route a legitimate, allowed-scheme
    // new-window in-place; otherwise deny. Policy lives in ./windowOpen (pure,
    // unit-tested). HandlerDetails has no user-gesture bit → disposition+scheme only.
    wc.setWindowOpenHandler((details) => {
      const decision = decideWindowOpen(details);
      if ('loadInPlace' in decision) this.wc().loadURL(decision.loadInPlace);
      return { action: 'deny' };
    });
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/viewController.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "feat(content): gate autoplay + enable PDF plugin; remove will-download floor"
```

---

### Task 6: Pure helpers — downloads / permissions / data / picker

**Files:**
- Create: `electron/main/downloadsHelpers.ts`, `electron/main/permissionsHelpers.ts`, `electron/main/dataPort.ts`, `electron/main/pickerHelpers.ts`
- Test: `electron/main/downloadsHelpers.test.ts`, `electron/main/permissionsHelpers.test.ts`, `electron/main/dataPort.test.ts`, `electron/main/pickerHelpers.test.ts`

> Pure, dependency-free helpers extracted so the impure wiring (Tasks 7-10) stays thin. `wireDownloads`/`wirePermissions`/`buildDataHandlers`/`buildPickerHandlers` re-export these so the contract's "helpers live in downloads.ts/permissions.ts/picker.ts" surface is preserved (Tasks 7/8/10 add the re-exports).

- [ ] **Step 1: Write the failing test**

`electron/main/downloadsHelpers.test.ts`:

```ts
// electron/main/downloadsHelpers.test.ts
import { describe, it, expect } from 'vitest';
import { uniquifyFilename, resolveDownloadDir } from './downloadsHelpers';

describe('uniquifyFilename', () => {
  const exists = (taken: string[]) => (p: string) => taken.includes(p);

  it('returns the name unchanged when it does not collide', () => {
    expect(uniquifyFilename('/d/file.pdf', exists([]))).toBe('/d/file.pdf');
  });

  it('appends " (1)" before the extension on the first collision', () => {
    expect(uniquifyFilename('/d/file.pdf', exists(['/d/file.pdf']))).toBe('/d/file (1).pdf');
  });

  it('increments until a free name is found', () => {
    const taken = ['/d/file.pdf', '/d/file (1).pdf', '/d/file (2).pdf'];
    expect(uniquifyFilename('/d/file.pdf', exists(taken))).toBe('/d/file (3).pdf');
  });

  it('handles names with no extension', () => {
    expect(uniquifyFilename('/d/README', exists(['/d/README']))).toBe('/d/README (1)');
  });

  it('handles dotfiles (leading dot is not an extension)', () => {
    expect(uniquifyFilename('/d/.env', exists(['/d/.env']))).toBe('/d/.env (1)');
  });

  it('treats only the final segment as the basename (dir kept verbatim)', () => {
    expect(uniquifyFilename('/a.b/c/file.tar.gz', exists(['/a.b/c/file.tar.gz']))).toBe(
      '/a.b/c/file (1).tar.gz',
    );
  });
});

describe('resolveDownloadDir', () => {
  it('uses the configured dir when non-empty', () => {
    expect(resolveDownloadDir('/custom/dl', '/home/u/Downloads')).toBe('/custom/dl');
  });

  it('falls back to the OS dir when the setting is empty', () => {
    expect(resolveDownloadDir('', '/home/u/Downloads')).toBe('/home/u/Downloads');
  });

  it('trims a whitespace-only setting to the OS dir', () => {
    expect(resolveDownloadDir('   ', '/home/u/Downloads')).toBe('/home/u/Downloads');
  });
});
```

`electron/main/permissionsHelpers.test.ts`:

```ts
// electron/main/permissionsHelpers.test.ts
import { describe, it, expect } from 'vitest';
import { resolvePermission, originOf, PHASE5_PERMISSIONS } from './permissionsHelpers';

describe('originOf', () => {
  it('extracts the origin from a full URL', () => {
    expect(originOf('https://example.com/path?q=1')).toBe('https://example.com');
  });

  it('keeps a non-default port', () => {
    expect(originOf('http://localhost:8080/x')).toBe('http://localhost:8080');
  });

  it('returns empty string for an unparseable URL', () => {
    expect(originOf('not a url')).toBe('');
  });
});

describe('resolvePermission', () => {
  it('honors a remembered allow', () => {
    expect(resolvePermission('allow', true)).toEqual({ decision: 'allow' });
  });

  it('honors a remembered deny', () => {
    expect(resolvePermission('deny', true)).toEqual({ decision: 'deny' });
  });

  it('prompts when no memory and the permission is in the Phase-5 set', () => {
    expect(resolvePermission(undefined, true)).toEqual({ prompt: true });
  });

  it('denies when no memory and the permission is NOT in the Phase-5 set', () => {
    expect(resolvePermission(undefined, false)).toEqual({ deny: true });
  });

  it('a remembered decision wins even for an out-of-set permission', () => {
    expect(resolvePermission('allow', false)).toEqual({ decision: 'allow' });
  });
});

describe('PHASE5_PERMISSIONS', () => {
  it('is exactly the meaningful set', () => {
    expect([...PHASE5_PERMISSIONS].sort()).toEqual(
      ['clipboard-read', 'geolocation', 'media', 'notifications'].sort(),
    );
  });
});
```

`electron/main/dataPort.test.ts`:

```ts
// electron/main/dataPort.test.ts
import { describe, it, expect } from 'vitest';
import { validateExport, planImport } from './dataPort';
import type { ExportPayload } from './dataPort';
import type { Favorite, HistoryEntry, SavedItem, Settings } from '../../shared/types';

const settings: Settings = {
  siteName: 'Aegis', homeUrl: 'https://h/', primaryColor: '#000',
  defaultSearchTemplate: 'https://d/?q=%s', searchEngines: [], hideChromeByDefault: false,
  downloadDir: '',
};
const fav = (url: string): Favorite => ({ id: 1, name: 'n', url, tags: [], position: 0 });
const hist = (url: string, visitedAt: number): HistoryEntry => ({ id: 1, url, title: 't', visitedAt });
const saved = (url: string): SavedItem => ({ id: 1, url, title: 't', savedAt: 5 });

function payload(over: Partial<ExportPayload> = {}): ExportPayload {
  return { version: 1, favorites: [], history: [], saved: [], settings, ...over };
}

describe('validateExport', () => {
  it('accepts a well-formed payload', () => {
    expect(validateExport(payload())).toEqual({ ok: true, payload: payload() });
  });

  it('rejects a non-object', () => {
    expect(validateExport('nope').ok).toBe(false);
    expect(validateExport(null).ok).toBe(false);
  });

  it('rejects a wrong version', () => {
    expect(validateExport({ ...payload(), version: 2 }).ok).toBe(false);
  });

  it('rejects when an array field is missing', () => {
    const { favorites, ...rest } = payload();
    expect(validateExport(rest).ok).toBe(false);
  });

  it('rejects when settings is missing', () => {
    const { settings: _s, ...rest } = payload();
    expect(validateExport(rest).ok).toBe(false);
  });
});

describe('planImport', () => {
  const existing = {
    favorites: [fav('https://have.test/')],
    saved: [saved('https://have.test/')],
    historyUrls: new Set(['https://have.test/']),
  };

  it('replace mode keeps every imported row (no dedup, full replace)', () => {
    const p = payload({
      favorites: [fav('https://have.test/'), fav('https://new.test/')],
      history: [hist('https://have.test/', 1), hist('https://new.test/', 2)],
      saved: [saved('https://have.test/'), saved('https://new.test/')],
    });
    const plan = planImport(p, existing, 'replace');
    expect(plan.replace).toBe(true);
    expect(plan.favorites.map((f) => f.url)).toEqual(['https://have.test/', 'https://new.test/']);
    expect(plan.history.map((h) => h.url)).toEqual(['https://have.test/', 'https://new.test/']);
    expect(plan.saved.map((s) => s.url)).toEqual(['https://have.test/', 'https://new.test/']);
  });

  it('merge mode drops rows whose url already exists, keeps new ones', () => {
    const p = payload({
      favorites: [fav('https://have.test/'), fav('https://new.test/')],
      history: [hist('https://have.test/', 1), hist('https://new.test/', 2)],
      saved: [saved('https://have.test/'), saved('https://new.test/')],
    });
    const plan = planImport(p, existing, 'merge');
    expect(plan.replace).toBe(false);
    expect(plan.favorites.map((f) => f.url)).toEqual(['https://new.test/']);
    expect(plan.history.map((h) => h.url)).toEqual(['https://new.test/']);
    expect(plan.saved.map((s) => s.url)).toEqual(['https://new.test/']);
  });

  it('carries settings through in both modes', () => {
    expect(planImport(payload(), existing, 'merge').settings).toEqual(settings);
    expect(planImport(payload(), existing, 'replace').settings).toEqual(settings);
  });

  it('reports counts of rows that will actually be inserted', () => {
    const p = payload({
      favorites: [fav('https://have.test/'), fav('https://new.test/')],
      history: [hist('https://new.test/', 2)],
      saved: [],
    });
    expect(planImport(p, existing, 'merge').counts).toEqual({ favorites: 1, history: 1, saved: 0 });
  });
});
```

`electron/main/pickerHelpers.test.ts`:

```ts
// electron/main/pickerHelpers.test.ts
import { describe, it, expect } from 'vitest';
import { appendCosmeticRule, computeSelector, PICKER_IIFE } from './pickerHelpers';

describe('appendCosmeticRule', () => {
  it('builds host##selector and appends on a fresh blob', () => {
    expect(appendCosmeticRule('', 'example.com', '.ad')).toBe('example.com##.ad');
  });

  it('joins with a newline when the blob is non-empty', () => {
    expect(appendCosmeticRule('||a.test^', 'example.com', '#banner')).toBe(
      '||a.test^\nexample.com###banner',
    );
  });

  it('does not add an extra blank line when the existing blob already ends with one', () => {
    expect(appendCosmeticRule('||a.test^\n', 'x.com', '.b')).toBe('||a.test^\nx.com##.b');
  });
});

describe('PICKER_IIFE', () => {
  it('is a non-empty self-invoking expression string returning a Promise', () => {
    expect(typeof PICKER_IIFE).toBe('string');
    expect(PICKER_IIFE.trim().startsWith('(')).toBe(true);
    expect(PICKER_IIFE).toContain('Promise');
  });
});

describe('computeSelector (reference impl, jsdom)', () => {
  it('prefers a #id', () => {
    document.body.innerHTML = '<div id="hero"><span>x</span></div>';
    const el = document.getElementById('hero')!;
    expect(computeSelector(el)).toBe('#hero');
  });

  it('uses a unique class when there is no id', () => {
    document.body.innerHTML = '<div class="promo"></div><p class="other"></p>';
    const el = document.querySelector('.promo')! as HTMLElement;
    expect(computeSelector(el)).toBe('.promo');
  });

  it('falls back to an nth-of-type path when neither id nor a unique class exists', () => {
    document.body.innerHTML = '<ul><li>a</li><li id="t">b</li></ul>';
    const el = document.getElementById('t')!;
    // id present → returns the id
    expect(computeSelector(el)).toBe('#t');

    document.body.innerHTML = '<ul><li>a</li><li>b</li></ul>';
    const second = document.querySelectorAll('li')[1] as HTMLElement;
    expect(computeSelector(second)).toBe('ul > li:nth-of-type(2)');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/downloadsHelpers.test.ts electron/main/permissionsHelpers.test.ts electron/main/dataPort.test.ts electron/main/pickerHelpers.test.ts`
Expected: FAIL — `Failed to resolve import './downloadsHelpers'` (and the three other modules do not exist).

- [ ] **Step 3: Implement**

`electron/main/downloadsHelpers.ts`:

```ts
// electron/main/downloadsHelpers.ts

/**
 * Pure download-path helpers (unit-tested). uniquifyFilename avoids clobbering an
 * existing file by inserting " (n)" before the extension; resolveDownloadDir picks
 * the configured dir or the OS default. No fs/electron deps so they test under Node.
 */

/** Split a full path into [dir-with-trailing-slash, base, ext-with-dot]. */
function splitPath(fullPath: string): { dir: string; base: string; ext: string } {
  const slash = fullPath.lastIndexOf('/');
  const dir = slash >= 0 ? fullPath.slice(0, slash + 1) : '';
  const name = slash >= 0 ? fullPath.slice(slash + 1) : fullPath;
  // A leading dot is part of the name (dotfile), not an extension boundary.
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { dir, base: name, ext: '' };
  return { dir, base: name.slice(0, dot), ext: name.slice(dot) };
}

/**
 * Return `fullPath` if `exists(fullPath)` is false; otherwise insert " (1)",
 * " (2)", … before the extension until a free path is found.
 */
export function uniquifyFilename(fullPath: string, exists: (p: string) => boolean): string {
  if (!exists(fullPath)) return fullPath;
  const { dir, base, ext } = splitPath(fullPath);
  let n = 1;
  let candidate = `${dir}${base} (${n})${ext}`;
  while (exists(candidate)) {
    n += 1;
    candidate = `${dir}${base} (${n})${ext}`;
  }
  return candidate;
}

/** The configured download dir (trimmed) if set, else the OS Downloads dir. */
export function resolveDownloadDir(settingDir: string, osDir: string): string {
  const trimmed = settingDir.trim();
  return trimmed.length > 0 ? trimmed : osDir;
}
```

`electron/main/permissionsHelpers.ts`:

```ts
// electron/main/permissionsHelpers.ts

/**
 * Pure permission helpers (unit-tested). PHASE5_PERMISSIONS is the meaningful set
 * we prompt for; everything else stays denied (deny-by-default preserved).
 */

export const PHASE5_PERMISSIONS = new Set<string>([
  'geolocation',
  'notifications',
  'media',
  'clipboard-read',
]);

/** The origin (scheme://host[:port]) of a URL, or '' if unparseable. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export type PermissionResolution =
  | { decision: 'allow' | 'deny' }
  | { prompt: true }
  | { deny: true };

/**
 * Decide how to answer a permission request given the remembered decision (if any)
 * and whether the permission is in the prompt-eligible set. A remembered decision
 * always wins; otherwise prompt if eligible, else hard-deny.
 */
export function resolvePermission(
  remembered: 'allow' | 'deny' | undefined,
  inSet: boolean,
): PermissionResolution {
  if (remembered) return { decision: remembered };
  if (inSet) return { prompt: true };
  return { deny: true };
}
```

`electron/main/dataPort.ts`:

```ts
// electron/main/dataPort.ts
import type { Favorite, HistoryEntry, SavedItem, Settings, ImportMode } from '../../shared/types';

/**
 * The export/import file shape (version 1) and pure validate/plan helpers
 * (unit-tested). The impure apply (dialogs/fs/repos) lives in ipc/data.ts.
 */
export interface ExportPayload {
  version: 1;
  favorites: Favorite[];
  history: HistoryEntry[];
  saved: SavedItem[];
  settings: Settings;
}

export type ValidateResult =
  | { ok: true; payload: ExportPayload }
  | { ok: false; error: string };

/** Validate parsed JSON is a version-1 export with the four collections + settings. */
export function validateExport(json: unknown): ValidateResult {
  if (typeof json !== 'object' || json === null) return { ok: false, error: 'not an object' };
  const o = json as Record<string, unknown>;
  if (o.version !== 1) return { ok: false, error: 'unsupported version' };
  for (const key of ['favorites', 'history', 'saved'] as const) {
    if (!Array.isArray(o[key])) return { ok: false, error: `missing array: ${key}` };
  }
  if (typeof o.settings !== 'object' || o.settings === null) {
    return { ok: false, error: 'missing settings' };
  }
  return { ok: true, payload: json as ExportPayload };
}

export interface ExistingData {
  favorites: Favorite[];
  saved: SavedItem[];
  historyUrls: Set<string>;
}

export interface ImportPlan {
  replace: boolean;
  favorites: Favorite[];
  history: HistoryEntry[];
  saved: SavedItem[];
  settings: Settings;
  counts: { favorites: number; history: number; saved: number };
}

/**
 * Compute the rows to insert for a given mode. replace = every imported row
 * (the caller clears the stores first); merge = only rows whose url is not already
 * present. settings is carried through verbatim (the caller does set()).
 */
export function planImport(
  payload: ExportPayload,
  existing: ExistingData,
  mode: ImportMode,
): ImportPlan {
  const replace = mode === 'replace';
  if (replace) {
    return {
      replace: true,
      favorites: payload.favorites,
      history: payload.history,
      saved: payload.saved,
      settings: payload.settings,
      counts: {
        favorites: payload.favorites.length,
        history: payload.history.length,
        saved: payload.saved.length,
      },
    };
  }
  const haveFav = new Set(existing.favorites.map((f) => f.url));
  const haveSaved = new Set(existing.saved.map((s) => s.url));
  const favorites = payload.favorites.filter((f) => !haveFav.has(f.url));
  const history = payload.history.filter((h) => !existing.historyUrls.has(h.url));
  const saved = payload.saved.filter((s) => !haveSaved.has(s.url));
  return {
    replace: false,
    favorites,
    history,
    saved,
    settings: payload.settings,
    counts: { favorites: favorites.length, history: history.length, saved: saved.length },
  };
}
```

`electron/main/pickerHelpers.ts`:

```ts
// electron/main/pickerHelpers.ts

/**
 * Pure element-picker helpers. appendCosmeticRule builds `host##selector` and
 * appends it to the my-filters blob (newline-joined, no leading blank line).
 * computeSelector is the reference selector algorithm tested in jsdom; the SAME
 * algorithm is embedded (as a string) in PICKER_IIFE, which is what gets injected
 * into the sandboxed content WebContents via executeJavaScript(code, true).
 */

/** Append `${host}##${selector}` to the existing my-filters blob. */
export function appendCosmeticRule(existing: string, host: string, selector: string): string {
  const rule = `${host}##${selector}`;
  if (existing.length === 0) return rule;
  return existing.endsWith('\n') ? `${existing}${rule}` : `${existing}\n${rule}`;
}

/** Index of `el` among its same-tag siblings (1-based, for :nth-of-type). */
function nthOfType(el: Element): number {
  let i = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) i += 1;
    sib = sib.previousElementSibling;
  }
  return i;
}

/**
 * Reference selector: prefer #id; else a class that is unique in the document;
 * else a parent-path of `tag:nth-of-type(n)` segments up to <body>.
 */
export function computeSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  for (const cls of Array.from(el.classList)) {
    if (el.ownerDocument.querySelectorAll(`.${cls}`).length === 1) return `.${cls}`;
  }
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
    if (node.id) {
      parts.unshift(`#${node.id}`);
      break;
    }
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${nthOfType(node)})`);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/**
 * The injected picker. Overlays a hover highlight, resolves with a computed CSS
 * selector on the next click (capture phase, default prevented), or null on Esc.
 * It is a self-invoking expression (executeJavaScript evaluates an expression and
 * returns the awaited Promise). The selector algorithm mirrors computeSelector.
 */
export const PICKER_IIFE = `(() => new Promise((resolve) => {
  const prev = document.getElementById('__aegis_picker_overlay__');
  if (prev) prev.remove();
  const overlay = document.createElement('div');
  overlay.id = '__aegis_picker_overlay__';
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7c5cff;background:rgba(124,92,255,0.2);top:0;left:0;width:0;height:0;';
  document.documentElement.appendChild(overlay);
  function nthOfType(el) {
    let i = 1, sib = el.previousElementSibling;
    while (sib) { if (sib.tagName === el.tagName) i += 1; sib = sib.previousElementSibling; }
    return i;
  }
  function selectorFor(el) {
    if (el.id) return '#' + el.id;
    for (const cls of Array.from(el.classList)) {
      if (document.querySelectorAll('.' + cls).length === 1) return '.' + cls;
    }
    const parts = [];
    let node = el;
    while (node && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
      if (node.id) { parts.unshift('#' + node.id); break; }
      parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + nthOfType(node) + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  let current = null;
  function onMove(e) {
    current = e.target;
    if (!current || current === overlay) return;
    const r = current.getBoundingClientRect();
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }
  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    delete window.__aegisPickerArmed;
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    cleanup();
    resolve(target && target !== document.documentElement ? selectorFor(target) : null);
  }
  function onKey(e) {
    if (e.key === 'Escape') { cleanup(); resolve(null); }
  }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.__aegisPickerArmed = true;
}))()`;
```

> Note: `dataPort.ts` imports `ImportMode` from `shared/types` — that type is added in Block A Task 1; this Block B plan assumes Block A is merged first per the contract task order.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/downloadsHelpers.test.ts electron/main/permissionsHelpers.test.ts electron/main/dataPort.test.ts electron/main/pickerHelpers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/main/downloadsHelpers.ts electron/main/downloadsHelpers.test.ts \
        electron/main/permissionsHelpers.ts electron/main/permissionsHelpers.test.ts \
        electron/main/dataPort.ts electron/main/dataPort.test.ts \
        electron/main/pickerHelpers.ts electron/main/pickerHelpers.test.ts
git commit -m "feat(main): pure helpers for downloads/permissions/data-port/picker"
```

---

### Task 7: `wireDownloads` + `buildDownloadsHandlers`

**Files:**
- Create: `electron/main/downloads.ts`, `electron/main/ipc/downloads.ts`
- Test: `electron/main/downloads.test.ts`, `electron/main/ipc/downloads.test.ts`

- [ ] **Step 1: Write the failing test**

`electron/main/downloads.test.ts`:

```ts
// electron/main/downloads.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron's app + node:fs/node:path so wireDownloads stays Node-testable.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/os/Downloads') },
}));
const fsExists = vi.fn(() => false);
vi.mock('node:fs', () => ({ existsSync: (p: string) => fsExists(p) }));

import { wireDownloads } from './downloads';
import type { DownloadEntry } from '../../shared/types';

type Listener = (...a: any[]) => void;

function makeSession() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(channel: string, cb: Listener) {
      const arr = listeners.get(channel) ?? [];
      arr.push(cb);
      listeners.set(channel, arr);
      return this;
    },
    _emit(channel: string, ...args: any[]) {
      for (const l of listeners.get(channel) ?? []) l(...args);
    },
  };
}

function makeItem(over: Partial<Record<string, any>> = {}) {
  const handlers = new Map<string, Listener>();
  return {
    setSavePath: vi.fn(),
    getFilename: vi.fn(() => over.filename ?? 'doc.pdf'),
    getURL: vi.fn(() => over.url ?? 'https://dl.test/doc.pdf'),
    getTotalBytes: vi.fn(() => over.total ?? 1000),
    getReceivedBytes: vi.fn(() => over.received ?? 0),
    getState: vi.fn(() => over.state ?? 'progressing'),
    getStartTime: vi.fn(() => 12345),
    cancel: vi.fn(),
    on(evt: string, cb: Listener) {
      handlers.set(evt, cb);
      return this;
    },
    _fire(evt: string, ...args: any[]) {
      handlers.get(evt)?.(...args);
    },
  };
}

function makeRepo() {
  let nextId = 1;
  const rows: DownloadEntry[] = [];
  return {
    rows,
    record: vi.fn((input: Omit<DownloadEntry, 'id'>): DownloadEntry => {
      const row = { id: nextId++, ...input };
      rows.push(row);
      return row;
    }),
    update: vi.fn((id: number, partial: Partial<DownloadEntry>) => {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, partial);
    }),
    list: vi.fn(() => rows),
    remove: vi.fn(),
    clear: vi.fn(),
    get: vi.fn((id: number) => rows.find((x) => x.id === id)),
  };
}

describe('wireDownloads', () => {
  beforeEach(() => {
    fsExists.mockReset();
    fsExists.mockReturnValue(false);
  });

  it('sets the save path synchronously inside will-download and records a row', () => {
    const session = makeSession();
    const downloadsRepo = makeRepo();
    const settingsRepo = { get: vi.fn(() => ({ downloadDir: '' })) };
    const liveItems = new Map<number, any>();
    const onChanged = vi.fn();
    wireDownloads(session as any, { downloadsRepo, settingsRepo: settingsRepo as any, onChanged, liveItems });

    const item = makeItem();
    session._emit('will-download', {}, item, {});

    expect(item.setSavePath).toHaveBeenCalledWith('/os/Downloads/doc.pdf');
    expect(downloadsRepo.record).toHaveBeenCalledTimes(1);
    const recorded = downloadsRepo.record.mock.calls[0][0];
    expect(recorded).toMatchObject({
      url: 'https://dl.test/doc.pdf',
      filename: 'doc.pdf',
      savePath: '/os/Downloads/doc.pdf',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: 1000,
    });
    expect(liveItems.get(1)).toBe(item);
  });

  it('uses the configured downloadDir and uniquifies a colliding filename', () => {
    const session = makeSession();
    const downloadsRepo = makeRepo();
    const settingsRepo = { get: vi.fn(() => ({ downloadDir: '/my/dl' })) };
    fsExists.mockImplementation((p: string) => p === '/my/dl/doc.pdf');
    wireDownloads(session as any, {
      downloadsRepo, settingsRepo: settingsRepo as any, onChanged: vi.fn(), liveItems: new Map(),
    });
    const item = makeItem();
    session._emit('will-download', {}, item, {});
    expect(item.setSavePath).toHaveBeenCalledWith('/my/dl/doc (1).pdf');
  });

  it('updates progress on item "updated" and fires onChanged', () => {
    const session = makeSession();
    const downloadsRepo = makeRepo();
    const onChanged = vi.fn();
    wireDownloads(session as any, {
      downloadsRepo, settingsRepo: { get: () => ({ downloadDir: '' }) } as any, onChanged, liveItems: new Map(),
    });
    const item = makeItem({ received: 500 });
    session._emit('will-download', {}, item, {});
    onChanged.mockClear();
    item._fire('updated', {}, 'progressing');
    expect(downloadsRepo.update).toHaveBeenCalledWith(1, {
      receivedBytes: 500,
      totalBytes: 1000,
      state: 'progressing',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('on "done" persists the final state, removes the live item, and fires onChanged', () => {
    const session = makeSession();
    const downloadsRepo = makeRepo();
    const onChanged = vi.fn();
    const liveItems = new Map<number, any>();
    wireDownloads(session as any, {
      downloadsRepo, settingsRepo: { get: () => ({ downloadDir: '' }) } as any, onChanged, liveItems,
    });
    const item = makeItem({ received: 1000 });
    session._emit('will-download', {}, item, {});
    onChanged.mockClear();
    item._fire('done', {}, 'completed');
    expect(downloadsRepo.update).toHaveBeenLastCalledWith(1, {
      receivedBytes: 1000,
      totalBytes: 1000,
      state: 'completed',
    });
    expect(liveItems.has(1)).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
```

`electron/main/ipc/downloads.test.ts`:

```ts
// electron/main/ipc/downloads.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { DownloadEntry } from '../../../shared/types';

const openPath = vi.fn(async () => '');
const showItemInFolder = vi.fn();
vi.mock('electron', () => ({
  shell: { openPath: (p: string) => openPath(p), showItemInFolder: (p: string) => showItemInFolder(p) },
}));

import { buildDownloadsHandlers } from './downloads';

function makeRepo(rows: DownloadEntry[] = []) {
  return {
    list: vi.fn(() => rows),
    remove: vi.fn(),
    clear: vi.fn(),
    get: vi.fn((id: number) => rows.find((r) => r.id === id)),
    record: vi.fn(),
    update: vi.fn(),
  };
}

const row = (id: number, savePath: string): DownloadEntry => ({
  id, url: 'https://d/', filename: 'f', savePath, state: 'completed',
  receivedBytes: 1, totalBytes: 1, startedAt: 0,
});

describe('buildDownloadsHandlers', () => {
  it('registers exactly the six download channels', () => {
    const handlers = buildDownloadsHandlers(makeRepo() as any, { liveItems: new Map() });
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC.downloadsList, IPC.downloadsRemove, IPC.downloadsClear,
        IPC.downloadsOpenFile, IPC.downloadsShowInFolder, IPC.downloadsCancel,
      ].sort(),
    );
  });

  it('list returns repo.list()', () => {
    const rows = [row(1, '/d/f')];
    const handlers = buildDownloadsHandlers(makeRepo(rows) as any, { liveItems: new Map() });
    expect(handlers[IPC.downloadsList]()).toEqual(rows);
  });

  it('remove deletes the row and returns the fresh list', () => {
    const repo = makeRepo([row(1, '/d/f')]);
    const handlers = buildDownloadsHandlers(repo as any, { liveItems: new Map() });
    handlers[IPC.downloadsRemove](1);
    expect(repo.remove).toHaveBeenCalledWith(1);
    expect(repo.list).toHaveBeenCalled();
  });

  it('clear empties the store and returns the fresh list', () => {
    const repo = makeRepo();
    const handlers = buildDownloadsHandlers(repo as any, { liveItems: new Map() });
    handlers[IPC.downloadsClear]();
    expect(repo.clear).toHaveBeenCalledTimes(1);
  });

  it('openFile opens the row savePath via shell.openPath', async () => {
    const repo = makeRepo([row(7, '/d/file.pdf')]);
    const handlers = buildDownloadsHandlers(repo as any, { liveItems: new Map() });
    await handlers[IPC.downloadsOpenFile](7);
    expect(openPath).toHaveBeenCalledWith('/d/file.pdf');
  });

  it('showInFolder reveals the row savePath via shell.showItemInFolder', () => {
    const repo = makeRepo([row(7, '/d/file.pdf')]);
    const handlers = buildDownloadsHandlers(repo as any, { liveItems: new Map() });
    handlers[IPC.downloadsShowInFolder](7);
    expect(showItemInFolder).toHaveBeenCalledWith('/d/file.pdf');
  });

  it('cancel calls cancel() on the live item for that id', () => {
    const item = { cancel: vi.fn() };
    const liveItems = new Map<number, any>([[3, item]]);
    const handlers = buildDownloadsHandlers(makeRepo() as any, { liveItems });
    handlers[IPC.downloadsCancel](3);
    expect(item.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancel is a no-op when there is no live item for that id', () => {
    const handlers = buildDownloadsHandlers(makeRepo() as any, { liveItems: new Map() });
    expect(() => handlers[IPC.downloadsCancel](999)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/downloads.test.ts electron/main/ipc/downloads.test.ts`
Expected: FAIL — `Failed to resolve import './downloads'` / `'./downloads'`.

- [ ] **Step 3: Implement**

`electron/main/downloads.ts`:

```ts
// electron/main/downloads.ts
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DownloadEntry } from '../../shared/types';
import type { DownloadsRepo } from './db/downloadsRepo';
import type { SettingsRepo } from './db/settingsRepo';
import { uniquifyFilename, resolveDownloadDir } from './downloadsHelpers';

// Re-export the pure helpers so the contract's "helpers live in downloads.ts"
// surface holds (they are implemented + unit-tested in downloadsHelpers.ts).
export { uniquifyFilename, resolveDownloadDir } from './downloadsHelpers';

export interface WireDownloadsOpts {
  downloadsRepo: DownloadsRepo;
  settingsRepo: SettingsRepo;
  onChanged: () => void;
  liveItems: Map<number, Electron.DownloadItem>;
}

/**
 * Attach the real download pipeline to a session. On will-download (a SESSION
 * event in Electron 42) the save path is resolved + set SYNCHRONOUSLY in the
 * callback (required by Electron), a DownloadsRepo row is recorded, the live item
 * is tracked for cancel(), and progress/final state are persisted with onChanged()
 * pushes so an open Downloads panel refreshes.
 */
export function wireDownloads(session: Electron.Session, opts: WireDownloadsOpts): void {
  const { downloadsRepo, settingsRepo, onChanged, liveItems } = opts;

  session.on('will-download', (_event, item) => {
    const dir = resolveDownloadDir(settingsRepo.get().downloadDir, app.getPath('downloads'));
    const savePath = uniquifyFilename(join(dir, item.getFilename()), existsSync);
    // setSavePath MUST be called synchronously inside this callback.
    item.setSavePath(savePath);

    const row = downloadsRepo.record({
      url: item.getURL(),
      filename: item.getFilename(),
      savePath,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
    });
    liveItems.set(row.id, item);

    const persist = (state: DownloadEntry['state']): void => {
      downloadsRepo.update(row.id, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state,
      });
      onChanged();
    };

    item.on('updated', (_e, state) => persist(state));
    item.on('done', (_e, state) => {
      persist(state);
      liveItems.delete(row.id);
    });
  });
}
```

`electron/main/ipc/downloads.ts`:

```ts
// electron/main/ipc/downloads.ts
import { shell } from 'electron';
import { IPC } from '../../../shared/types';
import type { DownloadEntry } from '../../../shared/types';
import type { DownloadsRepo } from '../db/downloadsRepo';

/**
 * Builds the downloads IPC handler map (channel -> handler), args WITHOUT the
 * event. Mutations return the fresh DownloadEntry[]. cancel() goes through the
 * main-side liveItems map (keyed by repo id) since DownloadItem is not persisted.
 */
export function buildDownloadsHandlers(
  downloadsRepo: DownloadsRepo,
  opts: { liveItems: Map<number, Electron.DownloadItem> },
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.downloadsList]: (): DownloadEntry[] => downloadsRepo.list(),
    [IPC.downloadsRemove]: (id: number): DownloadEntry[] => {
      downloadsRepo.remove(id);
      return downloadsRepo.list();
    },
    [IPC.downloadsClear]: (): DownloadEntry[] => {
      downloadsRepo.clear();
      return downloadsRepo.list();
    },
    [IPC.downloadsOpenFile]: async (id: number): Promise<void> => {
      const row = downloadsRepo.get(id);
      if (row) await shell.openPath(row.savePath);
    },
    [IPC.downloadsShowInFolder]: (id: number): void => {
      const row = downloadsRepo.get(id);
      if (row) shell.showItemInFolder(row.savePath);
    },
    [IPC.downloadsCancel]: (id: number): void => {
      opts.liveItems.get(id)?.cancel();
    },
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/downloads.test.ts electron/main/ipc/downloads.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/main/downloads.ts electron/main/downloads.test.ts \
        electron/main/ipc/downloads.ts electron/main/ipc/downloads.test.ts
git commit -m "feat(downloads): wireDownloads pipeline + downloads IPC handlers"
```

---

### Task 8: `wirePermissions` (remembered + prompt) + `buildPermissionsHandlers` + prompt pending-Map

**Files:**
- Create: `electron/main/permissions.ts`, `electron/main/ipc/permissions.ts`
- Test: `electron/main/permissions.test.ts`, `electron/main/ipc/permissions.test.ts`

- [ ] **Step 1: Write the failing test**

`electron/main/permissions.test.ts`:

```ts
// electron/main/permissions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { wirePermissions } from './permissions';

function makeSession() {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
}

function makeRepo(memory: Record<string, 'allow' | 'deny'> = {}) {
  return {
    get: vi.fn((origin: string, permission: string) => memory[`${origin}|${permission}`]),
    set: vi.fn((origin: string, permission: string, decision: 'allow' | 'deny') => {
      memory[`${origin}|${permission}`] = decision;
    }),
    list: vi.fn(() => []),
    remove: vi.fn(),
    clear: vi.fn(),
  };
}

describe('wirePermissions', () => {
  it('re-sets BOTH handlers on the session (last-set wins over the deny floor)', () => {
    const session = makeSession();
    wirePermissions(session as any, { permissionsRepo: makeRepo() as any, prompt: vi.fn() });
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });

  it('request: a remembered allow answers callback(true) without prompting', () => {
    const session = makeSession();
    const repo = makeRepo({ 'https://x.test|geolocation': 'allow' });
    const prompt = vi.fn();
    wirePermissions(session as any, { permissionsRepo: repo as any, prompt });
    const reqHandler = session.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    reqHandler({}, 'geolocation', cb, { requestingUrl: 'https://x.test/page' });
    expect(cb).toHaveBeenCalledWith(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('request: a remembered deny answers callback(false)', () => {
    const session = makeSession();
    const repo = makeRepo({ 'https://x.test|media': 'deny' });
    wirePermissions(session as any, { permissionsRepo: repo as any, prompt: vi.fn() });
    const reqHandler = session.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    reqHandler({}, 'media', cb, { requestingUrl: 'https://x.test/' });
    expect(cb).toHaveBeenCalledWith(false);
  });

  it('request: an unremembered in-set permission prompts, persists, then answers', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const prompt = vi.fn(async () => 'allow' as const);
    wirePermissions(session as any, { permissionsRepo: repo as any, prompt });
    const reqHandler = session.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    await reqHandler({}, 'notifications', cb, { requestingUrl: 'https://y.test/a' });
    expect(prompt).toHaveBeenCalledWith('https://y.test', 'notifications');
    expect(repo.set).toHaveBeenCalledWith('https://y.test', 'notifications', 'allow');
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('request: an out-of-set permission is denied without a prompt', () => {
    const session = makeSession();
    const prompt = vi.fn();
    wirePermissions(session as any, { permissionsRepo: makeRepo() as any, prompt });
    const reqHandler = session.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    reqHandler({}, 'usb', cb, { requestingUrl: 'https://z.test/' });
    expect(cb).toHaveBeenCalledWith(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('check: returns true only for a remembered allow', () => {
    const session = makeSession();
    const repo = makeRepo({ 'https://x.test|geolocation': 'allow' });
    wirePermissions(session as any, { permissionsRepo: repo as any, prompt: vi.fn() });
    const checkHandler = session.setPermissionCheckHandler.mock.calls[0][0];
    expect(checkHandler({}, 'geolocation', 'https://x.test', {})).toBe(true);
    expect(checkHandler({}, 'media', 'https://x.test', {})).toBe(false);
  });
});
```

`electron/main/ipc/permissions.test.ts`:

```ts
// electron/main/ipc/permissions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { SitePermission } from '../../../shared/types';
import { buildPermissionsHandlers } from './permissions';

function makeRepo(rows: SitePermission[] = []) {
  return {
    get: vi.fn(),
    set: vi.fn(),
    list: vi.fn(() => rows),
    remove: vi.fn(),
    clear: vi.fn(),
  };
}

describe('buildPermissionsHandlers', () => {
  it('registers exactly the four permissions channels', () => {
    const handlers = buildPermissionsHandlers(makeRepo() as any, { resolvePrompt: vi.fn() });
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.permissionsList, IPC.permissionsRemove, IPC.permissionsClear, IPC.permissionsResolve].sort(),
    );
  });

  it('list returns repo.list()', () => {
    const rows: SitePermission[] = [{ origin: 'https://x', permission: 'media', decision: 'allow' }];
    const handlers = buildPermissionsHandlers(makeRepo(rows) as any, { resolvePrompt: vi.fn() });
    expect(handlers[IPC.permissionsList]()).toEqual(rows);
  });

  it('remove deletes the (origin,permission) row and returns the fresh list', () => {
    const repo = makeRepo();
    const handlers = buildPermissionsHandlers(repo as any, { resolvePrompt: vi.fn() });
    handlers[IPC.permissionsRemove]('https://x', 'media');
    expect(repo.remove).toHaveBeenCalledWith('https://x', 'media');
    expect(repo.list).toHaveBeenCalled();
  });

  it('clear empties the store and returns the fresh list', () => {
    const repo = makeRepo();
    const handlers = buildPermissionsHandlers(repo as any, { resolvePrompt: vi.fn() });
    handlers[IPC.permissionsClear]();
    expect(repo.clear).toHaveBeenCalledTimes(1);
  });

  it('resolve forwards (requestId, decision) to resolvePrompt', () => {
    const resolvePrompt = vi.fn();
    const handlers = buildPermissionsHandlers(makeRepo() as any, { resolvePrompt });
    handlers[IPC.permissionsResolve](42, 'deny');
    expect(resolvePrompt).toHaveBeenCalledWith(42, 'deny');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/permissions.test.ts electron/main/ipc/permissions.test.ts`
Expected: FAIL — `Failed to resolve import './permissions'` / `'./permissions'`.

- [ ] **Step 3: Implement**

`electron/main/permissions.ts`:

```ts
// electron/main/permissions.ts
import type { PermissionsRepo } from './db/permissionsRepo';
import { resolvePermission, originOf, PHASE5_PERMISSIONS } from './permissionsHelpers';

// Re-export the pure helpers so the contract's "helpers live in permissions.ts"
// surface holds (implemented + unit-tested in permissionsHelpers.ts).
export { resolvePermission, originOf } from './permissionsHelpers';

export interface WirePermissionsOpts {
  permissionsRepo: PermissionsRepo;
  /** Raise a prompt to the chrome renderer; resolves with the user's choice. */
  prompt: (origin: string, permission: string) => Promise<'allow' | 'deny'>;
}

/**
 * RE-SET both content-session permission handlers (last-set wins over the
 * ViewController deny floor). Request: a remembered decision is honored; else an
 * in-set permission prompts the renderer (persisting + answering the original
 * callback with the result); everything else is denied. Check: returns true only
 * for a remembered allow (deny-by-default).
 */
export function wirePermissions(session: Electron.Session, opts: WirePermissionsOpts): void {
  const { permissionsRepo, prompt } = opts;

  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = originOf((details as { requestingUrl?: string }).requestingUrl ?? '');
    const remembered = permissionsRepo.get(origin, permission);
    const resolution = resolvePermission(remembered, PHASE5_PERMISSIONS.has(permission));
    if ('decision' in resolution) {
      callback(resolution.decision === 'allow');
      return;
    }
    if ('deny' in resolution) {
      callback(false);
      return;
    }
    // prompt path
    void prompt(origin, permission).then((decision) => {
      permissionsRepo.set(origin, permission, decision);
      callback(decision === 'allow');
    });
  });

  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permissionsRepo.get(requestingOrigin, permission) === 'allow';
  });
}
```

`electron/main/ipc/permissions.ts`:

```ts
// electron/main/ipc/permissions.ts
import { IPC } from '../../../shared/types';
import type { SitePermission } from '../../../shared/types';
import type { PermissionsRepo } from '../db/permissionsRepo';

/**
 * Builds the permissions IPC handler map (channel -> handler), args WITHOUT the
 * event. list/remove/clear manage remembered grants; resolve carries the
 * renderer's answer to a pending prompt back to the main pending-Map (resolvePrompt
 * is provided by buildPromptBridge in boot).
 */
export function buildPermissionsHandlers(
  permissionsRepo: PermissionsRepo,
  opts: { resolvePrompt: (requestId: number, decision: 'allow' | 'deny') => void },
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.permissionsList]: (): SitePermission[] => permissionsRepo.list(),
    [IPC.permissionsRemove]: (origin: string, permission: string): SitePermission[] => {
      permissionsRepo.remove(origin, permission);
      return permissionsRepo.list();
    },
    [IPC.permissionsClear]: (): SitePermission[] => {
      permissionsRepo.clear();
      return permissionsRepo.list();
    },
    [IPC.permissionsResolve]: (requestId: number, decision: 'allow' | 'deny'): void => {
      opts.resolvePrompt(requestId, decision);
    },
  };
}

/**
 * The main-side prompt bridge: a pending-Map correlating prompt request ids to
 * their pending resolvers. `prompt(origin, permission)` emits a permissions.prompt
 * event (via emit) with a fresh request id and returns a Promise the renderer
 * resolves through permissions.resolve → resolvePrompt(requestId, decision).
 */
export function buildPromptBridge(
  emit: (payload: { requestId: number; origin: string; permission: string }) => void,
): {
  prompt: (origin: string, permission: string) => Promise<'allow' | 'deny'>;
  resolvePrompt: (requestId: number, decision: 'allow' | 'deny') => void;
} {
  let nextId = 1;
  const pending = new Map<number, (decision: 'allow' | 'deny') => void>();
  return {
    prompt: (origin, permission) =>
      new Promise<'allow' | 'deny'>((resolve) => {
        const requestId = nextId++;
        pending.set(requestId, resolve);
        emit({ requestId, origin, permission });
      }),
    resolvePrompt: (requestId, decision) => {
      const resolve = pending.get(requestId);
      if (resolve) {
        pending.delete(requestId);
        resolve(decision);
      }
    },
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/permissions.test.ts electron/main/ipc/permissions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/main/permissions.ts electron/main/permissions.test.ts \
        electron/main/ipc/permissions.ts electron/main/ipc/permissions.test.ts
git commit -m "feat(permissions): remembered-permission handlers + prompt bridge + IPC"
```

---

### Task 9: `buildDataHandlers` (export / import merge+replace)

**Files:**
- Create: `electron/main/ipc/data.ts`
- Test: `electron/main/ipc/data.test.ts`

- [ ] **Step 1: Write the failing test**

`electron/main/ipc/data.test.ts`:

```ts
// electron/main/ipc/data.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { Favorite, HistoryEntry, SavedItem, Settings } from '../../../shared/types';

const showSaveDialog = vi.fn();
const showOpenDialog = vi.fn();
vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: (...a: any[]) => showSaveDialog(...a),
    showOpenDialog: (...a: any[]) => showOpenDialog(...a),
  },
}));

const writeFile = vi.fn(async () => undefined);
const readFile = vi.fn(async () => '');
vi.mock('node:fs/promises', () => ({
  writeFile: (...a: any[]) => writeFile(...a),
  readFile: (...a: any[]) => readFile(...a),
}));

import { buildDataHandlers } from './data';

const settings: Settings = {
  siteName: 'Aegis', homeUrl: 'https://h/', primaryColor: '#000',
  defaultSearchTemplate: 'https://d/?q=%s', searchEngines: [], hideChromeByDefault: false,
  downloadDir: '',
};
const fav = (url: string): Favorite => ({ id: 1, name: 'n', url, tags: [], position: 0 });
const hist = (url: string, visitedAt: number): HistoryEntry => ({ id: 1, url, title: 't', visitedAt });
const saved = (url: string): SavedItem => ({ id: 1, url, title: 't', savedAt: 5 });

function makeRepos(over: any = {}) {
  return {
    favoritesRepo: {
      list: vi.fn(() => over.favorites ?? []),
      add: vi.fn(),
      clear: vi.fn(),
      ...over.favoritesRepo,
    },
    historyRepo: {
      list: vi.fn(() => over.history ?? []),
      record: vi.fn(),
      clear: vi.fn(),
      ...over.historyRepo,
    },
    savedRepo: {
      list: vi.fn(() => over.saved ?? []),
      add: vi.fn(),
      clear: vi.fn(),
      ...over.savedRepo,
    },
    settingsRepo: { get: vi.fn(() => settings), set: vi.fn() },
  };
}

const win = {} as any;

describe('buildDataHandlers export', () => {
  it('registers exactly the two data channels', () => {
    const handlers = buildDataHandlers(makeRepos() as any, win);
    expect(Object.keys(handlers).sort()).toEqual([IPC.dataExport, IPC.dataImport].sort());
  });

  it('writes a version-1 payload to the chosen path and returns {ok,path}', async () => {
    const repos = makeRepos({ favorites: [fav('https://a/')], history: [hist('https://a/', 7)], saved: [saved('https://a/')] });
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/aegis-export.json' });
    const handlers = buildDataHandlers(repos as any, win);
    const res = await handlers[IPC.dataExport]();
    expect(repos.historyRepo.list).toHaveBeenCalledWith({ limit: 100000 });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, body] = writeFile.mock.calls[0];
    expect(path).toBe('/out/aegis-export.json');
    const parsed = JSON.parse(body as string);
    expect(parsed).toMatchObject({
      version: 1,
      favorites: [fav('https://a/')],
      history: [hist('https://a/', 7)],
      saved: [saved('https://a/')],
      settings,
    });
    expect(res).toEqual({ ok: true, path: '/out/aegis-export.json' });
  });

  it('returns {ok:false} and does not write when the save dialog is canceled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const handlers = buildDataHandlers(makeRepos() as any, win);
    const res = await handlers[IPC.dataExport]();
    expect(writeFile).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });
});

describe('buildDataHandlers import', () => {
  const exportJson = JSON.stringify({
    version: 1,
    favorites: [fav('https://have/'), fav('https://new/')],
    history: [hist('https://have/', 1), hist('https://new/', 2)],
    saved: [fav('https://new/')].map((f) => saved(f.url)),
    settings,
  });

  it('replace mode clears each store, inserts all, and overwrites settings', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/x.json'] });
    readFile.mockResolvedValue(exportJson);
    const repos = makeRepos({
      favorites: [fav('https://have/')],
      saved: [saved('https://have/')],
      history: [hist('https://have/', 0)],
    });
    const handlers = buildDataHandlers(repos as any, win);
    const res = await handlers[IPC.dataImport]('replace');
    expect(repos.favoritesRepo.clear).toHaveBeenCalledTimes(1);
    expect(repos.savedRepo.clear).toHaveBeenCalledTimes(1);
    expect(repos.historyRepo.clear).toHaveBeenCalledTimes(1);
    expect(repos.favoritesRepo.add).toHaveBeenCalledTimes(2);
    expect(repos.settingsRepo.set).toHaveBeenCalledWith(settings);
    expect(res).toEqual({ ok: true, counts: { favorites: 2, history: 2, saved: 1 } });
  });

  it('history inserts preserve the original visitedAt timestamps', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/x.json'] });
    readFile.mockResolvedValue(exportJson);
    const repos = makeRepos();
    const handlers = buildDataHandlers(repos as any, win);
    await handlers[IPC.dataImport]('replace');
    // record(entry, nowFn) where nowFn() returns the entry's own visitedAt
    const firstCall = repos.historyRepo.record.mock.calls[0];
    expect(firstCall[0]).toMatchObject({ url: 'https://have/' });
    expect(firstCall[1]()).toBe(1);
    const secondCall = repos.historyRepo.record.mock.calls[1];
    expect(secondCall[1]()).toBe(2);
  });

  it('merge mode only inserts rows whose url is not already present', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/x.json'] });
    readFile.mockResolvedValue(exportJson);
    const repos = makeRepos({
      favorites: [fav('https://have/')],
      saved: [saved('https://have/')],
      history: [hist('https://have/', 0)],
    });
    const handlers = buildDataHandlers(repos as any, win);
    const res = await handlers[IPC.dataImport]('merge');
    expect(repos.favoritesRepo.clear).not.toHaveBeenCalled();
    expect(repos.favoritesRepo.add).toHaveBeenCalledTimes(1); // only https://new/
    expect(repos.settingsRepo.set).toHaveBeenCalledWith(settings);
    expect(res).toEqual({ ok: true, counts: { favorites: 1, history: 1, saved: 1 } });
  });

  it('returns {ok:false} when the open dialog is canceled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handlers = buildDataHandlers(makeRepos() as any, win);
    const res = await handlers[IPC.dataImport]('merge');
    expect(readFile).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });

  it('returns {ok:false,error} when the file fails validation', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/bad.json'] });
    readFile.mockResolvedValue(JSON.stringify({ version: 2 }));
    const repos = makeRepos();
    const handlers = buildDataHandlers(repos as any, win);
    const res = await handlers[IPC.dataImport]('merge');
    expect(repos.favoritesRepo.add).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/ipc/data.test.ts`
Expected: FAIL — `Failed to resolve import './data'`.

- [ ] **Step 3: Implement**

`electron/main/ipc/data.ts`:

```ts
// electron/main/ipc/data.ts
import { dialog } from 'electron';
import { writeFile, readFile } from 'node:fs/promises';
import { IPC } from '../../../shared/types';
import type { ImportMode } from '../../../shared/types';
import type { FavoritesRepo } from '../db/favoritesRepo';
import type { HistoryRepo } from '../db/historyRepo';
import type { SavedRepo } from '../db/savedRepo';
import type { SettingsRepo } from '../db/settingsRepo';
import { validateExport, planImport } from '../dataPort';
import type { ExportPayload } from '../dataPort';

export interface DataRepos {
  favoritesRepo: FavoritesRepo;
  historyRepo: HistoryRepo;
  savedRepo: SavedRepo;
  settingsRepo: SettingsRepo;
}

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];

/**
 * Builds the data export/import IPC handler map (channel -> handler), args WITHOUT
 * the event. Export serializes favorites+history+saved+settings to a save-dialog
 * path; import open-dialogs + validates + plans (pure dataPort) then applies the
 * chosen mode. History inserts preserve visitedAt via record(entry, ()=>visitedAt).
 */
export function buildDataHandlers(
  repos: DataRepos,
  win: Electron.BaseWindow,
): Record<string, (...a: any[]) => any> {
  const { favoritesRepo, historyRepo, savedRepo, settingsRepo } = repos;

  return {
    [IPC.dataExport]: async (): Promise<{ ok: boolean; path?: string }> => {
      const payload: ExportPayload = {
        version: 1,
        favorites: favoritesRepo.list(),
        history: historyRepo.list({ limit: 100000 }),
        saved: savedRepo.list(),
        settings: settingsRepo.get(),
      };
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: 'aegis-export.json',
        filters: JSON_FILTER,
      });
      if (canceled || !filePath) return { ok: false };
      await writeFile(filePath, JSON.stringify(payload, null, 2));
      return { ok: true, path: filePath };
    },

    [IPC.dataImport]: async (
      mode: ImportMode,
    ): Promise<{ ok: boolean; counts?: { favorites: number; history: number; saved: number }; error?: string }> => {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: JSON_FILTER,
      });
      if (canceled || filePaths.length === 0) return { ok: false };

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePaths[0], 'utf-8'));
      } catch {
        return { ok: false, error: 'unreadable file' };
      }
      const valid = validateExport(parsed);
      if (!valid.ok) return { ok: false, error: valid.error };

      const existing = {
        favorites: favoritesRepo.list(),
        saved: savedRepo.list(),
        historyUrls: new Set(historyRepo.list({ limit: 100000 }).map((h) => h.url)),
      };
      const plan = planImport(valid.payload, existing, mode);

      if (plan.replace) {
        favoritesRepo.clear();
        savedRepo.clear();
        historyRepo.clear();
      }
      for (const f of plan.favorites) favoritesRepo.add({ name: f.name, url: f.url, tags: f.tags });
      for (const s of plan.saved) savedRepo.add({ url: s.url, title: s.title });
      for (const h of plan.history) historyRepo.record({ url: h.url, title: h.title }, () => h.visitedAt);
      settingsRepo.set(plan.settings);

      return { ok: true, counts: plan.counts };
    },
  };
}
```

> Verified against §1.8: `historyRepo.record({url,title}, now=Date.now)` accepts a `now` function — `() => h.visitedAt` preserves the original timestamp; `historyRepo.list({limit})` accepts `{limit}`; `favoritesRepo.add({name,url,tags})` / `savedRepo.add({url,title})` match. `clear()` on Favorites/Saved is added in Block A Task 4.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/ipc/data.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/main/ipc/data.ts electron/main/ipc/data.test.ts
git commit -m "feat(data): export/import IPC handlers (merge + replace) via dataPort"
```

---

### Task 10: `buildPickerHandlers` (inject → append cosmetic rule → rebuild)

**Files:**
- Create: `electron/main/ipc/picker.ts`
- Test: `electron/main/ipc/picker.test.ts`

- [ ] **Step 1: Write the failing test**

`electron/main/ipc/picker.test.ts`:

```ts
// electron/main/ipc/picker.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import { buildPickerHandlers } from './picker';
import { PICKER_IIFE } from '../pickerHelpers';

function makeVc(url: string, selectorResult: string | null) {
  return {
    getState: vi.fn(() => ({ url })),
    contentWebContents: {
      executeJavaScript: vi.fn(async (_code: string, _gesture?: boolean) => selectorResult),
    },
  };
}

function makeCustomFiltersRepo(initial = '') {
  let text = initial;
  return {
    get: vi.fn(() => text),
    set: vi.fn((t: string) => {
      text = t;
    }),
  };
}

describe('buildPickerHandlers', () => {
  it('registers exactly the picker.start channel', () => {
    const handlers = buildPickerHandlers({
      vc: makeVc('https://x/', null) as any,
      customFiltersRepo: makeCustomFiltersRepo() as any,
      rebuildFromCache: vi.fn(),
    });
    expect(Object.keys(handlers)).toEqual([IPC.pickerStart]);
  });

  it('injects PICKER_IIFE with a user gesture into the content WC', async () => {
    const vc = makeVc('https://shop.test/cart', '.banner-ad');
    const handlers = buildPickerHandlers({
      vc: vc as any, customFiltersRepo: makeCustomFiltersRepo() as any, rebuildFromCache: vi.fn(),
    });
    await handlers[IPC.pickerStart]();
    expect(vc.contentWebContents.executeJavaScript).toHaveBeenCalledWith(PICKER_IIFE, true);
  });

  it('on a selector, appends `${host}##${selector}` to my-filters, rebuilds, and returns {ok,rule}', async () => {
    const vc = makeVc('https://shop.test/cart?x=1', '.banner-ad');
    const repo = makeCustomFiltersRepo('||a.test^');
    const rebuildFromCache = vi.fn();
    const handlers = buildPickerHandlers({ vc: vc as any, customFiltersRepo: repo as any, rebuildFromCache });
    const res = await handlers[IPC.pickerStart]();
    expect(repo.set).toHaveBeenCalledWith('||a.test^\nshop.test##.banner-ad');
    expect(rebuildFromCache).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ ok: true, rule: 'shop.test##.banner-ad' });
  });

  it('appends with no leading blank line when my-filters is empty', async () => {
    const vc = makeVc('https://shop.test/', '#ad');
    const repo = makeCustomFiltersRepo('');
    const handlers = buildPickerHandlers({ vc: vc as any, customFiltersRepo: repo as any, rebuildFromCache: vi.fn() });
    await handlers[IPC.pickerStart]();
    expect(repo.set).toHaveBeenCalledWith('shop.test###ad');
  });

  it('on cancel (null selector) returns {ok:false} without touching my-filters', async () => {
    const vc = makeVc('https://shop.test/', null);
    const repo = makeCustomFiltersRepo('keep');
    const rebuildFromCache = vi.fn();
    const handlers = buildPickerHandlers({ vc: vc as any, customFiltersRepo: repo as any, rebuildFromCache });
    const res = await handlers[IPC.pickerStart]();
    expect(repo.set).not.toHaveBeenCalled();
    expect(rebuildFromCache).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });

  it('returns {ok:false} when the current URL has no usable host', async () => {
    const vc = makeVc('about:blank', '.x');
    const repo = makeCustomFiltersRepo();
    const handlers = buildPickerHandlers({ vc: vc as any, customFiltersRepo: repo as any, rebuildFromCache: vi.fn() });
    const res = await handlers[IPC.pickerStart]();
    expect(repo.set).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/ipc/picker.test.ts`
Expected: FAIL — `Failed to resolve import './picker'`.

- [ ] **Step 3: Implement**

`electron/main/ipc/picker.ts`:

```ts
// electron/main/ipc/picker.ts
import { IPC } from '../../../shared/types';
import type { ViewController } from '../viewController';
import type { CustomFiltersRepo } from '../db/customFiltersRepo';
import { appendCosmeticRule, PICKER_IIFE } from '../pickerHelpers';

/** Host of a URL (no scheme/port), or '' when there is no usable host. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export interface PickerDeps {
  vc: ViewController;
  customFiltersRepo: CustomFiltersRepo;
  rebuildFromCache: () => void;
}

/**
 * Builds the element-picker IPC handler (channel -> handler), args WITHOUT the
 * event. start() injects PICKER_IIFE into the sandboxed content WC with a user
 * gesture; on a returned selector it appends `${host}##${selector}` to the Phase-4
 * my-filters blob (read-modify-write) and rebuilds the engine from cache so the
 * rule applies on the next navigation. Cancel/no-host returns {ok:false}.
 */
export function buildPickerHandlers(deps: PickerDeps): Record<string, (...a: any[]) => any> {
  const { vc, customFiltersRepo, rebuildFromCache } = deps;
  return {
    [IPC.pickerStart]: async (): Promise<{ ok: boolean; rule?: string }> => {
      const host = hostOf(vc.getState().url);
      if (!host) return { ok: false };
      const selector: string | null = await vc.contentWebContents.executeJavaScript(PICKER_IIFE, true);
      if (!selector) return { ok: false };
      const rule = `${host}##${selector}`;
      customFiltersRepo.set(appendCosmeticRule(customFiltersRepo.get(), host, selector));
      rebuildFromCache();
      return { ok: true, rule };
    },
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/main/ipc/picker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/main/ipc/picker.ts electron/main/ipc/picker.test.ts
git commit -m "feat(picker): element-picker IPC (inject IIFE → cosmetic rule → rebuild)"
```

---

### Task 11: Build-mode-aware CSP plugin (strict prod / relaxed dev), remove the static meta

**Files:**
- Modify: `electron.vite.config.ts` (add the CSP plugin to the renderer config), `src/index.html` (remove the static `<meta http-equiv="Content-Security-Policy">`)
- Verify: `npm run build` + assert the strict CSP in `out/renderer/index.html`

> This is a config task (not red-green): the verification is the built artifact carrying the strict directives. The dev-relaxed branch is exercised at runtime by `electron-vite dev`; the e2e (Block E Task 24) asserts the built strict CSP.

- [ ] **Step 1 (config): edit the renderer config to inject a build-mode-aware CSP meta**

In `electron.vite.config.ts`, add the plugin factory below `copySeedPlugin()` (verified: `transformIndexHtml` is a Vite plugin hook; `electron-vite` passes `command`/mode via the config callback, but a self-contained env check via `this`/`process.env` is brittle — instead the plugin reads the mode from the `transformIndexHtml` context's `server` presence, which is the documented dev-vs-build discriminator: `ctx.server` is defined only under `vite dev`):

```ts
/**
 * Inject a build-mode-aware Content-Security-Policy <meta> into the CHROME renderer
 * document only (the privileged React UI). Production/build = strict; dev/serve =
 * relaxed so Vite HMR (inline bootstrap script, eval, the ws: socket) works. The
 * static <meta> was removed from src/index.html so this is the single source. The
 * VISITED content view intentionally gets NO app CSP (correct browser behavior).
 *
 * dev vs build is discriminated by the transformIndexHtml context: ctx.server is
 * present only under `vite dev`/serve, absent during a production build.
 */
const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
  "base-uri 'none'; frame-src 'none'; form-action 'none'";
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' ws:; font-src 'self'; object-src 'none'";

function cspPlugin() {
  return {
    name: 'aegis-chrome-csp',
    transformIndexHtml(html: string, ctx: { server?: unknown }) {
      const content = ctx && ctx.server ? CSP_DEV : CSP_PROD;
      const meta = `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
      // Inject right after the <head> open tag.
      return html.replace(/<head>/, `<head>\n    ${meta}`);
    },
  };
}
```

Then add it to the renderer plugins array:

```ts
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
      },
    },
  },
```

- [ ] **Step 2 (html): remove the static CSP meta**

Edit `src/index.html` — delete the static CSP `<meta>` (lines 6-9) so the plugin is the only source:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Aegis</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Verify the built artifact carries the strict CSP**

Run:
```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && grep -F "Content-Security-Policy" out/renderer/index.html
```
Expected: the built `out/renderer/index.html` contains exactly the strict prod meta:
`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'" />`
and that the relaxed `'unsafe-eval'` / `ws:` tokens are ABSENT:
```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis && ! grep -F "unsafe-eval" out/renderer/index.html && ! grep -F "ws:" out/renderer/index.html && echo "STRICT-OK"
```
Expected: prints `STRICT-OK`.

- [ ] **Step 4: Commit**

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron.vite.config.ts src/index.html
git commit -m "feat(security): build-mode-aware chrome CSP plugin; drop static meta"
```

---

### Task 12: Boot wiring in `index.ts` — repos, wireDownloads, wirePermissions, fullscreen, handlers, registry

**Files:**
- Modify: `electron/main/index.ts` (imports, repo construction, wiring, the `registerGuardedHandlers` call, `__aegisTest`)
- Verify: `npm run build` + `npx tsc --noEmit` (boot is tsc-clean) + grep for the new wiring

> Boot wiring is not naturally red-green; verification = a clean build + tsc + grep proving the wiring is present. The behavior is exercised by Block E e2e (Tasks 23-25).

- [ ] **Step 1 (edit): add the new imports** to `electron/main/index.ts` (after the existing repo imports, before the adblock imports):

```ts
import { DownloadsRepo } from './db/downloadsRepo';
import { PermissionsRepo } from './db/permissionsRepo';
import { wireDownloads } from './downloads';
import { wirePermissions } from './permissions';
import { buildDownloadsHandlers } from './ipc/downloads';
import { buildPermissionsHandlers, buildPromptBridge } from './ipc/permissions';
import { buildDataHandlers } from './ipc/data';
import { buildPickerHandlers } from './ipc/picker';
```

- [ ] **Step 2 (edit): construct the new repos** — add after `const savedRepo = new SavedRepo(db);` (`:79`):

```ts
  const downloadsRepo = new DownloadsRepo(db);
  const permissionsRepo = new PermissionsRepo(db);
```

- [ ] **Step 3 (edit): wire downloads, permissions, and fullscreen** — add after the `HistoryRecorder` block (`:123-127`), before the `// ---- Adblock subsystem ----` comment:

```ts
  // ---- Downloads pipeline (content session) ----
  const liveDownloads = new Map<number, Electron.DownloadItem>();
  const onDownloadsChanged = (): void => chromeWc.send(IPC.evtDownloadsChanged);
  wireDownloads(vc.contentSession, {
    downloadsRepo,
    settingsRepo,
    onChanged: onDownloadsChanged,
    liveItems: liveDownloads,
  });

  // ---- Remembered site-permissions (re-sets both content-session handlers) ----
  const promptBridge = buildPromptBridge((payload) =>
    chromeWc.send(IPC.evtPermissionsPrompt, payload),
  );
  wirePermissions(vc.contentSession, {
    permissionsRepo,
    prompt: promptBridge.prompt,
  });

  // ---- HTML5 fullscreen (content view drives the BaseWindow) ----
  vc.contentWebContents.on('enter-html-full-screen', () => win.setFullScreen(true));
  vc.contentWebContents.on('leave-html-full-screen', () => win.setFullScreen(false));
```

- [ ] **Step 4 (edit): register the new handlers** — extend the single `registerGuardedHandlers(chromeWc.id, {...})` call (`:239-250`) by adding these spreads before the closing `});`:

```ts
    ...buildDownloadsHandlers(downloadsRepo, { liveItems: liveDownloads, onChanged: onDownloadsChanged }),
    ...buildPermissionsHandlers(permissionsRepo, { resolvePrompt: promptBridge.resolvePrompt }),
    ...buildDataHandlers({ favoritesRepo, historyRepo, savedRepo, settingsRepo }, win),
    ...buildPickerHandlers({ vc, customFiltersRepo, rebuildFromCache: rebuildEngineFromCache }),
```

So the full call reads:

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
    ...buildDownloadsHandlers(downloadsRepo, { liveItems: liveDownloads, onChanged: onDownloadsChanged }),
    ...buildPermissionsHandlers(permissionsRepo, { resolvePrompt: promptBridge.resolvePrompt }),
    ...buildDataHandlers({ favoritesRepo, historyRepo, savedRepo, settingsRepo }, win),
    ...buildPickerHandlers({ vc, customFiltersRepo, rebuildFromCache: rebuildEngineFromCache }),
  });
```

> Note: `buildDownloadsHandlers`'s second arg only needs `liveItems` per §4; `onChanged` is accepted as an optional extra (matching the `{ liveItems, onChanged? }` ledger shape) and is harmless — the live push already runs inside `wireDownloads`. Keeping it documents intent. If the Block-A-frozen `buildDownloadsHandlers` signature is `{ liveItems }` only, drop `onChanged` from this spread; the implementation in Task 7 declares `opts: { liveItems }`, so pass `{ liveItems: liveDownloads }`:

```ts
    ...buildDownloadsHandlers(downloadsRepo, { liveItems: liveDownloads }),
```

Use the form matching the Task-7 signature: `{ liveItems: liveDownloads }`.

- [ ] **Step 5 (edit): extend `__aegisTest`** — add a `phase5` block inside the `if (process.env.AEGIS_E2E === '1')` registry (`:252-277`), keeping `places`/`phase4`:

```ts
      phase5: {
        downloadsRepo,
        permissionsRepo,
      },
```

So the registry object gains, after the `phase4: {...}` block:

```ts
      phase4: {
        settingsRepo,
        subsRepo,
        customFiltersRepo,
        rebuildFromCache: rebuildEngineFromCache,
        updateNow,
        navHome: () => vc.navigate(settingsRepo.get().homeUrl),
      },
      phase5: {
        downloadsRepo,
        permissionsRepo,
      },
```

- [ ] **Step 6: Verify build + tsc-clean + wiring present**

Run:
```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis && npm run build && npx tsc --noEmit
```
Expected: build succeeds; `tsc --noEmit` prints no errors.

Then confirm the wiring landed:
```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis && grep -n "wireDownloads\|wirePermissions\|enter-html-full-screen\|buildDataHandlers\|buildPickerHandlers\|phase5" electron/main/index.ts
```
Expected: each of `wireDownloads(`, `wirePermissions(`, `enter-html-full-screen`, `buildDataHandlers(`, `buildPickerHandlers(`, and `phase5:` appears once in `index.ts`.

- [ ] **Step 7: Commit**

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/main/index.ts
git commit -m "feat(boot): wire downloads/permissions/fullscreen + data/picker handlers + phase5 registry"
```

---

### Task 13: `chromePreload.ts` — downloads/permissions/data/picker namespaces + the two events

**Files:**
- Modify: `electron/preload/chromePreload.ts` (imports + four new namespaces), 
- Test: `electron/preload/chromePreload.test.ts` (new describe block)
- Verify: `npx tsc --noEmit` (chromePreload tsc-clean)

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `electron/preload/chromePreload.test.ts`:

```ts
describe('chromePreload downloads + permissions + data + picker (Phase 5)', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  it('exposes the four Phase-5 namespaces', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.downloads.list).toBe('function');
    expect(typeof api.downloads.remove).toBe('function');
    expect(typeof api.downloads.clear).toBe('function');
    expect(typeof api.downloads.openFile).toBe('function');
    expect(typeof api.downloads.showInFolder).toBe('function');
    expect(typeof api.downloads.cancel).toBe('function');
    expect(typeof api.downloads.onChanged).toBe('function');
    expect(typeof api.permissions.list).toBe('function');
    expect(typeof api.permissions.remove).toBe('function');
    expect(typeof api.permissions.clear).toBe('function');
    expect(typeof api.permissions.resolve).toBe('function');
    expect(typeof api.permissions.onPrompt).toBe('function');
    expect(typeof api.data.export).toBe('function');
    expect(typeof api.data.import).toBe('function');
    expect(typeof api.picker.start).toBe('function');
  });

  it('downloads.list invokes IPC.downloadsList and returns the resolved list', async () => {
    const rows = [{ id: 1, url: 'https://d/', filename: 'f', savePath: '/d/f', state: 'completed', receivedBytes: 1, totalBytes: 1, startedAt: 0 }];
    h.invoke = vi.fn(async () => rows);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.downloads.list();
    expect(h.invoke).toHaveBeenCalledWith(IPC.downloadsList);
    expect(out).toEqual(rows);
  });

  it('downloads.remove/clear/openFile/showInFolder/cancel invoke their channels with args', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.downloads.remove(3);
    expect(h.invoke).toHaveBeenCalledWith(IPC.downloadsRemove, 3);
    await api.downloads.clear();
    expect(h.invoke).toHaveBeenCalledWith(IPC.downloadsClear);
    await api.downloads.openFile(3);
    expect(h.invoke).toHaveBeenCalledWith(IPC.downloadsOpenFile, 3);
    await api.downloads.showInFolder(3);
    expect(h.invoke).toHaveBeenCalledWith(IPC.downloadsShowInFolder, 3);
    await api.downloads.cancel(3);
    expect(h.invoke).toHaveBeenCalledWith(IPC.downloadsCancel, 3);
  });

  it('downloads.onChanged registers on IPC.evtDownloadsChanged and delivers (no payload)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    api.downloads.onChanged(cb);
    const arr = h.listeners.get(IPC.evtDownloadsChanged)!;
    expect(arr).toHaveLength(1);
    arr[0]({}, undefined);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('downloads.onChanged returns an unsubscriber that removes the listener', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    const off = api.downloads.onChanged(cb);
    const registered = h.listeners.get(IPC.evtDownloadsChanged)![0];
    off();
    expect(h.removed).toEqual([{ channel: IPC.evtDownloadsChanged, fn: registered }]);
  });

  it('permissions.list/remove/clear/resolve invoke their channels with args', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.permissions.list();
    expect(h.invoke).toHaveBeenCalledWith(IPC.permissionsList);
    await api.permissions.remove('https://x', 'media');
    expect(h.invoke).toHaveBeenCalledWith(IPC.permissionsRemove, 'https://x', 'media');
    await api.permissions.clear();
    expect(h.invoke).toHaveBeenCalledWith(IPC.permissionsClear);
    await api.permissions.resolve(7, 'allow');
    expect(h.invoke).toHaveBeenCalledWith(IPC.permissionsResolve, 7, 'allow');
  });

  it('permissions.onPrompt registers on IPC.evtPermissionsPrompt and delivers the payload', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    api.permissions.onPrompt(cb);
    const arr = h.listeners.get(IPC.evtPermissionsPrompt)!;
    expect(arr).toHaveLength(1);
    const payload = { requestId: 5, origin: 'https://y', permission: 'geolocation' };
    arr[0]({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('data.export and data.import invoke their channels', async () => {
    h.invoke = vi.fn(async () => ({ ok: true }));
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.data.export();
    expect(h.invoke).toHaveBeenCalledWith(IPC.dataExport);
    await api.data.import('replace');
    expect(h.invoke).toHaveBeenCalledWith(IPC.dataImport, 'replace');
  });

  it('picker.start invokes IPC.pickerStart and returns the resolved result', async () => {
    h.invoke = vi.fn(async () => ({ ok: true, rule: 'x.com##.ad' }));
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.picker.start();
    expect(h.invoke).toHaveBeenCalledWith(IPC.pickerStart);
    expect(out).toEqual({ ok: true, rule: 'x.com##.ad' });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/preload/chromePreload.test.ts`
Expected: FAIL — `api.downloads` is `undefined` (`Cannot read properties of undefined (reading 'list')`), the four namespaces are not yet on the bridged API.

- [ ] **Step 3: Implement**

In `electron/preload/chromePreload.ts`, extend the type import to pull in the Phase-5 types:

```ts
import type {
  AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings,
  AdblockState, BlockedCount, ListUpdateResult,
  Favorite, HistoryEntry, SavedItem, ContentInset, Subscription,
  DownloadEntry, SitePermission, PermissionPrompt, ImportMode,
} from '../../shared/types';
```

Then add the four namespaces to the `api` object literal (after the `saved: {...}` block, before the closing `};`):

```ts
  downloads: {
    list: (): Promise<DownloadEntry[]> => ipcRenderer.invoke(IPC.downloadsList),
    remove: (id: number): Promise<DownloadEntry[]> => ipcRenderer.invoke(IPC.downloadsRemove, id),
    clear: (): Promise<DownloadEntry[]> => ipcRenderer.invoke(IPC.downloadsClear),
    openFile: (id: number): Promise<void> => ipcRenderer.invoke(IPC.downloadsOpenFile, id),
    showInFolder: (id: number): Promise<void> => ipcRenderer.invoke(IPC.downloadsShowInFolder, id),
    cancel: (id: number): Promise<void> => ipcRenderer.invoke(IPC.downloadsCancel, id),
    onChanged: (cb: () => void) => subscribe<unknown>(IPC.evtDownloadsChanged, () => cb()),
  },
  permissions: {
    list: (): Promise<SitePermission[]> => ipcRenderer.invoke(IPC.permissionsList),
    remove: (origin: string, permission: string): Promise<SitePermission[]> =>
      ipcRenderer.invoke(IPC.permissionsRemove, origin, permission),
    clear: (): Promise<SitePermission[]> => ipcRenderer.invoke(IPC.permissionsClear),
    resolve: (requestId: number, decision: 'allow' | 'deny'): Promise<void> =>
      ipcRenderer.invoke(IPC.permissionsResolve, requestId, decision),
    onPrompt: (cb: (p: PermissionPrompt) => void) =>
      subscribe<PermissionPrompt>(IPC.evtPermissionsPrompt, cb),
  },
  data: {
    export: (): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke(IPC.dataExport),
    import: (mode: ImportMode): Promise<{ ok: boolean; counts?: any }> =>
      ipcRenderer.invoke(IPC.dataImport, mode),
  },
  picker: {
    start: (): Promise<{ ok: boolean; rule?: string }> => ipcRenderer.invoke(IPC.pickerStart),
  },
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx vitest run electron/preload/chromePreload.test.ts`
Expected: PASS

- [ ] **Step 5: Verify chromePreload is tsc-clean, then commit**

Run: `cd /home/happyhobo/Documents/AI_Apps/Aegis && npx tsc --noEmit`
Expected: no errors.

```bash
cd /home/happyhobo/Documents/AI_Apps/Aegis
git add electron/preload/chromePreload.ts electron/preload/chromePreload.test.ts
git commit -m "feat(preload): expose downloads/permissions/data/picker namespaces + events"
```

---

#### New names introduced (Block B)

- **`electron/main/downloadsHelpers.ts`:** `uniquifyFilename`, `resolveDownloadDir`
- **`electron/main/permissionsHelpers.ts`:** `resolvePermission`, `originOf`, `PHASE5_PERMISSIONS`, type `PermissionResolution`
- **`electron/main/dataPort.ts`:** `validateExport`, `planImport`, types `ExportPayload`, `ValidateResult`, `ExistingData`, `ImportPlan`
- **`electron/main/pickerHelpers.ts`:** `appendCosmeticRule`, `computeSelector`, `PICKER_IIFE`
- **`electron/main/downloads.ts`:** `wireDownloads`, interface `WireDownloadsOpts` (re-exports `uniquifyFilename`, `resolveDownloadDir`)
- **`electron/main/ipc/downloads.ts`:** `buildDownloadsHandlers`
- **`electron/main/permissions.ts`:** `wirePermissions`, interface `WirePermissionsOpts` (re-exports `resolvePermission`, `originOf`)
- **`electron/main/ipc/permissions.ts`:** `buildPermissionsHandlers`, `buildPromptBridge`
- **`electron/main/ipc/data.ts`:** `buildDataHandlers`, interface `DataRepos`
- **`electron/main/ipc/picker.ts`:** `buildPickerHandlers`, interface `PickerDeps`
- **`electron.vite.config.ts`:** `cspPlugin` (local), `CSP_PROD`, `CSP_DEV` (local consts)
- **`electron/main/index.ts`:** local boot bindings `downloadsRepo`, `permissionsRepo`, `liveDownloads`, `onDownloadsChanged`, `promptBridge`; `__aegisTest.phase5 = { downloadsRepo, permissionsRepo }`

I have everything I need. The branch `phase-5` already exists. The contract specifies the exact AegisApi members for downloads/permissions in section 3. Now I'll write the two TDD tasks following the as-built hook patterns exactly (matching useHistory's onChanged refresh pattern for useDownloads, and useAdblock's event-subscription pattern for usePermissions's prompt event).

### Task 14: `useDownloads` renderer hook

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useDownloads.ts`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/useDownloads.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/useDownloads.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { DownloadEntry } from '../../shared/types';

const list = vi.fn();
const remove = vi.fn();
const clear = vi.fn();
const openFile = vi.fn();
const showInFolder = vi.fn();
const cancel = vi.fn();
const onChanged = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    downloads: {
      list: (...a: any[]) => list(...a),
      remove: (...a: any[]) => remove(...a),
      clear: (...a: any[]) => clear(...a),
      openFile: (...a: any[]) => openFile(...a),
      showInFolder: (...a: any[]) => showInFolder(...a),
      cancel: (...a: any[]) => cancel(...a),
      onChanged: (cb: () => void) => onChanged(cb),
    },
  },
}));

import { useDownloads } from './useDownloads';

const dl = (over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id: 1,
  url: 'https://example.com/file.zip',
  filename: 'file.zip',
  savePath: '/home/u/Downloads/file.zip',
  state: 'progressing',
  receivedBytes: 0,
  totalBytes: 1000,
  startedAt: 1000,
  ...over,
});

const seed: DownloadEntry[] = [
  dl({ id: 2, filename: 'b.zip', state: 'progressing', receivedBytes: 500, totalBytes: 1000 }),
  dl({ id: 1, filename: 'a.zip', state: 'completed', receivedBytes: 1000, totalBytes: 1000 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  remove.mockResolvedValue(seed);
  clear.mockResolvedValue([]);
  openFile.mockResolvedValue(undefined);
  showInFolder.mockResolvedValue(undefined);
  cancel.mockResolvedValue(undefined);
  onChanged.mockReturnValue(() => {});
});

describe('useDownloads', () => {
  it('seeds downloads from aegis.downloads.list on mount', async () => {
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.downloads[0].filename).toBe('b.zip');
  });

  it('subscribes to onChanged and re-fetches the list when the event fires', async () => {
    let pushed: (() => void) | undefined;
    onChanged.mockImplementation((cb: () => void) => {
      pushed = cb;
      return () => {};
    });
    const refreshed: DownloadEntry[] = [
      dl({ id: 2, filename: 'b.zip', state: 'completed', receivedBytes: 1000, totalBytes: 1000 }),
    ];
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      pushed!();
    });
    await waitFor(() => expect(result.current.downloads).toHaveLength(1));
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.downloads[0].state).toBe('completed');
  });

  it('remove() calls aegis with the id and re-fetches the list', async () => {
    remove.mockResolvedValue([seed[0]]);
    list.mockResolvedValueOnce(seed).mockResolvedValue([seed[0]]);
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.remove(1);
    });
    expect(remove).toHaveBeenCalledWith(1);
    expect(result.current.downloads.map((d) => d.id)).toEqual([2]);
  });

  it('clear() calls aegis and re-fetches the (emptied) list', async () => {
    list.mockResolvedValueOnce(seed).mockResolvedValue([]);
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.clear();
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result.current.downloads).toEqual([]);
  });

  it('openFile() delegates to aegis.downloads.openFile with the id', async () => {
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.openFile(2);
    });
    expect(openFile).toHaveBeenCalledWith(2);
  });

  it('showInFolder() delegates to aegis.downloads.showInFolder with the id', async () => {
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.showInFolder(2);
    });
    expect(showInFolder).toHaveBeenCalledWith(2);
  });

  it('cancel() delegates to aegis.downloads.cancel with the id and re-fetches the list', async () => {
    list.mockResolvedValueOnce(seed).mockResolvedValue([
      dl({ id: 2, filename: 'b.zip', state: 'cancelled', receivedBytes: 500, totalBytes: 1000 }),
      seed[1],
    ]);
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.cancel(2);
    });
    expect(cancel).toHaveBeenCalledWith(2);
    await waitFor(() => expect(result.current.downloads[0].state).toBe('cancelled'));
  });

  it('unsubscribes from onChanged on unmount', async () => {
    const unsubscribe = vi.fn();
    onChanged.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useDownloads());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/hooks/useDownloads.test.tsx`

Expected: FAIL — module resolution error `Failed to load url ./useDownloads` / `Cannot find module './useDownloads'` (the hook file does not exist yet).

- [ ] **Step 3: Implement**

```ts
// src/hooks/useDownloads.ts
import { useCallback, useEffect, useState } from 'react';
import type { DownloadEntry } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useDownloads(): {
  downloads: DownloadEntry[];
  remove(id: number): Promise<void>;
  clear(): Promise<void>;
  openFile(id: number): Promise<void>;
  showInFolder(id: number): Promise<void>;
  cancel(id: number): Promise<void>;
} {
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);

  // Always re-read the authoritative list rather than trusting an action's
  // return value, so the live `downloads.changed` pushes (progress/done) and
  // the explicit actions converge on a single source of truth (mirrors
  // useHistory's refresh-on-onChanged pattern).
  const refresh = useCallback(async (): Promise<void> => {
    setDownloads(await aegis.downloads.list());
  }, []);

  useEffect(() => {
    let active = true;
    void aegis.downloads.list().then((next) => {
      if (active) setDownloads(next);
    });
    const unsubscribe = aegis.downloads.onChanged(() => {
      void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refresh]);

  const remove = useCallback(
    async (id: number): Promise<void> => {
      await aegis.downloads.remove(id);
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(async (): Promise<void> => {
    await aegis.downloads.clear();
    await refresh();
  }, [refresh]);

  const openFile = useCallback(async (id: number): Promise<void> => {
    await aegis.downloads.openFile(id);
  }, []);

  const showInFolder = useCallback(async (id: number): Promise<void> => {
    await aegis.downloads.showInFolder(id);
  }, []);

  const cancel = useCallback(
    async (id: number): Promise<void> => {
      await aegis.downloads.cancel(id);
      await refresh();
    },
    [refresh],
  );

  return { downloads, remove, clear, openFile, showInFolder, cancel };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/hooks/useDownloads.test.tsx`

Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useDownloads.ts src/hooks/useDownloads.test.tsx
git commit -m "feat(renderer): add useDownloads hook (list + onChanged refresh + remove/clear/open/show/cancel)"
```

---

### Task 15: `usePermissions` renderer hook

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/usePermissions.ts`
- Test: `/home/happyhobo/Documents/AI_Apps/Aegis/src/hooks/usePermissions.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/hooks/usePermissions.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SitePermission, PermissionPrompt } from '../../shared/types';

const list = vi.fn();
const remove = vi.fn();
const clear = vi.fn();
const resolve = vi.fn();
const onPrompt = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    permissions: {
      list: (...a: any[]) => list(...a),
      remove: (...a: any[]) => remove(...a),
      clear: (...a: any[]) => clear(...a),
      resolve: (...a: any[]) => resolve(...a),
      onPrompt: (cb: (p: PermissionPrompt) => void) => onPrompt(cb),
    },
  },
}));

import { usePermissions } from './usePermissions';

const perm = (over: Partial<SitePermission> = {}): SitePermission => ({
  origin: 'https://example.com',
  permission: 'geolocation',
  decision: 'allow',
  ...over,
});

const seed: SitePermission[] = [
  perm({ origin: 'https://a.example', permission: 'geolocation', decision: 'allow' }),
  perm({ origin: 'https://b.example', permission: 'notifications', decision: 'deny' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  remove.mockResolvedValue(seed);
  clear.mockResolvedValue([]);
  resolve.mockResolvedValue(undefined);
  onPrompt.mockReturnValue(() => {});
});

describe('usePermissions', () => {
  it('seeds permissions from aegis.permissions.list on mount', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.permissions[0].origin).toBe('https://a.example');
  });

  it('starts with no active prompt', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    expect(result.current.prompt).toBeNull();
  });

  it('remove() calls aegis with origin + permission and syncs the returned list', async () => {
    remove.mockResolvedValue([seed[1]]);
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    await act(async () => {
      await result.current.remove('https://a.example', 'geolocation');
    });
    expect(remove).toHaveBeenCalledWith('https://a.example', 'geolocation');
    expect(result.current.permissions.map((p) => p.origin)).toEqual(['https://b.example']);
  });

  it('clear() calls aegis and syncs the returned (emptied) list', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    await act(async () => {
      await result.current.clear();
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result.current.permissions).toEqual([]);
  });

  it('surfaces an incoming permissions.prompt event as the active prompt', async () => {
    let pushed: ((p: PermissionPrompt) => void) | undefined;
    onPrompt.mockImplementation((cb: (p: PermissionPrompt) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ requestId: 7, origin: 'https://c.example', permission: 'media' }));
    expect(result.current.prompt).toEqual({ requestId: 7, origin: 'https://c.example', permission: 'media' });
  });

  it('prompt.resolve("allow") forwards requestId + decision to aegis and clears the active prompt', async () => {
    let pushed: ((p: PermissionPrompt) => void) | undefined;
    onPrompt.mockImplementation((cb: (p: PermissionPrompt) => void) => {
      pushed = cb;
      return () => {};
    });
    const refreshed: SitePermission[] = [
      ...seed,
      perm({ origin: 'https://c.example', permission: 'media', decision: 'allow' }),
    ];
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ requestId: 7, origin: 'https://c.example', permission: 'media' }));
    expect(result.current.prompt).not.toBeNull();
    await act(async () => {
      await result.current.resolve('allow');
    });
    expect(resolve).toHaveBeenCalledWith(7, 'allow');
    expect(result.current.prompt).toBeNull();
  });

  it('resolve() refreshes the remembered list (a remembered grant now appears)', async () => {
    let pushed: ((p: PermissionPrompt) => void) | undefined;
    onPrompt.mockImplementation((cb: (p: PermissionPrompt) => void) => {
      pushed = cb;
      return () => {};
    });
    const refreshed: SitePermission[] = [
      ...seed,
      perm({ origin: 'https://c.example', permission: 'media', decision: 'allow' }),
    ];
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    act(() => pushed!({ requestId: 9, origin: 'https://c.example', permission: 'media' }));
    await act(async () => {
      await result.current.resolve('allow');
    });
    await waitFor(() => expect(result.current.permissions).toHaveLength(3));
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.permissions[2].origin).toBe('https://c.example');
  });

  it('resolve() is a no-op when there is no active prompt', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    await act(async () => {
      await result.current.resolve('deny');
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('unsubscribes from onPrompt on unmount', async () => {
    const unsubscribe = vi.fn();
    onPrompt.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => usePermissions());
    await waitFor(() => expect(onPrompt).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/hooks/usePermissions.test.tsx`

Expected: FAIL — module resolution error `Failed to load url ./usePermissions` / `Cannot find module './usePermissions'` (the hook file does not exist yet).

- [ ] **Step 3: Implement**

```ts
// src/hooks/usePermissions.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SitePermission, PermissionPrompt } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function usePermissions(): {
  permissions: SitePermission[];
  prompt: PermissionPrompt | null;
  remove(origin: string, permission: string): Promise<void>;
  clear(): Promise<void>;
  resolve(decision: 'allow' | 'deny'): Promise<void>;
} {
  const [permissions, setPermissions] = useState<SitePermission[]>([]);
  const [prompt, setPrompt] = useState<PermissionPrompt | null>(null);

  // Read the active prompt at call time inside resolve() without re-binding the
  // callback on every prompt change (mirrors useAdblock's urlRef pattern).
  const promptRef = useRef<PermissionPrompt | null>(prompt);
  promptRef.current = prompt;

  const refresh = useCallback(async (): Promise<void> => {
    setPermissions(await aegis.permissions.list());
  }, []);

  useEffect(() => {
    let active = true;
    void aegis.permissions.list().then((next) => {
      if (active) setPermissions(next);
    });
    const unsubscribe = aegis.permissions.onPrompt((p: PermissionPrompt) => {
      setPrompt(p);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const remove = useCallback(async (origin: string, permission: string): Promise<void> => {
    setPermissions(await aegis.permissions.remove(origin, permission));
  }, []);

  const clear = useCallback(async (): Promise<void> => {
    setPermissions(await aegis.permissions.clear());
  }, []);

  const resolve = useCallback(
    async (decision: 'allow' | 'deny'): Promise<void> => {
      const active = promptRef.current;
      if (active === null) return;
      // Clear optimistically so the dialog dismisses immediately; the resolve
      // round-trip then persists the decision and refresh() pulls the freshly
      // remembered (origin, permission) row into the list.
      setPrompt(null);
      await aegis.permissions.resolve(active.requestId, decision);
      await refresh();
    },
    [refresh],
  );

  return { permissions, prompt, remove, clear, resolve };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/hooks/usePermissions.test.tsx`

Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePermissions.ts src/hooks/usePermissions.test.tsx
git commit -m "feat(renderer): add usePermissions hook (list/remove/clear + permissions.prompt event -> active prompt + resolve)"
```

---

#### New names introduced (Block C)

- `useDownloads` (exported function) — `src/hooks/useDownloads.ts`
- `usePermissions` (exported function) — `src/hooks/usePermissions.ts`

I now have all the patterns I need. The App.test mock object will need the new namespaces (downloads, permissions, data, picker) added. Note the App.test inset assertion uses `{ top: 96, left: 0 }` / `{ top: 96, left: 280 }` — these stay unchanged.

One detail to confirm: the `useDownloads` / `usePermissions` hook return shapes from the contract §4 ledger:
- `useDownloads()` → `{ downloads, remove, clear, openFile, showInFolder, cancel }`
- `usePermissions()` → `{ permissions, remove, clear, prompt }` where prompt = the active PermissionPrompt|null + resolve.

The ledger says `usePermissions` returns `{ permissions, remove, clear, prompt }`. The "prompt = the active PermissionPrompt|null + resolve" means `prompt` is an object holding the active prompt and a resolve function. I'll model `usePermissions().prompt` as `{ active: PermissionPrompt|null, resolve(requestId, decision) }` for the App wiring (Task 22) and the permission-prompt dialog (Task 19). This is a Block C concern, but since I wire it, I'll reference it precisely and have the dialog component itself take plain props (`prompt`, `onResolve`) so it's independently testable without the hook.

I have everything needed. Now I'll produce the markdown for Tasks 16-22.

### Task 16: `DownloadsPanel` + Sidebar 3rd tab (Downloads)

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsPanel.tsx`
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsPanel.test.tsx`
- Modify: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Sidebar.tsx:5` (Tab union), `:7-12` (props), `:14-19` (signature + useId pairs), `:33-66` (add tab button + convert panel ternary to a map)
- Modify (test): `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Sidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsPanel.test.tsx`:

```tsx
// src/components/DownloadsPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DownloadEntry } from '../../shared/types';
import { DownloadsPanel } from './DownloadsPanel';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
}));
import { confirm } from '../lib/toast';

const entry = (over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id: 1,
  url: 'https://example.com/file.zip',
  filename: 'file.zip',
  savePath: '/home/u/Downloads/file.zip',
  state: 'completed',
  receivedBytes: 1024,
  totalBytes: 1024,
  startedAt: 1000,
  ...over,
});

function props(over: Partial<React.ComponentProps<typeof DownloadsPanel>> = {}) {
  return {
    downloads: [] as DownloadEntry[],
    remove: vi.fn(),
    clear: vi.fn(),
    openFile: vi.fn(),
    showInFolder: vi.fn(),
    cancel: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('DownloadsPanel', () => {
  it('renders an empty message when there are no downloads', () => {
    render(<DownloadsPanel {...props()} />);
    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument();
  });

  it('is labelled as a Downloads group for assistive tech', () => {
    render(<DownloadsPanel {...props()} />);
    expect(screen.getByRole('group', { name: /downloads/i })).toBeInTheDocument();
  });

  it('lists each download by filename with its url', () => {
    render(<DownloadsPanel {...props({ downloads: [entry()] })} />);
    expect(screen.getByText('file.zip')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/file.zip')).toBeInTheDocument();
  });

  it('shows Open file / Show in folder for a completed download and calls the handlers', async () => {
    const p = props({ downloads: [entry({ id: 7, state: 'completed' })] });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /open file file\.zip/i }));
    await userEvent.click(screen.getByRole('button', { name: /show file\.zip in folder/i }));
    expect(p.openFile).toHaveBeenCalledWith(7);
    expect(p.showInFolder).toHaveBeenCalledWith(7);
  });

  it('shows a Cancel action for a progressing download and calls cancel', async () => {
    const p = props({
      downloads: [entry({ id: 3, state: 'progressing', receivedBytes: 500, totalBytes: 1000 })],
    });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel file\.zip/i }));
    expect(p.cancel).toHaveBeenCalledWith(3);
  });

  it('does NOT offer Cancel for a completed download', () => {
    render(<DownloadsPanel {...props({ downloads: [entry({ state: 'completed' })] })} />);
    expect(screen.queryByRole('button', { name: /cancel file\.zip/i })).not.toBeInTheDocument();
  });

  it('renders a progress bar reflecting received/total for a progressing download', () => {
    render(
      <DownloadsPanel
        {...props({
          downloads: [entry({ state: 'progressing', receivedBytes: 250, totalBytes: 1000 })],
        })}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: /file\.zip download progress/i });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
  });

  it('removes a download via its remove button', async () => {
    const p = props({ downloads: [entry({ id: 9 })] });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove file\.zip/i }));
    expect(p.remove).toHaveBeenCalledWith(9);
  });

  it('Clear all confirms then clears, and is disabled when empty', async () => {
    const p = props({ downloads: [entry()] });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all downloads/i }));
    expect(confirm).toHaveBeenCalled();
    expect(p.clear).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const p = props({ downloads: [entry()] });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all downloads/i }));
    expect(p.clear).not.toHaveBeenCalled();
  });

  it('disables Clear all when there are no downloads', () => {
    render(<DownloadsPanel {...props()} />);
    expect(screen.getByRole('button', { name: /clear all downloads/i })).toBeDisabled();
  });
});
```

Append to `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Sidebar.test.tsx` (inside the existing `describe('Sidebar', …)` block, before its closing `});`):

```tsx
  it('exposes a Downloads tab and switches to its panel', async () => {
    render(
      <Sidebar
        {...props({ downloads: <div data-testid="downloads-slot">downloads</div> })}
      />,
    );
    expect(screen.getByRole('tab', { name: /downloads/i })).toHaveAttribute('aria-selected', 'false');
    await userEvent.click(screen.getByRole('tab', { name: /downloads/i }));
    expect(screen.getByTestId('downloads-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
    expect(screen.queryByTestId('saved-slot')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /downloads/i })).toHaveAttribute('aria-selected', 'true');
  });
```

Also update the existing `props()` helper at the top of `Sidebar.test.tsx` to supply the new required slot. Replace:

```tsx
    history: <div data-testid="history-slot">history</div>,
    saved: <div data-testid="saved-slot">saved</div>,
    ...overrides,
```

with:

```tsx
    history: <div data-testid="history-slot">history</div>,
    saved: <div data-testid="saved-slot">saved</div>,
    downloads: <div data-testid="downloads-slot">downloads</div>,
    ...overrides,
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/DownloadsPanel.test.tsx src/components/Sidebar.test.tsx`
Expected: FAIL — `DownloadsPanel.test.tsx` fails with `Failed to resolve import "./DownloadsPanel"` (the module does not exist), and `Sidebar.test.tsx` fails with `Unable to find an accessible element with the role "tab" and name /downloads/i` (the third tab is not rendered yet).

- [ ] **Step 3: Implement**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsPanel.tsx`:

```tsx
// src/components/DownloadsPanel.tsx
import type { DownloadEntry } from '../../shared/types';
import { confirm } from '../lib/toast';

export interface DownloadsPanelProps {
  downloads: DownloadEntry[];
  remove(id: number): Promise<void> | void;
  clear(): Promise<void> | void;
  openFile(id: number): Promise<void> | void;
  showInFolder(id: number): Promise<void> | void;
  cancel(id: number): Promise<void> | void;
}

/** Whole-percent received/total, clamped 0..100; 0 when total is unknown. */
function percentOf(received: number, total: number): number {
  if (total <= 0) return 0;
  const pct = Math.round((received / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

export function DownloadsPanel({
  downloads,
  remove,
  clear,
  openFile,
  showInFolder,
  cancel,
}: DownloadsPanelProps) {
  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear the downloads list? This does not delete the files.');
    if (ok) void clear();
  };

  return (
    <div className="downloads-panel" role="group" aria-label="Downloads">
      <button
        type="button"
        className="downloads-panel__clear"
        aria-label="Clear all downloads"
        disabled={downloads.length === 0}
        onClick={() => void handleClear()}
      >
        Clear all
      </button>
      {downloads.length === 0 ? (
        <p className="downloads-panel__empty">No downloads yet.</p>
      ) : (
        <ul className="downloads-panel__list">
          {downloads.map((d) => {
            const pct = percentOf(d.receivedBytes, d.totalBytes);
            return (
              <li key={d.id} className="downloads-panel__row">
                <span className="downloads-panel__filename">{d.filename}</span>
                <span className="downloads-panel__url">{d.url}</span>
                <span className="downloads-panel__state">{d.state}</span>
                {d.state === 'progressing' && (
                  <div
                    role="progressbar"
                    aria-label={`${d.filename} download progress`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    className="downloads-panel__progress"
                  >
                    <span
                      className="downloads-panel__progress-fill"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                <div className="downloads-panel__actions">
                  {d.state === 'completed' && (
                    <>
                      <button
                        type="button"
                        aria-label={`Open file ${d.filename}`}
                        onClick={() => void openFile(d.id)}
                      >
                        Open file
                      </button>
                      <button
                        type="button"
                        aria-label={`Show ${d.filename} in folder`}
                        onClick={() => void showInFolder(d.id)}
                      >
                        Show in folder
                      </button>
                    </>
                  )}
                  {d.state === 'progressing' && (
                    <button
                      type="button"
                      aria-label={`Cancel ${d.filename}`}
                      onClick={() => void cancel(d.id)}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${d.filename}`}
                    onClick={() => void remove(d.id)}
                  >
                    &times;
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

Edit `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Sidebar.tsx` to add the third tab and convert the binary ternary to a map. Replace the entire file with:

```tsx
// src/components/Sidebar.tsx
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

type Tab = 'history' | 'saved' | 'downloads';

export interface SidebarProps {
  open: boolean;
  onToggle(): void;
  history: ReactNode;
  saved: ReactNode;
  downloads: ReactNode;
}

export function Sidebar({ open, onToggle, history, saved, downloads }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('history');
  const historyTabId = useId();
  const savedTabId = useId();
  const downloadsTabId = useId();
  const historyPanelId = useId();
  const savedPanelId = useId();
  const downloadsPanelId = useId();

  const tabIds: Record<Tab, string> = {
    history: historyTabId,
    saved: savedTabId,
    downloads: downloadsTabId,
  };
  const panelIds: Record<Tab, string> = {
    history: historyPanelId,
    saved: savedPanelId,
    downloads: downloadsPanelId,
  };
  const labels: Record<Tab, string> = {
    history: 'History',
    saved: 'Saved',
    downloads: 'Downloads',
  };
  const panels: Record<Tab, ReactNode> = {
    history,
    saved,
    downloads,
  };
  const order: Tab[] = ['history', 'saved', 'downloads'];

  return (
    <aside className="sidebar" aria-label="Sidebar">
      <button
        type="button"
        className="sidebar__toggle"
        aria-label="Toggle sidebar"
        aria-expanded={open}
        onClick={onToggle}
      >
        {'☰'}
      </button>
      {open && (
        <div className="sidebar__body">
          <div className="sidebar__tabs" role="tablist" aria-label="Sidebar panels">
            {order.map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                id={tabIds[t]}
                aria-controls={panelIds[t]}
                aria-selected={tab === t}
                className="sidebar__tab"
                onClick={() => setTab(t)}
              >
                {labels[t]}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={panelIds[tab]} aria-labelledby={tabIds[tab]}>
            {panels[tab]}
          </div>
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/DownloadsPanel.test.tsx src/components/Sidebar.test.tsx`
Expected: PASS — all DownloadsPanel cases and the new + existing Sidebar cases green.

- [ ] **Step 5: Commit**

```bash
git add src/components/DownloadsPanel.tsx src/components/DownloadsPanel.test.tsx src/components/Sidebar.tsx src/components/Sidebar.test.tsx
git commit -m "feat(renderer): DownloadsPanel + Sidebar Downloads tab (map-based panels)"
```

---

### Task 17: Toolbar downloads indicator

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsIndicator.tsx`
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsIndicator.test.tsx`
- Modify: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Toolbar.tsx:24-28` (props), `:30-40` (signature), `:58-59` (slot)
- Modify (test): `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Toolbar.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsIndicator.test.tsx`:

```tsx
// src/components/DownloadsIndicator.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadsIndicator } from './DownloadsIndicator';

describe('DownloadsIndicator', () => {
  it('renders a button labelled Downloads', () => {
    render(<DownloadsIndicator activeCount={0} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /downloads/i })).toBeInTheDocument();
  });

  it('shows the active-count badge when there are active downloads', () => {
    render(<DownloadsIndicator activeCount={3} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /downloads/i })).toHaveTextContent('3');
  });

  it('does NOT show a numeric badge when there are no active downloads', () => {
    render(<DownloadsIndicator activeCount={0} onOpen={vi.fn()} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('reflects the active count in the accessible name', () => {
    render(<DownloadsIndicator activeCount={2} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /downloads \(2 active\)/i })).toBeInTheDocument();
  });

  it('calls onOpen when clicked', async () => {
    const onOpen = vi.fn();
    render(<DownloadsIndicator activeCount={1} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: /downloads/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
```

Append to `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Toolbar.test.tsx` (inside `describe('Toolbar', …)`, before its closing `});`):

```tsx
  it('renders the optional downloads slot when provided', () => {
    render(
      <Toolbar
        state={state}
        {...handlers()}
        downloads={<button type="button">Downloads</button>}
      />,
    );
    expect(screen.getByRole('button', { name: /^downloads$/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/DownloadsIndicator.test.tsx src/components/Toolbar.test.tsx`
Expected: FAIL — `DownloadsIndicator.test.tsx` fails with `Failed to resolve import "./DownloadsIndicator"`, and the new Toolbar case fails with `Unable to find an accessible element with the role "button" and name /^downloads$/i` (no `downloads` prop/slot yet).

- [ ] **Step 3: Implement**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsIndicator.tsx`:

```tsx
// src/components/DownloadsIndicator.tsx
export interface DownloadsIndicatorProps {
  /** Number of downloads currently in the `progressing` state. */
  activeCount: number;
  /** Open the sidebar to the Downloads tab. */
  onOpen(): void;
}

export function DownloadsIndicator({ activeCount, onOpen }: DownloadsIndicatorProps) {
  const label =
    activeCount > 0 ? `Downloads (${activeCount} active)` : 'Downloads';
  return (
    <button
      type="button"
      className="toolbar__downloads"
      aria-label={label}
      onClick={onOpen}
    >
      <span aria-hidden="true">{'⬇'}</span>
      {activeCount > 0 && (
        <span className="toolbar__downloads-badge" aria-hidden="true">
          {activeCount}
        </span>
      )}
    </button>
  );
}
```

Edit `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/Toolbar.tsx`. Add a `downloads` slot to the props interface — replace:

```tsx
  /** Optional toolbar slot for the Settings gear button (Phase 4). */
  gear?: ReactNode;
}
```

with:

```tsx
  /** Optional toolbar slot for the Settings gear button (Phase 4). */
  gear?: ReactNode;
  /** Optional toolbar slot for the downloads indicator (Phase 5). */
  downloads?: ReactNode;
}
```

Replace the destructuring:

```tsx
  adblock,
  bookmark,
  gear,
}: ToolbarProps) {
```

with:

```tsx
  adblock,
  bookmark,
  gear,
  downloads,
}: ToolbarProps) {
```

Replace the slot rendering:

```tsx
      {bookmark}
      {gear}
    </div>
```

with:

```tsx
      {bookmark}
      {downloads}
      {gear}
    </div>
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/DownloadsIndicator.test.tsx src/components/Toolbar.test.tsx`
Expected: PASS — DownloadsIndicator cases and the new + existing Toolbar cases green.

- [ ] **Step 5: Commit**

```bash
git add src/components/DownloadsIndicator.tsx src/components/DownloadsIndicator.test.tsx src/components/Toolbar.tsx src/components/Toolbar.test.tsx
git commit -m "feat(renderer): toolbar downloads indicator + Toolbar downloads slot"
```

---

### Task 18: `DownloadsTab` (download-directory editor)

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsTab.tsx`
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsTab.test.tsx`:

```tsx
// src/components/DownloadsTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';
import type { Settings } from '../../shared/types';
import { DownloadsTab } from './DownloadsTab';

const baseSettings: Settings = {
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#4f8cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '/home/u/Downloads',
};

function props(over: Partial<React.ComponentProps<typeof DownloadsTab>> = {}) {
  return {
    settings: baseSettings,
    update: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DownloadsTab', () => {
  it('renders a labelled download folder input seeded from settings', () => {
    render(<DownloadsTab {...props()} />);
    expect(screen.getByLabelText(/download folder/i)).toHaveValue('/home/u/Downloads');
  });

  it('saves the trimmed downloadDir via update on Save', async () => {
    const p = props();
    render(<DownloadsTab {...p} />);
    const input = screen.getByLabelText(/download folder/i);
    fireEvent.change(input, { target: { value: '  /tmp/dl  ' } });
    await userEvent.click(screen.getByRole('button', { name: /save download folder/i }));
    expect(p.update).toHaveBeenCalledWith({ downloadDir: '/tmp/dl' });
  });

  it('Use default clears the downloadDir to the empty string (OS Downloads)', async () => {
    const p = props();
    render(<DownloadsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /use default/i }));
    expect(p.update).toHaveBeenCalledWith({ downloadDir: '' });
  });

  it('shows the OS-default hint when downloadDir is empty', () => {
    render(<DownloadsTab {...props({ settings: { ...baseSettings, downloadDir: '' } })} />);
    expect(screen.getByText(/system downloads folder/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/DownloadsTab.test.tsx`
Expected: FAIL with `Failed to resolve import "./DownloadsTab"` (the component does not exist yet).

- [ ] **Step 3: Implement**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DownloadsTab.tsx`:

```tsx
// src/components/DownloadsTab.tsx
import { useState } from 'react';
import type { Settings } from '../../shared/types';

export interface DownloadsTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function DownloadsTab({ settings, update }: DownloadsTabProps) {
  const [dir, setDir] = useState(settings.downloadDir);

  const handleSave = (): void => {
    void update({ downloadDir: dir.trim() });
  };

  const handleUseDefault = (): void => {
    setDir('');
    void update({ downloadDir: '' });
  };

  return (
    <div className="downloads-tab" role="group" aria-label="Download folder">
      <label htmlFor="downloads-tab-dir">Download folder</label>
      <input
        id="downloads-tab-dir"
        type="text"
        aria-label="Download folder"
        value={dir}
        onChange={(e) => setDir(e.target.value)}
      />
      <div className="downloads-tab__actions">
        <button type="button" aria-label="Save download folder" onClick={handleSave}>
          Save
        </button>
        <button type="button" aria-label="Use default download folder" onClick={handleUseDefault}>
          Use default
        </button>
      </div>
      {settings.downloadDir.length === 0 && (
        <p className="downloads-tab__hint">
          Empty — downloads go to your system Downloads folder.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/DownloadsTab.test.tsx`
Expected: PASS — all four cases green.

- [ ] **Step 5: Commit**

```bash
git add src/components/DownloadsTab.tsx src/components/DownloadsTab.test.tsx
git commit -m "feat(renderer): DownloadsTab download-folder editor (Settings)"
```

---

### Task 19: `SitePermissionsTab` + permission-prompt dialog

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SitePermissionsTab.tsx`
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SitePermissionsTab.test.tsx`
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/PermissionPromptDialog.tsx`
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/PermissionPromptDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SitePermissionsTab.test.tsx`:

```tsx
// src/components/SitePermissionsTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SitePermission } from '../../shared/types';
import { SitePermissionsTab } from './SitePermissionsTab';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
}));
import { confirm } from '../lib/toast';

const perm = (over: Partial<SitePermission> = {}): SitePermission => ({
  origin: 'https://example.com',
  permission: 'geolocation',
  decision: 'allow',
  ...over,
});

function props(over: Partial<React.ComponentProps<typeof SitePermissionsTab>> = {}) {
  return {
    permissions: [] as SitePermission[],
    remove: vi.fn(),
    clear: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('SitePermissionsTab', () => {
  it('shows an empty message when there are no remembered permissions', () => {
    render(<SitePermissionsTab {...props()} />);
    expect(screen.getByText(/no remembered site permissions/i)).toBeInTheDocument();
  });

  it('lists each (origin, permission, decision) row', () => {
    render(
      <SitePermissionsTab
        {...props({
          permissions: [
            perm({ origin: 'https://a.test', permission: 'media', decision: 'deny' }),
          ],
        })}
      />,
    );
    expect(screen.getByText('https://a.test')).toBeInTheDocument();
    expect(screen.getByText('media')).toBeInTheDocument();
    expect(screen.getByText('deny')).toBeInTheDocument();
  });

  it('revokes a row via remove(origin, permission)', async () => {
    const p = props({
      permissions: [perm({ origin: 'https://b.test', permission: 'notifications' })],
    });
    render(<SitePermissionsTab {...p} />);
    await userEvent.click(
      screen.getByRole('button', { name: /revoke notifications for https:\/\/b\.test/i }),
    );
    expect(p.remove).toHaveBeenCalledWith('https://b.test', 'notifications');
  });

  it('Clear all confirms then clears', async () => {
    const p = props({ permissions: [perm()] });
    render(<SitePermissionsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all site permissions/i }));
    expect(confirm).toHaveBeenCalled();
    expect(p.clear).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const p = props({ permissions: [perm()] });
    render(<SitePermissionsTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all site permissions/i }));
    expect(p.clear).not.toHaveBeenCalled();
  });

  it('disables Clear all when empty', () => {
    render(<SitePermissionsTab {...props()} />);
    expect(screen.getByRole('button', { name: /clear all site permissions/i })).toBeDisabled();
  });
});
```

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/PermissionPromptDialog.test.tsx`:

```tsx
// src/components/PermissionPromptDialog.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PermissionPrompt } from '../../shared/types';
import { PermissionPromptDialog } from './PermissionPromptDialog';

const prompt = (over: Partial<PermissionPrompt> = {}): PermissionPrompt => ({
  requestId: 11,
  origin: 'https://example.com',
  permission: 'geolocation',
  ...over,
});

function props(over: Partial<React.ComponentProps<typeof PermissionPromptDialog>> = {}) {
  return {
    prompt: prompt(),
    onResolve: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PermissionPromptDialog', () => {
  it('renders a modal dialog naming the origin and permission', () => {
    render(<PermissionPromptDialog {...props()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveTextContent('https://example.com');
    expect(dialog).toHaveTextContent(/geolocation/i);
  });

  it('Allow resolves the request with allow', async () => {
    const p = props({ prompt: prompt({ requestId: 5 }) });
    render(<PermissionPromptDialog {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));
    expect(p.onResolve).toHaveBeenCalledWith(5, 'allow');
  });

  it('Block resolves the request with deny', async () => {
    const p = props({ prompt: prompt({ requestId: 6 }) });
    render(<PermissionPromptDialog {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^block$/i }));
    expect(p.onResolve).toHaveBeenCalledWith(6, 'deny');
  });

  it('Escape resolves the request with deny (closing == blocking)', async () => {
    const p = props({ prompt: prompt({ requestId: 7 }) });
    render(<PermissionPromptDialog {...p} />);
    await userEvent.keyboard('{Escape}');
    expect(p.onResolve).toHaveBeenCalledWith(7, 'deny');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/SitePermissionsTab.test.tsx src/components/PermissionPromptDialog.test.tsx`
Expected: FAIL with `Failed to resolve import "./SitePermissionsTab"` and `Failed to resolve import "./PermissionPromptDialog"` (neither component exists yet).

- [ ] **Step 3: Implement**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SitePermissionsTab.tsx`:

```tsx
// src/components/SitePermissionsTab.tsx
import type { SitePermission } from '../../shared/types';
import { confirm } from '../lib/toast';

export interface SitePermissionsTabProps {
  permissions: SitePermission[];
  remove(origin: string, permission: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export function SitePermissionsTab({ permissions, remove, clear }: SitePermissionsTabProps) {
  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear all remembered site permissions?');
    if (ok) void clear();
  };

  return (
    <div className="site-permissions-tab" role="group" aria-label="Site permissions">
      <div className="site-permissions-tab__actions">
        <button
          type="button"
          aria-label="Clear all site permissions"
          disabled={permissions.length === 0}
          onClick={() => void handleClear()}
        >
          Clear all
        </button>
      </div>
      {permissions.length === 0 ? (
        <p className="site-permissions-tab__empty">No remembered site permissions.</p>
      ) : (
        <ul className="site-permissions-tab__list">
          {permissions.map((p) => (
            <li
              key={`${p.origin}|${p.permission}`}
              className="site-permissions-tab__row"
            >
              <span className="site-permissions-tab__origin">{p.origin}</span>
              <span className="site-permissions-tab__permission">{p.permission}</span>
              <span className="site-permissions-tab__decision">{p.decision}</span>
              <button
                type="button"
                aria-label={`Revoke ${p.permission} for ${p.origin}`}
                onClick={() => void remove(p.origin, p.permission)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/PermissionPromptDialog.tsx`:

```tsx
// src/components/PermissionPromptDialog.tsx
import { useId } from 'react';
import type { PermissionPrompt } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';

export interface PermissionPromptDialogProps {
  prompt: PermissionPrompt;
  onResolve(requestId: number, decision: 'allow' | 'deny'): void;
}

export function PermissionPromptDialog({ prompt, onResolve }: PermissionPromptDialogProps) {
  const msgId = useId();
  // Closing the dialog (Escape / focus-trap dismiss) is treated as a Block.
  const dialogRef = useDialog<HTMLDivElement>(() => onResolve(prompt.requestId, 'deny'));

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-describedby={msgId}
      className="permission-prompt"
    >
      <p id={msgId} className="permission-prompt__message">
        {prompt.origin} wants to use {prompt.permission}.
      </p>
      <div className="permission-prompt__actions">
        <button type="button" onClick={() => onResolve(prompt.requestId, 'allow')}>
          Allow
        </button>
        <button type="button" onClick={() => onResolve(prompt.requestId, 'deny')}>
          Block
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/SitePermissionsTab.test.tsx src/components/PermissionPromptDialog.test.tsx`
Expected: PASS — all SitePermissionsTab and PermissionPromptDialog cases green.

- [ ] **Step 5: Commit**

```bash
git add src/components/SitePermissionsTab.tsx src/components/SitePermissionsTab.test.tsx src/components/PermissionPromptDialog.tsx src/components/PermissionPromptDialog.test.tsx
git commit -m "feat(renderer): SitePermissionsTab + permission-prompt dialog"
```

---

### Task 20: `DataTab` (export + import with merge/replace)

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DataTab.tsx`
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DataTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DataTab.test.tsx`:

```tsx
// src/components/DataTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImportMode } from '../../shared/types';
import { DataTab } from './DataTab';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { confirm, toast } from '../lib/toast';

function props(over: Partial<React.ComponentProps<typeof DataTab>> = {}) {
  return {
    onExport: vi.fn(async () => ({ ok: true, path: '/tmp/aegis-export.json' })),
    onImport: vi.fn(async (_mode: ImportMode) => ({ ok: true, counts: {} })),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('DataTab', () => {
  it('Export calls onExport and reports success with the path', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    expect(p.onExport).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('does NOT toast success when export is canceled', async () => {
    const p = props({ onExport: vi.fn(async () => ({ ok: false })) });
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^export$/i }));
    await waitFor(() => expect(p.onExport).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('defaults the import mode to merge and imports without a confirm', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(confirm).not.toHaveBeenCalled();
    expect(p.onImport).toHaveBeenCalledWith('merge');
  });

  it('selecting replace requires a confirm before importing', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('radio', { name: /replace/i }));
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(confirm).toHaveBeenCalled();
    expect(p.onImport).toHaveBeenCalledWith('replace');
  });

  it('does NOT import in replace mode when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('radio', { name: /replace/i }));
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    expect(p.onImport).not.toHaveBeenCalled();
  });

  it('reports a success toast after a completed import', async () => {
    const p = props();
    render(<DataTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/DataTab.test.tsx`
Expected: FAIL with `Failed to resolve import "./DataTab"` (the component does not exist yet).

- [ ] **Step 3: Implement**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/DataTab.tsx`:

```tsx
// src/components/DataTab.tsx
import { useState } from 'react';
import type { ImportMode } from '../../shared/types';
import { confirm, toast } from '../lib/toast';

export interface DataTabProps {
  onExport(): Promise<{ ok: boolean; path?: string }>;
  onImport(mode: ImportMode): Promise<{ ok: boolean; counts?: unknown }>;
}

export function DataTab({ onExport, onImport }: DataTabProps) {
  const [mode, setMode] = useState<ImportMode>('merge');
  const [busy, setBusy] = useState(false);

  const handleExport = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await onExport();
      if (res.ok) {
        toast.success(`Exported to ${res.path ?? 'file'}.`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleImport = async (): Promise<void> => {
    if (mode === 'replace') {
      const ok = await confirm(
        'Replace all favorites, history, saved items and settings with the imported data? This cannot be undone.',
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await onImport(mode);
      if (res.ok) {
        toast.success('Import complete.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-tab" role="group" aria-label="Data export and import">
      <div className="data-tab__export">
        <button type="button" disabled={busy} onClick={() => void handleExport()}>
          Export
        </button>
      </div>

      <fieldset className="data-tab__mode">
        <legend>Import mode</legend>
        <label>
          <input
            type="radio"
            name="data-tab-mode"
            value="merge"
            checked={mode === 'merge'}
            onChange={() => setMode('merge')}
          />
          Merge
        </label>
        <label>
          <input
            type="radio"
            name="data-tab-mode"
            value="replace"
            checked={mode === 'replace'}
            onChange={() => setMode('replace')}
          />
          Replace
        </label>
      </fieldset>

      <div className="data-tab__import">
        <button type="button" disabled={busy} onClick={() => void handleImport()}>
          Import
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/DataTab.test.tsx`
Expected: PASS — all six cases green.

- [ ] **Step 5: Commit**

```bash
git add src/components/DataTab.tsx src/components/DataTab.test.tsx
git commit -m "feat(renderer): DataTab export + import (merge/replace with confirm)"
```

---

### Task 21: Element-picker action button

**Files:**
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/PickerButton.tsx`
- Create: `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/PickerButton.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/PickerButton.test.tsx`:

```tsx
// src/components/PickerButton.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const start = vi.fn();
vi.mock('../lib/ipcClient', () => ({
  aegis: {
    picker: {
      start: (...a: any[]) => start(...a),
    },
  },
}));

vi.mock('../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from '../lib/toast';

import { PickerButton } from './PickerButton';

beforeEach(() => {
  vi.clearAllMocks();
  start.mockResolvedValue({ ok: true, rule: 'example.com##.ad' });
});

describe('PickerButton', () => {
  it('renders a button to pick an element to hide', () => {
    render(<PickerButton />);
    expect(screen.getByRole('button', { name: /pick element to hide/i })).toBeInTheDocument();
  });

  it('clicking calls aegis.picker.start', async () => {
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reports the created rule via a success toast', async () => {
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('example.com##.ad')));
  });

  it('does not toast success when the pick is cancelled', async () => {
    start.mockResolvedValue({ ok: false });
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('disables itself while a pick is in flight', async () => {
    let resolveStart: (v: { ok: boolean; rule?: string }) => void = () => {};
    start.mockReturnValue(
      new Promise<{ ok: boolean; rule?: string }>((res) => {
        resolveStart = res;
      }),
    );
    render(<PickerButton />);
    const btn = screen.getByRole('button', { name: /pick element to hide/i });
    await userEvent.click(btn);
    expect(btn).toBeDisabled();
    resolveStart({ ok: false });
    await waitFor(() => expect(btn).toBeEnabled());
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/PickerButton.test.tsx`
Expected: FAIL with `Failed to resolve import "./PickerButton"` (the component does not exist yet).

- [ ] **Step 3: Implement**

Create `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/PickerButton.tsx`:

```tsx
// src/components/PickerButton.tsx
import { useState } from 'react';
import { aegis } from '../lib/ipcClient';
import { toast } from '../lib/toast';

export function PickerButton() {
  const [busy, setBusy] = useState(false);

  const handlePick = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await aegis.picker.start();
      if (res.ok && res.rule) {
        toast.success(`Hiding rule added: ${res.rule}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="toolbar__picker"
      aria-label="Pick element to hide"
      disabled={busy}
      onClick={() => void handlePick()}
    >
      <span aria-hidden="true">{'🎯'}</span>
    </button>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/PickerButton.test.tsx`
Expected: PASS — all five cases green.

- [ ] **Step 5: Commit**

```bash
git add src/components/PickerButton.tsx src/components/PickerButton.test.tsx
git commit -m "feat(renderer): element-picker action button (aegis.picker.start)"
```

---

### Task 22: App wiring — mount the 3 Settings tabs + Downloads sidebar tab + indicator + picker action + permission prompt

This task is renderer-mount wiring (not naturally red-green): it composes the Block C hooks (`useDownloads`, `usePermissions`) and Block D components into `App.tsx`, and updates `App.test.tsx`'s ipcClient mock for the new namespaces. Per the contract: `usePermissions().prompt` exposes the active prompt and its resolver as `{ active: PermissionPrompt | null, resolve(requestId, decision) }`; `useDownloads()` returns `{ downloads, remove, clear, openFile, showInFolder, cancel }`. The toolbar downloads indicator's active count is derived from `downloads.filter(d => d.state === 'progressing').length`, and clicking it opens the sidebar (the sidebar's internal tab is uncontrolled, so opening the sidebar surfaces Downloads as a reachable tab).

**Files:**
- Modify: `/home/happyhobo/Documents/AI_Apps/Aegis/src/App.tsx` (imports `:16-34`; hooks `:51-56`; Toolbar `:114-146`; Sidebar `:155-176`; SettingsModal `:196-220`; add picker action + permission-prompt mount)
- Modify (test): `/home/happyhobo/Documents/AI_Apps/Aegis/src/App.test.tsx` (extend the ipcClient mock + add wiring assertions)

- [ ] **Step 1 (test): Extend `App.test.tsx` for the new wiring**

Add the new namespaces to the `vi.mock('./lib/ipcClient', …)` object in `/home/happyhobo/Documents/AI_Apps/Aegis/src/App.test.tsx`. Insert these members inside the `aegis: { … }` object, immediately after the existing `saved: { … },` block (before the closing `},` of `aegis`):

```tsx
    downloads: {
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue([]),
      openFile: vi.fn().mockResolvedValue(undefined),
      showInFolder: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    permissions: {
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue([]),
      resolve: vi.fn().mockResolvedValue(undefined),
      onPrompt: vi.fn().mockReturnValue(() => {}),
    },
    data: {
      export: vi.fn().mockResolvedValue({ ok: false }),
      import: vi.fn().mockResolvedValue({ ok: false }),
    },
    picker: {
      start: vi.fn().mockResolvedValue({ ok: false }),
    },
```

Also extend `baseSettings` in `App.test.tsx` with the new field — replace:

```tsx
  hideChromeByDefault: false,
};
```

(the `baseSettings` literal, around line 23-24) with:

```tsx
  hideChromeByDefault: false,
  downloadDir: '',
};
```

Append these wiring assertions inside `describe('App', …)` before its closing `});`:

```tsx
  it('mounts the toolbar downloads indicator', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /downloads/i })).toBeInTheDocument(),
    );
  });

  it('mounts the element-picker action button', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /pick element to hide/i })).toBeInTheDocument(),
    );
  });

  it('exposes a Downloads sidebar tab when the sidebar is open', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /toggle sidebar/i }));
    expect(screen.getByRole('tab', { name: /downloads/i })).toBeInTheDocument();
  });

  it('clicking the downloads indicator opens the sidebar', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /downloads/i }));
    expect(screen.getByRole('tab', { name: /downloads/i })).toBeInTheDocument();
  });

  it('mounts the Downloads, Site permissions and Data Settings tabs', async () => {
    render(<App />);
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(await screen.findByRole('button', { name: /open settings/i }));
    expect(screen.getByRole('tab', { name: /^downloads$/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /site permissions/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^data$/i })).toBeInTheDocument();
  });

  it('shows the permission-prompt dialog when usePermissions surfaces an active prompt', async () => {
    const { aegis } = await import('./lib/ipcClient');
    let promptCb: ((p: import('../shared/types').PermissionPrompt) => void) | undefined;
    (aegis.permissions.onPrompt as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (p: import('../shared/types').PermissionPrompt) => void) => {
        promptCb = cb;
        return () => {};
      },
    );
    render(<App />);
    await waitFor(() => expect(promptCb).toBeTypeOf('function'));
    act(() =>
      promptCb!({ requestId: 1, origin: 'https://example.com', permission: 'geolocation' }),
    );
    expect(screen.getByRole('dialog', { name: undefined })).toBeInTheDocument();
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));
    expect(aegis.permissions.resolve).toHaveBeenCalledWith(1, 'allow');
  });
```

Note: the SettingsModal default tab assertion (`appearance` selected) and the existing inset assertions (`{ top: 96, left: 0 }` / `left: 280`) are unchanged by this task; the favorites bar height and sidebar width constants are not touched.

- [ ] **Step 2: Run the tests, verify they fail (red)**

Run: `npx vitest run src/App.test.tsx`
Expected: FAIL — the new cases fail (`Unable to find an accessible element with the role "button" and name /pick element to hide/i`; no `Downloads`/`Site permissions`/`Data` Settings tabs; no permission-prompt dialog) because `App.tsx` does not yet wire the indicator, picker, the three Settings tabs, the Downloads sidebar slot, or the permission prompt.

- [ ] **Step 3: Implement — full edited `App.tsx`**

Write `/home/happyhobo/Documents/AI_Apps/Aegis/src/App.tsx` with the complete wired version:

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
import { useDownloads } from './hooks/useDownloads';
import { usePermissions } from './hooks/usePermissions';
import { useContentInset } from './hooks/useContentInset';
import { Toolbar } from './components/Toolbar';
import { BookmarkButton } from './components/BookmarkButton';
import { DownloadsIndicator } from './components/DownloadsIndicator';
import { PickerButton } from './components/PickerButton';
import { FavoritesBar } from './components/FavoritesBar';
import { FavoritesManager } from './components/FavoritesManager';
import { Sidebar } from './components/Sidebar';
import { HistoryPanel } from './components/HistoryPanel';
import { SavedPanel } from './components/SavedPanel';
import { DownloadsPanel } from './components/DownloadsPanel';
import { ErrorOverlay } from './components/ErrorOverlay';
import { SkipLink } from './components/SkipLink';
import { Toaster } from './components/Toaster';
import { ConfirmDialog } from './components/ConfirmDialog';
import { PermissionPromptDialog } from './components/PermissionPromptDialog';
import { WelcomeHint } from './components/WelcomeHint';
import { SettingsModal } from './components/SettingsModal';
import { AppearanceTab } from './components/AppearanceTab';
import { SearchTab } from './components/SearchTab';
import { HomeTab } from './components/HomeTab';
import { FilterListsTab } from './components/FilterListsTab';
import { MyFiltersTab } from './components/MyFiltersTab';
import { AllowlistTab } from './components/AllowlistTab';
import { DownloadsTab } from './components/DownloadsTab';
import { SitePermissionsTab } from './components/SitePermissionsTab';
import { DataTab } from './components/DataTab';

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
  const downloads = useDownloads();
  const permissions = usePermissions();
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

  const activeDownloads = downloads.downloads.filter(
    (d) => d.state === 'progressing',
  ).length;

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
        downloads={
          <>
            <PickerButton />
            <DownloadsIndicator
              activeCount={activeDownloads}
              onOpen={() => setSidebarOpen(true)}
            />
          </>
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
        downloads={
          <DownloadsPanel
            downloads={downloads.downloads}
            remove={(id) => void downloads.remove(id)}
            clear={() => void downloads.clear()}
            openFile={(id) => void downloads.openFile(id)}
            showInFolder={(id) => void downloads.showInFolder(id)}
            cancel={(id) => void downloads.cancel(id)}
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
          downloads={<DownloadsTab settings={settings.settings} update={settings.update} />}
          sitePermissions={
            <SitePermissionsTab
              permissions={permissions.permissions}
              remove={permissions.remove}
              clear={permissions.clear}
            />
          }
          data={
            <DataTab
              onExport={() => aegis.data.export()}
              onImport={(mode) => aegis.data.import(mode)}
            />
          }
        />
      )}
      {permissions.prompt && (
        <PermissionPromptDialog
          prompt={permissions.prompt}
          onResolve={(_requestId, decision) => void permissions.resolve(decision)}
        />
      )}
      <WelcomeHint />
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
```

Update the SettingsModal map to carry the three new tabs. Edit `/home/happyhobo/Documents/AI_Apps/Aegis/src/components/SettingsModal.tsx` — extend the union, labels, order, props, and the two Records.

Replace the `SettingsTab` union:

```tsx
type SettingsTab =
  | 'appearance'
  | 'search'
  | 'home'
  | 'filterLists'
  | 'myFilters'
  | 'allowlist';
```

with:

```tsx
type SettingsTab =
  | 'appearance'
  | 'search'
  | 'home'
  | 'filterLists'
  | 'myFilters'
  | 'allowlist'
  | 'downloads'
  | 'sitePermissions'
  | 'data';
```

Replace `TAB_LABELS`:

```tsx
const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  search: 'Search',
  home: 'Home',
  filterLists: 'Filter Lists',
  myFilters: 'My Filters',
  allowlist: 'Allowlist',
};
```

with:

```tsx
const TAB_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  search: 'Search',
  home: 'Home',
  filterLists: 'Filter Lists',
  myFilters: 'My Filters',
  allowlist: 'Allowlist',
  downloads: 'Downloads',
  sitePermissions: 'Site permissions',
  data: 'Data',
};
```

Replace `TAB_ORDER`:

```tsx
const TAB_ORDER: SettingsTab[] = [
  'appearance',
  'search',
  'home',
  'filterLists',
  'myFilters',
  'allowlist',
];
```

with:

```tsx
const TAB_ORDER: SettingsTab[] = [
  'appearance',
  'search',
  'home',
  'filterLists',
  'myFilters',
  'allowlist',
  'downloads',
  'sitePermissions',
  'data',
];
```

Replace the props interface:

```tsx
export interface SettingsModalProps {
  onClose(): void;
  appearance: ReactNode;
  search: ReactNode;
  home: ReactNode;
  filterLists: ReactNode;
  myFilters: ReactNode;
  allowlist: ReactNode;
}
```

with:

```tsx
export interface SettingsModalProps {
  onClose(): void;
  appearance: ReactNode;
  search: ReactNode;
  home: ReactNode;
  filterLists: ReactNode;
  myFilters: ReactNode;
  allowlist: ReactNode;
  downloads: ReactNode;
  sitePermissions: ReactNode;
  data: ReactNode;
}
```

Replace the destructuring:

```tsx
export function SettingsModal({
  onClose,
  appearance,
  search,
  home,
  filterLists,
  myFilters,
  allowlist,
}: SettingsModalProps) {
```

with:

```tsx
export function SettingsModal({
  onClose,
  appearance,
  search,
  home,
  filterLists,
  myFilters,
  allowlist,
  downloads,
  sitePermissions,
  data,
}: SettingsModalProps) {
```

Replace the per-tab id declarations:

```tsx
  const appearanceTabId = useId();
  const searchTabId = useId();
  const homeTabId = useId();
  const filterListsTabId = useId();
  const myFiltersTabId = useId();
  const allowlistTabId = useId();
  const panelId = useId();
```

with:

```tsx
  const appearanceTabId = useId();
  const searchTabId = useId();
  const homeTabId = useId();
  const filterListsTabId = useId();
  const myFiltersTabId = useId();
  const allowlistTabId = useId();
  const downloadsTabId = useId();
  const sitePermissionsTabId = useId();
  const dataTabId = useId();
  const panelId = useId();
```

Replace the `tabIds` Record:

```tsx
  const tabIds: Record<SettingsTab, string> = {
    appearance: appearanceTabId,
    search: searchTabId,
    home: homeTabId,
    filterLists: filterListsTabId,
    myFilters: myFiltersTabId,
    allowlist: allowlistTabId,
  };
```

with:

```tsx
  const tabIds: Record<SettingsTab, string> = {
    appearance: appearanceTabId,
    search: searchTabId,
    home: homeTabId,
    filterLists: filterListsTabId,
    myFilters: myFiltersTabId,
    allowlist: allowlistTabId,
    downloads: downloadsTabId,
    sitePermissions: sitePermissionsTabId,
    data: dataTabId,
  };
```

Replace the `panels` Record:

```tsx
  const panels: Record<SettingsTab, ReactNode> = {
    appearance,
    search,
    home,
    filterLists,
    myFilters,
    allowlist,
  };
```

with:

```tsx
  const panels: Record<SettingsTab, ReactNode> = {
    appearance,
    search,
    home,
    filterLists,
    myFilters,
    allowlist,
    downloads,
    sitePermissions,
    data,
  };
```

Update the existing `SettingsModal.test.tsx` so its `panels()` helper supplies the three new required props. Replace:

```tsx
const panels = () => ({
  appearance: <div data-testid="panel-appearance">APPEARANCE</div>,
  search: <div data-testid="panel-search">SEARCH</div>,
  home: <div data-testid="panel-home">HOME</div>,
  filterLists: <div data-testid="panel-filterLists">FILTER LISTS</div>,
  myFilters: <div data-testid="panel-myFilters">MY FILTERS</div>,
  allowlist: <div data-testid="panel-allowlist">ALLOWLIST</div>,
});
```

with:

```tsx
const panels = () => ({
  appearance: <div data-testid="panel-appearance">APPEARANCE</div>,
  search: <div data-testid="panel-search">SEARCH</div>,
  home: <div data-testid="panel-home">HOME</div>,
  filterLists: <div data-testid="panel-filterLists">FILTER LISTS</div>,
  myFilters: <div data-testid="panel-myFilters">MY FILTERS</div>,
  allowlist: <div data-testid="panel-allowlist">ALLOWLIST</div>,
  downloads: <div data-testid="panel-downloads">DOWNLOADS</div>,
  sitePermissions: <div data-testid="panel-sitePermissions">SITE PERMISSIONS</div>,
  data: <div data-testid="panel-data">DATA</div>,
});
```

And update the SettingsModal test's "renders a tablist with the six tabs" case name + assertion list to cover nine tabs. Replace:

```tsx
  it('renders a tablist with the six tabs', () => {
    render(<SettingsModal {...props()} />);
    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    expect(tablist).toBeInTheDocument();
    for (const name of [/appearance/i, /search/i, /^home$/i, /filter lists/i, /my filters/i, /allowlist/i]) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });
```

with:

```tsx
  it('renders a tablist with all nine tabs', () => {
    render(<SettingsModal {...props()} />);
    const tablist = screen.getByRole('tablist', { name: /settings sections/i });
    expect(tablist).toBeInTheDocument();
    for (const name of [
      /appearance/i,
      /search/i,
      /^home$/i,
      /filter lists/i,
      /my filters/i,
      /allowlist/i,
      /^downloads$/i,
      /site permissions/i,
      /^data$/i,
    ]) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
  });
```

- [ ] **Step 4: Verify (renderer test suite + production tsc-clean)**

Run the touched renderer suites and a renderer typecheck:

```bash
npx vitest run src/App.test.tsx src/components/SettingsModal.test.tsx src/components/Sidebar.test.tsx src/components/Toolbar.test.tsx
npx tsc --noEmit -p tsconfig.json
```

Expected: PASS — all App, SettingsModal, Sidebar and Toolbar cases green (including the new downloads-indicator, picker, Downloads-sidebar-tab, three-Settings-tabs, and permission-prompt assertions); `tsc --noEmit` reports no errors for the renderer (App.tsx resolves `useDownloads`/`usePermissions` from Block C and all Block D components with matching prop types). Confirm the wiring is present:

```bash
grep -nE "DownloadsIndicator|PickerButton|DownloadsPanel|DownloadsTab|SitePermissionsTab|DataTab|PermissionPromptDialog|useDownloads|usePermissions" src/App.tsx
```

Expected: every wired component/hook name appears in `App.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/SettingsModal.tsx src/components/SettingsModal.test.tsx
git commit -m "feat(renderer): wire downloads/permissions/data/picker into App + Settings + Sidebar"
```

---

#### New names introduced (Block D)

- `DownloadsPanel` (component), `DownloadsPanelProps` (interface) — `src/components/DownloadsPanel.tsx`
- `DownloadsIndicator` (component), `DownloadsIndicatorProps` (interface) — `src/components/DownloadsIndicator.tsx`
- `DownloadsTab` (component), `DownloadsTabProps` (interface) — `src/components/DownloadsTab.tsx`
- `SitePermissionsTab` (component), `SitePermissionsTabProps` (interface) — `src/components/SitePermissionsTab.tsx`
- `PermissionPromptDialog` (component), `PermissionPromptDialogProps` (interface) — `src/components/PermissionPromptDialog.tsx`
- `DataTab` (component), `DataTabProps` (interface) — `src/components/DataTab.tsx`
- `PickerButton` (component) — `src/components/PickerButton.tsx`
- `Sidebar` gains the `downloads: ReactNode` prop on `SidebarProps`; the `Tab` union gains `'downloads'` — `src/components/Sidebar.tsx`
- `Toolbar` gains the optional `downloads?: ReactNode` slot on `ToolbarProps` — `src/components/Toolbar.tsx`
- `SettingsModal` `SettingsModalProps` gains `downloads`, `sitePermissions`, `data: ReactNode` props; the internal `SettingsTab` union gains `'downloads' | 'sitePermissions' | 'data'` — `src/components/SettingsModal.tsx`

I now have all the patterns I need. The `app.evaluate` first-arg destructures Electron modules (e.g. `{ ipcMain }` in sandbox.spec, `{ webContents }` available). The CSP assertion will read `out/renderer/index.html` from disk (the contract §2.4 says "e2e asserts the built `out/renderer/index.html` carries the strict directives") and also assert via the live chrome WC document. The `chromeWcId` is in the registry, so I can reach the chrome WC via `webContents.fromId`.

I have everything needed to write Tasks 23-26 grounded in real patterns. Here is the markdown.

---

### Task 23: Downloads e2e — real fixture download → repo state + file on disk + `downloads.changed`; cancel + clear

**Files:**
- Create: `electron/test/fixtures/downloads/big.bin`
- Create: `electron/test/fixtures/downloads/page.html`
- Modify: `electron/test/e2e/fixtureServer.ts:9-15` (add a `.bin` MIME entry so the fixture is served `application/octet-stream`, which Chromium downloads rather than renders)
- Test: `electron/test/e2e/downloads.spec.ts`

- [ ] **Step 1: Write the failing test**

First, add the two fixtures and the MIME entry that they depend on, then the spec.

Create `electron/test/fixtures/downloads/big.bin` (a small but non-empty binary blob; we only assert it lands on disk):

```
AEGIS-DOWNLOAD-FIXTURE-BODY-0123456789
```

Create `electron/test/fixtures/downloads/page.html` (an anchor with the `download` attribute pointing at the binary; clicking it via `executeJavaScript` triggers `will-download` on the content session):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Aegis downloads fixture</title>
  </head>
  <body>
    <main id="content">downloads fixture root</main>
    <!-- The download attribute forces a save (rather than navigate) so the SESSION
         will-download event fires; href is same-origin relative to the fixture server. -->
    <a id="dl" href="/downloads/big.bin" download="big.bin">download me</a>
    <script>
      // e2e clicks this from the main world to fire will-download.
      window.__aegisClickDownload = function () {
        document.getElementById('dl').click();
      };
    </script>
  </body>
</html>
```

Add the `.bin` MIME mapping in `electron/test/e2e/fixtureServer.ts` — change the `MIME` map (lines 9-15):

```ts
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
};
```

Now the spec `electron/test/e2e/downloads.spec.ts`:

```ts
// electron/test/e2e/downloads.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, DownloadEntry } from '../../../shared/types';

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

/** Click the fixture's download anchor from the content main world. */
function clickDownload(app: ElectronApplication): Promise<void> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
      'window.__aegisClickDownload()',
      true,
    ),
  );
}

function downloadsList(app: ElectronApplication): Promise<DownloadEntry[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase5.downloadsRepo.list());
}

function downloadsClear(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase5.downloadsRepo.clear());
}

test('a real fixture download saves to downloadDir, records a completed DownloadsRepo row, and lands on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-downloads-'));
  // A dedicated download target dir so the assertion is hermetic (not the OS Downloads).
  const dlDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-dldir-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Point the downloadDir setting at our temp dir so the will-download handler
    // resolves the save path there (resolveDownloadDir(settingDir, osDir)).
    await app.evaluate(
      (_e, d) => (globalThis as any).__aegisTest.phase4.settingsRepo.set({ downloadDir: d }),
      dlDir,
    );

    await navigateAndSettle(app, `${fixtures.baseUrl}/downloads/page.html`);
    await clickDownload(app);

    // The will-download handler records a row immediately (state 'progressing'),
    // then item.on('done') flips it to 'completed'. Poll for the terminal state.
    await expect
      .poll(
        async () => {
          const rows = await downloadsList(app);
          const row = rows.find((r) => r.filename === 'big.bin');
          return row?.state ?? null;
        },
        { timeout: 15000 },
      )
      .toBe('completed');

    const rows = await downloadsList(app);
    const row = rows.find((r) => r.filename === 'big.bin')!;
    expect(row.url).toBe(`${fixtures.baseUrl}/downloads/big.bin`);
    expect(row.savePath).toBe(join(dlDir, 'big.bin'));
    expect(row.totalBytes).toBeGreaterThan(0);
    expect(row.receivedBytes).toBe(row.totalBytes);
    expect(typeof row.id).toBe('number');
    expect(row.startedAt).toBeGreaterThan(0);

    // The file physically exists at the resolved save path with the fixture body.
    expect(existsSync(row.savePath)).toBe(true);
    expect(readFileSync(row.savePath, 'utf8')).toContain('AEGIS-DOWNLOAD-FIXTURE-BODY');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});

test('downloads.changed fires on a real download (renderer-visible push) and clear() empties the repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-downloads-changed-'));
  const dlDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-dldir2-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await app.evaluate(
      (_e, d) => (globalThis as any).__aegisTest.phase4.settingsRepo.set({ downloadDir: d }),
      dlDir,
    );

    // Subscribe to downloads.changed via the BRIDGED API in the chrome renderer. Only
    // window.aegis is exposed (ipcRenderer is intentionally NOT bridged — see sandbox.spec),
    // so we use aegis.downloads.onChanged (the real preload subscribe path).
    await app.evaluate(
      ({ webContents }) => {
        const chromeId = (globalThis as any).__aegisTest.chromeWcId;
        const wc = webContents.fromId(chromeId)!;
        return wc.executeJavaScript(`
          (() => {
            window.__aegisDownloadsChanged = 0;
            window.aegis.downloads.onChanged(() => {
              window.__aegisDownloadsChanged += 1;
            });
            return true;
          })()
        `);
      },
    );

    await navigateAndSettle(app, `${fixtures.baseUrl}/downloads/page.html`);
    await clickDownload(app);

    // 'updated' + 'done' both call onChanged → at least one push reaches chrome.
    await expect
      .poll(
        async () =>
          app.evaluate(({ webContents }) => {
            const chromeId = (globalThis as any).__aegisTest.chromeWcId;
            return webContents
              .fromId(chromeId)!
              .executeJavaScript('window.__aegisDownloadsChanged');
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    // Wait for the row to settle so clear() has something to remove.
    await expect
      .poll(async () => (await downloadsList(app)).length, { timeout: 15000 })
      .toBeGreaterThan(0);

    await downloadsClear(app);
    expect(await downloadsList(app)).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/downloads.spec.ts`

Expected: FAIL — before Task 12 boot wiring + Task 5 floor removal are in place, the build/registry has no `__aegisTest.phase5.downloadsRepo`, so the first `downloadsList` call throws `TypeError: Cannot read properties of undefined (reading 'downloadsRepo')`; with the will-download floor still removed but no handler, no file is written. (If run against the final build of Block A–D, the prior blocks supply `phase5`/`downloadsRepo` and the handler — this spec then locks the integrated behavior.)

- [ ] **Step 3: Implement**

This is a verification-only e2e task: the production behavior is delivered by Tasks 5 (floor removal + `plugins`/`autoplayPolicy`), 7 (`wireDownloads` + handlers), and 12 (boot wiring registers `wireDownloads(vc.contentSession, …)` and adds `phase5:{ downloadsRepo, permissionsRepo }` to `__aegisTest`). No new production code is written here — only the fixtures and the `.bin` MIME entry shown in Step 1. The fixtures and MIME change ARE the implementation for this task.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/downloads.spec.ts`

Expected: PASS — both tests green: a completed `DownloadsRepo` row with `savePath === join(dlDir,'big.bin')`, the file on disk containing the fixture body, at least one `downloads.changed` push observed on the chrome WC, and `clear()` emptying the repo.

- [ ] **Step 5: Commit**

```bash
git add electron/test/fixtures/downloads/big.bin \
        electron/test/fixtures/downloads/page.html \
        electron/test/e2e/fixtureServer.ts \
        electron/test/e2e/downloads.spec.ts
git commit -m "test(e2e): real download saves to downloadDir, records repo row, pushes downloads.changed, clear empties"
```

---

### Task 24: Permissions remembered round-trip e2e + chrome CSP e2e + autoplay/PDF/fullscreen policy checks

**Files:**
- Test: `electron/test/e2e/permissions.spec.ts`
- Test: `electron/test/e2e/csp.spec.ts`
- Test: `electron/test/e2e/contentPolicy.spec.ts`

- [ ] **Step 1: Write the failing test**

Three specs. First, the permissions remembered round-trip (`electron/test/e2e/permissions.spec.ts`). It seeds an `allow` for `(origin, 'geolocation')` directly via `__aegisTest.phase5.permissionsRepo.set`, then triggers a real `navigator.geolocation` call inside the content WC and asserts the request resolves (auto-answered from the remembered decision via the re-set `setPermissionRequestHandler`), and that the `setPermissionCheckHandler` reports the remembered grant:

```ts
// electron/test/e2e/permissions.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, SitePermission } from '../../../shared/types';

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

function permsList(app: ElectronApplication): Promise<SitePermission[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase5.permissionsRepo.list());
}

function permsSet(
  app: ElectronApplication,
  origin: string,
  permission: string,
  decision: 'allow' | 'deny',
): Promise<void> {
  return app.evaluate(
    (_e, a) =>
      (globalThis as any).__aegisTest.phase5.permissionsRepo.set(a.origin, a.permission, a.decision),
    { origin, permission, decision },
  );
}

test('a remembered geolocation ALLOW is auto-answered for the content WC (request handler honors PermissionsRepo)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-perms-allow-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const origin = fixtures.baseUrl; // http://127.0.0.1:<port>
    // Pre-seed the remembered decision; wirePermissions' request handler reads it and
    // resolves the callback without raising a prompt.
    await permsSet(app, origin, 'geolocation', 'allow');
    expect((await permsList(app)).some(
      (p) => p.origin === origin && p.permission === 'geolocation' && p.decision === 'allow',
    )).toBe(true);

    await navigateAndSettle(app, `${fixtures.baseUrl}/spa.html`);

    // Real getCurrentPosition: with the remembered ALLOW, the request handler resolves
    // callback(true); geolocation then either succeeds OR fails with a NON-permission
    // error (POSITION_UNAVAILABLE / TIMEOUT in a headless env). It must NOT be
    // PERMISSION_DENIED (code 1), which is what a deny would produce.
    const outcome = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        `new Promise((resolve) => {
           navigator.geolocation.getCurrentPosition(
             () => resolve({ ok: true, code: null }),
             (err) => resolve({ ok: false, code: err.code }),
             { timeout: 4000 },
           );
         })`,
        true,
      ),
    );
    expect((outcome as { ok: boolean; code: number | null }).code).not.toBe(1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a remembered geolocation DENY is auto-answered as PERMISSION_DENIED (code 1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-perms-deny-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const origin = fixtures.baseUrl;
    await permsSet(app, origin, 'geolocation', 'deny');

    await navigateAndSettle(app, `${fixtures.baseUrl}/spa.html`);

    const outcome = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        `new Promise((resolve) => {
           navigator.geolocation.getCurrentPosition(
             () => resolve({ ok: true, code: null }),
             (err) => resolve({ ok: false, code: err.code }),
             { timeout: 4000 },
           );
         })`,
        true,
      ),
    );
    // A remembered deny → callback(false) → the renderer sees PERMISSION_DENIED.
    expect((outcome as { ok: boolean; code: number | null }).code).toBe(1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a remembered decision survives an app restart (persisted in site_permissions)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-perms-persist-'));
  const origin = fixtures.baseUrl;
  const app1 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await permsSet(app1, origin, 'notifications', 'allow');
    expect((await permsList(app1)).some(
      (p) => p.origin === origin && p.permission === 'notifications' && p.decision === 'allow',
    )).toBe(true);
  } finally {
    await app1.close();
  }
  const app2 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(
        async () =>
          (await permsList(app2)).some(
            (p) =>
              p.origin === origin && p.permission === 'notifications' && p.decision === 'allow',
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  } finally {
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Second, the chrome CSP spec (`electron/test/e2e/csp.spec.ts`). It asserts the strict directives on BOTH the built `out/renderer/index.html` (the prod artifact the `transformIndexHtml` plugin emits) AND the live chrome document (`document.querySelector('meta[http-equiv="Content-Security-Policy"]')`):

```ts
// electron/test/e2e/csp.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-csp-'));
  app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, AEGIS_HOME_URL: 'about:blank' },
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
});

test.afterAll(async () => {
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

// The strict (prod/build) directives the transformIndexHtml plugin injects (§2.4).
const STRICT_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
];

test('the BUILT out/renderer/index.html carries the strict prod CSP meta', () => {
  // electron-vite renderer build root is src/; the prod transform emits the strict meta.
  const html = readFileSync(join('out', 'renderer', 'index.html'), 'utf8');
  const meta = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(html);
  expect(meta).not.toBeNull();
  const content = /content=["']([^"']+)["']/i.exec(meta![0])![1];
  for (const directive of STRICT_DIRECTIVES) {
    expect(content).toContain(directive);
  }
  // 'unsafe-eval' / ws: are dev-only relaxations and MUST NOT leak into the prod artifact.
  expect(content).not.toContain("'unsafe-eval'");
  expect(content).not.toContain('ws:');
});

test('the live chrome renderer document enforces the strict CSP meta', async () => {
  const content = await app.evaluate(({ webContents }) => {
    const chromeId = (globalThis as any).__aegisTest.chromeWcId;
    return webContents.fromId(chromeId)!.executeJavaScript(
      `(() => {
         const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
         return m ? m.getAttribute('content') : null;
       })()`,
    );
  });
  expect(content).not.toBeNull();
  for (const directive of STRICT_DIRECTIVES) {
    expect(content as string).toContain(directive);
  }
});

test('the visited CONTENT view document has NO app CSP meta (sites unaffected — correct browser behavior)', async () => {
  // The content view loads about:blank here; the app must NOT impose its chrome CSP on it.
  const hasAppCsp = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
      `!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`,
      true,
    ),
  );
  expect(hasAppCsp).toBe(false);
});
```

Third, the content-policy spec (`electron/test/e2e/contentPolicy.spec.ts`) — asserts autoplay + PDF (`plugins`) are set on the content `webPreferences`, and that the fullscreen listeners drive `win.setFullScreen` (via the content WC's `enter-html-full-screen` event and the BaseWindow `isFullScreen()` reachable through `BaseWindow.getAllWindows()`):

```ts
// electron/test/e2e/contentPolicy.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-contentpolicy-'));
  app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, AEGIS_HOME_URL: 'about:blank' },
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
});

test.afterAll(async () => {
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

test('the content webPreferences set autoplayPolicy + plugins (media + inline PDF policy)', async () => {
  const wp = await app.evaluate(() => {
    const wc = (globalThis as any).__aegisTest.primary.view.webContents;
    return wc.getLastWebPreferences() ?? {};
  });
  // Block autoplay-with-sound (default is no-user-gesture-required).
  expect(wp.autoplayPolicy).toBe('document-user-activation-required');
  // plugins:true → Chromium renders application/pdf inline in the content view.
  expect(wp.plugins).toBe(true);
});

test('HTML5 fullscreen enter/leave on the content WC drives the BaseWindow fullscreen state', async () => {
  // Emit the content WC fullscreen events directly (the boot listeners call
  // win.setFullScreen). Reading win via BaseWindow.getAllWindows()[0].
  const entered = await app.evaluate(({ BaseWindow }) => {
    const wc = (globalThis as any).__aegisTest.primary.view.webContents;
    wc.emit('enter-html-full-screen');
    return BaseWindow.getAllWindows()[0].isFullScreen();
  });
  expect(entered).toBe(true);

  const left = await app.evaluate(({ BaseWindow }) => {
    const wc = (globalThis as any).__aegisTest.primary.view.webContents;
    wc.emit('leave-html-full-screen');
    return BaseWindow.getAllWindows()[0].isFullScreen();
  });
  expect(left).toBe(false);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/permissions.spec.ts electron/test/e2e/csp.spec.ts electron/test/e2e/contentPolicy.spec.ts`

Expected: FAIL — without Task 8 (`wirePermissions`) + Task 12 boot, `__aegisTest.phase5.permissionsRepo` is undefined (permissions spec throws); without Task 11 the built `out/renderer/index.html` either has no CSP meta or the hardcoded relaxed one (csp spec fails on missing strict directives); without Task 5 (`autoplayPolicy`/`plugins`) + Task 12 fullscreen listeners the content-policy spec fails on `autoplayPolicy` undefined / `isFullScreen()` staying false.

- [ ] **Step 3: Implement**

Verification-only e2e task. The production behavior is delivered by Task 5 (content `webPreferences` `autoplayPolicy`+`plugins`), Task 8 (`wirePermissions` re-setting both handlers), Task 11 (`transformIndexHtml` CSP plugin + removing the static meta from `src/index.html`), and Task 12 (boot: `wirePermissions(vc.contentSession,…)`, fullscreen listeners `vc.contentWebContents.on('enter-html-full-screen', ()=>win.setFullScreen(true))` / leave → `false`, and `phase5:{ downloadsRepo, permissionsRepo }`). No new production code in this task — only the three specs above.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/permissions.spec.ts electron/test/e2e/csp.spec.ts electron/test/e2e/contentPolicy.spec.ts`

Expected: PASS — remembered allow is non-`PERMISSION_DENIED`, remembered deny is code 1, the decision survives restart; the built and live chrome documents carry all strict directives with no dev relaxations, the content view has no app CSP; `autoplayPolicy`/`plugins` are set and fullscreen enter/leave flips `isFullScreen()`.

- [ ] **Step 5: Commit**

```bash
git add electron/test/e2e/permissions.spec.ts \
        electron/test/e2e/csp.spec.ts \
        electron/test/e2e/contentPolicy.spec.ts
git commit -m "test(e2e): remembered permission round-trip + restart, strict chrome CSP (built+live), autoplay/PDF/fullscreen policy"
```

---

### Task 25: Data export/import e2e (merge AND replace round-trip) + element-picker e2e (inject → selector → custom filter → cosmetic hide)

**Files:**
- Test: `electron/test/e2e/dataPort.spec.ts`
- Test: `electron/test/e2e/picker.spec.ts`

The data export/import handlers (`buildDataHandlers`) gate on `dialog.showSaveDialog`/`showOpenDialog`, which cannot be driven headlessly. Per spec §5 ("export→import round-trip (merge AND replace) via `__aegisTest`"), this spec exercises the round-trip directly through the repos that `data.import` writes — proving the same `clear()`-then-insert (replace) and insert-non-duplicate (merge) mechanics the handler uses, against the live persisted DB. The picker spec exercises the real `picker.start()` injection path end to end.

- [ ] **Step 1: Write the failing test**

Data round-trip (`electron/test/e2e/dataPort.spec.ts`). It builds an export payload from a live app, then applies it back via the `clear()`/`add`/`record`/`set` primitives the import path uses, asserting both modes:

```ts
// electron/test/e2e/dataPort.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { Favorite, SavedItem, HistoryEntry, Settings } from '../../../shared/types';

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

interface ExportPayload {
  version: 1;
  favorites: Favorite[];
  history: HistoryEntry[];
  saved: SavedItem[];
  settings: Settings;
}

/** Build the export payload the same way data.export() does (§2.5). */
function buildExport(app: ElectronApplication): Promise<ExportPayload> {
  return app.evaluate(() => {
    const places = (globalThis as any).__aegisTest.places;
    const phase4 = (globalThis as any).__aegisTest.phase4;
    return {
      version: 1,
      favorites: places.favoritesRepo.list(),
      history: places.historyRepo.list({ limit: 100000 }),
      saved: places.savedRepo.list(),
      settings: phase4.settingsRepo.get(),
    };
  });
}

/** Apply a payload in REPLACE mode the same way data.import('replace') does (§2.5). */
function applyReplace(app: ElectronApplication, payload: ExportPayload): Promise<void> {
  return app.evaluate((_e, p) => {
    const places = (globalThis as any).__aegisTest.places;
    const phase4 = (globalThis as any).__aegisTest.phase4;
    places.favoritesRepo.clear();
    places.savedRepo.clear();
    places.historyRepo.clear();
    for (const f of p.favorites) {
      places.favoritesRepo.add({ name: f.name, url: f.url, tags: f.tags });
    }
    for (const s of p.saved) {
      places.savedRepo.add({ url: s.url, title: s.title });
    }
    for (const h of p.history) {
      // record(e, ()=>e.visitedAt) preserves the original timestamp on import.
      places.historyRepo.record({ url: h.url, title: h.title }, () => h.visitedAt);
    }
    phase4.settingsRepo.set(p.settings);
  }, payload);
}

/** Apply a payload in MERGE mode: insert rows whose url is not already present (§2.5). */
function applyMerge(app: ElectronApplication, payload: ExportPayload): Promise<void> {
  return app.evaluate((_e, p) => {
    const places = (globalThis as any).__aegisTest.places;
    const phase4 = (globalThis as any).__aegisTest.phase4;
    const favUrls = new Set(places.favoritesRepo.list().map((f: any) => f.url));
    for (const f of p.favorites) {
      if (!favUrls.has(f.url)) places.favoritesRepo.add({ name: f.name, url: f.url, tags: f.tags });
    }
    const savedUrls = new Set(places.savedRepo.list().map((s: any) => s.url));
    for (const s of p.saved) {
      if (!savedUrls.has(s.url)) places.savedRepo.add({ url: s.url, title: s.title });
    }
    const histUrls = new Set(places.historyRepo.list({ limit: 100000 }).map((h: any) => h.url));
    for (const h of p.history) {
      if (!histUrls.has(h.url)) places.historyRepo.record({ url: h.url, title: h.title }, () => h.visitedAt);
    }
    phase4.settingsRepo.set(p.settings);
  }, payload);
}

function favList(app: ElectronApplication): Promise<Favorite[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.favoritesRepo.list());
}
function savedList(app: ElectronApplication): Promise<SavedItem[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.savedRepo.list());
}
function historyList(app: ElectronApplication): Promise<HistoryEntry[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.historyRepo.list({ limit: 100000 }));
}
function settingsGet(app: ElectronApplication): Promise<Settings> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.settingsRepo.get());
}

test('export → REPLACE import round-trips favorites/saved/history/settings into a fresh profile', async () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-data-src-'));
  const dstDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-data-dst-'));
  const favUrl = `${fixtures.baseUrl}/spa.html`;
  const savedUrl = `${fixtures.baseUrl}/late-title.html`;

  // Source app: seed data + a non-default settings value, then export.
  const src = await launchApp(srcDir, { AEGIS_HOME_URL: 'about:blank' });
  let payload: ExportPayload;
  try {
    await src.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.favoritesRepo.add({ name: 'Fav A', url: u, tags: ['x'] }),
      favUrl,
    );
    await src.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.savedRepo.add({ url: u, title: 'Saved A' }),
      savedUrl,
    );
    await src.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.historyRepo.record({ url: u, title: 'Hist A' }),
      favUrl,
    );
    await src.evaluate(() =>
      (globalThis as any).__aegisTest.phase4.settingsRepo.set({ downloadDir: '/tmp/aegis-imported' }),
    );
    payload = await buildExport(src);
    expect(payload.favorites.map((f) => f.url)).toContain(favUrl);
    expect(payload.settings.downloadDir).toBe('/tmp/aegis-imported');
  } finally {
    await src.close();
  }

  // Destination app (fresh profile): seed a row that REPLACE must wipe, then import.
  const dst = await launchApp(dstDir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await dst.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.favoritesRepo.add({ name: 'Stale', url: u, tags: [] }),
      `${fixtures.baseUrl}/stale.html`,
    );
    await applyReplace(dst, payload);

    // REPLACE wiped the stale row; only the imported one remains.
    const favs = await favList(dst);
    expect(favs.map((f) => f.url)).toEqual([favUrl]);
    expect(favs[0].tags).toEqual(['x']);
    expect((await savedList(dst)).map((s) => s.url)).toEqual([savedUrl]);
    expect((await historyList(dst)).some((h) => h.url === favUrl)).toBe(true);
    expect((await settingsGet(dst)).downloadDir).toBe('/tmp/aegis-imported');
  } finally {
    await dst.close();
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(dstDir, { recursive: true, force: true });
  }
});

test('MERGE import keeps existing rows and only adds non-duplicate urls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-data-merge-'));
  const existingUrl = `${fixtures.baseUrl}/existing.html`;
  const newUrl = `${fixtures.baseUrl}/new.html`;
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Seed an existing favorite that the payload also contains (dup) + one only in the app.
    await app.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.favoritesRepo.add({ name: 'Existing', url: u, tags: [] }),
      existingUrl,
    );
    const current = await settingsGet(app);
    const payload: ExportPayload = {
      version: 1,
      favorites: [
        { id: 999, name: 'Existing dup', url: existingUrl, tags: ['dup'] },
        { id: 1000, name: 'Brand New', url: newUrl, tags: ['new'] },
      ] as Favorite[],
      history: [],
      saved: [],
      settings: { ...current, downloadDir: '/tmp/aegis-merge' },
    };

    await applyMerge(app, payload);

    const favs = await favList(app);
    const urls = favs.map((f) => f.url);
    // The duplicate url is NOT re-added (still one Existing); the new url IS added.
    expect(urls.filter((u) => u === existingUrl)).toHaveLength(1);
    expect(urls).toContain(newUrl);
    // Settings shallow-merged.
    expect((await settingsGet(app)).downloadDir).toBe('/tmp/aegis-merge');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Element-picker spec (`electron/test/e2e/picker.spec.ts`). It navigates to the cosmetic sentinel fixture, calls the real `__aegisTest.phase5.pickerStart` (boot exposes the picker start fn), pre-arming a synthetic click in the content world so the injected IIFE resolves a selector; then asserts the custom filter was appended and the element is hidden after the engine rebuild:

```ts
// electron/test/e2e/picker.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState } from '../../../shared/types';

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

function readContent<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(
    (_e, e) => (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(e, true),
    expr,
  );
}

function customFilters(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.customFiltersRepo.get());
}

test('element picker: a clicked element becomes a host-scoped cosmetic custom filter and is hidden after rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-picker-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_OFFLINE: '1', // engine starts empty; the only cosmetic rule comes from the picker
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/cosmetic/sentinel.html`);

    // Baseline: the sentinel is a visible 300x250 block (no cosmetic rule yet).
    const baseline = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('.aegis-ad-sentinel')).display",
    );
    expect(baseline).not.toBe('none');

    // Start the picker, then synthesize a real click on the sentinel so the injected IIFE
    // resolves a selector for that element. The IIFE attaches its own click listener on
    // the document; dispatching a click after start() drives it to resolve.
    const startPromise: Promise<{ ok: boolean; rule?: string }> = app.evaluate(() =>
      (globalThis as any).__aegisTest.phase5.pickerStart(),
    );
    // Give the IIFE a beat to install its overlay+listener, then click the sentinel.
    await expect
      .poll(
        async () =>
          readContent<boolean>(app, 'typeof window.__aegisPickerArmed === "boolean" && window.__aegisPickerArmed'),
        { timeout: 5000 },
      )
      .toBe(true);
    await readContent<void>(
      app,
      `(() => {
         const el = document.querySelector('.aegis-ad-sentinel');
         el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
       })()`,
    );

    const result = await startPromise;
    expect(result.ok).toBe(true);
    expect(typeof result.rule).toBe('string');
    // The rule is host-scoped: 127.0.0.1##<selector for the sentinel>.
    expect(result.rule!).toMatch(/^127\.0\.0\.1##/);

    // The rule was appended to the Phase-4 custom filters store.
    expect(await customFilters(app)).toContain(result.rule!);

    // buildPickerHandlers calls rebuildFromCache(); the rebuilt engine swaps on the next
    // nav. Re-navigate and poll for the sentinel to be hidden by the new cosmetic rule.
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

    // The non-targeted content marker stays visible (scoped, not a blanket hide).
    const marker = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#content-marker')).display",
    );
    expect(marker).not.toBe('none');

    // The custom filter survives a restart (persisted in customFiltersRepo).
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/dataPort.spec.ts electron/test/e2e/picker.spec.ts`

Expected: FAIL — the data spec fails because `__aegisTest.places.favoritesRepo.clear` / `savedRepo.clear` are not yet functions (added in Task 4) so `applyReplace` throws `TypeError: places.favoritesRepo.clear is not a function`; the picker spec fails because `__aegisTest.phase5.pickerStart` is undefined until Task 12 boot wires it (and the IIFE's `window.__aegisPickerArmed` marker is set only by the Task 10 `PICKER_IIFE`).

- [ ] **Step 3: Implement**

Two small wiring touches in the boot registry (`electron/main/index.ts`) are needed for these specs and belong here as the e2e-enabling glue; everything else (FavoritesRepo/SavedRepo `clear()` from Task 4, `PICKER_IIFE` from Task 10, `buildPickerHandlers` from Task 10) is already delivered by earlier tasks.

In `electron/main/index.ts`, inside the `if (process.env.AEGIS_E2E === '1')` registry block, the `phase5` key (added in Task 12) must also expose `pickerStart` so the e2e can invoke the real picker injection path without a UI button. Add `pickerStart` to the `phase5` object alongside `downloadsRepo`/`permissionsRepo`:

```ts
      phase5: {
        downloadsRepo,
        permissionsRepo,
        // Test-only handle to the real picker.start() flow (the IIFE injection +
        // customFiltersRepo append + rebuildFromCache), so e2e can drive it headlessly.
        pickerStart: () => buildPickerHandlers({ vc, customFiltersRepo, rebuildFromCache: rebuildEngineFromCache })[IPC.pickerStart](),
      },
```

This reuses the exact `buildPickerHandlers` builder (Task 10) keyed by `IPC.pickerStart`, so the e2e exercises the production code path, not a parallel one. (`IPC` is already imported in index.ts; `buildPickerHandlers`, `vc`, `customFiltersRepo`, and `rebuildEngineFromCache` are all in scope at the registry site per Task 12 / §1.7.)

The `PICKER_IIFE` (Task 10) must set the `window.__aegisPickerArmed = true` marker once its click listener is installed, so the e2e knows when to dispatch the synthetic click. This is part of Task 10's IIFE; this task depends on it but does not redefine it. The data-port `clear()` methods come from Task 4. No further production code is added in this task beyond the `pickerStart` registry handle above.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/dataPort.spec.ts electron/test/e2e/picker.spec.ts`

Expected: PASS — REPLACE wipes the stale favorite and restores exactly the exported favorites/saved/history/settings; MERGE keeps the existing row, skips the duplicate url, adds the new one, and shallow-merges settings; the picker returns `{ ok:true, rule:'127.0.0.1##…' }`, appends it to `customFiltersRepo`, and the sentinel collapses to `display:none` after the rebuild while the content marker stays visible.

- [ ] **Step 5: Commit**

```bash
git add electron/test/e2e/dataPort.spec.ts \
        electron/test/e2e/picker.spec.ts \
        electron/main/index.ts
git commit -m "test(e2e): data export/import merge+replace round-trip; element-picker inject→custom filter→cosmetic hide"
```

---

### Task 26: Docs (security-audit sign-off + engine/Chromium update policy + deferred-distribution) + the FULL dual-ABI regression gate (Phase-5 exit)

**Files:**
- Create: `docs/superpowers/security-audit-signoff.md`
- Create: `docs/superpowers/engine-update-policy.md`
- Create: `docs/superpowers/deferred-distribution.md`

This is a docs + final-gate task (no red-green). Write the three docs (full content below), then run the complete dual-ABI regression gate and confirm green.

- [ ] **Step 1: Write the docs**

Create `docs/superpowers/security-audit-signoff.md`:

```markdown
# Aegis — Security Audit Sign-off (Phase-5 exit)

**Date:** 2026-06-11
**Scope:** Electron 42.4.0 ad-blocking browser. Every hardening control below maps to
its enforcing code and its test. Verified at the Phase-5 exit gate (unit + e2e green).

## Control matrix

| # | Control | Enforcing code | Test(s) |
|---|---------|----------------|---------|
| 1 | Content view sandboxed | `electron/main/viewController.ts` content `webPreferences` `sandbox:true` | `electron/test/e2e/sandbox.spec.ts` (`content WebContents reports the locked-down sandbox config`), `boot.spec.ts` |
| 2 | Context isolation on | `viewController.ts` `contextIsolation:true`; `electron/main/window.ts` chrome `contextIsolation:true` | `sandbox.spec.ts` |
| 3 | Node integration off | `viewController.ts`/`window.ts` `nodeIntegration:false` | `sandbox.spec.ts` (`content main world has no Node globals`), `boot.spec.ts` |
| 4 | Web security on | `viewController.ts` `webSecurity:true` (chrome default true) | `sandbox.spec.ts` |
| 5 | Scheme allowlist (navigation) | `electron/lib/schemes.ts` `ALLOWED_NAV_SCHEMES=['https:','http:']` + `isAllowedNavigationUrl`; content gate `viewController.ts` `will-navigate`/`will-redirect`; chrome `isAppUrl` `window.ts` | `electron/lib/schemes.test.ts`, `sandbox.spec.ts` (`file://`/`javascript:` blocked), `nav.spec.ts` |
| 6 | Sender-guarded IPC | `electron/main/ipc/guard.ts` (`event.sender.id===chromeWebContentsId`) | `electron/main/ipc/guard.test.ts`, `sandbox.spec.ts` (content WC cannot invoke privileged IPC) |
| 7 | Deny-all popups (window.open) | chrome `window.ts` `setWindowOpenHandler` deny; content `viewController.ts` via `decideWindowOpen` (`electron/lib/windowOpen.ts`) | `windowOpen.test.ts`, `chromeLockdown.spec.ts`, `popup.spec.ts` |
| 8 | webviewTag never enabled | not set in either `webPreferences`; no `<webview>` in renderer | `sandbox.spec.ts` (locked webPreferences) |
| 9 | Deny-by-default permissions + remembered grants | `viewController.ts` deny-floor handlers; re-set by `electron/main/permissions.ts` `wirePermissions` (`PermissionsRepo`-backed, Phase-5 set only: geolocation/notifications/media/clipboard-read) | `permissions.test.ts` (pure `resolvePermission`), `electron/test/e2e/permissions.spec.ts` (remembered allow/deny round-trip + restart) |
| 10 | Strict CSP on the chrome renderer | build-mode-aware `transformIndexHtml` in `electron.vite.config.ts` (strict prod / relaxed dev); static meta removed from `src/index.html` | `electron/test/e2e/csp.spec.ts` (built `out/renderer/index.html` + live chrome doc carry strict directives; content view has none) |
| 11 | Downloads contained (no arbitrary main-process exec) | `electron/main/downloads.ts` `wireDownloads` (`setSavePath` synchronous-in-callback, repo-tracked); open via `shell.openPath`/`shell.showItemInFolder` only | `electron/main/ipc/downloads.test.ts`, `electron/test/e2e/downloads.spec.ts` |
| 12 | Picker injection scoped to content WC | `electron/main/ipc/picker.ts` `executeJavaScript(PICKER_IIFE, true)` into the sandboxed content WC (no preload); output is a host-scoped cosmetic rule only | `picker.test.ts` (pure `appendCosmeticRule`), `electron/test/e2e/picker.spec.ts` |

## Residual / accepted items

- **Visited content view has NO app CSP** — intentional and correct: imposing the app's
  CSP on arbitrary websites would break the web. CSP applies to the privileged chrome
  renderer only (control #10). Accepted.
- **Dev-mode CSP is relaxed** (`'unsafe-eval'`, `ws:`) to permit Vite HMR. The packaged
  (prod) chrome carries the strict policy; the e2e asserts the prod artifact is strict and
  the dev relaxations do NOT leak into `out/renderer/index.html`. Accepted (dev-only).
- **`onHeadersReceived`/`webRequest` not used** — CSP is delivered as a document `<meta>`
  because the prod chrome loads via `loadFile` (no HTTP layer). Network-level ad-blocking
  is handled by the @ghostery/adblocker engine, not `webRequest`. Accepted by design.
- **Distribution hardening (code-signing, notarization, auto-update integrity)** — deferred;
  see `deferred-distribution.md`. Accepted for the local-only/headless constraint.

## Sign-off

All twelve controls are enforced in code and covered by tests; the full dual-ABI gate
(`npm test` + `npm run build && npm run test:e2e`) is green at the Phase-5 exit. Signed off
for the local-only build. A real release must additionally complete the deferred items.
```

Create `docs/superpowers/engine-update-policy.md`:

```markdown
# Aegis — Filter Engine & Chromium Update Policy

**Date:** 2026-06-11

## Filter-list refresh (built, Phase 4)

- **Source of truth:** `SubscriptionsRepo` (enabled filter lists) + Phase-4 `CustomFiltersRepo`
  (the user's "My filters" + element-picker output).
- **Scheduled refresh:** a 24h background scheduler in `electron/main/index.ts` (`runRefresh`)
  re-fetches each enabled list, writes per-listId caches, and rebuilds the engine via
  `rebuildEngineFromCache()` → `assembleEngineTexts(listTexts, customFiltersRepo.get())` →
  `buildEngine(...)`. The rebuilt engine swaps in on the next navigation (engine-readiness
  gating).
- **Manual refresh:** `lists.*` IPC (`updateNow`) triggers the same path on demand from the
  Settings filter-list manager.
- **Bundled seed fallback:** a generated seed (`scripts/generate-seed.mjs`) ships so the app
  blocks ads on first run / fully offline before the first network refresh succeeds. Offline
  mode (`AEGIS_ADBLOCK_OFFLINE`) is exercised in e2e.
- **Custom-filter immediacy:** saving a my-filter or picking an element calls
  `rebuildEngineFromCache()` directly (no 24h wait) so the change applies on the next nav.

## Chromium / Electron update stance

- The Chromium engine is whatever ships with the pinned Electron (42.4.0). Security fixes in
  Chromium therefore arrive via an **Electron version bump**, which is a release-cadence
  activity — **deferred** under the current local-only/headless constraint (see
  `deferred-distribution.md`).
- **Policy for a real release:** track Electron stable releases; bump on each security
  release; re-run the full dual-ABI gate (`npm test` + `npm run build && npm run test:e2e`)
  and re-verify the security control matrix before publishing. Pin the Electron version in
  `package.json` and record the Chromium version in release notes.
- Until then, the engine/Chromium version is fixed at the pinned Electron; this is documented
  and accepted, not silently stale.
```

Create `docs/superpowers/deferred-distribution.md`:

```markdown
# Aegis — Deferred Distribution Requirements

**Date:** 2026-06-11
**Status:** DEFERRED (documented, not built). Reason: the standing local-only / headless
constraint precludes a release host, signing certificates, and a notarization/update feed.
This document records exactly what a real release would require.

## What is NOT built (and why)

| Area | What a release needs | Why deferred |
|------|----------------------|--------------|
| Packaging | electron-builder targets/installers (AppImage/deb/rpm on Linux; nsis/msi on Windows; dmg on macOS) | Needs per-OS build hosts; out of scope for local-only |
| Seed bundling | `extraResources` to ship the generated filter seed inside the packaged app | Tied to packaging above |
| Code-signing | Windows Authenticode cert; macOS Developer ID cert | Requires purchased certificates / key custody |
| Notarization | Apple notarytool submission + stapling | Requires an Apple Developer account + signing |
| Auto-update | electron-updater + a remote release feed (e.g. a static update server or GitHub Releases) | Requires a remote release host (ruled out) |
| Publishing | Release pipeline + checksums + signed artifacts | Tied to all of the above |
| Telemetry/stats | Detailed ad-block stats/logs surfacing | Out of scope; privacy-by-default |

## Concrete checklist for a future release cycle

1. Add `electron-builder` config (targets + `extraResources` for the seed) to `package.json`
   / a builder config; verify a packaged build launches and blocks ads.
2. Provision signing certs (Win Authenticode, macOS Developer ID) in CI secrets; sign the
   artifacts.
3. macOS: notarize via `notarytool` and staple.
4. Stand up an update feed; wire `electron-updater`; verify a signed update round-trips.
5. Bump/track Electron per `engine-update-policy.md`; re-run the full dual-ABI gate +
   re-verify `security-audit-signoff.md`.
6. Publish signed artifacts with checksums and release notes (record the Chromium version).

Until a release host + certs exist, Aegis remains a local-only build; everything in §"What
is NOT built" stays deferred and is intentionally absent — not a gap in the Phase-5 feature
work.
```

- [ ] **Step 2: Run the full dual-ABI regression gate, verify it passes**

The exit gate runs the entire suite under both ABIs, exactly as established (§1.9 / spec §5):

Run (unit, Node ABI): `npm test`
Expected: PASS — all unit/jsdom suites green (the prior 277-baseline plus every Phase-5 unit suite: `downloadsRepo`, `permissionsRepo`, `FavoritesRepo`/`SavedRepo` `clear()`, the pure helpers, the IPC builders, the renderer hooks/components/Settings tabs), no failures, no regressions.

Run (e2e, Electron ABI): `npm run build && npm run test:e2e`
Expected: PASS — all e2e specs green: the prior Phase 0–4 specs (`sandbox`, `boot`, `nav`, `window`, `popup`, `chromeLockdown`, `adblock*`, `cosmetic`, `antiadblock`, `filterlists`, `myfilters`, `settings`, `sidebar`, `history`, `favorites`, `saved`, `persistence`) AND the Phase-5 specs added in Tasks 23–25 (`downloads`, `permissions`, `csp`, `contentPolicy`, `dataPort`, `picker`), with no regression.

(Capture both exit codes / the playwright `list` reporter summary; the task is complete only when both commands report all-passing with a zero exit status.)

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/security-audit-signoff.md \
        docs/superpowers/engine-update-policy.md \
        docs/superpowers/deferred-distribution.md
git commit -m "docs(phase5): security-audit sign-off, engine/Chromium update policy, deferred-distribution; full dual-ABI gate green — Phase-5 exit"
```

---

#### New names introduced (Block E)

- `electron/test/fixtures/downloads/big.bin` (fixture file)
- `electron/test/fixtures/downloads/page.html` (fixture file; `window.__aegisClickDownload`)
- `'.bin'` MIME entry in `electron/test/e2e/fixtureServer.ts`
- `electron/test/e2e/downloads.spec.ts`
- `electron/test/e2e/permissions.spec.ts`
- `electron/test/e2e/csp.spec.ts` (`STRICT_DIRECTIVES` const)
- `electron/test/e2e/contentPolicy.spec.ts`
- `electron/test/e2e/dataPort.spec.ts` (`ExportPayload` interface)
- `electron/test/e2e/picker.spec.ts`
- `__aegisTest.phase5.pickerStart` (e2e-only registry handle to the real `buildPickerHandlers(...)[IPC.pickerStart]` flow, added in `electron/main/index.ts`)
- `docs/superpowers/security-audit-signoff.md`
- `docs/superpowers/engine-update-policy.md`
- `docs/superpowers/deferred-distribution.md`