import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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

/** Returns the registry, or throws if used outside a `ChromeSurfaceProvider`.
 *  The compositor in `DesktopApp` uses this; it always runs inside the provider. */
export function useChromeSurfaceRegistry(): SurfaceRegistry {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useChromeSurfaceRegistry must be used within a ChromeSurfaceProvider');
  }
  return ctx;
}

// A stable no-op registry for components rendered outside the provider (unit tests,
// Storybook, mobile shell). The functions are module-level constants so their
// referential identity never changes — safe to pass to useEffect deps.
const noopRegister = (_id: string): void => {};
const noopUnregister = (_id: string): void => {};
const EMPTY_SET: ReadonlySet<string> = new Set();
const NOOP_REGISTRY: SurfaceRegistry = {
  register: noopRegister,
  unregister: noopUnregister,
  openSurfaces: EMPTY_SET,
};

/** Register `id` as an open full-window surface while `active` is true; the effect
 *  cleanup unregisters it (on close or unmount). Idempotent per id.
 *  When called outside a `ChromeSurfaceProvider` (unit tests, mobile shell), this
 *  is a safe no-op — it does not throw. */
export function useChromeSurface(id: string, active: boolean): void {
  const ctx = useContext(Ctx);
  const { register, unregister } = ctx ?? NOOP_REGISTRY;
  useEffect(() => {
    if (!active) return;
    register(id);
    return () => unregister(id);
  }, [id, active, register, unregister]);
}
