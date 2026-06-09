// electron/main/ipc/settings.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { Settings } from '../../../shared/types';
import { buildSettingsHandlers } from './settings';

function makeRepo() {
  const current = {
    siteName: 'Aegis',
    homeUrl: 'https://duckduckgo.com/',
    primaryColor: '#7c5cff',
    defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
    searchEngines: [],
    hideChromeByDefault: false,
  } as Settings;
  return {
    get: vi.fn((): Settings => current),
    set: vi.fn((partial: Partial<Settings>): Settings => ({ ...current, ...partial })),
  };
}

describe('buildSettingsHandlers', () => {
  it('settingsGet returns repo.get()', () => {
    const repo = makeRepo();
    const handlers = buildSettingsHandlers(repo as any);
    const result = handlers[IPC.settingsGet]();
    expect(repo.get).toHaveBeenCalledTimes(1);
    expect(result.siteName).toBe('Aegis');
  });

  it('settingsSet forwards the partial to repo.set() and returns the merged result', () => {
    const repo = makeRepo();
    const handlers = buildSettingsHandlers(repo as any);
    const result = handlers[IPC.settingsSet]({ siteName: 'Renamed' });
    expect(repo.set).toHaveBeenCalledWith({ siteName: 'Renamed' });
    expect(result.siteName).toBe('Renamed');
    expect(result.homeUrl).toBe('https://duckduckgo.com/');
  });
});
