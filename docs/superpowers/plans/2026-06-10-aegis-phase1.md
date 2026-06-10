# Aegis Phase 1 — Network Ad/Tracker Blocking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add always-on, uBlock-grade network ad/tracker blocking (engine fully on; cosmetic/anti-adblock live but verified in Phase 2) to the Phase-0 Electron browser shell, with list management, escape-hatch controls, and blocked counts.

**Architecture:** A main-process adblock subsystem binds `@ghostery/adblocker-electron` to the content `persist:content` session. An `AdblockController` reconciles blocking on/off per top-frame navigation (global toggle + per-site allowlist), swaps in refreshed engines at the navigation boundary, and counts blocks via the engine's `request-blocked`/`request-redirected` events. A bundled prebuilt engine snapshot guarantees first-run blocking; a list manager fetches/refreshes/caches lists (HTTPS-only, size-capped, cache-fallback). New IPC (`adblock.*` / `lists.*` + an `adblock.blockedCount` event) drives a toolbar shield control.

**Tech Stack:** Electron 42.4.0 · @ghostery/adblocker-electron 2.18.0 (pure JS, no electron-rebuild) · better-sqlite3 · React 19 + TypeScript · Vitest 4 (`node` + `jsdom` projects) · Playwright `_electron`. Branch: `phase-1`.

**Companion contract (authoritative reference):** `docs/superpowers/plans/2026-06-10-aegis-phase1-contract.md` — §1 source-verified `@ghostery/adblocker` API, §2 as-built Phase-0 integration, §3 `shared/types.ts` additions, §4 interface ledger, §5 conventions, §6 task skeleton, **§8 review-driven corrections (override §1–§7)**.

---

## §0 — Corrections applied after adversarial review (already incorporated below)

This plan was drafted by 5 parallel block-drafters against the contract, then adversarially reviewed twice. The second-pass review confirmed all §8 corrections applied and the plan internally consistent across all 24 tasks. The following residual fixes from the second review are **already incorporated in the task bodies** (listed here only for traceability — do not re-apply):

1. **Task 7** — adds a dedicated assertion that `engine.updateResources(resources, checksum) === true` (the boolean is no longer only implied by a match check).
2. **Tasks 7 & 24** — the resources.json payload uses ONE source-verified shape, `{ "scriptlets": [], "redirects": [] }` (verified against `Resources.parse` in 2.18.0, which reads top-level `scriptlets[]`/`redirects[]`; other shapes silently load nothing). Used identically in the Task 7 unit test and the Task 24 fixture.
3. **Task 18** — a single final `index.ts` artifact that imports `IPC` and uses `IPC.evtAdblockBlockedCount` (no literal-then-replace two-step).
4. **Task 18 & 24** — boot exposes `__aegisTest.adblock.engineSource` (`'cache'|'snapshot'|'filter'|'built'`) and `__aegisTest.adblock.isBlockingActive()`; the **first-run-on-seed** e2e asserts `engineSource === 'snapshot'` + `isBlockingActive() === true` (deterministic — decoupled from uncertain EasyList localhost path matching), in addition to the deterministic-filter block proof.
5. **Task 18** — note: Phase 1 sources refresh from the `DEFAULT_LIST_URLS` constant (or the `AEGIS_ADBLOCK_LIST_BASE` override); `SubsRepo` records per-source metadata only. Driving fetch from `filter_subscriptions.enabled` is deferred to Phase 4 (no list-manager UI until then) — intentional, traceable.
6. **Task 1** — `electron-builder.yml` is shown as the real full file (`appId`, `productName`, the 3-entry `asarUnpack`), preserving existing keys.
7. **Task 21** — `AdblockState` is folded into the existing `import type { NavState } from '../../shared/types'` line in `Toolbar.test.tsx`.
8. **Task 12** — `BlockedCounter` tests use numeric `ViewId`s (`PRIMARY_VIEW_ID`, `42`), matching the real `ViewId = number` type.

---

Both packages exist at 2.18.0 on npm; I'm on branch `phase-1`. I have everything I need. Let me also quickly confirm the `nav.ts` IPC handler-builder shape (for the SubsRepo/seed conventions) and how `adsAndTrackingLists` is shaped, by checking how the contract describes it. I have all the integration facts from the contract §1-§4 and the as-built code. 

I now have all the information needed to expand Tasks 1-5. Here is the Block A markdown.

---

### Task 1: Add adblocker deps + electron-vite externalize/asarUnpack + seed-copy plugin

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `electron.vite.config.ts` (main config: `external`, `copySeedPlugin`)
- Modify: `electron-builder.yml` (asarUnpack)

This is a config/scaffold task (not red-green). Implement the config, then verify with the real `node -e` probe (§8.2) and `npm run build`.

- [ ] **Step 1: Install the two adblocker packages (pinned 2.18.0)**
Run:
```bash
npm install @ghostery/adblocker-electron@2.18.0 @ghostery/adblocker-electron-preload@2.18.0
```
This adds both to `dependencies` in `package.json` (they are pure JS, transitively pulling `@ghostery/adblocker@2.18.0` — no `electron-rebuild` burden; only `better-sqlite3` still needs the native ABI scripts, unchanged). After it runs, `package.json` `"dependencies"` must read:
```json
  "dependencies": {
    "@ghostery/adblocker-electron": "2.18.0",
    "@ghostery/adblocker-electron-preload": "2.18.0",
    "better-sqlite3": "^12.10.0"
  },
```

- [ ] **Step 2: Verify the value import works under plain Node (proves engine.ts unit-testability under the Vitest `node` project, §8.2)**
Run:
```bash
node -e "const {ElectronBlocker}=require('@ghostery/adblocker-electron'); console.log(typeof ElectronBlocker, typeof ElectronBlocker.parse, typeof ElectronBlocker.deserialize)"
```
Expected: `function function function`
(If this prints anything else, STOP — the rest of Block A/B assumes `ElectronBlocker.parse`/`deserialize` are callable in the `node` Vitest project. Do not proceed on assumption.)

- [ ] **Step 3: Implement — add `external` + the seed-copy Vite plugin to the `main` config (§8.1)**
Full new contents of `electron.vite.config.ts`:
```ts
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Copy the committed engine snapshot from the SOURCE tree into the main build
 * output on every main build (dev + build). At runtime __dirname for main is
 * out/main/, so Task 18 reads join(__dirname, 'adblock/seed/engine-seed.bin');
 * nothing else bridges the source blob to out/. If the blob has not been
 * generated yet, copyFileSync throws and we swallow it — loadSnapshotEngine
 * handles the resulting null. (Packaged-app extraResources is a Phase-5 item.)
 */
function copySeedPlugin() {
  return {
    name: 'aegis-copy-seed',
    writeBundle() {
      try {
        const dir = resolve(__dirname, 'out/main/adblock/seed');
        mkdirSync(dir, { recursive: true });
        copyFileSync(
          resolve(__dirname, 'electron/main/adblock/seed/engine-seed.bin'),
          resolve(dir, 'engine-seed.bin'),
        );
      } catch {
        /* seed not generated yet; loadSnapshotEngine handles null */
      }
    },
  };
}

export default defineConfig({
  main: {
    plugins: [copySeedPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
        external: [
          'better-sqlite3',
          '@ghostery/adblocker-electron',
          '@ghostery/adblocker-electron-preload',
        ],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          chromePreload: resolve(__dirname, 'electron/preload/chromePreload.ts'),
          contentPreload: resolve(__dirname, 'electron/preload/contentPreload.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
      },
    },
  },
});
```

- [ ] **Step 4: Implement — asarUnpack the adblocker packages (so the preload package resolves at runtime via `require.resolve`)**
Add the two adblocker packages to `asarUnpack` (the engine resolves its preload at runtime via `require.resolve`, so both must be unpacked). The existing `electron-builder.yml` has exactly `appId`, `productName`, and a one-entry `asarUnpack`. Replace its full contents with:
```yaml
appId: com.aegis.browser
productName: Aegis
asarUnpack:
  - "**/node_modules/better-sqlite3/**"
  - "**/node_modules/@ghostery/adblocker-electron/**"
  - "**/node_modules/@ghostery/adblocker-electron-preload/**"
```
(Packaging itself is exercised in Phase 5; this only records the unpack contract now.)

- [ ] **Step 5: Verify the build succeeds with the new deps + plugin**
Run:
```bash
npm run build
```
Expected: build completes with exit 0; `out/main/index.js` is produced; the build log shows no rollup "Could not resolve '@ghostery/adblocker-electron'" error (the packages are externalized, not bundled). The `aegis-copy-seed` plugin runs in `writeBundle` and silently no-ops (the seed blob does not exist until Task 2) — the build must NOT fail on the missing seed.

- [ ] **Step 6: Commit**
```bash
git add package.json package-lock.json electron.vite.config.ts electron-builder.yml
git commit -m "chore(adblock): add @ghostery/adblocker-electron deps, externalize+asarUnpack, seed-copy vite plugin"
```

---

### Task 2: `generate-seed` dev script + bundled snapshot + deserialize-compat test

**Files:**
- Create: `scripts/generate-seed.mjs`
- Create: `electron/main/adblock/seed/.gitkeep` (placeholder so the dir exists pre-generation)
- Create (generated, committed): `electron/main/adblock/seed/engine-seed.bin`
- Modify: `package.json` (add `generate-seed` script)
- Test: `electron/main/adblock/seed/seed-compat.test.ts`

This is a **scaffold task, NOT red-green** (§8.10). The compat test is written FIRST, but its first run PASSES-with-skip (the blob is absent → it logs a "run generate-seed" warning and skips). The meaningful green is Step 5, AFTER `npm run generate-seed` produces the blob.

- [ ] **Step 1: Write the compat test (skips cleanly when the blob is absent)**
Create `electron/main/adblock/seed/seed-compat.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ElectronBlocker } from '@ghostery/adblocker-electron';

const SEED_PATH = join(__dirname, 'engine-seed.bin');

describe('engine seed snapshot', () => {
  it('deserializes the committed snapshot against the installed engine', () => {
    if (!existsSync(SEED_PATH)) {
      console.warn(
        `[seed-compat] ${SEED_PATH} is absent — run \`npm run generate-seed\` to build it. Skipping.`,
      );
      return; // scaffold task: no blob yet → pass-with-skip (§8.10)
    }
    const bytes = new Uint8Array(readFileSync(SEED_PATH));
    // ElectronBlocker.deserialize throws on a serialization-version/format
    // mismatch — catching "engine bumped, snapshot not regenerated".
    const engine = ElectronBlocker.deserialize(bytes);
    expect(engine).toBeInstanceOf(ElectronBlocker);
  });
});
```

- [ ] **Step 2: Run the test — expect PASS-with-skip (blob absent, §8.10)**
Run:
```bash
npx vitest run electron/main/adblock/seed/seed-compat.test.ts
```
Expected: PASS. Console shows the `[seed-compat] ... is absent — run \`npm run generate-seed\`` warning (the blob does not exist yet, so the test returns early). This is NOT a red→green FAIL; it is the documented scaffold behavior.

- [ ] **Step 3: Implement the generate-seed script**
Create `scripts/generate-seed.mjs`:
```js
// scripts/generate-seed.mjs
// Dev-only: build the default-list ElectronBlocker via fromLists (fetches the
// 14 default ad/tracking lists AND the $redirect resources.json), serialize it,
// and write the committed snapshot the app ships for never-zero first-run
// blocking. Run with `npm run generate-seed`. Regenerate on engine-version bumps
// (the seed-compat test fails otherwise). Uses Node 22 global fetch (no cross-fetch).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, '..', 'electron', 'main', 'adblock', 'seed', 'engine-seed.bin');

async function main() {
  console.log(`[generate-seed] fetching ${adsAndTrackingLists.length} default lists + resources…`);
  // fromLists fetches lists AND $redirect resources, then parse + updateResources.
  // Pass NO custom config → library defaults (network + cosmetic + scriptlet layers).
  const engine = await ElectronBlocker.fromLists(fetch, adsAndTrackingLists);
  const bytes = engine.serialize();
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, bytes);
  console.log(`[generate-seed] wrote ${bytes.length} bytes to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[generate-seed] failed:', err);
  process.exitCode = 1;
});
```
Add the npm script to `package.json` `"scripts"` (insert after `"build"`):
```json
    "generate-seed": "node scripts/generate-seed.mjs",
```
Create `electron/main/adblock/seed/.gitkeep` (empty file) so the directory is tracked before the blob is generated:
```bash
mkdir -p electron/main/adblock/seed
touch electron/main/adblock/seed/.gitkeep
```

- [ ] **Step 4: Generate the snapshot (requires network — dev-time only)**
Run:
```bash
npm run generate-seed
```
Expected: prints `[generate-seed] fetching 14 default lists + resources…` then `[generate-seed] wrote <N> bytes to .../engine-seed.bin` (N ~1–2 MB). The file `electron/main/adblock/seed/engine-seed.bin` now exists.

- [ ] **Step 5: Re-run the compat test — now the meaningful PASS (blob deserializes)**
Run:
```bash
npx vitest run electron/main/adblock/seed/seed-compat.test.ts
```
Expected: PASS, with NO skip warning — `existsSync(SEED_PATH)` is true, `ElectronBlocker.deserialize(bytes)` returns an `ElectronBlocker` instance, `expect(engine).toBeInstanceOf(ElectronBlocker)` passes. This proves the committed blob is compatible with the installed `ENGINE_VERSION = 876`.

- [ ] **Step 6: Commit (script + committed binary snapshot + test)**
```bash
git add scripts/generate-seed.mjs package.json electron/main/adblock/seed/.gitkeep electron/main/adblock/seed/engine-seed.bin electron/main/adblock/seed/seed-compat.test.ts
git commit -m "chore(adblock): generate-seed dev script + bundled engine snapshot + deserialize-compat test"
```

---

### Task 3: `shared/types.ts` additions (AdblockState/BlockedCount/ListUpdateResult, IPC channels, AegisApi)

**Files:**
- Modify: `shared/types.ts` (add interfaces, extend `IPC`, extend `AegisApi`)
- Test: `shared/types.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test (extend `shared/types.test.ts`)**
Replace the full contents of `shared/types.test.ts` with:
```ts
import { describe, it, expect } from 'vitest';
import { IPC, PRIMARY_VIEW_ID, ALLOWED_NAV_SCHEMES } from './types';
import type { AdblockState, BlockedCount, ListUpdateResult, ListSourceResult } from './types';

describe('shared/types', () => {
  it('exposes the IPC channel constants', () => {
    expect(IPC.navNavigate).toBe('nav.navigate');
    expect(IPC.navGetState).toBe('nav.getState');
    expect(IPC.viewSetContentVisible).toBe('view.setContentVisible');
    expect(IPC.settingsGet).toBe('settings.get');
    expect(IPC.evtNavState).toBe('nav.state');
    expect(IPC.evtNavFailed).toBe('nav.failed');
    expect(IPC.evtNavCrashed).toBe('nav.crashed');
  });

  it('uses the primary view id and the nav-scheme allowlist', () => {
    expect(PRIMARY_VIEW_ID).toBe(1);
    expect(ALLOWED_NAV_SCHEMES).toEqual(['https:', 'http:']);
  });

  it('exposes the Phase-1 adblock + lists IPC channel constants', () => {
    expect(IPC.adblockSetEnabled).toBe('adblock.setEnabled');
    expect(IPC.adblockToggleAllowlist).toBe('adblock.toggleAllowlist');
    expect(IPC.adblockGetState).toBe('adblock.getState');
    expect(IPC.listsUpdateNow).toBe('lists.updateNow');
    expect(IPC.evtAdblockBlockedCount).toBe('adblock.blockedCount');
  });

  it('admits the Phase-1 data-model shapes', () => {
    const state: AdblockState = { enabled: true, allowlistedHosts: ['example.com'], sessionBlocked: 5 };
    expect(state.allowlistedHosts).toContain('example.com');

    const count: BlockedCount = { viewId: PRIMARY_VIEW_ID, page: 2, session: 9 };
    expect(count.viewId).toBe(PRIMARY_VIEW_ID);

    const src: ListSourceResult = { listId: 'easylist', ok: false, error: 'timeout' };
    const result: ListUpdateResult = { perSource: [src], lastUpdated: 1234 };
    expect(result.perSource[0].ok).toBe(false);
    expect(result.lastUpdated).toBe(1234);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run:
```bash
npx vitest run shared/types.test.ts
```
Expected: FAIL — `IPC.adblockSetEnabled` is `undefined` so `expect(IPC.adblockSetEnabled).toBe('adblock.setEnabled')` fails, and the `import type { AdblockState, ... }` resolves to nothing (the type-shape `it` block compiles against missing types). Failure references the new adblock channel assertions.

- [ ] **Step 3: Implement — extend `shared/types.ts`**
In `shared/types.ts`, extend the `IPC` object: replace the events comment block region so the full `IPC` object reads:
```ts
export const IPC = {
  navNavigate: 'nav.navigate',
  navBack: 'nav.back',
  navForward: 'nav.forward',
  navReloadOrStop: 'nav.reloadOrStop',
  navHome: 'nav.home',
  navGetState: 'nav.getState',
  viewSetContentVisible: 'view.setContentVisible',
  settingsGet: 'settings.get',
  settingsSet: 'settings.set',
  // adblock + lists (chrome -> main)
  adblockSetEnabled: 'adblock.setEnabled',
  adblockToggleAllowlist: 'adblock.toggleAllowlist',
  adblockGetState: 'adblock.getState',
  listsUpdateNow: 'lists.updateNow',
  // events (main -> chrome renderer)
  evtNavState: 'nav.state',
  evtNavFailed: 'nav.failed',
  evtNavCrashed: 'nav.crashed',
  evtAdblockBlockedCount: 'adblock.blockedCount',
} as const;
```
Add the data-model interfaces (place them after the `NavCrashed` interface, before `SearchEngine`):
```ts
// ---- adblock data model ----
export interface AdblockState {
  enabled: boolean; // global on/off
  allowlistedHosts: string[]; // hosts where blocking is suppressed
  sessionBlocked: number; // monotonic session total
}
export interface BlockedCount {
  viewId: ViewId;
  page: number; // resets each top-frame, non-same-document navigation
  session: number; // monotonic
}
export interface ListSourceResult {
  listId: string;
  ok: boolean;
  error?: string;
}
export interface ListUpdateResult {
  perSource: ListSourceResult[];
  lastUpdated: number; // epoch ms of this refresh attempt
}
```
Extend the `AegisApi` interface: add the `adblock` and `lists` namespaces after the `settings` namespace, inside the interface body:
```ts
  adblock: {
    setEnabled(enabled: boolean): Promise<AdblockState>;
    toggleAllowlist(host: string): Promise<AdblockState>;
    getState(): Promise<AdblockState>;
    onBlockedCount(cb: (c: BlockedCount) => void): () => void;
  };
  lists: {
    updateNow(): Promise<ListUpdateResult>;
  };
```

- [ ] **Step 4: Run the test, verify it passes**
Run:
```bash
npx vitest run shared/types.test.ts
```
Expected: PASS — all IPC-channel assertions resolve, and the data-model `it` block compiles and runs.

- [ ] **Step 5: Commit**
```bash
git add shared/types.ts shared/types.test.ts
git commit -m "feat(adblock): add AdblockState/BlockedCount/ListUpdateResult types, IPC channels, AegisApi namespaces"
```

---

### Task 4: `AdblockRepo` + `adblock_config` table in `runMigrations`

**Files:**
- Create: `electron/main/db/adblockRepo.ts`
- Modify: `electron/main/db/sqlite.ts` (add `adblock_config` table + singleton seed to `runMigrations`)
- Test: `electron/main/db/adblockRepo.test.ts`
- Test: `electron/main/db/sqlite.test.ts` (extend: assert the new table)

- [ ] **Step 1: Write the failing test**
Create `electron/main/db/adblockRepo.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { AdblockRepo } from './adblockRepo';

describe('adblockRepo', () => {
  let db: Database.Database;
  let repo: AdblockRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new AdblockRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('getState', () => {
    it('defaults to enabled=true and an empty allowlist (seeded singleton)', () => {
      expect(repo.getState()).toEqual({ enabled: true, allowlistedHosts: [] });
    });
  });

  describe('setEnabled', () => {
    it('persists the global toggle', () => {
      repo.setEnabled(false);
      expect(repo.getState().enabled).toBe(false);
      repo.setEnabled(true);
      expect(repo.getState().enabled).toBe(true);
    });

    it('persists across repo instances on the same db', () => {
      repo.setEnabled(false);
      const repo2 = new AdblockRepo(db);
      expect(repo2.getState().enabled).toBe(false);
    });
  });

  describe('toggleAllowlist', () => {
    it('adds a host then removes it, returning the new allowlist each time', () => {
      const added = repo.toggleAllowlist('example.com');
      expect(added).toEqual(['example.com']);
      expect(repo.getState().allowlistedHosts).toEqual(['example.com']);

      const removed = repo.toggleAllowlist('example.com');
      expect(removed).toEqual([]);
      expect(repo.getState().allowlistedHosts).toEqual([]);
    });

    it('accumulates multiple distinct hosts', () => {
      repo.toggleAllowlist('a.com');
      const list = repo.toggleAllowlist('b.com');
      expect(list).toContain('a.com');
      expect(list).toContain('b.com');
      expect(list).toHaveLength(2);
    });
  });

  describe('isAllowlisted', () => {
    it('reflects toggleAllowlist state', () => {
      expect(repo.isAllowlisted('example.com')).toBe(false);
      repo.toggleAllowlist('example.com');
      expect(repo.isAllowlisted('example.com')).toBe(true);
      repo.toggleAllowlist('example.com');
      expect(repo.isAllowlisted('example.com')).toBe(false);
    });
  });
});
```
Also extend `electron/main/db/sqlite.test.ts` — add this `it` inside the existing `describe('runMigrations', ...)` block:
```ts
    it('creates the adblock_config table with a seeded singleton row', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='adblock_config'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('adblock_config');
      const row = db.prepare('SELECT enabled, allowlist FROM adblock_config WHERE id = 1').get() as
        | { enabled: number; allowlist: string }
        | undefined;
      expect(row?.enabled).toBe(1);
      expect(JSON.parse(row!.allowlist)).toEqual([]);
    });
```

- [ ] **Step 2: Run the test, verify it fails**
Run:
```bash
npx vitest run electron/main/db/adblockRepo.test.ts electron/main/db/sqlite.test.ts
```
Expected: FAIL — `adblockRepo.ts` does not exist (module-not-found / import error), and the new sqlite `it` fails because `adblock_config` is not created (`tbl?.name` is `undefined`).

- [ ] **Step 3: Implement**
Add the `adblock_config` table + singleton seed to `runMigrations` in `electron/main/db/sqlite.ts`. Replace the `runMigrations` body's `db.exec(...)` so it reads:
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
  `);
}
```
(`perSiteOverrides`/`customFilters` are Phase-4 placeholders — intentionally NOT added; spec §8. The `CHECK (id = 1)` + `INSERT OR IGNORE` enforces the idempotent singleton.)

Create `electron/main/db/adblockRepo.ts`:
```ts
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
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run:
```bash
npx vitest run electron/main/db/adblockRepo.test.ts electron/main/db/sqlite.test.ts
```
Expected: PASS — all `adblockRepo` cases green; the new `adblock_config` sqlite assertion green; the existing `settings`/idempotency cases still green.

- [ ] **Step 5: Commit**
```bash
git add electron/main/db/adblockRepo.ts electron/main/db/adblockRepo.test.ts electron/main/db/sqlite.ts electron/main/db/sqlite.test.ts
git commit -m "feat(adblock): AdblockRepo over adblock_config singleton + migration"
```

---

### Task 5: `SubsRepo` + `filter_subscriptions` table in `runMigrations` + `seedDefaults`

**Files:**
- Create: `electron/main/db/subsRepo.ts`
- Modify: `electron/main/db/sqlite.ts` (add `filter_subscriptions` table to `runMigrations`)
- Test: `electron/main/db/subsRepo.test.ts`
- Test: `electron/main/db/sqlite.test.ts` (extend: assert the new table)

- [ ] **Step 1: Write the failing test**
Create `electron/main/db/subsRepo.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { SubsRepo } from './subsRepo';

const DEFAULTS = [
  { listId: 'easylist', url: 'https://example.test/easylist.txt' },
  { listId: 'easyprivacy', url: 'https://example.test/easyprivacy.txt' },
];

describe('subsRepo', () => {
  let db: Database.Database;
  let repo: SubsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new SubsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('all (empty)', () => {
    it('returns [] before any seeding', () => {
      expect(repo.all()).toEqual([]);
    });
  });

  describe('seedDefaults', () => {
    it('inserts the defaults enabled with null metadata', () => {
      repo.seedDefaults(DEFAULTS);
      const all = repo.all();
      expect(all).toHaveLength(2);
      const byId = Object.fromEntries(all.map((s) => [s.listId, s]));
      expect(byId.easylist).toEqual({
        listId: 'easylist',
        url: 'https://example.test/easylist.txt',
        enabled: true,
        lastUpdated: null,
        etag: null,
        hash: null,
      });
    });

    it('is idempotent (INSERT OR IGNORE) — re-seeding does not duplicate or clobber', () => {
      repo.seedDefaults(DEFAULTS);
      repo.updateMeta('easylist', { lastUpdated: 111, etag: 'W/"x"', hash: 'abc' });
      repo.seedDefaults(DEFAULTS); // second seed must not reset metadata
      const all = repo.all();
      expect(all).toHaveLength(2);
      const easylist = all.find((s) => s.listId === 'easylist')!;
      expect(easylist.lastUpdated).toBe(111);
      expect(easylist.etag).toBe('W/"x"');
      expect(easylist.hash).toBe('abc');
    });
  });

  describe('updateMeta', () => {
    it('records lastUpdated/etag/hash for a list (etag may be null)', () => {
      repo.seedDefaults(DEFAULTS);
      repo.updateMeta('easyprivacy', { lastUpdated: 222, etag: null, hash: 'deadbeef' });
      const ep = repo.all().find((s) => s.listId === 'easyprivacy')!;
      expect(ep.lastUpdated).toBe(222);
      expect(ep.etag).toBeNull();
      expect(ep.hash).toBe('deadbeef');
    });

    it('persists across repo instances on the same db', () => {
      repo.seedDefaults(DEFAULTS);
      repo.updateMeta('easylist', { lastUpdated: 333, etag: 'e', hash: 'h' });
      const repo2 = new SubsRepo(db);
      const easylist = repo2.all().find((s) => s.listId === 'easylist')!;
      expect(easylist.lastUpdated).toBe(333);
      expect(easylist.hash).toBe('h');
    });
  });
});
```
Also extend `electron/main/db/sqlite.test.ts` — add this `it` inside the existing `describe('runMigrations', ...)` block:
```ts
    it('creates the filter_subscriptions table with the expected columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='filter_subscriptions'",
        )
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('filter_subscriptions');
      const cols = (db.prepare('PRAGMA table_info(filter_subscriptions)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('listId');
      expect(cols).toHaveProperty('url');
      expect(cols).toHaveProperty('enabled');
      expect(cols).toHaveProperty('lastUpdated');
      expect(cols).toHaveProperty('etag');
      expect(cols).toHaveProperty('hash');
      expect(cols.listId).toBe(1); // listId is the primary key
    });
```

- [ ] **Step 2: Run the test, verify it fails**
Run:
```bash
npx vitest run electron/main/db/subsRepo.test.ts electron/main/db/sqlite.test.ts
```
Expected: FAIL — `subsRepo.ts` does not exist (module-not-found), and the new sqlite `it` fails because `filter_subscriptions` is not created (`tbl?.name` is `undefined`).

- [ ] **Step 3: Implement**
Add the `filter_subscriptions` table to `runMigrations` in `electron/main/db/sqlite.ts`. Append it inside the same `db.exec` template (after the `adblock_config` block from Task 4) so the full `db.exec` reads:
```ts
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
  `);
```
Create `electron/main/db/subsRepo.ts`:
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
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run:
```bash
npx vitest run electron/main/db/subsRepo.test.ts electron/main/db/sqlite.test.ts
```
Expected: PASS — all `subsRepo` cases green (empty, seed, idempotent re-seed, updateMeta, cross-instance persistence); the new `filter_subscriptions` sqlite assertion green; existing sqlite + `adblock_config` cases still green.

- [ ] **Step 5: Commit**
```bash
git add electron/main/db/subsRepo.ts electron/main/db/subsRepo.test.ts electron/main/db/sqlite.ts electron/main/db/sqlite.test.ts
git commit -m "feat(adblock): SubsRepo over filter_subscriptions + idempotent seedDefaults + migration"
```

---

#### New names introduced (Block A)
- `copySeedPlugin` — local helper in `electron.vite.config.ts` (not exported across modules); adds Vite plugin `name: 'aegis-copy-seed'`.
- npm scripts: `generate-seed`.
- `scripts/generate-seed.mjs` — dev script (no module exports; `main()` is local).
- `electron/main/adblock/seed/engine-seed.bin` — committed binary snapshot; `electron/main/adblock/seed/.gitkeep`.
- `shared/types.ts` exports: `AdblockState`, `BlockedCount`, `ListSourceResult`, `ListUpdateResult`; `IPC` keys `adblockSetEnabled`, `adblockToggleAllowlist`, `adblockGetState`, `listsUpdateNow`, `evtAdblockBlockedCount`; `AegisApi.adblock` (`setEnabled`/`toggleAllowlist`/`getState`/`onBlockedCount`) and `AegisApi.lists` (`updateNow`).
- `electron/main/db/adblockRepo.ts` export: `AdblockRepo` (methods `getState`, `setEnabled`, `isAllowlisted`, `toggleAllowlist`).
- `electron/main/db/subsRepo.ts` exports: `Subscription` (interface), `SubsRepo` (methods `seedDefaults`, `all`, `updateMeta`).
- `electron/main/db/sqlite.ts` `runMigrations` now also creates tables `adblock_config` (seeded singleton row id=1) and `filter_subscriptions` (no new exported symbol).

The adblocker package is not installed yet (Block A Task 1 handles that, per the contract). My drafting must rely on the contract's source-verified API in §1 and §4 — which it explicitly states was verified against the installed 2.18.0 source. I have all the codebase conventions I need: the vitest `node` project includes `electron/**/*.test.ts`, test command is `npx vitest run <file>`, and the atomicFile test style is confirmed.

I have everything required. Drafting Tasks 6-12 now.

### Task 6: `atomicFile` byte helpers (`writeFileAtomicBytes` / `readBytesSafe`)

**Files:**
- Modify: `electron/lib/atomicFile.ts:1-25`
- Test: `electron/lib/atomicFile.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to the existing `electron/lib/atomicFile.test.ts`. First extend the import line at the top of the file:

```ts
// electron/lib/atomicFile.test.ts (top import — replace line 6)
import {
  writeFileAtomic,
  readFileSafe,
  writeFileAtomicBytes,
  readBytesSafe,
} from './atomicFile';
```

Then append this block at the end of the file, before the final closing `});` is irrelevant — it is a new sibling `describe`, so add it after the existing top-level `describe('atomicFile', ...)` block (i.e. at end of file):

```ts
describe('atomicFile bytes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-atomic-bytes-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('writeFileAtomicBytes', () => {
    it('round-trips arbitrary binary bytes', () => {
      const target = join(dir, 'engine.bin');
      const data = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 128]);
      writeFileAtomicBytes(target, data);
      const back = readBytesSafe(target);
      expect(back).not.toBeNull();
      expect(Array.from(back as Buffer)).toEqual(Array.from(data));
    });

    it('overwrites an existing binary file', () => {
      const target = join(dir, 'engine.bin');
      writeFileAtomicBytes(target, new Uint8Array([1, 1, 1]));
      writeFileAtomicBytes(target, new Uint8Array([9, 8, 7, 6]));
      expect(Array.from(readBytesSafe(target) as Buffer)).toEqual([9, 8, 7, 6]);
    });

    it('leaves no temp file behind after a successful write', () => {
      const target = join(dir, 'engine.bin');
      writeFileAtomicBytes(target, new Uint8Array([42]));
      const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    });
  });

  describe('readBytesSafe', () => {
    it('returns a Buffer when the file exists', () => {
      const target = join(dir, 'present.bin');
      writeFileSync(target, Buffer.from([5, 6, 7]));
      const back = readBytesSafe(target);
      expect(Buffer.isBuffer(back)).toBe(true);
      expect(Array.from(back as Buffer)).toEqual([5, 6, 7]);
    });

    it('returns null when the file does not exist (ENOENT)', () => {
      const target = join(dir, 'missing.bin');
      expect(existsSync(target)).toBe(false);
      expect(readBytesSafe(target)).toBeNull();
    });

    it('returns null when the path is a directory (read error)', () => {
      expect(readBytesSafe(dir)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/lib/atomicFile.test.ts`
Expected: FAIL — the `node` project errors at import time / type level because `writeFileAtomicBytes` and `readBytesSafe` are not exported from `./atomicFile` (e.g. `No "writeFileAtomicBytes" export is defined` / the new `describe('atomicFile bytes')` tests throw `writeFileAtomicBytes is not a function`).

- [ ] **Step 3: Implement**

Replace the entire contents of `electron/lib/atomicFile.ts` with:

```ts
// electron/lib/atomicFile.ts
import { writeFileSync, renameSync, readFileSync } from 'node:fs';

/**
 * Atomically write `data` to `filePath`: write to a pid-suffixed temp file in
 * the same directory, then rename over the target (rename is atomic on the same
 * filesystem). Avoids a torn/partial file if the process dies mid-write.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, data, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Read `filePath` as UTF-8 text. Returns null on ENOENT or any read error
 * (e.g. EISDIR), so callers can treat "no usable file" uniformly.
 */
export function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Atomically write raw bytes (e.g. a serialized adblock engine blob) to
 * `filePath` using the same temp-write + rename crash-safe pattern as
 * `writeFileAtomic`, but without a UTF-8 encoding.
 */
export function writeFileAtomicBytes(filePath: string, data: Uint8Array): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}

/**
 * Read `filePath` as raw bytes. Returns a Buffer on success, or null on ENOENT
 * or any read error (e.g. EISDIR), mirroring `readFileSafe` for binary blobs.
 */
export function readBytesSafe(filePath: string): Buffer | null {
  try {
    return readFileSync(filePath);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/lib/atomicFile.test.ts`
Expected: PASS (all existing `atomicFile` tests plus the new `atomicFile bytes` tests green).

- [ ] **Step 5: Commit**

```bash
git add electron/lib/atomicFile.ts electron/lib/atomicFile.test.ts
git commit -m "feat(adblock): add atomic byte read/write helpers for engine blobs"
```

---

### Task 7: `engine.ts` `buildEngine` + `DEFAULT_LIST_URLS` / `RESOURCES_URL`

**Files:**
- Create: `electron/main/adblock/engine.ts`
- Test: `electron/main/adblock/engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/adblock/engine.test.ts
import { describe, it, expect } from 'vitest';
import { Request, ElectronBlocker } from '@ghostery/adblocker-electron';
import { createHash } from 'node:crypto';
import { buildEngine, DEFAULT_LIST_URLS, RESOURCES_URL } from './engine';

describe('engine buildEngine', () => {
  it('builds an engine from inline list text that blocks a matching URL', () => {
    const engine = buildEngine(['||ads.example.com^'], null);
    const { match } = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://ads.example.com/tag.js',
        sourceUrl: 'https://publisher.test/',
      }),
    );
    expect(match).toBe(true);
  });

  it('does not block a URL that no filter matches', () => {
    const engine = buildEngine(['||ads.example.com^'], null);
    const { match } = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://cdn.publisher.test/app.js',
        sourceUrl: 'https://publisher.test/',
      }),
    );
    expect(match).toBe(false);
  });

  it('concatenates multiple list texts', () => {
    const engine = buildEngine(['||a.example^', '||b.example^'], null);
    const a = engine.match(
      Request.fromRawDetails({
        type: 'image',
        url: 'https://a.example/x.gif',
        sourceUrl: 'https://pub.test/',
      }),
    ).match;
    const b = engine.match(
      Request.fromRawDetails({
        type: 'image',
        url: 'https://b.example/y.gif',
        sourceUrl: 'https://pub.test/',
      }),
    ).match;
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('loads $redirect resources when resources content is provided (updateResources returns true)', () => {
    // Source-verified resources.json shape: Resources.parse reads top-level
    // `scriptlets[]` / `redirects[]` (NOT a `resources` key); an empty-but-valid
    // payload loads cleanly without throwing. (§8.2/§8.3, verified vs 2.18.0.)
    const resources = JSON.stringify({ scriptlets: [], redirects: [] });

    // buildEngine accepts it without throwing and the engine still blocks.
    const engine = buildEngine(['||tracker.example^'], resources);
    const { match } = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://tracker.example/t.js',
        sourceUrl: 'https://pub.test/',
      }),
    );
    expect(match).toBe(true);

    // And updateResources itself returns true for this payload (§8.3) — assert the
    // boolean directly, since buildEngine swallows it.
    const direct = ElectronBlocker.parse('||tracker.example^');
    const checksum = createHash('sha1').update(resources).digest('hex');
    expect(direct.updateResources(resources, checksum)).toBe(true);
  });

  it('exposes the default list URL set derived from adsAndTrackingLists', () => {
    expect(Array.isArray(DEFAULT_LIST_URLS)).toBe(true);
    expect(DEFAULT_LIST_URLS.length).toBeGreaterThan(0);
    for (const entry of DEFAULT_LIST_URLS) {
      expect(typeof entry.listId).toBe('string');
      expect(entry.listId.length).toBeGreaterThan(0);
      expect(entry.url.startsWith('https://')).toBe(true);
    }
    // listIds are unique
    const ids = DEFAULT_LIST_URLS.map((s) => s.listId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes an HTTPS resources URL', () => {
    expect(RESOURCES_URL.startsWith('https://')).toBe(true);
    expect(RESOURCES_URL).toContain('resources.json');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/adblock/engine.test.ts`
Expected: FAIL — module `./engine` does not exist yet (`Failed to resolve import "./engine"` / `Cannot find module './engine'`).

- [ ] **Step 3: Implement**

```ts
// electron/main/adblock/engine.ts
import { createHash } from 'node:crypto';
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron';

/**
 * Single source for the default `$redirect` resources (ublock-origin resources.json).
 * Hardcoded per contract §1; the list URL set comes from `adsAndTrackingLists`.
 */
export const RESOURCES_URL =
  'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';

/**
 * Derive a stable, persistable list id from a default source URL. The id is the
 * filename (sans extension), used as the PK in `filter_subscriptions` and as the
 * per-list raw-cache filename.
 */
function listIdFromUrl(url: string): string {
  const last = url.split('/').filter(Boolean).pop() ?? url;
  return last.replace(/\.txt$/i, '');
}

/**
 * The default list URL set, derived from the engine's own `adsAndTrackingLists`
 * constant so the seed and runtime always agree on sources. Each entry pairs a
 * stable `listId` (for persistence/caching) with its HTTPS source `url`.
 */
export const DEFAULT_LIST_URLS: { listId: string; url: string }[] = adsAndTrackingLists.map(
  (url) => ({ listId: listIdFromUrl(url), url }),
);

/**
 * Build a runtime `ElectronBlocker` from already-fetched list text (NOT via
 * `fromLists`, which would re-fetch). When `resources` (resources.json content)
 * is provided, load it so `$redirect` rules serve neutered stubs.
 *
 * Passes NO custom config: the library defaults enable network + cosmetic +
 * scriptlet layers (contract §1).
 */
export function buildEngine(listTexts: string[], resources: string | null): ElectronBlocker {
  const engine = ElectronBlocker.parse(listTexts.join('\n'));
  if (resources !== null) {
    const checksum = createHash('sha1').update(resources).digest('hex');
    engine.updateResources(resources, checksum);
  }
  return engine;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/adblock/engine.test.ts`
Expected: PASS (all six `engine buildEngine` cases green; `updateResources` does not throw and the engine still blocks).

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/engine.ts electron/main/adblock/engine.test.ts
git commit -m "feat(adblock): buildEngine via parse + updateResources, default sources"
```

---

### Task 8: `engine.ts` `loadCachedEngine` / `loadSnapshotEngine` / `serializeEngine`

**Files:**
- Modify: `electron/main/adblock/engine.ts` (append three functions + a value import already present)
- Test: `electron/main/adblock/engine.test.ts` (append a `describe`)

- [ ] **Step 1: Write the failing test**

Extend the import at the top of `electron/main/adblock/engine.test.ts` to add the three new symbols, then append a new `describe` block at the end of the file.

Replace the existing `import { buildEngine, DEFAULT_LIST_URLS, RESOURCES_URL } from './engine';` line with:

```ts
import {
  buildEngine,
  loadCachedEngine,
  loadSnapshotEngine,
  serializeEngine,
  DEFAULT_LIST_URLS,
  RESOURCES_URL,
} from './engine';
```

And add these imports near the top of the test file (after the existing imports):

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Append at end of file:

```ts
describe('engine serialize/load round-trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-engine-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serializeEngine writes a blob that loadCachedEngine deserializes (round-trip blocks the same URL)', () => {
    const cachePath = join(dir, 'engine.bin');
    const original = buildEngine(['||ads.example.com^'], null);
    serializeEngine(original, cachePath);

    const loaded = loadCachedEngine(cachePath);
    expect(loaded).not.toBeNull();
    const { match } = (loaded as NonNullable<typeof loaded>).match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://ads.example.com/tag.js',
        sourceUrl: 'https://pub.test/',
      }),
    );
    expect(match).toBe(true);
  });

  it('loadCachedEngine returns null when the cache file is missing', () => {
    expect(loadCachedEngine(join(dir, 'nope.bin'))).toBeNull();
  });

  it('loadCachedEngine returns null on a corrupt blob (deserialize mismatch)', () => {
    const cachePath = join(dir, 'corrupt.bin');
    writeFileSync(cachePath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(loadCachedEngine(cachePath)).toBeNull();
  });

  it('loadSnapshotEngine round-trips a serialized blob the same way', () => {
    const snapPath = join(dir, 'engine-seed.bin');
    const original = buildEngine(['||tracker.example^'], null);
    serializeEngine(original, snapPath);

    const loaded = loadSnapshotEngine(snapPath);
    expect(loaded).not.toBeNull();
    const { match } = (loaded as NonNullable<typeof loaded>).match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://tracker.example/t.js',
        sourceUrl: 'https://pub.test/',
      }),
    );
    expect(match).toBe(true);
  });

  it('loadSnapshotEngine returns null when the snapshot is missing', () => {
    expect(loadSnapshotEngine(join(dir, 'absent.bin'))).toBeNull();
  });
});
```

Also extend the test file's vitest import to include the lifecycle hooks. Replace `import { describe, it, expect } from 'vitest';` with:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/adblock/engine.test.ts`
Expected: FAIL — `loadCachedEngine`, `loadSnapshotEngine`, and `serializeEngine` are not exported from `./engine` (`No "serializeEngine" export is defined` / `serializeEngine is not a function`).

- [ ] **Step 3: Implement**

Append these functions to `electron/main/adblock/engine.ts`, and extend its top imports to pull in the atomic byte helpers. Replace the existing import block at the top of `electron/main/adblock/engine.ts`:

```ts
import { createHash } from 'node:crypto';
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron';
```

with:

```ts
import { createHash } from 'node:crypto';
import { ElectronBlocker, adsAndTrackingLists } from '@ghostery/adblocker-electron';
import { writeFileAtomicBytes, readBytesSafe } from '../../lib/atomicFile';
```

Then append at the end of `electron/main/adblock/engine.ts`:

```ts
/**
 * Serialize `blocker` to `cachePath` atomically (temp-write + rename). Used to
 * write the user cache after a build/refresh so subsequent runs take the fast
 * deserialize path.
 */
export function serializeEngine(blocker: ElectronBlocker, cachePath: string): void {
  writeFileAtomicBytes(cachePath, blocker.serialize());
}

/**
 * Internal: read a serialized engine blob and deserialize it. Returns null on a
 * missing file or any deserialize error (corrupt blob or serialization-version
 * mismatch — `ElectronBlocker.deserialize` throws), so callers fall through to
 * the next load source instead of breaking.
 */
function loadEngineFromFile(filePath: string): ElectronBlocker | null {
  const bytes = readBytesSafe(filePath);
  if (bytes === null) return null;
  try {
    return ElectronBlocker.deserialize(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * Load the user-cache engine (`engine.bin` in app data). Null on miss/mismatch.
 */
export function loadCachedEngine(cachePath: string): ElectronBlocker | null {
  return loadEngineFromFile(cachePath);
}

/**
 * Load the bundled snapshot engine shipped in app resources. Null on
 * miss/mismatch (e.g. snapshot not regenerated after an engine-version bump).
 */
export function loadSnapshotEngine(snapshotPath: string): ElectronBlocker | null {
  return loadEngineFromFile(snapshotPath);
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/adblock/engine.test.ts`
Expected: PASS (Task 7 cases plus the five round-trip/null cases green).

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/engine.ts electron/main/adblock/engine.test.ts
git commit -m "feat(adblock): cache/snapshot load + atomic serialize round-trip"
```

---

### Task 9: `listManager.ts` `fetchSource` (timeout, streaming size-cap, non-2xx)

**Files:**
- Create: `electron/main/adblock/listManager.ts`
- Test: `electron/main/adblock/listManager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/adblock/listManager.test.ts
import { describe, it, expect } from 'vitest';
import { fetchSource } from './listManager';

/** Build a Response whose body streams `chunks` (Uint8Array) one at a time. */
function streamingResponse(
  chunks: Uint8Array[],
  init: { status?: number; etag?: string | null } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  const headers = new Headers();
  if (init.etag != null) headers.set('etag', init.etag);
  return new Response(stream, { status: init.status ?? 200, headers });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('listManager fetchSource', () => {
  it('returns the decoded text and the etag header on a 2xx response', async () => {
    const fetchImpl = (async () =>
      streamingResponse([enc('||ads.example^\n'), enc('||x.example^')], {
        etag: 'W/"abc123"',
      })) as unknown as typeof fetch;

    const result = await fetchSource('https://lists.test/a.txt', {
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      fetchImpl,
    });
    expect(result.text).toBe('||ads.example^\n||x.example^');
    expect(result.etag).toBe('W/"abc123"');
  });

  it('returns etag null when the response has no etag header', async () => {
    const fetchImpl = (async () =>
      streamingResponse([enc('||y.example^')])) as unknown as typeof fetch;
    const result = await fetchSource('https://lists.test/b.txt', {
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      fetchImpl,
    });
    expect(result.etag).toBeNull();
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () =>
      streamingResponse([enc('nope')], { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchSource('https://lists.test/c.txt', {
        timeoutMs: 1000,
        maxBytes: 1_000_000,
        fetchImpl,
      }),
    ).rejects.toThrow();
  });

  it('throws when the streamed body exceeds maxBytes (cap enforced before full buffering)', async () => {
    // Three 4-byte chunks = 12 bytes; cap at 8 → must throw on the chunk that crosses 8.
    const fetchImpl = (async () =>
      streamingResponse([enc('aaaa'), enc('bbbb'), enc('cccc')])) as unknown as typeof fetch;
    await expect(
      fetchSource('https://lists.test/big.txt', {
        timeoutMs: 1000,
        maxBytes: 8,
        fetchImpl,
      }),
    ).rejects.toThrow(/maxBytes|too large|size/i);
  });

  it('aborts and throws when the fetch exceeds timeoutMs', async () => {
    // fetchImpl honors the passed AbortSignal: reject when aborted.
    const fetchImpl = ((_url: string, opts: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal) {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }
      })) as unknown as typeof fetch;

    await expect(
      fetchSource('https://lists.test/slow.txt', {
        timeoutMs: 5,
        maxBytes: 1_000_000,
        fetchImpl,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/adblock/listManager.test.ts`
Expected: FAIL — module `./listManager` does not exist (`Failed to resolve import "./listManager"` / `Cannot find module './listManager'`).

- [ ] **Step 3: Implement**

```ts
// electron/main/adblock/listManager.ts

export interface FetchedSource {
  listId: string;
  url: string;
  ok: boolean;
  text: string;
  etag: string | null;
  hash: string;
  error?: string;
}

export interface FetchAllResult {
  sources: FetchedSource[];
  resources: string | null;
}

/**
 * Fetch a single list source with hardening:
 *  - per-request timeout via AbortController (caller-injectable clock through fetchImpl)
 *  - streaming size cap enforced as chunks arrive (throws before fully buffering)
 *  - non-2xx → throw
 * Returns the decoded UTF-8 text and the `etag` response header (or null).
 */
export async function fetchSource(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; fetchImpl?: typeof fetch },
): Promise<{ text: string; etag: string | null }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
    }
    const etag = res.headers.get('etag');
    const body = res.body;
    if (body === null) {
      // No streamable body: fall back to text(), still cap-checked.
      const text = await res.text();
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > opts.maxBytes) {
        throw new Error(`fetch ${url} exceeded maxBytes (${bytes} > ${opts.maxBytes})`);
      }
      return { text, etag };
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel();
          throw new Error(`fetch ${url} exceeded maxBytes (${total} > ${opts.maxBytes})`);
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    const text = new TextDecoder('utf-8').decode(merged);
    return { text, etag };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/adblock/listManager.test.ts`
Expected: PASS (all five `fetchSource` cases green, including timeout-abort and the size-cap throw on the chunk that crosses `maxBytes`).

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/listManager.ts electron/main/adblock/listManager.test.ts
git commit -m "feat(adblock): fetchSource with timeout, streaming size-cap, non-2xx guard"
```

---

### Task 10: `listManager.ts` `fetchAll` (per-source fetch → cache-fallback; resources best-effort)

**Files:**
- Modify: `electron/main/adblock/listManager.ts` (append `fetchAll` + a hash helper)
- Test: `electron/main/adblock/listManager.test.ts` (append a `describe`)

- [ ] **Step 1: Write the failing test**

Extend the test import line and append a `describe`. Replace `import { fetchSource } from './listManager';` with:

```ts
import { fetchSource, fetchAll } from './listManager';
```

Add these imports near the top of `electron/main/adblock/listManager.test.ts`:

```ts
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach } from 'vitest';
```

Append at end of file:

```ts
describe('listManager fetchAll', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'aegis-lists-'));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const okFetch = (bodyByUrl: Record<string, string>): typeof fetch =>
    (async (url: string) => {
      const body = bodyByUrl[url];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { etag: `etag-${body.length}` } });
    }) as unknown as typeof fetch;

  it('fetches each source, writes its raw cache, and returns ok with hash + etag', async () => {
    const subs = [
      { listId: 'easylist', url: 'https://lists.test/easylist.txt' },
      { listId: 'easyprivacy', url: 'https://lists.test/easyprivacy.txt' },
    ];
    const fetchImpl = okFetch({
      'https://lists.test/easylist.txt': '||ads.example^',
      'https://lists.test/easyprivacy.txt': '||track.example^',
      'https://lists.test/resources.json': '{"scriptlets":[],"redirects":[]}',
    });

    const result = await fetchAll(subs, {
      cacheDir,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      resourcesUrl: 'https://lists.test/resources.json',
      fetchImpl,
    });

    expect(result.sources.map((s) => s.listId).sort()).toEqual(['easylist', 'easyprivacy']);
    for (const s of result.sources) {
      expect(s.ok).toBe(true);
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.hash.length).toBeGreaterThan(0);
      expect(s.etag).toMatch(/^etag-/);
      expect(existsSync(join(cacheDir, `${s.listId}.txt`))).toBe(true);
    }
    expect(result.resources).toBe('{"scriptlets":[],"redirects":[]}');
  });

  it('falls back to the cached copy when a source fetch fails', async () => {
    const subs = [{ listId: 'easylist', url: 'https://lists.test/easylist.txt' }];
    // Pre-seed the cache as the last-known-good copy.
    writeFileSync(join(cacheDir, 'easylist.txt'), '||cached.example^');

    const failingFetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;

    const result = await fetchAll(subs, {
      cacheDir,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      resourcesUrl: 'https://lists.test/resources.json',
      fetchImpl: failingFetch,
    });

    expect(result.sources).toHaveLength(1);
    const s = result.sources[0];
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
    expect(s.text).toBe('||cached.example^');
    expect(s.hash.length).toBeGreaterThan(0);
  });

  it('marks a source not-ok with empty text when fetch fails and no cache exists', async () => {
    const subs = [{ listId: 'novel', url: 'https://lists.test/novel.txt' }];
    const failingFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await fetchAll(subs, {
      cacheDir,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      resourcesUrl: 'https://lists.test/resources.json',
      fetchImpl: failingFetch,
    });

    const s = result.sources[0];
    expect(s.ok).toBe(false);
    expect(s.text).toBe('');
    expect(s.error).toBeTruthy();
  });

  it('returns resources=null (best-effort) when the resources fetch fails', async () => {
    const subs = [{ listId: 'easylist', url: 'https://lists.test/easylist.txt' }];
    const fetchImpl = (async (url: string) => {
      if (url === 'https://lists.test/easylist.txt') {
        return new Response('||ads.example^', { status: 200 });
      }
      return new Response('no resources', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchAll(subs, {
      cacheDir,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      resourcesUrl: 'https://lists.test/resources.json',
      fetchImpl,
    });

    expect(result.sources[0].ok).toBe(true);
    expect(result.resources).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/adblock/listManager.test.ts`
Expected: FAIL — `fetchAll` is not exported from `./listManager` (`No "fetchAll" export is defined` / `fetchAll is not a function`).

- [ ] **Step 3: Implement**

Add a hash import and append `fetchAll` to `electron/main/adblock/listManager.ts`. First add at the very top of the file (above the `FetchedSource` interface):

```ts
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFileAtomic, readFileSafe } from '../../lib/atomicFile';
```

Then append at the end of `electron/main/adblock/listManager.ts`:

```ts
/** sha1 hex of list text — used as the per-source content hash in metadata. */
function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Fetch every subscription source. Per source: try `fetchSource`; on success
 * write the raw cache atomically and record ok + hash + etag; on failure fall
 * back to the on-disk cache (last-known-good) marked not-ok with the error, or
 * empty/not-ok if no cache exists. Resources are best-effort: a failure yields
 * `resources: null` (the engine still builds from list text).
 */
export async function fetchAll(
  subs: { listId: string; url: string }[],
  opts: {
    cacheDir: string;
    timeoutMs: number;
    maxBytes: number;
    resourcesUrl: string;
    fetchImpl?: typeof fetch;
  },
): Promise<FetchAllResult> {
  const sources: FetchedSource[] = [];
  for (const sub of subs) {
    const cachePath = join(opts.cacheDir, `${sub.listId}.txt`);
    try {
      const { text, etag } = await fetchSource(sub.url, {
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
        fetchImpl: opts.fetchImpl,
      });
      writeFileAtomic(cachePath, text);
      sources.push({
        listId: sub.listId,
        url: sub.url,
        ok: true,
        text,
        etag,
        hash: hashText(text),
      });
    } catch (err) {
      const cached = readFileSafe(cachePath);
      const text = cached ?? '';
      sources.push({
        listId: sub.listId,
        url: sub.url,
        ok: false,
        text,
        etag: null,
        hash: text.length > 0 ? hashText(text) : '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let resources: string | null = null;
  try {
    const { text } = await fetchSource(opts.resourcesUrl, {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      fetchImpl: opts.fetchImpl,
    });
    resources = text;
  } catch {
    resources = null;
  }

  return { sources, resources };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/adblock/listManager.test.ts`
Expected: PASS (Task 9 `fetchSource` cases plus the four `fetchAll` cases green: success+cache-write, cache-fallback, no-cache-empty, resources best-effort null).

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/listManager.ts electron/main/adblock/listManager.test.ts
git commit -m "feat(adblock): fetchAll with per-source cache-fallback and best-effort resources"
```

---

### Task 11: `listManager.ts` `RefreshScheduler` (injectable timer; `start` schedules; `triggerNow` no double-fire)

**Files:**
- Modify: `electron/main/adblock/listManager.ts` (append `RefreshScheduler`)
- Test: `electron/main/adblock/listManager.test.ts` (append a `describe`)

- [ ] **Step 1: Write the failing test**

Extend the test import line. Replace `import { fetchSource, fetchAll } from './listManager';` with:

```ts
import { fetchSource, fetchAll, RefreshScheduler } from './listManager';
```

Append at end of `electron/main/adblock/listManager.test.ts`:

```ts
describe('listManager RefreshScheduler', () => {
  /** A controllable fake timer: capture scheduled callbacks; fire on demand. */
  function makeFakeTimer() {
    let nextId = 1;
    const handles = new Map<number, { fn: () => void; ms: number }>();
    const setTimer = (fn: () => void, ms: number) => {
      const id = nextId++;
      handles.set(id, { fn, ms });
      return id;
    };
    const clearTimer = (id: number) => {
      handles.delete(id);
    };
    const fireAll = () => {
      // fire a snapshot so re-scheduling inside a tick does not loop forever here
      const snapshot = [...handles.values()];
      for (const h of snapshot) h.fn();
    };
    return { setTimer, clearTimer, fireAll, handles };
  }

  it('start() schedules a tick but does NOT fire immediately', () => {
    let ticks = 0;
    const t = makeFakeTimer();
    const sched = new RefreshScheduler({
      intervalMs: 1000,
      onTick: async () => {
        ticks++;
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    sched.start();
    expect(ticks).toBe(0); // no immediate tick
    expect(t.handles.size).toBe(1); // one timer scheduled
  });

  it('fires onTick when the scheduled timer elapses and re-schedules', async () => {
    let ticks = 0;
    const t = makeFakeTimer();
    const sched = new RefreshScheduler({
      intervalMs: 1000,
      onTick: async () => {
        ticks++;
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    sched.start();
    t.fireAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(ticks).toBe(1);
    // a fresh timer was scheduled for the next interval
    expect(t.handles.size).toBeGreaterThanOrEqual(1);
  });

  it('triggerNow() runs onTick once immediately without scheduling/disturbing the timer', async () => {
    let ticks = 0;
    const t = makeFakeTimer();
    const sched = new RefreshScheduler({
      intervalMs: 1000,
      onTick: async () => {
        ticks++;
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    sched.start();
    const sizeBefore = t.handles.size;
    await sched.triggerNow();
    expect(ticks).toBe(1); // exactly one extra tick
    expect(t.handles.size).toBe(sizeBefore); // schedule untouched (no double-fire)
  });

  it('stop() clears the scheduled timer so no further ticks fire', () => {
    let ticks = 0;
    const t = makeFakeTimer();
    const sched = new RefreshScheduler({
      intervalMs: 1000,
      onTick: async () => {
        ticks++;
      },
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    sched.start();
    sched.stop();
    expect(t.handles.size).toBe(0);
    t.fireAll();
    expect(ticks).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/adblock/listManager.test.ts`
Expected: FAIL — `RefreshScheduler` is not exported from `./listManager` (`No "RefreshScheduler" export is defined` / `RefreshScheduler is not a constructor`).

- [ ] **Step 3: Implement**

Append to `electron/main/adblock/listManager.ts`:

```ts
type TimerHandle = unknown;

/**
 * Repeating refresh scheduler with an injectable timer (so tests use a fake
 * clock and CI never hits the wall). `start()` schedules the FIRST tick one
 * interval out (no immediate fire); each tick re-schedules the next. `stop()`
 * cancels the pending timer. `triggerNow()` runs `onTick` once immediately
 * WITHOUT touching the schedule — the manual "update now" path must not
 * double-fire the periodic tick.
 */
export class RefreshScheduler {
  private readonly intervalMs: number;
  private readonly onTick: () => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;
  private handle: TimerHandle | null = null;
  private running = false;

  constructor(deps: {
    intervalMs: number;
    onTick: () => Promise<void>;
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    clearTimer?: (h: TimerHandle) => void;
  }) {
    this.intervalMs = deps.intervalMs;
    this.onTick = deps.onTick;
    this.setTimer =
      deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.clearTimer =
      deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
  }

  /** Run onTick once now without disturbing the periodic schedule. */
  async triggerNow(): Promise<void> {
    await this.onTick();
  }

  private schedule(): void {
    if (!this.running) return;
    this.handle = this.setTimer(() => {
      // fire the tick, then re-schedule the next interval
      void this.onTick().finally(() => {
        if (this.running) this.schedule();
      });
    }, this.intervalMs);
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/adblock/listManager.test.ts`
Expected: PASS (all prior `fetchSource`/`fetchAll` cases plus the four `RefreshScheduler` cases green: no immediate fire, tick+reschedule, `triggerNow` single-fire without schedule change, `stop` cancels).

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/listManager.ts electron/main/adblock/listManager.test.ts
git commit -m "feat(adblock): RefreshScheduler with injectable timer and no-double-fire triggerNow"
```

---

### Task 12: `blockedCounter.ts` (attach/detach to a fake EventEmitter blocker; page/session increments; `resetPage`; `snapshot`)

**Files:**
- Create: `electron/main/adblock/blockedCounter.ts`
- Test: `electron/main/adblock/blockedCounter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/adblock/blockedCounter.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { BlockedCounter } from './blockedCounter';
import { PRIMARY_VIEW_ID } from '../../../shared/types';

/**
 * Structural stand-in for ElectronBlocker's counting surface: the core engine
 * is an EventEmitter that emits 'request-blocked' / 'request-redirected' from
 * match(). BlockedCounter only uses `on` / `removeListener`, so a plain
 * EventEmitter is a faithful fake.
 */
function makeFakeBlocker() {
  return new EventEmitter();
}

const PRIMARY = PRIMARY_VIEW_ID; // ViewId is `number` (=== 1)

describe('BlockedCounter', () => {
  it('starts at zero for page and session', () => {
    const counter = new BlockedCounter(PRIMARY);
    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 0, session: 0 });
  });

  it('increments page and session on request-blocked', () => {
    const blocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);
    counter.attach(blocker as never);

    blocker.emit('request-blocked', {}, {});
    blocker.emit('request-blocked', {}, {});

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 2, session: 2 });
  });

  it('also increments on request-redirected', () => {
    const blocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);
    counter.attach(blocker as never);

    blocker.emit('request-blocked', {}, {});
    blocker.emit('request-redirected', {}, {});

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 2, session: 2 });
  });

  it('resetPage() zeroes page but leaves session monotonic', () => {
    const blocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);
    counter.attach(blocker as never);

    blocker.emit('request-blocked', {}, {});
    blocker.emit('request-blocked', {}, {});
    counter.resetPage();
    blocker.emit('request-blocked', {}, {});

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 1, session: 3 });
  });

  it('detach() removes listeners so later emits do not count', () => {
    const blocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);
    counter.attach(blocker as never);

    blocker.emit('request-blocked', {}, {});
    counter.detach(blocker as never);
    blocker.emit('request-blocked', {}, {});
    blocker.emit('request-redirected', {}, {});

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 1, session: 1 });
  });

  it('counts against a newly attached blocker after a swap (detach old, attach new)', () => {
    const oldBlocker = makeFakeBlocker();
    const newBlocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);

    counter.attach(oldBlocker as never);
    oldBlocker.emit('request-blocked', {}, {});
    counter.detach(oldBlocker as never);

    counter.attach(newBlocker as never);
    newBlocker.emit('request-blocked', {}, {});
    oldBlocker.emit('request-blocked', {}, {}); // detached → ignored

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 2, session: 2 });
  });

  it('snapshot() returns the viewId it was constructed with', () => {
    const counter = new BlockedCounter(42);
    expect(counter.snapshot().viewId).toBe(42);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/adblock/blockedCounter.test.ts`
Expected: FAIL — module `./blockedCounter` does not exist (`Failed to resolve import "./blockedCounter"` / `Cannot find module './blockedCounter'`).

- [ ] **Step 3: Implement**

```ts
// electron/main/adblock/blockedCounter.ts
import type { ViewId, BlockedCount } from '../../../shared/types';

/**
 * Structural type for the engine's counting surface. The core FiltersEngine is
 * an EventEmitter that emits 'request-blocked' / 'request-redirected' from
 * match(); we type only the methods we use so this module needs no value import
 * of ElectronBlocker (keeps it node-testable — contract §8.2).
 */
interface CountingBlocker {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Per-view blocked-request counter. `page` resets each top-frame navigation
 * (driven by the controller's did-start-navigation handler); `session` is
 * monotonic for the process lifetime. Counts both blocked and redirected
 * (neutered-stub) requests via the engine's events — the Electron wrapper emits
 * none of its own and allows only one onBeforeRequest listener (contract §1).
 */
export class BlockedCounter {
  private readonly viewId: ViewId;
  private pageCount = 0;
  private sessionCount = 0;
  private readonly onEvent = (): void => {
    this.pageCount += 1;
    this.sessionCount += 1;
  };

  constructor(viewId: ViewId) {
    this.viewId = viewId;
  }

  /** Add request-blocked + request-redirected listeners to `blocker`. */
  attach(blocker: CountingBlocker): void {
    blocker.on('request-blocked', this.onEvent);
    blocker.on('request-redirected', this.onEvent);
  }

  /** Remove the listeners (used when swapping to a new engine). */
  detach(blocker: CountingBlocker): void {
    blocker.removeListener('request-blocked', this.onEvent);
    blocker.removeListener('request-redirected', this.onEvent);
  }

  /** Reset the per-page count to 0; the session total is untouched. */
  resetPage(): void {
    this.pageCount = 0;
  }

  /** Current counts for this view. */
  snapshot(): BlockedCount {
    return { viewId: this.viewId, page: this.pageCount, session: this.sessionCount };
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/adblock/blockedCounter.test.ts`
Expected: PASS (all seven cases green: zero start, page+session on blocked, redirected counts, `resetPage` keeps session monotonic, `detach` stops counting, swap counts against the new blocker, `snapshot` carries the viewId).

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/blockedCounter.ts electron/main/adblock/blockedCounter.test.ts
git commit -m "feat(adblock): BlockedCounter with attach/detach, page/session, resetPage"
```

---

#### New names introduced (Block B)

- `electron/lib/atomicFile.ts`: `writeFileAtomicBytes`, `readBytesSafe` (exported)
- `electron/main/adblock/engine.ts`: `RESOURCES_URL`, `DEFAULT_LIST_URLS`, `buildEngine`, `serializeEngine`, `loadCachedEngine`, `loadSnapshotEngine` (exported); `listIdFromUrl`, `loadEngineFromFile` (local, non-exported)
- `electron/main/adblock/listManager.ts`: `FetchedSource`, `FetchAllResult` (exported interfaces), `fetchSource`, `fetchAll`, `RefreshScheduler` (exported); `hashText` (local, non-exported), `TimerHandle` (local type alias)
- `electron/main/adblock/blockedCounter.ts`: `BlockedCounter` (exported); `CountingBlocker` (local interface, non-exported)

The adblocker packages aren't installed yet (they're added in Task 1, which is Block A — not my responsibility). The branch is `phase-1` as required. The cwd is correct, the bash command just needs the project root which is the cwd. The package isn't installed, which is expected since Task 1 (Block A) adds it.

I have all the verified facts I need. Let me confirm the App.test.tsx mock shape is referenced by Task 21 (Block D, not mine) — I just need to ensure I don't duplicate it. My tasks are 13-18 (Block C). I now have everything to write the markdown.

Let me note the key constraint for Task 14's controller `getState()`: it returns `AdblockState` which has `sessionBlocked`, but `AdblockRepo.getState()` returns only `{enabled, allowlistedHosts}`. So the controller composes `sessionBlocked` from `this.counter.snapshot().session`. This is consistent with §3 and §4.

Now I'll produce the Block C task markdown.

### Task 13: `ViewController` getters `contentSession` / `contentWebContents`

**Files:**
- Modify: `electron/main/viewController.ts:62-65` (add two getters next to the private `wc()` helper)
- Test: `electron/main/viewController.test.ts` (extend the existing electron mock + add a new `describe` block)

The adblock subsystem binds to the content `WebContents` and its `Session`. The controller (Task 14) and boot (Task 18) need stable handles. Per contract §2 and §8.11 the mock's `webContents` and its `session` must be stable identities; the existing mock already returns a single `webContents` per `WebContentsView` instance and a single `session` object on it, so we assert against those exact references.

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `electron/main/viewController.test.ts` (after the existing `ViewController content-session security (Task 13)` block; the existing mock already exposes a stable `wc.session` object and a stable `wc` per instance — no mock change needed, we reference `h.getLastWc()`):

```ts
describe('ViewController content getters (Phase 1)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  it('contentWebContents returns the content WebContents (stable identity)', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    expect(vc.contentWebContents).toBe(wc);
    // stable across calls
    expect(vc.contentWebContents).toBe(vc.contentWebContents);
  });

  it('contentSession returns the content WebContents session (stable identity)', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    expect(vc.contentSession).toBe(wc.session);
    expect(vc.contentSession).toBe(vc.contentSession);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/viewController.test.ts`
Expected: FAIL — the two new tests error/fail because `vc.contentWebContents` and `vc.contentSession` are `undefined` (`expected undefined to be [WebContents]` / `... to be [session object]`). The pre-existing tests still pass.

- [ ] **Step 3: Implement**

Add the two getters to `electron/main/viewController.ts` immediately after the private `wc()` helper. Replace:

```ts
  private wc() {
    return this.view.webContents;
  }
```

with:

```ts
  private wc() {
    return this.view.webContents;
  }

  /** The content WebContents the adblock engine/counter binds to. */
  get contentWebContents(): Electron.WebContents {
    return this.view.webContents;
  }

  /** The content session ('persist:content') the adblock engine enables blocking on. */
  get contentSession(): Electron.Session {
    return this.view.webContents.session;
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/viewController.test.ts`
Expected: PASS — all `viewController.test.ts` tests green, including the two new getter tests.

- [ ] **Step 5: Commit**

```bash
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "feat(adblock): add ViewController contentSession/contentWebContents getters"
```

---

### Task 14: `AdblockController`

**Files:**
- Create: `electron/main/adblock/controller.ts`
- Test: `electron/main/adblock/controller.test.ts`

Pure-logic controller: reconcile (enable/disable per host), engine swap, `setEnabled`/`toggleAllowlist`/`getState`/`primeFor`/`setPendingBlocker`/`snapshotCount`/`isBlockingActive`. It binds to the content WC events `did-start-navigation` (gated on `isMainFrame && !isSameDocument`) and `did-stop-loading` per §8.12. Session-binding is exercised against an injected fake blocker whose `isBlockingEnabled`/`enableBlockingInSession`/`disableBlockingInSession` are spies; the real Electron session binding is covered by Block-E e2e. Per §8.2 the blocker is imported **type-only**; per §8.5 the controller exposes `snapshotCount(): BlockedCount`.

The reconcile rule (§4): `host = new URL(url).hostname`; `shouldBlock = repo.getState().enabled && !repo.isAllowlisted(host)`; enable if `shouldBlock && !isBlockingEnabled(session)`, disable (guarded) if `!shouldBlock && isBlockingEnabled(session)`. `getState()` composes `AdblockState` from the repo plus `counter.snapshot().session`. The injected `BlockedCounter`-shaped dep provides `attach`/`detach`/`resetPage`/`snapshot`.

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/adblock/controller.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import type { BlockedCount } from '../../../shared/types';
import { AdblockController } from './controller';

// ---- fakes (no live Electron / no real engine) ------------------------------

type Listener = (...args: any[]) => void;
function makeWc() {
  const listeners = new Map<string, Listener[]>();
  return {
    _emit(channel: string, ...args: any[]) {
      for (const l of listeners.get(channel) ?? []) l(...args);
    },
    on(channel: string, cb: Listener) {
      const arr = listeners.get(channel) ?? [];
      arr.push(cb);
      listeners.set(channel, arr);
      return this;
    },
  };
}

// A fake ElectronBlocker exposing only the methods the controller calls. Per-
// session enablement is tracked in a Set keyed by the session object.
function makeBlocker(name: string) {
  const enabled = new Set<object>();
  return {
    _name: name,
    enableBlockingInSession: vi.fn((session: object) => {
      enabled.add(session);
    }),
    disableBlockingInSession: vi.fn((session: object) => {
      if (!enabled.has(session)) throw new Error('Trying to disable blocking which was not enabled');
      enabled.delete(session);
    }),
    isBlockingEnabled: vi.fn((session: object) => enabled.has(session)),
  };
}

function makeCounter(initial: Partial<BlockedCount> = {}) {
  const snap: BlockedCount = {
    viewId: PRIMARY_VIEW_ID,
    page: initial.page ?? 0,
    session: initial.session ?? 0,
  };
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    resetPage: vi.fn(() => {
      snap.page = 0;
    }),
    snapshot: vi.fn((): BlockedCount => ({ ...snap })),
    _setSession: (n: number) => {
      snap.session = n;
    },
  };
}

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

function build(opts?: {
  repo?: ReturnType<typeof makeRepo>;
  counter?: ReturnType<typeof makeCounter>;
  blocker?: ReturnType<typeof makeBlocker>;
  session?: object;
  onBlockedCount?: ReturnType<typeof vi.fn>;
}) {
  const repo = opts?.repo ?? makeRepo({ enabled: true, allowlistedHosts: [] });
  const counter = opts?.counter ?? makeCounter();
  const blocker = opts?.blocker ?? makeBlocker('active');
  const session = opts?.session ?? {};
  const contentWc = makeWc();
  const onBlockedCount = opts?.onBlockedCount ?? vi.fn();
  const controller = new AdblockController({
    viewId: PRIMARY_VIEW_ID,
    session: session as any,
    contentWc: contentWc as any,
    repo: repo as any,
    blocker: blocker as any,
    counter: counter as any,
    onBlockedCount,
  });
  return { controller, repo, counter, blocker, session, contentWc, onBlockedCount };
}

describe('AdblockController construction', () => {
  it('attaches the counter to the initial blocker on construction', () => {
    const { counter, blocker } = build();
    expect(counter.attach).toHaveBeenCalledWith(blocker);
  });
});

describe('AdblockController.primeFor (first-nav reconcile)', () => {
  it('enables blocking for the first nav when enabled and host not allowlisted', () => {
    const { controller, blocker, session } = build();
    controller.primeFor('https://example.com/');
    expect(blocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(blocker.isBlockingEnabled(session)).toBe(true);
  });

  it('does NOT enable blocking when globally disabled', () => {
    const { controller, blocker, session } = build({
      repo: makeRepo({ enabled: false, allowlistedHosts: [] }),
    });
    controller.primeFor('https://example.com/');
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(false);
  });

  it('does NOT enable blocking when the host is allowlisted', () => {
    const { controller, blocker, session } = build({
      repo: makeRepo({ enabled: true, allowlistedHosts: ['example.com'] }),
    });
    controller.primeFor('https://example.com/path');
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(false);
  });
});

describe('AdblockController did-start-navigation reconcile gating', () => {
  it('reconciles + resets page on a main-frame, non-same-document navigation', () => {
    const { controller, contentWc, counter, blocker, session } = build();
    contentWc._emit('did-start-navigation', {
      url: 'https://example.com/',
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(blocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(counter.resetPage).toHaveBeenCalledTimes(1);
  });

  it('ignores sub-frame navigations (no reconcile, no resetPage)', () => {
    const { contentWc, counter, blocker } = build();
    contentWc._emit('did-start-navigation', {
      url: 'https://ads.example/',
      isMainFrame: false,
      isSameDocument: false,
    });
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(counter.resetPage).not.toHaveBeenCalled();
  });

  it('ignores same-document (SPA) navigations', () => {
    const { contentWc, counter, blocker } = build();
    contentWc._emit('did-start-navigation', {
      url: 'https://example.com/page2',
      isMainFrame: true,
      isSameDocument: true,
    });
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(counter.resetPage).not.toHaveBeenCalled();
  });
});

describe('AdblockController did-stop-loading push', () => {
  it('pushes the counter snapshot on did-stop-loading', () => {
    const counter = makeCounter({ page: 3, session: 11 });
    const onBlockedCount = vi.fn();
    const { contentWc } = build({ counter, onBlockedCount });
    contentWc._emit('did-stop-loading');
    expect(onBlockedCount).toHaveBeenCalledWith({ viewId: PRIMARY_VIEW_ID, page: 3, session: 11 });
  });
});

describe('AdblockController setEnabled / toggleAllowlist / getState', () => {
  it('setEnabled persists via repo and returns the new AdblockState', () => {
    const counter = makeCounter({ session: 7 });
    const { controller, repo } = build({ counter });
    const state = controller.setEnabled(false);
    expect(repo.setEnabled).toHaveBeenCalledWith(false);
    expect(state).toEqual({ enabled: false, allowlistedHosts: [], sessionBlocked: 7 });
  });

  it('setEnabled does NOT change session blocking until the next navigation', () => {
    const { controller, blocker, session } = build();
    controller.primeFor('https://example.com/'); // blocking on
    expect(blocker.isBlockingEnabled(session)).toBe(true);
    controller.setEnabled(false); // persisted, not applied yet
    expect(blocker.disableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(true);
    // next nav applies it
    blocker.disableBlockingInSession.mockClear();
    (controller as any).reconcile('https://example.com/');
    expect(blocker.disableBlockingInSession).toHaveBeenCalledWith(session);
    expect(blocker.isBlockingEnabled(session)).toBe(false);
  });

  it('toggleAllowlist persists via repo and returns the new AdblockState', () => {
    const counter = makeCounter({ session: 2 });
    const { controller, repo } = build({ counter });
    const state = controller.toggleAllowlist('example.com');
    expect(repo.toggleAllowlist).toHaveBeenCalledWith('example.com');
    expect(state).toEqual({
      enabled: true,
      allowlistedHosts: ['example.com'],
      sessionBlocked: 2,
    });
  });

  it('getState composes repo state with the live session count', () => {
    const counter = makeCounter({ session: 42 });
    const { controller } = build({
      counter,
      repo: makeRepo({ enabled: true, allowlistedHosts: ['x.test'] }),
    });
    expect(controller.getState()).toEqual({
      enabled: true,
      allowlistedHosts: ['x.test'],
      sessionBlocked: 42,
    });
  });

  it('snapshotCount returns the counter snapshot', () => {
    const counter = makeCounter({ page: 5, session: 9 });
    const { controller } = build({ counter });
    expect(controller.snapshotCount()).toEqual({ viewId: PRIMARY_VIEW_ID, page: 5, session: 9 });
  });

  it('isBlockingActive reflects whether the session has blocking enabled', () => {
    const { controller, session, blocker } = build();
    expect(controller.isBlockingActive()).toBe(false);
    controller.primeFor('https://example.com/');
    expect(controller.isBlockingActive()).toBe(true);
    expect(blocker.isBlockingEnabled(session)).toBe(true);
  });
});

describe('AdblockController engine swap', () => {
  it('on next nav: disables old (if enabled), detaches counter from old, attaches to new, then re-enables', () => {
    const oldBlocker = makeBlocker('old');
    const newBlocker = makeBlocker('new');
    const counter = makeCounter();
    const session = {};
    const { controller } = build({ blocker: oldBlocker, counter, session });
    controller.primeFor('https://example.com/'); // old enabled
    expect(oldBlocker.isBlockingEnabled(session)).toBe(true);
    counter.attach.mockClear();

    controller.setPendingBlocker(newBlocker as any);
    (controller as any).reconcile.mock; // no-op reference for clarity

    // simulate the next navigation boundary
    (controller.contentWc as any)._emit?.('did-start-navigation', {
      url: 'https://example.com/',
      isMainFrame: true,
      isSameDocument: false,
    });

    expect(oldBlocker.disableBlockingInSession).toHaveBeenCalledWith(session);
    expect(counter.detach).toHaveBeenCalledWith(oldBlocker);
    expect(counter.attach).toHaveBeenCalledWith(newBlocker);
    // after swap, reconcile re-enables on the NEW blocker
    expect(newBlocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(newBlocker.isBlockingEnabled(session)).toBe(true);
  });

  it('swap when old blocking was disabled does NOT call disableBlockingInSession (guard)', () => {
    const oldBlocker = makeBlocker('old');
    const newBlocker = makeBlocker('new');
    const counter = makeCounter();
    const { controller } = build({
      blocker: oldBlocker,
      counter,
      repo: makeRepo({ enabled: false, allowlistedHosts: [] }),
    });
    controller.primeFor('https://example.com/'); // disabled => never enabled
    controller.setPendingBlocker(newBlocker as any);
    (controller as any).swapPendingIfAny();
    expect(oldBlocker.disableBlockingInSession).not.toHaveBeenCalled();
    expect(counter.detach).toHaveBeenCalledWith(oldBlocker);
    expect(counter.attach).toHaveBeenCalledWith(newBlocker);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/adblock/controller.test.ts`
Expected: FAIL — `Error: Failed to resolve import "./controller"` / `AdblockController is not defined` (the module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/adblock/controller.ts
import type { Session, WebContents } from 'electron';
import type { ElectronBlocker } from '@ghostery/adblocker-electron';
import type { AdblockState, BlockedCount, ViewId } from '../../../shared/types';
import type { AdblockRepo } from '../db/adblockRepo';
import type { BlockedCounter } from './blockedCounter';

/**
 * Reconciles per-session blocking against the persisted enable/allowlist state at
 * the navigation boundary, swaps in a refreshed engine when one is pending, and
 * surfaces blocked counts. Pure logic over injected deps (no live Electron in
 * unit tests); real session binding is covered by Block-E e2e.
 */
export interface AdblockControllerOpts {
  viewId: ViewId;
  session: Session;
  contentWc: WebContents;
  repo: AdblockRepo;
  blocker: ElectronBlocker;
  counter: BlockedCounter;
  onBlockedCount: (c: BlockedCount) => void;
}

export class AdblockController {
  readonly contentWc: WebContents;
  private readonly opts: AdblockControllerOpts;
  private active: ElectronBlocker;
  private pending: ElectronBlocker | null = null;

  constructor(opts: AdblockControllerOpts) {
    this.opts = opts;
    this.contentWc = opts.contentWc;
    this.active = opts.blocker;
    this.opts.counter.attach(this.active);

    this.contentWc.on('did-start-navigation', (details: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.swapPendingIfAny();
      this.reconcile(details.url);
      this.opts.counter.resetPage();
    });

    this.contentWc.on('did-stop-loading', () => {
      this.opts.onBlockedCount(this.opts.counter.snapshot());
    });
  }

  /** Reconcile session enable/disable for the first nav (call BEFORE vc.navigate). */
  primeFor(firstUrl: string): void {
    this.reconcile(firstUrl);
  }

  setEnabled(enabled: boolean): AdblockState {
    this.opts.repo.setEnabled(enabled);
    return this.getState();
  }

  toggleAllowlist(host: string): AdblockState {
    this.opts.repo.toggleAllowlist(host);
    return this.getState();
  }

  getState(): AdblockState {
    const { enabled, allowlistedHosts } = this.opts.repo.getState();
    return { enabled, allowlistedHosts, sessionBlocked: this.opts.counter.snapshot().session };
  }

  /** Refresh produced a new engine; swap on the next navigation boundary. */
  setPendingBlocker(b: ElectronBlocker): void {
    this.pending = b;
  }

  snapshotCount(): BlockedCount {
    return this.opts.counter.snapshot();
  }

  /** True if blocking is currently enabled on the content session (e2e/readiness probe). */
  isBlockingActive(): boolean {
    return this.active.isBlockingEnabled(this.opts.session);
  }

  private swapPendingIfAny(): void {
    if (!this.pending) return;
    const old = this.active;
    if (old.isBlockingEnabled(this.opts.session)) {
      old.disableBlockingInSession(this.opts.session);
    }
    this.opts.counter.detach(old);
    this.active = this.pending;
    this.opts.counter.attach(this.active);
    this.pending = null;
  }

  private reconcile(url: string): void {
    const host = hostOf(url);
    const { enabled } = this.opts.repo.getState();
    const shouldBlock = enabled && !this.opts.repo.isAllowlisted(host);
    const isOn = this.active.isBlockingEnabled(this.opts.session);
    if (shouldBlock && !isOn) {
      this.active.enableBlockingInSession(this.opts.session);
    } else if (!shouldBlock && isOn) {
      this.active.disableBlockingInSession(this.opts.session);
    }
  }
}

/** hostname of a URL; '' if unparseable (treated as not-allowlisted). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/adblock/controller.test.ts`
Expected: PASS — all `controller.test.ts` tests green.

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/controller.ts electron/main/adblock/controller.test.ts
git commit -m "feat(adblock): AdblockController reconcile/swap/state over injected deps"
```

---

### Task 15: `ipc/adblock.ts` `buildAdblockHandlers`

**Files:**
- Create: `electron/main/ipc/adblock.ts`
- Test: `electron/main/ipc/adblock.test.ts`

Plain handler-map builder (same shape as `buildSettingsHandlers`): keys `IPC.adblockSetEnabled` → `c.setEnabled`, `IPC.adblockToggleAllowlist` → `c.toggleAllowlist`, `IPC.adblockGetState` → `c.getState`. The guard strips the event, so handlers receive only the invoke args. The new `IPC` channel constants come from the Task-3 (Block A) `shared/types.ts` additions; this task depends on them existing.

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/ipc/adblock.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { AdblockState } from '../../../shared/types';
import { buildAdblockHandlers } from './adblock';

function makeController(state: AdblockState) {
  return {
    setEnabled: vi.fn((enabled: boolean): AdblockState => ({ ...state, enabled })),
    toggleAllowlist: vi.fn((host: string): AdblockState => ({
      ...state,
      allowlistedHosts: [...state.allowlistedHosts, host],
    })),
    getState: vi.fn((): AdblockState => state),
  };
}

describe('buildAdblockHandlers', () => {
  const base: AdblockState = { enabled: true, allowlistedHosts: [], sessionBlocked: 5 };

  it('registers exactly the three adblock channels', () => {
    const handlers = buildAdblockHandlers(makeController(base) as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.adblockSetEnabled, IPC.adblockToggleAllowlist, IPC.adblockGetState].sort(),
    );
  });

  it('adblockSetEnabled forwards the flag to controller.setEnabled and returns the state', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockSetEnabled](false);
    expect(c.setEnabled).toHaveBeenCalledWith(false);
    expect(result).toEqual({ ...base, enabled: false });
  });

  it('adblockToggleAllowlist forwards the host and returns the new state', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockToggleAllowlist]('example.com');
    expect(c.toggleAllowlist).toHaveBeenCalledWith('example.com');
    expect(result.allowlistedHosts).toContain('example.com');
  });

  it('adblockGetState returns controller.getState()', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockGetState]();
    expect(c.getState).toHaveBeenCalledTimes(1);
    expect(result).toEqual(base);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/ipc/adblock.test.ts`
Expected: FAIL — `Error: Failed to resolve import "./adblock"` (module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/ipc/adblock.ts
import { IPC } from '../../../shared/types';
import type { AdblockState } from '../../../shared/types';
import type { AdblockController } from '../adblock/controller';

/**
 * Builds the adblock IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). setEnabled/toggleAllowlist
 * return the new AdblockState so the renderer syncs from the result.
 */
export function buildAdblockHandlers(
  c: AdblockController,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.adblockSetEnabled]: (enabled: boolean): AdblockState => c.setEnabled(enabled),
    [IPC.adblockToggleAllowlist]: (host: string): AdblockState => c.toggleAllowlist(host),
    [IPC.adblockGetState]: (): AdblockState => c.getState(),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/ipc/adblock.test.ts`
Expected: PASS — all four `adblock.test.ts` tests green.

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/adblock.ts electron/main/ipc/adblock.test.ts
git commit -m "feat(adblock): buildAdblockHandlers IPC map (setEnabled/toggleAllowlist/getState)"
```

---

### Task 16: `ipc/lists.ts` `buildListsHandlers`

**Files:**
- Create: `electron/main/ipc/lists.ts`
- Test: `electron/main/ipc/lists.test.ts`

A single-channel handler-map builder over an injected `updateNow: () => Promise<ListUpdateResult>` (boot supplies the canonical `runRefresh`-backed `updateNow` per §8.4 — never `triggerNow`). Key: `IPC.listsUpdateNow`.

- [ ] **Step 1: Write the failing test**

```ts
// electron/main/ipc/lists.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { ListUpdateResult } from '../../../shared/types';
import { buildListsHandlers } from './lists';

describe('buildListsHandlers', () => {
  it('registers exactly the listsUpdateNow channel', () => {
    const handlers = buildListsHandlers(async () => ({ perSource: [], lastUpdated: 0 }));
    expect(Object.keys(handlers)).toEqual([IPC.listsUpdateNow]);
  });

  it('listsUpdateNow invokes the injected updateNow and resolves its result', async () => {
    const result: ListUpdateResult = {
      perSource: [{ listId: 'easylist', ok: true }],
      lastUpdated: 1717977600000,
    };
    const updateNow = vi.fn(async () => result);
    const handlers = buildListsHandlers(updateNow);
    const out = await handlers[IPC.listsUpdateNow]();
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(out).toEqual(result);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/ipc/lists.test.ts`
Expected: FAIL — `Error: Failed to resolve import "./lists"` (module does not exist yet).

- [ ] **Step 3: Implement**

```ts
// electron/main/ipc/lists.ts
import { IPC } from '../../../shared/types';
import type { ListUpdateResult } from '../../../shared/types';

/**
 * Builds the lists IPC handler map (channel -> handler). updateNow is the boot-
 * supplied canonical refresh (runRefresh()) — a single-fire manual update that
 * returns the per-source result; it never re-enters the 24h scheduler.
 */
export function buildListsHandlers(
  updateNow: () => Promise<ListUpdateResult>,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.listsUpdateNow]: (): Promise<ListUpdateResult> => updateNow(),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/ipc/lists.test.ts`
Expected: PASS — both `lists.test.ts` tests green.

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/lists.ts electron/main/ipc/lists.test.ts
git commit -m "feat(adblock): buildListsHandlers IPC map (lists.updateNow)"
```

---

### Task 17: `chromePreload.ts` — add `adblock` / `lists` namespaces + `onBlockedCount`

**Files:**
- Modify: `electron/preload/chromePreload.ts:13-33` (extend the `api` object)
- Test: `electron/preload/chromePreload.test.ts` (extend the existing suite — real assertions, no placeholder anchors per §8.13)

The bridged API gains `adblock.setEnabled/toggleAllowlist/getState/onBlockedCount` and `lists.updateNow`, matching the §3 `AegisApi` additions (which Task 3 adds to `shared/types.ts`). `onBlockedCount` uses the existing `subscribe` helper over `IPC.evtAdblockBlockedCount` and returns an unsubscriber — same pattern as `onState`.

- [ ] **Step 1: Write the failing test**

Append this `describe` block to `electron/preload/chromePreload.test.ts` (it reuses the existing hoisted `h` mock and `import('./chromePreload')` pattern):

```ts
describe('chromePreload adblock + lists (Phase 1)', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  it('exposes adblock and lists namespaces', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.adblock.setEnabled).toBe('function');
    expect(typeof api.adblock.toggleAllowlist).toBe('function');
    expect(typeof api.adblock.getState).toBe('function');
    expect(typeof api.adblock.onBlockedCount).toBe('function');
    expect(typeof api.lists.updateNow).toBe('function');
  });

  it('adblock.setEnabled invokes IPC.adblockSetEnabled with the flag', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.adblock.setEnabled(false);
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockSetEnabled, false);
  });

  it('adblock.toggleAllowlist invokes IPC.adblockToggleAllowlist with the host', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.adblock.toggleAllowlist('example.com');
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockToggleAllowlist, 'example.com');
  });

  it('adblock.getState invokes IPC.adblockGetState and returns the resolved state', async () => {
    const state = { enabled: true, allowlistedHosts: ['x.test'], sessionBlocked: 9 };
    h.invoke = vi.fn(async () => state);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const result = await api.adblock.getState();
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockGetState);
    expect(result).toEqual(state);
  });

  it('lists.updateNow invokes IPC.listsUpdateNow and returns the resolved result', async () => {
    const res = { perSource: [{ listId: 'easylist', ok: true }], lastUpdated: 1 };
    h.invoke = vi.fn(async () => res);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.lists.updateNow();
    expect(h.invoke).toHaveBeenCalledWith(IPC.listsUpdateNow);
    expect(out).toEqual(res);
  });

  it('onBlockedCount registers on IPC.evtAdblockBlockedCount and delivers the payload', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    api.adblock.onBlockedCount(cb);
    const arr = h.listeners.get(IPC.evtAdblockBlockedCount)!;
    expect(arr).toHaveLength(1);
    const payload = { viewId: PRIMARY_VIEW_ID, page: 3, session: 12 };
    arr[0]({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('onBlockedCount returns an unsubscriber that removes the listener', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    const off = api.adblock.onBlockedCount(cb);
    const registered = h.listeners.get(IPC.evtAdblockBlockedCount)![0];
    off();
    expect(h.removed).toEqual([{ channel: IPC.evtAdblockBlockedCount, fn: registered }]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/preload/chromePreload.test.ts`
Expected: FAIL — the new tests fail with `api.adblock is undefined` (`Cannot read properties of undefined (reading 'setEnabled')`); the pre-existing nav/settings tests still pass.

- [ ] **Step 3: Implement**

Update the imports and the `api` object in `electron/preload/chromePreload.ts`. Replace the import of types on line 4:

```ts
import type { AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings } from '../../shared/types';
```

with:

```ts
import type {
  AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings,
  AdblockState, BlockedCount, ListUpdateResult,
} from '../../shared/types';
```

Then replace the closing of the `api` object — change:

```ts
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (partial: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, partial),
  },
};
```

with:

```ts
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
};
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/preload/chromePreload.test.ts`
Expected: PASS — all `chromePreload.test.ts` tests green (existing + the new adblock/lists block).

- [ ] **Step 5: Commit**

```bash
git add electron/preload/chromePreload.ts electron/preload/chromePreload.test.ts
git commit -m "feat(adblock): expose adblock/lists namespaces + onBlockedCount on window.aegis"
```

---

### Task 18: Boot wiring in `electron/main/index.ts`

**Files:**
- Modify: `electron/main/index.ts` (whole file — add adblock construction, prime-before-navigate, handler registration, `onBlockedCount` forwarder, `runRefresh`/scheduler after navigate, E2E env hooks + `__aegisTest.adblock`)

This wires the Block-A/B/C pieces into boot. Per §2 the adblock setup goes **after** `new ViewController(...)` and **before** `vc.navigate(...)`; the background refresh + 24 h scheduler go **after** navigate. Per §8.4 there is ONE canonical `runRefresh()`; the scheduler's `onTick` calls it and `updateNow = () => runRefresh()` — never `triggerNow().then(runRefresh)`. Per §8.7 the env hooks `AEGIS_ADBLOCK_TEST_FILTER` / `AEGIS_ADBLOCK_OFFLINE` / `AEGIS_ADBLOCK_LIST_BASE` are implemented, and the automatic first-run refresh kick is skipped when offline or a test filter is set (handlers + `updateNow` always registered). Per §8.6 the `__aegisTest` shape is exact. Per §8.1 the snapshot is read from `join(__dirname, 'adblock/seed/engine-seed.bin')` (the Vite plugin copies it there). Per §8.13 the background-refresh failure handler is concrete (`console.error`, non-fatal) with no dead code.

This is integration boot wiring exercised by Block-E Playwright e2e (Tasks 22-24); there is no standalone unit test for boot (it requires a live Electron runtime). Step 2/4 verify the build/typecheck compiles, and Block E asserts runtime behavior.

`runRefresh` builds `subs` and `resourcesUrl` from the `AEGIS_ADBLOCK_LIST_BASE` hook or the defaults, calls `fetchAll`, then — when at least one source returned usable text — `buildEngine` + `controller.setPendingBlocker` + `serializeEngine`, and returns `{ perSource, lastUpdated }`. `perSource` maps each `FetchedSource` to `{ listId, ok, error }`. The cache dir for raw lists is `join(userData, 'lists')`; the engine cache is `join(userData, 'engine.bin')`.

- [ ] **Step 1: Write the failing test**

No new unit test file — boot requires a live Electron runtime, so its behavior is asserted by the Block-E Playwright e2e (Tasks 22-24). The "failing" signal here is a TypeScript/build error before wiring exists. Confirm the current build fails to reference the not-yet-wired symbols only after we edit — so the failing-first check is the typecheck in Step 2 against the new code. (We write the implementation in Step 3 and verify it builds in Step 4; the runtime red/green is Block E.)

Run (baseline, must already pass before this task — proves we start from green): `npm run build`
Expected: PASS (Phase-0 boot compiles).

- [ ] **Step 2: Establish the red — show the failing reference**

Before wiring, a build that references the adblock modules would fail. To make the gap explicit, run the unit suites for the modules this task composes and confirm they are green (so the only thing left is the boot glue, verified by build in Step 4 and by Block E at runtime):

Run: `npx vitest run electron/main/adblock/controller.test.ts electron/main/ipc/adblock.test.ts electron/main/ipc/lists.test.ts`
Expected: PASS — the composed units are green; boot has not yet imported them (so the app does not yet enable blocking — Block E will observe `blockedCount === 0` without this wiring).

- [ ] **Step 3: Implement**

Replace the entire contents of `electron/main/index.ts` with:

```ts
import { app, dialog } from 'electron';
import { join } from 'node:path';
import type { NavState, ListUpdateResult, BlockedCount } from '../../shared/types';
import { IPC } from '../../shared/types';
import { createMainWindow, layout } from './window';
import { ViewController } from './viewController';
import { openDb, runMigrations } from './db/sqlite';
import { SettingsRepo } from './db/settingsRepo';
import { AdblockRepo } from './db/adblockRepo';
import { SubsRepo } from './db/subsRepo';
import { readLastSession, writeLastSession } from './session';
import { registerGuardedHandlers } from './ipc/guard';
import { buildNavHandlers, buildViewEventForwarders } from './ipc/nav';
import { buildSettingsHandlers } from './ipc/settings';
import { buildAdblockHandlers } from './ipc/adblock';
import { buildListsHandlers } from './ipc/lists';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import {
  buildEngine,
  loadCachedEngine,
  loadSnapshotEngine,
  serializeEngine,
  DEFAULT_LIST_URLS,
  RESOURCES_URL,
} from './adblock/engine';
import { fetchAll, RefreshScheduler } from './adblock/listManager';
import { BlockedCounter } from './adblock/blockedCounter';
import { AdblockController } from './adblock/controller';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 16 * 1024 * 1024;

/** Resolve the data dir: AEGIS_USER_DATA override (e2e isolation) or app userData. */
function resolveUserData(): string {
  return process.env.AEGIS_USER_DATA ?? app.getPath('userData');
}

function boot(): void {
  const userData = resolveUserData();

  // Persistence: DB + migrations + repos.
  const db = openDb(join(userData, 'aegis.db'));
  runMigrations(db);
  const settingsRepo = new SettingsRepo(db);
  const adblockRepo = new AdblockRepo(db);
  const subsRepo = new SubsRepo(db);
  subsRepo.seedDefaults(DEFAULT_LIST_URLS);

  // Window + chrome (window.ts owns the BaseWindow + chromeView ONLY).
  const { win, chromeView } = createMainWindow();
  const chromeWc = chromeView.webContents;

  // Main->chrome event forwarders.
  const fwd = buildViewEventForwarders(chromeWc);

  // onState wrapper: forward to chrome AND persist last session when the URL changes.
  let lastPersistedUrl: string | null = null;
  const onState = (s: NavState): void => {
    fwd.onState(s);
    if (s.url && s.url !== lastPersistedUrl) {
      lastPersistedUrl = s.url;
      writeLastSession(userData, { url: s.url, title: s.title });
    }
  };

  // The ONE content view is owned by ViewController.
  const contentPreloadPath = join(__dirname, '../preload/contentPreload.js');
  const vc = new ViewController({
    contentPreloadPath,
    onState,
    onFailed: fwd.onFailed,
    onCrashed: fwd.onCrashed,
  });

  // Compose: chrome added first by window.ts; index.ts adds the content view over it.
  win.contentView.addChildView(vc.view);
  layout(win, chromeView, vc.view);
  win.on('resize', () => layout(win, chromeView, vc.view));

  // ---- Adblock subsystem (after ViewController, BEFORE the first navigate) ----
  const cachePath = join(userData, 'engine.bin');
  const snapshotPath = join(__dirname, 'adblock/seed/engine-seed.bin');
  const listsCacheDir = join(userData, 'lists');

  // E2E determinism hooks.
  const TEST_FILTER = process.env.AEGIS_ADBLOCK_TEST_FILTER;
  const OFFLINE = process.env.AEGIS_ADBLOCK_OFFLINE === '1';
  const LIST_BASE = process.env.AEGIS_ADBLOCK_LIST_BASE;

  // Initial engine: deterministic test filter (e2e) | user cache | bundled snapshot | empty.
  // Track the source so e2e can assert first-run-on-seed deterministically (§8.4/§8.7).
  let initialBlocker: ElectronBlocker;
  let engineSource: 'filter' | 'cache' | 'snapshot' | 'built';
  if (TEST_FILTER) {
    initialBlocker = buildEngine([TEST_FILTER], null);
    engineSource = 'filter';
  } else {
    const cached = loadCachedEngine(cachePath);
    const snapshot = cached ? null : loadSnapshotEngine(snapshotPath);
    if (cached) {
      initialBlocker = cached;
      engineSource = 'cache';
    } else if (snapshot) {
      initialBlocker = snapshot;
      engineSource = 'snapshot';
    } else {
      initialBlocker = buildEngine([], null);
      engineSource = 'built';
    }
  }

  const counter = new BlockedCounter(vc.id);
  const onBlockedCount = (c: BlockedCount): void => chromeWc.send(IPC.evtAdblockBlockedCount, c);
  const controller = new AdblockController({
    viewId: vc.id,
    session: vc.contentSession,
    contentWc: vc.contentWebContents,
    repo: adblockRepo,
    blocker: initialBlocker,
    counter,
    onBlockedCount,
  });

  // Privileged IPC, sender-validated against the chrome WebContents id.
  // updateNow is the ONE canonical refresh (never triggerNow) — defined below.
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

  registerGuardedHandlers(chromeWc.id, {
    ...buildNavHandlers(vc, settingsRepo),
    ...buildSettingsHandlers(settingsRepo),
    ...buildAdblockHandlers(controller),
    ...buildListsHandlers(updateNow),
  });

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
    };
  }

  // Session restore on boot: last URL, else AEGIS_HOME_URL override (used by e2e to
  // avoid live network), else settings.homeUrl.
  const last = readLastSession(userData);
  const homeUrl = process.env.AEGIS_HOME_URL ?? settingsRepo.get().homeUrl;
  const firstUrl = last ? last.url : homeUrl;

  // Prime blocking for the first nav BEFORE navigating (engine-readiness gating).
  controller.primeFor(firstUrl);
  vc.navigate(firstUrl);

  // ---- Background refresh + 24h scheduler (AFTER navigate; non-blocking) ----
  // Skip the automatic first-run kick under deterministic e2e (offline / test filter);
  // handlers + updateNow are still registered so explicit calls work.
  const scheduler = new RefreshScheduler({
    intervalMs: REFRESH_INTERVAL_MS,
    onTick: () => runRefresh().then(() => {}),
  });
  if (!OFFLINE && !TEST_FILTER) {
    runRefresh().catch((err) => console.error('[adblock] background refresh failed', err));
  }
  scheduler.start();

  // Lifecycle cleanup: WebContentsView does not auto-destroy on BaseWindow close.
  win.on('closed', () => {
    scheduler.stop();
    vc.destroy();
    chromeWc.close();
  });
}

app.whenReady().then(() => {
  try {
    boot();
  } catch (err) {
    dialog.showErrorBox('Aegis failed to start', String(err instanceof Error ? err.stack ?? err.message : err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

Note: the `onBlockedCount` forwarder uses the `IPC.evtAdblockBlockedCount` constant (imported above), matching the `evtNav*` channels — no magic strings.

- [ ] **Step 4: Run the build, verify it compiles and passes**

Run: `npm run build`
Expected: PASS — the main bundle compiles (all adblock imports resolve, `vc.contentSession`/`vc.contentWebContents` exist from Task 13, the handler builders and `runRefresh`/scheduler typecheck). The `copySeedPlugin` (Task 1) copies the seed blob into `out/main/adblock/seed/engine-seed.bin`.

- [ ] **Step 5: Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(adblock): boot wiring — prime engine before first nav, IPC, refresh scheduler"
```

---

#### New names introduced (Block C)

- `ViewController.contentWebContents` (getter) — `electron/main/viewController.ts` (Task 13)
- `ViewController.contentSession` (getter) — `electron/main/viewController.ts` (Task 13)
- `AdblockControllerOpts` (interface, exported) — `electron/main/adblock/controller.ts` (Task 14; adds `counter: BlockedCounter` to the §4 opts shape so the controller takes an injected `BlockedCounter`, keeping it node-unit-testable)
- `AdblockController` (class, exported) — `electron/main/adblock/controller.ts` (Task 14)
- `AdblockController.contentWc` (public readonly field) — used by e2e/tests to emit nav events (Task 14)
- `AdblockController.snapshotCount(): BlockedCount` (method) — per §8.5 (Task 14)
- `hostOf(url: string): string` (module-local helper, NOT exported) — `electron/main/adblock/controller.ts` (Task 14)
- `buildAdblockHandlers(c: AdblockController): Record<string, (...a: any[]) => any>` (exported) — `electron/main/ipc/adblock.ts` (Task 15)
- `buildListsHandlers(updateNow: () => Promise<ListUpdateResult>): Record<string, (...a: any[]) => any>` (exported) — `electron/main/ipc/lists.ts` (Task 16)
- `api.adblock` / `api.lists` namespaces + `api.adblock.onBlockedCount` on the bridged `window.aegis` — `electron/preload/chromePreload.ts` (Task 17; matches the §3 `AegisApi` additions, no new exported symbol)
- Boot-local (NOT exported, all inside `boot()` in `electron/main/index.ts`, Task 18): `runRefresh(): Promise<ListUpdateResult>`, `updateNow: () => Promise<ListUpdateResult>`, `onBlockedCount`, `refreshFetch`, `refreshSubs`, `refreshResourcesUrl`, `scheduler`, and module-level constants `REFRESH_INTERVAL_MS`, `FETCH_TIMEOUT_MS`, `FETCH_MAX_BYTES`

I now have a complete picture of the conventions, the IPC ledger, the `useAdblock` signature, the `AdblockShield` requirements, the `Toolbar` shape, and the exact `App.test.tsx` mock to extend. I have everything needed to write Tasks 19-21.

Key facts I've verified:
- `aegis` is imported from `../lib/ipcClient` (mocked via `vi.mock('../lib/ipcClient', ...)`).
- `useAdblock(viewId, currentUrl)` signature from §4 ledger; returns `{ state, page, setEnabled, toggleAllowlist, updateNow }`; subscribes to `onBlockedCount`, seeds via `getState`; `setEnabled`/`toggleAllowlist` return new `AdblockState`; renderer derives host from `currentUrl` via `new URL(url).hostname`.
- `AegisApi.adblock` has `getState`, `setEnabled`, `toggleAllowlist`, `onBlockedCount`; `AegisApi.lists.updateNow`.
- `onBlockedCount` callback receives `BlockedCount { viewId, page, session }`; hook filters by `viewId`.
- Toolbar mounts the shield; App.test.tsx mock must be extended unconditionally (§8.8 exact shape).
- Dom test project name `dom`; run command `npx vitest run <file>`.
- a11y patterns: `useDialog` ref for popover focus/escape, `aria-label`, `role`.

Here are the expanded tasks.

---

### Task 19: `useAdblock` hook

**Files:**
- Create: `src/hooks/useAdblock.ts`
- Test: `src/hooks/useAdblock.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/hooks/useAdblock.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { AdblockState, BlockedCount, ListUpdateResult } from '../../shared/types';

const getState = vi.fn();
const setEnabled = vi.fn();
const toggleAllowlist = vi.fn();
const onBlockedCount = vi.fn();
const updateNow = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    adblock: {
      getState: (...a: any[]) => getState(...a),
      setEnabled: (...a: any[]) => setEnabled(...a),
      toggleAllowlist: (...a: any[]) => toggleAllowlist(...a),
      onBlockedCount: (cb: (c: BlockedCount) => void) => onBlockedCount(cb),
    },
    lists: { updateNow: (...a: any[]) => updateNow(...a) },
  },
}));

import { useAdblock } from './useAdblock';

const baseState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(baseState);
  setEnabled.mockResolvedValue({ ...baseState, enabled: false });
  toggleAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: ['example.com'] });
  onBlockedCount.mockReturnValue(() => {});
  updateNow.mockResolvedValue({ perSource: [], lastUpdated: 123 } as ListUpdateResult);
});

describe('useAdblock', () => {
  it('seeds state from aegis.adblock.getState on mount', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    expect(getState).toHaveBeenCalledTimes(1);
    expect(result.current.state.allowlistedHosts).toEqual([]);
  });

  it('subscribes to onBlockedCount and updates page for the matching viewId', async () => {
    let pushed: ((c: BlockedCount) => void) | undefined;
    onBlockedCount.mockImplementation((cb: (c: BlockedCount) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ viewId: PRIMARY_VIEW_ID, page: 7, session: 42 }));
    expect(result.current.page).toBe(7);
  });

  it('ignores onBlockedCount events for a different viewId', async () => {
    let pushed: ((c: BlockedCount) => void) | undefined;
    onBlockedCount.mockImplementation((cb: (c: BlockedCount) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ viewId: PRIMARY_VIEW_ID + 1, page: 7, session: 42 }));
    expect(result.current.page).toBe(0);
  });

  it('mirrors session count from onBlockedCount into state.sessionBlocked', async () => {
    let pushed: ((c: BlockedCount) => void) | undefined;
    onBlockedCount.mockImplementation((cb: (c: BlockedCount) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ viewId: PRIMARY_VIEW_ID, page: 3, session: 99 }));
    expect(result.current.state.sessionBlocked).toBe(99);
  });

  it('setEnabled calls aegis and syncs state from the returned AdblockState', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.setEnabled(false));
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(result.current.state.enabled).toBe(false);
  });

  it('toggleAllowlist derives the host from currentUrl and syncs returned state', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/page'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.toggleAllowlist());
    expect(toggleAllowlist).toHaveBeenCalledWith('example.com');
    expect(result.current.state.allowlistedHosts).toEqual(['example.com']);
  });

  it('toggleAllowlist is a no-op when currentUrl has no parseable host', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, ''));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.toggleAllowlist());
    expect(toggleAllowlist).not.toHaveBeenCalled();
  });

  it('updateNow delegates to aegis.lists.updateNow and returns its result', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    let res: ListUpdateResult | undefined;
    await act(async () => {
      res = await result.current.updateNow();
    });
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ perSource: [], lastUpdated: 123 });
  });

  it('unsubscribes from onBlockedCount on unmount', async () => {
    const unsubscribe = vi.fn();
    onBlockedCount.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(onBlockedCount).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/hooks/useAdblock.test.tsx`
Expected: FAIL — module resolution error `Failed to resolve import "./useAdblock"` / `Cannot find module './useAdblock'` (the hook does not exist yet).

- [ ] **Step 3: Implement**
```ts
// src/hooks/useAdblock.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdblockState, BlockedCount, ListUpdateResult, ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const emptyState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
};

/** Returns the parseable hostname of `url`, or null when `url` has no host. */
function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

export function useAdblock(
  viewId: ViewId,
  currentUrl: string,
): {
  state: AdblockState;
  page: number;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
  updateNow(): Promise<ListUpdateResult>;
} {
  const [state, setState] = useState<AdblockState>(emptyState);
  const [page, setPage] = useState<number>(0);

  // `currentUrl` is read at call time inside toggleAllowlist; keep a ref so the
  // callback identity stays stable across URL changes.
  const urlRef = useRef<string>(currentUrl);
  urlRef.current = currentUrl;

  useEffect(() => {
    let active = true;
    void aegis.adblock.getState().then((s) => {
      if (active) setState(s);
    });
    const unsubscribe = aegis.adblock.onBlockedCount((c: BlockedCount) => {
      if (c.viewId !== viewId) return;
      setPage(c.page);
      // Mirror the monotonic session total so the popover's "this session"
      // figure stays live without an extra getState round-trip.
      setState((prev) => (prev.sessionBlocked === c.session ? prev : { ...prev, sessionBlocked: c.session }));
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [viewId]);

  const setEnabled = useCallback((enabled: boolean) => {
    void aegis.adblock.setEnabled(enabled).then((s) => setState(s));
  }, []);

  const toggleAllowlist = useCallback(() => {
    const host = hostOf(urlRef.current);
    if (host === null) return;
    void aegis.adblock.toggleAllowlist(host).then((s) => setState(s));
  }, []);

  const updateNow = useCallback((): Promise<ListUpdateResult> => {
    return aegis.lists.updateNow();
  }, []);

  return { state, page, setEnabled, toggleAllowlist, updateNow };
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/hooks/useAdblock.test.tsx`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**
```bash
git add src/hooks/useAdblock.ts src/hooks/useAdblock.test.tsx
git commit -m "feat(adblock): useAdblock hook (getState seed, onBlockedCount, toggle/setEnabled/updateNow)"
```

---

### Task 20: `AdblockShield` component (badge + popover)

**Files:**
- Create: `src/components/AdblockShield.tsx`
- Test: `src/components/AdblockShield.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/components/AdblockShield.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdblockState } from '../../shared/types';
import { AdblockShield } from './AdblockShield';

const baseState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 487,
};

const props = (over: Partial<React.ComponentProps<typeof AdblockShield>> = {}) => ({
  state: baseState,
  page: 12,
  host: 'example.com',
  setEnabled: vi.fn(),
  toggleAllowlist: vi.fn(),
  ...over,
});

describe('AdblockShield', () => {
  it('renders the shield button showing the per-page blocked count', () => {
    render(<AdblockShield {...props()} />);
    const btn = screen.getByRole('button', { name: /ad blocking/i });
    expect(btn).toHaveTextContent('12');
  });

  it('the popover is closed until the shield button is clicked', () => {
    render(<AdblockShield {...props()} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the popover on click and exposes aria-expanded', async () => {
    render(<AdblockShield {...props()} />);
    const btn = screen.getByRole('button', { name: /ad blocking/i });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows page and session counts in the popover', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/blocked here/i)).toHaveTextContent('12');
    expect(within(dialog).getByText(/this session/i)).toHaveTextContent('487');
  });

  it('the global toggle reflects enabled and calls setEnabled(false) when on', async () => {
    const p = props();
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const toggle = screen.getByRole('switch', { name: /ad blocking/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(p.setEnabled).toHaveBeenCalledWith(false);
  });

  it('the global toggle calls setEnabled(true) when currently off', async () => {
    const p = props({ state: { ...baseState, enabled: false } });
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const toggle = screen.getByRole('switch', { name: /ad blocking/i });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(p.setEnabled).toHaveBeenCalledWith(true);
  });

  it('the allow-this-site checkbox reflects allowlist membership and calls toggleAllowlist', async () => {
    const p = props({ state: { ...baseState, allowlistedHosts: ['example.com'] } });
    render(<AdblockShield {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    const checkbox = screen.getByRole('checkbox', { name: /allow ads on example\.com/i });
    expect(checkbox).toBeChecked();
    await userEvent.click(checkbox);
    expect(p.toggleAllowlist).toHaveBeenCalledTimes(1);
  });

  it('the allow-this-site checkbox is unchecked when the host is not allowlisted', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    expect(screen.getByRole('checkbox', { name: /allow ads on example\.com/i })).not.toBeChecked();
  });

  it('surfaces an "applies on reload" affordance for next-nav semantics', async () => {
    render(<AdblockShield {...props()} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    expect(within(screen.getByRole('dialog')).getByText(/applies on reload/i)).toBeInTheDocument();
  });

  it('closes the popover on Escape and restores focus to the shield button', async () => {
    render(<AdblockShield {...props()} />);
    const btn = screen.getByRole('button', { name: /ad blocking/i });
    await userEvent.click(btn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(btn).toHaveFocus();
  });

  it('disables the allow-this-site checkbox when there is no host', async () => {
    render(<AdblockShield {...props({ host: null })} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    expect(screen.getByRole('checkbox', { name: /allow ads on this site/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/AdblockShield.test.tsx`
Expected: FAIL — `Failed to resolve import "./AdblockShield"` / `Cannot find module './AdblockShield'` (the component does not exist yet).

- [ ] **Step 3: Implement**
```tsx
// src/components/AdblockShield.tsx
import { useId, useState } from 'react';
import type { AdblockState } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';

export interface AdblockShieldProps {
  state: AdblockState;
  page: number;
  /** The current page's hostname, or null when the URL has no parseable host. */
  host: string | null;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
}

function Popover({
  state,
  page,
  host,
  setEnabled,
  toggleAllowlist,
  onClose,
}: AdblockShieldProps & { onClose: () => void }) {
  const labelId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const allowlisted = host !== null && state.allowlistedHosts.includes(host);
  const allowLabel = host ? `Allow ads on ${host}` : 'Allow ads on this site';

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelId}
      className="adblock-shield__popover"
    >
      <div className="adblock-shield__row">
        <span id={labelId} className="adblock-shield__title">
          Ad blocking
        </span>
        <label className="adblock-shield__switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Ad blocking"
            checked={state.enabled}
            onChange={() => setEnabled(!state.enabled)}
          />
        </label>
      </div>
      <hr className="adblock-shield__divider" />
      <label className="adblock-shield__row">
        <input
          type="checkbox"
          aria-label={allowLabel}
          checked={allowlisted}
          disabled={host === null}
          onChange={() => toggleAllowlist()}
        />
        <span>{allowLabel}</span>
      </label>
      <p className="adblock-shield__count">Blocked here: {page}</p>
      <p className="adblock-shield__count">Blocked this session: {state.sessionBlocked}</p>
      <p className="adblock-shield__hint">Changes apply on reload.</p>
    </div>
  );
}

export function AdblockShield(props: AdblockShieldProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="adblock-shield">
      <button
        type="button"
        className="adblock-shield__button"
        aria-label="Ad blocking"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true" className="adblock-shield__icon">
          {'\u{1F6E1}'}
        </span>
        <span className="adblock-shield__badge">{props.page}</span>
      </button>
      {open && <Popover {...props} onClose={() => setOpen(false)} />}
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/AdblockShield.test.tsx`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**
```bash
git add src/components/AdblockShield.tsx src/components/AdblockShield.test.tsx
git commit -m "feat(adblock): AdblockShield badge + popover (toggle, allowlist, counts, a11y)"
```

---

### Task 21: Wire `AdblockShield` into `Toolbar`

**Files:**
- Modify: `src/components/Toolbar.tsx:1-28`
- Modify: `src/components/Toolbar.test.tsx:8-25`
- Modify: `src/App.tsx:64-71`
- Modify: `src/App.test.tsx:32-57`
- Test: `src/components/Toolbar.test.tsx`, `src/App.test.tsx`

> Wiring uses the `useAdblock` hook (Task 19) inside `App` (where `useNav` already lives) and threads its values into `Toolbar`, which renders `AdblockShield` to the right of the `AddressBar`. `App.test.tsx`'s `ipcClient` mock must gain the `adblock`/`lists` namespaces unconditionally because `useAdblock` calls `getState`/`onBlockedCount` at mount (§8.8).

- [ ] **Step 1: Write the failing test**

First, extend `Toolbar.test.tsx` to assert the shield mounts and that the adblock props are threaded. Replace the `state`/`handlers` setup block and add shield assertions. Edit `src/components/Toolbar.test.tsx`:

First fold `AdblockState` into the existing type import on line 6 — change `import type { NavState } from '../../shared/types';` to `import type { NavState, AdblockState } from '../../shared/types';`.

Then replace lines 8-25 (the `state` const through the `handlers` factory) with:
```tsx
const state: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: true,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const adblockState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
};

const handlers = () => ({
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  reloadOrStop: vi.fn(),
  home: vi.fn(),
  adblock: {
    state: adblockState,
    page: 5,
    host: 'example.com',
    setEnabled: vi.fn(),
    toggleAllowlist: vi.fn(),
  },
});
```

Then append these two tests inside the `describe('Toolbar', ...)` block (before its closing `});`):
```tsx
  it('mounts the AdblockShield showing the per-page blocked count', () => {
    render(<Toolbar state={state} {...handlers()} />);
    expect(screen.getByRole('button', { name: /ad blocking/i })).toHaveTextContent('5');
  });

  it('opens the shield popover and toggles ad blocking', async () => {
    const h = handlers();
    render(<Toolbar state={state} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /ad blocking/i }));
    await userEvent.click(screen.getByRole('switch', { name: /ad blocking/i }));
    expect(h.adblock.setEnabled).toHaveBeenCalledWith(false);
  });
```

Next, extend `src/App.test.tsx` so its `ipcClient` mock includes the `adblock`/`lists` namespaces (`useAdblock` calls them at mount). Edit `src/App.test.tsx`. Replace the `view`/`settings` tail of the mock object (lines 54-56) so the closing of `aegis` includes the new namespaces:

Replace:
```tsx
    view: { setContentVisible: (...a: any[]) => setContentVisible(...a) },
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
  },
}));
```
with:
```tsx
    view: { setContentVisible: (...a: any[]) => setContentVisible(...a) },
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
    adblock: {
      getState: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      setEnabled: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      toggleAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      onBlockedCount: vi.fn().mockReturnValue(() => {}),
    },
    lists: { updateNow: vi.fn().mockResolvedValue({ perSource: [], lastUpdated: 0 }) },
  },
}));
```

Then add this test to `src/App.test.tsx` inside the `describe('App', ...)` block (before its closing `});`):
```tsx
  it('renders the AdblockShield in the toolbar', async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /ad blocking/i })).toBeInTheDocument(),
    );
  });
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/Toolbar.test.tsx src/App.test.tsx`
Expected: FAIL — `Toolbar.test.tsx` fails to type/render because `Toolbar` does not accept an `adblock` prop and renders no element with the accessible name `/ad blocking/i` (`Unable to find an accessible element with the role "button" and name /ad blocking/i`); `App.test.tsx`'s new test fails for the same missing shield button.

- [ ] **Step 3: Implement**

Edit `src/components/Toolbar.tsx` — add the `adblock` prop and render `AdblockShield`. Replace the whole file:
```tsx
// src/components/Toolbar.tsx
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
}

export function Toolbar({
  state,
  navigate,
  back,
  forward,
  reloadOrStop,
  home,
  adblock,
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
    </div>
  );
}
```

Edit `src/App.tsx` — call `useAdblock` and thread its values into `Toolbar`. Replace the whole file:
```tsx
// src/App.tsx
import { useEffect, useState } from 'react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavCrashed, NavFailed } from '../shared/types';
import { aegis } from './lib/ipcClient';
import { applyTheme } from './lib/theme';
import { useNav } from './hooks/useNav';
import { useAdblock } from './hooks/useAdblock';
import { Toolbar } from './components/Toolbar';
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
  const [failed, setFailed] = useState<NavFailed | null>(null);
  const [crashed, setCrashed] = useState<NavCrashed | null>(null);

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
      />
      <div id={CONTENT_ANCHOR_ID} className="content-anchor" tabIndex={-1} />
      <ErrorOverlay
        failed={failed}
        crashed={crashed}
        onRetry={handleRetry}
        onHome={handleHome}
      />
      <WelcomeHint />
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/Toolbar.test.tsx src/App.test.tsx`
Expected: PASS (Toolbar: 7 tests; App: 6 tests)

- [ ] **Step 5: Commit**
```bash
git add src/components/Toolbar.tsx src/components/Toolbar.test.tsx src/App.tsx src/App.test.tsx
git commit -m "feat(adblock): wire AdblockShield into Toolbar via useAdblock in App"
```

---

#### New names introduced (Block D)
- `useAdblock` — exported function, `src/hooks/useAdblock.ts` (signature per §4 ledger; local non-exported helper `hostOf`).
- `AdblockShield` — exported React component, `src/components/AdblockShield.tsx`.
- `AdblockShieldProps` — exported interface, `src/components/AdblockShield.tsx` (`{ state, page, host, setEnabled, toggleAllowlist }`). Local non-exported `Popover` component.
- `ToolbarAdblockProps` — exported interface, `src/components/Toolbar.tsx` (the `adblock` prop shape: `{ state, page, host, setEnabled, toggleAllowlist }`).
- `ToolbarProps.adblock` — new required field added to the existing exported `ToolbarProps` interface, `src/components/Toolbar.tsx`.
- Local non-exported `hostOf` helper in `src/App.tsx`.

I now have full grounding: the e2e launch pattern (`_electron.launch` with `args: ['out/main/index.js']` + `AEGIS_E2E='1'`, `AEGIS_USER_DATA`, env hooks), the `__aegisTest` shape from §8.6, the fixture server (root `electron/test/fixtures`, serves any file by extension, `.txt`/`.json` need MIME entries — `.txt` is missing so it falls through to `application/octet-stream`, which adblocker list-fetch tolerates), the `navigate`/`navigateAndSettle`/`state` helpers, and the `app.evaluate` bridge. I'll write Tasks 22-24 grounded in these exact patterns.

### Task 22: e2e — block-on-local-ad-fixture (deterministic test filter → blockedCount > 0 pushed to chrome)

**Files:**
- Create: `electron/test/fixtures/ad-page.html`
- Create: `electron/test/fixtures/ads/banner.js`
- Create: `electron/test/e2e/adblock.spec.ts`
- Test: `electron/test/e2e/adblock.spec.ts`

This task proves the real `ElectronBlocker`, bound to the content session via `AdblockController.primeFor`, blocks a sub-resource on a navigated page and that the per-page/session count is observable through the `__aegisTest.adblock.snapshotCount()` hook (§8.6) — the exact surface Block E consumes. The engine is the deterministic `AEGIS_ADBLOCK_TEST_FILTER` engine (§8.7), so no live network and no snapshot dependency.

- [ ] **Step 1: Write the failing test**

First create the two fixtures the test serves. The ad page requests a sub-resource at `/ads/banner.js`; the test filter `/ads/banner.js^` blocks exactly that request (a sub-resource, never the main frame — main frames are not filtered per §1).

`electron/test/fixtures/ad-page.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Ad Page Fixture</title>
  </head>
  <body>
    <main id="content" style="min-height: 200px">ad-page root</main>
    <!-- Sub-resource the seeded test filter (/ads/banner.js^) must block.
         When blocked, the script never runs and window.__adLoaded stays false. -->
    <script>
      window.__adLoaded = false;
    </script>
    <script src="/ads/banner.js"></script>
  </body>
</html>
```

`electron/test/fixtures/ads/banner.js`:
```js
// If this script is fetched and executed, the network filter did NOT block it.
// The adblock e2e asserts this side effect never happens on the ad page.
window.__adLoaded = true;
```

Now the spec. It launches with `AEGIS_ADBLOCK_TEST_FILTER` so the initial engine deterministically blocks `/ads/banner.js`:

`electron/test/e2e/adblock.spec.ts`:
```ts
// electron/test/e2e/adblock.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, BlockedCount } from '../../../shared/types';

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
      () =>
        app.evaluate(() => {
          const reg = (globalThis as any).__aegisTest;
          return reg?.primary ? reg.primary.getState().url : '';
        }),
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function state(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

function snapshotCount(app: ElectronApplication): Promise<BlockedCount> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.snapshotCount());
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

test('blocks a sub-resource matching the seeded test filter and reports blockedCount > 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-block-'));
  // Deterministic engine: block the ad sub-resource only (a network filter on a path).
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);

    // The blocked sub-resource never executed → the page's __adLoaded stays false.
    const adLoaded = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'window.__adLoaded',
        true,
      ),
    );
    expect(adLoaded).toBe(false);

    // The controller pushes the count on did-stop-loading; the snapshot must show a block.
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(0);

    const snap = await snapshotCount(app);
    expect(snap.viewId).toBe(1);
    expect(snap.page).toBeGreaterThan(0);
    expect(snap.session).toBeGreaterThanOrEqual(snap.page);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-page count resets on a new top-frame navigation; session stays monotonic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-reset-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    await expect
      .poll(async () => (await snapshotCount(app)).page, { timeout: 15000 })
      .toBeGreaterThan(0);
    const first = await snapshotCount(app);

    // Navigate to a clean page (no ad sub-resource): page resets to 0, session preserved.
    await navigateAndSettle(app, `${fixtures.baseUrl}/spa.html`);
    await expect
      .poll(async () => (await snapshotCount(app)).page, { timeout: 15000 })
      .toBe(0);
    expect((await snapshotCount(app)).session).toBe(first.session);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run build && npx playwright test electron/test/e2e/adblock.spec.ts`
Expected: FAIL — the app launches but `__aegisTest.adblock` is `undefined` (the Task-18 boot wiring and `AEGIS_ADBLOCK_TEST_FILTER` hook are not yet in the built `out/main/index.js`), so `snapshotCount(app)` throws `TypeError: Cannot read properties of undefined (reading 'snapshotCount')`. (If Block A–D and Task 18 are already implemented in the repo, this test instead drives the missing fixture files; create them in Step 3 either way.)

- [ ] **Step 3: Implement**

The fixtures shown in Step 1 ARE the implementation for this verification task (the engine/controller/boot wiring is delivered by Tasks 7/14/18; this task contributes the fixtures and the spec). Confirm both fixture files exist exactly as written in Step 1 and create the `ads/` subdirectory. The fixture server (`electron/test/e2e/fixtureServer.ts`) already serves any file under `electron/test/fixtures` by extension — `.js` maps to `text/javascript`, `.html` to `text/html` — so no server change is needed.

```bash
mkdir -p electron/test/fixtures/ads
```

No production-code change belongs to this task: the deterministic-engine hook (`AEGIS_ADBLOCK_TEST_FILTER`), the `controller.primeFor(firstUrl)` call, the `did-stop-loading` count push, and the `__aegisTest.adblock.snapshotCount` registry entry are all delivered by Task 18 per §8.6/§8.7. This task fails until those are present and passes once they are, which is the point of the regression-grade e2e.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run build && npx playwright test electron/test/e2e/adblock.spec.ts`
Expected: PASS — 2 tests green. `window.__adLoaded` is `false` (sub-resource blocked), `snapshotCount().session > 0` and `page > 0` on the ad page, and `page` resets to `0` while `session` is preserved after navigating to the clean `spa.html`.

- [ ] **Step 5: Commit**
```bash
git add electron/test/fixtures/ad-page.html electron/test/fixtures/ads/banner.js electron/test/e2e/adblock.spec.ts
git commit -m "test(adblock): e2e block-on-local-ad-fixture with deterministic test filter"
```

---

### Task 23: e2e — toggle + allowlist timing (off→no new blocks, allowlist→ads restored, all on next nav)

**Files:**
- Create: `electron/test/e2e/adblockToggle.spec.ts`
- Test: `electron/test/e2e/adblockToggle.spec.ts`

This task verifies the escape-hatch controls' "applies on next navigation, not mid-load" contract (spec §5, success criterion §13.3) against the REAL controller through the `__aegisTest.adblock` hooks (§8.6): `setEnabled`, `toggleAllowlist`, `getState`, `snapshotCount`. It uses the same deterministic `AEGIS_ADBLOCK_TEST_FILTER` engine so behavior is independent of live lists. The reconcile path being exercised is the §4 rule (`shouldBlock = enabled && !isAllowlisted(host)`) applied at the `did-start-navigation` boundary (§8.12), with the `disableBlockingInSession` guard from §1.

- [ ] **Step 1: Write the failing test**

`electron/test/e2e/adblockToggle.spec.ts`:
```ts
// electron/test/e2e/adblockToggle.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, BlockedCount, AdblockState } from '../../../shared/types';

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
      () =>
        app.evaluate(() => {
          const reg = (globalThis as any).__aegisTest;
          return reg?.primary ? reg.primary.getState().url : '';
        }),
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function state(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

function snapshotCount(app: ElectronApplication): Promise<BlockedCount> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.snapshotCount());
}

function setEnabled(app: ElectronApplication, enabled: boolean): Promise<AdblockState> {
  return app.evaluate(
    (_e, b) => (globalThis as any).__aegisTest.adblock.setEnabled(b),
    enabled,
  );
}

function toggleAllowlist(app: ElectronApplication, host: string): Promise<AdblockState> {
  return app.evaluate(
    (_e, h) => (globalThis as any).__aegisTest.adblock.toggleAllowlist(h),
    host,
  );
}

function adState(app: ElectronApplication): Promise<AdblockState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.getState());
}

function adLoaded(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
      'window.__adLoaded',
      true,
    ),
  );
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

test('global toggle off suppresses blocking on the next nav; re-enable restores it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-toggle-'));
  const adUrl = `${fixtures.baseUrl}/ad-page.html`;
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
  });
  try {
    // Baseline: blocking is on → the ad is blocked.
    await navigateAndSettle(app, adUrl);
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(await adLoaded(app)).toBe(false);
    const sessionAfterBlocked = (await snapshotCount(app)).session;

    // Turn blocking OFF — must NOT take effect mid-load; the current page is unchanged.
    const offState = await setEnabled(app, false);
    expect(offState.enabled).toBe(false);

    // Next navigation runs with blocking suppressed → the ad now loads, no NEW blocks.
    await navigateAndSettle(app, adUrl);
    expect(await adLoaded(app)).toBe(true);
    expect((await snapshotCount(app)).page).toBe(0);
    expect((await snapshotCount(app)).session).toBe(sessionAfterBlocked);

    // Re-enable → blocking returns on the NEXT navigation.
    const onState = await setEnabled(app, true);
    expect(onState.enabled).toBe(true);
    await navigateAndSettle(app, adUrl);
    expect(await adLoaded(app)).toBe(false);
    await expect
      .poll(async () => (await snapshotCount(app)).page, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect((await snapshotCount(app)).session).toBeGreaterThan(sessionAfterBlocked);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowlisting the host restores its ads on next load; un-allowlisting restores blocking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-allowlist-'));
  const adUrl = `${fixtures.baseUrl}/ad-page.html`;
  const host = new URL(adUrl).hostname; // 127.0.0.1
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
  });
  try {
    // Baseline: blocking on, host not allowlisted → ad blocked.
    await navigateAndSettle(app, adUrl);
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(await adLoaded(app)).toBe(false);
    const sessionBefore = (await snapshotCount(app)).session;

    // Allowlist the host. Global enable stays on; only this host is exempted.
    const allowed = await toggleAllowlist(app, host);
    expect(allowed.enabled).toBe(true);
    expect(allowed.allowlistedHosts).toContain(host);
    expect(await adState(app)).toMatchObject({ allowlistedHosts: [host] });

    // Next nav to the allowlisted host → ads restored, no new blocks.
    await navigateAndSettle(app, adUrl);
    expect(await adLoaded(app)).toBe(true);
    expect((await snapshotCount(app)).page).toBe(0);
    expect((await snapshotCount(app)).session).toBe(sessionBefore);

    // Un-allowlist (toggle again) → blocking restored on next load.
    const removed = await toggleAllowlist(app, host);
    expect(removed.allowlistedHosts).not.toContain(host);
    await navigateAndSettle(app, adUrl);
    expect(await adLoaded(app)).toBe(false);
    await expect
      .poll(async () => (await snapshotCount(app)).page, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect((await snapshotCount(app)).session).toBeGreaterThan(sessionBefore);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run build && npx playwright test electron/test/e2e/adblockToggle.spec.ts`
Expected: FAIL — before Task 18's boot wiring is built, `__aegisTest.adblock.setEnabled` is `undefined`, so the first `setEnabled(app, false)` call throws `TypeError: Cannot read properties of undefined (reading 'setEnabled')`. (If the controller reconcile/guard is implemented incorrectly — e.g. `disableBlockingInSession` called without the `isBlockingEnabled` guard — the failure instead surfaces as an uncaught `'Trying to disable blocking which was not enabled'` from the second nav, also failing the test.)

- [ ] **Step 3: Implement**

This is a pure verification task; its assertions drive correctness in already-skeletoned modules. The behavior under test is delivered entirely by prior tasks: `AdblockController.setEnabled`/`toggleAllowlist`/`getState` (Task 14, §4), the §8.12 `did-start-navigation` reconcile applying changes on the next nav, the §4 reconcile rule using `repo.getState().enabled && !repo.isAllowlisted(host)`, the `disableBlockingInSession` guard via `isBlockingEnabled` (§1), and the `__aegisTest.adblock` hooks (§8.6). It depends on the `ad-page.html` + `ads/banner.js` fixtures created in Task 22 (no new fixtures here). No new production or fixture code is introduced by this task — only the spec file from Step 1.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run build && npx playwright test electron/test/e2e/adblockToggle.spec.ts`
Expected: PASS — 2 tests green. With blocking off, `__adLoaded` becomes `true` and `session` is unchanged across the nav; re-enabling restores blocking on the next nav (`session` grows). Allowlisting `127.0.0.1` restores its ad while global `enabled` stays `true`; un-allowlisting restores blocking. No `'Trying to disable blocking which was not enabled'` error is thrown (proves the `isBlockingEnabled` guard).

- [ ] **Step 5: Commit**
```bash
git add electron/test/e2e/adblockToggle.spec.ts
git commit -m "test(adblock): e2e toggle/allowlist timing applies on next navigation"
```

---

### Task 24: e2e — first-run-on-seed + offline cache-fallback + real engine-swap on updateNow; then Phase-0 regression gate

**Files:**
- Create: `electron/test/fixtures/lists/easylist.txt` (and the other default-list `.txt` files served as a list base — see Step 3)
- Create: `electron/test/fixtures/lists/resources.json`
- Create: `electron/test/e2e/adblockLists.spec.ts`
- Test: `electron/test/e2e/adblockLists.spec.ts`

This task closes Block E with the three list-lifecycle behaviors (success criterion §13.2) and the regression gate (§13.7). Per §8.9 it includes the ONLINE-fixture REAL engine-swap test: launch with an initial `AEGIS_ADBLOCK_TEST_FILTER` engine that blocks ad A and an `AEGIS_ADBLOCK_LIST_BASE` pointing at the fixture server (whose served list blocks a DIFFERENT ad B); call the REAL `updateNow()` (real `fetch` → real second `ElectronBlocker` via `buildEngine` → `setPendingBlocker`), navigate to trigger the swap, and assert ad B is now blocked with no throw — exercising the real swap + re-enable + counter re-attach (§4 swap rule, §8.4 single-fire `runRefresh`). The offline test uses `AEGIS_ADBLOCK_OFFLINE` (§8.7) to force cache-fallback.

- [ ] **Step 1: Write the failing test**

First the served list fixtures. The list base serves one file per `DEFAULT_LIST_URLS` `listId` as `${base}/${listId}.txt` plus `${base}/resources.json` (§8.7). The boot maps every default `listId` to a `${base}/<listId>.txt` URL, so EVERY default `listId` must resolve to a file; to avoid coupling the test to the exact 14-list set, the fixture server returns the SAME list body for any `lists/*.txt` request via a dedicated handler added in Step 3. The list body blocks ad B (`/ads/tracker.js^`):

`electron/test/fixtures/lists/easylist.txt` (canonical body; the Step-3 server alias makes every `lists/<id>.txt` return this content):
```text
! Title: Aegis e2e fixture list
! Blocks the ONLINE-fixture ad B sub-resource for the engine-swap test.
/ads/tracker.js^
```

`electron/test/fixtures/lists/resources.json` (source-verified shape: `Resources.parse` reads top-level `scriptlets[]` / `redirects[]`; this empty-but-valid payload is parsed by `updateResources` without throwing — see Task 7 §8.2):
```json
{
  "scriptlets": [],
  "redirects": []
}
```

Now the second served ad page (ad B) and its sub-resource. The initial test-filter engine blocks `/ads/banner.js` (ad A) but NOT `/ads/tracker.js` (ad B); the refreshed engine from the fixture list blocks `/ads/tracker.js` (ad B).

`electron/test/fixtures/ad-page-b.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Ad Page B Fixture</title>
  </head>
  <body>
    <main id="content" style="min-height: 200px">ad-page-b root</main>
    <!-- Sub-resource blocked ONLY by the refreshed (fixture-list) engine: /ads/tracker.js^ -->
    <script>
      window.__trackerLoaded = false;
    </script>
    <script src="/ads/tracker.js"></script>
  </body>
</html>
```

`electron/test/fixtures/ads/tracker.js`:
```js
// If fetched/executed, ad B was NOT blocked. The swap test asserts this stays false
// after the refreshed engine (which blocks /ads/tracker.js) takes effect.
window.__trackerLoaded = true;
```

Now the spec:

`electron/test/e2e/adblockLists.spec.ts`:
```ts
// electron/test/e2e/adblockLists.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, BlockedCount, ListUpdateResult } from '../../../shared/types';

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
      () =>
        app.evaluate(() => {
          const reg = (globalThis as any).__aegisTest;
          return reg?.primary ? reg.primary.getState().url : '';
        }),
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function state(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

function snapshotCount(app: ElectronApplication): Promise<BlockedCount> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.snapshotCount());
}

function updateNow(app: ElectronApplication): Promise<ListUpdateResult> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.updateNow());
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

test('first run loads the bundled snapshot with blocking active (no cache, offline)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-seed-'));
  // No AEGIS_ADBLOCK_TEST_FILTER and no prior cache → boot MUST load the bundled
  // snapshot engine (not a built-empty one). OFFLINE skips the background refresh
  // kick so the snapshot stays the active engine — fully hermetic.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_OFFLINE: '1',
  });
  try {
    // Deterministic — decoupled from uncertain EasyList localhost path matching:
    // (1) the engine came from the bundled snapshot (proves never-zero first-run,
    // §13.2); (2) blocking is enabled on the content session after the first nav
    // (proves engine-readiness gating, §13.4 / §13.6 — the preload path resolved).
    const engineSource = await app.evaluate(
      () => (globalThis as any).__aegisTest.adblock.engineSource,
    );
    expect(engineSource).toBe('snapshot');

    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    const active = await app.evaluate(
      () => (globalThis as any).__aegisTest.adblock.isBlockingActive(),
    );
    expect(active).toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline updateNow falls back to cache and every source reports ok:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-offline-'));
  // Deterministic initial engine (so blocking is live independent of the seed), and
  // OFFLINE so refreshFetch rejects → fetchAll's per-source try fails → cache-fallback.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
    AEGIS_ADBLOCK_OFFLINE: '1',
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    // Blocking still works offline (initial engine is live).
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(0);

    // Manual update while offline: must resolve (never throw), every source ok:false.
    const result = await updateNow(app);
    expect(Array.isArray(result.perSource)).toBe(true);
    expect(result.perSource.length).toBeGreaterThan(0);
    expect(result.perSource.every((s) => s.ok === false)).toBe(true);
    expect(typeof result.lastUpdated).toBe('number');

    // App keeps blocking after the failed refresh (initial engine untouched).
    const before = (await snapshotCount(app)).session;
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    expect((await snapshotCount(app)).session).toBeGreaterThan(before);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real engine swap: updateNow fetches the fixture list, swaps, and blocks the new ad B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-swap-'));
  // Initial engine blocks ad A (/ads/banner.js) only; the fixture list (served at
  // AEGIS_ADBLOCK_LIST_BASE) blocks ad B (/ads/tracker.js). updateNow does a REAL fetch
  // from the fixture server, builds a REAL second ElectronBlocker, and stages it for swap.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
    AEGIS_ADBLOCK_LIST_BASE: `${fixtures.baseUrl}/lists`,
  });
  try {
    // Pre-swap: ad B is NOT yet blocked by the initial (banner-only) engine.
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(true);
    const sessionBeforeSwap = (await snapshotCount(app)).session;

    // Real refresh: fetch the fixture list over the network and stage the new engine.
    const result = await updateNow(app);
    expect(result.perSource.length).toBeGreaterThan(0);
    expect(result.perSource.every((s) => s.ok === true)).toBe(true);
    expect(typeof result.lastUpdated).toBe('number');

    // The swap is applied at the next navigation boundary (§4/§8.12).
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(false); // ad B now blocked
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(sessionBeforeSwap);

    // The swap re-enabled blocking + re-attached the counter against the REAL new engine;
    // a follow-up nav still works (no detached-listener / disable-throw regression).
    const afterSwap = (await snapshotCount(app)).session;
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect((await snapshotCount(app)).session).toBeGreaterThan(afterSwap);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run build && npx playwright test electron/test/e2e/adblockLists.spec.ts`
Expected: FAIL — before the fixture aliasing (Step 3) and the built Task-18 boot wiring exist: the `lists/<id>.txt` requests 404 (so the swap test's `perSource.every(ok===true)` is false), and `__aegisTest.adblock.updateNow` is `undefined` (so `updateNow(app)` throws `TypeError`). The first-run-on-seed test also fails if the committed snapshot blob is missing or not copied into `out/main/adblock/seed/` (§8.1).

- [ ] **Step 3: Implement**

3a. Create the served list/resources/ad-B fixtures shown in Step 1 (the `.txt` list, `resources.json`, `ad-page-b.html`, `ads/tracker.js`).

3b. The fixture server must (i) return a `text/plain` MIME for `.txt` and (ii) alias every `lists/<anything>.txt` request to the single canonical list body, so the boot's `DEFAULT_LIST_URLS`→`${base}/<listId>.txt` mapping resolves for ALL default `listId`s without committing 14 identical files. Add the alias + MIME entry to `electron/test/e2e/fixtureServer.ts`. Show the full edited `serveFile` + `MIME` (the rest of the file is unchanged):

```ts
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // Strip any leading slash, normalize, and reject path traversal.
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  // Adblock e2e: alias every lists/<id>.txt to the single canonical fixture list so the
  // boot's DEFAULT_LIST_URLS -> `${base}/<listId>.txt` mapping resolves for all listIds.
  const resolvedRel =
    /^lists\/[^/]+\.txt$/.test(rel) ? 'lists/easylist.txt' : (rel || 'index.html');
  const filePath = join(FIXTURE_ROOT, resolvedRel);
  if (!filePath.startsWith(FIXTURE_ROOT)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}
```

This alias is additive and used ONLY by paths under `lists/`; all existing fixtures (`spa.html`, `late-title.html`, `crash.html`, `ad-page.html`, `ad-page-b.html`, `ads/*.js`) are unaffected because they don't match `^lists\/[^/]+\.txt$`. The `resources.json` request (`lists/resources.json`) does NOT match the alias regex (extension `.json`, not `.txt`), so it serves the real `lists/resources.json` file.

3c. No production-code change belongs to this task. First-run-on-seed depends on the committed snapshot (Task 2) being copied to `out/main/adblock/seed/engine-seed.bin` by the §8.1 Vite plugin (Task 1) and `loadSnapshotEngine` reading `join(__dirname, 'adblock/seed/engine-seed.bin')` (Task 18). Offline cache-fallback depends on the `AEGIS_ADBLOCK_OFFLINE` hook and `fetchAll`'s per-source cache-fallback (Tasks 10/18, §8.7). The real swap depends on `runRefresh` → `buildEngine` → `controller.setPendingBlocker` + the §4 swap-on-nav rule and the `AEGIS_ADBLOCK_LIST_BASE` hook (Tasks 7/14/18, §8.4/§8.7/§8.9). This task supplies fixtures, the server alias, and the spec.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run build && npx playwright test electron/test/e2e/adblockLists.spec.ts`
Expected: PASS — 3 tests green. First-run-on-seed: `engineSource === 'snapshot'` (the bundled blob loaded with no cache and no network) and `isBlockingActive() === true` after the first nav. Offline: `updateNow()` resolves with every `perSource.ok === false` and blocking survives. Real swap: pre-swap `__trackerLoaded === true`; `updateNow()` returns `perSource` all `ok === true`; post-swap-nav `__trackerLoaded === false` and `session` grows; a second post-swap nav still increments `session` (no detach/disable regression).

- [ ] **Step 5: Run the full Phase-0 regression gate, then commit**

Run the complete suites and confirm green BEFORE committing (success criterion §13.7). Quote the real tail of each run.

Run: `npm test`
Expected: PASS — all unit/component tests green (the Phase-0 177 plus every Phase-1 unit/component test added in Blocks A–D; 0 failures).

Run: `npm run test:e2e`
Expected: PASS — all Playwright specs green: the Phase-0 specs (`boot`, `nav`, `sandbox`, `chromeLockdown`, `window`) AND the three new adblock specs (`adblock`, `adblockToggle`, `adblockLists`); 0 failures.

If either suite reports any failure, STOP and fix the offending task before committing — do not commit a red gate.

```bash
git add electron/test/fixtures/lists/easylist.txt electron/test/fixtures/lists/resources.json electron/test/fixtures/ad-page-b.html electron/test/fixtures/ads/tracker.js electron/test/e2e/fixtureServer.ts electron/test/e2e/adblockLists.spec.ts
git commit -m "test(adblock): e2e first-run-seed + offline fallback + real engine-swap; pass Phase-0 regression gate"
```

---

#### New names introduced (Block E)

- `electron/test/fixtures/ad-page.html` — fixture page requesting the ad-A sub-resource `/ads/banner.js`; exposes `window.__adLoaded` (Task 22).
- `electron/test/fixtures/ads/banner.js` — ad-A sub-resource; sets `window.__adLoaded = true` when not blocked (Task 22).
- `electron/test/e2e/adblock.spec.ts` — Task 22 spec (block-on-fixture; per-page reset / monotonic session).
- `electron/test/e2e/adblockToggle.spec.ts` — Task 23 spec (global toggle + allowlist timing).
- `electron/test/fixtures/ad-page-b.html` — fixture page requesting the ad-B sub-resource `/ads/tracker.js`; exposes `window.__trackerLoaded` (Task 24).
- `electron/test/fixtures/ads/tracker.js` — ad-B sub-resource; sets `window.__trackerLoaded = true` when not blocked (Task 24).
- `electron/test/fixtures/lists/easylist.txt` — canonical fixture filter list body (`/ads/tracker.js^`) served for every `lists/<id>.txt` request via the server alias (Task 24).
- `electron/test/fixtures/lists/resources.json` — minimal valid uBO resources document served at `${base}/resources.json` (Task 24).
- `electron/test/e2e/adblockLists.spec.ts` — Task 24 spec (first-run-seed, offline fallback, real engine-swap).
- `resolvedRel` (local const in `serveFile`, `electron/test/e2e/fixtureServer.ts`) — `lists/<id>.txt`→`lists/easylist.txt` alias; plus added `'.txt'` MIME entry (Task 24).

No new exported runtime symbols are introduced by Block E (all production exports come from Blocks A–D); Block E adds only e2e specs, in-repo fixtures, and the additive fixture-server alias/MIME edit.
