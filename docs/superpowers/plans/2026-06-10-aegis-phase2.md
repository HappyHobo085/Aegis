# Aegis Phase 2 — Cosmetic + Anti-Adblock Verification & Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the already-live cosmetic (Layer 2) + scriptlet/anti-adblock (Layer 3) engine layers with deterministic in-repo fixtures, and lightly harden the popup gate by extracting it to a pure, unit-testable module.

**Architecture:** The `@ghostery/adblocker` engine already runs at full defaults (Phase 1), so cosmetics + scriptlets execute on the content view. Phase 2 adds (a) a pure `electron/main/windowOpen.ts` (`decideWindowOpen`) extracted from `ViewController.wireSecurity`, (b) an extended e2e boot hook (multi-line `AEGIS_ADBLOCK_TEST_FILTER` + `AEGIS_ADBLOCK_TEST_RESOURCES`) for deterministic cosmetic/scriptlet tests, and (c) Playwright `_electron` fixture suites proving cosmetic hiding, scriptlet/anti-adblock defusing, and popup/redirect behavior.

**Tech Stack:** Electron 42.4.0 · @ghostery/adblocker(-electron) 2.18.0 · React 19 + TS · Vitest 4 (`node`+`jsdom`) · Playwright `_electron`. Branch `phase-2` (off `main`; LOCAL commits only).

**Companion contract (authoritative reference):** `docs/superpowers/plans/2026-06-10-aegis-phase2-contract.md` — §1 source-verified `@ghostery/adblocker` facts (cosmetic + scriptlet injection probes, `HandlerDetails` has no gesture flag), §2 as-built integration, §3 test-hook extension, §4 interface ledger, §5 conventions, §6 task skeleton, **§8 review-driven corrections (override §1–§7)**.

---

## §0 — How this plan was built + corrections applied (already incorporated below)

Drafted by 3 parallel block-drafters against the source-verified contract, then adversarially reviewed. The first review (NEEDS REVISION) caught: the dropped `save-to-disk` branch silently breaking the existing `viewController.test.ts`; a `string[]` needing `as const`; `windows().length===1` being wrong for the chrome+content two-view architecture; an async-scriptlet race; and a `{{n}}`-token scriptlet-substitution bug. All were encoded as contract **§8** and the plan was regenerated against it (every §8 item verified applied below).

**One additional correction applied during assembly (the structured re-review agent failed to return, so the controller self-reviewed against §8 + for correctness):**
- **Task 5, test 1 (allowed `window.open`)** was reworked: the drafted `popunder-allowed.html` **auto-fired `window.open` on load**, so a routed-in-place navigation would move the content view off the fixture *during load* and `navigateAndSettle(fixtureUrl)` could never settle (hang). Also, route-in-place only happens for *foreground* dispositions, which Electron's `HandlerDetails` can't be forced to in a hermetic test. Fixed: test 1 uses the **trigger-based** `popunder-blank.html` fixture (`window.__aegisOpenPopunder(url)`, no auto-fire), settles on the fixture cleanly, then triggers the open and asserts the **deterministic, disposition-independent** guarantee — an allowed-scheme `window.open` opens **no real popup window** (`windows().length` unchanged). The route-in-place behavior is covered deterministically by the Task-1 `windowOpen.test.ts` unit test (and the existing `viewController.test.ts`). Tests 2 (disallowed-scheme → deny, no route) and 3 (hostile redirect → blocked) are unchanged. `popunder-allowed.html` is removed.

---

I now have all the source-verified facts. Here is the Block A task markdown.

### Task 1: Extract `decideWindowOpen` policy + unit test; delegate from `ViewController.wireSecurity`

**Files:**
- Create: `electron/main/windowOpen.ts`
- Create (Test): `electron/main/windowOpen.test.ts`
- Modify: `electron/main/viewController.ts:170-185` (the inline `setWindowOpenHandler` body) + add `import { decideWindowOpen } from './windowOpen';`
- Modify: `electron/main/viewController.test.ts:459` (drop `'save-to-disk'` from the popunder-deny loop — this is an intentional **behavior change**, see §8.1)

Removing the dead `'save-to-disk'` branch is a real behavior change, NOT a no-op refactor: `'save-to-disk'` is not a member of the Electron 42.4.0 `HandlerDetails.disposition` enum (`default|foreground-tab|background-tab|new-window|other`, §1), so the old branch was unreachable in practice. Under the new policy a (hypothetical) `'save-to-disk'` with an allowed URL would route in-place rather than be denied. We therefore also fix the one existing unit test that asserted the old dead behavior.

- [ ] **Step 1: Write the failing test**

Create `electron/main/windowOpen.test.ts`:
```ts
// electron/main/windowOpen.test.ts
import { describe, it, expect } from 'vitest';
import { decideWindowOpen } from './windowOpen';

// The real Electron 42.4.0 HandlerDetails.disposition enum (no 'save-to-disk').
const dispositions = [
  'default',
  'foreground-tab',
  'background-tab',
  'new-window',
  'other',
] as const;

describe('decideWindowOpen', () => {
  it("denies the popunder dispositions ('background-tab', 'other') regardless of URL", () => {
    for (const disposition of ['background-tab', 'other'] as const) {
      expect(decideWindowOpen({ url: 'https://ok.test/page', disposition })).toEqual({
        action: 'deny',
      });
      // even an otherwise-allowed scheme must not route in-place for these
      expect('loadInPlace' in decideWindowOpen({ url: 'https://ok.test/page', disposition })).toBe(
        false,
      );
    }
  });

  it('routes an allowed-scheme new-window in-place for the non-popunder dispositions', () => {
    for (const disposition of ['default', 'foreground-tab', 'new-window'] as const) {
      expect(decideWindowOpen({ url: 'https://ok.test/page', disposition })).toEqual({
        action: 'deny',
        loadInPlace: 'https://ok.test/page',
      });
    }
  });

  it('routes about:blank in-place for an allowed disposition', () => {
    expect(decideWindowOpen({ url: 'about:blank', disposition: 'foreground-tab' })).toEqual({
      action: 'deny',
      loadInPlace: 'about:blank',
    });
  });

  it('denies a disallowed-scheme url for an allowed disposition without routing', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'aegis-bad://x', 'data:text/html,x']) {
      const res = decideWindowOpen({ url, disposition: 'new-window' });
      expect(res).toEqual({ action: 'deny' });
      expect('loadInPlace' in res).toBe(false);
    }
  });

  it('covers every real disposition value without throwing', () => {
    for (const disposition of dispositions) {
      const res = decideWindowOpen({ url: 'https://ok.test/', disposition });
      expect(res.action).toBe('deny');
    }
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run electron/main/windowOpen.test.ts`
Expected: FAIL — module resolution error `Failed to resolve import "./windowOpen"` / `Cannot find module './windowOpen'` (the implementation file does not exist yet).

- [ ] **Step 3: Implement**

Create `electron/main/windowOpen.ts`:
```ts
// electron/main/windowOpen.ts
import type { HandlerDetails } from 'electron'; // type-only — keeps this module node-pure
import { isAllowedNavigationUrl } from '../lib/schemes';

export type WindowOpenDecision = { action: 'deny' } | { action: 'deny'; loadInPlace: string };

/**
 * Pure popup/new-window policy (extracted from ViewController.wireSecurity so it is
 * unit-testable in isolation). Electron 42.4.0 HandlerDetails exposes NO user-gesture
 * bit, so the policy is disposition + scheme based only (documented limitation).
 *
 *  - 'background-tab' / 'other'  → deny (popunder / unknown intent), never route.
 *  - otherwise, allowed scheme   → deny the popup but route the single content view
 *                                  in-place to the requested URL.
 *  - otherwise                   → deny.
 *
 * Note: the real disposition enum is default|foreground-tab|background-tab|new-window|other.
 * There is NO 'save-to-disk' member, so no such branch exists here.
 */
export function decideWindowOpen(
  details: Pick<HandlerDetails, 'url' | 'disposition'>,
): WindowOpenDecision {
  if (details.disposition === 'background-tab' || details.disposition === 'other') {
    return { action: 'deny' };
  }
  if (isAllowedNavigationUrl(details.url)) {
    return { action: 'deny', loadInPlace: details.url };
  }
  return { action: 'deny' };
}
```

Modify `electron/main/viewController.ts`. Add the import beneath the existing `schemes` import (line 5):
```ts
import { isAllowedNavigationUrl } from '../lib/schemes';
import { decideWindowOpen } from './windowOpen';
```

Replace the inline handler body (current lines 170-185) with the delegating version — same runtime behavior, now backed by the pure module:
```ts
    // Popup policy (§5): deny popunders; route a legitimate, allowed-scheme
    // new-window in-place; otherwise deny. Policy lives in ./windowOpen (pure,
    // unit-tested). HandlerDetails has no user-gesture bit → disposition+scheme only.
    wc.setWindowOpenHandler((details) => {
      const decision = decideWindowOpen(details);
      if ('loadInPlace' in decision) this.wc().loadURL(decision.loadInPlace);
      return { action: 'deny' };
    });
```

Modify `electron/main/viewController.test.ts` line 459 — drop `'save-to-disk'` from the popunder-deny loop (it is no longer a denied disposition under the corrected policy; with an allowed URL it would now route in-place, so the old loop would fail `expect(wc.loadURL).not.toHaveBeenCalled()`):
```ts
    for (const disposition of ['background-tab', 'other']) {
```

(The other two existing popup tests at lines 465-481 — "routes an allowed foreground new-window in-place…" and "denies an allowed-disposition but disallowed-scheme url…" — already match the corrected policy and are NOT touched.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/main/windowOpen.test.ts electron/main/viewController.test.ts`
Expected: PASS — both files green (the new `windowOpen` suite passes; the edited `viewController` popunder-deny test now loops only the two real denied dispositions and still asserts `loadURL` was never called).

- [ ] **Step 5: Commit**
```bash
git add electron/main/windowOpen.ts electron/main/windowOpen.test.ts electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "refactor(popup): extract decideWindowOpen policy to pure module; drop dead save-to-disk branch

Extracts the inline setWindowOpenHandler policy from ViewController into a pure,
unit-testable electron/main/windowOpen.ts (decideWindowOpen + WindowOpenDecision).
The 'save-to-disk' disposition is not a member of Electron 42.4.0's HandlerDetails
enum, so its deny branch was dead/unreachable; removing it is an intentional
behavior change (an allowed-URL save-to-disk would now route in-place). Updates the
existing viewController popunder-deny unit test accordingly."
```

---

### Task 2: Extend boot e2e hooks — multi-line `AEGIS_ADBLOCK_TEST_FILTER` + new `AEGIS_ADBLOCK_TEST_RESOURCES`

**Files:**
- Modify: `electron/main/index.ts:86-97` (the E2E determinism hooks + the test-filter engine build)

No unit test for this task: the hook is gated on `AEGIS_E2E === '1'` and is exercised at runtime by the Block B/C e2e specs (cosmetic/antiadblock/popup). The Task-2 verification is a clean `npm run build`. Notes (§8.6):
- `AEGIS_ADBLOCK_TEST_FILTER` becomes multi-line: newline-split, empty/whitespace lines dropped → a filter-rule array (network + `##…` cosmetic + `##+js(…)` scriptlet rules). A single-line value still works (split of one line yields `[line]`).
- New `AEGIS_ADBLOCK_TEST_RESOURCES` (inline `resources.json` content string) is passed as `buildEngine`'s `resources` arg; unset/empty → `null` (unchanged behavior).
- This is the **boot wiring only**. The committed `electron/test/fixtures/antiadblock/resources.json` is read by the spec via `readFileSync` and passed through `AEGIS_ADBLOCK_TEST_RESOURCES` (Task 4) — it is separate from and does not touch the Phase-1 `electron/test/fixtures/lists/resources.json` (empty).

- [ ] **Step 1: Write the failing test**

None. This boot hook has no isolated unit test (it is gated on `AEGIS_E2E` and runs inside the booted Electron main process). Its behavior is verified at runtime by the Block B/C e2e specs (`cosmetic.spec.ts`, `antiadblock.spec.ts`), which inject multi-line `AEGIS_ADBLOCK_TEST_FILTER` and `AEGIS_ADBLOCK_TEST_RESOURCES`. The Task-2 gate is a successful compile (`npm run build`).

- [ ] **Step 2: Run the test, verify it fails**

Not applicable (no failing unit test for a boot-only, env-gated hook). Proceed to Step 3; the build in Step 4 is the verification.

- [ ] **Step 3: Implement**

Modify `electron/main/index.ts`. Add a small line-splitting helper just above `function boot()` (after the byte/timeout constants, e.g. after line 32) so the boot hook can reuse it:
```ts
const FETCH_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Split a multi-line filter blob (AEGIS_ADBLOCK_TEST_FILTER) into trimmed, non-empty
 * filter rules. A single-line value yields a 1-element array. Used by the e2e boot
 * hook so cosmetic (`##…`) + scriptlet (`##+js(…)`) + network rules can be supplied
 * together as one newline-delimited env var.
 */
function splitNonEmptyLines(blob: string): string[] {
  return blob
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
```

Then replace the E2E determinism hooks + the test-filter engine build (current lines 86-97) with the extended version:
```ts
  // E2E determinism hooks.
  const TEST_FILTER = process.env.AEGIS_ADBLOCK_TEST_FILTER;
  const TEST_RESOURCES = process.env.AEGIS_ADBLOCK_TEST_RESOURCES || null;
  const OFFLINE = process.env.AEGIS_ADBLOCK_OFFLINE === '1';
  const LIST_BASE = process.env.AEGIS_ADBLOCK_LIST_BASE;

  // Initial engine: deterministic test filter (e2e) | user cache | bundled snapshot | empty.
  // Track the source so e2e can assert first-run-on-seed deterministically (§8.4/§8.7).
  let initialBlocker: ElectronBlocker;
  let engineSource: 'filter' | 'cache' | 'snapshot' | 'built';
  if (TEST_FILTER) {
    // Multi-line filter set (network + cosmetic `##…` + scriptlet `##+js(…)` rules);
    // TEST_RESOURCES supplies the custom scriptlet resources.json so `##+js(...)` resolve.
    initialBlocker = buildEngine(splitNonEmptyLines(TEST_FILTER), TEST_RESOURCES);
    engineSource = 'filter';
  } else {
```

The remaining `else` branch (cache / snapshot / built) and everything below are unchanged. The auto-kick guard at line ~203 (`if (!OFFLINE && !TEST_FILTER)`) still references `TEST_FILTER`, so the automatic refresh stays skipped whenever a test filter is set — unchanged.

- [ ] **Step 4: Verify it compiles (build)**

Run: `npm run build`
Expected: PASS — TypeScript compiles with no errors; `out/main/index.js` is produced. (`TEST_RESOURCES` is `string | null`, matching `buildEngine(listTexts: string[], resources: string | null)`; `splitNonEmptyLines` returns `string[]` for the first arg.)

- [ ] **Step 5: Commit**
```bash
git add electron/main/index.ts
git commit -m "test(e2e): multi-line AEGIS_ADBLOCK_TEST_FILTER + AEGIS_ADBLOCK_TEST_RESOURCES boot hook

Splits AEGIS_ADBLOCK_TEST_FILTER on newlines (trimmed, non-empty) so cosmetic
(##…), scriptlet (##+js(…)), and network rules can be supplied together, and adds
AEGIS_ADBLOCK_TEST_RESOURCES (inline resources.json) passed to buildEngine so
scriptlets resolve. AEGIS_E2E-gated only; no production-path change. Exercised at
runtime by the Block B/C cosmetic/antiadblock e2e specs."
```

---

#### New names introduced (Block A)
- `decideWindowOpen` — exported function, `electron/main/windowOpen.ts`
- `WindowOpenDecision` — exported type, `electron/main/windowOpen.ts`
- `splitNonEmptyLines` — module-local (non-exported) helper, `electron/main/index.ts`

I now have all the verified facts I need: the `app.evaluate((_e, arg) => …, arg)` parameter-passing idiom, the `executeJavaScript(expr, true)` main-world read returning a Promise, the `launchApp`/`navigateAndSettle`/`state` helpers, env passing via `extraEnv`, and the fixture server serving `.html`/`.json` from `electron/test/fixtures/`. Block B (Tasks 3-4) depends on the Block A Task 2 boot hook (multi-line `AEGIS_ADBLOCK_TEST_FILTER` + `AEGIS_ADBLOCK_TEST_RESOURCES`). I'll write the two tasks now.

### Task 3: Cosmetic verification — sentinel fixture + `cosmetic.spec.ts` (generic + per-host hide, report-only no-flash probe)

**Files:**
- Create: `electron/test/fixtures/cosmetic/sentinel.html`
- Create: `electron/test/e2e/cosmetic.spec.ts`
- Test: `electron/test/e2e/cosmetic.spec.ts` (the e2e spec IS the test; run via `npm run build && npx playwright test`)

This task depends on the Block A Task 2 boot hook (multi-line `AEGIS_ADBLOCK_TEST_FILTER` + `AEGIS_ADBLOCK_TEST_RESOURCES`) already being in `electron/main/index.ts`. The fixture server (`electron/test/e2e/fixtureServer.ts`) already serves `.html` from `electron/test/fixtures/**` with `text/html` MIME and serves nested dirs — no server change needed.

Per contract §1, a minimal `parse()`-built engine returns `active:true` with `styles` containing BOTH the generic `.aegis-ad-sentinel { display: none !important; }` and the per-host `127.0.0.1##.aegis-ad-sentinel-host` rule; the live runtime path is the engine preload → main `insertCSS`. So the deterministic gate is: both sentinels end `display:none` / zero rendered height, while a non-matching content marker stays visible. No-flash is REPORT-ONLY (log timing; never assert).

- [ ] **Step 1: Write the failing test**

First, create the fixture (the test navigates to it, so it must exist for the spec to be meaningful — but we author the spec first per TDD, then add the fixture in Step 3; the spec fails in Step 2 because neither the fixture nor — until Block A Task 2 lands — the multi-line hook exists).

Create `electron/test/e2e/cosmetic.spec.ts`:

```ts
// electron/test/e2e/cosmetic.spec.ts
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

test('cosmetic: generic + per-host sentinels end hidden; content marker stays visible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-cosmetic-'));
  // Two cosmetic rules: a generic class hide + a 127.0.0.1-scoped class hide.
  // Multi-line filter (Block A Task 2 hook splits on \n).
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '##.aegis-ad-sentinel\n127.0.0.1##.aegis-ad-sentinel-host',
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/cosmetic/sentinel.html`);

    // Engine cosmetic CSS injects via preload->main insertCSS asynchronously; poll the
    // computed display of each sentinel until the hide lands.
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

    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('.aegis-ad-sentinel-host')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('none');

    // Rendered height collapses to zero for both (belt-and-braces on the visual gate).
    const genericHeight = await readContent<number>(
      app,
      "document.querySelector('.aegis-ad-sentinel').getBoundingClientRect().height",
    );
    expect(genericHeight).toBe(0);
    const hostHeight = await readContent<number>(
      app,
      "document.querySelector('.aegis-ad-sentinel-host').getBoundingClientRect().height",
    );
    expect(hostHeight).toBe(0);

    // The non-ad content marker is untouched and visibly rendered.
    const markerDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#content-marker')).display",
    );
    expect(markerDisplay).not.toBe('none');
    const markerHeight = await readContent<number>(
      app,
      "document.querySelector('#content-marker').getBoundingClientRect().height",
    );
    expect(markerHeight).toBeGreaterThan(0);

    // ---- Report-only no-flash probe (NEVER asserts pass/fail) ----
    // The fixture records the timestamp of its first paint entry; we read it alongside
    // the moment the sentinel's computed display first became 'none' (captured by the
    // fixture's own observer). Log the delta for visibility; do not gate on it.
    const probe = await readContent<{ firstPaint: number | null; hiddenAt: number | null }>(
      app,
      'JSON.stringify({ firstPaint: window.__aegisFirstPaint ?? null, hiddenAt: window.__aegisSentinelHiddenAt ?? null })',
    ).then((s) => JSON.parse(s as unknown as string));
    const delta =
      probe.firstPaint !== null && probe.hiddenAt !== null
        ? probe.hiddenAt - probe.firstPaint
        : null;
    // eslint-disable-next-line no-console
    console.log(
      `[no-flash report-only] firstPaint=${probe.firstPaint} hiddenAt=${probe.hiddenAt} ` +
        `applyMinusPaintMs=${delta} (report-only; not asserted)`,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run build && npx playwright test electron/test/e2e/cosmetic.spec.ts`

Expected: FAIL — the fixture `electron/test/fixtures/cosmetic/sentinel.html` does not exist yet, so the fixture server returns 404, the page never reaches the sentinel DOM, and `getComputedStyle(document.querySelector('.aegis-ad-sentinel'))` throws on a `null` element (the `expect.poll` for `display === 'none'` times out / errors). The error surfaces as a poll timeout against the missing element rather than `'none'`.

- [ ] **Step 3: Implement**

Create the fixture `electron/test/fixtures/cosmetic/sentinel.html`. It contains a generic-class sentinel, a per-host-class sentinel (each 300×250), a visible non-ad content marker, plus a minimal report-only no-flash instrumentation (a `paint` PerformanceObserver records `__aegisFirstPaint`; a MutationObserver-free poll records `__aegisSentinelHiddenAt` when the injected user-CSS first collapses the generic sentinel).

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Aegis cosmetic sentinel fixture</title>
    <style>
      /* Baseline so an UN-hidden sentinel is a visible 300x250 block (the thing we hide). */
      .aegis-ad-sentinel,
      .aegis-ad-sentinel-host {
        width: 300px;
        height: 250px;
        background: #c00;
      }
      #content-marker {
        width: 400px;
        height: 80px;
        background: #0a0;
      }
    </style>
    <script>
      // ---- Report-only no-flash instrumentation (never gates the test) ----
      // First paint timestamp (DOMHighResTimeStamp), if the browser reports one.
      window.__aegisFirstPaint = null;
      window.__aegisSentinelHiddenAt = null;
      try {
        const po = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (window.__aegisFirstPaint === null) {
              window.__aegisFirstPaint = entry.startTime;
            }
          }
        });
        po.observe({ type: 'paint', buffered: true });
      } catch (_e) {
        /* paint timing unavailable in this environment — leave null */
      }
      // Record the moment the engine's user-CSS first collapses the generic sentinel.
      (function watchHide() {
        const tick = function () {
          const el = document.querySelector('.aegis-ad-sentinel');
          if (
            window.__aegisSentinelHiddenAt === null &&
            el &&
            getComputedStyle(el).display === 'none'
          ) {
            window.__aegisSentinelHiddenAt = performance.now();
            return; // stop polling once captured
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })();
    </script>
  </head>
  <body>
    <!-- Generic cosmetic rule target: ##.aegis-ad-sentinel -->
    <div class="aegis-ad-sentinel">generic ad</div>
    <!-- Per-host cosmetic rule target: 127.0.0.1##.aegis-ad-sentinel-host -->
    <div class="aegis-ad-sentinel-host">per-host ad</div>
    <!-- Non-ad content; must remain visible (no rule matches it). -->
    <div id="content-marker">real content</div>
  </body>
</html>
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run build && npx playwright test electron/test/e2e/cosmetic.spec.ts`

Expected: PASS — both sentinels resolve to `display:none` with `getBoundingClientRect().height === 0`, the content marker stays visible (`display !== 'none'`, height > 0), and the `[no-flash report-only]` line is logged without affecting the result.

- [ ] **Step 5: Commit**

```bash
git add electron/test/fixtures/cosmetic/sentinel.html electron/test/e2e/cosmetic.spec.ts
git commit -m "test(phase2): verify cosmetic Layer-2 hide (generic + per-host) via e2e fixture

Adds a 300x250 sentinel fixture (generic .aegis-ad-sentinel + per-host
.aegis-ad-sentinel-host) and cosmetic.spec.ts: launches with a multi-line
AEGIS_ADBLOCK_TEST_FILTER, polls both sentinels to display:none / zero height,
asserts the non-ad content marker stays visible, and logs a report-only
apply-vs-paint no-flash timing probe (never gates).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Anti-adblock / scriptlet verification — `resources.json` + detector fixtures + `antiadblock.spec.ts`

**Files:**
- Create: `electron/test/fixtures/antiadblock/resources.json`
- Create: `electron/test/fixtures/antiadblock/set-false-detector.html`
- Create: `electron/test/fixtures/antiadblock/bait-undefined-detector.html`
- Create: `electron/test/fixtures/antiadblock/cosmetic-wall.html`
- Create: `electron/test/e2e/antiadblock.spec.ts`
- Test: `electron/test/e2e/antiadblock.spec.ts` (the e2e spec IS the test; run via `npm run build && npx playwright test`)

Notes (per contract §8.6):
- `electron/test/fixtures/lists/resources.json` (Phase-1, empty) is SEPARATE and untouched. The new `antiadblock/resources.json` is read via `readFileSync` and passed inline through `AEGIS_ADBLOCK_TEST_RESOURCES` (the Block A Task 2 hook accepts the JSON CONTENT, not a path).
- The spec §4 "popunder" pattern is intentionally covered in Task 5 (`popup.spec.ts`), NOT here.

Per contract §8.3, scriptlet bodies are NO-ARG, self-contained function expressions (the engine assembles `(BODY)(...[args])` → a bare statement would crash; and `{{n}}` tokens get mis-substituted, so none appear in the bodies). Per §8.4, each detector exposes a RE-CHECKABLE end-state and the spec asserts via `expect.poll` (scriptlet injection is async IPC). The fixtures cover three deterministic representative patterns: a `set-constant`-style defuser (`adblockDetected` forced `false`), a property-read-returns-undefined defuser (the bait global reads `undefined`), and a cosmetic-rule-removed "disable your ad blocker" wall.

- [ ] **Step 1: Write the failing test**

Create `electron/test/e2e/antiadblock.spec.ts`:

```ts
// electron/test/e2e/antiadblock.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState } from '../../../shared/types';

let fixtures: FixtureServer;

// The committed fixture scriptlet resources (SEPARATE from electron/test/fixtures/lists/resources.json).
// Read here and passed inline through AEGIS_ADBLOCK_TEST_RESOURCES (content, not a path).
const RESOURCES_JSON = readFileSync(
  join(__dirname, '..', 'fixtures', 'antiadblock', 'resources.json'),
  'utf8',
);

// The detector-defusing filter set (multi-line; Block A Task 2 hook splits on \n):
//  - scriptlet rule forcing adblockDetected=false,
//  - scriptlet rule making the bait global read undefined,
//  - a cosmetic rule removing the "disable your ad blocker" wall element.
const TEST_FILTER = [
  '127.0.0.1##+js(aegis-set-false)',
  '127.0.0.1##+js(aegis-no-bait)',
  '127.0.0.1##.adblock-wall',
].join('\n');

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

// One app per detector fixture so each scriptlet/cosmetic set is exercised in isolation.

test('antiadblock: set-constant defuser keeps content visible (adblockDetected forced false)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-aab-setfalse-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: TEST_FILTER,
    AEGIS_ADBLOCK_TEST_RESOURCES: RESOURCES_JSON,
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/antiadblock/set-false-detector.html`);
    // Re-checkable end-state: the detector re-evaluates adblockDetected on a rAF loop and
    // sets #content display:block (visible) when it stays false. Poll until visible.
    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('#content')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('block');
    // And the wall the detector would have shown stays hidden.
    const wallDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#wall')).display",
    );
    expect(wallDisplay).toBe('none');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('antiadblock: property-read-returns-undefined defuser keeps content visible (bait reads undefined)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-aab-bait-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: TEST_FILTER,
    AEGIS_ADBLOCK_TEST_RESOURCES: RESOURCES_JSON,
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/antiadblock/bait-undefined-detector.html`);
    // Re-checkable end-state: detector reads window.aegisBait on a rAF loop; while it is
    // undefined it keeps #content visible and #wall hidden. Poll the visible end-state.
    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('#content')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('block');
    const wallDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#wall')).display",
    );
    expect(wallDisplay).toBe('none');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('antiadblock: cosmetic rule removes the "disable your ad blocker" wall; content visible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-aab-wall-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: TEST_FILTER,
    AEGIS_ADBLOCK_TEST_RESOURCES: RESOURCES_JSON,
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/antiadblock/cosmetic-wall.html`);
    // Re-checkable end-state: the cosmetic rule 127.0.0.1##.adblock-wall hides the wall
    // via injected user-CSS (async). Poll the wall's computed display to 'none'.
    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('.adblock-wall')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('none');
    // Primary content underneath is rendered.
    const contentHeight = await readContent<number>(
      app,
      "document.querySelector('#content').getBoundingClientRect().height",
    );
    expect(contentHeight).toBeGreaterThan(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run build && npx playwright test electron/test/e2e/antiadblock.spec.ts`

Expected: FAIL — the module-level `readFileSync('.../antiadblock/resources.json')` throws `ENOENT` (the file does not exist yet), so the spec file fails to load entirely (Playwright reports a worker error / "Cannot read … resources.json"). Even once created, the detector fixtures `.html` are absent (404), so the `expect.poll` for `#content` `display === 'block'` / `.adblock-wall` `display === 'none'` would time out against missing elements.

- [ ] **Step 3: Implement**

Create the committed scriptlet resources. Both bodies are NO-ARG, self-contained function expressions with NO `{{n}}` tokens (contract §8.3 exact shape).

Create `electron/test/fixtures/antiadblock/resources.json`:

```json
{
  "scriptlets": [
    {
      "name": "aegis-set-false.js",
      "aliases": ["aegis-set-false"],
      "body": "function(){ Object.defineProperty(window, 'adblockDetected', { get: function(){ return false; }, set: function(){}, configurable: true }); }",
      "dependencies": []
    },
    {
      "name": "aegis-no-bait.js",
      "aliases": ["aegis-no-bait"],
      "body": "function(){ Object.defineProperty(window, 'aegisBait', { get: function(){ return undefined; }, configurable: true }); }",
      "dependencies": []
    }
  ],
  "redirects": []
}
```

Create `electron/test/fixtures/antiadblock/set-false-detector.html` — a `set-constant`-style detector that re-evaluates `window.adblockDetected` on a rAF loop and toggles the wall vs content based on it:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Aegis anti-adblock: set-constant detector</title>
    <style>
      #wall { display: none; width: 100%; height: 400px; background: #111; color: #fff; }
      #content { display: none; width: 400px; height: 200px; background: #0a0; }
    </style>
  </head>
  <body>
    <div id="wall">Please disable your ad blocker to continue.</div>
    <div id="content">Primary article content.</div>
    <script>
      // Page default: it BELIEVES an ad blocker is present (true). The aegis-set-false
      // scriptlet (injected main-world at document_start) redefines adblockDetected to
      // always read false, so this detector keeps content visible and the wall hidden.
      // Re-checkable: re-evaluated every animation frame (defeats any residual race).
      try {
        if (!('adblockDetected' in window)) {
          window.adblockDetected = true;
        }
      } catch (_e) {
        /* already defined by the scriptlet (non-writable get) — ignore */
      }
      var wall = document.getElementById('wall');
      var content = document.getElementById('content');
      function evaluate() {
        if (window.adblockDetected) {
          wall.style.display = 'block';
          content.style.display = 'none';
        } else {
          wall.style.display = 'none';
          content.style.display = 'block';
        }
        requestAnimationFrame(evaluate);
      }
      requestAnimationFrame(evaluate);
    </script>
  </body>
</html>
```

Create `electron/test/fixtures/antiadblock/bait-undefined-detector.html` — the property-read-returns-undefined defuser target (the bait global reads `undefined`, so the wall never shows):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Aegis anti-adblock: bait-undefined detector</title>
    <style>
      #wall { display: none; width: 100%; height: 400px; background: #111; color: #fff; }
      #content { display: none; width: 400px; height: 200px; background: #0a0; }
    </style>
  </head>
  <body>
    <div id="wall">Please disable your ad blocker to continue.</div>
    <div id="content">Primary article content.</div>
    <script>
      // Page would set a bait global it later reads to detect tampering. The
      // aegis-no-bait scriptlet (main-world, document_start) defines window.aegisBait
      // as a getter returning undefined, so this page's own assignment is swallowed and
      // the read is undefined -> the wall never appears.
      try {
        window.aegisBait = { live: true };
      } catch (_e) {
        /* getter-only property defined by the scriptlet — assignment ignored */
      }
      var wall = document.getElementById('wall');
      var content = document.getElementById('content');
      function evaluate() {
        // Detector logic: if the bait survived (truthy), it concludes no tampering and
        // shows the wall. With the scriptlet, aegisBait reads undefined -> content shown.
        if (window.aegisBait) {
          wall.style.display = 'block';
          content.style.display = 'none';
        } else {
          wall.style.display = 'none';
          content.style.display = 'block';
        }
        requestAnimationFrame(evaluate);
      }
      requestAnimationFrame(evaluate);
    </script>
  </body>
</html>
```

Create `electron/test/fixtures/antiadblock/cosmetic-wall.html` — a "disable your ad blocker" overlay removed by the cosmetic rule `127.0.0.1##.adblock-wall`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Aegis anti-adblock: cosmetic wall</title>
    <style>
      /* Baseline: the wall is a visible full-page overlay until the cosmetic rule hides it. */
      .adblock-wall {
        display: block;
        position: fixed;
        inset: 0;
        background: #111;
        color: #fff;
        z-index: 9999;
      }
      #content { width: 400px; height: 200px; background: #0a0; }
    </style>
  </head>
  <body>
    <!-- Cosmetic rule target: 127.0.0.1##.adblock-wall -->
    <div class="adblock-wall">Please disable your ad blocker to continue.</div>
    <div id="content">Primary article content.</div>
  </body>
</html>
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run build && npx playwright test electron/test/e2e/antiadblock.spec.ts`

Expected: PASS — all three tests green: the set-constant detector and the bait-undefined detector each poll `#content` to `display:block` with `#wall` `display:none`; the cosmetic-wall test polls `.adblock-wall` to `display:none` with `#content` height > 0. (Synthetic fixtures are deterministic → all pass, per §4 / §8.)

- [ ] **Step 5: Commit**

```bash
git add electron/test/fixtures/antiadblock/resources.json electron/test/fixtures/antiadblock/set-false-detector.html electron/test/fixtures/antiadblock/bait-undefined-detector.html electron/test/fixtures/antiadblock/cosmetic-wall.html electron/test/e2e/antiadblock.spec.ts
git commit -m "test(phase2): verify scriptlet/cosmetic anti-adblock Layer-3 via deterministic fixtures

Adds antiadblock/resources.json (no-arg, self-contained function-expression
scriptlets: aegis-set-false forces adblockDetected=false; aegis-no-bait makes
the bait global read undefined) plus three detector fixtures (set-constant,
property-read-returns-undefined, cosmetic-removed wall) and antiadblock.spec.ts.
The spec launches with a multi-line AEGIS_ADBLOCK_TEST_FILTER (##+js + cosmetic)
and AEGIS_ADBLOCK_TEST_RESOURCES (inline JSON content), then polls each fixture's
re-checkable end-state (scriptlet injection is async IPC). All synthetic
fixtures are deterministic and must pass; the separate Phase-1
fixtures/lists/resources.json is untouched. The popunder pattern is covered in
popup.spec.ts (Task 5).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

#### New names introduced (Block B)
- `electron/test/e2e/cosmetic.spec.ts` (file) — test-local helpers `launchApp`, `state`, `navigate`, `navigateAndSettle`, `readContent`; module-local `fixtures`. (Mirrors the existing per-spec helper convention; not exported across modules.)
- `electron/test/e2e/antiadblock.spec.ts` (file) — test-local helpers `launchApp`, `state`, `navigate`, `navigateAndSettle`, `readContent`; module-local `fixtures`, `RESOURCES_JSON`, `TEST_FILTER`. (Per-spec local; not exported.)
- Fixtures (not code symbols): `electron/test/fixtures/cosmetic/sentinel.html`; `electron/test/fixtures/antiadblock/resources.json`; `electron/test/fixtures/antiadblock/set-false-detector.html`; `electron/test/fixtures/antiadblock/bait-undefined-detector.html`; `electron/test/fixtures/antiadblock/cosmetic-wall.html`.
- Fixture-injected window globals (no-flash report-only): `window.__aegisFirstPaint`, `window.__aegisSentinelHiddenAt` (in `sentinel.html`).
- Scriptlet resource names/aliases (in `antiadblock/resources.json`): `aegis-set-false.js` / `aegis-set-false`; `aegis-no-bait.js` / `aegis-no-bait`. Fixture-injected window globals exercised by the scriptlets: `window.adblockDetected`, `window.aegisBait`.

No new exported TypeScript symbols are introduced by Block B (all helpers are per-spec-local, matching the existing e2e convention).

I have all the verified facts needed. Note that `http:` is allowed, so I'll use the local fixture server URL (`http://127.0.0.1:...`) as the "allowed" target and a custom scheme like `aegis-bad://x` as the disallowed one. Here are the expanded tasks for Block C.

### Task 5: Popup/redirect e2e — popunder denied, allowed new-window routed in-place, hostile-scheme redirect blocked

**Files:**
- Create: `electron/test/fixtures/popup/popunder-blank.html`
- Create: `electron/test/fixtures/popup/popunder-disallowed.html`
- Create: `electron/test/fixtures/popup/redirect-hostile.html`
- Create: `electron/test/fixtures/popup/landing.html`
- Test (e2e): `electron/test/e2e/popup.spec.ts`

This task verifies the as-built popup/redirect gate end-to-end against the live `ViewController.wireSecurity` handler (now delegating to `decideWindowOpen` from Task 1) and the `will-redirect` gate. Per contract §8.5 it is **disposition-robust**: it never hardcodes `windows().length === 1`, captures a baseline window count and asserts it is **unchanged** (delta 0), and tests three disposition-independent guarantees — (a) an allowed-scheme `window.open` opens **no real popup window**, (b) a disallowed-scheme `window.open` is denied without routing (content URL unchanged), (c) a hostile-scheme top-frame redirect is blocked. The route-in-place behavior (foreground disposition) and the `background-tab`/`other`→deny branch are both covered deterministically by the Task-1 `windowOpen.test.ts` unit test (and the existing `viewController.test.ts`), so this e2e does not depend on which disposition Electron assigns a scripted `window.open` — keeping it hermetic. The `http://127.0.0.1:<port>` fixture URL is an allowed scheme (`http:` is in `ALLOWED_NAV_SCHEMES`); `aegis-bad://x` is a disallowed custom scheme. All fixtures are `.html` (already served by `fixtureServer.ts`; no MIME change needed). No supplementary `window.open` return-stub is built — `contentPreload.ts` stays no-op (the main-process gate is authoritative and these fixtures pass without it).

- [ ] **Step 1: Write the failing test (fixtures + spec)**

Fixture — `electron/test/fixtures/popup/landing.html` (the allowed in-place target the routed new-window lands on; its `<title>` is a stable end-state marker):
```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>aegis-popup-landing</title></head>
<body>
  <h1 id="landing">Aegis popup landing page</h1>
</body>
</html>
```

Fixture — `electron/test/fixtures/popup/popunder-blank.html` (a `target=_blank` popunder attempt to an allowed URL via `window.open`; exposes `window.__aegisOpenPopunder(url)` so the test triggers it deterministically with a known disposition-independent path, and a `__aegisLastOpenReturn` flag for diagnostics):
```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>aegis-popunder-blank</title></head>
<body>
  <h1 id="content">popunder-blank fixture content</h1>
  <script>
    // Disposition-independent popunder attempt: the page asks for a new window
    // via window.open(url, '_blank'). The main-process gate decides the outcome;
    // we expose a trigger so the e2e fires it after capturing a window baseline.
    window.__aegisOpenPopunder = function (url) {
      window.__aegisLastOpenReturn = 'pending';
      var w = window.open(url, '_blank');
      window.__aegisLastOpenReturn = w === null ? 'null' : 'window';
      return window.__aegisLastOpenReturn;
    };
  </script>
</body>
</html>
```

(Test 1 (allowed `window.open`) uses the trigger-based `popunder-blank.html` above — NOT an auto-firing fixture — so the page settles on the fixture before the open is triggered; see §0.)

Fixture — `electron/test/fixtures/popup/popunder-disallowed.html` (case (b): auto-fires a `window.open` to a disallowed custom scheme; denied without routing → content view URL must stay on the fixture):
```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>aegis-popunder-disallowed</title></head>
<body>
  <h1 id="content">popunder-disallowed fixture content</h1>
  <script>
    // Auto-fire on load: window.open to a DISALLOWED custom scheme. The gate denies
    // it AND does not route it in-place (isAllowedNavigationUrl is false), so the
    // content view stays on this fixture.
    (function () {
      window.open('aegis-bad://popunder', '_blank');
    })();
  </script>
</body>
</html>
```

Fixture — `electron/test/fixtures/popup/redirect-hostile.html` (case (c): top-frame redirect to a disallowed scheme via `location.href`; blocked by the existing `will-redirect`/`will-navigate` gate → content stays on the fixture):
```html
<!doctype html>
<html>
<head><meta charset="utf-8"><title>aegis-redirect-hostile</title></head>
<body>
  <h1 id="content">redirect-hostile fixture content</h1>
  <script>
    // Top-frame navigation to a disallowed scheme. isAllowedNavigationUrl('aegis-bad://x')
    // is false, so the will-navigate/will-redirect gate calls preventDefault -> the
    // content view never leaves this fixture.
    (function () {
      window.location.href = 'aegis-bad://hostile';
    })();
  </script>
</body>
</html>
```

Spec — `electron/test/e2e/popup.spec.ts` (full file):
```ts
// electron/test/e2e/popup.spec.ts
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

test('an allowed-scheme window.open opens no real popup window (gate always denies the popup)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-popup-allowed-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const landing = `${fixtures.baseUrl}/popup/landing.html`;
    // Trigger-based fixture (NOT auto-firing): settle on it FIRST, then fire the open.
    // An auto-firing fixture that routes in-place would navigate off the fixture during
    // load and navigateAndSettle could never settle (§0).
    const fixtureUrl = `${fixtures.baseUrl}/popup/popunder-blank.html`;
    await navigateAndSettle(app, fixtureUrl);

    // Capture a window-count BASELINE after the fixture has settled. The BaseWindow
    // hosts chrome + content (= 2 page targets); a spawned popup would INCREASE this.
    const baseline = app.windows().length;

    // Trigger window.open(<allowed https url>, '_blank') in the content main world.
    await app.evaluate(
      (_e, u) =>
        (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
          `window.__aegisOpenPopunder(${JSON.stringify(u)})`,
          true,
        ),
      landing,
    );

    // Deterministic, disposition-INDEPENDENT guarantee: the setWindowOpenHandler always
    // returns {action:'deny'}, so NO real popup window is ever created — windows().length
    // is unchanged regardless of the disposition Electron assigned. (Whether the view also
    // routes the URL in-place is a foreground-disposition behavior covered by the Task-1
    // windowOpen.test.ts unit test; not asserted here to keep this hermetic.) Poll briefly
    // to let the async open attempt be processed, then assert the count is still the baseline.
    await expect.poll(async () => app.windows().length, { timeout: 5000 }).toBe(baseline);
    expect(app.windows().length).toBe(baseline);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('popunder window.open to a disallowed scheme is denied without routing (no new window)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-popup-disallowed-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const fixtureUrl = `${fixtures.baseUrl}/popup/popunder-disallowed.html`;
    await navigateAndSettle(app, fixtureUrl);

    const baseline = app.windows().length;

    // The window.open('aegis-bad://...', '_blank') is denied and NOT routed in-place
    // (disallowed scheme), so the content view stays on the fixture. Give the async
    // open attempt time to be processed, then assert the URL is UNCHANGED.
    await expect
      .poll(async () => app.windows().length, { timeout: 5000 })
      .toBe(baseline);
    expect((await state(app)).url).toBe(fixtureUrl);
    expect(app.windows().length).toBe(baseline);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('top-frame redirect to a disallowed scheme is blocked by will-redirect (content unchanged)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-popup-redirect-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const fixtureUrl = `${fixtures.baseUrl}/popup/redirect-hostile.html`;
    await navigateAndSettle(app, fixtureUrl);

    const baseline = app.windows().length;

    // location.href='aegis-bad://...' is a disallowed scheme -> will-navigate/will-redirect
    // preventDefault. The content view never leaves the fixture, and no window opens.
    await expect
      .poll(async () => app.windows().length, { timeout: 5000 })
      .toBe(baseline);
    expect((await state(app)).url).toBe(fixtureUrl);
    // The fixture's own content marker is still present (page did not navigate away).
    const marker = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'document.getElementById("content") ? document.getElementById("content").textContent : ""',
        true,
      ),
    );
    expect(marker).toContain('redirect-hostile');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm run build && npx playwright test electron/test/e2e/popup.spec.ts`

Expected: FAIL — the fixtures do not exist yet (the server returns 404 for `/popup/*.html`, so `navigateAndSettle` never reaches the fixture URL and the assertions never satisfy; the test times out). This is the red state.

- [ ] **Step 3: Implement**

The implementation IS the four fixture files (the spec exercises the already-built, Task-1-refactored runtime gate; no production code changes in this task). The fixtures are created exactly as shown in Step 1 — `electron/test/fixtures/popup/landing.html`, `popunder-blank.html`, `popunder-disallowed.html`, and `redirect-hostile.html`. The three spec tests drive `popunder-blank.html` (trigger-based allowed open → no popup), `popunder-disallowed.html` (auto-fire disallowed-scheme open → denied, content unchanged), and `redirect-hostile.html` (auto-fire hostile redirect → blocked).

No edit to `fixtureServer.ts` is required: `.html` is already in its `MIME` map and nested `popup/` paths are served by the existing `serveFile` join. No edit to `contentPreload.ts` (stays no-op). The `will-navigate`/`will-redirect` gate and `setWindowOpenHandler` delegation are already in `viewController.ts` from Phase 0+1 and Task 1.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm run build && npx playwright test electron/test/e2e/popup.spec.ts`

Expected: PASS — all three tests green:
- allowed `window.open` opens no real popup: `windows().length === baseline` after the triggered open (route-in-place is unit-tested in Task 1, not asserted here).
- disallowed-scheme `window.open`: content URL unchanged, `windows().length === baseline`.
- hostile redirect: content URL stays on the fixture, marker still `redirect-hostile`, `windows().length === baseline`.

- [ ] **Step 5: Commit**
```bash
git add electron/test/fixtures/popup/landing.html electron/test/fixtures/popup/popunder-blank.html electron/test/fixtures/popup/popunder-disallowed.html electron/test/fixtures/popup/redirect-hostile.html electron/test/e2e/popup.spec.ts
git commit -m "test(e2e): verify popup gate — allowed new-window routed in-place, disallowed-scheme popunder denied, hostile redirect blocked"
```

### Task 6: Phase-2 regression gate — full unit + e2e suites green, final commit

**Files:**
- Modify: none (verification task; this is the Phase-2 closing gate)
- Test: the FULL suites — `npm test` (272 baseline + the new `windowOpen.test.ts` unit + the `viewController.test.ts` edit from Task 1) and `npm run test:e2e` (24 baseline + `cosmetic.spec.ts` + `antiadblock.spec.ts` + `popup.spec.ts`)

This task adds no code; it runs the complete Phase-0+1+2 regression gate and confirms green, then makes the final Phase-2 commit (a no-op-content commit that records the gate result if there is nothing left to stage — in practice all preceding tasks already committed their files, so this commit captures any final docs/state and serves as the phase marker). Per §5: `npm test`'s `pretest` runs `rebuild:node`; `npm run test:e2e`'s `pretest:e2e` runs `rebuild:electron` + the build. Commits are LOCAL ONLY on branch `phase-2` — never push, never set a remote, never rename the branch.

- [ ] **Step 1: Write the failing test**

No new test is authored here. The "test" is the union of all existing + Phase-2 suites. Before running, confirm the working tree from Tasks 1–5 is committed (each prior task committed its own files), so the gate runs against the integrated branch state:
```bash
git status --short
git log --oneline -8
```

- [ ] **Step 2: Run the test, verify it fails**

This step establishes the pre-gate observation: confirm we are on `phase-2` and that the full suites have NOT yet been run together as the closing gate. Run the unit gate first (fast, ABI-isolated):

Run: `npm test`

Expected at this checkpoint: PASS for unit (we expect 272 baseline + the new `windowOpen.test.ts` cases + the edited `viewController.test.ts` popunder loop all green). If ANY unit test fails, STOP — that is the red signal to fix before proceeding (do not continue to e2e). This "verify it fails" slot exists to catch a regression from Tasks 1–4; the expected healthy state is green. Capture the actual reported test count and pass/fail tally from the real output.

- [ ] **Step 3: Implement**

There is no implementation code. "Implementing" the gate = running BOTH suites to completion and reading their real output. Run the e2e gate (it builds + electron-rebuilds via `pretest:e2e`):

Run: `npm run test:e2e`

Expected: PASS — 24 Phase-0+1 e2e + the 3 new Phase-2 specs (`cosmetic.spec.ts`, `antiadblock.spec.ts`, `popup.spec.ts`) all green. If any e2e fails, STOP and fix the offending task before closing the gate — do not commit a red gate. Record the actual spec/assertion tallies from the real Playwright output (no-flash probe lines from `cosmetic.spec.ts` are report-only log lines, not pass/fail signals).

- [ ] **Step 4: Run the test, verify it passes**

Run both gate commands back-to-back and confirm both exit 0 with all suites green:

Run: `npm test && npm run test:e2e`

Expected: PASS — unit suite green (272 baseline + Phase-2 unit additions) AND e2e suite green (24 baseline + 3 new Phase-2 specs). Quote the actual final summary lines from each run as the evidence the gate is green.

- [ ] **Step 5: Commit**
```bash
git add -A
git commit --allow-empty -m "chore(phase-2): close cosmetic/anti-adblock verification + popup-gate hardening; full unit + e2e gate green"
```

#### New names introduced (Block C)

- (none) — Block C introduces no new exported symbols. Task 5 adds e2e fixtures (`electron/test/fixtures/popup/landing.html`, `popunder-blank.html`, `popunder-disallowed.html`, `redirect-hostile.html`) and the e2e spec `electron/test/e2e/popup.spec.ts`; the only in-fixture globals are page-local browser-context helpers (`window.__aegisOpenPopunder`, `window.__aegisLastOpenReturn`), not exported module names. Task 6 is a verification/gate task with no code. The exported `decideWindowOpen` / `WindowOpenDecision` (windowOpen.ts) and the boot-hook additions belong to Block A (Tasks 1–2).
