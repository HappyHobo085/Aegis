// src/hooks/useSettings.ts
import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { applyTheme } from '../lib/theme';

const emptySettings: Settings = {
  siteName: '',
  homeUrl: '',
  primaryColor: '#3b82f6',
  defaultSearchTemplate: '',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
};

export function useSettings(): {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
} {
  const [settings, setSettings] = useState<Settings>(emptySettings);

  useEffect(() => {
    let active = true;
    void aegis.settings.get().then((s) => {
      if (!active) return;
      setSettings(s);
      document.title = s.siteName;
    });
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback(async (partial: Partial<Settings>): Promise<void> => {
    const next = await aegis.settings.set(partial);
    setSettings(next);
    // Theme re-applies live only when the accent color was part of this edit.
    if (partial.primaryColor !== undefined) {
      applyTheme({ primaryColor: next.primaryColor });
    }
    // Keep the document title in sync when the site name was part of this edit.
    if (partial.siteName !== undefined) {
      document.title = next.siteName;
    }
  }, []);

  return { settings, update };
}
