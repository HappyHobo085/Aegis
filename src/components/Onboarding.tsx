// src/components/Onboarding.tsx
import { useRef, useState } from 'react';
import { Shield, EyeOff, Fingerprint, Network } from 'lucide-react';
import type { SearchEngine } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

export const ONBOARDING_STORAGE_KEY = 'aegis.onboarding.completed.v1';

export interface OnboardingProps {
  searchEngines: SearchEngine[];
  defaultSearchTemplate: string;
  /** Persist the chosen default search engine. */
  onChooseSearch(template: string): void;
  /** Apply a one-click privacy baseline before browsing. */
  onChoosePrivacyPreset?(preset: 'balanced' | 'strict'): void;
  /** Open the Settings modal (the onboarding closes first). */
  onOpenSettings(): void;
  /** Jump straight to backup/import controls. */
  onImportData?(): void;
  /** Test seam: force the modal open regardless of the stored flag. */
  forceOpen?: boolean;
}

const FEATURES = [
  {
    Icon: Shield,
    title: 'Ads blocked by default',
    body: 'Ads and trackers are filtered out of the box — no setup.',
  },
  {
    Icon: EyeOff,
    title: 'Private tabs',
    body: 'Open a private tab (Ctrl+Shift+N) that leaves no history behind.',
  },
  {
    Icon: Fingerprint,
    title: 'Fingerprint protection',
    body: 'Turn on anti-fingerprinting in Settings → Security to resist tracking.',
  },
  {
    Icon: Network,
    title: 'Built-in proxy',
    body: 'Route browsed pages through a proxy in Settings → Proxy.',
  },
];

/** First-run welcome: surfaces the signature features and lets the user pick a default
 *  search engine, instead of the old single-line hint. Shown once (localStorage-gated),
 *  and never during the live autopilot (which runs on a fresh profile). */
export function Onboarding({
  searchEngines,
  defaultSearchTemplate,
  onChooseSearch,
  onChoosePrivacyPreset,
  onOpenSettings,
  onImportData,
  forceOpen = false,
}: OnboardingProps) {
  const isAutopilot = Boolean(import.meta.env.VITE_AEGIS_AUTOPILOT);
  const [done, setDone] = useState<boolean>(
    () => !forceOpen && (isAutopilot || localStorage.getItem(ONBOARDING_STORAGE_KEY) === '1'),
  );
  const [privacyPreset, setPrivacyPreset] = useState<'balanced' | 'strict'>('balanced');
  const titleId = useRef(`onboarding-title`).current;
  const startRef = useRef<HTMLButtonElement | null>(null);

  const complete = (): void => {
    onChoosePrivacyPreset?.(privacyPreset);
    localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    setDone(true);
  };
  const dialogRef = useDialog<HTMLDivElement>(complete, { initialFocus: startRef });
  useChromeSurface('onboarding', !done);

  if (done) return null;

  return (
    <div className="onboarding" role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="onboarding__card"
      >
        <h1 id={titleId} className="onboarding__title">
          Welcome to Aegis
        </h1>
        <p className="onboarding__lead">A private, ad-free browser. Here’s what’s built in:</p>
        <ol className="onboarding__steps" aria-label="Setup steps">
          <li>Start fresh or import</li>
          <li>Choose privacy</li>
          <li>Pick search</li>
        </ol>

        <ul className="onboarding__features">
          {FEATURES.map(({ Icon, title, body }) => (
            <li key={title} className="onboarding__feature">
              <Icon size={20} aria-hidden="true" className="onboarding__feature-icon" />
              <div>
                <div className="onboarding__feature-title">{title}</div>
                <div className="onboarding__feature-body">{body}</div>
              </div>
            </li>
          ))}
        </ul>

        {searchEngines.length > 0 && (
          <fieldset className="onboarding__search">
            <legend className="onboarding__search-legend">Choose your search engine</legend>
            {searchEngines.map((e) => (
              <label key={e.id} className="onboarding__search-option">
                <input
                  type="radio"
                  name="onboarding-search"
                  checked={e.template === defaultSearchTemplate}
                  onChange={() => onChooseSearch(e.template)}
                />
                {e.name}
              </label>
            ))}
          </fieldset>
        )}

        {onChoosePrivacyPreset && (
          <fieldset className="onboarding__privacy">
            <legend className="onboarding__search-legend">Choose a privacy preset</legend>
            <label className="onboarding__privacy-option">
              <input
                type="radio"
                name="onboarding-privacy"
                checked={privacyPreset === 'balanced'}
                onChange={() => setPrivacyPreset('balanced')}
              />
              <span>
                <strong>Balanced</strong>
                <small>HTTPS upgrades, public-only WebRTC, standard fingerprint protection.</small>
              </span>
            </label>
            <label className="onboarding__privacy-option">
              <input
                type="radio"
                name="onboarding-privacy"
                checked={privacyPreset === 'strict'}
                onChange={() => setPrivacyPreset('strict')}
              />
              <span>
                <strong>Strict</strong>
                <small>Blocks WebRTC construction and uses strict fingerprint protection.</small>
              </span>
            </label>
          </fieldset>
        )}

        <div className="onboarding__actions">
          {onImportData && (
            <button
              type="button"
              className="onboarding__secondary"
              onClick={() => {
                complete();
                onImportData();
              }}
            >
              Import backup
            </button>
          )}
          <button
            type="button"
            className="onboarding__secondary"
            onClick={() => {
              complete();
              onOpenSettings();
            }}
          >
            Open settings
          </button>
          <button ref={startRef} type="button" className="onboarding__primary" onClick={complete}>
            Start fresh
          </button>
        </div>
      </div>
    </div>
  );
}
