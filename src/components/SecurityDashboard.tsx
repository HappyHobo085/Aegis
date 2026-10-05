import type { AdblockState } from '../../shared/types';
import type { ProtectionSummary } from '../lib/protectionSummary';

export interface SecurityDashboardProps {
  protection: ProtectionSummary;
  adblock: AdblockState;
  blockedHere: number;
  onHarden(): void;
  onOpenProxy(): void;
}

function statusOf(
  protection: ProtectionSummary,
  adblock: AdblockState,
): 'Strong' | 'Standard' | 'Relaxed' {
  const strong =
    protection.httpsOnly &&
    protection.webrtcPolicy !== 'default' &&
    protection.fingerprintLevel !== 'off' &&
    adblock.enabled;
  if (strong && (protection.privateMode || protection.proxyActive)) return 'Strong';
  if (strong) return 'Standard';
  return 'Relaxed';
}

export function SecurityDashboard({
  protection,
  adblock,
  blockedHere,
  onHarden,
  onOpenProxy,
}: SecurityDashboardProps) {
  const status = statusOf(protection, adblock);
  return (
    <section className="security-dashboard" aria-label="Security dashboard">
      <div
        className={`security-dashboard__status security-dashboard__status--${status.toLowerCase()}`}
      >
        <span>Current protection</span>
        <strong>{status}</strong>
      </div>
      <div className="security-dashboard__grid">
        <div>
          <span>Ad blocking</span>
          <strong>{adblock.enabled ? `${blockedHere} blocked here` : 'Off'}</strong>
        </div>
        <div>
          <span>HTTPS upgrades</span>
          <strong>{protection.httpsOnly ? 'On' : 'Off'}</strong>
        </div>
        <div>
          <span>WebRTC</span>
          <strong>{protection.webrtcPolicy === 'default' ? 'Default' : 'Protected'}</strong>
        </div>
        <div>
          <span>Fingerprinting</span>
          <strong>
            {protection.fingerprintLevel === 'off' ? 'Off' : protection.fingerprintLevel}
          </strong>
        </div>
        <div>
          <span>Private tab</span>
          <strong>{protection.privateMode ? 'On' : 'Off'}</strong>
        </div>
        <div>
          <span>Proxy</span>
          <strong>{protection.proxyActive ? 'Active' : 'Off'}</strong>
        </div>
      </div>
      <div className="security-dashboard__actions">
        <button type="button" onClick={onHarden}>
          Harden this session
        </button>
        <button type="button" onClick={onOpenProxy}>
          Proxy settings
        </button>
      </div>
    </section>
  );
}
