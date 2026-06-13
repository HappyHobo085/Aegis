# Aegis Security Phase 3b — Malicious-Site Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block top-level navigations to known-malicious/phishing hosts with a warning interstitial (reusing Phase 3a's `SafetyController`/`SafetyInterstitial`), and network-block malicious subresources via the existing ad engine — from a curated, non-user-toggleable malware list set.

**Architecture:** A dedicated in-memory `MalwareGuard` (a second `@ghostery` `ElectronBlocker`, consulted via `.match()` only — it MUST NOT call `enableBlockingInSession`, which owns the single session listener). The same malware list texts are merged into the MAIN ad engine at its two build sites for subresource blocking. The nav gate + entry path query `SafetyController.checkMalicious(url)`, which raises a `reason: 'malware'` interstitial; "Continue anyway" adds a **session-only** (non-persisted) bypass. Lists are a hardcoded constant (outside `filter_subscriptions`, so invisible to the toggle UI), fetched/cached alongside the ad lists.

**Tech Stack:** Electron 42, `@ghostery/adblocker-electron` 2.18.0 (`ElectronBlocker.parse`, `engine.match(Request.fromRawDetails(...))`), better-sqlite3 (none new), React 19, Vitest + Playwright.

**Branch:** Execute on `feat/security-phase3b` cut from `main` (no push/branch/rename beyond this branch).

**Builds on 3a (already on `main`):** `SafetyController`, `SafetyInterstitial`, `useSafety`, `safety.*` IPC, `SafetyInterstitialPayload` (extend `reason`), the `upgradeNavigation` gate hook + `chromeOverlayActive` overlay, `normalizeHost`.

---

## Verified grounding (live source — do not re-derive)

- **@ghostery match API:** `ElectronBlocker extends FiltersEngine` → `engine.match(request: Request, withMetadata?): BlockingResponse` where `BlockingResponse = { match: boolean, redirect }`. `Request.fromRawDetails({ url, sourceUrl, type, … }: Partial<RequestInitialization>): Request` (import `Request` from `@ghostery/adblocker`; `ElectronBlocker` from `@ghostery/adblocker-electron`). `type: 'document'` is a valid `RequestType`. `ElectronBlocker.parse(text: string)` builds an engine from filter text — same as `buildEngine(listTexts, null)` in `electron/main/adblock/engine.ts:46` (`ElectronBlocker.parse(listTexts.join('\n'))`).
- **CRITICAL — single session listener:** `AdblockController` (`electron/main/adblock/controller.ts`) attaches the ad engine via `enableBlockingInSession`/`disableBlockingInSession`; a 2nd `enableBlockingInSession` on the same `persist:content` session would clobber the ad engine. MalwareGuard is therefore **in-memory `.match()` only**; subresource malware blocking is achieved by **merging malware texts into the main engine**.
- **Refresh seams** (`electron/main/index.ts`):
  - `runRefresh()` (≈286-310): `fetchAll(resolveRefreshSubs(subsRepo.all(), LIST_BASE), {cacheDir: listsCacheDir, …})` → `usable = sources.filter(s => s.ok && s.text.length>0)` → `assembleEngineTexts(usable.map(s=>s.text), customFiltersRepo.get())` → `buildEngine(texts, resources)` → `controller.setPendingBlocker(engine)` → `serializeEngine(engine, cachePath)`.
  - `rebuildEngineFromCache()` (≈321-332): reads `lists/<listId>.txt` for enabled subs → `assembleEngineTexts(listTexts, customFiltersRepo.get())` → `buildEngine(texts, null)` → `setPendingBlocker`.
  - `assembleEngineTexts(listTexts: string[], customFilters: string): string[]` (`refreshHelpers.ts`) — appends `customFilters` when non-empty. **Append malware texts to the first arg at both sites.**
- **Fetch + cache helpers:** `fetchSource(url, {timeoutMs, maxBytes, fetchImpl}): Promise<{text, etag}>` and `fetchAll(subs, {cacheDir, timeoutMs, maxBytes, resourcesUrl, fetchImpl?})` (`electron/main/adblock/listManager.ts`); `writeFileAtomic(path, data)` / `readFileSafe(path): string|null` (`electron/lib/atomicFile.ts`). Per-list cache file = `join(cacheDir, '<listId>.txt')`. Constants in scope at the refresh site: `FETCH_TIMEOUT_MS`, `FETCH_MAX_BYTES`, `refreshFetch`, `OFFLINE`, `TEST_FILTER`, `LIST_BASE`, `userData`, `listsCacheDir = join(userData,'lists')`.
- **Boot engine init** (`index.ts:236-258`): `TEST_FILTER` (env `AEGIS_ADBLOCK_TEST_FILTER`) → deterministic e2e engine; else cache→snapshot→empty `buildEngine([], null)`. First-nav gating: `controller.primeFor(firstUrl); safety!.navigate(firstUrl);` (≈410-412); background refresh kicked `if (!OFFLINE && !TEST_FILTER)` (≈424).
- **Subscriptions are user-toggleable:** `subsRepo` (`filter_subscriptions`) rows are all exposed via `subsList`/`subsSetEnabled`/`subsRemove` to the filter-list-manager UI. **Malware lists must NOT be `filter_subscriptions` rows** — keep them a hardcoded constant so they can't be toggled off.
- **3a SafetyController** (`electron/main/safety/SafetyController.ts`): deps `{navigateView, httpExceptions, getHttpsOnly, onInterstitial}`; `navigate`, `resolveUpgrade`, `handleNavFailed`, `handleNavCommitted`, `proceed` (guards `url===current.url`, persists `normalizeHost(host)` to `httpExceptions`), `getState`, private `raise`/`dismiss`. `normalizeHost` exported from `./httpsUpgrade`.

## Design decision (documented): no serialized malware seed
The 14 MB ad `engine-seed.bin` exists because dozens of ad lists are slow to fetch. Malware = 1–3 small lists. **MalwareGuard boots from the `malware-lists/` cache (empty on a fresh profile)** and is populated by the first background `runRefresh`; the cache makes every later boot immediate. The only gap is the first few seconds of the *first-ever online* run — and an offline first-run can't reach a malware site anyway. So no `generate-malware-seed.mjs` / vite copy / `extraResources` / `resolveMalwareSeedPath`. (Justified deviation from spec §3.3 "seeded like the ad lists".)

## Open verifications (resolve during impl — like spec §7)
1. **Document-type match:** confirm a plain domain rule (e.g. `||evil.example^`) matches `engine.match(Request.fromRawDetails({type:'document', url, sourceUrl:url}))`. Task 2's red→green test is the proof. If `'document'` doesn't match, try `'mainFrame'`/`'main_frame'` (all valid `RequestType`s) and use whichever matches; report the result.
2. **Real list formats parse:** URLhaus (hosts format) + Phishing Army (domain list) must parse via `ElectronBlocker.parse`. The runtime feature depends on this; e2e uses a deterministic ABP test rule (`AEGIS_MALWARE_TEST_FILTER`), so list-format issues surface only at real runtime — flag for follow-up if a list parses to zero filters.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `electron/main/adblock/malwareLists.ts` (create) | `MALWARE_LIST_URLS` constant + `refreshMalwareTexts()` (fetch+cache) + `readMalwareCacheTexts()` (cache-only). |
| `electron/main/safety/MalwareGuard.ts` (create) | In-memory engine holder: `isMalicious(url)` via `.match()`, `setActive(engine)`. |
| `electron/main/safety/SafetyController.ts` (modify) | `malware` dep + session `malwareBypass` + `checkMalicious`; `navigate` checks malware first; `proceed` branches on `reason`. |
| `electron/main/viewController.ts` (modify) | `onBlockedNavigation?` gate hook (preventDefault when malicious). |
| `electron/main/index.ts` (modify) | Construct `MalwareGuard` (cache/`AEGIS_MALWARE_TEST_FILTER`); wire `safety.malware` + gate hook; malware fetch/merge in `runRefresh`/`rebuildEngineFromCache`. |
| `shared/types.ts` (modify) | `SafetyInterstitialPayload.reason: 'https-failed' \| 'malware'`. |
| `src/components/SafetyInterstitial.tsx` (modify) | Malware-variant copy/styling. |
| `src/components/SecurityTab.tsx` (modify) | Read-only "Malicious-site protection: On" status. |
| `src/index.css` (modify) | `.interstitial--malware` accent. |
| `electron/test/e2e/malware.spec.ts` (create) | malicious-host → interstitial → continue → loads (session bypass); ad-block + normal nav unaffected. |

## Out of scope
- Real Google Safe Browsing (Electron strips it — spec Tier-3 non-goal). This is a list-based "Safe-Browsing-lite".
- Per-site persisted malware exceptions (malware bypass is **session-only** by design — "protected").

---

## Task 1: Malware list constant + fetch/cache helpers

**Files:** Create `electron/main/adblock/malwareLists.ts`; Test `electron/main/adblock/malwareLists.test.ts`.

- [ ] **Step 1: Write the failing test** — `electron/main/adblock/malwareLists.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MALWARE_LIST_URLS, readMalwareCacheTexts } from './malwareLists';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aegis-malware-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('MALWARE_LIST_URLS', () => {
  it('is a non-empty list of { listId, url } with https urls and unique ids', () => {
    expect(MALWARE_LIST_URLS.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const e of MALWARE_LIST_URLS) {
      expect(typeof e.listId).toBe('string');
      expect(e.url.startsWith('https://')).toBe(true);
      ids.add(e.listId);
    }
    expect(ids.size).toBe(MALWARE_LIST_URLS.length);
  });
});

describe('readMalwareCacheTexts', () => {
  it('returns [] when no cache files exist', () => {
    expect(readMalwareCacheTexts(dir)).toEqual([]);
  });

  it('reads cached <listId>.txt for each known list, skipping missing/empty', () => {
    const first = MALWARE_LIST_URLS[0];
    writeFileSync(join(dir, `${first.listId}.txt`), '||evil.example^\n');
    const texts = readMalwareCacheTexts(dir);
    expect(texts).toContain('||evil.example^\n');
    expect(texts.length).toBe(1); // only the one we wrote
  });
});
```

- [ ] **Step 2: Run it (red)** — `npx vitest run electron/main/adblock/malwareLists.test.ts` → module not found.

- [ ] **Step 3: Implement** — `electron/main/adblock/malwareLists.ts`:

```ts
// electron/main/adblock/malwareLists.ts
// Curated malware/phishing blocklists for the MalwareGuard + main-engine
// subresource blocking. Deliberately a hardcoded constant (NOT filter_subscriptions
// rows) so the category is on-by-default and not user-toggleable. Fetched/cached
// alongside the ad lists (own cache dir); no serialized seed (see the Phase 3b plan).
import { join } from 'node:path';
import { fetchSource } from './listManager';
import { writeFileAtomic, readFileSafe } from '../../lib/atomicFile';

export const MALWARE_LIST_URLS: { listId: string; url: string }[] = [
  // URLhaus (abuse.ch) — active malware-distribution hosts (hosts format).
  { listId: 'urlhaus', url: 'https://urlhaus.abuse.ch/downloads/hostfile/' },
  // Phishing Army — extended phishing blocklist (domain list).
  { listId: 'phishing-army', url: 'https://phishing.army/download/phishing_army_blocklist_extended.txt' },
];

export interface MalwareFetchOpts {
  cacheDir: string;
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch each malware list (atomically caching it), falling back to the on-disk
 * cache on failure. Returns the usable list texts (for the MalwareGuard build AND
 * the main-engine subresource merge). No $redirect resources (malware lists don't
 * use them), so this does NOT call fetchAll (which always refetches resources).
 */
export async function refreshMalwareTexts(opts: MalwareFetchOpts): Promise<string[]> {
  const texts: string[] = [];
  for (const { listId, url } of MALWARE_LIST_URLS) {
    const cachePath = join(opts.cacheDir, `${listId}.txt`);
    try {
      const { text } = await fetchSource(url, {
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
        fetchImpl: opts.fetchImpl,
      });
      writeFileAtomic(cachePath, text);
      if (text.length > 0) texts.push(text);
    } catch {
      const cached = readFileSafe(cachePath);
      if (cached !== null && cached.length > 0) texts.push(cached);
    }
  }
  return texts;
}

/** Read the cached malware list texts (no network). Used at boot + cache rebuilds. */
export function readMalwareCacheTexts(cacheDir: string): string[] {
  const texts: string[] = [];
  for (const { listId } of MALWARE_LIST_URLS) {
    const text = readFileSafe(join(cacheDir, `${listId}.txt`));
    if (text !== null && text.length > 0) texts.push(text);
  }
  return texts;
}
```

- [ ] **Step 4: Run it (green)** — `npx vitest run electron/main/adblock/malwareLists.test.ts` → pass.

- [ ] **Step 5: Commit**

```bash
git add electron/main/adblock/malwareLists.ts electron/main/adblock/malwareLists.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): add malware blocklist constant + fetch/cache helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: MalwareGuard (in-memory `.match()` engine) — verifies the document-match API

**Files:** Create `electron/main/safety/MalwareGuard.ts`; Test `electron/main/safety/MalwareGuard.test.ts`.

- [ ] **Step 1: Write the failing test** — `electron/main/safety/MalwareGuard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEngine } from '../adblock/engine';
import { MalwareGuard } from './MalwareGuard';

describe('MalwareGuard', () => {
  it('isMalicious is true for a host matched by a domain rule, false otherwise', () => {
    const guard = new MalwareGuard(buildEngine(['||evil.example^'], null));
    expect(guard.isMalicious('http://evil.example/path')).toBe(true);
    expect(guard.isMalicious('https://evil.example/')).toBe(true);
    expect(guard.isMalicious('https://good.example/')).toBe(false);
  });

  it('an empty engine matches nothing', () => {
    const guard = new MalwareGuard(buildEngine([], null));
    expect(guard.isMalicious('http://evil.example/')).toBe(false);
  });

  it('setActive swaps the engine', () => {
    const guard = new MalwareGuard(buildEngine([], null));
    expect(guard.isMalicious('http://evil.example/')).toBe(false);
    guard.setActive(buildEngine(['||evil.example^'], null));
    expect(guard.isMalicious('http://evil.example/')).toBe(true);
  });

  it('returns false (never throws) for an unparseable url', () => {
    const guard = new MalwareGuard(buildEngine(['||evil.example^'], null));
    expect(guard.isMalicious('not a url')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it (red)** — `npx vitest run electron/main/safety/MalwareGuard.test.ts` → module not found.

- [ ] **Step 3: Implement** — `electron/main/safety/MalwareGuard.ts`:

```ts
// electron/main/safety/MalwareGuard.ts
// A second @ghostery engine consulted IN-MEMORY for top-level document checks.
// It MUST NOT call enableBlockingInSession — the AdblockController owns the single
// persist:content webRequest listener (a 2nd would clobber the ad engine). Malware
// subresource blocking is done by merging the malware texts into the MAIN engine.
import type { ElectronBlocker } from '@ghostery/adblocker-electron';
import { Request } from '@ghostery/adblocker';

export class MalwareGuard {
  private engine: ElectronBlocker;

  constructor(engine: ElectronBlocker) {
    this.engine = engine;
  }

  /** Swap in a rebuilt malware engine (after a refresh). */
  setActive(engine: ElectronBlocker): void {
    this.engine = engine;
  }

  /** True if `url` (a top-level document target) matches a malware/phishing rule. */
  isMalicious(url: string): boolean {
    try {
      const req = Request.fromRawDetails({ type: 'document', url, sourceUrl: url });
      return this.engine.match(req).match === true;
    } catch {
      return false;
    }
  }
}
```

> **If Step 4 fails** (a domain rule does NOT match `type: 'document'`): change `type` to `'mainFrame'` then `'main_frame'` until the first test goes green, and report which `RequestType` matched (open verification #1). Do NOT weaken the test — the document-level match MUST work.

- [ ] **Step 4: Run it (green)** — `npx vitest run electron/main/safety/MalwareGuard.test.ts` → pass. Report which `type` value matched.

- [ ] **Step 5: Commit**

```bash
git add electron/main/safety/MalwareGuard.ts electron/main/safety/MalwareGuard.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): add in-memory MalwareGuard (.match document check)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend the interstitial reason type

**Files:** Modify `shared/types.ts`.

- [ ] **Step 1: Widen the union** — in `SafetyInterstitialPayload`, change `reason: 'https-failed';` to:

```ts
  reason: 'https-failed' | 'malware';
```

- [ ] **Step 2: Build** — `npm run build` → success (existing `'https-failed'` literals still assignable). Commit.

```bash
git add shared/types.ts
git commit -m "$(cat <<'EOF'
feat(safety): extend SafetyInterstitialPayload.reason with 'malware'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: SafetyController malware check + session bypass

**Files:** Modify `electron/main/safety/SafetyController.ts`; Modify `electron/main/safety/SafetyController.test.ts`.

- [ ] **Step 1: Write failing tests** — add to `SafetyController.test.ts`. First extend the `setup()` helper to inject a malware predicate, then add a describe. Update the existing `setup` (find it) to add a `malware` dep:

```ts
// In setup(opts), add an injectable malicious-host set:
//   const malicious = opts?.malicious ?? new Set<string>();
//   ... new SafetyController({ ..., malware: { isMalicious: (url) => { try { return malicious.has(new URL(url).hostname); } catch { return false; } } } })
// and return { ..., malicious }.
```

Then add:

```ts
describe('SafetyController malware', () => {
  it('navigate() raises a malware interstitial and does NOT navigate a malicious host', () => {
    const { sc, navigateView, events } = setup({ malicious: new Set(['evil.example']) });
    sc.navigate('http://evil.example/');
    expect(navigateView).not.toHaveBeenCalled();
    expect(sc.getState()).toEqual({ url: 'http://evil.example/', reason: 'malware' });
    expect(events.at(-1)).toEqual({ url: 'http://evil.example/', reason: 'malware' });
  });

  it('checkMalicious returns false (no interstitial) for a clean host', () => {
    const { sc } = setup({ malicious: new Set(['evil.example']) });
    expect(sc.checkMalicious('https://good.example/')).toBe(false);
    expect(sc.getState()).toBeNull();
  });

  it('proceed on a malware interstitial adds a SESSION bypass (not persisted) and reloads', () => {
    const { sc, navigateView, exceptions } = setup({ malicious: new Set(['evil.example']) });
    sc.navigate('http://evil.example/');
    navigateView.mockClear();
    sc.proceed('http://evil.example/');
    expect(navigateView).toHaveBeenCalledWith('http://evil.example/');
    expect(sc.getState()).toBeNull();
    expect(exceptions.has('evil.example')).toBe(false); // NOT in the persisted http exceptions
    // bypass is in effect: a second nav is allowed through
    navigateView.mockClear();
    sc.navigate('http://evil.example/');
    expect(navigateView).toHaveBeenCalledWith('http://evil.example/');
    expect(sc.getState()).toBeNull();
  });

  it('malware takes priority over the https upgrade (no upgrade attempted)', () => {
    const { sc, navigateView } = setup({ malicious: new Set(['evil.example']) });
    sc.navigate('http://evil.example/');
    expect(navigateView).not.toHaveBeenCalled(); // not upgraded, not loaded
  });
});
```

- [ ] **Step 2: Run (red)** — `npx vitest run electron/main/safety/SafetyController.test.ts` → fails (no `malware` dep / `checkMalicious`).

- [ ] **Step 3: Implement** — in `SafetyController.ts`:

  (a) Extend deps + add the bypass field + import nothing new (`normalizeHost` already imported):

```ts
export interface MalwareLike {
  isMalicious(url: string): boolean;
}

export interface SafetyControllerDeps {
  navigateView: (url: string) => void;
  httpExceptions: HttpExceptionsLike;
  getHttpsOnly: () => boolean;
  onInterstitial: (p: SafetyInterstitialPayload | null) => void;
  malware: MalwareLike;
}
```
```ts
export class SafetyController {
  private current: SafetyInterstitialPayload | null = null;
  private lastUpgrade: { from: string; to: string } | null = null;
  private readonly malwareBypass = new Set<string>(); // session-only "continue anyway" hosts
```

  (b) Add `checkMalicious` (place after `resolveUpgrade`):

```ts
  /**
   * If `url` is a non-bypassed malicious host, raise the malware interstitial and
   * return true (caller must NOT navigate). Else false. Session-only bypass.
   */
  checkMalicious(url: string): boolean {
    let host: string;
    try {
      host = normalizeHost(new URL(url).hostname);
    } catch {
      return false;
    }
    if (this.malwareBypass.has(host)) return false;
    if (!this.deps.malware.isMalicious(url)) return false;
    this.raise({ url, reason: 'malware' });
    return true;
  }
```

  (c) `navigate` checks malware FIRST:

```ts
  navigate(url: string): void {
    if (this.current !== null) this.dismiss();
    this.lastUpgrade = null;
    if (this.checkMalicious(url)) return; // malware -> interstitial, do not navigate
    const upgraded = this.resolveUpgrade(url);
    this.deps.navigateView(upgraded ?? url);
  }
```

  (d) `proceed` branches on the interstitial reason (capture it BEFORE dismiss):

```ts
  proceed(url: string): void {
    if (this.current === null || url !== this.current.url) return;
    const reason = this.current.reason;
    try {
      const host = normalizeHost(new URL(url).hostname);
      if (host) {
        if (reason === 'malware') {
          this.malwareBypass.add(host); // session-only, never persisted
        } else {
          this.deps.httpExceptions.add(host); // https-failed: persisted
        }
      }
    } catch {
      /* malformed url — skip persistence, still attempt the load */
    }
    this.dismiss();
    this.deps.navigateView(url);
  }
```

- [ ] **Step 4: Run (green)** — `npx vitest run electron/main/safety/SafetyController.test.ts` → all pass (prior 17 + new). Report count.

- [ ] **Step 5: Commit**

```bash
git add electron/main/safety/SafetyController.ts electron/main/safety/SafetyController.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): SafetyController malware check + session-only bypass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: ViewController malware gate hook

**Files:** Modify `electron/main/viewController.ts`; Modify `electron/main/viewController.test.ts`.

- [ ] **Step 1: Add the opt** — in `ViewControllerOpts`, after `upgradeNavigation`:

```ts
  /** Malware gate: return true to BLOCK this navigation (the hook raises its own interstitial). */
  onBlockedNavigation?: (url: string) => boolean;
```

- [ ] **Step 2: Use it in the gate** — in the `gate` closure, add the malware check AFTER the scheme block and BEFORE the upgrade:

```ts
const gate = (event: { preventDefault: () => void }, url: string) => {
  if (!isAllowedNavigationUrl(url)) {
    event.preventDefault();
    return;
  }
  if (this.opts.onBlockedNavigation?.(url)) {
    event.preventDefault();
    return;
  }
  const upgraded = this.opts.upgradeNavigation?.(url) ?? null;
  if (upgraded && upgraded !== url) {
    event.preventDefault();
    this.wc().loadURL(upgraded);
  }
};
```

- [ ] **Step 3: Add a test** — in `viewController.test.ts`, mirroring the existing gate tests (`wc._emit('will-navigate', ev, url)`): assert that when `onBlockedNavigation` returns true, `ev.preventDefault()` is called and `wc.loadURL` is NOT called (and `upgradeNavigation` is not consulted). Add a 2nd case: `onBlockedNavigation` returns false → falls through to the upgrade path as before.

- [ ] **Step 4: Build + suite** — `npm run build` → success; `npm test` → green (report count). Commit.

```bash
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "$(cat <<'EOF'
feat(safety): add onBlockedNavigation (malware) hook to the nav gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Wire MalwareGuard into boot + refresh (index.ts)

**Files:** Modify `electron/main/index.ts`.

> This is the integration-critical task. READ `index.ts:218-340` + `:405-426` first; match the real surrounding code.

- [ ] **Step 1: Imports** — add:

```ts
import { MalwareGuard } from './safety/MalwareGuard';
import { MALWARE_LIST_URLS, refreshMalwareTexts, readMalwareCacheTexts } from './adblock/malwareLists';
```

- [ ] **Step 2: A malware cache dir + the guard** — after `const listsCacheDir = join(userData, 'lists');` add:

```ts
  const malwareListsCacheDir = join(userData, 'malware-lists');
```
  After the `const TEST_FILTER = …` block (the e2e hooks), add a malware e2e hook + construct the guard from the cache (or the test filter). Place AFTER the ad-engine `initialBlocker` block and `MALWARE_LIST_URLS` is available:

```ts
  // MalwareGuard: an in-memory engine for top-level document checks (NEVER attached
  // to the session). Seed from the on-disk cache (immediate on later boots); empty on
  // a fresh profile until the first refresh. AEGIS_MALWARE_TEST_FILTER gives e2e a
  // deterministic rule set (mirrors AEGIS_ADBLOCK_TEST_FILTER).
  const MALWARE_TEST_FILTER = process.env.AEGIS_MALWARE_TEST_FILTER;
  const malwareGuard = new MalwareGuard(
    MALWARE_TEST_FILTER
      ? buildEngine(splitNonEmptyLines(MALWARE_TEST_FILTER), null)
      : buildEngine(readMalwareCacheTexts(malwareListsCacheDir), null),
  );
```
(`splitNonEmptyLines` is already imported for `TEST_FILTER`; confirm and reuse it.)

- [ ] **Step 3: Pass `malware` into the SafetyController construction** — add to the `new SafetyController({ … })` deps:

```ts
    malware: malwareGuard,
```

- [ ] **Step 4: Wire the gate hook** — in the `new ViewController({ … })` opts, add:

```ts
    onBlockedNavigation: (url) => safety?.checkMalicious(url) ?? false,
```

- [ ] **Step 5: Merge malware into `runRefresh`** — replace the body of `runRefresh` from the `usable` line through the `if (usable.length > 0) { … }` block with (skip the malware fetch under TEST_FILTER, which has its own deterministic engine):

```ts
    const usable = sources.filter((s) => s.ok && s.text.length > 0);
    // Malware lists: fetch+cache (own dir), rebuild the in-memory MalwareGuard, and
    // merge their texts into the MAIN engine so malicious SUBresources are blocked too.
    // Skip the fetch under any deterministic/offline mode — including MALWARE_TEST_FILTER
    // (e2e) so a background refresh can't overwrite the test engine.
    const skipMalwareFetch = TEST_FILTER || MALWARE_TEST_FILTER || OFFLINE;
    const malwareTexts = skipMalwareFetch
      ? []
      : await refreshMalwareTexts({
          cacheDir: malwareListsCacheDir,
          timeoutMs: FETCH_TIMEOUT_MS,
          maxBytes: FETCH_MAX_BYTES,
          fetchImpl: refreshFetch as typeof fetch,
        });
    // Only swap the in-memory guard when we actually fetched rules — never wipe the
    // boot-loaded (cache or AEGIS_MALWARE_TEST_FILTER) engine with an empty one.
    if (malwareTexts.length > 0) malwareGuard.setActive(buildEngine(malwareTexts, null));
    if (usable.length > 0 || malwareTexts.length > 0) {
      const texts = assembleEngineTexts(
        [...usable.map((s) => s.text), ...malwareTexts],
        customFiltersRepo.get(),
      );
      const engine = buildEngine(texts, resources);
      controller.setPendingBlocker(engine);
      serializeEngine(engine, cachePath);
      for (const s of usable) {
        subsRepo.updateMeta(s.listId, { lastUpdated, etag: s.etag, hash: s.hash });
      }
    }
```

- [ ] **Step 6: Merge malware into `rebuildEngineFromCache`** — replace its body with:

```ts
    const listTexts: string[] = [];
    for (const sub of subsRepo.all()) {
      if (!sub.enabled) continue;
      const text = readFileSafe(join(listsCacheDir, `${sub.listId}.txt`));
      if (text !== null && text.length > 0) listTexts.push(text);
    }
    const malwareTexts = readMalwareCacheTexts(malwareListsCacheDir);
    if (malwareTexts.length > 0) malwareGuard.setActive(buildEngine(malwareTexts, null));
    const texts = assembleEngineTexts([...listTexts, ...malwareTexts], customFiltersRepo.get());
    const engine = buildEngine(texts, null);
    controller.setPendingBlocker(engine);
    serializeEngine(engine, cachePath);
```

- [ ] **Step 7: Build + full suite** — `npm run build` → success; `npm test` → green (report count). Commit.

```bash
git add electron/main/index.ts
git commit -m "$(cat <<'EOF'
feat(safety): wire MalwareGuard into boot, nav gate, and the refresh path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Interstitial malware variant (renderer)

**Files:** Modify `src/components/SafetyInterstitial.tsx`; Modify `src/components/SafetyInterstitial.test.tsx`; Modify `src/index.css`.

- [ ] **Step 1: Add a failing test** — in `SafetyInterstitial.test.tsx`, add:

```ts
it('renders the malware variant with a danger heading + Continue anyway', async () => {
  const onProceed = vi.fn();
  render(
    <SafetyInterstitial
      interstitial={{ url: 'http://evil.example/', reason: 'malware' }}
      onProceed={onProceed}
    />,
  );
  expect(screen.getByText(/dangerous|malicious|deceptive/i)).toBeInTheDocument();
  expect(screen.getByText(/evil\.example/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /continue anyway/i }));
  expect(onProceed).toHaveBeenCalledWith('http://evil.example/');
});
```
(Keep the existing https-failed tests; ensure the https button text still matches `/continue to http/i`.)

- [ ] **Step 2: Run (red)** — `npx vitest run src/components/SafetyInterstitial.test.tsx` → the malware case fails.

- [ ] **Step 3: Implement the variant** — branch on `interstitial.reason`:

```tsx
export function SafetyInterstitial({
  interstitial,
  onProceed,
}: {
  interstitial: SafetyInterstitialPayload | null;
  onProceed: (url: string) => void;
}) {
  if (interstitial === null) return null;
  const host = safeHost(interstitial.url);
  const malware = interstitial.reason === 'malware';
  return (
    <div
      className={`interstitial${malware ? ' interstitial--malware' : ''}`}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="interstitial-title"
    >
      <div className="interstitial__panel">
        <h1 id="interstitial-title" className="interstitial__title">
          {malware ? 'Dangerous site blocked' : 'This site isn’t available over a secure connection'}
        </h1>
        <p className="interstitial__body">
          {malware ? (
            <>
              <strong>{host}</strong> is on a malware/phishing blocklist and may try to steal your
              information or harm your device. We strongly recommend you go back.
            </>
          ) : (
            <>
              Aegis tried to load <strong>{host}</strong> securely over HTTPS, but the secure
              connection failed. Continuing will load this site over an unencrypted <strong>HTTP</strong>{' '}
              connection, which others on your network may be able to read or modify.
            </>
          )}
        </p>
        <div className="interstitial__actions">
          <button type="button" className="interstitial__continue" onClick={() => onProceed(interstitial.url)}>
            {malware ? 'Continue anyway (not recommended)' : 'Continue to HTTP for this site'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: CSS accent** — append to `src/index.css`:

```css
.interstitial--malware {
  background: #1a0b0b;
}
.interstitial--malware .interstitial__panel {
  border-color: #7f1d1d;
}
.interstitial--malware .interstitial__title {
  color: #fca5a5;
}
```

- [ ] **Step 5: Run (green)** — `npx vitest run src/components/SafetyInterstitial.test.tsx` → all pass. Commit.

```bash
git add src/components/SafetyInterstitial.tsx src/components/SafetyInterstitial.test.tsx src/index.css
git commit -m "$(cat <<'EOF'
feat(safety): add malware variant to the safety interstitial

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Security tab — malware-protection status

**Files:** Modify `src/components/SecurityTab.tsx`; Modify `src/components/SecurityTab.test.tsx`.

- [ ] **Step 1: Add a failing test** — in `SecurityTab.test.tsx`:

```ts
it('shows malicious-site protection as on (always)', () => {
  render(
    <SecurityTab settings={baseSettings} update={vi.fn()} listExceptions={async () => []} removeException={vi.fn()} />,
  );
  expect(screen.getByText(/malicious-site protection/i)).toBeInTheDocument();
  expect(screen.getByText(/\bon\b/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run (red)** — `npx vitest run src/components/SecurityTab.test.tsx` → the new case fails.

- [ ] **Step 3: Implement** — add a read-only status block to `SecurityTab` (after the httpsOnly toggle, matching the sibling markup classes):

```tsx
      <h3 className="settings-subhead">Malicious-site protection</h3>
      <p className="settings-empty">
        On — known malware and phishing sites are blocked with a warning. This protection is always
        active and can’t be turned off.
      </p>
```
(Use the REAL class names the tab already uses; the strings above are the content.)

- [ ] **Step 4: Run (green)** + `npm test` → green. Commit.

```bash
git add src/components/SecurityTab.tsx src/components/SecurityTab.test.tsx
git commit -m "$(cat <<'EOF'
feat(safety): show malicious-site protection status in the Security tab

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: e2e — malicious-site interstitial + bypass

**Files:** Create `electron/test/e2e/malware.spec.ts`.

- [ ] **Step 1: Learn the harness** — read `electron/test/e2e/httpsOnly.spec.ts` (3a) + `nav.spec.ts` + `fixtureServer.ts`. Key facts to reuse: per-test `launchApp(dir, extraEnv)`; the fixture HTTP server (`fixtures.baseUrl`); HTTPS-Only nav must go through `window.aegis.nav.navigate(viewId, url)` via the chrome WC (the `__aegisTest.primary.navigate` path BYPASSES SafetyController); `.interstitial` DOM + `window.aegis.safety.getState()`/`proceed()`.

- [ ] **Step 2: Write the scenarios** — launch with `AEGIS_MALWARE_TEST_FILTER` set to a deterministic rule that matches the fixture host, e.g. `{ AEGIS_MALWARE_TEST_FILTER: '||127.0.0.1^', AEGIS_HTTPS_ONLY: '0' }` (httpsOnly off so the http upgrade doesn't interfere; pick a rule that matches the fixture host — confirm the fixture host and craft the rule accordingly, e.g. the list-base host):
  1. **Malware interstitial:** navigate (via `aegis.nav.navigate`) to a fixture URL whose host the test filter blocks; assert `aegis.safety.getState()` returns `{reason:'malware', url}` and the `.interstitial.interstitial--malware` DOM appears; assert the page did NOT load the target.
  2. **Continue anyway → session bypass:** click "Continue anyway"; assert the page then loads; navigate away and back to the same host and assert it loads WITHOUT the interstitial (session bypass in effect).
  3. **Clean host unaffected:** a non-blocked fixture host loads normally with no interstitial.
  4. (If feasible) **Subresource block:** a page that requests a subresource from the blocked host has that request blocked (ad-block counter or a missing resource) — only if the harness already asserts subresource blocking elsewhere; else skip with a documented note.

- [ ] **Step 3: Run** — `npm run test:e2e`. Report ACTUAL output. Honestly note any skipped scenario.

- [ ] **Step 4: Commit**

```bash
git add electron/test/e2e/malware.spec.ts
git commit -m "$(cat <<'EOF'
test(safety): e2e for malicious-site interstitial + session bypass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all tasks)
- [ ] `npm test` → full unit/jsdom suite green (report count).
- [ ] `npm run build` → success.
- [ ] `npm run test:e2e` → report actual (note any skip honestly).
- [ ] Manual smoke (dev): with `AEGIS_MALWARE_TEST_FILTER='||example.com^'`, navigate to `http://example.com` → malware interstitial; "Continue anyway" loads it; a clean host is unaffected; ad-blocking still works.

## Success criteria (spec §3.3 malicious-site + §6.3)
| Requirement | Delivered by |
| --- | --- |
| Known-malicious top-level nav blocked with a warning interstitial | Tasks 2, 4, 5, 6, 7 |
| Malicious subresources network-blocked (lists merged into main engine) | Task 6 |
| Malware category on by default, not user-toggleable | Task 1 (constant outside `filter_subscriptions`) + Task 8 (status only) |
| Reuses the 3a interstitial framework | Tasks 3, 4, 7 (`reason:'malware'`) |
| Lists refreshed by the existing scheduler | Task 6 (`runRefresh`/`rebuildEngineFromCache`) |
| No regression | Final verification: `npm test` + build + e2e |
