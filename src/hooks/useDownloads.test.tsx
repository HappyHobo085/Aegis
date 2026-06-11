// src/hooks/useDownloads.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { DownloadEntry } from '../../shared/types';

const list = vi.fn();
const remove = vi.fn();
const clear = vi.fn();
const openFile = vi.fn();
const showInFolder = vi.fn();
const cancel = vi.fn();
const onChanged = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    downloads: {
      list: (...a: any[]) => list(...a),
      remove: (...a: any[]) => remove(...a),
      clear: (...a: any[]) => clear(...a),
      openFile: (...a: any[]) => openFile(...a),
      showInFolder: (...a: any[]) => showInFolder(...a),
      cancel: (...a: any[]) => cancel(...a),
      onChanged: (cb: () => void) => onChanged(cb),
    },
  },
}));

import { useDownloads } from './useDownloads';

const dl = (over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id: 1,
  url: 'https://example.com/file.zip',
  filename: 'file.zip',
  savePath: '/home/u/Downloads/file.zip',
  state: 'progressing',
  receivedBytes: 0,
  totalBytes: 1000,
  startedAt: 1000,
  ...over,
});

const seed: DownloadEntry[] = [
  dl({ id: 2, filename: 'b.zip', state: 'progressing', receivedBytes: 500, totalBytes: 1000 }),
  dl({ id: 1, filename: 'a.zip', state: 'completed', receivedBytes: 1000, totalBytes: 1000 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  remove.mockResolvedValue(seed);
  clear.mockResolvedValue([]);
  openFile.mockResolvedValue(undefined);
  showInFolder.mockResolvedValue(undefined);
  cancel.mockResolvedValue(undefined);
  onChanged.mockReturnValue(() => {});
});

describe('useDownloads', () => {
  it('seeds downloads from aegis.downloads.list on mount', async () => {
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.downloads[0].filename).toBe('b.zip');
  });

  it('subscribes to onChanged and re-fetches the list when the event fires', async () => {
    let pushed: (() => void) | undefined;
    onChanged.mockImplementation((cb: () => void) => {
      pushed = cb;
      return () => {};
    });
    const refreshed: DownloadEntry[] = [
      dl({ id: 2, filename: 'b.zip', state: 'completed', receivedBytes: 1000, totalBytes: 1000 }),
    ];
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      pushed!();
    });
    await waitFor(() => expect(result.current.downloads).toHaveLength(1));
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.downloads[0].state).toBe('completed');
  });

  it('remove() calls aegis with the id and re-fetches the list', async () => {
    remove.mockResolvedValue([seed[0]]);
    list.mockResolvedValueOnce(seed).mockResolvedValue([seed[0]]);
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.remove(1);
    });
    expect(remove).toHaveBeenCalledWith(1);
    expect(result.current.downloads.map((d) => d.id)).toEqual([2]);
  });

  it('clear() calls aegis and re-fetches the (emptied) list', async () => {
    list.mockResolvedValueOnce(seed).mockResolvedValue([]);
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.clear();
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result.current.downloads).toEqual([]);
  });

  it('openFile() delegates to aegis.downloads.openFile with the id', async () => {
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.openFile(2);
    });
    expect(openFile).toHaveBeenCalledWith(2);
  });

  it('showInFolder() delegates to aegis.downloads.showInFolder with the id', async () => {
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.showInFolder(2);
    });
    expect(showInFolder).toHaveBeenCalledWith(2);
  });

  it('cancel() delegates to aegis.downloads.cancel with the id and re-fetches the list', async () => {
    list.mockResolvedValueOnce(seed).mockResolvedValue([
      dl({ id: 2, filename: 'b.zip', state: 'cancelled', receivedBytes: 500, totalBytes: 1000 }),
      seed[1],
    ]);
    const { result } = renderHook(() => useDownloads());
    await waitFor(() => expect(result.current.downloads).toHaveLength(2));
    await act(async () => {
      await result.current.cancel(2);
    });
    expect(cancel).toHaveBeenCalledWith(2);
    await waitFor(() => expect(result.current.downloads[0].state).toBe('cancelled'));
  });

  it('unsubscribes from onChanged on unmount', async () => {
    const unsubscribe = vi.fn();
    onChanged.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useDownloads());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
