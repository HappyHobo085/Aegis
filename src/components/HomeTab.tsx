// src/components/HomeTab.tsx
import { useState } from 'react';
import type { Settings } from '../../shared/types';
import { toast } from '../lib/toast';

export interface HomeTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function HomeTab({ settings, update }: HomeTabProps) {
  const [homeUrl, setHomeUrl] = useState(settings.homeUrl);

  const handleSave = (): void => {
    void (async () => {
      await update({ homeUrl: homeUrl.trim() });
      toast.success('Saved');
    })();
  };

  return (
    <form
      className="home-tab"
      role="group"
      aria-label="Home URL"
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
    >
      <label htmlFor="home-tab-url">Home URL</label>
      <input
        id="home-tab-url"
        type="text"
        aria-label="Home URL"
        placeholder="https://duckduckgo.com"
        value={homeUrl}
        onChange={(e) => setHomeUrl(e.target.value)}
      />
      <button type="submit" aria-label="Save home URL">
        Save
      </button>
    </form>
  );
}
