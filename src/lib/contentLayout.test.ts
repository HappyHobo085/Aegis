import { describe, it, expect } from 'vitest';
import { computeContentLayout } from './contentLayout';

describe('computeContentLayout', () => {
  it('nothing open → content shown, no inset', () => {
    expect(
      computeContentLayout({
        fullOverlay: false,
        sidebar: false,
        sidebarWidth: 280,
      }),
    ).toEqual({ overlay: false, sidebar: false, width: 280 });
  });

  it('a full overlay rides the chrome over the content', () => {
    expect(
      computeContentLayout({
        fullOverlay: true,
        sidebar: false,
        sidebarWidth: 280,
      }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });

  it('the sidebar insets the content (overlay rides true, sidebar inset true)', () => {
    expect(
      computeContentLayout({
        fullOverlay: false,
        sidebar: true,
        sidebarWidth: 300,
      }),
    ).toEqual({ overlay: true, sidebar: true, width: 300 });
  });

  it('a full overlay suppresses the sidebar inset (overlay wins)', () => {
    expect(
      computeContentLayout({
        fullOverlay: true,
        sidebar: true,
        sidebarWidth: 280,
      }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });

  // Chrome popovers (omnibox, site info, shield, zoom) are NOT part of this
  // derivation any more: they inset the content top by their own measured height
  // (useChromePopover) so the page stays visible behind them, instead of riding a
  // boolean that blanks the whole content webview.
  it('knows nothing about popovers — only fullOverlay and sidebar reach the content layout', () => {
    expect(
      Object.keys(
        computeContentLayout({
          fullOverlay: false,
          sidebar: false,
          sidebarWidth: 320,
        }),
      ).sort(),
    ).toEqual(['overlay', 'sidebar', 'width']);
  });
});
