# Aegis Frontend Restyle — Universal Wrapper Visual Language — Design

**Status:** approved (brainstorming complete) · **Branch:** `restyle-uw` (local-only)

## Goal

Re-skin Aegis's existing browser chrome (toolbar / address bar / favorites bar / sidebar / settings / dialogs / toasts) in the **Universal Wrapper (UW)** visual language, and convert the sidebar from a left content-inset to a **right overlay + scrim**. Aegis keeps its own feature set and layout; this adopts UW's *look*, not UW's screens.

## Key finding that shapes the work

`src/index.css` is only 66 lines (`:root` tokens + base resets). The chrome components carry BEM `className` hooks (verified inventory) but have **zero component CSS rules** today — the UI renders as unstyled browser-default blocks. So the bulk of this is **greenfield CSS authoring against existing hooks**, not a refactor. The one exception is the overlay-sidebar conversion, which is an architecture change.

## Scope decisions (locked with the user)

1. **Accent:** default → UW blue `#3b82f6` (was violet `#7c5cff`); remains user-configurable via Appearance (live `primaryColor` wiring stays).
2. **Icons:** keep the existing Unicode glyphs (`⚙ ☰ ★ ☆ ⬇ ×`); style them with UW button rules. No `lucide-react` dependency. (Possible later follow-up.)
3. **Sidebar:** convert to UW's **right overlay + scrim** (content no longer shrinks). This is the architectural piece.

## Non-goals

- No TV/10-foot focus mode (no 4px-white/yellow focus or 44px touch rules) — desktop only.
- No header restructure beyond skinning; no new submit-circle on the address bar (pill input only).
- No component-logic changes except: Sidebar → overlay, move the sidebar toggle into the Toolbar, and the accent-default edits.
- Keep `DownloadsPanel.tsx` dynamic inline `width:${pct}%` (the only inline style).

---

## 1. Design tokens (UW values to adopt)

Re-map the **existing** `:root` variable names (preserves the `applyTheme` → `--accent-color` live wiring) to UW values, and add the missing ones:

```css
:root {
  /* re-based to UW palette (names kept so theme wiring is untouched) */
  --accent-color: #3b82f6;     /* was #4f8cff (CSS fallback); blue-500 brand */
  --bg: #121212;               /* app base / scrollbar track */
  --bg-elevated: #1f1f1f;      /* header, sidebar, modals, toasts */
  --bg-input: #2a2a2a;         /* inputs, cards/list rows, chips, hover */
  --fg: #e0e0e0;               /* primary text */
  --fg-muted: #888;            /* muted text, icons, placeholders */
  --border: #333;              /* default borders */
  --danger: #ff5d5d;           /* keep Aegis danger token name; value may stay or → #ef4444 */
  --chrome-top-height: 56px;   /* unchanged (keep 56; see §3) */

  /* new tokens */
  --border-2: #444;            /* secondary border: search field, dividers, scrollbar hover */
  --success: #22c55e;          /* toast success only */
  --text-on-accent: #ffffff;   /* text on accent-filled buttons */
  --radius-1: 4px;
  --radius-2: 6px;
  --radius-3: 8px;
  --radius-4: 12px;
  --radius-pill: 999px;
  --shadow-modal: 0 10px 25px rgba(0, 0, 0, 0.5);
  --shadow-float: 0 6px 24px rgba(0, 0, 0, 0.4);
}
```

Typography: keep the font stack; base size stays **14px** (Aegis baseline; UW's 16px is not required). Use weights 600/700 for titles/active items.

Focus (desktop): `outline: 2px solid var(--accent-color); outline-offset: 1px;` (keep current; do NOT adopt the TV style).

---

## 2. Visual language per surface (target rules)

Authoritative concrete patterns; the plan turns these into CSS against the inventoried classes.

- **App shell** (`.app`, `html/body/#root`): background **transparent** (so the content view shows through when the chrome view is moved on top for the sidebar overlay — see §4); flex column; custom `::-webkit-scrollbar` (8px; track `--bg`; thumb `--bg-input` r4; thumb hover `--border-2`).
- **Toolbar** (`.toolbar`): `display:flex; align-items:center; gap:10px; height:var(--chrome-top-height); padding:0 12px; background:var(--bg-elevated); border-bottom:1px solid var(--border);` (opaque).
- **Nav buttons / icon buttons** (`.nav-controls` buttons, `.toolbar__gear`, `.toolbar__picker`, `.toolbar__sidebar-toggle`, `.bookmark-button`, `.toolbar__downloads`): ~32px square, `border-radius:var(--radius-2)`, transparent bg, `color:var(--fg-muted)`, no border; `:hover` `background:rgba(255,255,255,0.08); color:var(--fg);`. Bookmark when active tints with `var(--accent-color)`.
- **Address bar** (`.address-bar`): pill — `flex:1; padding:8px 14px; border-radius:var(--radius-pill); border:1px solid var(--border-2); background:var(--bg-input); color:#fff;`; `:focus` border `var(--accent-color)`.
- **Adblock shield** (`.adblock-shield*`): icon button + count badge (`--accent-color` bg pill); popover uses the card pattern (`--bg-elevated`, `--radius-4`, `--shadow-modal`, border).
- **Favorites bar** (`.favorites-bar`): `display:flex; gap:8px; align-items:center; height:40px; padding:0 12px; background:rgba(0,0,0,0.35); overflow-x:auto;` (opaque-ish strip). `__chip` → pill (`--bg-input`, `--radius-4`, `--fg-muted`, accent border on hover). `__manage` → subtle pill (`rgba(255,255,255,0.06)`, weight 600).
- **Tag filter / tag input chips** (`.tag-filter__chip`, `.tag-input__chip`): `--radius-pill`, `--bg-input`, `--fg-muted`, border `--border`; active/selected → `--accent-color` bg + `#fff`.
- **Sidebar overlay** (`.sidebar`, `.sidebar__scrim`, `.sidebar__panel`/`__body`, `__tabs`, `__tab`, `__close`): see §4. Panel `--bg-elevated`, left border, `--shadow-modal`, slide-in. Tabs = bottom-border-accent underline; active tab `color:var(--fg)` + 2px accent bottom border, inactive `--fg-muted`.
- **List rows** (`.history-panel__row`, `.saved-panel__row`, `.downloads-panel` rows): card rows — `background:var(--bg-input); border-radius:var(--radius-3); border:1px solid transparent;` `:hover` border `--accent-color`; title 600/14px; secondary (time/url) `--fg-muted` 11–12px; remove/cancel actions in `--danger`. Downloads progress: track `--bg-input`, fill `var(--accent-color)` (keep the inline width).
- **Modal pattern** (`.settings-modal`, `.favorites-manager`): full-window scrim `position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:11000; display:flex; align-items:center; justify-content:center;` + centered content `background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius-4); padding:24px; box-shadow:var(--shadow-modal); max-width/max-height` with internal scroll. Title `h*` 18px/700; close `×` top-right icon button. Settings tab list = the sidebar underline-tab pattern.
- **Form controls** (settings tabs, `.appearance-tab__field`, `*-tab__*`): labels `--fg-muted` 14px; inputs/textareas `--bg-input`, `--border`, `--radius-2`, accent border on focus; primary/submit buttons `background:var(--accent-color); color:var(--text-on-accent); font-weight:600; border:none;`; remove/clear buttons bordered or `--danger`. Keep `<input type="color">` for primaryColor.
- **Dialogs** (`.confirm-*`, `.permission-prompt`, `.error-overlay__*`): scrim + centered card (same pattern, smaller). Primary action accent; danger `--danger`.
- **Toaster** (`.toaster`): fixed bottom-right, `z-index:10020`, gap; each toast `--bg-elevated`, border, left accent border by type (success `--success`, error `--danger`, info `--accent-color`), `--radius-3`, `--shadow-float`, `toast-in` keyframe.
- **Welcome hint** (`.welcome-hint`): fixed bottom-left, `--bg-elevated`, 3px left accent border, `--radius-3`, `--shadow-float`.
- **Skip link** (`.skip-link`): offscreen until `:focus` (then accent bg, `#fff`).
- **Keyframes:** `toast-in` (translateY+fade), `scrim-fade-in` (opacity), `sidebar-in` (translateX).

---

## 3. Layout constants

Keep **TOOLBAR_H = 56**, **FAVBAR_H = 40** (top inset = 96, unchanged), **SIDEBAR_W = 280**. `--chrome-top-height` stays 56. No dual-source desync risk since heights don't change.

---

## 4. Sidebar overlay architecture (the core change)

### Current model (left inset)
`window.ts` adds `chromeView` (full-window, opaque) first; `index.ts:118` adds the content `vc.view` **on top**, positioned inset `{top:96, left: sidebarOpen?280:0}`. The left strip of chrome shows the sidebar. `useContentInset` reports `{top, left}` via `aegis.view.setContentInset`.

### Target model (right overlay + scrim) — primary approach: z-order swap + transparent chrome
Because the content view sits **on top** of chrome, a chrome-rendered overlay can't paint over content unless chrome is moved on top. So:

- **chromeView becomes transparent** (`chromeView.setBackgroundColor('#00000000')` in `createMainWindow`), and the renderer's `html/body/#root` background becomes **transparent**. The toolbar/favbar/sidebar panel/scrim each paint their own background, so they stay opaque/semi as intended; the empty content region of the chrome view is transparent.
- **Content view bounds never change for the sidebar** — only the top inset (96) applies; **left inset is always 0**. The content view stays full-width.
- **A z-order swap** toggles which native view is on top:
  - *Sidebar closed (browsing):* content view on top → normal interaction, chrome (transparent middle) hidden behind content in the content region.
  - *Sidebar open:* chrome view on top → its scrim (semi-transparent black div over the content region) dims the page, and the right panel covers content on the right. Clicks land on chrome (scrim closes the sidebar; panel is interactive).
  - Bring a view to top reliably via `win.contentView.removeChildView(v); win.contentView.addChildView(v);`.
- **New main closure** `setSidebarOpen(open: boolean)`: performs the swap (chrome-on-top when open, content-on-top when closed). It does **not** change bounds.
- **New IPC** `view.setSidebarOpen` (`IPC.viewSetSidebarOpen`), `AegisApi.view.setSidebarOpen(viewId, open): Promise<void>`, preload wrapper, and a handler in `buildViewLayoutHandlers` that calls the `setSidebarOpen` closure.
- **Renderer:** `useContentInset` simplifies to a constant `{top:96, left:0}` on mount; a separate effect calls `aegis.view.setSidebarOpen(viewId, sidebarOpen)` on change. `Sidebar.tsx` renders only when open: a `.sidebar__scrim` (click → close) + a `.sidebar__panel` (right, slide-in, tabs + `__close` ×). The open toggle (☰) moves into the Toolbar (new `menu` slot / `.toolbar__sidebar-toggle`).
- **Test seam:** `__aegisTest.places.setSidebarOpen(open)` and `__aegisTest.view.isChromeOnTop()` (`win.contentView.children.at(-1) === chromeView`) so e2e can drive + assert the swap.

### Spike + fallback (verify-don't-guess)
WebContentsView-over-WebContentsView transparency must be confirmed on this Electron 42 + Linux/NVIDIA/Wayland box. **The first build task spikes it**: implement the transparent chrome + z-swap, then verify (a) the z-order swap via `win.contentView.children` order, and (b) transparency via `chromeView.webContents.capturePage()` sampling a pixel in the content region (alpha ≈ 0 ⇒ chrome paints nothing there ⇒ content composites through).

**If transparency proves unreliable**, fall back to a **right inset** (mirror of today): extend `ContentInset`/`layout()` with a `right` value; `setContentInset` insets the content view from the right by `SIDEBAR_W` when open; the sidebar renders in the exposed right strip (chrome stays at the bottom, opaque, no z-swap, no scrim-over-content). This still ships a right-side sidebar; the scrim degrades to none. The plan documents both paths; the spike picks one.

---

## 5. Accent default change

`#7c5cff` → `#3b82f6` in: `electron/main/db/settingsRepo.ts` (`DEFAULT_SETTINGS.primaryColor`), `src/hooks/useSettings.ts` (`emptySettings.primaryColor`), `src/index.css` (`--accent-color` fallback already → `#3b82f6` in §1), and the picker overlay color in `electron/main/pickerHelpers.ts:80` (`#7c5cff`/`rgba(124,92,255,…)` → blue equivalents). Update any unit test asserting the old default.

---

## 6. Test / gate impact

- **Rewrite `electron/test/e2e/sidebar.spec.ts`**: boot top-inset (y=96, x=0) stays; *opening the sidebar no longer changes content bounds* (x=0, width unchanged) — instead assert the z-order swap via `isChromeOnTop()` (false closed, true open) and that resize preserves the top inset.
- **Unit:** `useContentInset` test (if present) updated to the simplified contract; settings default-color tests updated. Renderer component tests for `Sidebar`/`Toolbar`/`App` updated for the moved toggle + overlay structure + the new `view.setSidebarOpen` mock.
- **Mechanism unchanged otherwise:** single `src/index.css`, sender-guarded IPC, dual-ABI. Full gate (`npm test` + `npm run build && npm run test:e2e`) must stay green; production `tsc` clean.

---

## 7. Risks

1. **Chrome transparency compositing** (primary) — mitigated by the §4 spike + right-inset fallback.
2. **Scrim input on the transparent chrome region** — when chrome is on top, it captures clicks over the content region (desired: scrim closes). When closed, content is on top (browsing). The swap must be exact or input routes to the wrong view; the e2e z-order assertion guards this.
3. **CSS regressions to functionality** — pure styling; the per-task spec+quality review + the unchanged behavioral e2e suite guard against accidental layout breakage.
