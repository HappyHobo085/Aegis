// src/hooks/useSafety.ts
import { useCallback, useEffect, useState } from 'react';
import type { SafetyInterstitialPayload } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useSafety() {
  const [interstitial, setInterstitial] = useState<SafetyInterstitialPayload | null>(null);

  useEffect(() => {
    let active = true;
    // BUG(F2): subscribe BEFORE the seed fetch, or an interstitial raised while
    // `safety.getState` is in flight is lost and no malware page is ever shown.
    const unsubscribe = aegis.safety.onInterstitial((p) => setInterstitial(p));
    void aegis.safety.getState().then((s) => {
      if (active) setInterstitial(s);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const proceed = useCallback((url: string): Promise<void> => aegis.safety.proceed(url), []);
  return { interstitial, proceed };
}
