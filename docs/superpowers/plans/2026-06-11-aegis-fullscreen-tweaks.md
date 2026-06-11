# Aegis — Fullscreen content + favbar color + bookmark discoverability — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.
> Branch: `fullscreen-tweaks` (LOCAL commits only — never push/remote/branch-rename). Builds on the merged UW restyle + overlay architecture.

**Goal (3 user requests):**
1. **Favorites-bar color** → the same grey as the modals/popovers (`var(--bg-elevated)`, was `rgba(0,0,0,0.35)`).
2. **Bookmark discoverability** — the ★ bookmark button works (saves to the Saved list) but is hard to find; add hover **tooltips** (`title`) to the toolbar icon buttons (especially ★) so they're discoverable. Keep the Saved-list behavior + the disable-on-no-host logic.
3. **Fullscreen content** — a toolbar button hides the toolbar + favorites bar and fills the window with the web content; exit via a **small button overlaid top-right**.

**Fullscreen architecture (decided):** the content view is a separate native view on top of the (transparent) chrome view, so a chrome button behind it isn't clickable. Instead, in fullscreen the **chrome view is shrunk to a small top-right corner** (kept on top), the content view fills the whole window, and the chrome renders only the exit button into that corner. The corner is clickable; the rest of the page stays interactive. Consolidate the main-process layout into a single `relayout()` + `applyZOrder()` driven by `{ contentInset, fullscreen, chromeOnTop }`.

**Tech:** Electron 42 · React 19 + TS · electron-vite · Vitest 4 · Playwright. tsc bar: production files must not newly appear in `npx tsc --noEmit 2>&1 | grep -E '^(src|electron|shared)/' | grep -vE '\.test\.'`.

---

## Block A — Small UI tweaks

### Task 1: Favorites-bar color + toolbar tooltips

**Files:** `src/index.css`; `src/components/BookmarkButton.tsx`, `NavControls.tsx`, `AdblockShield.tsx`, `PickerButton.tsx`, `DownloadsIndicator.tsx`, `src/App.tsx` (gear + sidebar-toggle buttons); affected tests.

- [ ] **Favbar color:** in `src/index.css`, change `.favorites-bar { background: rgba(0, 0, 0, 0.35); ... }` → `background: var(--bg-elevated);`. (Find the exact current value; replace only the background.)
- [ ] **Tooltips (discoverability):** add a `title` attribute (hover tooltip) to each toolbar icon button, matching its existing `aria-label`:
  - BookmarkButton: `title={label}` (the existing `saved ? 'Remove bookmark' : 'Save bookmark'`). This is the key one — it makes the ★ findable.
  - NavControls: back `title="Back"`, forward `title="Forward"`, reload/stop `title={state.isLoading ? 'Stop' : 'Reload'}`, home `title="Home"` (match the existing aria-labels — read the component).
  - AdblockShield button: `title="Ad blocking"` (or match its aria-label).
  - PickerButton: `title="Pick element to hide"` (match aria-label).
  - DownloadsIndicator: `title="Downloads"` (match aria-label).
  - App gear button (`toolbar__gear`): `title="Settings"`. App sidebar-toggle (`toolbar__sidebar-toggle`): `title="Toggle sidebar"`.
  Keep all aria-labels/onClick/disabled unchanged — only ADD `title`.
- [ ] Run the affected component tests (`npx vitest run src/components/BookmarkButton.test.tsx src/components/Toolbar.test.tsx src/App.test.tsx` + any others touched) → adding `title` is non-breaking for role/aria/text queries; paste counts.
- [ ] `npm run build 2>&1 | tail -3` clean; production tsc clean.
- [ ] Commit `feat(ui): favorites-bar uses elevated grey + toolbar button tooltips (bookmark discoverability)` (+ trailer).

---

## Block B — Fullscreen content

### Task 2: Main-process fullscreen layout + `view.setFullscreen` IPC

**Files:** `electron/main/window.ts` (layout), `electron/main/index.ts` (relayout/z-order/fullscreen + registry), `shared/types.ts`, `electron/preload/chromePreload.ts`, `electron/main/ipc/viewLayout.ts` + `.test.ts`.

- [ ] **`window.ts` `layout()`** — support a fullscreen branch. Add a corner constant and change the signature to take options (update all callers in Step 2):
```ts
export const FULLSCREEN_CORNER = 44; // px — top-right region that holds the exit button

export function layout(
  win: BaseWindow,
  chromeView: WebContentsView,
  contentView?: WebContentsView,
  opts: { inset?: { top: number; left: number }; fullscreen?: boolean } = {},
): void {
  const { inset = { top: CHROME_TOP_HEIGHT, left: 0 }, fullscreen = false } = opts;
  const { width, height } = win.getContentBounds();
  if (fullscreen) {
    // Chrome shrinks to a small top-right corner (holds the exit button); content fills the window.
    chromeView.setBounds({ x: Math.max(0, width - FULLSCREEN_CORNER), y: 0, width: FULLSCREEN_CORNER, height: FULLSCREEN_CORNER });
    if (contentView) contentView.setBounds({ x: 0, y: 0, width, height });
  } else {
    chromeView.setBounds({ x: 0, y: 0, width, height });
    if (contentView) {
      contentView.setBounds({ x: inset.left, y: inset.top, width: width - inset.left, height: height - inset.top });
    }
  }
}
```
- [ ] **`index.ts`** — replace the `setContentInset` + `setChromeOverlay` closures with a consolidated state + relayout/z-order (keep `bringToTop`):
```ts
let contentInset = { top: CHROME_TOP_HEIGHT, left: 0 };
let fullscreen = false;
let chromeOnTop = false;
const relayout = (): void => layout(win, chromeView, vc.view, { inset: contentInset, fullscreen });
const applyZOrder = (): void => bringToTop(fullscreen || chromeOnTop ? chromeView : vc.view);
const setContentInset = (top: number, left: number): void => { contentInset = { top, left }; relayout(); };
const setChromeOverlay = (active: boolean): void => { chromeOnTop = active; applyZOrder(); };
const setFullscreen = (on: boolean): void => { fullscreen = on; relayout(); applyZOrder(); };
relayout();
win.on('resize', relayout);
```
  (Remove the old standalone `layout(...)`/`win.on('resize', () => layout(...))` lines; `bringToTop` stays.)
- [ ] **IPC type/channel:** `shared/types.ts` → `IPC.viewSetFullscreen: 'view.setFullscreen'`; `AegisApi.view.setFullscreen(viewId: ViewId, on: boolean): Promise<void>`.
- [ ] **Preload:** `chromePreload.ts` view namespace → `setFullscreen: (viewId, on) => ipcRenderer.invoke(IPC.viewSetFullscreen, viewId, on)`.
- [ ] **Handler:** `viewLayout.ts` → `buildViewLayoutHandlers(setContentInset, setChromeOverlay, setFullscreen)` + `[IPC.viewSetFullscreen]: (_v, on: boolean) => setFullscreen(on)`. Update `viewLayout.test.ts` (3rd spy, assert called with the boolean). Update the spread in `index.ts` to pass `setFullscreen`.
- [ ] **Registry seam** (`AEGIS_E2E` block): add `places.setFullscreen` (the closure) and `view.chromeBounds: () => chromeView.getBounds()` (so e2e can assert the corner). Keep `view.isChromeOnTop`.
- [ ] Run `npx vitest run electron/main/ipc/viewLayout.test.ts` (pure) → paste PASS. `npm run rebuild:electron && npm run build` → clean. tsc production clean.
- [ ] Commit `feat(view): fullscreen layout (content full-window + chrome top-right corner) + view.setFullscreen IPC` (+ trailer).

### Task 3: Renderer fullscreen wiring (enter button + corner exit button)

**Files:** `src/App.tsx`, `src/components/Toolbar.tsx`, `src/index.css`; tests `src/App.test.tsx`, `src/components/Toolbar.test.tsx`.

- [ ] **Toolbar:** add an optional `fullscreen?: ReactNode` slot (rendered with the other right-cluster buttons, e.g. before `gear`). (Or reuse `menu` ordering — keep it a distinct slot.)
- [ ] **App:** add `const [fullscreen, setFullscreen] = useState(false);`. Add an effect: `useEffect(() => { void aegis.view.setFullscreen(PRIMARY_VIEW_ID, fullscreen); }, [fullscreen]);`. Pass an enter button into the Toolbar `fullscreen` slot:
```tsx
fullscreen={
  <button type="button" className="toolbar__fullscreen" aria-label="Enter fullscreen" title="Fullscreen"
    onClick={() => setFullscreen(true)}><Maximize2 size={18} aria-hidden="true" /></button>
}
```
  (import `Maximize2`, `Minimize2` from `lucide-react`.)
- [ ] **App fullscreen render:** AFTER all hooks, before the normal `return`, add an early return when fullscreen — render ONLY the corner exit button:
```tsx
if (fullscreen) {
  return (
    <button type="button" className="fullscreen-exit" aria-label="Exit fullscreen" title="Exit fullscreen"
      onClick={() => setFullscreen(false)}>
      <Minimize2 size={18} aria-hidden="true" />
    </button>
  );
}
```
  (All hooks — useNav, useContentInset, the chromeOverlay/fullscreen effects, etc. — MUST be called before this return so the rule of hooks holds. The component stays mounted; only its output changes, so hook state persists.)
- [ ] **CSS** (`src/index.css`): style the corner exit button to sit in the top-right and be clearly visible over content:
```css
.fullscreen-exit {
  position: fixed; top: 4px; right: 4px; width: 36px; height: 36px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; background: var(--bg-elevated); color: var(--fg);
  border: 1px solid var(--border); box-shadow: var(--shadow-float); cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.fullscreen-exit:hover { background: var(--bg-input); color: #fff; }
```
  (The chrome view is 44×44 in the corner; a 36px button at top/right:4 fits with 4px margins.) Also give the new `.toolbar__fullscreen` the shared toolbar icon-button styling (extend the existing icon-button selector list).
- [ ] **Tests:** `Toolbar.test.tsx` — renders the `fullscreen` slot. `App.test.tsx` — clicking the toolbar fullscreen button drives `aegis.view.setFullscreen(PRIMARY_VIEW_ID, true)` and switches App to render only the `Exit fullscreen` button (toolbar/favbar gone); clicking that button drives `setFullscreen(..., false)` and restores the normal chrome. Add `view.setFullscreen` to the App test's `aegis` mock. Run `npx vitest run src/App.test.tsx src/components/Toolbar.test.tsx` → paste counts.
- [ ] Build clean; tsc production clean.
- [ ] Commit `feat(ui): fullscreen toggle — toolbar button hides chrome; top-right corner button exits` (+ trailer).

### Task 4: e2e — fullscreen end-to-end

**Files:** new `electron/test/e2e/fullscreen.spec.ts`.

- [ ] Use the established harness (`launchApp`, `__aegisTest`, chrome WC via `webContents.fromId(chromeWcId).executeJavaScript`, content bounds via `__aegisTest.primary.view.getBounds()`). Test:
  1. Boot: content `y === 96`, chrome bounds == full window.
  2. Enter fullscreen: `executeJavaScript` click `.toolbar__fullscreen` → poll content bounds `y === 0` AND `x === 0` AND width/height == window (full); chrome bounds == top-right corner (`x === winW - 44, y === 0, width === 44, height === 44`); `__aegisTest.view.isChromeOnTop()` === true.
  3. Exit via the corner button: `executeJavaScript` click `.fullscreen-exit` → poll content `y === 96` again; chrome bounds == full window; `isChromeOnTop()` === false.
  (Drive clicks in the chrome WC via `executeJavaScript`; read content/chrome bounds + flags via `app.evaluate` + the registry. You may also drive `places.setFullscreen(true/false)` directly as a secondary assertion.)
- [ ] `npm run rebuild:electron && npm run build && npx playwright test electron/test/e2e/fullscreen.spec.ts` → paste PASS.
- [ ] Commit `test(e2e): fullscreen — chrome shrinks to corner, content fills window, exit restores` (+ trailer).

---

## Block C — Gate + visual

### Task 5: Full gate + visual + (controller offers merge)

- [ ] Full dual-ABI gate: `npm test` then `npm run build && npm run test:e2e` → paste both summaries.
- [ ] tsc production clean.
- [ ] Visual (controller, throwaway capture, deleted after): default toolbar (tooltips not visible in a static shot, but verify the favbar grey + the new Maximize button), and fullscreen state (content full + the corner exit button). Confirm the favbar matches the modal grey.

---

## Notes
- Local commits only on `fullscreen-tweaks`; never push/remote/branch-rename. Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- The fullscreen z-order is consolidated: chrome is on top when `fullscreen || chromeOnTop`. In fullscreen no overlays can open (no toolbar), so `chromeOnTop` is false and `fullscreen` forces chrome (the corner) on top.
- A ~44px top-right corner is a small dead-zone where the page isn't clickable while fullscreen — acceptable for the exit affordance.
