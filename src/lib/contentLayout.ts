// The single renderer-side derivation of the content webview's layout from the set of
// open chrome surfaces. Extracted verbatim from the old inline logic in App.tsx so the
// emitted view.setLayout payload is byte-identical to before this refactor.
//
// The Tauri content webview is opaque and on top, so:
//  - `overlay` = bring the chrome over the content (any full-window surface, OR the
//    sidebar/shield which also ride the chrome).
//  - `sidebar` = inset the content from the right so the page stays visible beside the
//    panel — but ONLY when no full overlay is covering it (a full overlay wins).
import type { SplitLayout } from '../../shared/types';

export interface ContentLayoutState {
  /** Any full-window, content-hiding surface is open (settings, downloads, dialogs, ...). */
  fullOverlay: boolean;
  /** The right-hand sidebar panel is open (insets, does not hide). */
  sidebar: boolean;
  /** The ad-block shield popover is open (rides the chrome, does not inset). */
  shield: boolean;
  /** The zoom indicator popover is open (rides the chrome, does not inset). */
  zoom: boolean;
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
    overlay: s.fullOverlay || s.sidebar || s.shield || s.zoom,
    sidebar: s.sidebar && !s.fullOverlay,
    width: s.sidebarWidth,
  };
}

// --- Split-view layout ---------------------------------------------------

/** Pixel rectangle for a single split pane. */
export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Matches `SplitPane.tabId` so the caller can map each pane to its tab. */
  paneId: number;
}

/** Pixel rectangle for a resize handle between two adjacent panes. */
export interface HandleRect {
  x: number;
  y: number;
  width: number;
  height: number;
  orientation: 'vertical' | 'horizontal';
  /** The tab ids of the two panes this handle separates. */
  leftPaneId: number;
  rightPaneId: number;
}

const HANDLE_THICKNESS = 6;
const MIN_PANE_SIZE = 200;

/**
 * Map the fractional split-layout coordinates to actual pixel positions inside
 * the given `contentArea`. The Rust side stores `x`, `y`, `width`, `height`
 * as fractions (0.0 -- 1.0) relative to the available content area.
 */
export function computeSplitLayout(
  splitLayout: SplitLayout,
  contentArea: { x: number; y: number; width: number; height: number },
): { panes: PaneRect[]; handles: HandleRect[] } {
  const panes: PaneRect[] = splitLayout.panes.map((pane) => ({
    x: contentArea.x + pane.x * contentArea.width,
    y: contentArea.y + pane.y * contentArea.height,
    width: Math.round(pane.width * contentArea.width),
    height: Math.round(pane.height * contentArea.height),
    paneId: pane.tabId,
  }));

  // Place handles between adjacent panes that share the same axis.
  const handles: HandleRect[] = [];

  for (let i = 0; i < panes.length; i++) {
    for (let j = i + 1; j < panes.length; j++) {
      const a = panes[i];
      const b = panes[j];

      // Horizontal adjacency (side-by-side): same y origin and height
      if (
        Math.abs(a.y - b.y) < 1 &&
        Math.abs(a.height - b.height) < 1 &&
        Math.abs(a.x + a.width - b.x) < 1
      ) {
        // Vertical handle between them at the shared edge
        const handleX = a.x + a.width - HANDLE_THICKNESS / 2;
        handles.push({
          x: handleX,
          y: a.y,
          width: HANDLE_THICKNESS,
          height: a.height,
          orientation: 'vertical',
          leftPaneId: a.paneId,
          rightPaneId: b.paneId,
        });
      }
      // Vertical adjacency (stacked): same x origin and width
      else if (
        Math.abs(a.x - b.x) < 1 &&
        Math.abs(a.width - b.width) < 1 &&
        Math.abs(a.y + a.height - b.y) < 1
      ) {
        // Horizontal handle between them at the shared edge
        const handleY = a.y + a.height - HANDLE_THICKNESS / 2;
        handles.push({
          x: a.x,
          y: handleY,
          width: a.width,
          height: HANDLE_THICKNESS,
          orientation: 'horizontal',
          leftPaneId: a.paneId,
          rightPaneId: b.paneId,
        });
      }
    }
  }

  return { panes, handles };
}

/**
 * Enforce minimum and maximum pane sizes on a resize delta, returning the
 * clamped delta that should actually be applied.
 */
export function clampResizeDelta(
  delta: number,
  orientation: 'vertical' | 'horizontal',
  paneRects: PaneRect[],
  leftPaneId: number,
  rightPaneId: number,
  contentSize: number,
): number {
  const leftPane = paneRects.find((p) => p.paneId === leftPaneId);
  const rightPane = paneRects.find((p) => p.paneId === rightPaneId);
  if (!leftPane || !rightPane) return 0;

  const maxSize = Math.floor(contentSize * 0.8);
  const min = MIN_PANE_SIZE;
  const max = maxSize;

  if (orientation === 'vertical') {
    let clamped = delta;
    if (leftPane.width + delta < min) clamped = min - leftPane.width;
    if (rightPane.width - delta < min) clamped = leftPane.width - (rightPane.width - min);
    if (leftPane.width + delta > max) clamped = max - leftPane.width;
    if (rightPane.width - delta > max) clamped = leftPane.width - (rightPane.width - max);
    return clamped;
  }
  // Horizontal: same logic on height
  let clamped = delta;
  if (leftPane.height + delta < min) clamped = min - leftPane.height;
  if (rightPane.height - delta < min) clamped = leftPane.height - (rightPane.height - min);
  if (leftPane.height + delta > max) clamped = max - leftPane.height;
  if (rightPane.height - delta > max) clamped = leftPane.height - (rightPane.height - max);
  return clamped;
}
