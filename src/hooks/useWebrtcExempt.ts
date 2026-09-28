// src/hooks/useWebrtcExempt.ts
import { useCallback, useEffect, useState } from 'react';
import type { WebrtcExemptState } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const emptyState: WebrtcExemptState = { exemptHosts: [] };

/** Hosts this device has exempted from the WebRTC IP-leak defence.
 *
 * LOCAL-ONLY, like the fp-allowlist and unlike the ad-block allowlist: a peer merge cannot
 * change this list, so there is deliberately NO `onSyncChange` subscription here. The absence
 * is the feature — see `WebrtcExemptState` in shared/types.ts.
 */
export function useWebrtcExempt(): {
  state: WebrtcExemptState;
  toggleExempt(host: string): void;
  removeExempt(host: string): void;
  clearExempt(): void;
} {
  const [state, setState] = useState<WebrtcExemptState>(emptyState);

  useEffect(() => {
    let active = true;
    const load = () => {
      void aegis.webrtc.getExemptHosts().then((s) => {
        if (active) setState(s);
      });
    };
    load();
    return () => {
      active = false;
    };
  }, []);

  const toggleExempt = useCallback((host: string) => {
    void aegis.webrtc.toggleExempt(host).then(setState);
  }, []);

  const removeExempt = useCallback((host: string) => {
    void aegis.webrtc.removeExempt(host).then(setState);
  }, []);

  const clearExempt = useCallback(() => {
    void aegis.webrtc.clearExempt().then(setState);
  }, []);

  return { state, toggleExempt, removeExempt, clearExempt };
}
