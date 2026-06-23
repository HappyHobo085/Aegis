# Centralized Content Compositor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scattered, manually-maintained content-visibility/z-order logic (the `App.tsx` overlay union + the thrice-duplicated visibility predicate in `view.rs`) with a single declarative source of truth on each side, plus auto-registering chrome surfaces, so the "forgot to register a new overlay → it renders behind the page" class of bug becomes structurally impossible.

**Architecture:** Keep the exact two-webview layout (chrome webview + opaque native content webview) and the exact pixel layout. Change only _how the composition is decided_: (1) a pure `computeContentLayout()` function on the renderer replaces the inline boolean soup; (2) a `ChromeSurfaceProvider` registry lets every full-window surface register itself while open, so `fullOverlayActive` is _derived_, never hand-maintained; (3) a single `content_visible(&Layout)` function on the Rust side replaces the three duplicated predicates; (4) a drift-guard test asserts every overlay lowers the content. This is a **pure refactor** — the IPC calls emitted must be byte-identical to today's, proven by the existing autopilot tour passing unchanged.

**Tech Stack:** React 19 + TypeScript (renderer), Vitest (jsdom) for renderer tests, Rust + Tauri 2 (`view.rs`), `cargo test` for Rust tests.

## Global Constraints

- **No behavior change.** This is a refactor. The sequence of `aegis.view.setLayout` / `aegis.view.setFullscreen` calls for any given UI state must be identical to today's. The existing `src/autopilot/tour.test.tsx` and `interactions.test.tsx` must pass **unchanged** (do not edit them to accommodate the refactor; if they break, the refactor is wrong).
- **No new IPC channels.** Reuse the existing `view.setLayout` / `view.setFullscreen` channels. (Per `CLAUDE.md`, a new channel needs edits in `shared/types.ts` + the Rust dispatcher + `ipcClient.ts` — we add none.)
- **Scope is the DESKTOP shell (`DesktopApp` in `App.tsx`).** The mobile shell (`MobileApp`) routes overlays through `view.setChromeOverlay` via the `AegisAndroid` bridge — a separate path, explicitly out of scope here.
- **Living docs, enforced.** Update `src/CLAUDE.md` and the autopilot notes in the same commit as the code (per the repo's living-docs rule).
- **Test gate:** `npm test` green AND `cargo test --manifest-path src-tauri/Cargo.toml` green before the final commit. For any runtime-behavior change, the repo also requires `bash scripts/autopilot/run-autopilot.sh` (Linux) green — here that gate proves the refactor preserved real z-order behavior.
- **Event names never contain `.` on the wire** — not touched by this plan (we add no events), but do not introduce any.

---

## File Structure

| File                                        | Responsibility                                                                                                                                      | Action |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | ------ |
| `src/lib/contentLayout.ts`                  | Pure `computeContentLayout(state) → {overlay, sidebar, width}`. The single renderer-side derivation.                                                | Create |
| `src/lib/contentLayout.test.ts`             | Truth-table tests for `computeContentLayout`.                                                                                                       | Create |
| `src/hooks/useChromeSurfaces.tsx`           | `ChromeSurfaceProvider` + `useChromeSurfaceRegistry()` + `useChromeSurface(id, active)`. The auto-registering surface set.                          | Create |
| `src/hooks/useChromeSurfaces.test.tsx`      | Registry register/unregister + hook lifecycle tests.                                                                                                | Create |
| `src/App.tsx`                               | Wrap `DesktopApp` in the provider; derive `fullOverlayActive` from the registry; compute the layout via `computeContentLayout`; delete the manual ` |        | ` union.  | Modify |
| `src/components/SettingsModal.tsx`          | Self-register `'settings'` while mounted.                                                                                                           | Modify |
| `src/components/DownloadsModal.tsx`         | Self-register `'downloads'` while mounted.                                                                                                          | Modify |
| `src/components/FavoritesManager.tsx`       | Self-register `'favoritesManager'` while mounted.                                                                                                   | Modify |
| `src/components/PermissionPromptDialog.tsx` | Self-register `'permissionPrompt'` while mounted.                                                                                                   | Modify |
| `src/components/ErrorOverlay.tsx`           | Self-register `'errorOverlay'` while `failed                                                                                                        |        | crashed`. | Modify |
| `src/components/SafetyInterstitial.tsx`     | Self-register `'safetyInterstitial'` while interstitial present.                                                                                    | Modify |
| `src/components/ConfirmDialog.tsx`          | Self-register `'confirmDialog'` while open.                                                                                                         | Modify |
| `src/autopilot/compositor.test.tsx`         | Drift guard: every overlay opened via the autopilot control lowers the content (`setLayout overlay:true`).                                          | Create |
| `src-tauri/src/view.rs`                     | Extract `content_visible(&Layout) -> bool`; replace the 3 duplicated predicates; add a unit-test module.                                            | Modify |
| `src/CLAUDE.md`                             | Document the compositor + the registration rule (replaces the "add it to the union in App.tsx" instruction).                                        | Modify |

**Surfaces covered by the registry** (exactly today's `fullOverlayActive` members — full-window, content-hiding): `settings`, `downloads`, `favoritesManager`, `permissionPrompt`, `errorOverlay`, `crashOverlay`/`errorOverlay` (same component), `confirmDialog`, `safetyInterstitial`. **NOT** in the registry (unchanged, stay as direct `App` state because they do not hide content): the **sidebar** (insets) and the **shield popover** (a dropdown that rides the chrome but leaves content visible).

---

### Task 1: Single-source the Rust visibility predicate

**Files:**

- Modify: `src-tauri/src/view.rs` (lines 71-81, 110-123, 152-161)
- Test: `src-tauri/src/view.rs` (new `#[cfg(test)] mod tests`)

**Interfaces:**

- Produces: `pub fn content_visible(lay: &Layout) -> bool` — the ONE definition of "is the content webview shown", consumed by `apply_visibility` and both branches of `apply_inset`.

- [ ] **Step 1: Write the failing test**

Append to `src-tauri/src/view.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::{content_visible, Layout};

    fn lay(overlay: bool, sidebar: bool, fullscreen: bool) -> Layout {
        Layout { left: 0.0, top: 0.0, right: 0.0, fullscreen, overlay, sidebar }
    }

    #[test]
    fn content_visible_truth_table() {
        // Nothing open → content shown.
        assert!(content_visible(&lay(false, false, false)));
        // A full overlay hides the content.
        assert!(!content_visible(&lay(true, false, false)));
        // The sidebar insets (does NOT hide) — content stays shown even though
        // overlay rides true while the sidebar is open.
        assert!(content_visible(&lay(true, true, false)));
        // Fullscreen always shows content, even if an overlay flag lingers.
        assert!(content_visible(&lay(true, false, true)));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml content_visible_truth_table`
Expected: FAIL — `cannot find function content_visible in this scope`.

- [ ] **Step 3: Add the single-source function**

In `src-tauri/src/view.rs`, after the `layout_of` function (around line 66), add:

```rust
/// The ONE definition of whether the content webview is shown for a given layout:
/// shown in fullscreen, shown when the sidebar insets it (page stays visible beside
/// the panel), and shown whenever no full-window overlay is covering it. A full
/// overlay (settings/downloads/dialogs/…) is the only thing that hides it.
pub fn content_visible(lay: &Layout) -> bool {
    lay.fullscreen || lay.sidebar || !lay.overlay
}
```

- [ ] **Step 4: Replace the three duplicated predicates**

In `apply_visibility` (was line 72), replace:

```rust
    let visible = lay.fullscreen || lay.sidebar || !lay.overlay;
```

with:

```rust
    let visible = content_visible(&lay);
```

In `apply_inset`, the Linux branch (was line 112), replace:

```rust
        let content_visible = lay.fullscreen || lay.sidebar || !lay.overlay;
        crate::linux_layout::layout(
            app,
            left as i32,
            top as i32,
            right as i32,
            logical.width as i32,
            logical.height as i32,
            lay.fullscreen,
            content_visible,
        );
```

with (rename the shadowing local to avoid colliding with the new fn name):

```rust
        let visible = content_visible(&lay);
        crate::linux_layout::layout(
            app,
            left as i32,
            top as i32,
            right as i32,
            logical.width as i32,
            logical.height as i32,
            lay.fullscreen,
            visible,
        );
```

In `apply_inset`, the Windows/macOS tab loop (was line 155), replace:

```rust
        let active_visible = lay.fullscreen || lay.sidebar || !lay.overlay;
```

with:

```rust
        let active_visible = content_visible(&lay);
```

- [ ] **Step 5: Run test to verify it passes + nothing else broke**

Run: `cargo test --manifest-path src-tauri/Cargo.toml content_visible_truth_table`
Expected: PASS.
Run: `cargo build --manifest-path src-tauri/Cargo.toml`
Expected: builds clean (no `unused`/shadow warnings from the rename).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/view.rs
git commit -m "refactor(view): single-source content_visible predicate (was duplicated 3x)"
```

---

### Task 2: Pure `computeContentLayout` on the renderer

**Files:**

- Create: `src/lib/contentLayout.ts`
- Test: `src/lib/contentLayout.test.ts`

**Interfaces:**

- Produces:
  - `interface ContentLayoutState { fullOverlay: boolean; sidebar: boolean; shield: boolean; sidebarWidth: number }`
  - `interface ContentLayout { overlay: boolean; sidebar: boolean; width: number }`
  - `function computeContentLayout(s: ContentLayoutState): ContentLayout` — the exact extraction of `App.tsx:175-178`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/contentLayout.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeContentLayout } from './contentLayout';

describe('computeContentLayout', () => {
  it('nothing open → content shown, no inset', () => {
    expect(
      computeContentLayout({
        fullOverlay: false,
        sidebar: false,
        shield: false,
        sidebarWidth: 280,
      }),
    ).toEqual({ overlay: false, sidebar: false, width: 280 });
  });

  it('a full overlay rides the chrome over the content', () => {
    expect(
      computeContentLayout({ fullOverlay: true, sidebar: false, shield: false, sidebarWidth: 280 }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });

  it('the sidebar insets the content (overlay rides true, sidebar inset true)', () => {
    expect(
      computeContentLayout({ fullOverlay: false, sidebar: true, shield: false, sidebarWidth: 300 }),
    ).toEqual({ overlay: true, sidebar: true, width: 300 });
  });

  it('the shield popover rides the chrome but does NOT inset', () => {
    expect(
      computeContentLayout({ fullOverlay: false, sidebar: false, shield: true, sidebarWidth: 280 }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });

  it('a full overlay suppresses the sidebar inset (overlay wins)', () => {
    expect(
      computeContentLayout({ fullOverlay: true, sidebar: true, shield: false, sidebarWidth: 280 }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/contentLayout.test.ts`
Expected: FAIL — cannot resolve `./contentLayout`.

- [ ] **Step 3: Write the pure function**

Create `src/lib/contentLayout.ts`:

```ts
// The single renderer-side derivation of the content webview's layout from the set of
// open chrome surfaces. Extracted verbatim from the old inline logic in App.tsx so the
// emitted view.setLayout payload is byte-identical to before this refactor.
//
// The Tauri content webview is opaque and on top, so:
//  - `overlay` = bring the chrome over the content (any full-window surface, OR the
//    sidebar/shield which also ride the chrome).
//  - `sidebar` = inset the content from the right so the page stays visible beside the
//    panel — but ONLY when no full overlay is covering it (a full overlay wins).
export interface ContentLayoutState {
  /** Any full-window, content-hiding surface is open (settings, downloads, dialogs, …). */
  fullOverlay: boolean;
  /** The right-hand sidebar panel is open (insets, does not hide). */
  sidebar: boolean;
  /** The ad-block shield popover is open (rides the chrome, does not inset). */
  shield: boolean;
  /** Current user-resized sidebar width, forwarded so the inset matches exactly. */
  sidebarWidth: number;
}

export interface ContentLayout {
  overlay: boolean;
  sidebar: boolean;
  width: number;
}

export function computeContentLayout(s: ContentLayoutState): ContentLayout {
  return {
    overlay: s.fullOverlay || s.sidebar || s.shield,
    sidebar: s.sidebar && !s.fullOverlay,
    width: s.sidebarWidth,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/contentLayout.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/contentLayout.ts src/lib/contentLayout.test.ts
git commit -m "refactor(chrome): extract pure computeContentLayout (mirrors App.tsx inline logic)"
```

---

### Task 3: Auto-registering chrome-surface registry

**Files:**

- Create: `src/hooks/useChromeSurfaces.tsx`
- Test: `src/hooks/useChromeSurfaces.test.tsx`

**Interfaces:**

- Produces:
  - `function ChromeSurfaceProvider({ children }: { children: ReactNode }): JSX.Element`
  - `function useChromeSurfaceRegistry(): { register(id: string): void; unregister(id: string): void; openSurfaces: ReadonlySet<string> }`
  - `function useChromeSurface(id: string, active: boolean): void` — registers `id` while `active`, unregisters on cleanup.

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useChromeSurfaces.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import {
  ChromeSurfaceProvider,
  useChromeSurface,
  useChromeSurfaceRegistry,
} from './useChromeSurfaces';

function CountProbe() {
  const { openSurfaces } = useChromeSurfaceRegistry();
  return <span data-testid="count">{openSurfaces.size}</span>;
}

function Surface({ id, active }: { id: string; active: boolean }) {
  useChromeSurface(id, active);
  return null;
}

function wrap(ui: ReactNode) {
  return render(<ChromeSurfaceProvider>{ui}</ChromeSurfaceProvider>);
}

describe('chrome surface registry', () => {
  it('registers an active surface and unregisters when it goes inactive', () => {
    const { rerender } = wrap(
      <>
        <CountProbe />
        <Surface id="settings" active={true} />
      </>,
    );
    expect(screen.getByTestId('count').textContent).toBe('1');

    act(() => {
      rerender(
        <ChromeSurfaceProvider>
          <CountProbe />
          <Surface id="settings" active={false} />
        </ChromeSurfaceProvider>,
      );
    });
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('counts distinct surfaces and dedupes a repeated id', () => {
    wrap(
      <>
        <CountProbe />
        <Surface id="settings" active={true} />
        <Surface id="downloads" active={true} />
        <Surface id="settings" active={true} />
      </>,
    );
    expect(screen.getByTestId('count').textContent).toBe('2');
  });

  it('a brand-new surface participates with NO change to any central list', () => {
    // The whole point: adding a never-before-seen id just works.
    wrap(
      <>
        <CountProbe />
        <Surface id="some-future-overlay" active={true} />
      </>,
    );
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('useChromeSurfaceRegistry throws outside the provider', () => {
    expect(() => render(<CountProbe />)).toThrow(/ChromeSurfaceProvider/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useChromeSurfaces.test.tsx`
Expected: FAIL — cannot resolve `./useChromeSurfaces`.

- [ ] **Step 3: Implement the registry**

Create `src/hooks/useChromeSurfaces.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';

// Every full-window, content-hiding chrome surface (Settings, Downloads, dialogs,
// error/crash, safety, permission prompt, favorites manager) registers itself here
// while it is open. The compositor derives `fullOverlayActive` from this set, so
// adding a new surface can NEVER forget to lower the content webview: a surface that
// renders is a surface that is mounted, and a mounted surface registers. This replaces
// the hand-maintained `||` union that used to live in App.tsx.

interface SurfaceRegistry {
  register: (id: string) => void;
  unregister: (id: string) => void;
  openSurfaces: ReadonlySet<string>;
}

const Ctx = createContext<SurfaceRegistry | null>(null);

export function ChromeSurfaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [openSurfaces, setOpen] = useState<Set<string>>(() => new Set());

  const register = useCallback((id: string) => {
    setOpen((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const unregister = useCallback((id: string) => {
    setOpen((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo<SurfaceRegistry>(
    () => ({ register, unregister, openSurfaces }),
    [register, unregister, openSurfaces],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChromeSurfaceRegistry(): SurfaceRegistry {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useChromeSurfaceRegistry must be used within a ChromeSurfaceProvider');
  }
  return ctx;
}

/** Register `id` as an open full-window surface while `active` is true; the effect
 *  cleanup unregisters it (on close or unmount). Idempotent per id. */
export function useChromeSurface(id: string, active: boolean): void {
  const { register, unregister } = useChromeSurfaceRegistry();
  useEffect(() => {
    if (!active) return;
    register(id);
    return () => unregister(id);
  }, [id, active, register, unregister]);
}
```

> NOTE for the implementer: the import line above intentionally lists the React hooks
> actually used — `createContext, useContext, useMemo, useState, useCallback, useEffect`.
> Collapse the two import statements into one and drop the stray `useCallback`
> duplicate; lint will flag it. Final import:
> `import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useChromeSurfaces.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useChromeSurfaces.tsx src/hooks/useChromeSurfaces.test.tsx
git commit -m "feat(chrome): auto-registering chrome-surface registry (replaces manual overlay union)"
```

---

### Task 4: Wire `App.tsx` + make every full-window surface self-register

**Files:**

- Modify: `src/App.tsx` (lines 82, 158-179, 563-565)
- Modify: `src/components/SettingsModal.tsx`, `DownloadsModal.tsx`, `FavoritesManager.tsx`, `PermissionPromptDialog.tsx`, `ErrorOverlay.tsx`, `SafetyInterstitial.tsx`, `ConfirmDialog.tsx`

**Interfaces:**

- Consumes: `computeContentLayout` (Task 2); `ChromeSurfaceProvider`, `useChromeSurface`, `useChromeSurfaceRegistry` (Task 3).
- Produces: identical `aegis.view.setLayout` payloads to today's (verified by the unchanged tour).

- [ ] **Step 1: Add registration to each full-window surface component**

In each component below, add the import and one hook call. For components rendered conditionally by `App` (mounted only when open), register unconditionally. For always-mounted components, register on their internal "is visible" condition.

`src/components/SettingsModal.tsx` — add near the top of the component body:

```tsx
import { useChromeSurface } from '../hooks/useChromeSurfaces';
// …inside the component:
useChromeSurface('settings', true);
```

`src/components/DownloadsModal.tsx`:

```tsx
import { useChromeSurface } from '../hooks/useChromeSurfaces';
// …inside the component:
useChromeSurface('downloads', true);
```

`src/components/FavoritesManager.tsx`:

```tsx
import { useChromeSurface } from '../hooks/useChromeSurfaces';
// …inside the component:
useChromeSurface('favoritesManager', true);
```

`src/components/PermissionPromptDialog.tsx` (rendered only when `permissions.prompt` is non-null):

```tsx
import { useChromeSurface } from '../hooks/useChromeSurfaces';
// …inside the component:
useChromeSurface('permissionPrompt', true);
```

`src/components/ErrorOverlay.tsx` (always mounted; visible when `failed` or `crashed` is set — props it already receives):

```tsx
import { useChromeSurface } from '../hooks/useChromeSurfaces';
// …inside the component, using its existing `failed`/`crashed` props:
useChromeSurface('errorOverlay', failed !== null || crashed !== null);
```

`src/components/SafetyInterstitial.tsx` (always mounted; visible when its `interstitial` prop is non-null):

```tsx
import { useChromeSurface } from '../hooks/useChromeSurfaces';
// …inside the component:
useChromeSurface('safetyInterstitial', interstitial !== null);
```

`src/components/ConfirmDialog.tsx` (always mounted; subscribes to its own open state — register on that internal `open` boolean):

```tsx
import { useChromeSurface } from '../hooks/useChromeSurfaces';
// …inside the component, using its existing internal `open` state:
useChromeSurface('confirmDialog', open);
```

- [ ] **Step 2: Wrap `DesktopApp` in the provider**

In `src/App.tsx`, change the bottom `App` export (lines 563-565):

```tsx
export function App() {
  if (isMobile) return <MobileApp />;
  return (
    <ChromeSurfaceProvider>
      <DesktopApp />
    </ChromeSurfaceProvider>
  );
}
```

And add the import at the top (with the other hook imports):

```tsx
import { ChromeSurfaceProvider, useChromeSurfaceRegistry } from './hooks/useChromeSurfaces';
import { computeContentLayout } from './lib/contentLayout';
```

- [ ] **Step 3: Replace the manual union + inline layout math in `DesktopApp`**

In `DesktopApp`, delete the hand-maintained union (old lines 158-166):

```tsx
const fullOverlayActive =
  downloadsOpen ||
  settingsOpen ||
  managerOpen ||
  confirmOpen ||
  permissions.prompt !== null ||
  failed !== null ||
  crashed !== null ||
  safety.interstitial !== null;
```

Replace it with a derivation from the registry:

```tsx
// Derived, never hand-maintained: any registered full-window surface means a full
// overlay is up. New overlays self-register (see useChromeSurface) — there is no
// central list to forget to update.
const { openSurfaces } = useChromeSurfaceRegistry();
const fullOverlayActive = openSurfaces.size > 0;
```

Then replace the layout effect (old lines 167-179) with the pure-function form:

```tsx
useEffect(() => {
  // ONE atomic update from a single derived state. computeContentLayout is the sole
  // place the overlay/sidebar/shield → content-layout mapping lives (mirrored on the
  // Rust side by view::content_visible).
  void aegis.view.setLayout?.(
    tabs.activeId,
    computeContentLayout({
      fullOverlay: fullOverlayActive,
      sidebar: sidebarOpen,
      shield: shieldOpen,
      sidebarWidth,
    }),
  );
}, [tabs.activeId, fullOverlayActive, sidebarOpen, shieldOpen, sidebarWidth]);
```

> The `confirmOpen` local state and its `subscribeConfirmOpen` effect (old lines 108, 145) are now redundant for layout — `ConfirmDialog` self-registers. Leave `confirmOpen`
> ONLY if something else reads it; grep first: `grep -n confirmOpen src/App.tsx`. If the
> sole use was the union, delete the `confirmOpen` state + its `subscribeConfirmOpen`
> effect. (The `ConfirmDialog` component manages its own visibility independently.)

- [ ] **Step 4: Run the existing tour unchanged — it must still pass**

Run: `npx vitest run src/autopilot/tour.test.tsx src/autopilot/interactions.test.tsx`
Expected: PASS, unedited. This is the proof the refactor changed no behavior. If a test fails, the registration set or the derivation is wrong — fix the refactor, not the test.

- [ ] **Step 5: Run the full renderer suite**

Run: `npm test`
Expected: PASS (all jsdom + node projects green).

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/SettingsModal.tsx src/components/DownloadsModal.tsx \
        src/components/FavoritesManager.tsx src/components/PermissionPromptDialog.tsx \
        src/components/ErrorOverlay.tsx src/components/SafetyInterstitial.tsx \
        src/components/ConfirmDialog.tsx
git commit -m "refactor(chrome): derive overlay state from self-registering surfaces (delete manual union)"
```

---

### Task 5: Drift-guard test — every overlay lowers the content

**Files:**

- Create: `src/autopilot/compositor.test.tsx`

**Interfaces:**

- Consumes: the dev autopilot control (`installAutopilotControl` is wired in `DesktopApp`, exposing `window.__aegisAutopilot` with `openSettings`/`openDownloads`/`openManager`/`openConfirm`/`showError`/`showCrash`, etc. — see `src/autopilot/control.ts`), and the mocked `aegis` (the jsdom tests mock the IPC client).

- [ ] **Step 1: Write the failing test**

Create `src/autopilot/compositor.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { App } from '../App';
import { aegis } from '../lib/ipcClient';
import { getAutopilotControl } from './control';

// Drift guard: opening ANY full-window overlay must lower the content webview, i.e.
// call aegis.view.setLayout with overlay:true. A new overlay that forgets to register
// (useChromeSurface) fails here — the structural backstop to the self-registration.

function lastSetLayout(): { overlay: boolean } | undefined {
  const calls = (aegis.view.setLayout as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  const last = calls[calls.length - 1];
  return last?.[1] as { overlay: boolean } | undefined;
}

describe('compositor drift guard: overlays lower the content', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // Each entry: a human label + how the autopilot control opens that overlay.
  const overlays: Array<
    [string, (c: NonNullable<ReturnType<typeof getAutopilotControl>>) => void]
  > = [
    ['settings', (c) => c.openSettings()],
    ['downloads', (c) => c.openDownloads()],
    ['favoritesManager', (c) => c.openManager()],
    ['confirmDialog', (c) => c.openConfirm('are you sure?')],
    [
      'errorOverlay',
      (c) => c.showError({ viewId: 1, url: 'https://x', code: 0, description: 'fail' }),
    ],
    ['crashOverlay', (c) => c.showCrash({ viewId: 1, url: 'https://x' })],
  ];

  it.each(overlays)(
    'opening %s lowers the content (setLayout overlay:true)',
    async (_label, open) => {
      render(<App />);
      // Let DesktopApp mount + register its autopilot control.
      const control = await vi.waitFor(() => {
        const c = getAutopilotControl();
        if (!c) throw new Error('control not installed yet');
        return c;
      });
      act(() => open(control));
      expect(lastSetLayout()?.overlay).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails for the right reason first**

Run: `npx vitest run src/autopilot/compositor.test.tsx`
Expected: With Task 4 complete, this PASSES. To confirm the guard actually guards, temporarily remove `useChromeSurface('downloads', true)` from `DownloadsModal.tsx`, re-run, and observe the `downloads` row FAIL with `overlay` false/undefined. Restore the line. (This is a one-off manual verification of the guard's teeth, not a committed change.)

- [ ] **Step 3: Confirm it passes with all registrations in place**

Run: `npx vitest run src/autopilot/compositor.test.tsx`
Expected: PASS (all rows).

> NOTE: `errorOverlay` and `crashOverlay` both register the id `'errorOverlay'` (one
> component renders both states) — both rows still assert `overlay:true`, which is the
> behavior under test. If the autopilot control's `showError`/`showCrash` payload shape
> differs from the placeholder above, copy the exact `NavFailed`/`NavCrashed` shape from
> `shared/types.ts`; the assertion (`overlay:true`) is unaffected by payload fields.

- [ ] **Step 4: Commit**

```bash
git add src/autopilot/compositor.test.tsx
git commit -m "test(chrome): drift guard — every overlay lowers the content webview"
```

---

### Task 6: Update living docs + run the live autopilot gate

**Files:**

- Modify: `src/CLAUDE.md` (the "Chrome overlay z-order" bullet)

**Interfaces:** none (docs + verification).

- [ ] **Step 1: Replace the stale z-order instruction in `src/CLAUDE.md`**

Find the bullet that currently reads (paraphrased): _"If you add a new full-window overlay, add it to that union in `App.tsx` or it will render behind the page."_ Replace it with:

```markdown
- **Chrome overlay z-order (centralized compositor).** The content webview is opaque
  and on top, so full-window chrome must lower it. The decision is single-sourced:
  every content-hiding surface calls `useChromeSurface('<id>', active)`
  (`src/hooks/useChromeSurfaces.tsx`) to register itself while open; `App.tsx` derives
  `fullOverlayActive` from the registry and computes the content layout via
  `computeContentLayout` (`src/lib/contentLayout.ts`), mirrored on the Rust side by
  `view::content_visible`. **To add a new full-window overlay, call `useChromeSurface`
  in its component — there is no central union to update.** The sidebar (insets) and
  shield popover (dropdown) are NOT registry surfaces; they stay as direct `App` state.
  The `src/autopilot/compositor.test.tsx` drift guard fails the build if an overlay
  reachable via the autopilot control does not lower the content.
```

- [ ] **Step 2: Run the full gate**

Run: `npm test`
Expected: PASS.
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 3: Run the live autopilot (Linux runtime behavior)**

Run: `bash scripts/autopilot/run-autopilot.sh`
Expected: `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`. This proves the refactor preserved real Linux z-order behavior (overlays paint over content; the GtkFixed layout still hides/parks correctly) — the class of bug this plan targets.

- [ ] **Step 4: Commit**

```bash
git add src/CLAUDE.md
git commit -m "docs(chrome): document the centralized content compositor + registration rule"
```

---

## Self-Review

**1. Spec coverage.** The two recurring-bug sources are both addressed: the manual `App.tsx` union → Task 3/4 (auto-registering registry + derived `fullOverlayActive`); the thrice-duplicated Rust predicate → Task 1 (`content_visible`). The "keep the layout identical" requirement → enforced by Task 4 Step 4 (existing tour passes unedited) + Task 6 Step 3 (live autopilot). The "structurally impossible to forget" goal → Task 3 (self-registration) + Task 5 (drift guard). The pure-derivation single-source → Task 2.

**2. Placeholder scan.** No TBD/TODO/"handle edge cases" — every step has concrete code, exact commands, and expected output. The two `NOTE` blocks (Task 3 import cleanup, Task 4 `confirmOpen` grep) are explicit instructions with the exact action, not deferrals.

**3. Type consistency.** `computeContentLayout(ContentLayoutState) → ContentLayout` (Task 2) is consumed in Task 4 with the exact field names `{ fullOverlay, sidebar, shield, sidebarWidth }`. `useChromeSurface(id, active)` / `useChromeSurfaceRegistry().openSurfaces` (Task 3) are consumed in Task 4. `content_visible(&Layout)` (Task 1) — `Layout` is the existing struct in `view.rs`. The registry ids used in Task 4 (`settings`, `downloads`, `favoritesManager`, `permissionPrompt`, `errorOverlay`, `safetyInterstitial`, `confirmDialog`) match the drift-guard rows in Task 5.

---

## Appendix: the road not taken — layer inversion

This plan deliberately keeps the current compositing model (opaque native content webview on top; chrome lowered/parked when an overlay covers it). A more radical alternative — **layer inversion** — was considered and rejected for now:

**What it is:** flip the stack so the **content webview sits at the bottom, full-window, and never moves**, and the **chrome webview floats on top, transparent except where UI is drawn**. Overlays and the sidebar then become ordinary opaque DOM in the always-on-top chrome layer — they render _over_ the content with no native restacking, and the content webview is never resized/parked for an overlay. This would make the "sidebar over content" idea natural and delete the entire reposition-the-native-webview bug class at its root.

**What it would entail:**

- A transparent, full-window chrome webview kept above the content webview on every platform (WebView2 / WKWebView / WebKitGTK transparency each behave differently).
- **The hard part — input pass-through:** where the chrome is transparent, mouse/keyboard must reach the content behind it; where the toolbar/sidebar/overlay are drawn, the chrome must capture them. There is no clean cross-platform primitive for per-region hit-testing between two overlapping child webviews. It would require dynamically toggling cursor-event ignoring based on pointer position (e.g. wry's `set_ignore_cursor_events`), which is janky and platform-divergent — trading the z-order problem for an equally platform-specific click-through problem.
- Rework of `view.rs`/`linux_layout.rs` from "move/park the content for overlays" to "content fixed; toggle chrome transparency + input regions."

**Why it's deferred:** it's a research spike, not a refactor — uncertain payoff, new platform-divergent risk, and it touches the same native code this plan stabilizes. Do the centralized compositor first (low-risk, keeps layout identical, kills the _recurring_ nature of the bugs). Only pursue layer inversion if, after this, you still want the content to never move for a sidebar/overlay — and budget it as a spike with a Linux + Windows + macOS input-pass-through proof before committing.
