// src/hooks/useProxy.ts
import { useCallback, useEffect, useState } from 'react';
import type { ProxyConfig, ProxyState } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const EMPTY_STATE: ProxyState = {
  mode: 'off',
  scheme: 'http',
  host: '',
  port: 8080,
  bypassHosts: [],
  active: false,
  uri: null,
};

export interface UseProxy {
  state: ProxyState;
  setConfig(cfg: ProxyConfig): Promise<ProxyState>;
  clear(): Promise<ProxyState>;
  test(cfg: ProxyConfig): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  /** Dev-only: directly seed the proxy state (bypasses the async getState() path). */
  _setState(s: ProxyState): void;
}

export function useProxy(): UseProxy {
  const [state, setState] = useState<ProxyState>(EMPTY_STATE);

  useEffect(() => {
    let active = true;
    void aegis.proxy.getState().then((s) => {
      if (active) setState(s);
    });
    const offState = aegis.proxy.onState((s) => setState(s));
    return () => {
      active = false;
      offState();
    };
  }, []);

  const setConfig = useCallback(async (cfg: ProxyConfig): Promise<ProxyState> => {
    const next = await aegis.proxy.setConfig(cfg);
    setState(next);
    return next;
  }, []);

  const clear = useCallback(async (): Promise<ProxyState> => {
    const next = await aegis.proxy.clear();
    setState(next);
    return next;
  }, []);

  const test = useCallback((cfg: ProxyConfig) => aegis.proxy.testConnection(cfg), []);

  return { state, setConfig, clear, test, _setState: setState };
}
