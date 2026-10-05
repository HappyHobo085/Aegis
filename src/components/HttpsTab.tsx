// src/components/HttpsTab.tsx
//
// The "HTTPS" settings tab — one third of what used to be the single Security tab.
// It carries ONLY the transport-security concern: the HTTPS-Only switch and the
// per-site HTTP exception list. Each of the three tabs this split produced receives
// just the props it reads; before the split all three rode one 14-field bundle, so
// this panel was handed the fingerprint allowlist and the WebRTC exemption list,
// neither of which it ever touched.
import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/types';

/** True on the Android shell. `.aegis-mobile` is the repo's ONE Android marker: it is
 *  written in exactly one place (`ipcClient.ts`, from the UA at module load) and read
 *  by `App.tsx` to pick the mobile shell and by `useNarrowViewport` to skip its
 *  desktop branch. Reading the class rather than re-testing the UA is deliberate — a
 *  second platform test is how the crate got two scheme lists in the first place. */
function isAndroid(): boolean {
  return (
    typeof document !== 'undefined' && document.documentElement.classList.contains('aegis-mobile')
  );
}

export interface HttpsTabProps {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  listExceptions: () => Promise<string[]>;
  removeException: (host: string) => void;
}

export function HttpsTab({ settings, update, listExceptions, removeException }: HttpsTabProps) {
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
    <div className="settings-panel https-tab">
      {/* HTTPS-Only is a DESKTOP control only, and this is the honest reason rather
          than a hidden limitation: `gen/android/app/build.gradle.kts` sets
          `usesCleartextTraffic=false` for RELEASE (true only for debug), so a
          release build cannot load `http://` at all — the setting cannot be
          turned OFF there, and a checkbox that cannot do anything is a control
          that lies. Flipping the manifest instead would re-enable cleartext for
          EVERY request, third-party ads and trackers included, which is a real
          privacy regression on the platform that most needs the protection. The
          upgrade in `MainActivity.secureUrl` still runs, so the feature is not
          lost — it is unconditional. Gate on `.aegis-mobile`, the single signal
          the rest of the chrome already uses for the Android shell (written once
          in `ipcClient.ts` from the UA, read by `App.tsx` and
          `useNarrowViewport`), and read it at RENDER time for the same reason
          `App.tsx`'s `getIsMobile()` is a function: import order must not decide
          whether the control appears. */}
      <section className="settings-section" aria-label="HTTPS-Only mode">
        <h3 className="settings-section__title">HTTPS-Only mode</h3>
        {isAndroid() ? (
          <p className="settings-hint">
            HTTPS-Only mode is always on here — Android&apos;s network policy refuses plain HTTP
            outright, so there is nothing to switch.
          </p>
        ) : (
          <label className="settings-row">
            <input
              type="checkbox"
              checked={settings.httpsOnly}
              onChange={(e) => update({ httpsOnly: e.target.checked })}
              aria-label="HTTPS-Only mode"
            />
            <span className="settings-row__label">
              Upgrade sites to a secure connection and warn before using HTTP
            </span>
          </label>
        )}
      </section>

      <section className="settings-section" aria-label="Sites allowed over HTTP">
        <h3 className="settings-section__title">Sites allowed over HTTP</h3>
        {exceptions.length === 0 ? (
          <p className="settings-hint">No HTTP exceptions remembered.</p>
        ) : (
          <ul className="settings-list">
            {exceptions.map((host) => (
              <li key={host} className="settings-list__row">
                <span className="settings-list__main">{host}</span>
                <button
                  type="button"
                  className="settings-btn settings-btn--quiet"
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
      </section>
    </div>
  );
}

export default HttpsTab;
