// src/components/HomeTab.tsx
import { useState } from 'react';
import type { Settings } from '../../shared/types';

export interface HomeTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function HomeTab({ settings, update }: HomeTabProps) {
  const [homeUrl, setHomeUrl] = useState(settings.homeUrl);

  return (
    <div className="home-tab" role="group" aria-label="Home URL">
      <label htmlFor="home-tab-url">Home URL</label>
      <input
        id="home-tab-url"
        type="text"
        aria-label="Home URL"
        value={homeUrl}
        onChange={(e) => setHomeUrl(e.target.value)}
      />
      <button
        type="button"
        aria-label="Save home URL"
        onClick={() => void update({ homeUrl: homeUrl.trim() })}
      >
        Save
      </button>
    </div>
  );
}
