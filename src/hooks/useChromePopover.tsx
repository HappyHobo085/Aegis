// src/hooks/useChromePopover.tsx
//
// Registry of chrome-anchored POPOVERS (address-bar suggestions, site info,
// ad-block shield, zoom) and the content-top inset they need.
//
// Why this exists: the content webview is opaque and stacked ON TOP of the
// chrome webview (which itself fills the window behind the content). So a popover
// drawn in the chrome is only visible if the content view gets out of the way.
// `useChromeSurfaces` solves that for full-window overlays by HIDING the content;
// a popover must not (the page should stay visible behind it, like a real
// browser), so the compositor needs a NUMBER, not a boolean — and that number is
// only knowable after the popover has been laid out.
//
// Hence: every popover measures itself (see useMeasuredHeight) and registers its
// height here. A new popover that forgets to register renders behind the content,
// which is exactly the bug the site-information popover shipped with — the
// `||` union in App.tsx that this registry replaces never covered it.
//
// Desktop only: the Android shell is a single webview, and its native content
// view is lowered through `view.setChromeOverlay` instead (see MobileApp).

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

interface ChromePopoverRegistry {
  register(id: string, height: number): void;
  unregister(id: string): void;
  /** The tallest open popover's height: the extra content-top inset to reserve. */
  inset: number;
}

const Ctx = createContext<ChromePopoverRegistry | null>(null);

/** Reduce the registered heights to the inset the content top must clear. */
function tallest(heights: ReadonlyMap<string, number>): number {
  let max = 0;
  for (const height of heights.values()) if (height > max) max = height;
  return max;
}

export function ChromePopoverProvider({ children }: { children: ReactNode }): ReactElement {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());

  const register = useCallback((id: string, height: number) => {
    setHeights((prev) => {
      if (height <= 0) {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }
      if (prev.get(id) === height) return prev;
      const next = new Map(prev);
      next.set(id, height);
      return next;
    });
  }, []);

  const unregister = useCallback((id: string) => {
    setHeights((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const value = useMemo<ChromePopoverRegistry>(
    () => ({ register, unregister, inset: tallest(heights) }),
    [register, unregister, heights],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The registry, or throws if used outside a `ChromePopoverProvider`. The
 *  compositor in `DesktopApp` uses this; it always runs inside the provider. */
export function useChromePopoverRegistry(): ChromePopoverRegistry {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useChromePopoverRegistry must be used within a ChromePopoverProvider');
  }
  return ctx;
}

// A stable no-op registry for components rendered outside the provider (unit
// tests, the mobile shell). Module-level constants, so identity never changes.
const noopRegister = (_id: string, _height: number): void => {};
const noopUnregister = (_id: string): void => {};
const NOOP_REGISTRY: ChromePopoverRegistry = {
  register: noopRegister,
  unregister: noopUnregister,
  inset: 0,
};

/**
 * Reserve `height` pixels of content-top inset for the popover `id` while it is
 * measured (> 0) and release it otherwise. Outside a provider this is a no-op.
 */
export function useChromePopoverInset(id: string, height: number): void {
  const ctx = useContext(Ctx);
  const { register, unregister } = ctx ?? NOOP_REGISTRY;
  useEffect(() => {
    register(id, height);
    return () => unregister(id);
  }, [register, unregister, id, height]);
}
