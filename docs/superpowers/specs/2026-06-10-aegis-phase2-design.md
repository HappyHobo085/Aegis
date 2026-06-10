# Aegis — Design Spec, Phase 2 ("Cosmetic + anti-adblock verification & hardening")

**Date:** 2026-06-10
**Status:** Design approved → awaiting spec self-review + user review
**Parent specs:** `docs/superpowers/specs/2026-06-09-aegis-slice1-design.md` (Slice 1 = Phases 0–2) and `docs/superpowers/specs/2026-06-10-aegis-phase1-design.md`. This document carves **Phase 2** out of the Slice-1 spec, refined against the *as-built* Phase-0+1 code.
**Builds on:** Phase 0 + Phase 1 (complete, merged to `main`; 272 unit/component + 24 Playwright e2e green). Phase 1 turned the `@ghostery/adblocker-electron` engine **fully on** (network + cosmetic + scriptlet at library defaults).

> **Markers:** **[decided]** = locked this brainstorm; **[verify@plan]** = exact `@ghostery/adblocker` 2.18.0 behavior/schema to confirm against the installed source before writing code (per the project's verify-don't-guess rule).

---

## 1. Purpose & phase boundary

The cosmetic (Layer 2) and scriptlet/anti-adblock (Layer 3) engine layers are **already live** from Phase 1 — `enableBlockingInSession` runs the engine at full defaults, so DOM ad-hiding and uBO `##+js` scriptlets already execute on the content view. Phase 2 does **not add** those layers; it **proves they work** with a real fixture+test suite and **lightly hardens** the one remaining gap (the popup/redirect gate), without chasing the unwinnable anti-adblock cat-and-mouse (the brief §7 states 100% is not achievable).

### Two scope decisions locked this phase
1. **Verify + light, measured hardening** (not maximal). Build the verification suite + modularize/lightly-harden the popup gate; defer supplementary anti-adblock stubs and the in-page `window.open` stub to *measure-then-add* (built only if a fixture demonstrably needs them).
2. **No-flash = deterministic end-state assert + report-only timing probe.** The cosmetic e2e asserts the sentinel container ends hidden (the real gate); a separate best-effort probe records cosmetic-apply time vs first paint and **logs** it (no hard pass/fail) — honoring the engine's inherently-async injection (Slice-1 §3.3: best-effort, measured not guaranteed).

### In scope (Phase 2)
- **Cosmetic verification:** a sentinel ad container (300×250) ends visually hidden (`display:none` / zero rendered height) — generic and per-host cosmetic rules.
- **No-flash:** deterministic end-state assert + report-only apply-vs-paint timing probe.
- **Anti-adblock / scriptlet verification:** a small, deterministic, in-repo detector-fixture suite (N≈4–6 representative patterns) with a committed custom scriptlet `resources.json`; each fixture's wall is neutralized / primary content rendered.
- **Popup/redirect hardening (light):** extract the inline `setWindowOpenHandler` policy into a pure, unit-testable `electron/main/windowOpen.ts`; e2e-verify popunder-denied / new-window-routed-in-place / hostile-scheme-redirect-blocked.
- **Deterministic e2e test hooks:** extend `AEGIS_ADBLOCK_TEST_FILTER` (multi-line) + add `AEGIS_ADBLOCK_TEST_RESOURCES` so cosmetic/scriptlet tests run against a controlled engine.

### Deferred (documented, not built now)
- **Supplementary global anti-adblock stubs** (the `adblock-helper`-style floor): measure-then-add; built only if a deterministic fixture needs more than uBO `##+js` scriptlets.
- **In-page `window.open` return-value stub:** `contentPreload.ts` stays a no-op; the main-process gate is authoritative. Add only if a popunder fixture breaks without it.
- **Aggressive user-gesture popup detection:** Electron's `setWindowOpenHandler` `details` exposes no reliable user-gesture bit **[verify@plan]**; the policy stays disposition+scheme-based and the limitation is documented.

### Explicit non-goals (carried)
No real-world anti-adblock wall coverage in CI (synthetic deterministic fixtures only; real-world is inherently partial, brief §7); no proxy/MITM; no new engine layers (all three already live).

---

## 2. As-built integration facts (verified by reading the code)
- **Engine runs full defaults** (`adblock/engine.ts` `buildEngine` passes NO config) → `loadCosmeticFilters` / `loadGenericCosmeticsFilters` / scriptlets all ON. Cosmetic CSS injects via the engine's auto-registered preload → main-process `insertCSS(styles,{cssOrigin:'user'})`; scriptlets via main-world `executeJavaScript` (Slice-1 §3.3).
- **Popup floor (`viewController.ts` `setWindowOpenHandler`):** denies `background-tab`/`save-to-disk`/`other`; routes an allowed-scheme new-window in-place via `this.wc().loadURL`; denies otherwise. Inline today → Phase 2 extracts it.
- **Redirect/nav gate (`viewController.ts`):** `will-navigate`/`will-redirect` call `isAllowedNavigationUrl` and `preventDefault` on disallowed schemes (already blocks hostile-scheme top-frame redirects).
- **`contentPreload.ts`:** no-op (isolated world can't touch main-world `window.open`).
- **e2e determinism hooks (boot, under `AEGIS_E2E`):** `AEGIS_ADBLOCK_TEST_FILTER` → initial engine = `buildEngine([filter], null)`; `AEGIS_ADBLOCK_OFFLINE`, `AEGIS_ADBLOCK_LIST_BASE`. `__aegisTest.adblock` exposes `snapshotCount`/`isBlockingActive`/`engineSource`/`setEnabled`/`toggleAllowlist`/`getState`/`updateNow`; `__aegisTest.primary` is the ViewController. The retry-tolerant `launchApp` poll pattern is now standard in the e2e specs.

---

## 3. Cosmetic verification (Layer 2)
**Mechanism (live):** the engine's preload calls `onInjectCosmeticFilters` → `getCosmeticsFilters({getBaseRules,getRulesFromHostname,…})` → the main process `insertCSS`es the returned user-CSS into the top frame.
**Verification (deterministic):** the e2e builds a test engine containing cosmetic rules — a **generic** rule `##.aegis-ad-sentinel` and a **per-host** rule `127.0.0.1##.aegis-ad-sentinel-host` — and loads a fixture with both sentinel `<div>`s sized 300×250. Assert each ends `display:none` (or `getBoundingClientRect().height === 0`) after load. **[verify@plan]** that a generic cosmetic rule in a minimal `parse()`-built engine actually injects (default `loadGenericCosmeticsFilters:true`; the base stylesheet carries generic hides).
**No-flash:** the hide assertion above is the gate. A separate **report-only** probe (e.g. a `PerformanceObserver('paint')` reading in the content page, or a timestamp captured when the user-CSS lands vs the first paint entry) logs whether/when the sentinel could have been briefly visible; it **never fails the test**. **[decided]**

---

## 4. Anti-adblock / scriptlet verification (Layer 3)
**Mechanism (live):** `##+js(scriptlet, args)` rules inject **main-world** via `executeJavaScript(script, true)` (bypasses page CSP). Scriptlet bodies come from the engine's **resources** (loaded via `updateResources`).
**Verification (deterministic + self-contained):** commit a small fixture **`resources.json`** (real uBO-shaped `scriptlets[]`; exact schema **[verify@plan]** against `Resources.parse`/`isScriptletValid`) defining only the scriptlets the fixtures use. Each detector fixture pairs a wall simulation with the rule(s) that neutralize it; the test engine = `buildEngine([rules…], fixtureResourcesJson)`. Representative set (N≈4–6) **[decided]**:
- `set-constant`-style defuser (page reads `window.adblockDetected`; scriptlet forces it `false` → no wall).
- `abort-on-property-read`/`abort-current-script`-style bait (page aborts on a bait global; scriptlet prevents it → content runs).
- A "disable your ad blocker" overlay element removed by a **cosmetic** rule (`##.adblock-wall`).
- A **popunder** attempt neutralized by the §4-main-gate (no new window; content unaffected).
Assert each fixture renders primary content with the wall absent. Synthetic fixtures are deterministic → **all must pass**; real-world anti-adblock is inherently partial (brief §7) and **documented, not chased** (so the Slice-1 "≥M of N" reduces to M=N for the synthetic suite, with the <100% caveat recorded). **[decided]**

---

## 5. Popup/redirect hardening (light)
Extract `electron/main/windowOpen.ts` exposing a **pure** function:
```
decideWindowOpen(details: { url: string; disposition: string }): { action: 'deny' } | { action: 'deny'; loadInPlace: string }
```
encoding the current policy verbatim: deny `background-tab`/`save-to-disk`/`other`; if the URL passes `isAllowedNavigationUrl`, return `{action:'deny', loadInPlace: url}`; else deny. `ViewController.setWindowOpenHandler` calls it and performs `this.wc().loadURL(loadInPlace)` when present — **same runtime behavior, now unit-testable in isolation** (today it's only e2e-reachable). e2e verifies: a popunder (`window.open` with a popunder disposition / `target=_blank` with `rel=noopener` to a blank) yields no new window and an unchanged content view; a legit foreground new-window to an allowed `https` URL navigates the single view in-place; a top-frame redirect to a disallowed scheme is blocked by the existing `will-redirect` gate. The no-reliable-gesture-bit limitation is documented. **[decided]**

---

## 6. Deterministic e2e test hooks (boot, `AEGIS_E2E` only)
Extend boot's existing hooks (no production-path change):
- `AEGIS_ADBLOCK_TEST_FILTER` accepts a **multi-line** filter set (newline-split into network + cosmetic + scriptlet rules); the test engine = `buildEngine(splitNonEmptyLines(TEST_FILTER), <resources>)`.
- new `AEGIS_ADBLOCK_TEST_RESOURCES` — a path to (or inline content of) the scriptlet `resources.json`; when set, passed as the `resources` arg to `buildEngine` so scriptlets resolve. When unset, `null` (unchanged). **[decided]**

---

## 7. New / touched module structure
```
electron/main/windowOpen.ts                    pure decideWindowOpen(details) policy (extracted from viewController)
electron/main/windowOpen.test.ts               unit tests (every disposition/scheme branch)
electron/test/fixtures/cosmetic/*.html         sentinel-container pages (generic + per-host)
electron/test/fixtures/antiadblock/*.html      N detector pages
electron/test/fixtures/antiadblock/resources.json   committed fixture scriptlet resources
electron/test/fixtures/popup/*.html            popunder / target=_blank / hostile-redirect pages
electron/test/e2e/cosmetic.spec.ts             hide assert (generic + per-host) + report-only no-flash probe
electron/test/e2e/antiadblock.spec.ts          deterministic detector suite (all pass)
electron/test/e2e/popup.spec.ts                popunder denied / new-window in-place / redirect blocked
```
Touched: `viewController.ts` (delegate `setWindowOpenHandler` to `windowOpen.ts`), `index.ts` (extended `AEGIS_ADBLOCK_TEST_*` hooks), `fixtureServer.ts` (serve the new fixture dirs / MIME if needed).

---

## 8. Testing strategy
- **Unit:** `windowOpen.test.ts` — every branch of `decideWindowOpen` (each popunder disposition → deny; allowed-scheme foreground → `loadInPlace`; disallowed scheme → deny).
- **e2e (Playwright `_electron`, deterministic via §6 hooks; retry-tolerant `launchApp`):**
  - `cosmetic.spec.ts` — generic + per-host sentinel hidden; report-only no-flash probe logs timing.
  - `antiadblock.spec.ts` — each detector fixture's wall neutralized / content rendered.
  - `popup.spec.ts` — popunder denied; foreground new-window routed in-place; hostile-scheme redirect blocked.
- **Regression:** the full Phase-0+1 suite (272 unit/component + 24 e2e) stays green.

---

## 9. Success criteria (Phase-2 subset of Slice-1 §10.3/§10.4)
1. **Ads gone — cosmetic half (§10.3):** sentinel container ends visually hidden on a pinned fixture (generic + per-host); no-flash measured + reported (non-gating).
2. **Anti-adblock pages usable (§10.4):** every synthetic detector fixture renders primary content with the wall absent (all pass; real-world <100% documented).
3. **Popup/redirect:** popunder denied; legit new-window routed in-place; hostile-scheme redirect blocked — `windowOpen.ts` unit-covered.
4. **No regression:** Phase-0+1 gate green (272 unit + 24 e2e), plus the new Phase-2 unit + e2e.

---

## 10. Open items to resolve during planning (verify against `@ghostery/adblocker` 2.18.0 source)
1. Generic + per-host cosmetic injection from a minimal `parse()`-built engine (does the base stylesheet carry the generic hide; does per-host resolve for `127.0.0.1`).
2. Exact `resources.json` `scriptlets[]` object schema `Resources.parse` accepts (`isScriptletValid`), and that a `##+js(...)` rule injects main-world with a custom resources set.
3. Confirm `setWindowOpenHandler` `details` has no usable user-gesture flag (drives the disposition-only policy + documented limitation).
4. Whether any deterministic detector genuinely needs a supplementary stub or the in-page `window.open` return-stub (decides the deferred items; default = not built).
