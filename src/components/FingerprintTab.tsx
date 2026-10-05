// src/components/FingerprintTab.tsx
//
// The "Fingerprinting" settings tab — one third of what used to be the single
// Security tab. Owns the anti-fingerprinting level and its per-site allowlist.
//
// The fp-allowlist is a SEPARATE store from the ad-block allowlist, and unlike the
// WebRTC exemption list this one IS synced (`sync_stores::SYNCABLE` does not carry
// it — `fp-allowlist` is local-only, see `src-tauri/AGENTS.md`). Both facts are why
// this panel cannot borrow the allowlist's props.
import { useState } from 'react';
import type { FingerprintState, Settings } from '../../shared/types';

export interface FingerprintTabProps {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  fingerprintState: FingerprintState;
  toggleFingerprintAllowlist: (host: string) => void;
  removeFingerprintAllowlist: (host: string) => void;
}

export function FingerprintTab({
  settings,
  update,
  fingerprintState,
  toggleFingerprintAllowlist,
  removeFingerprintAllowlist,
}: FingerprintTabProps) {
  const [addHost, setAddHost] = useState('');

  return (
    <div className="settings-panel fingerprint-tab">
      <section className="settings-section" aria-label="Anti-fingerprinting">
        <h3 className="settings-section__title">Anti-fingerprinting</h3>
        <label className="settings-row">
          <span className="settings-row__label">Anti-fingerprinting level</span>
          <select
            value={settings.antiFingerprint}
            onChange={(e) =>
              update({ antiFingerprint: e.target.value as Settings['antiFingerprint'] })
            }
            aria-label="Anti-fingerprinting level"
          >
            <option value="off">Off (default)</option>
            <option value="standard">Standard — noise canvas, audio &amp; device details</option>
            <option value="strict">
              Strict — Standard plus WebGL, and reduced timer precision
            </option>
          </select>
        </label>
        <p className="settings-hint">
          <strong>Opt-in.</strong> This adds randomized noise to the fingerprinting signals websites
          read, regenerated for each tab that is opened or reloaded — so each site sees a
          stable-but-unique fingerprint within that tab rather than your real value. Because the
          seed is baked in when a tab is created, a level change{' '}
          <strong>only takes effect in tabs opened or reloaded afterwards</strong>; an already-open
          tab keeps the seed it was given, so reload it to pick up the new level.{' '}
          <strong>Standard</strong> covers canvas, audio, and device details (such as your reported
          CPU cores and memory). <strong>Strict</strong>
          adds WebGL surfaces and reduces timer precision. Limit: this kind of protection is
          detectable by anti-bot vendors and may break sites that rely on canvas for rendering. Each
          website&apos;s embedded frames are noised independently.
        </p>
      </section>

      <section className="settings-section" aria-label="Sites with fingerprint protection off">
        <h3 className="settings-section__title">Sites with fingerprint protection off</h3>
        {fingerprintState.allowlistedHosts.length === 0 ? (
          <p className="settings-hint">No sites are exempted from fingerprint protection.</p>
        ) : (
          <ul className="settings-list">
            {fingerprintState.allowlistedHosts.map((host) => (
              <li key={host} className="settings-list__row">
                <span className="settings-list__main">{host}</span>
                <button
                  type="button"
                  className="settings-btn settings-btn--quiet"
                  aria-label={`Remove ${host} from fingerprint allowlist`}
                  onClick={() => removeFingerprintAllowlist(host)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="settings-row settings-row--inline">
          <input
            type="text"
            value={addHost}
            onChange={(e) => setAddHost(e.target.value)}
            placeholder="example.com"
            aria-label="Host to add to fingerprint allowlist"
          />
          <button
            type="button"
            className="settings-btn"
            aria-label="Add host to fingerprint allowlist"
            disabled={addHost.trim() === ''}
            onClick={() => {
              const h = addHost.trim();
              // No `if (!h) return;` here — the button's
              // `disabled={addHost.trim() === ''}` is the single enforcement point, and a
              // guard inside the handler would be unreachable (a disabled button never
              // dispatches), i.e. uncovered dead code. See `WebrtcTab` for the same note.
              // "Add" must only ADD. toggleAllowlist would REMOVE an already-listed host,
              // so guard against the host already being present (idempotent add).
              if (!fingerprintState.allowlistedHosts.includes(h)) {
                toggleFingerprintAllowlist(h);
              }
              setAddHost('');
            }}
          >
            Add
          </button>
        </div>
      </section>
    </div>
  );
}

export default FingerprintTab;
