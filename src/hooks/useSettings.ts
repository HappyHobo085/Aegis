// src/hooks/useSettings.ts
import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { applyTheme } from '../lib/theme';
import { onSyncChange } from '../lib/syncBus';

const emptySettings: Settings = {
  homeUrl: '',
  primaryColor: '#3b82f6',
  defaultSearchTemplate: '',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
  httpsOnly: true,
  tabIdleTimeout: 30,
  webrtcPolicy: 'public-only',
  themeMode: 'system',
  syncServerUrl: '',
};

export function useSettings(): {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
} {
  const [settings, setSettings] = useState<Settings>(emptySettings);

  useEffect(() => {
    let active = true;
    // Mount: just load (the initial accent theme is applied once by App/MobileApp).
    void aegis.settings.get().then((s) => {
      if (active) setSettings(s);
    });
    // On a SYNC-merged settings change, refetch AND re-apply the accent theme live
    // (idempotent) so a synced primaryColor recolors the chrome without a reload.
    const off = onSyncChange('settings', () => {
      void aegis.settings.get().then((s) => {
        if (!active) return;
        setSettings(s);
        applyTheme({ primaryColor: s.primaryColor });
      });
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  const update = useCallback(async (partial: Partial<Settings>): Promise<void> => {
    const next = await aegis.settings.set(partial);
    setSettings(next);
    // Theme re-applies live only when the accent color was part of this edit.
    if (partial.primaryColor !== undefined) {
      applyTheme({ primaryColor: next.primaryColor });
    }
  }, []);

  return { settings, update };
}
