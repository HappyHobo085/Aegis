// src/hooks/useChromeHeights.ts
import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { TOOLBAR_H, FAVBAR_H, TABSTRIP_H, WORKSPACE_BAR_H, FIND_BAR_H } from '../lib/layout';

/**
 * CSS selectors for each chrome element, keyed by a stable short name.
 * Used to measure the element's height once on mount.
 */
const SELECTORS = {
  tabstrip: '.tabstrip',
  toolbar: '.toolbar',
  favbar: '.favorites-bar',
  findbar: '.find-bar',
  workspacebar: '.workspace-switcher',
} as const;

type ChromeKey = keyof typeof SELECTORS;

/** Fallback heights when the element is not in the DOM or not yet measured. */
const FALLBACKS: Record<ChromeKey, number> = {
  tabstrip: TABSTRIP_H,
  toolbar: TOOLBAR_H,
  favbar: FAVBAR_H,
  findbar: FIND_BAR_H,
  workspacebar: WORKSPACE_BAR_H,
};

/** Public return type — camelCase names with H-suffix for individual heights. */
export interface ChromeHeights {
  tabStripH: number;
  toolbarH: number;
  favBarH: number;
  findBarH: number;
  workspaceBarH: number;
  topInset: number;
}

/** Map internal lowercase key to public camelCase key. */
const KEY_MAP: Record<ChromeKey, keyof ChromeHeights> = {
  tabstrip: 'tabStripH',
  toolbar: 'toolbarH',
  favbar: 'favBarH',
  findbar: 'findBarH',
  workspacebar: 'workspaceBarH',
};

/** Initial (fallback) values in the public shape. */
const INITIAL: ChromeHeights = {
  tabStripH: FALLBACKS.tabstrip,
  toolbarH: FALLBACKS.toolbar,
  favBarH: FALLBACKS.favbar,
  findBarH: FALLBACKS.findbar,
  workspaceBarH: FALLBACKS.workspacebar,
  topInset: TABSTRIP_H + TOOLBAR_H + FAVBAR_H + WORKSPACE_BAR_H + FIND_BAR_H,
};

/**
 * Measure actual chrome element heights from the DOM **once** on mount via
 * `getBoundingClientRect`, falling back to the `layout.ts` constants when an
 * element is absent (FindBar closed, WorkspaceSwitcher hidden) or unmeasured.
 *
 * Chrome element heights are fixed by CSS — they never change at runtime.
 * Only element *presence* changes (FindBar appears/disappears, WorkspaceSwitcher
 * appears/disappears). Absent elements return 0 (they take no space); present
 * elements return their measured height (or the constant if measurement fails).
 *
 * No ResizeObserver or MutationObserver — those create feedback loops with
 * React re-renders and `setContentInset`.
 */
export function useChromeHeights(containerRef: RefObject<HTMLElement | null>): ChromeHeights {
  const [heights, setHeights] = useState<ChromeHeights>(INITIAL);
  const measured = useRef(false);

  useLayoutEffect(() => {
    if (measured.current) return;
    const container = containerRef.current;
    if (!container) return;

    const keys = Object.keys(SELECTORS) as ChromeKey[];
    const next: ChromeHeights = { ...INITIAL };

    for (const key of keys) {
      const el = container.querySelector<HTMLElement>(SELECTORS[key]);
      const h = el ? el.getBoundingClientRect().height : 0;
      const rounded = Math.round(h);
      // Use the measured value only if it's > 0 (element present and laid out).
      // Otherwise fall back to the constant (element present but not yet painted)
      // or 0 (element absent from DOM).
      const value = rounded > 0 ? rounded : el ? FALLBACKS[key] : 0;
      (next as Record<keyof ChromeHeights, number>)[KEY_MAP[key]] = value;
    }

    next.topInset =
      next.toolbarH + next.favBarH + next.tabStripH + next.workspaceBarH + next.findBarH;

    measured.current = true;
    setHeights(next);
  }, [containerRef]);

  return heights;
}
