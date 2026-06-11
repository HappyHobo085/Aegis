# Aegis Restyle (Universal Wrapper visual language) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.
> Spec: `docs/superpowers/specs/2026-06-11-aegis-restyle-uw-design.md`. Branch: `restyle-uw` (LOCAL commits only — never push/remote/branch-rename).

**Goal:** Re-skin Aegis's chrome in the UW visual language (dark `#121212`/`#1f1f1f`/`#2a2a2a`, `#3b82f6` accent, pill inputs, chip favorites, card rows, modal+scrim, toasts, custom scrollbars) and convert the sidebar to a **right overlay + scrim**.

**Architecture:** Almost all styling lives in the single global `src/index.css` against existing BEM hooks (currently unstyled). The sidebar overlay is a main-process **z-order swap** with a **transparent chrome WebContentsView** (primary) and a documented **right-inset fallback** if transparency fails the spike.

**Tech Stack:** Electron 42 · React 19 + TS · electron-vite · Vitest 4 · Playwright `_electron`. Dual-ABI: renderer/pure unit → `npx vitest run <f>`; DB unit → `npm run rebuild:node && npx vitest run <f>`; e2e → `npm run rebuild:electron && npm run build && npx playwright test <f>`. Full gate: `npm test` then `npm run build && npm run test:e2e`.

**tsc baseline:** `tsc --noEmit` is not a gate; pre-existing `*.test.ts(x)` noise is accepted. The bar per task = the task's PRODUCTION files must not newly appear in `npx tsc --noEmit 2>&1 | grep -E '^(src|electron|shared)/' | grep -vE '\.test\.'`.

---

## Block A — Tokens & accent default

### Task 1: Re-base `:root` tokens + base primitives (UW palette)

**Files:** Modify `src/index.css`.

- [ ] **Step 1:** Replace the `:root` block with the spec §1 token set (verbatim): re-mapped `--accent-color:#3b82f6`, `--bg:#121212`, `--bg-elevated:#1f1f1f`, `--bg-input:#2a2a2a`, `--fg:#e0e0e0`, `--fg-muted:#888`, `--border:#333`, keep `--danger:#ff5d5d`, `--chrome-top-height:56px`; ADD `--border-2:#444`, `--success:#22c55e`, `--text-on-accent:#fff`, `--radius-1..4`, `--radius-pill:999px`, `--shadow-modal`, `--shadow-float`.
- [ ] **Step 2:** Update base rules: keep `* {box-sizing}`, `html,body,#root {margin/padding/height/width}`. Change `body` to `background: transparent;` (overlay needs the content region transparent — toolbar/favbar/sidebar paint their own bg), keep `color:var(--fg)`, font stack, `font-size:14px`, `overflow:hidden`. Keep the `button`/`input`/`:focus-visible` primitives (they already consume tokens; the focus stays `2px solid var(--accent-color)`).
- [ ] **Step 3:** Build check: `npm run build 2>&1 | tail -3` → builds clean (CSS only; no JS change). The app will still render (tokens just changed values; chrome bg becomes transparent — content view covers it while browsing).
- [ ] **Step 4:** Commit `style(restyle): re-base :root tokens to UW palette + transparent app shell`.

**Acceptance:** `:root` holds the §1 tokens; `body` background transparent; build clean.

### Task 2: Default accent → `#3b82f6` (themeable)

**Files:** Modify `electron/main/db/settingsRepo.ts`, `src/hooks/useSettings.ts`, `electron/main/pickerHelpers.ts`; update any test asserting the old default.

- [ ] **Step 1:** Grep the old default: `grep -rn "#7c5cff" src electron shared`. Expected: `settingsRepo.ts:8`, `useSettings.ts:10`, `pickerHelpers.ts:80` (overlay border `#7c5cff` + `rgba(124,92,255,0.2)`), plus any test.
- [ ] **Step 2:** Change `DEFAULT_SETTINGS.primaryColor` (`settingsRepo.ts`) and `emptySettings.primaryColor` (`useSettings.ts`) `#7c5cff` → `#3b82f6`.
- [ ] **Step 3:** In `pickerHelpers.ts:80`, change the overlay cssText accent to blue: border `2px solid #3b82f6`, background `rgba(59,130,246,0.2)`.
- [ ] **Step 4:** Update tests asserting the old default: grep `#7c5cff` in `*.test.*` (likely `settingsRepo.test.ts`, maybe `useSettings.test.tsx`) and switch expectations to `#3b82f6`. Run them: `npm run rebuild:node && npx vitest run electron/main/db/settingsRepo.test.ts` and `npx vitest run src/hooks/useSettings.test.tsx` (if present). Paste real PASS counts.
- [ ] **Step 5:** Commit `feat(restyle): default accent → UW blue #3b82f6 (themeable)`.

**Acceptance:** default primaryColor is `#3b82f6` in both sources + picker overlay; affected unit tests green.

---

## Block B — Sidebar → right overlay + scrim (architecture)

### Task 3: Main-process overlay mechanism + IPC + SPIKE (transparency & z-order)

**Files:** Modify `electron/main/window.ts`, `electron/main/index.ts`, `shared/types.ts`, `electron/preload/chromePreload.ts`, `electron/main/ipc/viewLayout.ts`; tests `electron/main/ipc/viewLayout.test.ts`.

- [ ] **Step 1 — chrome transparent:** In `createMainWindow` (`window.ts`), after creating `chromeView`, add `chromeView.setBackgroundColor('#00000000');`. (Keep everything else.)
- [ ] **Step 2 — new IPC channel + type:** In `shared/types.ts`, add to `IPC`: `viewSetSidebarOpen: 'view.setSidebarOpen'`. Add to `AegisApi.view`: `setSidebarOpen(viewId: ViewId, open: boolean): Promise<void>;`.
- [ ] **Step 3 — preload wrapper:** In `chromePreload.ts` `view` namespace, add `setSidebarOpen: (viewId: ViewId, open: boolean) => ipcRenderer.invoke(IPC.viewSetSidebarOpen, viewId, open),` (mirror the existing `setContentInset` wrapper).
- [ ] **Step 4 — handler:** Extend `buildViewLayoutHandlers` to also accept a `setSidebarOpen` closure and register `[IPC.viewSetSidebarOpen]: (_viewId, open: boolean) => setSidebarOpen(open)`. Update its signature to `buildViewLayoutHandlers(setContentInset, setSidebarOpen)`. Update `viewLayout.test.ts` to pass a second spy and assert it's called with the boolean. Run `npx vitest run electron/main/ipc/viewLayout.test.ts` (pure) → paste PASS.
- [ ] **Step 5 — main closure + z-swap:** In `index.ts`, after `win.contentView.addChildView(vc.view)` and the `setContentInset` closure, add:

```ts
// Sidebar overlay: chrome (transparent) on top when open (scrim + right panel paint
// over the content view); content view on top when closed (normal browsing). Bounds
// never change for the sidebar — only the top inset applies (left always 0).
const bringToTop = (v: WebContentsView): void => {
  win.contentView.removeChildView(v);
  win.contentView.addChildView(v);
};
const setSidebarOpen = (open: boolean): void => {
  bringToTop(open ? chromeView : vc.view);
};
```

Import `WebContentsView` type if needed (already imported in window.ts; in index.ts use the value via the existing electron import or type only — `bringToTop` takes the concrete views in scope, so a local `(v: Electron.WebContentsView)` annotation avoids a new import). Wire the handler: change the `...buildViewLayoutHandlers(setContentInset)` spread to `...buildViewLayoutHandlers(setContentInset, setSidebarOpen)`.
- [ ] **Step 6 — test seam:** In the `AEGIS_E2E` registry, add to `places`: `setSidebarOpen` (the closure), and add a top-level `view: { isChromeOnTop: () => win.contentView.children.at(-1) === chromeView }`.
- [ ] **Step 7 — SPIKE (build + verify):** `npm run rebuild:electron && npm run build`. Then write a throwaway verify (a tiny `_electron` script in the project root, run, then delete — do NOT commit it) that: launches with `AEGIS_E2E=1`, navigates content to `about:blank`, then:
  - **(a) z-order:** asserts `__aegisTest.view.isChromeOnTop()` is `false`; calls `__aegisTest.places.setSidebarOpen(true)`; asserts it's now `true`; `setSidebarOpen(false)` → `false`.
  - **(b) transparency:** with the sidebar open (chrome on top), `app.evaluate` → `chromeWc.capturePage()` is not directly addressable; instead capture the chrome view via `__aegisTest`-exposed handle OR sample through the BaseWindow: use `win.contentView` not capturable. Practical check: `chromeView.webContents.capturePage({x:200,y:300,width:2,height:2})` returns a NativeImage; `image.toBitmap()` (BGRA) — assert the sampled pixel alpha byte ≈ 0 in the content region (chrome paints nothing there). Expose a tiny registry helper `view.sampleChromeAlpha(x,y)` returning the alpha byte to make this driveable. Paste the real numbers.
  - Print PASS/FAIL for (a) and (b). Delete the script.
- [ ] **Step 8 — DECISION GATE:**
  - If (a) AND (b) pass → **primary path confirmed**; proceed.
  - If (b) fails (chrome region not transparent / content not visible through) → **FALLBACK**: do NOT use the z-swap. Instead revert `setBackgroundColor` transparent (chrome stays opaque), keep `setSidebarOpen` as a no-op shim, and extend the inset to a **right** inset: add `right` to `ContentInset` (`shared/types.ts`) and to `layout()` (`window.ts`: `width: width - inset.left - (inset.right ?? 0)`), and have `setContentInset` carry it. Document the pivot in the commit message and report it so Task 4/5 use the right-inset variant. (Report BLOCKED-with-evidence only if BOTH fail.)
- [ ] **Step 9:** Commit `feat(restyle): chrome z-order overlay mechanism + view.setSidebarOpen IPC (spike: <result>)`.

**Acceptance:** new IPC wired + guarded; `setSidebarOpen` swaps z-order; spike result recorded (primary or fallback); `viewLayout.test.ts` green; production tsc clean for touched files (note: `chromePreload.ts` may transiently reference the new member until all wired — verify clean at task end).

### Task 4: Renderer overlay wiring (Sidebar panel + scrim, toggle → Toolbar)

**Files:** Modify `src/hooks/useContentInset.ts`, `src/components/Sidebar.tsx`, `src/components/Toolbar.tsx`, `src/App.tsx`; tests `src/components/Sidebar.test.tsx`, `src/components/Toolbar.test.tsx`, `src/App.test.tsx`. (Primary path; if Task 3 chose fallback, keep `useContentInset` reporting the right inset instead — see note.)

- [ ] **Step 1 — useContentInset (primary):** Simplify to report a constant top inset and drive the swap:

```ts
import { useEffect } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { TOOLBAR_H, FAVBAR_H } from '../lib/layout';

/** Top inset is constant (toolbar + always-on favbar). The sidebar is an overlay,
 *  so it never insets content — it drives a z-order swap via view.setSidebarOpen. */
export function useContentInset(viewId: ViewId, { sidebarOpen }: { sidebarOpen: boolean }): void {
  useEffect(() => {
    void aegis.view.setContentInset(viewId, { top: TOOLBAR_H + FAVBAR_H, left: 0 });
  }, [viewId]);
  useEffect(() => {
    void aegis.view.setSidebarOpen(viewId, sidebarOpen);
  }, [viewId, sidebarOpen]);
}
```
  *(Fallback variant: keep the single effect but report `{ top, left:0, right: sidebarOpen?SIDEBAR_W:0 }` and skip `setSidebarOpen`.)*
- [ ] **Step 2 — Sidebar.tsx → overlay:** Remove the always-rendered `__toggle` button from `Sidebar`. Render nothing when `!open`; when `open`, render a scrim + right panel. New props: `open`, `onClose()`, `history`, `saved`, `downloads`. Structure:

```tsx
if (!open) return null;
return (
  <>
    <div className="sidebar__scrim" onClick={onClose} aria-hidden="true" />
    <aside className="sidebar sidebar__panel" aria-label="Sidebar">
      <div className="sidebar__head">
        <div className="sidebar__tabs" role="tablist" aria-label="Sidebar panels">{/* tabs as today */}</div>
        <button type="button" className="sidebar__close" aria-label="Close sidebar" onClick={onClose}>{'×'}</button>
      </div>
      <div role="tabpanel" id={panelIds[tab]} aria-labelledby={tabIds[tab]} className="sidebar__content">
        {panels[tab]}
      </div>
    </aside>
  </>
);
```
  Keep the `useId` tab/panel wiring and tab buttons (`sidebar__tab`, role=tab, aria-selected) exactly as today.
- [ ] **Step 3 — Toolbar.tsx:** Add an optional `menu?: ReactNode` slot, rendered last (right side), for the sidebar toggle. (Update `ToolbarProps` + destructure + render `{menu}` after `{gear}`.)
- [ ] **Step 4 — App.tsx:** Pass a toggle button into the new Toolbar `menu` slot:

```tsx
menu={
  <button type="button" className="toolbar__sidebar-toggle" aria-label="Toggle sidebar"
    aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((v) => !v)}>{'☰'}</button>
}
```
  Change the `<Sidebar .../>` usage: replace `onToggle={...}` with `onClose={() => setSidebarOpen(false)}` (keep `open` + the three panel props). The `DownloadsIndicator onOpen` still does `setSidebarOpen(true)`.
- [ ] **Step 5 — tests:** Update `Sidebar.test.tsx` (no toggle inside; renders scrim+panel when open; close button + scrim call onClose; hidden when closed), `Toolbar.test.tsx` (renders the `menu` slot), `App.test.tsx` (the sidebar toggle now in toolbar; `aegis.view.setSidebarOpen` mock added to the ipcClient mock; opening via toolbar toggle / downloads indicator). Run `npx vitest run src/components/Sidebar.test.tsx src/components/Toolbar.test.tsx src/App.test.tsx` → paste real PASS counts.
- [ ] **Step 6 — tsc:** `npx tsc --noEmit 2>&1 | grep -E '^(src|electron|shared)/' | grep -vE '\.test\.'` → empty.
- [ ] **Step 7:** Commit `feat(restyle): sidebar right-overlay renderer wiring (scrim + panel; toggle in toolbar)`.

**Acceptance:** sidebar renders as scrim+right panel when open, hidden when closed; toggle in toolbar; `setSidebarOpen` driven on toggle; touched suites green; production tsc clean.

### Task 5: Rewrite `sidebar.spec.ts` for the overlay model

**Files:** Modify `electron/test/e2e/sidebar.spec.ts`.

- [ ] **Step 1:** Keep `launchApp`/`contentBounds` helpers. Replace the `setContentInset` driver with a `setSidebarOpen` driver: `app.evaluate((_e, open) => (globalThis as any).__aegisTest.places.setSidebarOpen(open), open)` and an `isChromeOnTop` reader `app.evaluate(() => (globalThis as any).__aegisTest.view.isChromeOnTop())`.
- [ ] **Step 2 — tests (primary path):**
  - *Top inset on boot:* `contentBounds.y === 96` and `x === 0` (unchanged).
  - *Opening the sidebar overlays (does not inset content):* read closed bounds; `setSidebarOpen(true)`; poll `isChromeOnTop()` → true; assert content bounds **unchanged** (`x===0`, `width===closed.width`, `y===96`). `setSidebarOpen(false)`; poll `isChromeOnTop()` → false; bounds still unchanged.
  - *Resize preserves top inset:* open sidebar, resize window, assert `contentBounds.y===96`, `x===0`, `width===winW` (full width; no inset).
  *(Fallback variant: assert the right inset instead — `width===winW - SIDEBAR_W` when open, `x===0`.)*
- [ ] **Step 3:** `npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/sidebar.spec.ts` → paste real PASS.
- [ ] **Step 4:** Commit `test(e2e): sidebar overlay (z-order swap, no content inset on open)`.

**Acceptance:** sidebar e2e asserts the overlay/z-swap behavior and passes on a real build.

---

## Block C — Chrome CSS authoring (UW visual language)

> All tasks append rules to `src/index.css` against the inventoried BEM classes. Each: read the component JSX for exact class names + structure, author the CSS per spec §2 (concrete tokens), `npm run build` (clean), eyeball-free verify via the existing renderer tests still passing (`npx vitest run <component>.test.tsx` for any touched component test — CSS doesn't affect jsdom tests, so this just confirms no import breakage), commit. No behavior change.

### Task 6: App shell, scrollbars, skip-link, keyframes

**Files:** `src/index.css`.
- [ ] Author: `.app { display:flex; flex-direction:column; height:100%; }`; the content region between favbar and bottom is transparent (content view shows there). `.content-anchor` zero-size focus target. Custom `::-webkit-scrollbar` (8px; track `var(--bg)`; thumb `var(--bg-input)` r4; `:hover` `var(--border-2)`). `.skip-link` offscreen→`:focus` accent. Keyframes `toast-in`, `scrim-fade-in`, `sidebar-in`.
- [ ] Build clean; commit `style(restyle): app shell, scrollbars, skip-link, keyframes`.

### Task 7: Toolbar group (toolbar, nav buttons, address pill, adblock shield)

**Files:** `src/index.css` (read `Toolbar.tsx`, `NavControls.tsx`, `AddressBar.tsx`, `AdblockShield.tsx`, `BookmarkButton.tsx`, `PickerButton.tsx`, `DownloadsIndicator.tsx`).
- [ ] `.toolbar` flex row (spec §2). Icon-button rule shared by `.nav-controls button`, `.toolbar__gear`, `.toolbar__picker`, `.toolbar__sidebar-toggle`, `.bookmark-button`, `.toolbar__downloads` (32px, r6, transparent, `--fg-muted`, hover `rgba(255,255,255,0.08)`+`--fg`). `.bookmark-button[aria-pressed="true"]`/saved → accent tint. `.address-bar` pill (spec §2). `.toolbar__downloads-badge` accent count pill. `.adblock-shield*`: icon button + `__count`/`__badge` accent pill + `__popover` card pattern + `__row`/`__switch`/`__divider`/`__hint`/`__count` per inventory.
- [ ] Build clean; commit `style(restyle): toolbar, nav buttons, address pill, adblock shield`.

### Task 8: Favorites bar + tag filter + tag input

**Files:** `src/index.css` (read `FavoritesBar.tsx`, `TagFilter.tsx`, `TagInput.tsx`).
- [ ] `.favorites-bar` strip (height 40, `padding:0 12px`, `rgba(0,0,0,0.35)`, `display:flex; gap:8px; overflow-x:auto`). `.favorites-bar__chip` favorite pill; `.favorites-bar__manage` subtle pill. `.tag-filter`/`.tag-filter__chip` (pill, active→accent fill). `.tag-input`/`.tag-input__chips`/`.tag-input__chip` chips.
- [ ] Build clean; commit `style(restyle): favorites bar + tag chips`.

### Task 9: Sidebar overlay panel + list panels (history/saved/downloads)

**Files:** `src/index.css` (read `Sidebar.tsx` (as rewritten in T4), `HistoryPanel.tsx`, `SavedPanel.tsx`, `DownloadsPanel.tsx`).
- [ ] `.sidebar__scrim` (fixed, inset:0 below toolbar, `rgba(0,0,0,0.5)`, `scrim-fade-in`, z below panel). `.sidebar__panel` (fixed right, top:96, bottom:0, width:280, `--bg-elevated`, left border, `--shadow-modal`, `sidebar-in` slide). `.sidebar__head` (flex, padding `12px 15px`, border-bottom). `.sidebar__tabs`/`.sidebar__tab` underline tabs (active → `--fg` + 2px accent bottom border; inactive `--fg-muted`). `.sidebar__close` icon button. `.sidebar__content` (flex:1; overflow-y:auto; padding 12px). List rows for `.history-panel__*`, `.saved-panel__*`, `.downloads-panel*` per spec §2 (card rows; `__open` link styling; `__remove`/cancel `--danger`; `__time`/`__url` muted; `__search` pill; `__clear` button; `__empty` muted; downloads `__progress` track `--bg-input`/fill accent — keep inline width).
- [ ] Build clean; commit `style(restyle): sidebar overlay panel + history/saved/downloads list rows`.

### Task 10: Settings modal + scrim + all tabs

**Files:** `src/index.css` (read `SettingsModal.tsx` + each tab: `AppearanceTab`, `SearchTab`, `HomeTab`, `FilterListsTab`, `MyFiltersTab`, `AllowlistTab`, `DownloadsTab`, `SitePermissionsTab`, `DataTab`).
- [ ] `.settings-modal` scrim + centered `.settings-modal` content card? — note the inventory: the modal root is `.settings-modal` with `__header/__title/__tabs/__tab/__panel/__body`. Author: a fixed full-window scrim wrapper rule (the component renders `.settings-modal` as the overlay root — style it `position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:11000; display:flex; align-items:center; justify-content:center;`) and an inner content card via `.settings-modal__body`/a content wrapper (`--bg-elevated`, r12, padding 24, `--shadow-modal`, max-width ~640, max-height 80vh, overflow). If the JSX has no separate content wrapper element, add one in the component (minimal structural edit) OR style `.settings-modal` as the card and add a separate scrim — read the JSX and choose the smallest correct structure; document it. `__header`+`__title` (18/700) + a close `×`. `__tabs`/`__tab` underline pattern. `__panel` scroll area. Form controls across all tabs: labels `--fg-muted`; inputs/textareas `--bg-input`/`--border`/r6/accent focus; submit/add buttons accent-filled; remove/clear bordered or `--danger`; `*-tab__row` card rows; `.my-filters-tab__textarea` styled; keep `<input type=color>`.
- [ ] Build clean; `npx vitest run src/components/SettingsModal.test.tsx` (no import breakage); commit `style(restyle): settings modal + scrim + all tabs`.

### Task 11: Dialogs, overlays, toasts, hint

**Files:** `src/index.css` (read `ConfirmDialog.tsx`, `PermissionPromptDialog.tsx`, `ErrorOverlay.tsx`, `FavoritesManager.tsx`, `Toaster.tsx`, `WelcomeHint.tsx`).
- [ ] `.favorites-manager` modal (scrim + card, `__header/__title/__row/__tags` per inventory). `.permission-prompt` (scrim + card; `__message`; `__actions`: Allow accent, Block bordered/danger). `.confirm-*` (scrim + card; primary accent / danger). `.error-overlay__*` (overlay + `__panel` card, `__heading`/`__detail`/`__body`/`__actions`; primary accent). `.toaster`/`.toast` (fixed bottom-right; per-type left accent border: success `--success`, error `--danger`, info `--accent-color`; `toast-in`). `.welcome-hint` (fixed bottom-left, 3px accent left border, float shadow). `.loading-indicator` subtle.
- [ ] Build clean; commit `style(restyle): dialogs, error overlay, toasts, welcome hint`.

---

## Block D — Gate & visual verification

### Task 12: Full dual-ABI gate + live visual smoke + doc note

**Files:** none (verification) + optional `docs/superpowers/specs/2026-06-11-aegis-restyle-uw-design.md` note.
- [ ] **Step 1 — gate:** `npm test` (unit) then `npm run build && npm run test:e2e` (e2e). Paste both real summaries (counts). Any failure caused by the restyle → fix in the relevant task's files and re-run. (Expected adjustments already covered by T2/T4/T5 test edits.)
- [ ] **Step 2 — tsc:** `npx tsc --noEmit 2>&1 | grep -E '^(src|electron|shared)/' | grep -vE '\.test\.'` → empty.
- [ ] **Step 3 — live visual smoke:** run the narrated `_electron` smoke flow (as used previously) to confirm the app still boots + functions with the new chrome (ad-block, favorites, sidebar overlay open/close via `setSidebarOpen`, downloads, picker). Paste the narration. (This exercises behavior; visual fidelity is reviewed via the per-task specs + the brief.)
- [ ] **Step 4:** Commit `chore(restyle): full dual-ABI gate green + visual smoke (restyle exit)`.

**Acceptance:** full gate green (unit + e2e), production tsc clean, app boots/functions with the UW skin + overlay sidebar.

---

## Notes for the executor
- **Spike first (Task 3 Step 7–8).** The whole Block B primary path depends on chrome transparency. Record the result; if fallback, carry the right-inset variant through Tasks 4–5 (their fallback notes).
- **Single CSS file**, sequential CSS tasks (B/C touch `src/index.css`) — no parallel implementers.
- **Local commits only** on `restyle-uw`; never push/remote/branch-rename. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
