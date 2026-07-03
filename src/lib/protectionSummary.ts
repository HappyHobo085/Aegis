import type { FingerprintState, ProxyState, Settings, TabMeta } from '../../shared/types';

export interface ProtectionSummary {
  privateMode: boolean;
  httpsOnly: boolean;
  webrtcPolicy: Settings['webrtcPolicy'];
  fingerprintLevel: FingerprintState['level'];
  fingerprintAllowed: boolean;
  proxyActive: boolean;
  proxyUri: string | null;
}

export function protectionSummary(opts: {
  activeTab?: TabMeta;
  settings: Settings;
  fingerprint: FingerprintState;
  proxy: ProxyState;
  host: string | null;
}): ProtectionSummary {
  const { activeTab, settings, fingerprint, proxy, host } = opts;
  return {
    privateMode: activeTab?.private ?? false,
    httpsOnly: settings.httpsOnly,
    webrtcPolicy: settings.webrtcPolicy,
    fingerprintLevel: fingerprint.level,
    fingerprintAllowed: host !== null && fingerprint.allowlistedHosts.includes(host),
    proxyActive: proxy.active,
    proxyUri: proxy.uri,
  };
}
