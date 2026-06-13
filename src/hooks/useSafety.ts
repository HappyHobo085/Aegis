// src/hooks/useSafety.ts
import { useCallback, useEffect, useState } from 'react';
import type { SafetyInterstitialPayload } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useSafety() {
  const [interstitial, setInterstitial] = useState<SafetyInterstitialPayload | null>(null);

  useEffect(() => {
    let active = true;
    void aegis.safety.getState().then((s) => {
      if (active) setInterstitial(s);
    });
    const unsubscribe = aegis.safety.onInterstitial((p) => setInterstitial(p));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const proceed = useCallback((url: string): Promise<void> => aegis.safety.proceed(url), []);
  return { interstitial, proceed };
}
