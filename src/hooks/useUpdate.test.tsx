// src/hooks/useUpdate.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { UpdateState } from '../../shared/types';

const getState = vi.fn();
const checkNow = vi.fn();
const restartToInstall = vi.fn();
const onState = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    update: {
      getState: (...a: any[]) => getState(...a),
      checkNow: (...a: any[]) => checkNow(...a),
      restartToInstall: (...a: any[]) => restartToInstall(...a),
      onState: (cb: (s: UpdateState) => void) => onState(cb),
    },
  },
}));

import { useUpdate } from './useUpdate';

const st = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle', version: null, percent: 0, error: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(st());
  checkNow.mockResolvedValue(undefined);
  restartToInstall.mockResolvedValue(undefined);
  onState.mockReturnValue(() => {});
});

describe('useUpdate', () => {
  it('seeds state from aegis.update.getState on mount', async () => {
    getState.mockResolvedValue(st({ status: 'available', version: '0.2.0' }));
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.state.status).toBe('available'));
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('updates state when an onState event fires', async () => {
    let pushed: ((s: UpdateState) => void) | undefined;
    onState.mockImplementation((cb: (s: UpdateState) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.state.status).toBe('idle'));
    await act(async () => {
      pushed!(st({ status: 'downloaded', version: '0.3.0', percent: 100 }));
    });
    expect(result.current.state).toMatchObject({ status: 'downloaded', version: '0.3.0' });
  });

  it('restartToInstall() delegates to aegis.update.restartToInstall', async () => {
    const { result } = renderHook(() => useUpdate());
    await act(async () => {
      await result.current.restartToInstall();
    });
    expect(restartToInstall).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', async () => {
    const unsubscribe = vi.fn();
    onState.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useUpdate());
    await waitFor(() => expect(onState).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
