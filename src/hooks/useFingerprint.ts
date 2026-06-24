// src/hooks/useFingerprint.ts
import { useCallback, useEffect, useState } from 'react';
import type { FingerprintState } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const emptyState: FingerprintState = {
  level: 'off',
  allowlistedHosts: [],
};

export function useFingerprint(): {
  state: FingerprintState;
  toggleAllowlist(host: string): void;
  removeAllowlist(host: string): void;
  clearAllowlist(): void;
} {
  const [state, setState] = useState<FingerprintState>(emptyState);

  useEffect(() => {
    let active = true;
    void aegis.fingerprint.getState().then((s) => {
      if (active) setState(s);
    });
    return () => {
      active = false;
    };
  }, []);

  const toggleAllowlist = useCallback((host: string) => {
    void aegis.fingerprint.toggleAllowlist(host).then((s) => setState(s));
  }, []);

  const removeAllowlist = useCallback((host: string) => {
    void aegis.fingerprint.removeAllowlist(host).then((s) => setState(s));
  }, []);

  const clearAllowlist = useCallback(() => {
    void aegis.fingerprint.clearAllowlist().then((s) => setState(s));
  }, []);

  return { state, toggleAllowlist, removeAllowlist, clearAllowlist };
}
