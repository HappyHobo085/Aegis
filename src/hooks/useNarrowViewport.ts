// src/hooks/useNarrowViewport.ts
import { useEffect, useState } from 'react';

/** Width below which the desktop chrome switches to its compact (touch-adapted)
 *  layout: secondary toolbar actions fold into an overflow menu so the address bar
 *  keeps a usable width. The app's minimum window is 420px, so this triggers well
 *  before then. */
export const NARROW_BREAKPOINT_PX = 680;

/**
 * Reactively reports whether the desktop window is narrow enough to need the
 * compact toolbar, and mirrors the result onto `<html class="aegis-narrow">` so CSS
 * can adapt too. This is the responsive fallback the desktop shell uses INSTEAD of
 * swapping to the Android `MobileApp` shell — that shell is wired to the Android
 * native content WebView bridge and cannot drive the desktop Tauri content webview,
 * so rendering it on desktop would break browsing. Adapting the desktop layout in
 * place keeps the working content model.
 */
export function useNarrowViewport(): boolean {
  const query = `(max-width: ${NARROW_BREAKPOINT_PX}px)`;
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent | MediaQueryList): void => setNarrow(e.matches);
    onChange(mql);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  useEffect(() => {
    const root = document.documentElement;
    // Never apply the desktop-compact class in the Android shell (it has its own layout).
    if (root.classList.contains('aegis-mobile')) return;
    root.classList.toggle('aegis-narrow', narrow);
    return () => root.classList.remove('aegis-narrow');
  }, [narrow]);

  return narrow;
}
