# Aegis Security Phase 3a — HTTPS-Only + Safety-Interstitial Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade top-level `http:` navigations to `https:` (default on), and when the HTTPS load fails, show a full-window interstitial with a remembered per-site "Continue to HTTP" — built on a reusable safety-interstitial framework that Phase 3b's malicious-site warning will extend.

**Architecture:** A pure `upgradeUrl()` helper decides the http→https rewrite. A main-side `SafetyController` owns the upgrade entry point, the `did-fail-load`→interstitial decision, the persisted `HttpExceptionsRepo`, and the `safety.*` guarded IPC. The interstitial is plain React DOM rendered inside the already-elevated transparent chrome `WebContentsView` (registered in App's `chromeOverlayActive` union — the documented overlay gotcha). A new `httpsOnly` Setting (default `true`) gates it, exposed in a new "Security" Settings tab.

**Tech Stack:** Electron 42 (`WebContentsView`, `will-navigate`/`did-fail-load`), React 19 + contextBridge IPC, better-sqlite3, Vitest (node + jsdom), Playwright e2e.

**Branch:** Execute on `feat/security-phase3a` cut from `main` (do NOT commit to `main`; no push/branch/rename beyond this branch).

**Scope note:** This is Phase **3a** of the spec's Phase 3 (`docs/superpowers/specs/2026-06-12-aegis-security-upgrades-design.md` §3.3). It delivers HTTPS-Only + the shared interstitial. Phase **3b** (malicious-site `MalwareGuard`) is a separate later plan that reuses the `SafetyController` / interstitial built here — hence the extensible `reason` field and the generic naming.

---

## Verified grounding (from live source — do not re-derive)

- **Nav gate** `electron/main/viewController.ts:115-119`: `const gate = (event, url) => { if (!isAllowedNavigationUrl(url)) event.preventDefault(); }; wc.on('will-navigate', gate); wc.on('will-redirect', gate);`.
- **`navigate()`** `viewController.ts:203-217`: guards scheme via `isAllowedNavigationUrl` (fires `onFailed` + returns if blocked), else `this.wc().loadURL(url)`. No normalization.
- **`did-fail-load`** `viewController.ts:121-144`: main-frame only, ignores `-3` (ERR_ABORTED), classifies `kind: 'cert'` for `-300 < code <= -200` else `'load'`, hides view, calls `this.opts.onFailed({ viewId, errorCode, errorDescription, validatedURL, kind })`.
- **`isAllowedNavigationUrl`** `electron/lib/schemes.ts:16-25` + **`ALLOWED_NAV_SCHEMES = ['https:', 'http:']`** `shared/types.ts:5`. **KEEP `http:` allowed** — server-side redirects step through `http:`, and the "continue to HTTP" fallback needs it.
- **ViewController** is `export class ViewController` (named); constructed `index.ts:121-126` with `{ contentPreloadPath, onState, onFailed, onCrashed }`; `ViewControllerOpts` is exported (imported in `ipc/nav.ts`). First nav: `index.ts:~389 vc.navigate(firstUrl)`.
- **Nav IPC** `electron/main/ipc/nav.ts:12-25`: `buildNavHandlers(vc, settingsRepo)`; `[IPC.navNavigate]: (_v, url) => vc.navigate(url)`, `[IPC.navHome]: (_v) => vc.navigate(settingsRepo.get().homeUrl)`. `onFailed` forwarder `ipc/nav.ts:40`: `(f) => chromeWc.send(IPC.evtNavFailed, f)`.
- **Guarded IPC** `electron/main/ipc/guard.ts`: `registerGuardedHandlers(chromeWebContentsId, handlers)` throws on `event.sender.id !== chromeWebContentsId`. Handler map spread at `index.ts:313-329`. Event send pattern: `chromeWc.send(IPC.evtUpdateState, s)` (`index.ts:103`).
- **`update` namespace template** — `shared/types.ts`: IPC consts `updateGetState:'update.getState'` etc. + `evtUpdateState:'update.state'`; `AegisApi.update` block. `chromePreload.ts`: `subscribe<T>(channel, cb)` helper (lines 12-16) + the `update` contextBridge block (129-134). Renderer: `src/hooks/useUpdate.ts` (initial `getState()` with `active` guard + `onState` subscribe) and `src/components/UpdateIndicator.tsx` (pure, returns `null` when inactive). Renderer IPC client: `import { aegis } from '../lib/ipcClient'`.
- **Overlay gotcha** `src/App.tsx:86-93`: `const chromeOverlayActive = sidebarOpen || downloadsOpen || settingsOpen || managerOpen || permissions.prompt !== null || failed !== null || crashed !== null;` then effect `index.ts`-side z-swap. The interstitial is NOT a new view — it's DOM in the chrome renderer; it only needs (a) a new `|| interstitial !== null` term in this union, (b) the component rendered in the tree.
- **Settings** `shared/types.ts:207-215` `interface Settings { siteName; homeUrl; primaryColor; defaultSearchTemplate; searchEngines; hideChromeByDefault; downloadDir }`. `electron/main/db/settingsRepo.ts` `DEFAULT_SETTINGS` + generic key-value upsert (`set(partial)`); `electron/main/ipc/settings.ts` `settingsGet`/`settingsSet`. Renderer reads via `aegis.settings.get()/set()`. **Adding a Setting = add to `Settings` + `DEFAULT_SETTINGS`; the store is generic.**
- **Settings UI** `src/components/SettingsModal.tsx`: `type SettingsTab = 'appearance'|'search'|'home'|'filterLists'|'myFilters'|'allowlist'|'downloads'|'sitePermissions'|'data'`; `TAB_LABELS`, `TAB_ORDER`; each tab a component taking `settings`+`update`; wired from `App.tsx`.
- **DB** `electron/main/db/sqlite.ts`: `openDb(path)` (WAL + FK on); `runMigrations(db)` = single idempotent `db.exec(...)` block of `CREATE TABLE IF NOT EXISTS` (lines 20-97), no versioning. Repo template: `electron/main/db/permissionsRepo.ts` (`private readonly` prepared stmts, `@named` binds, `constructor(private readonly db: Database.Database)`), test template `permissionsRepo.test.ts` (`openDb(':memory:')` + `runMigrations` in `beforeEach`, `db.close()` in `afterEach`). Repos constructed in `index.ts` boot as `new XRepo(db)`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `electron/main/safety/httpsUpgrade.ts` (create) | Pure `upgradeUrl(url, {httpsOnly, isException})` → upgraded https URL or `null`. |
| `electron/main/safety/SafetyController.ts` (create) | Upgrade entry point, `did-fail-load`→interstitial, exceptions, `proceed`/`getState`. |
| `electron/main/db/httpExceptionsRepo.ts` (create) | `http_exceptions` repo: `has/add/remove/list`. |
| `electron/main/ipc/safety.ts` (create) | `buildSafetyHandlers(safety)` guarded IPC map. |
| `electron/main/db/sqlite.ts` (modify) | Add `http_exceptions` table to the migration block. |
| `electron/main/viewController.ts` (modify) | Add `upgradeNavigation?` opt; use it in the nav gate. |
| `electron/main/ipc/nav.ts` (modify) | Route `navNavigate`/`navHome` through `safety.navigate`. |
| `electron/main/index.ts` (modify) | Construct repo + `SafetyController`; compose `onFailed`; register handlers; first-nav via safety. |
| `shared/types.ts` (modify) | `safety.*` IPC consts, `SafetyInterstitialPayload`, `AegisApi.safety`, `Settings.httpsOnly`. |
| `electron/main/db/settingsRepo.ts` (modify) | `httpsOnly: true` default. |
| `electron/preload/chromePreload.ts` (modify) | Expose `safety` namespace. |
| `src/hooks/useSafety.ts` (create) | Hook: hydrate `getState` + subscribe `onInterstitial`. |
| `src/components/SafetyInterstitial.tsx` (create) | Full-window interstitial (null when inactive). |
| `src/components/SecurityTab.tsx` (create) | Settings tab: HTTPS-Only toggle + exceptions list. |
| `src/index.css` (modify) | `.interstitial` overlay styles. |
| `src/App.tsx` (modify) | `useSafety()`, union term, render interstitial, wire Security tab. |
| `src/components/SettingsModal.tsx` (modify) | Add `'security'` tab. |
| `electron/test/e2e/*` (create) | e2e: upgrade + interstitial + persistence. |

## Out of scope for 3a (documented)
- **Malicious-site `MalwareGuard`** — Phase 3b (reuses this `SafetyController`/interstitial via a `'malware'` `reason`).
- **Subresource HTTPS upgrade** — spec locked to top-level only (Chromium handles active mixed content).

---

## Task 1: Pure `upgradeUrl` helper

**Files:** Create `electron/main/safety/httpsUpgrade.ts`; Test `electron/main/safety/httpsUpgrade.test.ts`.

- [ ] **Step 1: Write the failing test** — `electron/main/safety/httpsUpgrade.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { upgradeUrl } from './httpsUpgrade';

const never = () => false;

describe('upgradeUrl', () => {
  it('upgrades a plain http URL to https, preserving path/query/hash', () => {
    expect(upgradeUrl('http://example.com/a/b?q=1#h', { httpsOnly: true, isException: never })).toBe(
      'https://example.com/a/b?q=1#h',
    );
  });

  it('returns null for an https URL (nothing to do)', () => {
    expect(upgradeUrl('https://example.com/', { httpsOnly: true, isException: never })).toBeNull();
  });

  it('returns null when httpsOnly is off', () => {
    expect(upgradeUrl('http://example.com/', { httpsOnly: false, isException: never })).toBeNull();
  });

  it('returns null when the host is an exception', () => {
    const isException = (h: string) => h === 'example.com';
    expect(upgradeUrl('http://example.com/', { httpsOnly: true, isException })).toBeNull();
  });

  it('upgrades a non-exception host even when another host is excepted', () => {
    const isException = (h: string) => h === 'other.com';
    expect(upgradeUrl('http://example.com/', { httpsOnly: true, isException })).toBe('https://example.com/');
  });

  it('returns null for non-http(s) schemes', () => {
    expect(upgradeUrl('about:blank', { httpsOnly: true, isException: never })).toBeNull();
    expect(upgradeUrl('file:///x', { httpsOnly: true, isException: never })).toBeNull();
  });

  it('returns null for an unparseable URL', () => {
    expect(upgradeUrl('not a url', { httpsOnly: true, isException: never })).toBeNull();
  });

  it('preserves a non-default port', () => {
    expect(upgradeUrl('http://example.com:8080/x', { httpsOnly: true, isException: never })).toBe(
      'https://example.com:8080/x',
    );
  });
});
```

- [ ] **Step 2: Run it (red)** — `npx vitest run electron/main/safety/httpsUpgrade.test.ts` → fails to resolve `./httpsUpgrade`.

- [ ] **Step 3: Implement** — `electron/main/safety/httpsUpgrade.ts`:

```ts
// electron/main/safety/httpsUpgrade.ts
// Pure HTTPS-Only decision for a top-level navigation URL. No I/O — callers
// supply the `httpsOnly` setting and a per-host exception predicate. Returns the
// upgraded https URL when an upgrade applies, otherwise null (load as-is).
// Only plain `http:` is upgraded; scheme is the only thing changed (path, query,
// hash, and any non-default port are preserved).

export function upgradeUrl(
  rawUrl: string,
  opts: { httpsOnly: boolean; isException: (host: string) => boolean },
): string | null {
  if (!opts.httpsOnly) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  if (opts.isException(u.hostname)) return null;
  u.protocol = 'https:';
  return u.toString();
}
```

- [ ] **Step 4: Run it (green)** — `npx vitest run electron/main/safety/httpsUpgrade.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/safety/httpsUpgrade.ts electron/main/safety/httpsUpgrade.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): add pure HTTPS-Only upgradeUrl helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `httpsOnly` Setting (default on)

**Files:** Modify `shared/types.ts` (`Settings`); Modify `electron/main/db/settingsRepo.ts` (`DEFAULT_SETTINGS`); Test `electron/main/db/settingsRepo.test.ts` (add a case if the file exists, else add to an existing settings test).

- [ ] **Step 1: Add the field to `Settings`** — in `shared/types.ts`, add `httpsOnly: boolean;` to the `Settings` interface (after `downloadDir`):

```ts
export interface Settings {
  siteName: string;
  homeUrl: string;
  primaryColor: string;
  defaultSearchTemplate: string;
  searchEngines: SearchEngine[];
  hideChromeByDefault: boolean;
  downloadDir: string;
  httpsOnly: boolean;
}
```

- [ ] **Step 2: Add the default** — in `electron/main/db/settingsRepo.ts`, add `httpsOnly: true,` to `DEFAULT_SETTINGS`.

- [ ] **Step 3: Write/extend the test** — open `electron/main/db/settingsRepo.test.ts`. If it exists, add:

```ts
it('defaults httpsOnly to true', () => {
  const repo = new SettingsRepo(db);
  expect(repo.get().httpsOnly).toBe(true);
});

it('round-trips httpsOnly=false', () => {
  const repo = new SettingsRepo(db);
  repo.set({ httpsOnly: false });
  expect(repo.get().httpsOnly).toBe(false);
});
```

If `settingsRepo.test.ts` does NOT exist, create it mirroring `permissionsRepo.test.ts` (imports `{ openDb, runMigrations } from './sqlite'`, `beforeEach` opens `:memory:` + migrates, `afterEach` closes) with the two cases above plus one asserting an unrelated default (e.g. `siteName === 'Aegis'`).

- [ ] **Step 4: Run it** — `npx vitest run electron/main/db/settingsRepo.test.ts` → pass.

- [ ] **Step 5: Typecheck the renderer doesn't break** — run `npm test` (the App + settings component tests exercise `Settings`); confirm green. If any test constructs a literal `Settings` object and now errors on the missing `httpsOnly`, add `httpsOnly: true` to that fixture (additive only).

- [ ] **Step 6: Commit**

```bash
git add shared/types.ts electron/main/db/settingsRepo.ts electron/main/db/settingsRepo.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): add httpsOnly setting (default true)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `http_exceptions` table + `HttpExceptionsRepo`

**Files:** Modify `electron/main/db/sqlite.ts`; Create `electron/main/db/httpExceptionsRepo.ts`; Test `electron/main/db/httpExceptionsRepo.test.ts`.

- [ ] **Step 1: Add the migration** — in `electron/main/db/sqlite.ts`, inside the existing `db.exec(\`...\`)` block in `runMigrations`, append after the `site_permissions` statement:

```sql
CREATE TABLE IF NOT EXISTS http_exceptions (
  host      TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL
);
```

- [ ] **Step 2: Write the failing test** — `electron/main/db/httpExceptionsRepo.test.ts` (mirror `permissionsRepo.test.ts`):

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { HttpExceptionsRepo } from './httpExceptionsRepo';

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
});
afterEach(() => db.close());

describe('HttpExceptionsRepo', () => {
  it('has() is false for an unknown host', () => {
    expect(new HttpExceptionsRepo(db).has('example.com')).toBe(false);
  });

  it('add() makes has() true', () => {
    const repo = new HttpExceptionsRepo(db);
    repo.add('example.com');
    expect(repo.has('example.com')).toBe(true);
  });

  it('add() is idempotent', () => {
    const repo = new HttpExceptionsRepo(db);
    repo.add('example.com');
    repo.add('example.com');
    expect(repo.list()).toEqual(['example.com']);
  });

  it('remove() clears the exception', () => {
    const repo = new HttpExceptionsRepo(db);
    repo.add('example.com');
    repo.remove('example.com');
    expect(repo.has('example.com')).toBe(false);
  });

  it('list() returns hosts (newest first)', () => {
    const repo = new HttpExceptionsRepo(db);
    repo.add('a.com');
    repo.add('b.com');
    expect(repo.list()).toContain('a.com');
    expect(repo.list()).toContain('b.com');
    expect(repo.list().length).toBe(2);
  });

  it('persists across repo instances on the same db', () => {
    new HttpExceptionsRepo(db).add('example.com');
    expect(new HttpExceptionsRepo(db).has('example.com')).toBe(true);
  });
});
```

- [ ] **Step 3: Run it (red)** — `npx vitest run electron/main/db/httpExceptionsRepo.test.ts` → fails to resolve `./httpExceptionsRepo`.

- [ ] **Step 4: Implement** — `electron/main/db/httpExceptionsRepo.ts`:

```ts
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
```

- [ ] **Step 5: Run it (green)** — `npx vitest run electron/main/db/httpExceptionsRepo.test.ts` → pass.

- [ ] **Step 6: Commit**

```bash
git add electron/main/db/sqlite.ts electron/main/db/httpExceptionsRepo.ts electron/main/db/httpExceptionsRepo.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): add http_exceptions table + HttpExceptionsRepo

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Safety IPC types (`shared/types.ts`)

**Files:** Modify `shared/types.ts`.

- [ ] **Step 1: Add IPC channel constants** — in the `IPC` object, add (next to the `update*` entries):

```ts
  safetyGetState: 'safety.getState',
  safetyProceed: 'safety.proceed',
  safetyListExceptions: 'safety.listExceptions',
  safetyRemoveException: 'safety.removeException',
  evtSafetyInterstitial: 'safety.interstitial',
```

- [ ] **Step 2: Add the payload interface** — near `UpdateState`:

```ts
/**
 * A full-window safety interstitial shown over the content view. `reason`
 * is extensible — Phase 3a uses only 'https-failed'; Phase 3b adds 'malware'.
 */
export interface SafetyInterstitialPayload {
  /** The http URL the user may choose to continue to. */
  url: string;
  reason: 'https-failed';
}
```

- [ ] **Step 3: Add the `safety` block to `AegisApi`** — next to the `update` block:

```ts
  safety: {
    getState(): Promise<SafetyInterstitialPayload | null>;
    proceed(url: string): Promise<void>;
    listExceptions(): Promise<string[]>;
    removeException(host: string): Promise<void>;
    onInterstitial(cb: (p: SafetyInterstitialPayload | null) => void): () => void;
  };
```

- [ ] **Step 4: Verify the project still type-checks/builds** — run `npm run build`. Expected: success (types-only additions; no consumer yet). Commit.

```bash
git add shared/types.ts
git commit -m "$(cat <<'EOF'
feat(safety): add safety.* IPC contract (types only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `SafetyController` (main)

**Files:** Create `electron/main/safety/SafetyController.ts`; Test `electron/main/safety/SafetyController.test.ts`.

- [ ] **Step 1: Write the failing test** — `electron/main/safety/SafetyController.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { NavFailed, SafetyInterstitialPayload } from '../../../shared/types';
import { SafetyController } from './SafetyController';

function setup(opts?: { httpsOnly?: boolean; exceptions?: Set<string> }) {
  const exceptions = opts?.exceptions ?? new Set<string>();
  const navigateView = vi.fn();
  const events: (SafetyInterstitialPayload | null)[] = [];
  const sc = new SafetyController({
    navigateView,
    httpExceptions: {
      has: (h) => exceptions.has(h),
      add: (h) => exceptions.add(h),
      remove: (h) => exceptions.delete(h),
      list: () => [...exceptions],
    },
    getHttpsOnly: () => opts?.httpsOnly ?? true,
    onInterstitial: (p) => events.push(p),
  });
  return { sc, navigateView, events, exceptions };
}

const failed = (url: string): NavFailed => ({
  viewId: 'primary',
  errorCode: -105,
  errorDescription: 'ERR_NAME_NOT_RESOLVED',
  validatedURL: url,
  kind: 'load',
});

describe('SafetyController.navigate', () => {
  it('upgrades http -> https before loading', () => {
    const { sc, navigateView } = setup();
    sc.navigate('http://example.com/');
    expect(navigateView).toHaveBeenCalledWith('https://example.com/');
  });

  it('loads as-is when httpsOnly is off', () => {
    const { sc, navigateView } = setup({ httpsOnly: false });
    sc.navigate('http://example.com/');
    expect(navigateView).toHaveBeenCalledWith('http://example.com/');
  });

  it('loads http as-is for an excepted host', () => {
    const { sc, navigateView } = setup({ exceptions: new Set(['example.com']) });
    sc.navigate('http://example.com/');
    expect(navigateView).toHaveBeenCalledWith('http://example.com/');
  });
});

describe('SafetyController.handleNavFailed', () => {
  it('raises the interstitial when an upgraded URL fails, returns true', () => {
    const { sc, events } = setup();
    sc.navigate('http://example.com/'); // records upgrade http->https
    const handled = sc.handleNavFailed(failed('https://example.com/'));
    expect(handled).toBe(true);
    expect(sc.getState()).toEqual({ url: 'http://example.com/', reason: 'https-failed' });
    expect(events.at(-1)).toEqual({ url: 'http://example.com/', reason: 'https-failed' });
  });

  it('returns false for a failure unrelated to an upgrade', () => {
    const { sc } = setup();
    sc.navigate('https://example.com/'); // no upgrade recorded
    expect(sc.handleNavFailed(failed('https://example.com/'))).toBe(false);
    expect(sc.getState()).toBeNull();
  });

  it('does not double-fire for a stale upgrade record', () => {
    const { sc } = setup();
    sc.navigate('http://example.com/');
    expect(sc.handleNavFailed(failed('https://example.com/'))).toBe(true);
    // second failure of the same URL no longer matches (record cleared)
    expect(sc.handleNavFailed(failed('https://example.com/'))).toBe(false);
  });
});

describe('SafetyController.proceed', () => {
  it('persists the host exception, dismisses, and reloads over http', () => {
    const { sc, navigateView, events, exceptions } = setup();
    sc.navigate('http://example.com/');
    sc.handleNavFailed(failed('https://example.com/'));
    navigateView.mockClear();
    sc.proceed('http://example.com/');
    expect(exceptions.has('example.com')).toBe(true);
    expect(navigateView).toHaveBeenCalledWith('http://example.com/');
    expect(sc.getState()).toBeNull();
    expect(events.at(-1)).toBeNull(); // dismiss emits null
  });
});

describe('SafetyController.resolveUpgrade (gate hook)', () => {
  it('returns the https URL for an upgradeable http link', () => {
    const { sc } = setup();
    expect(sc.resolveUpgrade('http://example.com/x')).toBe('https://example.com/x');
  });
  it('returns null when nothing to upgrade', () => {
    const { sc } = setup();
    expect(sc.resolveUpgrade('https://example.com/x')).toBeNull();
  });
});

describe('SafetyController exception management', () => {
  it('listExceptions + removeException delegate to the repo', () => {
    const { sc, exceptions } = setup({ exceptions: new Set(['a.com', 'b.com']) });
    expect(sc.listExceptions().sort()).toEqual(['a.com', 'b.com']);
    sc.removeException('a.com');
    expect(exceptions.has('a.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it (red)** — `npx vitest run electron/main/safety/SafetyController.test.ts` → fails to resolve module.

- [ ] **Step 3: Implement** — `electron/main/safety/SafetyController.ts`:

```ts
// electron/main/safety/SafetyController.ts
import type { NavFailed, SafetyInterstitialPayload } from '../../../shared/types';
import { upgradeUrl } from './httpsUpgrade';

export interface HttpExceptionsLike {
  has(host: string): boolean;
  add(host: string): void;
  remove(host: string): void;
  list(): string[];
}

export interface SafetyControllerDeps {
  /** Load a URL in the content view (ViewController.navigate). */
  navigateView: (url: string) => void;
  httpExceptions: HttpExceptionsLike;
  getHttpsOnly: () => boolean;
  onInterstitial: (p: SafetyInterstitialPayload | null) => void;
}

/**
 * Owns HTTPS-Only navigation upgrades and the safety interstitial. The pure
 * upgrade decision lives in ./httpsUpgrade; this class adds the stateful pieces:
 * recording the last upgrade so a did-fail-load on the https form can offer an
 * HTTP fallback, and the persisted per-host exception set.
 */
export class SafetyController {
  private current: SafetyInterstitialPayload | null = null;
  private lastUpgrade: { from: string; to: string } | null = null;

  constructor(private readonly deps: SafetyControllerDeps) {}

  /** Gate/entry hook: returns the https URL to load instead, or null. Records it. */
  resolveUpgrade(url: string): string | null {
    const upgraded = upgradeUrl(url, {
      httpsOnly: this.deps.getHttpsOnly(),
      isException: (h) => this.deps.httpExceptions.has(h),
    });
    if (upgraded) this.lastUpgrade = { from: url, to: upgraded };
    return upgraded;
  }

  /** Upgrade-aware navigation entry (address bar / home / first nav). */
  navigate(url: string): void {
    const upgraded = this.resolveUpgrade(url);
    this.deps.navigateView(upgraded ?? url);
  }

  /**
   * did-fail-load hook. If the failed URL is the https form we just upgraded to,
   * raise the HTTPS-failed interstitial and return true (caller suppresses the
   * generic error page). Otherwise return false.
   */
  handleNavFailed(f: NavFailed): boolean {
    if (this.lastUpgrade && f.validatedURL === this.lastUpgrade.to) {
      const httpUrl = this.lastUpgrade.from;
      this.lastUpgrade = null;
      this.raise({ url: httpUrl, reason: 'https-failed' });
      return true;
    }
    return false;
  }

  getState(): SafetyInterstitialPayload | null {
    return this.current;
  }

  /** "Continue to HTTP for this site": persist the host + reload over http. */
  proceed(url: string): void {
    try {
      const host = new URL(url).hostname;
      if (host) this.deps.httpExceptions.add(host);
    } catch {
      /* malformed url — skip persistence, still attempt the load */
    }
    this.dismiss();
    this.deps.navigateView(url);
  }

  listExceptions(): string[] {
    return this.deps.httpExceptions.list();
  }

  removeException(host: string): void {
    this.deps.httpExceptions.remove(host);
  }

  private raise(p: SafetyInterstitialPayload): void {
    this.current = p;
    this.deps.onInterstitial(p);
  }

  private dismiss(): void {
    this.current = null;
    this.deps.onInterstitial(null);
  }
}
```

- [ ] **Step 4: Run it (green)** — `npx vitest run electron/main/safety/SafetyController.test.ts` → all pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/safety/SafetyController.ts electron/main/safety/SafetyController.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): add SafetyController (upgrade + interstitial + exceptions)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Safety IPC handlers + preload namespace

**Files:** Create `electron/main/ipc/safety.ts`; Test `electron/main/ipc/safety.test.ts`; Modify `electron/preload/chromePreload.ts`.

- [ ] **Step 1: Write the failing test** — `electron/main/ipc/safety.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import { buildSafetyHandlers } from './safety';

function fakeController() {
  return {
    getState: vi.fn(() => null),
    proceed: vi.fn(),
    listExceptions: vi.fn(() => ['a.com']),
    removeException: vi.fn(),
  };
}

describe('buildSafetyHandlers', () => {
  it('maps the safety channels to controller methods', () => {
    const c = fakeController();
    const h = buildSafetyHandlers(c as never);
    expect(typeof h[IPC.safetyGetState]).toBe('function');
    h[IPC.safetyProceed]('http://x/');
    expect(c.proceed).toHaveBeenCalledWith('http://x/');
    expect(h[IPC.safetyListExceptions]()).toEqual(['a.com']);
    h[IPC.safetyRemoveException]('a.com');
    expect(c.removeException).toHaveBeenCalledWith('a.com');
  });
});
```

- [ ] **Step 2: Run it (red)** — `npx vitest run electron/main/ipc/safety.test.ts` → fails to resolve module.

- [ ] **Step 3: Implement** — `electron/main/ipc/safety.ts`:

```ts
// electron/main/ipc/safety.ts
import { IPC } from '../../../shared/types';
import type { SafetyController } from '../safety/SafetyController';

/** Guarded IPC map for the safety/interstitial surface. */
export function buildSafetyHandlers(
  safety: SafetyController,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.safetyGetState]: () => safety.getState(),
    [IPC.safetyProceed]: (url: string) => safety.proceed(url),
    [IPC.safetyListExceptions]: () => safety.listExceptions(),
    [IPC.safetyRemoveException]: (host: string) => safety.removeException(host),
  };
}
```

- [ ] **Step 4: Run it (green)** — `npx vitest run electron/main/ipc/safety.test.ts` → pass.

- [ ] **Step 5: Expose the preload namespace** — in `electron/preload/chromePreload.ts`, import `SafetyInterstitialPayload` from `shared/types`, and add a `safety` block to the `contextBridge.exposeInMainWorld` object (mirror the `update` block + `subscribe` helper):

```ts
  safety: {
    getState: (): Promise<SafetyInterstitialPayload | null> => ipcRenderer.invoke(IPC.safetyGetState),
    proceed: (url: string): Promise<void> => ipcRenderer.invoke(IPC.safetyProceed, url),
    listExceptions: (): Promise<string[]> => ipcRenderer.invoke(IPC.safetyListExceptions),
    removeException: (host: string): Promise<void> => ipcRenderer.invoke(IPC.safetyRemoveException, host),
    onInterstitial: (cb: (p: SafetyInterstitialPayload | null) => void) =>
      subscribe<SafetyInterstitialPayload | null>(IPC.evtSafetyInterstitial, cb),
  },
```

- [ ] **Step 6: Build to verify preload compiles** — `npm run build` → success. Commit.

```bash
git add electron/main/ipc/safety.ts electron/main/ipc/safety.test.ts electron/preload/chromePreload.ts
git commit -m "$(cat <<'EOF'
feat(safety): add safety IPC handlers + preload namespace

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: ViewController nav-gate upgrade hook

**Files:** Modify `electron/main/viewController.ts`; Test `electron/main/viewController.test.ts` (add a case; create if absent).

- [ ] **Step 1: Add the opt** — in `viewController.ts`, add to `ViewControllerOpts`:

```ts
  /** HTTPS-Only hook: given a navigation URL, return the https URL to load instead, or null to allow as-is. */
  upgradeNavigation?: (url: string) => string | null;
```

- [ ] **Step 2: Use it in the gate** — replace the gate (lines ~115-119) with:

```ts
const gate = (event: { preventDefault: () => void }, url: string) => {
  if (!isAllowedNavigationUrl(url)) {
    event.preventDefault();
    return;
  }
  const upgraded = this.opts.upgradeNavigation?.(url) ?? null;
  if (upgraded && upgraded !== url) {
    event.preventDefault();
    this.wc().loadURL(upgraded);
  }
};
wc.on('will-navigate', gate);
wc.on('will-redirect', gate);
```

- [ ] **Step 3: Write the failing test** — add to `electron/main/viewController.test.ts` (or create it). If the file/harness for ViewController is heavy (it wires a real WebContentsView), instead add a focused unit test that exercises the gate logic via a small extraction is NOT needed — prefer testing the observable behavior. Mirror the existing ViewController test setup; if none exists, add this minimal test that asserts the opt is invoked and an upgrade preventДefaults + reloads:

```ts
// Pseudocode shape — match the existing ViewController test harness exactly.
// If ViewController tests mock `wc`, assert: when upgradeNavigation returns a
// new url, the gate calls event.preventDefault() and wc.loadURL(upgradedUrl).
```

**If `viewController.test.ts` does not exist or cannot cleanly mock the WebContents gate**, SKIP a bespoke unit test here (the gate is exercised end-to-end by the Task 12 e2e), and instead add an inline note in your task report that the gate is covered by e2e. Do NOT fabricate a passing test against un-mockable Electron internals — report honestly.

- [ ] **Step 4: Build** — `npm run build` → success (the opt is optional; existing constructions still compile).

- [ ] **Step 5: Commit**

```bash
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): add upgradeNavigation hook to the content nav gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire it in `index.ts` + route nav handlers

**Files:** Modify `electron/main/index.ts`; Modify `electron/main/ipc/nav.ts`.

- [ ] **Step 1: Route nav handlers through safety** — in `electron/main/ipc/nav.ts`, change `buildNavHandlers` to accept the controller and use `safety.navigate` for the URL-loading handlers:

```ts
import type { SafetyController } from '../safety/SafetyController';

export function buildNavHandlers(
  vc: ViewController,
  settingsRepo: SettingsRepo,
  safety: SafetyController,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.navNavigate]: (_viewId: ViewId, url: string) => safety.navigate(url),
    [IPC.navBack]: (_viewId: ViewId) => vc.back(),
    [IPC.navForward]: (_viewId: ViewId) => vc.forward(),
    [IPC.navReloadOrStop]: (_viewId: ViewId) => vc.reloadOrStop(),
    [IPC.navHome]: (_viewId: ViewId) => safety.navigate(settingsRepo.get().homeUrl),
    [IPC.navGetState]: (_viewId: ViewId): NavState => vc.getState(),
    [IPC.viewSetContentVisible]: (_viewId: ViewId, visible: boolean) => vc.setVisible(visible),
  };
}
```

- [ ] **Step 2: Construct repo + controller in `index.ts` boot.** Add the import `import { HttpExceptionsRepo } from './db/httpExceptionsRepo';`, `import { SafetyController } from './safety/SafetyController';`, and `import { buildSafetyHandlers } from './ipc/safety';`. After the other repos are constructed, add `const httpExceptionsRepo = new HttpExceptionsRepo(db);`. Then forward-declare and wire the controller around the `vc` construction (lines ~119-126):

```ts
  // HTTPS-Only / safety. Forward-declared so the content nav gate can consult it.
  let safety: SafetyController | undefined;

  const contentPreloadPath = join(__dirname, '../preload/contentPreload.js');
  const vc = new ViewController({
    contentPreloadPath,
    onState,
    onFailed: (f) => {
      if (safety?.handleNavFailed(f)) return; // upgraded-URL failure -> interstitial
      fwd.onFailed(f);
    },
    onCrashed: fwd.onCrashed,
    upgradeNavigation: (url) => safety?.resolveUpgrade(url) ?? null,
  });

  safety = new SafetyController({
    navigateView: (u) => vc.navigate(u),
    httpExceptions: httpExceptionsRepo,
    getHttpsOnly: () => settingsRepo.get().httpsOnly,
    onInterstitial: (p) => chromeWc.send(IPC.evtSafetyInterstitial, p),
  });
```

- [ ] **Step 3: Register safety handlers + pass `safety` to nav handlers** — in the `registerGuardedHandlers(chromeWc.id, { ... })` map (lines ~313-329), change `...buildNavHandlers(vc, settingsRepo)` to `...buildNavHandlers(vc, settingsRepo, safety)` and add `...buildSafetyHandlers(safety),`.

- [ ] **Step 4: Route the first navigation through safety** — change the boot first-nav (`~389 vc.navigate(firstUrl)`) to `safety.navigate(firstUrl);`.

- [ ] **Step 5: Build + full suite** — `npm run build` → success; `npm test` → green. Manually launch is covered by e2e (Task 12).

- [ ] **Step 6: Commit**

```bash
git add electron/main/index.ts electron/main/ipc/nav.ts
git commit -m "$(cat <<'EOF'
feat(safety): wire SafetyController into boot, nav handlers, and did-fail-load

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Interstitial UI (hook + component + CSS + App wiring)

**Files:** Create `src/hooks/useSafety.ts`; Create `src/components/SafetyInterstitial.tsx`; Test `src/components/SafetyInterstitial.test.tsx`; Modify `src/index.css`; Modify `src/App.tsx`.

- [ ] **Step 1: Create the hook** — `src/hooks/useSafety.ts` (mirror `useUpdate.ts`):

```ts
import { useCallback, useEffect, useState } from 'react';
import type { SafetyInterstitialPayload } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useSafety() {
  const [interstitial, setInterstitial] = useState<SafetyInterstitialPayload | null>(null);

  useEffect(() => {
    let active = true;
    void aegis.safety.getState().then((s) => {
      if (active) setInterstitial(s);
    });
    const unsubscribe = aegis.safety.onInterstitial((p) => setInterstitial(p));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const proceed = useCallback((url: string): Promise<void> => aegis.safety.proceed(url), []);
  return { interstitial, proceed };
}
```

- [ ] **Step 2: Write the failing component test** — `src/components/SafetyInterstitial.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SafetyInterstitial } from './SafetyInterstitial';

describe('SafetyInterstitial', () => {
  it('renders nothing when inactive', () => {
    const { container } = render(<SafetyInterstitial interstitial={null} onProceed={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the host and calls onProceed with the url', async () => {
    const onProceed = vi.fn();
    render(
      <SafetyInterstitial
        interstitial={{ url: 'http://example.com/x', reason: 'https-failed' }}
        onProceed={onProceed}
      />,
    );
    expect(screen.getByText(/example\.com/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /continue to http/i }));
    expect(onProceed).toHaveBeenCalledWith('http://example.com/x');
  });
});
```

- [ ] **Step 3: Run it (red)** — `npx vitest run src/components/SafetyInterstitial.test.tsx` → fails to resolve module.

- [ ] **Step 4: Implement the component** — `src/components/SafetyInterstitial.tsx`:

```tsx
import type { SafetyInterstitialPayload } from '../../shared/types';

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function SafetyInterstitial({
  interstitial,
  onProceed,
}: {
  interstitial: SafetyInterstitialPayload | null;
  onProceed: (url: string) => void;
}) {
  if (interstitial === null) return null;
  const host = safeHost(interstitial.url);
  return (
    <div className="interstitial" role="alertdialog" aria-modal="true" aria-labelledby="interstitial-title">
      <div className="interstitial__panel">
        <h1 id="interstitial-title" className="interstitial__title">
          This site isn’t available over a secure connection
        </h1>
        <p className="interstitial__body">
          Aegis tried to load <strong>{host}</strong> securely over HTTPS, but the secure connection
          failed. Continuing will load this site over an unencrypted <strong>HTTP</strong> connection,
          which others on your network may be able to read or modify.
        </p>
        <div className="interstitial__actions">
          <button
            type="button"
            className="interstitial__continue"
            onClick={() => onProceed(interstitial.url)}
          >
            Continue to HTTP for this site
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run it (green)** — `npx vitest run src/components/SafetyInterstitial.test.tsx` → pass.

- [ ] **Step 6: Add CSS** — in `src/index.css`, add a full-window overlay block consistent with the dark / `#3b82f6` theme:

```css
.interstitial {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #0b0f17;
}
.interstitial__panel {
  max-width: 560px;
  background: #111827;
  border: 1px solid #1f2937;
  border-radius: 12px;
  padding: 28px 32px;
  color: #e5e7eb;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
.interstitial__title {
  margin: 0 0 12px;
  font-size: 20px;
  font-weight: 600;
  color: #f9fafb;
}
.interstitial__body {
  margin: 0 0 24px;
  line-height: 1.55;
  font-size: 14px;
  color: #cbd5e1;
}
.interstitial__actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
.interstitial__continue {
  background: transparent;
  color: #93a4bd;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 9px 16px;
  font-size: 13px;
  cursor: pointer;
}
.interstitial__continue:hover {
  color: #e5e7eb;
  border-color: #475569;
}
```

- [ ] **Step 7: Wire into `App.tsx`** — import `useSafety` + `SafetyInterstitial`; add `const safety = useSafety();`; add `|| safety.interstitial !== null` to the `chromeOverlayActive` union (line ~86-93); render the component (alongside the other overlays):

```tsx
<SafetyInterstitial
  interstitial={safety.interstitial}
  onProceed={(u) => void safety.proceed(u)}
/>
```

- [ ] **Step 8: Update `App.test.tsx` mock** — the `aegis` mock in `src/App.test.tsx` must gain a `safety` namespace (mirroring how `update` was added) so mounting `useSafety` doesn't break existing App tests: `safety: { getState: vi.fn().mockResolvedValue(null), proceed: vi.fn(), listExceptions: vi.fn().mockResolvedValue([]), removeException: vi.fn(), onInterstitial: vi.fn(() => () => {}) }`. Additive only — do not weaken existing assertions.

- [ ] **Step 9: Run the renderer suite** — `npm test` → green (App tests + new component test).

- [ ] **Step 10: Commit**

```bash
git add src/hooks/useSafety.ts src/components/SafetyInterstitial.tsx src/components/SafetyInterstitial.test.tsx src/index.css src/App.tsx src/App.test.tsx
git commit -m "$(cat <<'EOF'
feat(safety): add HTTPS-failed interstitial overlay (hook + component + App wiring)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Security settings tab

**Files:** Modify `src/components/SettingsModal.tsx`; Create `src/components/SecurityTab.tsx`; Test `src/components/SecurityTab.test.tsx`; Modify `src/App.tsx`.

- [ ] **Step 1: Add the tab to `SettingsModal.tsx`** — add `'security'` to the `SettingsTab` union, a `TAB_LABELS.security = 'Security'` entry, insert `'security'` into `TAB_ORDER` (after `'sitePermissions'`, before `'data'`), add a `security: ReactNode` prop to `SettingsModalProps`, and render `{security}` in the tab-content switch for `activeTab === 'security'` (mirror an existing tab exactly).

- [ ] **Step 2: Write the failing test** — `src/components/SecurityTab.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityTab } from './SecurityTab';

const baseSettings = { httpsOnly: true } as never;

describe('SecurityTab', () => {
  it('reflects httpsOnly and toggles it via update', async () => {
    const update = vi.fn();
    render(<SecurityTab settings={baseSettings} update={update} listExceptions={async () => []} removeException={vi.fn()} />);
    const toggle = screen.getByRole('checkbox', { name: /https-only/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ httpsOnly: false });
  });
});
```

- [ ] **Step 3: Run it (red)** — `npx vitest run src/components/SecurityTab.test.tsx` → fails to resolve module.

- [ ] **Step 4: Implement `SecurityTab.tsx`** — mirror an existing tab (e.g. `AppearanceTab.tsx`) for the toggle; add a list of remembered HTTP exceptions with a remove button. The component receives `settings` (for `httpsOnly`), `update` (calls `aegis.settings.set` upstream — match how other tabs call `update`), and `listExceptions`/`removeException` (from `aegis.safety`). Keep it simple:

```tsx
import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';

export function SecurityTab({
  settings,
  update,
  listExceptions,
  removeException,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  listExceptions: () => Promise<string[]>;
  removeException: (host: string) => void;
}) {
  const [exceptions, setExceptions] = useState<string[]>([]);
  const refresh = () => void listExceptions().then(setExceptions);
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="settings-tab">
      <label className="settings-row">
        <input
          type="checkbox"
          checked={settings.httpsOnly}
          onChange={(e) => update({ httpsOnly: e.target.checked })}
          aria-label="HTTPS-Only mode"
        />
        <span>HTTPS-Only mode — upgrade sites to a secure connection and warn before using HTTP</span>
      </label>

      <h3 className="settings-subhead">Sites allowed over HTTP</h3>
      {exceptions.length === 0 ? (
        <p className="settings-empty">No HTTP exceptions remembered.</p>
      ) : (
        <ul className="settings-list">
          {exceptions.map((host) => (
            <li key={host} className="settings-list__row">
              <span>{host}</span>
              <button
                type="button"
                onClick={() => {
                  removeException(host);
                  setExceptions((xs) => xs.filter((h) => h !== host));
                }}
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

> Match the actual class names / `update` calling convention of the existing tabs when you implement — the markup above is the structure; align styling hooks with siblings.

- [ ] **Step 5: Run it (green)** — `npx vitest run src/components/SecurityTab.test.tsx` → pass.

- [ ] **Step 6: Wire into `App.tsx`** — pass `security={<SecurityTab settings={settings.settings} update={settings.update} listExceptions={() => aegis.safety.listExceptions()} removeException={(h) => void aegis.safety.removeException(h)} />}` to `<SettingsModal>` (match how the other tab props are passed). Ensure `aegis` is imported in App (it already is for `view.setChromeOverlay`).

- [ ] **Step 7: Run the suite** — `npm test` → green.

- [ ] **Step 8: Commit**

```bash
git add src/components/SettingsModal.tsx src/components/SecurityTab.tsx src/components/SecurityTab.test.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
feat(safety): add Security settings tab (HTTPS-Only toggle + HTTP exceptions)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Full gate + manual smoke

**Files:** none (verification task).

- [ ] **Step 1: Full unit gate** — `npm test` → all green (report the count; expect the prior baseline + the new safety/repo/component tests).
- [ ] **Step 2: Build** — `npm run build` → success.
- [ ] **Step 3: Manual smoke (dev)** — `npm run dev`, then in the address bar enter `http://example.com` and confirm it loads as `https://example.com`. Enter a host that only serves HTTP (e.g. `http://neverssl.com`) and confirm the interstitial appears; click "Continue to HTTP for this site" and confirm it loads over http and that re-entering it loads http directly (exception remembered). Toggle HTTPS-Only off in Settings → Security and confirm `http://neverssl.com` loads directly. Report exactly what you observed.
- [ ] **Step 4: Commit** (if any fixups were needed during smoke; otherwise skip).

---

## Task 12: e2e — upgrade, interstitial, persistence

**Files:** Create `electron/test/e2e/httpsOnly.e2e.ts` (match the actual e2e file naming/extension in `electron/test/e2e/`).

- [ ] **Step 1: Learn the harness** — read 1-2 existing tests in `electron/test/e2e/` to learn how the app is launched (Playwright + Electron), how test pages are served (local HTTP server fixture?), and the offline flag (`AEGIS_ADBLOCK_OFFLINE=1`). Mirror that harness exactly — do NOT invent helpers.

- [ ] **Step 2: Write the scenarios** (mirroring the harness):
  1. **Upgrade:** serve a page over HTTPS for some host; navigate to the `http://` form; assert the committed URL ends up `https://…` (the address bar / nav state shows https).
  2. **Interstitial + proceed + persist:** serve a host on HTTP only (no HTTPS listener); navigate to its `http://` URL; assert the `.interstitial` overlay appears; click "Continue to HTTP for this site"; assert the page loads over http; navigate away and back to the same host and assert it loads over http directly WITHOUT the interstitial (exception persisted).
  3. **Toggle off:** with HTTPS-Only disabled (set `httpsOnly:false` via the settings IPC or a seeded DB), assert an `http://` URL loads directly with no upgrade and no interstitial.
  4. **Regression:** a normal `https://` page and ad-blocking behavior are unaffected (a minimal sanity nav).

- [ ] **Step 3: Run e2e** — `npm run test:e2e` (this runs `pretest:e2e` = `rebuild:electron && build` first). Report the ACTUAL pass/fail output. If the harness cannot serve an HTTPS fixture (self-signed cert handling), document the limitation honestly and cover what you can (the upgrade-attempt + interstitial path via an http-only fixture is the core assertion); do not claim a scenario passed that you did not run.

- [ ] **Step 4: Commit**

```bash
git add electron/test/e2e/
git commit -m "$(cat <<'EOF'
test(safety): e2e for HTTPS-Only upgrade + interstitial + persistence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all tasks)

- [ ] `npm test` → full unit/jsdom suite green (report count).
- [ ] `npm run build` → success.
- [ ] `npm run test:e2e` → report actual result (note any HTTPS-fixture limitation honestly).
- [ ] Manual smoke (Task 11) observations recorded.

## Success criteria (spec §3.3 HTTPS-Only + §6.3 partial)

| Requirement | Delivered by |
| --- | --- |
| Top-level `http` navigations upgrade to `https` (address bar, home, first nav, link clicks) | Tasks 1, 5, 7, 8 |
| HTTPS failure shows an interstitial | Tasks 5, 9 |
| "Continue" remembers a per-site HTTP exception + reloads over http | Tasks 3, 5, 9 |
| HTTPS-Only is a setting (default on), with a Security UI | Tasks 2, 10 |
| Shared interstitial framework reusable by Phase 3b (malware) | Tasks 4, 5, 9 (extensible `reason`) |
| No regression | Final verification: `npm test` + `npm run build` + e2e |

## Carried to Phase 3b (malicious-site)
- `MalwareGuard` (second `@ghostery` engine, in-memory `.match(Request.fromRawDetails({type:'document',url,sourceUrl:url}))`; do NOT call `enableBlockingInSession` twice) + a `will-navigate` document check that raises the interstitial with `reason:'malware'` (extend `SafetyInterstitialPayload.reason`), + merging malware list texts into the main session engine for subresource blocking, + a curated non-user-toggleable malware list set seeded/refreshed alongside the ad lists. Requires recon of `index.ts` engine build/refresh wiring (deferred).
