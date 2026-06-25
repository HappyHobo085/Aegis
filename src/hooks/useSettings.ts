// src/hooks/useSettings.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { applyTheme, watchSystemTheme } from '../lib/theme';
import { onSyncChange } from '../lib/syncBus';
import { publishSettings } from '../lib/settingsBus';

const emptySettings: Settings = {
  homeUrl: '',
  primaryColor: '#2563eb',
  defaultSearchTemplate: '',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
  httpsOnly: true,
  tabIdleTimeout: 30,
  webrtcPolicy: 'public-only',
  themeMode: 'system',
  syncServerUrl: '',
  antiFingerprint: 'off',
};

export function useSettings(): {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
} {
  const [settings, setSettings] = useState<Settings>(emptySettings);
  // Keep a ref so the OS-preference change handler can read the latest settings
  // without being re-subscribed on every render.
  const settingsRef = useRef<Settings>(emptySettings);

  useEffect(() => {
    let active = true;
    // Mount: just load (the initial accent theme is applied once by App/MobileApp).
    void aegis.settings.get().then((s) => {
      if (active) {
        setSettings(s);
        settingsRef.current = s;
      }
    });
    // On a SYNC-merged settings change, refetch AND re-apply the full theme live
    // so a synced primaryColor OR themeMode recolors the chrome without a reload.
    const off = onSyncChange('settings', () => {
      void aegis.settings.get().then((s) => {
        if (!active) return;
        setSettings(s);
        settingsRef.current = s;
        // Re-apply the resolved theme (accent + palette) so a synced primaryColor OR
        // themeMode recolors the chrome without a reload.
        applyTheme(s);
        // Notify settings-derived hooks (e.g. useNav's search template) of the change.
        publishSettings(s);
      });
    });
    // Subscribe to OS color-scheme changes so `system` mode follows the OS live.
    const offWatch = watchSystemTheme(() => {
      applyTheme(settingsRef.current);
    });
    return () => {
      active = false;
      off();
      offWatch();
    };
  }, []);

  const update = useCallback(async (partial: Partial<Settings>): Promise<void> => {
    const next = await aegis.settings.set(partial);
    setSettings(next);
    settingsRef.current = next;
    // Theme re-applies live when the accent color OR theme mode was part of this edit.
    if (partial.primaryColor !== undefined || partial.themeMode !== undefined) {
      applyTheme(next);
    }
    // Notify settings-derived hooks (e.g. useNav's search template) so a changed
    // default search engine takes effect immediately, without a reload.
    publishSettings(next);
  }, []);

  return { settings, update };
}
