# Mobile tabs / tab switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Android live multi-tab browsing — one native `WebView` per tab (switching resumes live state), a vertical-list tab switcher, and a reworked bottom bar `[Saved, History, Tabs(count), Shield, Menu]`.

**Architecture:** The chrome coordinates: `MobileApp` uses `useTabs()` + `useNav(activeId)` (the existing hooks); the existing `tab_registry` is the model; `MainActivity` owns a `tabId → WebView` map driven by new `AegisAndroid` bridge calls. A small `useMobileTabSync` hook diffs the tabs state and drives the native bridge.

**Tech Stack:** React 19 + TypeScript, Vitest (jsdom), `lucide-react`; Android Kotlin (`MainActivity.kt`) + the `window.AegisAndroid` bridge.

---

## Testing reality (read first)

- The **renderer** (`src/components/mobile/*`, `src/hooks/useMobileTabSync.ts`, `ipcClient.ts`) is unit-tested in Vitest jsdom with `aegis` + the bridge helpers mocked. **TDD it.** Test the components/hook **directly** (the `isMobile` branch is a module constant, so render `MobileTabSwitcher`/`MobileApp` directly).
- The **native Kotlin** (`MainActivity.kt`) can't be unit-tested headlessly. Tasks 8–9 are implement-then-**owner-builds**: `JAVA_HOME=~/development/android-studio/jbr npm run android:build -- --target aarch64`, then GUI-validate on the device. Don't claim they pass without that.
- The **desktop suite stays green** throughout (desktop untouched). Run `npm test` after renderer tasks.

Commands: one file → `npx vitest run <path>`; whole suite → `npm test`; android build (owner) → `JAVA_HOME=/home/happyhobo/development/android-studio/jbr npm run android:build -- --target aarch64`.

---

## File structure

**New (renderer)**
- `src/components/mobile/MobileTabSwitcher.tsx` (+ `.test.tsx`) — the switcher sheet (vertical list).
- `src/hooks/useMobileTabSync.ts` (+ `.test.ts`) — diffs the tabs state → drives the native bridge.

**Modified (renderer)**
- `src/lib/ipcClient.ts` — `AndroidBridge.activateTab/closeTab/discardTab` + exported helpers; `window.__aegisOpenTab` typing.
- `src/components/mobile/MobileBottomBar.tsx` (+ test) — slots → `[Saved, History, Tabs(count), Shield, Menu]`.
- `src/components/mobile/MobileMenuSheet.tsx` (+ test) — items → `[Back, Forward, Home, Bookmark, Downloads, Settings]`.
- `src/components/mobile/MobileApp.tsx` (+ test) — rewire to `useTabs` + `useNav(activeId)`, the `tabs` sheet, `useMobileTabSync`, `__aegisOpenTab`, back-intercept.
- `src/index.css` — switcher rows + tab-count badge.

**Modified (native)**
- `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt` — `tabId → WebView` map + lifecycle.

**Docs**
- `src/CLAUDE.md`, `src-tauri/CLAUDE.md`.

---

## Milestone 1 — Chrome components (jsdom TDD)

### Task 1: Bridge tab-lifecycle methods + helpers

**Files:**
- Modify: `src/lib/ipcClient.ts`

- [ ] **Step 1: Add to the `AndroidBridge` interface** — after `setFullscreen(on: boolean): void;`:

```ts
  /** Show tab `id` (lazily creating its native WebView at `url` if absent) and hide the
   * rest — switching, or reopening a discarded tab. */
  activateTab(id: number, url: string): void;
  /** Destroy + forget tab `id`'s native WebView. */
  closeTab(id: number): void;
  /** Destroy tab `id`'s native WebView but keep the tab (idle-sweep); recreated on next
   * activateTab. */
  discardTab(id: number): void;
```

- [ ] **Step 2: Add exported helpers** — after the `setFullscreen` helper near the bottom:

```ts
/** Mobile-only: show/lazily-create the active tab's native WebView. No-op off Android. */
export function activateTab(id: number, url: string): void {
  androidBridge()?.activateTab(id, url);
}
/** Mobile-only: destroy + forget a tab's native WebView. No-op off Android. */
export function closeTab(id: number): void {
  androidBridge()?.closeTab(id);
}
/** Mobile-only: discard a tab's native WebView (idle-sweep), keeping the tab. No-op off Android. */
export function discardTab(id: number): void {
  androidBridge()?.discardTab(id);
}
```

- [ ] **Step 3: Run the suite** — `npm test` — Expected: still green (additions only).

- [ ] **Step 4: Commit**

```bash
git add src/lib/ipcClient.ts
git commit -m "feat(mobile): bridge tab-lifecycle methods (activate/close/discard)"
```

### Task 2: Rework `MobileBottomBar`

**Files:**
- Modify: `src/components/mobile/MobileBottomBar.tsx`, `src/components/mobile/MobileBottomBar.test.tsx`

- [ ] **Step 1: Replace the test** — `MobileBottomBar.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileBottomBar } from './MobileBottomBar';

function setup(over = {}) {
  const props = {
    onSaved: vi.fn(), onHistory: vi.fn(), onTabs: vi.fn(), onMenu: vi.fn(),
    tabCount: 3, shield: <div data-testid="shield" />,
    ...over,
  };
  render(<MobileBottomBar {...props} />);
  return props;
}

describe('MobileBottomBar', () => {
  it('renders Saved, History, Tabs, Menu + the shield slot', () => {
    setup();
    expect(screen.getByRole('button', { name: /saved/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tabs/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
    expect(screen.getByTestId('shield')).toBeInTheDocument();
  });
  it('shows the open-tab count on the Tabs button', () => {
    setup({ tabCount: 5 });
    expect(screen.getByRole('button', { name: /tabs/i })).toHaveTextContent('5');
  });
  it('fires callbacks on tap', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /saved/i }));
    expect(p.onSaved).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(p.onHistory).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /tabs/i }));
    expect(p.onTabs).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    expect(p.onMenu).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/mobile/MobileBottomBar.test.tsx` (prop shape changed).

- [ ] **Step 3: Replace the component** — `MobileBottomBar.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Bookmark, History, Layers, Menu } from 'lucide-react';

interface MobileBottomBarProps {
  onSaved(): void;
  onHistory(): void;
  onTabs(): void;
  tabCount: number;
  shield: ReactNode;
  onMenu(): void;
}

export function MobileBottomBar({
  onSaved, onHistory, onTabs, tabCount, shield, onMenu,
}: MobileBottomBarProps) {
  return (
    <nav className="mobile-bottombar" aria-label="Browser actions">
      <button type="button" className="mobile-bottombar__btn" aria-label="Saved" onClick={onSaved}>
        <Bookmark size={22} aria-hidden="true" />
      </button>
      <button type="button" className="mobile-bottombar__btn" aria-label="History" onClick={onHistory}>
        <History size={22} aria-hidden="true" />
      </button>
      <button type="button" className="mobile-bottombar__btn mobile-bottombar__tabs" aria-label={`Tabs (${tabCount} open)`} onClick={onTabs}>
        <Layers size={20} aria-hidden="true" />
        <span className="mobile-bottombar__count" aria-hidden="true">{tabCount}</span>
      </button>
      <div className="mobile-bottombar__shield">{shield}</div>
      <button type="button" className="mobile-bottombar__btn" aria-label="Menu" onClick={onMenu}>
        <Menu size={22} aria-hidden="true" />
      </button>
    </nav>
  );
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/components/mobile/MobileBottomBar.test.tsx` (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileBottomBar.tsx src/components/mobile/MobileBottomBar.test.tsx
git commit -m "feat(mobile): bottom bar -> Saved/History/Tabs(count)/Shield/Menu"
```

### Task 3: Rework `MobileMenuSheet`

**Files:**
- Modify: `src/components/mobile/MobileMenuSheet.tsx`, `src/components/mobile/MobileMenuSheet.test.tsx`

- [ ] **Step 1: Replace the test** — `MobileMenuSheet.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileMenuSheet } from './MobileMenuSheet';

function setup(over = {}) {
  const props = {
    onClose: vi.fn(), onBack: vi.fn(), onForward: vi.fn(),
    canGoBack: true, canGoForward: false,
    onHome: vi.fn(), onDownloads: vi.fn(), onSettings: vi.fn(),
    isCurrentSaved: false, canBookmark: true, onToggleBookmark: vi.fn(),
    ...over,
  };
  render(<MobileMenuSheet {...props} />);
  return props;
}

describe('MobileMenuSheet', () => {
  it('launches Home, Downloads, Settings', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /^home$/i }));
    expect(p.onHome).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /downloads/i }));
    expect(p.onDownloads).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(p.onSettings).toHaveBeenCalled();
  });
  it('has Back/Forward, disabled per the canGo flags', () => {
    const p = setup({ canGoBack: true, canGoForward: false });
    const back = screen.getByRole('button', { name: /back/i });
    const fwd = screen.getByRole('button', { name: /forward/i });
    expect(fwd).toBeDisabled();
    fireEvent.click(back);
    expect(p.onBack).toHaveBeenCalled();
  });
  it('shows the bookmark toggle and reflects saved state', () => {
    setup({ isCurrentSaved: true });
    expect(screen.getByRole('button', { name: /remove bookmark/i })).toBeInTheDocument();
  });
  it('disables bookmarking when not bookmarkable', () => {
    setup({ canBookmark: false });
    expect(screen.getByRole('button', { name: /bookmark this page/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/mobile/MobileMenuSheet.test.tsx`.

- [ ] **Step 3: Replace the component** — `MobileMenuSheet.tsx`:

```tsx
import { ArrowLeft, ArrowRight, Home, Star, Download, Settings } from 'lucide-react';
import { MobileSheet } from './MobileSheet';

interface MobileMenuSheetProps {
  onClose(): void;
  onBack(): void;
  onForward(): void;
  canGoBack: boolean;
  canGoForward: boolean;
  onHome(): void;
  onDownloads(): void;
  onSettings(): void;
  isCurrentSaved: boolean;
  canBookmark: boolean;
  onToggleBookmark(): void;
}

export function MobileMenuSheet({
  onClose, onBack, onForward, canGoBack, canGoForward, onHome,
  onDownloads, onSettings, isCurrentSaved, canBookmark, onToggleBookmark,
}: MobileMenuSheetProps) {
  return (
    <MobileSheet title="Menu" onClose={onClose}>
      <ul className="mobile-menu">
        <li>
          <button type="button" className="mobile-menu__item" disabled={!canGoBack} onClick={onBack}>
            <ArrowLeft size={20} aria-hidden="true" />Back
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" disabled={!canGoForward} onClick={onForward}>
            <ArrowRight size={20} aria-hidden="true" />Forward
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onHome}>
            <Home size={20} aria-hidden="true" />Home
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" disabled={!canBookmark} onClick={onToggleBookmark}>
            <Star size={20} aria-hidden="true" />
            {isCurrentSaved ? 'Remove bookmark' : 'Bookmark this page'}
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onDownloads}>
            <Download size={20} aria-hidden="true" />Downloads
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onSettings}>
            <Settings size={20} aria-hidden="true" />Settings
          </button>
        </li>
      </ul>
    </MobileSheet>
  );
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/components/mobile/MobileMenuSheet.test.tsx` (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileMenuSheet.tsx src/components/mobile/MobileMenuSheet.test.tsx
git commit -m "feat(mobile): menu drawer -> Back/Forward/Home/Bookmark/Downloads/Settings"
```

### Task 4: `MobileTabSwitcher`

**Files:**
- Create: `src/components/mobile/MobileTabSwitcher.tsx`, `src/components/mobile/MobileTabSwitcher.test.tsx`

- [ ] **Step 1: Write the failing test** — `MobileTabSwitcher.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileTabSwitcher } from './MobileTabSwitcher';
import type { TabMeta } from '../../../shared/types';

const tabs: TabMeta[] = [
  { id: 1, pinned: false, live: true, title: 'Example', url: 'https://example.com/' },
  { id: 2, pinned: false, live: false, title: '', url: 'https://news.test/' },
];

function setup(over = {}) {
  const props = {
    tabs, activeId: 1,
    onSwitch: vi.fn(), onCloseTab: vi.fn(), onNewTab: vi.fn(), onClose: vi.fn(),
    ...over,
  };
  render(<MobileTabSwitcher {...props} />);
  return props;
}

describe('MobileTabSwitcher', () => {
  it('renders a row per tab (title, or host fallback)', () => {
    setup();
    expect(screen.getByText('Example')).toBeInTheDocument();
    expect(screen.getByText('news.test')).toBeInTheDocument(); // no title -> host
  });
  it('switches to a tab on row tap', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /switch to news\.test/i }));
    expect(p.onSwitch).toHaveBeenCalledWith(2);
  });
  it('closes a tab via its close button', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /close example/i }));
    expect(p.onCloseTab).toHaveBeenCalledWith(1);
  });
  it('opens a new tab', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /new tab/i }));
    expect(p.onNewTab).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/mobile/MobileTabSwitcher.test.tsx` (cannot find module).

- [ ] **Step 3: Implement** — `MobileTabSwitcher.tsx`:

```tsx
import { Globe, Plus, X } from 'lucide-react';
import type { TabMeta, ViewId } from '../../../shared/types';
import { MobileSheet } from './MobileSheet';

interface MobileTabSwitcherProps {
  tabs: TabMeta[];
  activeId: ViewId;
  onSwitch(id: ViewId): void;
  onCloseTab(id: ViewId): void;
  onNewTab(): void;
  onClose(): void;
}

function label(t: TabMeta): string {
  if (t.title.length > 0) return t.title;
  try { const h = new URL(t.url).hostname; if (h.length > 0) return h; } catch { /* ignore */ }
  return t.url || 'New tab';
}

export function MobileTabSwitcher({
  tabs, activeId, onSwitch, onCloseTab, onNewTab, onClose,
}: MobileTabSwitcherProps) {
  return (
    <MobileSheet title="Tabs" onClose={onClose}>
      <button type="button" className="mobile-tabs__new" onClick={onNewTab}>
        <Plus size={18} aria-hidden="true" />New tab
      </button>
      <ul className="mobile-tabs">
        {tabs.map((t) => {
          const name = label(t);
          return (
            <li key={t.id} className={t.id === activeId ? 'mobile-tabs__row mobile-tabs__row--active' : 'mobile-tabs__row'}>
              <button type="button" className="mobile-tabs__open" aria-label={`Switch to ${name}`} onClick={() => onSwitch(t.id)}>
                <Globe size={18} aria-hidden="true" />
                <span className="mobile-tabs__title">{name}</span>
              </button>
              <button type="button" className="mobile-tabs__close" aria-label={`Close ${name}`} onClick={() => onCloseTab(t.id)}>
                <X size={18} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </MobileSheet>
  );
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/components/mobile/MobileTabSwitcher.test.tsx` (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileTabSwitcher.tsx src/components/mobile/MobileTabSwitcher.test.tsx
git commit -m "feat(mobile): MobileTabSwitcher (vertical list)"
```

### Task 5: `useMobileTabSync` (diff registry state → native bridge)

**Files:**
- Create: `src/hooks/useMobileTabSync.ts`, `src/hooks/useMobileTabSync.test.ts`

- [ ] **Step 1: Write the failing test** — `useMobileTabSync.test.ts`:

```ts
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TabMeta } from '../../shared/types';

const activateTab = vi.fn();
const closeTab = vi.fn();
const discardTab = vi.fn();
vi.mock('../lib/ipcClient', () => ({ activateTab, closeTab, discardTab }));

import { useMobileTabSync } from './useMobileTabSync';

const t = (id: number, over: Partial<TabMeta> = {}): TabMeta =>
  ({ id, pinned: false, live: true, title: '', url: `https://t${id}.test/`, ...over });

beforeEach(() => { activateTab.mockClear(); closeTab.mockClear(); discardTab.mockClear(); });

describe('useMobileTabSync', () => {
  it('activates the active tab on mount', () => {
    renderHook(({ tabs, activeId }) => useMobileTabSync(tabs, activeId), {
      initialProps: { tabs: [t(1)], activeId: 1 },
    });
    expect(activateTab).toHaveBeenCalledWith(1, 'https://t1.test/');
  });
  it('activates the new active tab when activeId changes', () => {
    const { rerender } = renderHook(({ tabs, activeId }) => useMobileTabSync(tabs, activeId), {
      initialProps: { tabs: [t(1), t(2)], activeId: 1 },
    });
    activateTab.mockClear();
    rerender({ tabs: [t(1), t(2)], activeId: 2 });
    expect(activateTab).toHaveBeenCalledWith(2, 'https://t2.test/');
  });
  it('closes a tab that disappeared from the list', () => {
    const { rerender } = renderHook(({ tabs, activeId }) => useMobileTabSync(tabs, activeId), {
      initialProps: { tabs: [t(1), t(2)], activeId: 1 },
    });
    rerender({ tabs: [t(1)], activeId: 1 });
    expect(closeTab).toHaveBeenCalledWith(2);
  });
  it('discards a tab that went live -> not live', () => {
    const { rerender } = renderHook(({ tabs, activeId }) => useMobileTabSync(tabs, activeId), {
      initialProps: { tabs: [t(1), t(2, { live: true })], activeId: 1 },
    });
    rerender({ tabs: [t(1), t(2, { live: false })], activeId: 1 });
    expect(discardTab).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/hooks/useMobileTabSync.test.ts`.

- [ ] **Step 3: Implement** — `useMobileTabSync.ts`:

```ts
import { useEffect, useRef } from 'react';
import type { TabMeta, ViewId } from '../../shared/types';
import { activateTab, closeTab, discardTab } from '../lib/ipcClient';

/**
 * Drive the native per-tab WebViews (on Android) from the registry's tabs state. The
 * registry decides; this relays to the bridge. Native calls are idempotent/no-op off
 * Android, so we fire on plain state diffs without tracking native's internal map.
 */
export function useMobileTabSync(tabs: TabMeta[], activeId: ViewId): void {
  const prev = useRef<{ tabs: TabMeta[]; activeId: ViewId } | null>(null);

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);
    const before = prev.current;

    // Ensure the active tab's WebView exists + is shown (idempotent).
    if (active && (!before || before.activeId !== activeId)) {
      activateTab(activeId, active.url);
    }
    if (before) {
      // Tabs removed from the list -> destroy + forget.
      for (const b of before.tabs) {
        if (!tabs.some((t) => t.id === b.id)) closeTab(b.id);
      }
      // Tabs idle-swept (live: true -> false) -> discard the WebView.
      for (const b of before.tabs) {
        const now = tabs.find((t) => t.id === b.id);
        if (b.live && now && !now.live) discardTab(b.id);
      }
    }
    prev.current = { tabs, activeId };
  }, [tabs, activeId]);
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run src/hooks/useMobileTabSync.test.ts` (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useMobileTabSync.ts src/hooks/useMobileTabSync.test.ts
git commit -m "feat(mobile): useMobileTabSync (registry state -> native tab bridge)"
```

## Milestone 2 — Orchestration + CSS

### Task 6: Rewire `MobileApp`

**Files:**
- Modify: `src/components/mobile/MobileApp.tsx`, `src/components/mobile/MobileApp.test.tsx`

- [ ] **Step 1: Update the test** — In `MobileApp.test.tsx`, add `activateTab`/`closeTab`/`discardTab` to the `vi.mock('../../lib/ipcClient', ...)` exports (alongside `setBackInterceptActive`/`setBottomBarHidden`/`setFullscreen`):

```ts
  setBackInterceptActive: vi.fn(),
  setBottomBarHidden: vi.fn(),
  setFullscreen: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  discardTab: vi.fn(),
}));
```

Then replace the "hides the bottom bar" / "enters fullscreen" assertions' siblings with a tabs test (keep the existing top-bar/bottom-bar/menu/fullscreen tests; they still hold). Add:

```tsx
  it('opens the tab switcher from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /tabs/i }));
    expect(await screen.findByRole('dialog', { name: 'Tabs' })).toBeInTheDocument();
  });
  it('opens Saved directly from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /saved/i }));
    expect(await screen.findByRole('dialog', { name: 'Saved' })).toBeInTheDocument();
  });
```

> The existing test "hides the bottom bar via the top-bar toggle" still works. The test that clicked bottom-bar `/menu/i` then `/history/i` must change: History is now opened from the **bottom bar** directly, not the menu — update that test to click `/history/i` (bottom bar) and expect the History dialog.

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/components/mobile/MobileApp.test.tsx`.

- [ ] **Step 3: Implement the rewire** — apply these edits to `MobileApp.tsx`:

(a) Imports — add `useTabs`, `useMobileTabSync`, `MobileTabSwitcher`, and the type:

```tsx
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import { useTabs } from '../../hooks/useTabs';
import { useMobileTabSync } from '../../hooks/useMobileTabSync';
import { MobileTabSwitcher } from './MobileTabSwitcher';
```

(b) Window globals — extend the augmentation:

```tsx
declare global {
  interface Window {
    __aegisMobileBack?: () => void;
    __aegisOpenTab?: (url: string) => void;
  }
}
```

(c) Sheet union — add `'tabs'`:

```tsx
type Sheet = 'menu' | 'history' | 'saved' | 'downloads' | 'settings' | 'tabs' | null;
```

(d) Hooks — replace the single-view nav with tabs + active-id nav, and run the sync:

```tsx
  const tabs = useTabs();
  const nav = useNav(tabs.activeId);
  const adblock = useAdblock(tabs.activeId, nav.state.url);
  useMobileTabSync(tabs.tabs, tabs.activeId);
```

(`useFavorites`/`useSaved` stay keyed on `nav.state.url`; everything else unchanged.)

(e) `setChromeOverlay` effect — key it on the active id:

```tsx
  useEffect(() => {
    void aegis.view.setChromeOverlay(tabs.activeId, overlayOpen);
  }, [overlayOpen, tabs.activeId]);
```

(f) New-tab-from-native — install `__aegisOpenTab` (and the Back precedence already covers `sheet !== null`, which now includes `'tabs'`):

```tsx
  useEffect(() => {
    window.__aegisOpenTab = (url) => { void tabs.create(url); };
    return () => { delete window.__aegisOpenTab; };
  }, [tabs]);
```

(g) Bottom bar — new props (replace the whole `<MobileBottomBar .../>` block):

```tsx
      {!bottomBarHidden && !fullscreen && (
        <MobileBottomBar
          onSaved={() => setSheet('saved')}
          onHistory={() => setSheet('history')}
          onTabs={() => setSheet('tabs')}
          tabCount={tabs.tabs.length}
          shield={shield}
          onMenu={() => setSheet('menu')}
        />
      )}
```

(h) Menu sheet — new props (replace the `<MobileMenuSheet .../>` block):

```tsx
      {sheet === 'menu' && (
        <MobileMenuSheet
          onClose={() => setSheet(null)}
          onBack={nav.back}
          onForward={nav.forward}
          canGoBack={nav.state.canGoBack}
          canGoForward={nav.state.canGoForward}
          onHome={nav.home}
          onDownloads={() => setSheet('downloads')}
          onSettings={() => setSheet('settings')}
          isCurrentSaved={saved.isCurrentSaved}
          canBookmark={host !== null}
          onToggleBookmark={() => {
            if (saved.isCurrentSaved) void saved.removeCurrent();
            else void saved.addCurrent(nav.state.title);
          }}
        />
      )}
```

(i) Tab switcher — add the sheet (e.g. right after the menu block):

```tsx
      {sheet === 'tabs' && (
        <MobileTabSwitcher
          tabs={tabs.tabs}
          activeId={tabs.activeId}
          onSwitch={(id) => { void tabs.activate(id); setSheet(null); }}
          onCloseTab={(id) => void tabs.close(id)}
          onNewTab={() => { void tabs.create('about:blank'); setSheet(null); }}
          onClose={() => setSheet(null)}
        />
      )}
```

> `PRIMARY_VIEW_ID` is no longer used directly in render (active id comes from `tabs.activeId`); keep the import only if still referenced, otherwise drop it to avoid an unused-import lint.

- [ ] **Step 4: Run the suite + build** — `npm test` (whole suite green) then `npm run build:renderer` (real TS compile — fix any type error to match the real interfaces). Paste both.

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileApp.tsx src/components/mobile/MobileApp.test.tsx
git commit -m "feat(mobile): MobileApp uses tabs (useTabs + useNav(activeId)) + tab switcher"
```

### Task 7: Switcher + tab-count CSS

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Add the styles** — append to the `===== Mobile (Android) chrome =====` block:

```css
.mobile-bottombar__tabs { position: relative; }
.mobile-bottombar__count { position: absolute; font-size: 10px; line-height: 1; font-weight: 700;
  color: #e6e6e6; top: 50%; left: 50%; transform: translate(-50%, -45%); }

.mobile-tabs__new { display: flex; align-items: center; gap: 8px; width: 100%; height: 48px;
  padding: 0 16px; border: 0; border-bottom: 1px solid #2a2a2a; background: transparent;
  color: #cfcfcf; font-size: 15px; }
.mobile-tabs { list-style: none; margin: 0; padding: 0; }
.mobile-tabs__row { display: flex; align-items: center; border-bottom: 1px solid #222; }
.mobile-tabs__row--active { background: #20232a; }
.mobile-tabs__open { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0;
  height: 52px; padding: 0 12px; border: 0; background: transparent; color: #e6e6e6;
  font-size: 15px; text-align: left; }
.mobile-tabs__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobile-tabs__close { display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 52px; border: 0; background: transparent; color: #9aa0a6; }
```

- [ ] **Step 2: Build** — `npm run build:renderer` → succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "feat(mobile): tab switcher + tab-count CSS"
```

## Milestone 3 — Native (`MainActivity.kt`) — owner builds + GUI-validates

> These edit Kotlin and can't be unit-tested headlessly. After each, the owner runs `JAVA_HOME=/home/happyhobo/development/android-studio/jbr npm run android:build -- --target aarch64` and validates on the device. The agent's job is correct, careful Kotlin.

### Task 8: Per-tab native WebViews

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

The current code creates ONE content `WebView` eagerly in `onWebViewCreate` and stores `contentWebView`/`currentPageUrl` as single values. Refactor to a `tabId → WebView` map; the active tab's WebView becomes `contentWebView` (so all existing active-tab logic — margins, overlay, navigate, back/forward — keeps working unchanged).

- [ ] **Step 1: Add fields** — near `contentWebView`/`chromeWebView`/`currentPageUrl`:

```kotlin
  // One native WebView per tab (live tabs); the active one is mirrored into contentWebView
  // so the existing margin/overlay/nav logic keeps targeting "the active tab".
  private val tabWebViews = HashMap<Int, WebView>()
  private var activeTabId = -1
  // Per-tab current page URL (the ad-block first-party context), read on the network
  // thread in shouldInterceptRequest; concurrent for safe cross-thread reads.
  private val pageUrls = java.util.concurrent.ConcurrentHashMap<Int, String>()
  // The shared content container (the chrome webview's parent), set in onWebViewCreate.
  private var contentParent: ViewGroup? = null
```

> Remove the single `@Volatile private var currentPageUrl: String = ""` field — it's replaced by `pageUrls`.

- [ ] **Step 2: Extract the per-tab WebViewClient into a factory** — replace the inline `content.webViewClient = object : WebViewClient() { ... }` with a method `makeContentClient(id: Int)` (move the existing body, swapping the single fields for the per-tab ones):

```kotlin
  private fun makeContentClient(id: Int): WebViewClient = object : WebViewClient() {
    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      pageUrls[id] = url
      pushNavState(id, url, true)
    }
    override fun onPageFinished(view: WebView, url: String) = pushNavState(id, url, false)
    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
      pageUrls[id] = url
      pushNavState(id, url, view.progress < 100)
    }
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
      val url = request.url?.toString() ?: return null
      if (!url.startsWith("http")) return null
      return try {
        val host = request.url?.host
        val firstParty = pageUrls[id] ?: ""
        when {
          host != null && NativeSafety.isMalwareHost(host) -> { Log.i("AegisSafety", "BLOCK malware $url"); blockedResponse() }
          NativeAdblock.shouldBlock(url, firstParty, requestType(url, request)) -> { Log.i("AegisAdblock", "BLOCK $url"); blockedResponse() }
          else -> null
        }
      } catch (t: Throwable) { Log.w("AegisGuard", "intercept failed for $url", t); null }
    }
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      val raw = request.url?.toString() ?: return false
      if (!raw.startsWith("http")) return false
      return when (val target = secureUrl(raw)) {
        null -> { showMalwareWarning(raw); true }
        raw -> false
        else -> { view.loadUrl(target); true }
      }
    }
  }
```

- [ ] **Step 3: Extract the WebChromeClient factory** — move the existing fullscreen `WebChromeClient` body into `makeChromeClient()` (it's tab-agnostic; one per WebView is fine):

```kotlin
  private fun makeChromeClient(): WebChromeClient = object : WebChromeClient() {
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
      if (customView != null) onHideCustomView()
      customView = view; customCallback = callback
      view.setBackgroundColor(android.graphics.Color.BLACK)
      (window.decorView as ViewGroup).addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      WindowInsetsControllerCompat(window, window.decorView).apply {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        hide(WindowInsetsCompat.Type.systemBars())
      }
    }
    override fun onHideCustomView() {
      val v = customView ?: return
      (window.decorView as ViewGroup).removeView(v); customView = null
      WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
      customCallback?.onCustomViewHidden(); customCallback = null
    }
  }
```

- [ ] **Step 4: A `createTabWebView` builder** (settings + clients + add to the container, hidden):

```kotlin
  private fun createTabWebView(id: Int, url: String): WebView {
    val wv = WebView(this)
    wv.settings.javaScriptEnabled = true
    wv.settings.domStorageEnabled = true
    wv.settings.userAgentString = CHROME_UA
    wv.webChromeClient = makeChromeClient()
    wv.webViewClient = makeContentClient(id)
    val lp = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
    lp.topMargin = topChromePx + statusTop
    lp.bottomMargin = bottomBarPx + navBottom
    wv.visibility = View.GONE
    contentParent?.addView(wv, lp)
    pageUrls[id] = url
    wv.loadUrl(url)
    return wv
  }
```

- [ ] **Step 5: Rewrite `onWebViewCreate`'s body** — DON'T create a content WebView eagerly; just set up `contentParent`, the chrome heights, the insets listener (now calling `applyContentMargins()` on the active webview + pushing CSS vars), the bridge, and the adblock warmup. Replace the block from `val content = WebView(this)` … through `contentWebView = content` with:

```kotlin
      contentParent = parent
      val density = resources.displayMetrics.density
      val top = (72 * density).toInt()
      val bottomBar = (56 * density).toInt()
      topChromePx = top
      bottomBarPx = bottomBar
```

…and keep the existing insets listener + `requestApplyInsets` + `addJavascriptInterface(Bridge(), "AegisAndroid")` + adblock warmup that follow (the listener already calls `applyContentMargins()` which targets `contentWebView`; no per-tab change needed there). The first WebView now arrives via `activateTab` from the chrome's `useMobileTabSync` on mount.

- [ ] **Step 6: Bridge — tab lifecycle + active-targeting nav.** Add to `inner class Bridge`:

```kotlin
    @JavascriptInterface
    fun activateTab(id: Int, url: String) = runOnUiThread {
      val wv = tabWebViews[id] ?: createTabWebView(id, url).also { tabWebViews[id] = it }
      activeTabId = id
      contentWebView = wv
      for ((tid, w) in tabWebViews) if (tid != id) w.visibility = View.GONE
      hasPage = (pageUrls[id] ?: url) != "about:blank"
      applyContentMargins()
      updateContentVisibility()
    }

    @JavascriptInterface
    fun closeTab(id: Int) = runOnUiThread {
      tabWebViews.remove(id)?.let { it.visibility = View.GONE; contentParent?.removeView(it); it.destroy() }
      pageUrls.remove(id)
      if (activeTabId == id) { activeTabId = -1; contentWebView = null }
    }

    @JavascriptInterface
    fun discardTab(id: Int) = runOnUiThread {
      tabWebViews.remove(id)?.let { it.visibility = View.GONE; contentParent?.removeView(it); it.destroy() }
      pageUrls.remove(id)
      if (activeTabId == id) { activeTabId = -1; contentWebView = null }
    }
```

> `closeTab` and `discardTab` have the same native effect (destroy the WebView); they differ only in the registry (the chrome keeps a discarded tab, forgets a closed one). Keeping both bridge methods documents intent and lets them diverge later.

The existing `navigate`/`back`/`forward`/`reload` already operate on `contentWebView` (= the active tab) — leave them, EXCEPT `navigate` must update the active tab's `pageUrls`:

```kotlin
    @JavascriptInterface
    fun navigate(url: String) = runOnUiThread {
      val c = contentWebView ?: return@runOnUiThread
      if (url.isEmpty() || url == "about:blank") {
        hasPage = false; updateContentVisibility()
        if (activeTabId >= 0) pageUrls[activeTabId] = "about:blank"
        pushNavState(activeTabId, "about:blank", false)
      } else {
        when (val target = secureUrl(url)) {
          null -> showMalwareWarning(url)
          else -> { hasPage = true; updateContentVisibility(); if (activeTabId >= 0) pageUrls[activeTabId] = target; c.loadUrl(target) }
        }
      }
    }
```

- [ ] **Step 7: `pushNavState` + `showMalwareWarning` carry the tab id.** Change `pushNavState(url, loading)` → `pushNavState(id: Int, url, loading)` and use `id` for the `"viewId"` JSON field (instead of the hardcoded `1`). Update `showMalwareWarning(url)` to push with `activeTabId`. Their callers are all in `makeContentClient(id)` (uses `id`) and `navigate`/`showMalwareWarning` (use `activeTabId`).

```kotlin
  private fun pushNavState(id: Int, url: String, loading: Boolean) {
    val c = contentWebView
    val obj = JSONObject().put("viewId", id).put("url", url).put("title", c?.title ?: "")
      .put("canGoBack", c?.canGoBack() ?: false).put("canGoForward", c?.canGoForward() ?: false)
      .put("isLoading", loading).put("crashed", false)
    val js = "window.__aegisNavState && window.__aegisNavState($obj)"
    chromeWebView?.post { chromeWebView?.evaluateJavascript(js, null) }
  }
```

- [ ] **Step 8: Owner builds + checks.** `JAVA_HOME=/home/happyhobo/development/android-studio/jbr npm run android:build -- --target aarch64`, install, and confirm: opening the app shows the first tab; the Tabs button shows the count; the switcher lists tabs; **switching tabs preserves live state** (scroll/video); new tab → home screen; closing works; ad-block + the address bar still track the **active** tab. Paste the build result / a screenshot. (If Back inside the switcher should close it — it already does via the `sheet` back-intercept.)

- [ ] **Step 9: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt
git commit -m "feat(mobile): per-tab native WebViews (activate/close/discard, per-tab adblock + nav-state)"
```

### Task 9: `target=_blank` / `window.open` → background tab (deferrable)

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

- [ ] **Step 1: Enable multi-window + handle `onCreateWindow`.** In `createTabWebView`, after the other settings:

```kotlin
    wv.settings.setSupportMultipleWindows(true)
    wv.settings.javaScriptCanOpenWindowsAutomatically = true
```

In `makeChromeClient()`, add (a temporary WebView captures the target URL, routes it to a new chrome tab, then self-destroys):

```kotlin
    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: android.os.Message): Boolean {
      val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
      val temp = WebView(this@MainActivity)
      temp.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
          val url = req.url?.toString() ?: return true
          chromeWebView?.evaluateJavascript("window.__aegisOpenTab && window.__aegisOpenTab(${JSONObject.quote(url)})", null)
          temp.destroy(); return true
        }
      }
      transport.webView = temp
      resultMsg.sendToTarget()
      return true
    }
```

- [ ] **Step 2: Owner builds + checks.** Rebuild; confirm a `target=_blank` / `window.open` link opens a **new background tab** (the tab count increments; you stay on the current page) and doesn't steal focus or loop. **If it misbehaves, this whole task can be reverted** — Task 8 ships tabs fine (such links just open in the current tab as today).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt
git commit -m "feat(mobile): target=_blank/window.open opens a background tab"
```

## Milestone 4 — Gate + docs

### Task 10: Full gate + CLAUDE.md + finish

**Files:**
- Modify: `src/CLAUDE.md`, `src-tauri/CLAUDE.md`

- [ ] **Step 1: Gate** — `npm test` (whole suite green) + `npm run build:renderer` (succeeds). Paste the summary.

- [ ] **Step 2: Docs.**
  - `src/CLAUDE.md` (Mobile shell section): note `MobileApp` now uses `useTabs()` + `useNav(activeId)`; the bottom bar is `[Saved, History, Tabs(count), Shield, Menu]`; the ☰ menu is `[Back, Forward, Home, Bookmark, Downloads, Settings]`; `MobileTabSwitcher` is the vertical-list switcher; `useMobileTabSync` relays registry state → the native tab bridge; `window.__aegisOpenTab` opens a tab for native new-window links.
  - `src-tauri/CLAUDE.md` (Android section): note `MainActivity` keeps a `tabId → WebView` map (live tabs); `AegisAndroid.activateTab/closeTab/discardTab` drive it (the chrome coordinates — Rust can't touch native Android views); per-tab `WebViewClient` (per-tab `pageUrls` for ad-block + nav-state carrying the tab id); `onCreateWindow` → `__aegisOpenTab` background tab.

- [ ] **Step 3: Commit**

```bash
git add src/CLAUDE.md src-tauri/CLAUDE.md
git commit -m "docs(mobile): document mobile tabs (per-tab WebViews + switcher)"
```

- [ ] **Step 4: Finish the branch** — Use superpowers:finishing-a-development-branch (the owner GUI-validates the Android build first).

---

## Self-review notes (author)

- **Spec coverage:** §4 architecture → Tasks 5, 6, 8; §5 native (map/activate/close/discard, per-tab client, active-target nav, onCreateWindow) → Tasks 8, 9; §6 chrome UI (bottom bar, menu, switcher) → Tasks 2, 3, 4, 6, 7; §7 data flow (useTabs, diff-and-sync, per-tab nav-state id) → Tasks 5, 6, 8; §8 testing → embedded + Task 10. All covered.
- **Type consistency:** bridge helpers `activateTab(id,url)`/`closeTab(id)`/`discardTab(id)` (Task 1) ↔ consumer `useMobileTabSync` (Task 5) ↔ native `Bridge` methods (Task 8) match. `TabMeta` fields `{id,pinned,live,title,url}` used in Tasks 4/5. `useTabs()` shape (`tabs,activeId,create,close,activate,...`) used in Task 6 matches `src/hooks/useTabs.ts`. `pushNavState(id,url,loading)` (Task 8 step 7) is updated at every call site.
- **Native caveats:** Tasks 8–9 are owner-built/GUI-validated (no headless test). Task 9 (new-window → tab) is the explicitly-revertable piece. The home-screen behavior is preserved per active tab (`hasPage` follows the active tab's `about:blank`); `+New tab` opens `about:blank` → the chrome home screen.
