// src/hooks/useUpdate.ts
import { useCallback, useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const IDLE: UpdateState = { status: 'idle', version: null, percent: 0, error: null };

export function useUpdate(): {
  state: UpdateState;
  checkNow(): Promise<void>;
  restartToInstall(): Promise<void>;
} {
  const [state, setState] = useState<UpdateState>(IDLE);

  useEffect(() => {
    let active = true;
    // BUG(F2): subscribe BEFORE the seed fetch, or a download that finishes while
    // `update.getState` is in flight never reaches the UI — the "Update available" prompt and
    // the restart-to-install button would simply never appear.
    const unsubscribe = aegis.update.onState((s) => {
      setState(s);
    });
    void aegis.update.getState().then((s) => {
      if (active) setState(s);
    });
    // Auto-check on startup so updates surface without the user asking ("auto-
    // updating"). Result arrives via onState; no-ops quietly when up to date.
    void aegis.update.checkNow();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const checkNow = useCallback((): Promise<void> => aegis.update.checkNow(), []);
  const restartToInstall = useCallback((): Promise<void> => aegis.update.restartToInstall(), []);

  return { state, checkNow, restartToInstall };
}
