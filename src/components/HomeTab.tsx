// src/components/HomeTab.tsx
import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/types';
import { toast } from '../lib/toast';
import { saveErrorText } from '../lib/saveError';

export interface HomeTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function HomeTab({ settings, update }: HomeTabProps) {
  const [homeUrl, setHomeUrl] = useState(settings.homeUrl);
  // Re-sync the draft when the persisted value changes externally (sync push / data import) —
  // but keep the user's in-progress edit (only adopt when they haven't touched it).
  const lastPropRef = useRef(settings.homeUrl);
  useEffect(() => {
    if (settings.homeUrl !== lastPropRef.current) {
      if (homeUrl === lastPropRef.current) setHomeUrl(settings.homeUrl);
      lastPropRef.current = settings.homeUrl;
    }
  }, [settings.homeUrl, homeUrl]);

  const handleSave = (): void => {
    void (async () => {
      try {
        await update({ homeUrl: homeUrl.trim() });
        toast.success('Saved');
      } catch (e) {
        // The core validates the home URL and REFUSES a bad one. That rejection used to
        // escape this floating async IIFE as an unhandled promise rejection — invisible
        // in the UI, so a refused save looked exactly like a Save button that did nothing.
        // The draft is deliberately left alone so the user can correct and retry.
        toast.error(saveErrorText(e));
      }
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
