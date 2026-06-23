// src/hooks/usePermissions.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SitePermission, PermissionPrompt } from '../../shared/types';

const list = vi.fn();
const remove = vi.fn();
const clear = vi.fn();
const resolve = vi.fn();
const onPrompt = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    permissions: {
      list: (...a: any[]) => list(...a),
      remove: (...a: any[]) => remove(...a),
      clear: (...a: any[]) => clear(...a),
      resolve: (...a: any[]) => resolve(...a),
      onPrompt: (cb: (p: PermissionPrompt) => void) => onPrompt(cb),
    },
  },
}));

import { usePermissions } from './usePermissions';

const perm = (over: Partial<SitePermission> = {}): SitePermission => ({
  origin: 'https://example.com',
  permission: 'geolocation',
  decision: 'allow',
  ...over,
});

const seed: SitePermission[] = [
  perm({ origin: 'https://a.example', permission: 'geolocation', decision: 'allow' }),
  perm({ origin: 'https://b.example', permission: 'notifications', decision: 'deny' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  remove.mockResolvedValue(seed);
  clear.mockResolvedValue([]);
  resolve.mockResolvedValue(undefined);
  onPrompt.mockReturnValue(() => {});
});

describe('usePermissions', () => {
  it('seeds permissions from aegis.permissions.list on mount', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.permissions[0].origin).toBe('https://a.example');
  });

  it('starts with no active prompt', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    expect(result.current.prompt).toBeNull();
  });

  it('remove() calls aegis with origin + permission and syncs the returned list', async () => {
    remove.mockResolvedValue([seed[1]]);
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    await act(async () => {
      await result.current.remove('https://a.example', 'geolocation');
    });
    expect(remove).toHaveBeenCalledWith('https://a.example', 'geolocation');
    expect(result.current.permissions.map((p) => p.origin)).toEqual(['https://b.example']);
  });

  it('clear() calls aegis and syncs the returned (emptied) list', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    await act(async () => {
      await result.current.clear();
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result.current.permissions).toEqual([]);
  });

  it('surfaces an incoming permissions.prompt event as the active prompt', async () => {
    let pushed: ((p: PermissionPrompt) => void) | undefined;
    onPrompt.mockImplementation((cb: (p: PermissionPrompt) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ requestId: 7, origin: 'https://c.example', permission: 'media' }));
    expect(result.current.prompt).toEqual({
      requestId: 7,
      origin: 'https://c.example',
      permission: 'media',
    });
  });

  it('prompt.resolve("allow") forwards requestId + decision to aegis and clears the active prompt', async () => {
    let pushed: ((p: PermissionPrompt) => void) | undefined;
    onPrompt.mockImplementation((cb: (p: PermissionPrompt) => void) => {
      pushed = cb;
      return () => {};
    });
    const refreshed: SitePermission[] = [
      ...seed,
      perm({ origin: 'https://c.example', permission: 'media', decision: 'allow' }),
    ];
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ requestId: 7, origin: 'https://c.example', permission: 'media' }));
    expect(result.current.prompt).not.toBeNull();
    await act(async () => {
      await result.current.resolve('allow');
    });
    expect(resolve).toHaveBeenCalledWith(7, 'allow');
    expect(result.current.prompt).toBeNull();
  });

  it('resolve() refreshes the remembered list (a remembered grant now appears)', async () => {
    let pushed: ((p: PermissionPrompt) => void) | undefined;
    onPrompt.mockImplementation((cb: (p: PermissionPrompt) => void) => {
      pushed = cb;
      return () => {};
    });
    const refreshed: SitePermission[] = [
      ...seed,
      perm({ origin: 'https://c.example', permission: 'media', decision: 'allow' }),
    ];
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    act(() => pushed!({ requestId: 9, origin: 'https://c.example', permission: 'media' }));
    await act(async () => {
      await result.current.resolve('allow');
    });
    await waitFor(() => expect(result.current.permissions).toHaveLength(3));
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.permissions[2].origin).toBe('https://c.example');
  });

  it('resolve() is a no-op when there is no active prompt', async () => {
    const { result } = renderHook(() => usePermissions());
    await waitFor(() => expect(result.current.permissions).toHaveLength(2));
    await act(async () => {
      await result.current.resolve('deny');
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('unsubscribes from onPrompt on unmount', async () => {
    const unsubscribe = vi.fn();
    onPrompt.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => usePermissions());
    await waitFor(() => expect(onPrompt).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
