# Aegis Phase 2 — Plan Contract (authoritative)

**Date:** 2026-06-10 · **Spec:** `docs/superpowers/specs/2026-06-10-aegis-phase2-design.md` · **Branch:** `phase-2` (off `main`; local-only, NOT pushed)
**Purpose:** locked reference for the Phase-2 plan — source-verified `@ghostery/adblocker` 2.18.0 behaviors, as-built Phase-0+1 integration facts, the e2e test-hook extension, the `decideWindowOpen` interface, conventions, and the task skeleton. Drafters expand the skeleton using ONLY the facts here.

## 0. Pinned versions
- `electron` 42.4.0; `@ghostery/adblocker-electron` / `-preload` / core 2.18.0 (already installed). Vitest 4 (`node` + `jsdom` projects), Playwright `_electron`.

## 1. Source-verified `@ghostery/adblocker` 2.18.0 facts (probed against installed source — do not deviate)

**Cosmetic injection (Layer 2) — works from a minimal `parse()`-built engine.** Probe:
`ElectronBlocker.parse('##.aegis-ad-sentinel\\n127.0.0.1##.aegis-ad-sentinel-host').getCosmeticsFilters({ url, hostname:'127.0.0.1', domain:'127.0.0.1', getBaseRules:true, getInjectionRules:true, getRulesFromHostname:true, getRulesFromDOM:false })` returns `active:true` and `styles` containing BOTH `.aegis-ad-sentinel { display: none !important; }` (generic) AND the per-host rule. So a tiny test engine with cosmetic rules deterministically hides matching elements (the live runtime path is the engine's preload → main `insertCSS`).

**Scriptlet injection (Layer 3) — works from `parse()` + `updateResources(customResources)`.** Probe: `parse('127.0.0.1##+js(aegis-set-false)')` + `updateResources('{"scriptlets":[{"name":"aegis-set-false.js","aliases":["aegis-set-false"],"body":"function(){ window.adblockDetected=false; }","dependencies":[]}],"redirects":[]}', 'chk')` then `getCosmeticsFilters({…getInjectionRules:true})` returns `scripts:[<one script>]` containing the body.
  - **CRITICAL:** the engine assembles each scriptlet as `(BODY)(...[args])`. So the scriptlet `body` MUST be a **function expression** (e.g. `function(){…}` or `function(a,b){…}`), NOT a bare statement — a bare statement becomes `(stmt)(...)` → runtime error. Args from `##+js(name, a, b)` are substituted as `{{1}}…`; a no-arg scriptlet `##+js(name)` passes literal placeholders the function may ignore.
  - **resources.json schema** (`Resources.parse` → `isScriptletValid`/`isResourceValid`): top-level `{ scriptlets: [], redirects: [] }`. Scriptlet object = `{ name: string, aliases: string[], body: string, dependencies: string[], executionWorld?: 'MAIN'|'ISOLATED', requiresTrust?: boolean }`. Redirect/resource object = `{ name, aliases: string[], body, contentType: string }`. Empty arrays are valid (load nothing, no throw).
  - Scriptlet injection runs main-world (`executeJavaScript(script, true)`) early (preload's first `inject-cosmetic-filters` invoke), i.e. before the page's own scripts in practice.

**`setWindowOpenHandler` `details` (Electron 42.4.0 `HandlerDetails`) — NO user-gesture flag.** Fields: `url:string`, `frameName:string`, `features:string`, `disposition:('default'|'foreground-tab'|'background-tab'|'new-window'|'other')`, `referrer`, `postBody?`. There is NO gesture/activation bit → gesture-based popup detection is impossible; policy stays disposition+scheme-based (documented limitation). The disposition enum does NOT include `'save-to-disk'` → the current handler's `details.disposition === 'save-to-disk'` branch is **dead code** to drop in the extraction.

**Engine runs full defaults (Phase 1):** `adblock/engine.ts` `buildEngine(listTexts, resources)` = `ElectronBlocker.parse(listTexts.join('\\n'))` + (resources? `updateResources(resources, sha1)`); NO custom Config → cosmetics + generic cosmetics + scriptlets all ON.

## 2. As-built Phase-0+1 integration facts (verified by reading the code)
- **Popup floor** (`electron/main/viewController.ts`, in `wireSecurity`): `wc.setWindowOpenHandler((details) => { if (disposition ∈ {background-tab, save-to-disk, other}) return {action:'deny'}; if (isAllowedNavigationUrl(details.url)) { this.wc().loadURL(details.url); return {action:'deny'}; } return {action:'deny'}; })`. Inline today → Phase 2 extracts to a pure module. (`save-to-disk` is dead per §1.)
- **Redirect/nav gate** (`viewController.ts`): `wc.on('will-navigate'|'will-redirect', (e,url)=>{ if(!isAllowedNavigationUrl(url)) e.preventDefault(); })` — `isAllowedNavigationUrl` from `electron/lib/schemes.ts` (allows `https:`/`http:`, `about:blank`; rejects `file:`/`javascript:`/custom).
- **`electron/preload/contentPreload.ts`** — no-op (stays so).
- **Boot e2e hooks** (`electron/main/index.ts`, gated `process.env.AEGIS_E2E==='1'`): currently
  - `AEGIS_ADBLOCK_TEST_FILTER` → `initialBlocker = buildEngine([TEST_FILTER], null)`, `engineSource='filter'`.
  - `AEGIS_ADBLOCK_OFFLINE`, `AEGIS_ADBLOCK_LIST_BASE` (refresh hooks).
  - `(globalThis as any).__aegisTest = { primary: vc, chromeWcId, adblock: { controller, engineSource, snapshotCount, isBlockingActive, setEnabled, toggleAllowlist, getState, updateNow } }`.
- **`__aegisTest.primary`** is the `ViewController` (public `.view`, `.navigate(url)`, `.getState()`, `.contentWebContents`, `.contentSession`).
- **Retry-tolerant `launchApp`** is the standard e2e readiness pattern (every spec): `await expect.poll(async () => { try { return await app.evaluate(()=>{ const reg=(globalThis as any).__aegisTest; return reg?.primary ? reg.primary.getState().url : ''; }); } catch { return ''; } }, {timeout:15000}).not.toEqual('')`. Reuse it verbatim.
- **`electron/test/e2e/fixtureServer.ts`**: serves `electron/test/fixtures/**` over `http://127.0.0.1:<port>`; MIME map has `.html/.js/.css/.json/.txt`; `serveFile` normalizes paths + has a path-traversal guard + a `lists/<id>.txt` alias (Phase-1). Nested dirs already served. Add MIME/handlers only if a new fixture type needs it (the new fixtures are `.html`/`.json` → already covered).
- **Phase-0+1 gate (must stay green): 272 unit/component (`npm test`) + 24 e2e (`npm run test:e2e`).**

## 3. Test-hook extension (boot, `AEGIS_E2E` only — Phase-2 adds this)
Extend the engine-build hook so cosmetic/scriptlet e2e are deterministic:
- `AEGIS_ADBLOCK_TEST_FILTER` becomes **multi-line**: split on `\n`, drop empty/whitespace lines → a filter-rule array (network + cosmetic `##…` + scriptlet `##+js(…)` rules).
- new `AEGIS_ADBLOCK_TEST_RESOURCES` (string): the scriptlet `resources.json` CONTENT (inline JSON), or empty/unset → `null`.
- When `TEST_FILTER` is set: `initialBlocker = buildEngine(splitNonEmptyLines(process.env.AEGIS_ADBLOCK_TEST_FILTER), process.env.AEGIS_ADBLOCK_TEST_RESOURCES || null)`, `engineSource='filter'`. (Single-line filters still work — split of a 1-line string yields `[line]`.) No production-path change; the auto-kick stays skipped when `TEST_FILTER` is set.

## 4. Interface ledger (match EXACTLY)
**`electron/main/windowOpen.ts`**
```ts
import type { HandlerDetails } from 'electron'; // type-only
export type WindowOpenDecision = { action: 'deny' } | { action: 'deny'; loadInPlace: string };
// Pure policy: deny popunder dispositions; route an allowed-scheme foreground new-window in-place; deny otherwise.
export function decideWindowOpen(details: Pick<HandlerDetails, 'url' | 'disposition'>): WindowOpenDecision;
```
Policy (encode against the REAL disposition enum, drop the dead `save-to-disk`):
- `disposition === 'background-tab' || disposition === 'other'` → `{ action: 'deny' }` (popunder/unknown).
- else if `isAllowedNavigationUrl(details.url)` → `{ action: 'deny', loadInPlace: details.url }` (route the single view in-place).
- else → `{ action: 'deny' }`.
`ViewController.wireSecurity` calls it: `const d = decideWindowOpen(details); if ('loadInPlace' in d) this.wc().loadURL(d.loadInPlace); return { action: 'deny' };` — same runtime behavior, now unit-testable. `decideWindowOpen` imports `isAllowedNavigationUrl` from `../lib/schemes` (value import; pure, node-testable).

**Fixtures (deterministic, in-repo):**
- `electron/test/fixtures/cosmetic/sentinel.html` — contains `<div class="aegis-ad-sentinel" style="width:300px;height:250px">` (generic) AND `<div class="aegis-ad-sentinel-host" style="width:300px;height:250px">` (per-host) + a visible content marker.
- `electron/test/fixtures/antiadblock/*.html` — N≈4–6 detector pages (each sets a `window.__contentVisible` style flag the test reads); `electron/test/fixtures/antiadblock/resources.json` — committed custom scriptlet resources (function-expression bodies per §1).
- `electron/test/fixtures/popup/*.html` — popunder (`window.open` background-tab / `target=_blank`), legit foreground new-window to an allowed URL, hostile-scheme redirect page.

**e2e specs** (Playwright `_electron`, deterministic via §3 hooks, retry-tolerant `launchApp`):
- `electron/test/e2e/cosmetic.spec.ts`, `electron/test/e2e/antiadblock.spec.ts`, `electron/test/e2e/popup.spec.ts`.

## 5. Conventions
- **TDD**, bite-sized steps, one commit/task. Branch `phase-2`. **LOCAL commits only — no push/remote/branch-rename** (project standing rule).
- **ABI:** `windowOpen.ts` + its unit test are pure (import only `schemes` + a type) → run under the Vitest `node` project, NO better-sqlite3, no ABI concern: `npx vitest run electron/main/windowOpen.test.ts`. e2e need the built app (Electron ABI): `npm run build && npx playwright test <file>`. The suite-wide `npm test` handles `rebuild:node` via `pretest`; `npm run test:e2e` handles `rebuild:electron` + build via `pretest:e2e`.
- e2e are deterministic via §3 hooks (no live network); reuse the retry-tolerant `launchApp`. Fixtures pinned in-repo.
- No-flash is **report-only** (log timing; never fail the test). Anti-adblock synthetic fixtures are deterministic → ALL must pass (real-world <100% documented, not chased).
- Do NOT build supplementary stubs or the in-page `window.open` return-stub unless a deterministic fixture provably fails without it (default: not built; `contentPreload` stays no-op).

## 6. Task skeleton (~6 tasks, 3 blocks; drafters expand)
**Block A — popup policy + test hooks**
1. Extract `electron/main/windowOpen.ts` (`decideWindowOpen` + `WindowOpenDecision`) per §4; unit test (`windowOpen.test.ts`) covering every disposition/scheme branch; refactor `ViewController.wireSecurity` to delegate (existing e2e/unit stay green). Drop the dead `save-to-disk` branch.
2. Extend boot e2e hooks (`index.ts`) per §3: multi-line `AEGIS_ADBLOCK_TEST_FILTER` + new `AEGIS_ADBLOCK_TEST_RESOURCES`; verify `npm run build` compiles (no unit; exercised by Block B/C e2e).

**Block B — cosmetic + anti-adblock verification**
3. Cosmetic: `cosmetic/sentinel.html` fixture + `cosmetic.spec.ts` — launch with `AEGIS_ADBLOCK_TEST_FILTER='##.aegis-ad-sentinel\n127.0.0.1##.aegis-ad-sentinel-host'`, navigate, assert both sentinels end `display:none`/zero height and the content marker is visible; add the **report-only** no-flash timing probe (logs apply-vs-paint; no assertion).
4. Anti-adblock: `antiadblock/resources.json` (function-expr scriptlets) + N detector fixtures + `antiadblock.spec.ts` — launch with the multi-line `TEST_FILTER` (cosmetic + `##+js(...)` rules) + `AEGIS_ADBLOCK_TEST_RESOURCES`, navigate each fixture, assert the wall is absent / primary content rendered (all pass).

**Block C — popup/redirect + regression gate**
5. Popup: `popup/*.html` fixtures + `popup.spec.ts` — popunder (`background-tab`/`other`) denied (no new window, content view unchanged); a foreground allowed-scheme new-window routed in-place (single view navigates); a top-frame redirect to a disallowed scheme blocked by `will-redirect`.
6. Regression gate: run the FULL `npm test` (272+ incl. the new windowOpen unit) and `npm run test:e2e` (24 + the 3 new adblock-layer specs); confirm green; final commit.

## 7. Known decisions folded in (don't re-litigate)
- No gesture detection (HandlerDetails has no gesture bit); disposition+scheme policy only; drop dead `save-to-disk`.
- Scriptlet bodies are function expressions; resources.json = `{scriptlets:[…],redirects:[]}`.
- No-flash report-only; supplementary stubs / `window.open` stub deferred (measure-then-add); `contentPreload` stays no-op.
- Synthetic anti-adblock fixtures deterministic (all pass); real-world partial, documented.

---

## 8. Review-driven corrections (AUTHORITATIVE — override §1–§7 wherever they conflict)
A first draft was adversarially reviewed; these corrections are mandatory.

**8.1 — Task 1 MUST update the existing `viewController.test.ts` (dropping `save-to-disk` is a behavior CHANGE).** Removing the dead `save-to-disk` branch means `save-to-disk` with an allowed URL now routes in-place (was: denied without load). The existing test `electron/main/viewController.test.ts` → `it('setWindowOpenHandler denies popunder dispositions', …)` loops `for (const disposition of ['background-tab', 'save-to-disk', 'other'])` (line ~459) and then asserts `expect(wc.loadURL).not.toHaveBeenCalled()` — which will FAIL for `save-to-disk` under the new policy. Task 1 MUST edit that loop to `['background-tab', 'other']` (remove `'save-to-disk'`), add `electron/main/viewController.test.ts` to its `git add`, and re-run `npx vitest run electron/main/viewController.test.ts` green. The other two existing popup tests (`routes an allowed foreground new-window in-place…` and `denies an allowed-disposition but disallowed-scheme url…`) ALREADY match the new policy — do not touch them. **Correct Task 1's prose/commit: save-to-disk behavior is INTENTIONALLY changed (it was dead/unreachable in practice — not a real disposition), NOT "runtime behavior unchanged."**

**8.2 — Task 1's disposition-sweep array MUST be `as const`.** `const dispositions = ['default','foreground-tab','background-tab','new-window','other'] as const;` — otherwise it infers `string[]`, and passing `string` to `decideWindowOpen`'s `Pick<HandlerDetails,'disposition'>` union is a TS2322 compile error that fails the vitest run.

**8.3 — Task 4 scriptlet bodies MUST NOT embed `{{n}}` arg tokens.** The engine assembles each scriptlet as `(BODY)(...[`{{1}}`,`{{2}}`,…])` and substitutes args via first-occurrence `String.replace`; a `{{2}}` literal inside the body gets mis-substituted. Use **no-arg, self-contained function-expression** scriptlets whose body hardcodes the defuse. Examples for `antiadblock/resources.json`:
```json
{ "scriptlets": [
  { "name": "aegis-set-false.js", "aliases": ["aegis-set-false"],
    "body": "function(){ Object.defineProperty(window, 'adblockDetected', { get: function(){ return false; }, set: function(){}, configurable: true }); }",
    "dependencies": [] },
  { "name": "aegis-no-bait.js", "aliases": ["aegis-no-bait"],
    "body": "function(){ Object.defineProperty(window, 'aegisBait', { get: function(){ return undefined; }, configurable: true }); }",
    "dependencies": [] }
], "redirects": [] }
```
invoked `127.0.0.1##+js(aegis-set-false)` / `127.0.0.1##+js(aegis-no-bait)` (no args). Name the `aegis-no-bait` fixture honestly as a **"property-read-returns-undefined defuser"** (not "abort-on-read", which it isn't).

**8.4 — Task 4 anti-adblock e2e MUST poll the end-state (scriptlet injection is async IPC).** Do NOT do a single synchronous `__contentVisible` read. Each detector fixture exposes a **re-checkable** end-state (e.g. the wall element's computed `display`/height, or a flag the detector re-evaluates on a `requestAnimationFrame`/`setInterval`), and the spec asserts via `await expect.poll(async () => <read via __aegisTest.primary.view.webContents.executeJavaScript>, { timeout: 15000 }).toBe(<expected>)`. The scriptlet defuses at `document_start` (before the page's inline detector in practice), but polling removes any residual race.

**8.5 — Task 5 popup e2e MUST be disposition-robust and not hardcode window counts.**
- Do NOT assert `app.windows().length === 1`. The `BaseWindow` hosts chrome + content = **2** page targets, and a spawned popup would make 3. Capture `const baseline = app.windows().length` after launch and assert it is **UNCHANGED** after each popup attempt (delta 0 = no popup opened).
- Deterministic, disposition-INDEPENDENT cases (hold for ANY disposition Electron assigns a scripted `window.open` — do NOT guess the disposition):
  (a) `window.open('<ALLOWED https url>', '_blank')` → routed in-place: assert the content view's `getState().url` becomes that URL (poll) AND `windows().length === baseline`.
  (b) `window.open('<DISALLOWED-scheme url, e.g. a custom scheme>', '_blank')` → denied without routing: content `getState().url` UNCHANGED AND `windows().length === baseline`.
  (c) top-frame redirect to a disallowed scheme (`location.href='aegis-bad://x'` or `<meta http-equiv=refresh>` to it) → blocked by `will-redirect`: content stays on the fixture.
- The `background-tab`/`other` → deny branch is covered DETERMINISTICALLY by the Task-1 `windowOpen.test.ts` unit test (pure function); the e2e need NOT force a background-tab disposition.

**8.6 — Minor.** Task 2 line range is **86-97** (consistent). Task 4: add a one-line note that `electron/test/fixtures/lists/resources.json` (Phase-1, empty) is SEPARATE/untouched — the new `antiadblock/resources.json` is read via `readFileSync` and passed inline through `AEGIS_ADBLOCK_TEST_RESOURCES`. Task 4: note the spec §4 "popunder" pattern is intentionally covered in Task 5 (`popup.spec.ts`), not `antiadblock.spec.ts`.
