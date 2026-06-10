// src/components/AppearanceTab.tsx
import { useState } from 'react';
import type { Settings } from '../../shared/types';

export interface AppearanceTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function AppearanceTab({ settings, update }: AppearanceTabProps) {
  const [siteName, setSiteName] = useState(settings.siteName);

  return (
    <div className="appearance-tab">
      <label className="appearance-tab__field">
        <span>Accent color</span>
        <input
          type="color"
          aria-label="Accent color"
          value={settings.primaryColor}
          onChange={(e) => void update({ primaryColor: e.target.value })}
        />
      </label>

      <div className="appearance-tab__field" role="group" aria-label="Site name">
        <label htmlFor="appearance-tab-site-name">Site name</label>
        <input
          id="appearance-tab-site-name"
          type="text"
          aria-label="Site name"
          value={siteName}
          onChange={(e) => setSiteName(e.target.value)}
        />
        <button
          type="button"
          aria-label="Save site name"
          onClick={() => void update({ siteName })}
        >
          Save
        </button>
      </div>
    </div>
  );
}
