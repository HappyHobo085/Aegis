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
