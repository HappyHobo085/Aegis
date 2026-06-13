// src/components/SecurityTab.tsx
import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';

export function SecurityTab({
  settings,
  update,
  listExceptions,
  removeException,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  listExceptions: () => Promise<string[]>;
  removeException: (host: string) => void;
}) {
  const [exceptions, setExceptions] = useState<string[]>([]);
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
        <span>HTTPS-Only mode — upgrade sites to a secure connection and warn before using HTTP</span>
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
      <h3>Malicious-site protection</h3>
      <p>
        On &mdash; known malware and phishing sites are blocked with a warning. This protection is always
        active and can&apos;t be turned off.
      </p>
    </div>
  );
}
