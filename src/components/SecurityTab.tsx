// src/components/SecurityTab.tsx
//
// The "Overview" tab of the Security section — what this component used to be called
// before the split, back when one tab carried the dashboard, HTTPS-Only, WebRTC and
// anti-fingerprinting together. Those three concerns now live in `HttpsTab`,
// `WebrtcTab` and `FingerprintTab`; what remains here is the protection SUMMARY plus
// the one protection with no control at all.
//
// `SecurityPanelProps` therefore shrank from 14 fields to 5: every prop this tab
// never read (the fingerprint allowlist, the WebRTC exemptions, the HTTP exception
// list) went to the panel that does read it.
import { SecurityDashboard } from './SecurityDashboard';
import type { SecurityDashboardProps } from './SecurityDashboard';

/**
 * The Overview tab's props. Declared here rather than aliased to `SecurityDashboardProps`
 * because the modal's bundle has always called the ad-block state `adblockState` — the
 * name the two shells pass — while the dashboard's own prop is `adblock`. The rename is
 * done at this boundary instead of in the shells, which keeps both `App.tsx` and
 * `MobileApp.tsx` untouched by the split.
 */
export interface SecurityTabProps {
  protection: SecurityDashboardProps['protection'];
  adblockState: SecurityDashboardProps['adblock'];
  blockedHere: number;
  onHarden(): void;
  onOpenProxy(): void;
}

export function SecurityTab({
  protection,
  adblockState,
  blockedHere,
  onHarden,
  onOpenProxy,
}: SecurityTabProps) {
  return (
    <div className="settings-panel security-tab">
      <SecurityDashboard
        protection={protection}
        adblock={adblockState}
        blockedHere={blockedHere}
        onHarden={onHarden}
        onOpenProxy={onOpenProxy}
      />

      {/* Malicious-site protection has NO control — it is always on and cannot be turned
          off — so it earns a section here rather than a tab of its own. A tab is for
          something you can change; this is something you can only be told. */}
      <section className="settings-section" aria-label="Malicious-site protection">
        <h3 className="settings-section__title">Malicious-site protection</h3>
        <p className="settings-hint">
          On &mdash; known malware and phishing sites are blocked with a warning. This protection is
          always active and can&apos;t be turned off.
        </p>
      </section>
    </div>
  );
}

export default SecurityTab;
