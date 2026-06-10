/**
 * Chrome layout constants shared between the renderer (which computes the
 * content inset) and the CSS. Kept in one place so the renderer can report a
 * deterministic inset to main WITHOUT measuring the DOM (§2 of the contract).
 *
 *   TOOLBAR_H  — the top toolbar band height (=== CHROME_TOP_HEIGHT in main).
 *   FAVBAR_H   — the always-on favorites bar height.
 *   SIDEBAR_W  — the inset sidebar width when open.
 */
export const TOOLBAR_H = 56;
export const FAVBAR_H = 40;
export const SIDEBAR_W = 280;
