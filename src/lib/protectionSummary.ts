import type {
  FingerprintState,
  ProxyState,
  Settings,
  TabMeta,
  WebrtcExemptState,
} from '../../shared/types';
import { hostCovered } from './url';

export interface ProtectionSummary {
  privateMode: boolean;
  httpsOnly: boolean;
  webrtcPolicy: Settings['webrtcPolicy'];
  /**
   * The browsed host is on the per-site WebRTC exemption list, so NO WebRTC
   * IP-leak shim is injected for it and the native backstops are skipped.
   *
   * Without this field the badge reported the page's *policy* and nothing about
   * whether that policy actually applied, so an exempt host was shown as
   * "WebRTC IP protection: Public only" in green while a page could read the
   * machine's real local IPs. Wave 7 split the exemption out of the ad-block
   * allowlist precisely so it stops travelling; the badge has to know about it
   * too, or the one place the user looks for "am I protected?" is the one place
   * that lies.
   */
  webrtcExempt: boolean;
  fingerprintLevel: FingerprintState['level'];
  fingerprintAllowed: boolean;
  proxyActive: boolean;
  proxyUri: string | null;
}

export function protectionSummary(opts: {
  activeTab?: TabMeta;
  settings: Settings;
  fingerprint: FingerprintState;
  webrtc: WebrtcExemptState;
  proxy: ProxyState;
  host: string | null;
}): ProtectionSummary {
  const { activeTab, settings, fingerprint, webrtc, proxy, host } = opts;
  return {
    privateMode: activeTab?.private ?? false,
    httpsOnly: settings.httpsOnly,
    webrtcPolicy: settings.webrtcPolicy,
    // Scope comes from the ONE shared helper, not `.includes()`, so the badge
    // cannot claim a host is protected when the core exempted its subdomain.
    webrtcExempt: hostCovered(webrtc.exemptHosts, host),
    fingerprintLevel: fingerprint.level,
    fingerprintAllowed: hostCovered(fingerprint.allowlistedHosts, host),
    proxyActive: proxy.active,
    proxyUri: proxy.uri,
  };
}
