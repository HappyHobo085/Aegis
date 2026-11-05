// src/hooks/useDownloads.ts
import { useCallback, useEffect, useRef, useState } from 'react';
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
  // Audit 5.3: every list request is numbered and only the NEWEST-issued one may land, so a
  // slow seed (or an earlier refresh) resolving after a later one cannot roll the list back.
  const seq = useRef(0);
  const latestList = useCallback(async (): Promise<DownloadEntry[] | null> => {
    const mine = ++seq.current;
    const next = await aegis.downloads.list();
    return mine === seq.current ? next : null;
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    const next = await latestList();
    if (next) setDownloads(next);
  }, [latestList]);

  useEffect(() => {
    let active = true;
    // BUG(F2): subscribe BEFORE the seed fetch. `downloads.onChanged` registers its backend
    // listener only when the `listen` IPC is processed, so a progress/done event emitted
    // while the `downloads.list` round-trip was still queued was lost — and the list fetch
    // had already snapshotted the pre-event state, so the entry stayed frozen.
    const unsubscribe = aegis.downloads.onChanged(() => {
      void refresh();
    });
    void latestList().then((next) => {
      if (active && next) setDownloads(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [refresh, latestList]);

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
