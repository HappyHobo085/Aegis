// src/components/WebrtcTab.tsx
//
// The "WebRTC" settings tab — one third of what used to be the single Security tab.
// Owns the local-IP-leak policy and the per-site exemption list.
//
// The exemption list is a SEPARATE, NEVER-SYNCED store from the ad-block allowlist
// (see `src/lib/url.ts`'s `hostCovered` note and `src/AGENTS.md`), which is why it
// needs its own three props rather than sharing the allowlist's.
import { useState } from 'react';
import type { Settings, WebrtcExemptState } from '../../shared/types';

export interface WebrtcTabProps {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  webrtcExempt: WebrtcExemptState;
  toggleWebrtcExempt: (host: string) => void;
  removeWebrtcExempt: (host: string) => void;
}

export function WebrtcTab({
  settings,
  update,
  webrtcExempt,
  toggleWebrtcExempt,
  removeWebrtcExempt,
}: WebrtcTabProps) {
  const [exemptHost, setExemptHost] = useState('');

  return (
    <div className="settings-panel webrtc-tab">
      <section className="settings-section" aria-label="WebRTC IP protection">
        <h3 className="settings-section__title">WebRTC IP protection</h3>
        <label className="settings-row">
          <span className="settings-row__label">WebRTC policy</span>
          <select
            value={settings.webrtcPolicy}
            onChange={(e) => update({ webrtcPolicy: e.target.value as Settings['webrtcPolicy'] })}
            aria-label="WebRTC policy"
          >
            <option value="public-only">Hide my local IP (recommended)</option>
            <option value="disable">Disable WebRTC entirely — breaks video calls</option>
            <option value="default">No protection</option>
          </select>
        </label>
        <p className="settings-hint">
          WebRTC can leak your device&apos;s local-network IP to websites, even over a VPN.
          &ldquo;Hide my local IP&rdquo; filters out private/loopback addresses while keeping relay
          candidates so video and voice calls still work. &ldquo;Disable&rdquo; turns WebRTC off
          entirely (calls won&apos;t work). Changes apply to new tabs &mdash; reload open tabs to
          apply.
        </p>
      </section>

      <section className="settings-section" aria-label="Sites with WebRTC protection off">
        <h3 className="settings-section__title">Sites with WebRTC protection off</h3>
        {webrtcExempt.exemptHosts.length === 0 ? (
          <p className="settings-hint">No sites are exempted from WebRTC protection.</p>
        ) : (
          <ul className="settings-list">
            {webrtcExempt.exemptHosts.map((host) => (
              <li key={host} className="settings-list__row">
                <span className="settings-list__main">{host}</span>
                <button
                  type="button"
                  className="settings-btn settings-btn--quiet"
                  aria-label={`Remove ${host} from WebRTC exemptions`}
                  onClick={() => removeWebrtcExempt(host)}
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
            value={exemptHost}
            onChange={(e) => setExemptHost(e.target.value)}
            placeholder="example.com"
            aria-label="Host to exempt from WebRTC protection"
          />
          <button
            type="button"
            className="settings-btn"
            aria-label="Add host to WebRTC exemptions"
            disabled={exemptHost.trim() === ''}
            onClick={() => {
              const h = exemptHost.trim();
              // No `if (!h) return;` here, and that is deliberate: the button's
              // `disabled={exemptHost.trim() === ''}` is the SINGLE enforcement point, and a
              // second guard inside the handler is unreachable — a disabled button never
              // dispatches, so the branch could never run and no test could ever cover it.
              // It was written once, measured as 0% covered, and deleted rather than kept
              // as decorative defence.
              // "Add" must only ADD. toggleExempt would REMOVE an already-exempt host, so
              // guard against the host already being present (idempotent add).
              if (!webrtcExempt.exemptHosts.includes(h)) {
                toggleWebrtcExempt(h);
              }
              setExemptHost('');
            }}
          >
            Add
          </button>
        </div>
        <p className="settings-hint">
          Only add a site here if WebRTC protection genuinely breaks it (a local video-call test
          harness, typically). This list is <strong>never synced</strong> and never travels with
          your account, because a record from any device that can sync would otherwise turn WebRTC
          protection off everywhere without saying so. It is also separate from &ldquo;sites where
          ads are allowed&rdquo; — allowing a site&apos;s ads must not also leak your IP to it.
        </p>
      </section>
    </div>
  );
}

export default WebrtcTab;
