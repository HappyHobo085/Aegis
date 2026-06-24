// src/hooks/useProxy.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ProxyState } from '../../shared/types';

// --- mock ipcClient ---
const baseProxyState: ProxyState = {
  mode: 'off',
  scheme: 'http',
  host: '',
  port: 8080,
  bypassHosts: [],
  active: false,
  uri: null,
};

const onStateCallbacks: Array<(s: ProxyState) => void> = [];

const mockProxy = {
  getState: vi.fn().mockResolvedValue(baseProxyState),
  setConfig: vi.fn().mockResolvedValue(baseProxyState),
  clear: vi.fn().mockResolvedValue(baseProxyState),
  testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 12 }),
  onState: vi.fn((cb: (s: ProxyState) => void) => {
    onStateCallbacks.push(cb);
    return () => {
      const i = onStateCallbacks.indexOf(cb);
      if (i !== -1) onStateCallbacks.splice(i, 1);
    };
  }),
};

vi.mock('../lib/ipcClient', () => ({
  aegis: { proxy: mockProxy },
}));

// import after mock
const { useProxy } = await import('./useProxy');

describe('useProxy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onStateCallbacks.length = 0;
    mockProxy.getState.mockResolvedValue(baseProxyState);
    mockProxy.setConfig.mockResolvedValue(baseProxyState);
    mockProxy.clear.mockResolvedValue(baseProxyState);
    mockProxy.testConnection.mockResolvedValue({ ok: true, latencyMs: 12 });
    mockProxy.onState.mockImplementation((cb: (s: ProxyState) => void) => {
      onStateCallbacks.push(cb);
      return () => {
        const i = onStateCallbacks.indexOf(cb);
        if (i !== -1) onStateCallbacks.splice(i, 1);
      };
    });
  });

  it('seeds state from getState on mount', async () => {
    const seeded: ProxyState = {
      ...baseProxyState,
      mode: 'proxy',
      host: '127.0.0.1',
      active: true,
      uri: 'http://127.0.0.1:8080',
    };
    mockProxy.getState.mockResolvedValue(seeded);
    const { result } = renderHook(() => useProxy());
    await act(async () => {});
    expect(result.current.state.mode).toBe('proxy');
    expect(result.current.state.host).toBe('127.0.0.1');
  });

  it('subscribes to onState and updates on event', async () => {
    const { result } = renderHook(() => useProxy());
    await act(async () => {});
    const updated: ProxyState = {
      ...baseProxyState,
      mode: 'proxy',
      host: '10.0.0.1',
      active: true,
      uri: 'http://10.0.0.1:8080',
    };
    act(() => {
      onStateCallbacks.forEach((cb) => cb(updated));
    });
    expect(result.current.state.host).toBe('10.0.0.1');
  });

  it('setConfig calls aegis.proxy.setConfig and updates state', async () => {
    const newCfg = {
      mode: 'proxy' as const,
      scheme: 'http' as const,
      host: '1.2.3.4',
      port: 3128,
      bypassHosts: [],
    };
    const returned: ProxyState = { ...newCfg, active: true, uri: 'http://1.2.3.4:3128' };
    mockProxy.setConfig.mockResolvedValue(returned);
    const { result } = renderHook(() => useProxy());
    await act(async () => {});
    await act(async () => {
      await result.current.setConfig(newCfg);
    });
    expect(mockProxy.setConfig).toHaveBeenCalledWith(newCfg);
    expect(result.current.state.host).toBe('1.2.3.4');
    expect(result.current.state.active).toBe(true);
  });

  it('clear calls aegis.proxy.clear and resets state', async () => {
    const cleared: ProxyState = { ...baseProxyState };
    mockProxy.clear.mockResolvedValue(cleared);
    const { result } = renderHook(() => useProxy());
    await act(async () => {});
    await act(async () => {
      await result.current.clear();
    });
    expect(mockProxy.clear).toHaveBeenCalled();
    expect(result.current.state.mode).toBe('off');
  });

  it('test calls aegis.proxy.testConnection', async () => {
    const cfg = {
      mode: 'proxy' as const,
      scheme: 'socks5' as const,
      host: 'proxy.test',
      port: 1080,
      bypassHosts: [],
    };
    const { result } = renderHook(() => useProxy());
    await act(async () => {});
    let testResult: { ok: boolean; latencyMs?: number; error?: string } | undefined;
    await act(async () => {
      testResult = await result.current.test(cfg);
    });
    expect(mockProxy.testConnection).toHaveBeenCalledWith(cfg);
    expect(testResult?.ok).toBe(true);
    expect(testResult?.latencyMs).toBe(12);
  });

  it('unsubscribes from onState on unmount', async () => {
    const { unmount } = renderHook(() => useProxy());
    await act(async () => {});
    expect(onStateCallbacks).toHaveLength(1);
    unmount();
    expect(onStateCallbacks).toHaveLength(0);
  });
});
