import { describe, it, expect } from 'vitest';
import { TAB_ORDER } from '../components/SettingsModal';
import { SCREENS } from './screens';

describe('SCREENS', () => {
  it('has a settings screen for every Settings tab', () => {
    const ids = new Set(SCREENS.map((s) => s.id));
    for (const tab of TAB_ORDER) expect(ids.has(`settings:${tab}`)).toBe(true);
  });
  it('covers both sidebar tabs and the core overlays', () => {
    const ids = new Set(SCREENS.map((s) => s.id));
    for (const id of [
      'sidebar:history',
      'sidebar:saved',
      'downloads',
      'favoritesManager',
      'shieldPopover',
      'fullscreen',
      'errorOverlay',
      'crashOverlay',
      'safetyInterstitial',
      'permissionPrompt',
      'redirectBar',
      'confirmDialog',
      'home',
    ] as const)
      expect(ids.has(id)).toBe(true);
  });
  it('has unique ids', () => {
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(SCREENS.length);
  });
});
