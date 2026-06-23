import { describe, it, expect } from 'vitest';
import { computeContentLayout } from './contentLayout';

describe('computeContentLayout', () => {
  it('nothing open → content shown, no inset', () => {
    expect(
      computeContentLayout({
        fullOverlay: false,
        sidebar: false,
        shield: false,
        sidebarWidth: 280,
      }),
    ).toEqual({ overlay: false, sidebar: false, width: 280 });
  });

  it('a full overlay rides the chrome over the content', () => {
    expect(
      computeContentLayout({ fullOverlay: true, sidebar: false, shield: false, sidebarWidth: 280 }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });

  it('the sidebar insets the content (overlay rides true, sidebar inset true)', () => {
    expect(
      computeContentLayout({ fullOverlay: false, sidebar: true, shield: false, sidebarWidth: 300 }),
    ).toEqual({ overlay: true, sidebar: true, width: 300 });
  });

  it('the shield popover rides the chrome but does NOT inset', () => {
    expect(
      computeContentLayout({ fullOverlay: false, sidebar: false, shield: true, sidebarWidth: 280 }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });

  it('a full overlay suppresses the sidebar inset (overlay wins)', () => {
    expect(
      computeContentLayout({ fullOverlay: true, sidebar: true, shield: false, sidebarWidth: 280 }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });
});
