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
/** TABSTRIP_H — the top tab strip height (desktop only). */
export const TABSTRIP_H = 36;
export const SIDEBAR_W = 280;
/**
 * REDIRECT_BAR_H — the redirect-blocked notification bar height. When a scripted
 * cross-origin top-frame redirect is cancelled, this bar shows below the favbar and is
 * ADDED to the content inset so it sits in the chrome's always-visible strip (a floating
 * toast can't paint over the opaque content webview). Desktop for now.
 */
export const REDIRECT_BAR_H = 40;
/**
 * FIND_BAR_H — the find-in-page infobar height. While a find session is active this bar
 * shows below the favbar (or redirect bar) and is ADDED to the content inset so it sits
 * in the chrome's always-visible strip. Desktop only; same stripe as REDIRECT_BAR_H.
 */
export const FIND_BAR_H = 40;

/**
 * Mobile (Android) chrome heights in logical px. These MUST stay in sync with the
 * content-WebView margins in MainActivity.kt (the renderer chrome and the native
 * margins have to agree — the same convention the desktop 96px ↔ 96dp uses):
 *   topMargin    = MOBILE_ADDRESS_H + MOBILE_FAV_H  (slim address bar + favourites)
 *   bottomMargin = MOBILE_BOTTOMBAR_H                (the auto-hiding action bar)
 */
export const MOBILE_ADDRESS_H = 48;
// 36px so the favourites chips clear the ~36px touch-target floor (was 24px, chips
// were only 22px tall — too small to tap reliably). Kept in sync with MainActivity.kt.
export const MOBILE_FAV_H = 36;
export const MOBILE_BOTTOMBAR_H = 56;
