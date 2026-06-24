// src/components/SecurityTab.tsx
import { useEffect, useState } from 'react';
import type { FingerprintState, Settings } from '../../shared/types';

export function SecurityTab({
  settings,
  update,
  listExceptions,
  removeException,
  fingerprintState,
  toggleFingerprintAllowlist,
  removeFingerprintAllowlist,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  listExceptions: () => Promise<string[]>;
  removeException: (host: string) => void;
  fingerprintState: FingerprintState;
  toggleFingerprintAllowlist: (host: string) => void;
  removeFingerprintAllowlist: (host: string) => void;
}) {
  const [exceptions, setExceptions] = useState<string[]>([]);
  const [addHost, setAddHost] = useState('');

  useEffect(() => {
    let active = true;
    void listExceptions().then((xs) => {
      if (active) setExceptions(xs);
    });
    return () => {
      active = false;
    };
  }, [listExceptions]);

  return (
    <div className="security-tab">
      <label className="security-tab__field">
        <input
          type="checkbox"
          checked={settings.httpsOnly}
          onChange={(e) => update({ httpsOnly: e.target.checked })}
          aria-label="HTTPS-Only mode"
        />
        <span>
          HTTPS-Only mode — upgrade sites to a secure connection and warn before using HTTP
        </span>
      </label>

      <h3>Sites allowed over HTTP</h3>
      {exceptions.length === 0 ? (
        <p>No HTTP exceptions remembered.</p>
      ) : (
        <ul>
          {exceptions.map((host) => (
            <li key={host}>
              <span>{host}</span>
              <button
                type="button"
                aria-label={`Remove HTTP exception for ${host}`}
                onClick={() => {
                  removeException(host);
                  setExceptions((xs) => xs.filter((h) => h !== host));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>WebRTC IP protection</h3>
      <label className="security-tab__field">
        <span>WebRTC policy</span>
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
      <p>
        WebRTC can leak your device&apos;s local-network IP to websites, even over a VPN.
        &ldquo;Hide my local IP&rdquo; filters out private/loopback addresses while keeping relay
        candidates so video and voice calls still work. &ldquo;Disable&rdquo; turns WebRTC off
        entirely (calls won&apos;t work). Changes apply to new tabs &mdash; reload open tabs to
        apply.
      </p>

      <h3>Malicious-site protection</h3>
      <p>
        On &mdash; known malware and phishing sites are blocked with a warning. This protection is
        always active and can&apos;t be turned off.
      </p>

      <h3>Anti-fingerprinting</h3>
      <label className="security-tab__field">
        <span>Anti-fingerprinting level</span>
        <select
          value={settings.antiFingerprint}
          onChange={(e) =>
            update({ antiFingerprint: e.target.value as Settings['antiFingerprint'] })
          }
          aria-label="Anti-fingerprinting level"
        >
          <option value="off">Off (default)</option>
          <option value="standard">Standard — noise canvas, audio &amp; device details</option>
          <option value="strict">Strict — Standard plus WebGL, and reduced timer precision</option>
        </select>
      </label>
      <p>
        <strong>Opt-in.</strong> This adds randomized noise to the fingerprinting signals websites
        read, regenerated each session — so each site sees a stable-but-unique fingerprint within a
        session rather than your real value. <strong>Standard</strong> covers canvas, audio, and
        device details (such as your reported CPU cores and memory). <strong>Strict</strong> adds
        WebGL surfaces and reduces timer precision. Limit: this kind of protection is detectable by
        anti-bot vendors and may break sites that rely on canvas for rendering. Each website&apos;s
        embedded frames are noised independently.
      </p>

      <h3>Sites with fingerprint protection off</h3>
      {fingerprintState.allowlistedHosts.length === 0 ? (
        <p>No sites are exempted from fingerprint protection.</p>
      ) : (
        <ul>
          {fingerprintState.allowlistedHosts.map((host) => (
            <li key={host}>
              <span>{host}</span>
              <button
                type="button"
                aria-label={`Remove ${host} from fingerprint allowlist`}
                onClick={() => removeFingerprintAllowlist(host)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="security-tab__add-host">
        <input
          type="text"
          value={addHost}
          onChange={(e) => setAddHost(e.target.value)}
          placeholder="example.com"
          aria-label="Host to add to fingerprint allowlist"
        />
        <button
          type="button"
          aria-label="Add host to fingerprint allowlist"
          disabled={addHost.trim() === ''}
          onClick={() => {
            const h = addHost.trim();
            if (!h) return;
            toggleFingerprintAllowlist(h);
            setAddHost('');
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
