# Mobile-friendly UI (touch chrome + panels) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Android a native-feeling mobile chrome — a slim top address bar + a 24dp favourites strip, a thumb-reachable bottom action bar that auto-hides while scrolling, and full-screen sheets (reusing the existing panels) for Settings/History/Saved/Downloads.

**Architecture:** A dedicated `MobileApp` shell is rendered when `isMobile` (the desktop `App` body is unchanged, just renamed `DesktopApp`, with `App` becoming a 1-line selector). `MobileApp` reuses the existing hooks + presentational panels; the desktop chrome is untouched. A small native layer in `MainActivity.kt` adjusts the content-WebView margins, intercepts the Android Back button to close an open sheet, and auto-hides the bottom bar on scroll.

**Tech Stack:** React 19 + TypeScript, Vitest (jsdom), `lucide-react` icons; Android Kotlin (`MainActivity.kt`) + the existing `window.AegisAndroid` bridge.

---

## Testing reality (read first)

- The **renderer** (`src/components/mobile/*`, the `App` branch, `layout.ts`, `ipcClient.ts`) is unit-tested in Vitest jsdom with the `aegis` object mocked. **TDD it** (red → green). `isMobile` is a module constant read from the `.aegis-mobile` class at import — so test the mobile components and `MobileApp` **directly** (render `<MobileApp/>`), not via `App`'s branch.
- The **native Kotlin** (`MainActivity.kt`) cannot be unit-tested headlessly. Those tasks are implement-then-**owner-builds**: the repo owner runs `npm run android:build` and GUI-validates on the emulator/device. Do not claim they pass without that.
- The **desktop suite stays green** throughout (desktop chrome untouched). Run `npm test` after renderer tasks.

Commands: JS one file → `npx vitest run <path>`; whole suite → `npm test`; Android build (owner) → `npm run android:build`.

---

## File structure

**New (renderer, `src/components/mobile/`)**
- `MobileApp.tsx` — the mobile orchestrator (hooks + shell + sheet routing). Rendered by `App` when `isMobile`.
- `MobileTopBar.tsx` — slim address bar (reuses `AddressBar`) + reload/stop + the favourites strip.
- `MobileFavourites.tsx` — 24dp horizontal favourites chips (reuses `useFavorites` data).
- `MobileBottomBar.tsx` — back / forward / home / shield / menu.
- `MobileMenuSheet.tsx` — the ☰ drawer (Settings/History/Saved/Downloads + bookmark toggle).
- `MobileSheet.tsx` — generic full-screen sheet (top bar `← Title` + body), hosts History/Saved.
- Co-located `*.test.tsx` for each.

**Modified**
- `src/App.tsx` — rename the current `App` body to `DesktopApp`; new `App` = `isMobile ? <MobileApp/> : <DesktopApp/>`.
- `src/lib/layout.ts` — add `MOBILE_ADDRESS_H` / `MOBILE_FAV_H` / `MOBILE_BOTTOMBAR_H`.
- `src/lib/ipcClient.ts` — `AndroidBridge.setBackInterceptActive` + an exported `setBackInterceptActive()` helper.
- `src/index.css` — mobile styles for the new components; make `SettingsModal`/`DownloadsModal` full-screen on `.aegis-mobile`; drop the now-dead `.aegis-mobile .toolbar` reflow rules (the desktop `Toolbar` no longer renders on mobile).
- `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt` — content-WebView margins, Android Back handler + `setBackInterceptActive` bridge method, scroll auto-hide.
- `src/CLAUDE.md` / `src-tauri/CLAUDE.md` — document the mobile shell + native changes.

---

## Milestone 1 — Foundations

### Task 1: Mobile layout constants + the Back-intercept bridge

**Files:**
- Modify: `src/lib/layout.ts`
- Modify: `src/lib/ipcClient.ts`
- Test: `src/lib/layout.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `src/lib/layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MOBILE_ADDRESS_H, MOBILE_FAV_H, MOBILE_BOTTOMBAR_H } from './layout';

describe('mobile layout constants', () => {
  it('match the native MainActivity margins (address 48 + fav 24 top; 56 bottom)', () => {
    expect(MOBILE_ADDRESS_H).toBe(48);
    expect(MOBILE_FAV_H).toBe(24);
    expect(MOBILE_BOTTOMBAR_H).toBe(56);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/layout.test.ts`
Expected: FAIL — `MOBILE_ADDRESS_H` is undefined.

- [ ] **Step 3: Add the constants + the bridge helper**

In `src/lib/layout.ts` append:

```ts
/**
 * Mobile (Android) chrome heights in logical px. These MUST stay in sync with the
 * content-WebView margins in MainActivity.kt (the renderer chrome and the native
 * margins have to agree — the same convention the desktop 96px ↔ 96dp uses):
 *   topMargin    = MOBILE_ADDRESS_H + MOBILE_FAV_H  (slim address bar + favourites)
 *   bottomMargin = MOBILE_BOTTOMBAR_H                (the auto-hiding action bar)
 */
export const MOBILE_ADDRESS_H = 48;
export const MOBILE_FAV_H = 24;
export const MOBILE_BOTTOMBAR_H = 56;
```

In `src/lib/ipcClient.ts`, add `setBackInterceptActive` to the `AndroidBridge` interface (after `openExternal`):

```ts
  openExternal(url: string): void;
  /** Tell the native Android Back handler a chrome sheet is open (so Back closes it
   * instead of navigating the page). */
  setBackInterceptActive(active: boolean): void;
```

And export a helper near the bottom of `ipcClient.ts` (after the `aegis` object):

```ts
/** Mobile-only: report whether a chrome sheet/menu is open so the native Android
 * Back button closes it first. No-op off Android. */
export function setBackInterceptActive(active: boolean): void {
  androidBridge()?.setBackInterceptActive(active);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/layout.ts src/lib/layout.test.ts src/lib/ipcClient.ts
git commit -m "feat(mobile): mobile chrome layout constants + back-intercept bridge"
```

## Milestone 2 — Mobile components (jsdom TDD)

### Task 2: `MobileBottomBar`

**Files:**
- Create: `src/components/mobile/MobileBottomBar.tsx`, `src/components/mobile/MobileBottomBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileBottomBar } from './MobileBottomBar';

function setup(over = {}) {
  const props = {
    canGoBack: true, canGoForward: false,
    onBack: vi.fn(), onForward: vi.fn(), onHome: vi.fn(), onMenu: vi.fn(),
    shield: <div data-testid="shield" />,
    ...over,
  };
  render(<MobileBottomBar {...props} />);
  return props;
}

describe('MobileBottomBar', () => {
  it('renders the five controls + the shield slot', () => {
    setup();
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /forward/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /menu/i })).toBeInTheDocument();
    expect(screen.getByTestId('shield')).toBeInTheDocument();
  });
  it('disables back/forward per canGo flags', () => {
    setup({ canGoBack: false, canGoForward: true });
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /forward/i })).not.toBeDisabled();
  });
  it('fires callbacks on tap', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /home/i }));
    expect(p.onHome).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    expect(p.onMenu).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/mobile/MobileBottomBar.test.tsx`
Expected: FAIL — cannot find `./MobileBottomBar`.

- [ ] **Step 3: Implement**

```tsx
import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Home, Menu } from 'lucide-react';

interface MobileBottomBarProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack(): void;
  onForward(): void;
  onHome(): void;
  onMenu(): void;
  shield: ReactNode;
}

export function MobileBottomBar({
  canGoBack, canGoForward, onBack, onForward, onHome, onMenu, shield,
}: MobileBottomBarProps) {
  return (
    <nav className="mobile-bottombar" aria-label="Browser actions">
      <button type="button" className="mobile-bottombar__btn" aria-label="Back" disabled={!canGoBack} onClick={onBack}>
        <ArrowLeft size={22} aria-hidden="true" />
      </button>
      <button type="button" className="mobile-bottombar__btn" aria-label="Forward" disabled={!canGoForward} onClick={onForward}>
        <ArrowRight size={22} aria-hidden="true" />
      </button>
      <button type="button" className="mobile-bottombar__btn" aria-label="Home" onClick={onHome}>
        <Home size={22} aria-hidden="true" />
      </button>
      <div className="mobile-bottombar__shield">{shield}</div>
      <button type="button" className="mobile-bottombar__btn" aria-label="Menu" onClick={onMenu}>
        <Menu size={22} aria-hidden="true" />
      </button>
    </nav>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/mobile/MobileBottomBar.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileBottomBar.tsx src/components/mobile/MobileBottomBar.test.tsx
git commit -m "feat(mobile): MobileBottomBar"
```

### Task 3: `MobileFavourites`

**Files:**
- Create: `src/components/mobile/MobileFavourites.tsx`, `src/components/mobile/MobileFavourites.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileFavourites } from './MobileFavourites';
import type { Favorite } from '../../../shared/types';

const favs: Favorite[] = [
  { id: 1, name: 'Home', url: 'https://home.test/', position: 0 },
  { id: 2, name: 'News', url: 'https://news.test/', position: 1 },
];

describe('MobileFavourites', () => {
  it('renders a chip per favourite and opens on tap', () => {
    const onOpen = vi.fn();
    render(<MobileFavourites favorites={favs} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'News' }));
    expect(onOpen).toHaveBeenCalledWith('https://news.test/');
  });
  it('renders nothing when there are no favourites', () => {
    const { container } = render(<MobileFavourites favorites={[]} onOpen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/mobile/MobileFavourites.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
import type { Favorite } from '../../../shared/types';

interface MobileFavouritesProps {
  favorites: Favorite[];
  onOpen(url: string): void;
}

export function MobileFavourites({ favorites, onOpen }: MobileFavouritesProps) {
  if (favorites.length === 0) return null;
  return (
    <div className="mobile-favourites" aria-label="Favourites">
      {favorites.map((f) => (
        <button
          key={f.id}
          type="button"
          className="mobile-favourites__chip"
          title={f.name}
          onClick={() => onOpen(f.url)}
        >
          {f.name}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/mobile/MobileFavourites.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileFavourites.tsx src/components/mobile/MobileFavourites.test.tsx
git commit -m "feat(mobile): MobileFavourites strip"
```

### Task 4: `MobileSheet` (generic full-screen sheet)

**Files:**
- Create: `src/components/mobile/MobileSheet.tsx`, `src/components/mobile/MobileSheet.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileSheet } from './MobileSheet';

describe('MobileSheet', () => {
  it('renders the title + body and closes via the back button', () => {
    const onClose = vi.fn();
    render(<MobileSheet title="History" onClose={onClose}><p>body</p></MobileSheet>);
    expect(screen.getByRole('dialog', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/mobile/MobileSheet.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

interface MobileSheetProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

export function MobileSheet({ title, onClose, children }: MobileSheetProps) {
  return (
    <div className="mobile-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="mobile-sheet__bar">
        <button type="button" className="mobile-sheet__back" aria-label="Back" onClick={onClose}>
          <ArrowLeft size={22} aria-hidden="true" />
        </button>
        <h2 className="mobile-sheet__title">{title}</h2>
      </header>
      <div className="mobile-sheet__body">{children}</div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/mobile/MobileSheet.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileSheet.tsx src/components/mobile/MobileSheet.test.tsx
git commit -m "feat(mobile): MobileSheet full-screen wrapper"
```

### Task 5: `MobileMenuSheet` (the ☰ drawer)

**Files:**
- Create: `src/components/mobile/MobileMenuSheet.tsx`, `src/components/mobile/MobileMenuSheet.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileMenuSheet } from './MobileMenuSheet';

function setup(over = {}) {
  const props = {
    onClose: vi.fn(), onSettings: vi.fn(), onHistory: vi.fn(), onSaved: vi.fn(), onDownloads: vi.fn(),
    isCurrentSaved: false, canBookmark: true, onToggleBookmark: vi.fn(),
    ...over,
  };
  render(<MobileMenuSheet {...props} />);
  return props;
}

describe('MobileMenuSheet', () => {
  it('launches each feature', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));
    expect(p.onSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(p.onHistory).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /downloads/i }));
    expect(p.onDownloads).toHaveBeenCalled();
  });
  it('shows the bookmark action and toggles its label', () => {
    setup({ isCurrentSaved: false });
    expect(screen.getByRole('button', { name: /bookmark this page/i })).toBeInTheDocument();
  });
  it('reflects an already-saved page', () => {
    const p = setup({ isCurrentSaved: true });
    fireEvent.click(screen.getByRole('button', { name: /remove bookmark/i }));
    expect(p.onToggleBookmark).toHaveBeenCalled();
  });
  it('disables bookmarking when the page is not bookmarkable', () => {
    setup({ canBookmark: false });
    expect(screen.getByRole('button', { name: /bookmark this page/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/mobile/MobileMenuSheet.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
import { Settings, History, Bookmark, Download, Star } from 'lucide-react';
import { MobileSheet } from './MobileSheet';

interface MobileMenuSheetProps {
  onClose(): void;
  onSettings(): void;
  onHistory(): void;
  onSaved(): void;
  onDownloads(): void;
  isCurrentSaved: boolean;
  canBookmark: boolean;
  onToggleBookmark(): void;
}

export function MobileMenuSheet({
  onClose, onSettings, onHistory, onSaved, onDownloads,
  isCurrentSaved, canBookmark, onToggleBookmark,
}: MobileMenuSheetProps) {
  return (
    <MobileSheet title="Menu" onClose={onClose}>
      <ul className="mobile-menu">
        <li>
          <button type="button" className="mobile-menu__item" disabled={!canBookmark} onClick={onToggleBookmark}>
            <Star size={20} aria-hidden="true" />
            {isCurrentSaved ? 'Remove bookmark' : 'Bookmark this page'}
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onSaved}>
            <Bookmark size={20} aria-hidden="true" />Saved
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onHistory}>
            <History size={20} aria-hidden="true" />History
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

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/mobile/MobileMenuSheet.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileMenuSheet.tsx src/components/mobile/MobileMenuSheet.test.tsx
git commit -m "feat(mobile): MobileMenuSheet drawer"
```

### Task 6: `MobileTopBar` (address bar + reload + favourites)

**Files:**
- Create: `src/components/mobile/MobileTopBar.tsx`, `src/components/mobile/MobileTopBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileTopBar } from './MobileTopBar';
import type { Favorite } from '../../../shared/types';

const favs: Favorite[] = [{ id: 1, name: 'Home', url: 'https://home.test/', position: 0 }];

function setup(over = {}) {
  const props = {
    url: 'https://example.com/', isLoading: false,
    onNavigate: vi.fn(), onReloadOrStop: vi.fn(),
    favorites: favs, onOpenFavourite: vi.fn(),
    ...over,
  };
  render(<MobileTopBar {...props} />);
  return props;
}

describe('MobileTopBar', () => {
  it('shows a reload button that becomes stop while loading', () => {
    setup({ isLoading: false });
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });
  it('shows stop while loading and fires onReloadOrStop', () => {
    const p = setup({ isLoading: true });
    const stop = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(stop);
    expect(p.onReloadOrStop).toHaveBeenCalled();
  });
  it('renders the favourites strip', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(p.onOpenFavourite).toHaveBeenCalledWith('https://home.test/');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/mobile/MobileTopBar.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
import { RotateCw, X } from 'lucide-react';
import type { Favorite } from '../../../shared/types';
import { AddressBar } from '../AddressBar';
import { MobileFavourites } from './MobileFavourites';

interface MobileTopBarProps {
  url: string;
  isLoading: boolean;
  onNavigate(raw: string): void;
  onReloadOrStop(): void;
  favorites: Favorite[];
  onOpenFavourite(url: string): void;
}

export function MobileTopBar({
  url, isLoading, onNavigate, onReloadOrStop, favorites, onOpenFavourite,
}: MobileTopBarProps) {
  return (
    <div className="mobile-topbar">
      <div className="mobile-topbar__row">
        <AddressBar url={url} onSubmit={onNavigate} />
        <button
          type="button"
          className="mobile-topbar__reload"
          aria-label={isLoading ? 'Stop' : 'Reload'}
          onClick={onReloadOrStop}
        >
          {isLoading ? <X size={18} aria-hidden="true" /> : <RotateCw size={18} aria-hidden="true" />}
        </button>
      </div>
      <MobileFavourites favorites={favorites} onOpen={onOpenFavourite} />
    </div>
  );
}
```

> If the reused `AddressBar` requires extra props beyond `url`/`onSubmit`, open `src/components/AddressBar.tsx` and pass exactly what its interface needs (the desktop `Toolbar` calls it `<AddressBar url={state.url} onSubmit={navigate} />`, so those two are the contract).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/mobile/MobileTopBar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileTopBar.tsx src/components/mobile/MobileTopBar.test.tsx
git commit -m "feat(mobile): MobileTopBar"
```

## Milestone 3 — Orchestration + branch + CSS

### Task 7: `MobileApp` orchestrator

**Files:**
- Create: `src/components/mobile/MobileApp.tsx`, `src/components/mobile/MobileApp.test.tsx`

- [ ] **Step 1: Write the failing test**

`MobileApp.test.tsx` (mock `aegis` like `App.test.tsx` does — copy its `vi.mock('../../lib/ipcClient', ...)` shape, including a `tabs`/`nav`/`favorites`/`saved`/`history`/`downloads`/`settings`/`adblock`/`view`/`permissions`/`subs`/`customFilters` surface and the exported `setBackInterceptActive`). Minimum assertions:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileApp } from './MobileApp';

// vi.mock('../../lib/ipcClient', () => ({ aegis: { ...minimal mock... }, setBackInterceptActive: vi.fn() }))
// (Model it on src/App.test.tsx's aegis mock; add favorites.list -> [], saved.list -> [], etc.)

describe('MobileApp', () => {
  it('renders the top bar + bottom bar (no desktop Toolbar)', async () => {
    render(<MobileApp />);
    expect(await screen.findByRole('navigation', { name: /browser actions/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/toggle sidebar/i)).toBeNull();
  });
  it('opens the menu sheet from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /menu/i }));
    expect(await screen.findByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
  });
  it('opens History from the menu', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /menu/i }));
    fireEvent.click(await screen.findByRole('button', { name: /history/i }));
    expect(await screen.findByRole('dialog', { name: 'History' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/mobile/MobileApp.test.tsx`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState } from 'react';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import { aegis, setBackInterceptActive } from '../../lib/ipcClient';
import { applyTheme } from '../../lib/theme';
import { useNav } from '../../hooks/useNav';
import { useAdblock } from '../../hooks/useAdblock';
import { useFavorites } from '../../hooks/useFavorites';
import { useHistory } from '../../hooks/useHistory';
import { useSaved } from '../../hooks/useSaved';
import { useSettings } from '../../hooks/useSettings';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { useCustomFilters } from '../../hooks/useCustomFilters';
import { useDownloads } from '../../hooks/useDownloads';
import { usePermissions } from '../../hooks/usePermissions';
import { AdblockShield } from '../AdblockShield';
import { HistoryPanel } from '../HistoryPanel';
import { SavedPanel } from '../SavedPanel';
import { DownloadsModal } from '../DownloadsModal';
import { SettingsModal } from '../SettingsModal';
import { AppearanceTab } from '../AppearanceTab';
import { SearchTab } from '../SearchTab';
import { HomeTab } from '../HomeTab';
import { TabsTab } from '../TabsTab';
import { FilterListsTab } from '../FilterListsTab';
import { MyFiltersTab } from '../MyFiltersTab';
import { AllowlistTab } from '../AllowlistTab';
import { DownloadsTab } from '../DownloadsTab';
import { SitePermissionsTab } from '../SitePermissionsTab';
import { SecurityTab } from '../SecurityTab';
import { DataTab } from '../DataTab';
import { PermissionPromptDialog } from '../PermissionPromptDialog';
import { Toaster } from '../Toaster';
import { ConfirmDialog } from '../ConfirmDialog';
import { MobileTopBar } from './MobileTopBar';
import { MobileBottomBar } from './MobileBottomBar';
import { MobileMenuSheet } from './MobileMenuSheet';
import { MobileSheet } from './MobileSheet';

declare global {
  interface Window { __aegisMobileBack?: () => void }
}

type Sheet = 'menu' | 'history' | 'saved' | 'downloads' | 'settings' | null;

function hostOf(url: string): string | null {
  try { const h = new URL(url).hostname; return h.length > 0 ? h : null; } catch { return null; }
}

export function MobileApp() {
  const nav = useNav(PRIMARY_VIEW_ID);
  const adblock = useAdblock(PRIMARY_VIEW_ID, nav.state.url);
  const favorites = useFavorites(nav.state.url);
  const history = useHistory();
  const saved = useSaved(nav.state.url);
  const settings = useSettings();
  const subscriptions = useSubscriptions();
  const customFilters = useCustomFilters();
  const downloads = useDownloads();
  const permissions = usePermissions();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [shieldOpen, setShieldOpen] = useState(false);

  useEffect(() => { void aegis.settings.get().then((s) => applyTheme(s)); }, []);

  // Any sheet/menu (or the shield popover) covers the page: lower the native content
  // via the existing overlay bridge, and tell the native Back handler to close it first.
  const overlayOpen = sheet !== null || shieldOpen;
  useEffect(() => {
    void aegis.view.setChromeOverlay(PRIMARY_VIEW_ID, overlayOpen);
  }, [overlayOpen]);
  useEffect(() => {
    setBackInterceptActive(sheet !== null);
    window.__aegisMobileBack = () => setSheet(null);
    return () => { delete window.__aegisMobileBack; };
  }, [sheet]);

  const host = hostOf(nav.state.url);
  const shield = (
    <AdblockShield
      state={adblock.state}
      page={adblock.page}
      host={host}
      setEnabled={adblock.setEnabled}
      toggleAllowlist={adblock.toggleAllowlist}
      onOpenChange={setShieldOpen}
    />
  );

  return (
    <div className="app app--mobile">
      <MobileTopBar
        url={nav.state.url}
        isLoading={nav.state.isLoading}
        onNavigate={nav.navigate}
        onReloadOrStop={nav.reloadOrStop}
        favorites={favorites.favorites}
        onOpenFavourite={(url) => void nav.navigate(url)}
      />
      <div className="content-anchor" />
      <MobileBottomBar
        canGoBack={nav.state.canGoBack}
        canGoForward={nav.state.canGoForward}
        onBack={nav.back}
        onForward={nav.forward}
        onHome={nav.home}
        onMenu={() => setSheet('menu')}
        shield={shield}
      />

      {sheet === 'menu' && (
        <MobileMenuSheet
          onClose={() => setSheet(null)}
          onSettings={() => setSheet('settings')}
          onHistory={() => setSheet('history')}
          onSaved={() => setSheet('saved')}
          onDownloads={() => setSheet('downloads')}
          isCurrentSaved={saved.isCurrentSaved}
          canBookmark={host !== null}
          onToggleBookmark={() => {
            if (saved.isCurrentSaved) void saved.removeCurrent();
            else void saved.addCurrent(nav.state.title);
          }}
        />
      )}

      {sheet === 'history' && (
        <MobileSheet title="History" onClose={() => setSheet(null)}>
          <HistoryPanel
            entries={history.entries}
            query={history.query}
            setQuery={history.setQuery}
            search={history.search}
            remove={history.remove}
            clear={history.clear}
            onOpen={(url) => { void nav.navigate(url); setSheet(null); }}
          />
        </MobileSheet>
      )}

      {sheet === 'saved' && (
        <MobileSheet title="Saved" onClose={() => setSheet(null)}>
          <SavedPanel
            items={saved.items}
            tagUnion={saved.tagUnion}
            activeTags={saved.activeTags}
            setActiveTags={saved.setActiveTags}
            add={(input) => void saved.add(input)}
            remove={(id) => void saved.remove(id)}
            update={(id, partial) => void saved.update(id, partial)}
            renameTag={(oldT, newT) => void saved.renameTag(oldT, newT)}
            deleteTag={(tag) => void saved.deleteTag(tag)}
            onOpen={(url) => { void nav.navigate(url); setSheet(null); }}
          />
        </MobileSheet>
      )}

      {sheet === 'downloads' && (
        <DownloadsModal
          onClose={() => setSheet(null)}
          downloads={downloads.downloads}
          remove={(id) => void downloads.remove(id)}
          clear={() => void downloads.clear()}
          openFile={(id) => void downloads.openFile(id)}
          showInFolder={(id) => void downloads.showInFolder(id)}
          cancel={(id) => void downloads.cancel(id)}
        />
      )}

      {sheet === 'settings' && (
        <SettingsModal
          onClose={() => setSheet(null)}
          appearance={<AppearanceTab settings={settings.settings} update={settings.update} />}
          search={<SearchTab settings={settings.settings} update={settings.update} />}
          home={<HomeTab settings={settings.settings} update={settings.update} />}
          tabs={<TabsTab settings={settings.settings} update={settings.update} />}
          filterLists={
            <FilterListsTab
              subs={subscriptions.subs}
              setEnabled={subscriptions.setEnabled}
              add={subscriptions.add}
              remove={subscriptions.remove}
              updateNow={subscriptions.updateNow}
            />
          }
          myFilters={<MyFiltersTab text={customFilters.text} save={customFilters.save} />}
          allowlist={
            <AllowlistTab
              hosts={adblock.state.allowlistedHosts}
              removeAllowlist={adblock.removeAllowlist}
              clearAllowlist={adblock.clearAllowlist}
            />
          }
          downloads={<DownloadsTab settings={settings.settings} update={settings.update} />}
          sitePermissions={
            <SitePermissionsTab
              permissions={permissions.permissions}
              remove={permissions.remove}
              clear={permissions.clear}
            />
          }
          security={
            <SecurityTab
              settings={settings.settings}
              update={settings.update}
              listExceptions={() => aegis.safety.listExceptions()}
              removeException={(h) => void aegis.safety.removeException(h)}
            />
          }
          data={
            <DataTab
              onExport={() => aegis.data.export()}
              onImport={(mode, source) => aegis.data.import(mode, source)}
            />
          }
        />
      )}

      {permissions.prompt && (
        <PermissionPromptDialog
          prompt={permissions.prompt}
          onResolve={(_requestId, decision) => void permissions.resolve(decision)}
        />
      )}
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
```

> The `SettingsModal` block is intentionally identical to `App.tsx`'s usage (same tab props) — reuse it verbatim so the Settings sheet is the full settings UI.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/mobile/MobileApp.test.tsx`
Expected: PASS (3 tests). If the mock is missing a method a hook calls, add it to the mock (model on `App.test.tsx`) — fix the TEST mock, not the component.

- [ ] **Step 5: Commit**

```bash
git add src/components/mobile/MobileApp.tsx src/components/mobile/MobileApp.test.tsx
git commit -m "feat(mobile): MobileApp shell orchestrator"
```

### Task 8: `App` branch + mobile CSS

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/index.css`

- [ ] **Step 1: Branch `App`**

In `src/App.tsx`: add the import `import { MobileApp } from './components/mobile/MobileApp';`. Rename the existing `export function App() {` to `function DesktopApp() {` (the entire current body, unchanged). Add a new selector at the bottom of the file:

```tsx
export function App() {
  return isMobile ? <MobileApp /> : <DesktopApp />;
}
```

(`isMobile` is the existing module constant. `DesktopApp` is the verbatim old `App` body — do not change its logic, just the function name.)

- [ ] **Step 2: Add the mobile CSS**

In `src/index.css`, REPLACE the dead `.aegis-mobile .toolbar` / `.address-bar` (order/flex) / `.favorites-bar` / `.toolbar__fullscreen` reflow rules (the desktop `Toolbar` no longer renders on mobile) — KEEP only the font-size rule that still applies to the reused `AddressBar`:

```css
/* ===== Mobile (Android) chrome — the MobileApp shell ===== */
.aegis-mobile .address-bar input { font-size: 16px; height: 38px; } /* no focus-zoom, touch height */

.mobile-topbar { position: fixed; top: 0; left: 0; right: 0; z-index: 10;
  background: #1b1b1b; border-bottom: 1px solid #2a2a2a;
  padding: env(safe-area-inset-top) calc(8px + env(safe-area-inset-right)) 0 calc(8px + env(safe-area-inset-left)); }
.mobile-topbar__row { display: flex; align-items: center; gap: 6px; height: 48px; }
.mobile-topbar__reload { display: inline-flex; align-items: center; justify-content: center;
  width: 38px; height: 38px; border: 0; background: transparent; color: #cfcfcf; border-radius: 8px; }
.mobile-favourites { display: flex; gap: 6px; height: 24px; overflow-x: auto; align-items: center;
  scrollbar-width: none; }
.mobile-favourites::-webkit-scrollbar { display: none; }
.mobile-favourites__chip { flex: 0 0 auto; height: 22px; padding: 0 8px; font-size: 12px; line-height: 22px;
  border: 0; border-radius: 11px; background: #2a2a2a; color: #cfcfcf; white-space: nowrap; }

.mobile-bottombar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; height: 56px;
  display: flex; align-items: center; justify-content: space-around;
  background: #1b1b1b; border-top: 1px solid #2a2a2a;
  padding-bottom: env(safe-area-inset-bottom); }
.mobile-bottombar__btn { display: inline-flex; align-items: center; justify-content: center;
  width: 48px; height: 48px; border: 0; background: transparent; color: #e6e6e6; border-radius: 10px; }
.mobile-bottombar__btn:disabled { color: #555; }
.mobile-bottombar__shield { display: inline-flex; align-items: center; }

.mobile-sheet { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column;
  background: #161616; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
.mobile-sheet__bar { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 8px;
  border-bottom: 1px solid #2a2a2a; }
.mobile-sheet__back { display: inline-flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border: 0; background: transparent; color: #e6e6e6; border-radius: 10px; }
.mobile-sheet__title { font-size: 17px; margin: 0; color: #fff; }
.mobile-sheet__body { flex: 1; overflow: auto; }

.mobile-menu { list-style: none; margin: 0; padding: 8px; }
.mobile-menu__item { display: flex; align-items: center; gap: 12px; width: 100%; height: 52px;
  padding: 0 12px; border: 0; background: transparent; color: #e6e6e6; font-size: 16px; text-align: left; }
.mobile-menu__item:disabled { color: #666; }

/* Reused desktop modals go full-screen on mobile. */
.aegis-mobile .settings-modal, .aegis-mobile .downloads-modal { inset: 0; }
.aegis-mobile .settings-modal__content, .aegis-mobile .downloads-modal__content {
  width: 100%; height: 100%; max-width: none; max-height: none; border-radius: 0; }
```

> Verify the exact class names of `SettingsModal`/`DownloadsModal`'s root + content (`settings-modal`, `settings-modal__content`, and the downloads modal's equivalents) by opening those components; adjust the last block to match.

- [ ] **Step 3: Run the suite + desktop App test**

Run: `npm test`
Expected: whole suite green — `App.test.tsx` still passes (renders `DesktopApp` since jsdom has no `.aegis-mobile` class), plus all the new mobile component tests. Paste the summary.

- [ ] **Step 4: Verify the renderer builds**

Run: `npm run build:renderer`
Expected: vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/index.css
git commit -m "feat(mobile): render MobileApp on Android; mobile chrome CSS"
```

## Milestone 4 — Native (`MainActivity.kt`) — owner builds + GUI-validates

> These tasks edit Kotlin and cannot be unit-tested headlessly. After each, the repo owner runs `npm run android:build` and checks behavior on the emulator/device. The agent's job is correct, careful Kotlin.

### Task 9: Content-WebView margins (slim top + bottom-bar gap)

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

- [ ] **Step 1: Change the margins**

In `onWebViewCreate`, the content WebView currently uses `val top = (96 * density).toInt()` and the inset listener sets `p.topMargin = top + bars.top; p.bottomMargin = bars.bottom`. Change to the new mobile chrome heights (top = address 48 + favourites 24 = 72; bottom bar 56), keeping them in sync with `src/lib/layout.ts` (`MOBILE_ADDRESS_H + MOBILE_FAV_H` / `MOBILE_BOTTOMBAR_H`):

```kotlin
// Slim top address bar (48dp) + favourites strip (24dp) = 72dp; bottom action bar 56dp.
// MUST match src/lib/layout.ts MOBILE_ADDRESS_H + MOBILE_FAV_H / MOBILE_BOTTOMBAR_H.
val density = resources.displayMetrics.density
val top = (72 * density).toInt()
val bottomBar = (56 * density).toInt()
```

Set the initial layout params with the bottom margin too:

```kotlin
lp.topMargin = top
lp.bottomMargin = bottomBar
```

And in the `setOnApplyWindowInsetsListener` block:

```kotlin
p.topMargin = top + bars.top
p.bottomMargin = bottomBar + bars.bottom
```

(`bottomBar` must be visible to the listener closure — declare `top`/`bottomBar` before it, as above.)

- [ ] **Step 2: Owner builds + checks**

Owner runs `npm run android:build`, installs the APK, and confirms: the content sits below the slim top chrome and above a bottom gap (the bottom bar shows there). Paste the build result / a screenshot.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt
git commit -m "feat(mobile): android content-webview margins for the new chrome"
```

### Task 10: Android Back closes an open sheet

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

- [ ] **Step 1: Add the flag + bridge method + back override**

Add a field near `hasPage`/`overlayHidden`:

```kotlin
// True while a chrome sheet/menu is open — the Back button should close it (via the
// chrome) before navigating the page. Set by the chrome through AegisAndroid.
@Volatile private var backInterceptActive = false
```

Add a bridge method inside `inner class Bridge`:

```kotlin
@JavascriptInterface
fun setBackInterceptActive(active: Boolean) = runOnUiThread {
  backInterceptActive = active
}
```

Override the activity Back press (place it as a method on `MainActivity`):

```kotlin
@Deprecated("Back press precedence: close an open chrome sheet, else page-back, else default")
override fun onBackPressed() {
  when {
    backInterceptActive -> chromeWebView?.evaluateJavascript(
      "window.__aegisMobileBack && window.__aegisMobileBack()", null,
    )
    contentWebView?.canGoBack() == true -> contentWebView?.goBack()
    else -> @Suppress("DEPRECATION") super.onBackPressed()
  }
}
```

> Note: if the build target has predictive back / `OnBackInvokedDispatcher` enforced (so `onBackPressed` is never called), register an `androidx.activity.OnBackPressedCallback` in `onCreate` with the same three-way logic instead. Owner: if Back doesn't behave, that's the switch to make.

- [ ] **Step 2: Owner builds + checks**

`npm run android:build`; confirm: with a sheet open, hardware Back closes the sheet (page unchanged); with no sheet but page history, Back navigates the page back; at the root, Back exits. Paste results.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt
git commit -m "feat(mobile): android back closes an open chrome sheet"
```

### Task 11: Bottom-bar scroll auto-hide (stretch)

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

- [ ] **Step 1: Animate the content bottom margin on scroll direction**

After the content WebView is created (and `bottomBar` is known), add a scroll listener that hides the bar (content bottom margin → 0) on scroll-down and shows it (→ `bottomBar + navInset`) on scroll-up, with a small threshold. Store the current nav-bar bottom inset so the shown margin is correct:

```kotlin
// Remember the system nav-bar bottom inset so "show the bar" restores the right gap.
// (Updated in the insets listener above: set `navBottom = bars.bottom` there too.)
// Auto-hide: scroll down past a threshold collapses the bottom-bar gap (bar hidden);
// scroll up restores it. Push model — the chrome bar lives behind the content WebView
// and only shows in this gap. Disabled at the very top of the page (always show).
val threshold = (6 * density).toInt()
content.setOnScrollChangeListener { _, _, scrollY, _, oldScrollY ->
  val dy = scrollY - oldScrollY
  val target = when {
    scrollY <= 0 -> bottomBar + navBottom            // top of page: always show
    dy > threshold -> 0                              // scrolling down: hide
    dy < -threshold -> bottomBar + navBottom         // scrolling up: show
    else -> return@setOnScrollChangeListener
  }
  val p = content.layoutParams as? FrameLayout.LayoutParams ?: return@setOnScrollChangeListener
  if (p.bottomMargin == target) return@setOnScrollChangeListener
  android.animation.ValueAnimator.ofInt(p.bottomMargin, target).apply {
    duration = 160
    addUpdateListener { a ->
      p.bottomMargin = a.animatedValue as Int
      content.layoutParams = p
    }
    start()
  }
}
```

Add the `navBottom` field and set it in the insets listener:

```kotlin
@Volatile private var navBottom = 0
// ...inside setOnApplyWindowInsetsListener, alongside the margin updates:
navBottom = bars.bottom
```

When a sheet opens the content is hidden anyway (`setContentHidden`), and on close the next scroll-up / top-of-page restores the bar — no extra reset needed.

- [ ] **Step 2: Owner builds + checks**

`npm run android:build`; confirm scrolling down hides the bottom bar (content expands), scrolling up / reaching the top reveals it; no jank. **If it's janky, this whole task can be reverted/deferred** — items 9–10 ship the static bottom bar fine.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt
git commit -m "feat(mobile): auto-hide the bottom bar on content scroll"
```

## Milestone 5 — Gate + docs

### Task 12: Full gate + CLAUDE.md

**Files:**
- Modify: `src/CLAUDE.md`, `src-tauri/CLAUDE.md`

- [ ] **Step 1: Run the gate**

Run: `npm test`
Expected: whole suite green (desktop unaffected + new mobile tests). Paste summary.
Run: `npm run build:renderer` → succeeds.

- [ ] **Step 2: Update the living docs**

- `src/CLAUDE.md`: note that on Android (`isMobile`) `App` renders `MobileApp` (a dedicated mobile shell in `src/components/mobile/`) instead of the desktop chrome — a slim top address bar + 24dp favourites + a bottom action bar + full-screen sheets reusing the existing panels; `lib/layout.ts` has `MOBILE_*_H` constants that must match the native margins; the desktop chrome is unchanged.
- `src-tauri/CLAUDE.md` (Android section): note `MainActivity.kt` now sets the content-WebView `topMargin = 72dp` / `bottomMargin = 56dp` for the new mobile chrome (kept in sync with `MOBILE_*_H`), overrides Back to close an open chrome sheet (via `backInterceptActive` + the new `AegisAndroid.setBackInterceptActive` bridge method + `window.__aegisMobileBack`), and auto-hides the bottom bar on content scroll.

- [ ] **Step 3: Commit**

```bash
git add src/CLAUDE.md src-tauri/CLAUDE.md
git commit -m "docs(mobile): document the mobile chrome shell + android changes"
```

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch (the owner GUI-validates the Android build first).

---

## Self-review notes (author)

- **Spec coverage:** §4.1 components → Tasks 2–7; §4.2 layout/constants → Tasks 1, 8, 9; §4.3 menu routing → Task 7 (`MobileApp` sheet states) + Task 8 CSS; §5.1 margins → Task 9; §5.2 Back handler → Tasks 1 (bridge), 7 (`__aegisMobileBack`/`setBackInterceptActive`), 10 (native); §5.3 auto-hide → Task 11; §6 reuse → Task 7; §7 testing → embedded + Task 12. All covered.
- **Type consistency:** `setBackInterceptActive` (Task 1 helper ← Task 7 caller ← Task 10 native method) and `window.__aegisMobileBack` (Task 7 installs ← Task 10 calls) match. The `Sheet` union and the menu callbacks are defined and consumed in Task 7. Reused-component props mirror `App.tsx` verbatim.
- **Native caveat:** Tasks 9–11 are owner-built/GUI-validated (no headless test); the Back-override may need the `OnBackPressedCallback` variant flagged in Task 10. Task 11 is an explicitly revertable stretch.
