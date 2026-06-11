# Aegis UI Polish + Input Examples — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.
> Branch: `ui-polish` (LOCAL commits only — never push/remote/branch-rename). Builds on the merged UW restyle.

**Goal:** Make the chrome feel less "basic" — (1) replace Unicode glyphs with **lucide-react** SVG icons, (2) add **example placeholders** to all input fields, (3) a **polish pass**: depth/elevation, hover/active transitions, refined focus + type hierarchy, polished sidebar empty states, plus **some flair** (accent gradient on key elements). Decisions locked with the user: lucide-react YES; polish level = "refined base + some flair"; examples in inputs.

**Architecture:** Pure renderer change. Icons = a new `lucide-react` dep + swapping glyph spans for `<Icon/>` components (keep every `aria-label` so a11y + tests are unaffected). Placeholders = `placeholder=` attrs. Polish = CSS in `src/index.css`. No main-process / IPC / overlay-architecture changes. CSP-safe (lucide renders inline `<svg>`, not inline scripts).

**Tech:** React 19 + TS + electron-vite + Vitest 4 + Playwright. Dual-ABI gate unchanged. tsc bar: production files (`src/**` non-test) must not newly appear in `npx tsc --noEmit 2>&1 | grep -E '^(src|electron|shared)/' | grep -vE '\.test\.'`.

**Icon CSS:** lucide icons take `size`/`strokeWidth` props and a `className`. Add a shared rule so all chrome icons inherit `color: currentColor` and align; size via the component prop (16 for inline, 18–20 for toolbar). Icon buttons already styled (Task 7 of the restyle) — icons inherit `currentColor` from the button.

---

## Block A — Icons (lucide-react)

### Task 1: Add lucide-react + swap toolbar-cluster glyphs

**Files:** `package.json` (dep); `src/components/NavControls.tsx`, `AdblockShield.tsx`, `BookmarkButton.tsx`, `PickerButton.tsx`, `DownloadsIndicator.tsx`, `src/App.tsx` (gear + menu); `src/index.css` (icon sizing if needed); affected tests.

- [ ] **Step 1:** `npm install lucide-react@^0.477.0` (matches UW, React-19 compatible). If a peer-dep error blocks it, retry with `--legacy-peer-deps` and note it. Confirm `package.json` lists it.
- [ ] **Step 2:** READ each component, then replace its glyph(s) with a lucide icon, keeping the existing `aria-label`/`type`/`onClick`/className. Suggested mapping (pick the closest lucide name that exists in 0.477; adjust if a name differs):
  - NavControls: back → `ArrowLeft`, forward → `ArrowRight`, reload → `RotateCw`, stop → `X`, home → `House`. (Read NavControls for the exact buttons — it conditionally shows reload vs stop.)
  - AdblockShield button → `Shield` when enabled / `ShieldOff` when blocking disabled for the host (reflect the state). The count badge stays text.
  - BookmarkButton → `Star` (when saved, render it filled: `fill="currentColor"`; when not saved, no fill).
  - PickerButton → `SquareMousePointer` (or `Crosshair` if that name is absent).
  - DownloadsIndicator → `Download`.
  - App gear → `Settings`; App sidebar-toggle (menu) → `PanelRight` (sidebar is on the right) or `Menu`.
  - Use `size={18}` for toolbar icons (tune to look right vs the 32px buttons), default `strokeWidth`.
- [ ] **Step 3:** Tests — these components' tests query by `aria-label`/`role`/text, NOT the glyph (verify by reading the test files). Adding an SVG with the same aria-label should keep them green. Run `npx vitest run src/components/NavControls.test.tsx src/components/AdblockShield.test.tsx src/components/BookmarkButton.test.tsx src/components/DownloadsIndicator.test.tsx src/App.test.tsx` (run whichever exist) → paste counts. If any test asserted a glyph string, update it to query by aria-label/role (do NOT weaken).
- [ ] **Step 4:** `npm run build 2>&1 | tail -3` clean. tsc production clean.
- [ ] **Step 5:** Commit `feat(ui): lucide-react icons for the toolbar cluster` (+ trailer).

### Task 2: Swap sidebar / panel / dialog glyphs

**Files:** `src/components/Sidebar.tsx` (close ×, + optional tab icons), `FavoritesBar.tsx` (manage ☰), `HistoryPanel.tsx`, `SavedPanel.tsx`, `DownloadsPanel.tsx` (remove/open/clear/cancel buttons), `SettingsModal.tsx` (close ×), `FavoritesManager.tsx` (remove/save), `TagInput.tsx` (chip remove ×), `Toaster.tsx` (close if any); affected tests; `src/index.css` if sizing needed.

- [ ] **Step 1:** READ each, replace glyphs with lucide, keep aria-labels:
  - Sidebar close → `X`; optional flair: a small icon before each tab label — History → `History`, Saved → `Bookmark`, Downloads → `Download` (size 14, inside `.sidebar__tab`). Keep the text labels.
  - FavoritesBar manage → `Pencil` or `SlidersHorizontal` (edit-favorites affordance).
  - HistoryPanel/SavedPanel: remove → `X` (size 14), clear-all stays a text button (optionally `Trash2`).
  - DownloadsPanel: cancel → `X`, remove → `Trash2` (or `X`), open-file/show-in-folder can gain `FileText`/`Folder` (optional). Keep the existing actions + aria-labels.
  - SettingsModal close → `X`. FavoritesManager remove → `Trash2`/`X`. TagInput chip remove → `X` (size 12).
- [ ] **Step 2:** Run the affected component tests (`npx vitest run src/components/Sidebar.test.tsx src/components/HistoryPanel.test.tsx src/components/SavedPanel.test.tsx src/components/DownloadsPanel.test.tsx src/components/SettingsModal.test.tsx src/components/FavoritesManager.test.tsx src/components/TagInput.test.tsx` — those that exist) → paste counts. Update any glyph-string assertions to aria-label/role queries (don't weaken).
- [ ] **Step 3:** Build clean + tsc production clean.
- [ ] **Step 4:** Commit `feat(ui): lucide-react icons for sidebar, panels, dialogs` (+ trailer).

---

## Block B — Input examples (placeholders)

### Task 3: Add example placeholders to every input/textarea

**Files:** `src/components/AddressBar.tsx`, `AppearanceTab.tsx`, `HomeTab.tsx`, `SearchTab.tsx`, `FilterListsTab.tsx`, `MyFiltersTab.tsx`, `DownloadsTab.tsx`, `FavoritesManager.tsx`, `HistoryPanel.tsx` (search), `TagInput.tsx`; affected tests.

- [ ] **Step 1:** READ each, add a concrete `placeholder` (example value, not a restatement of the label). Suggested text (adapt to the actual field):
  - AddressBar → `Search or enter a website  ·  e.g. example.com`
  - AppearanceTab siteName → `Aegis`
  - HomeTab homeUrl → `https://duckduckgo.com`
  - SearchTab: engine name → `DuckDuckGo`; template → `https://duckduckgo.com/?q=%s` (note: the `%s` is where the query goes)
  - FilterListsTab add-URL → `https://easylist.to/easylist/easylist.txt`
  - MyFiltersTab textarea → a multi-line example (use `\n` in the JSX string):
    `! One filter per line. Examples:\n||ads.example.com^\nexample.com##.ad-banner`
  - DownloadsTab downloadDir → `e.g. /home/you/Downloads`
  - FavoritesManager: name → `Hacker News`; url → `https://news.ycombinator.com`; tags add → `Add a tag…`; (rename-tag inputs → `New tag name`)
  - HistoryPanel search → `Search history…`
  - TagInput → `Add a tag…`
- [ ] **Step 2:** Tests: adding a `placeholder` is non-breaking for label/role queries. If any test now benefits, leave existing assertions; if a test queried a placeholder that didn't exist, it would've failed before — not applicable. Run `npx vitest run src/components/AddressBar.test.tsx src/components/MyFiltersTab.test.tsx src/components/FilterListsTab.test.tsx src/components/SearchTab.test.tsx src/components/FavoritesManager.test.tsx src/components/HistoryPanel.test.tsx src/components/TagInput.test.tsx src/components/HomeTab.test.tsx src/components/AppearanceTab.test.tsx src/components/DownloadsTab.test.tsx` (those that exist) → paste counts.
- [ ] **Step 3:** Build clean + tsc production clean. CSS: ensure `::placeholder { color: var(--fg-muted); opacity: 1; }` (and for textarea) so the examples are legibly muted.
- [ ] **Step 4:** Commit `feat(ui): example placeholders for all input fields` (+ trailer).

---

## Block C — Polish + flair (CSS in `src/index.css`)

### Task 4: Depth, transitions, focus, type hierarchy

**Files:** `src/index.css`.

- [ ] Author a refinement pass (append/adjust rules):
  - **Depth:** toolbar `box-shadow: 0 1px 0 var(--border), 0 2px 8px rgba(0,0,0,0.25)` (subtle elevation over content); modal/sidebar already have shadows — ensure consistent. Cards (`*-panel__row`, settings rows) get a hair more contrast on hover (slight `background` lift + the accent border already there).
  - **Transitions:** add smooth `transition: background-color .15s ease, border-color .15s ease, color .15s ease, box-shadow .15s ease` to interactive elements (buttons, chips, rows, tabs, inputs). Add a subtle `:active { transform: translateY(1px) }` on buttons for tactility.
  - **Focus:** keep accessible but refine — `:focus-visible { outline: 2px solid var(--accent-color); outline-offset: 2px; }` plus a soft `box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 30%, transparent)` on inputs/buttons focus (use `color-mix`; Chromium 138 supports it — this is an Electron-only renderer).
  - **Type hierarchy:** modal/dialog titles a touch larger/tighter; muted secondary text consistent at `--fg-muted`; nudge line-heights for readability.
  - **Inputs:** unify radius/padding; pill address bar gets a focus glow.
- [ ] Build clean. Commit `style(ui): depth, transitions, refined focus + type` (+ trailer).

### Task 5: Empty states + flair (gradient/accent)

**Files:** `src/index.css`; possibly tiny JSX in `HistoryPanel.tsx`/`SavedPanel.tsx`/`DownloadsPanel.tsx` empty blocks to add an icon + hint (lucide icon + short message), and `WelcomeHint.tsx`.

- [ ] **Empty states:** the sidebar panels' `__empty` currently render plain muted text. Improve each to a centered block: a large muted lucide icon (History → `Clock`, Saved → `BookmarkX`/`Bookmark`, Downloads → `DownloadCloud`/`Inbox`) + a primary line + a faint hint line. Minimal JSX edit to the existing `__empty` element (keep its class). Style `.…__empty` as a centered column with the icon muted.
- [ ] **Flair (tasteful):** 
  - Primary/accent-filled buttons (submit/save/add, the welcome-hint "Got it", permission Allow) get a subtle accent gradient: `background: linear-gradient(180deg, color-mix(in srgb, var(--accent-color) 100%, white 8%), var(--accent-color));` + a soft accent shadow on hover.
  - Active sidebar/settings tab underline → a 2px accent bar; optionally a faint accent text-glow on the brand/active tab.
  - The favorites bar / toolbar bottom border → a 1px hairline; consider a very subtle top-edge accent on focus-within of the address bar.
  - Keep it restrained — refined, not loud.
- [ ] Build clean. Run any touched panel tests (`npx vitest run src/components/HistoryPanel.test.tsx src/components/SavedPanel.test.tsx src/components/DownloadsPanel.test.tsx`) → the `__empty` JSX change must keep existing empty-state assertions (they likely assert the empty text — keep that text as the primary line). Paste counts.
- [ ] Commit `style(ui): polished empty states + accent flair` (+ trailer).

---

## Block D — Gate + visual

### Task 6: Full gate + visual capture

- [ ] **Gate:** `npm test` then `npm run build && npm run test:e2e` → paste both summaries (counts). Fix any restyle-caused failure in the owning task's files.
- [ ] **tsc:** production clean.
- [ ] **Visual:** capture the chrome via `chromeView.webContents.capturePage()` (throwaway `_electron` script in project root, deleted after — same approach as the restyle) in: default, sidebar-open, settings-open, an empty sidebar tab. Confirm icons render, placeholders show, polish/flair landed. (Controller will eyeball.)
- [ ] Commit any doc note if needed.

---

## Notes
- **Local commits only** on `ui-polish`; never push/remote/branch-rename. Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Sequential CSS tasks share `src/index.css`. Icon tasks touch many components — keep aria-labels intact (a11y + tests depend on them).
- If a suggested lucide icon name doesn't exist in 0.477.0, substitute the nearest existing one (the implementer verifies the import resolves at build).
