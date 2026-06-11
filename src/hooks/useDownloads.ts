// src/hooks/useDownloads.ts
import { useCallback, useEffect, useState } from 'react';
import type { DownloadEntry } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useDownloads(): {
  downloads: DownloadEntry[];
  remove(id: number): Promise<void>;
  clear(): Promise<void>;
  openFile(id: number): Promise<void>;
  showInFolder(id: number): Promise<void>;
  cancel(id: number): Promise<void>;
} {
  const [downloads, setDownloads] = useState<DownloadEntry[]>([]);

  // Always re-read the authoritative list rather than trusting an action's
  // return value, so the live `downloads.changed` pushes (progress/done) and
  // the explicit actions converge on a single source of truth (mirrors
  // useHistory's refresh-on-onChanged pattern).
  const refresh = useCallback(async (): Promise<void> => {
    setDownloads(await aegis.downloads.list());
  }, []);

  useEffect(() => {
    let active = true;
    void aegis.downloads.list().then((next) => {
      if (active) setDownloads(next);
    });
    const unsubscribe = aegis.downloads.onChanged(() => {
      void refresh();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refresh]);

  const remove = useCallback(
    async (id: number): Promise<void> => {
      await aegis.downloads.remove(id);
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(async (): Promise<void> => {
    await aegis.downloads.clear();
    await refresh();
  }, [refresh]);

  const openFile = useCallback(async (id: number): Promise<void> => {
    await aegis.downloads.openFile(id);
  }, []);

  const showInFolder = useCallback(async (id: number): Promise<void> => {
    await aegis.downloads.showInFolder(id);
  }, []);

  const cancel = useCallback(
    async (id: number): Promise<void> => {
      await aegis.downloads.cancel(id);
      await refresh();
    },
    [refresh],
  );

  return { downloads, remove, clear, openFile, showInFolder, cancel };
}
