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
    void aegis.update.getState().then((s) => {
      if (active) setState(s);
    });
    const unsubscribe = aegis.update.onState((s) => {
      setState(s);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const checkNow = useCallback((): Promise<void> => aegis.update.checkNow(), []);
  const restartToInstall = useCallback((): Promise<void> => aegis.update.restartToInstall(), []);

  return { state, checkNow, restartToInstall };
}
