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
