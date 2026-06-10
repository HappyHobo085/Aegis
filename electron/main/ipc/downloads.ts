// electron/main/ipc/downloads.ts
import { shell } from 'electron';
import { IPC } from '../../../shared/types';
import type { DownloadEntry } from '../../../shared/types';
import type { DownloadsRepo } from '../db/downloadsRepo';

/**
 * Builds the downloads IPC handler map (channel -> handler), args WITHOUT the
 * event. Mutations return the fresh DownloadEntry[]. cancel() goes through the
 * main-side liveItems map (keyed by repo id) since DownloadItem is not persisted.
 */
export function buildDownloadsHandlers(
  downloadsRepo: DownloadsRepo,
  opts: { liveItems: Map<number, Electron.DownloadItem> },
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.downloadsList]: (): DownloadEntry[] => downloadsRepo.list(),
    [IPC.downloadsRemove]: (id: number): DownloadEntry[] => {
      downloadsRepo.remove(id);
      return downloadsRepo.list();
    },
    [IPC.downloadsClear]: (): DownloadEntry[] => {
      downloadsRepo.clear();
      return downloadsRepo.list();
    },
    [IPC.downloadsOpenFile]: async (id: number): Promise<void> => {
      const row = downloadsRepo.get(id);
      if (row) await shell.openPath(row.savePath);
    },
    [IPC.downloadsShowInFolder]: (id: number): void => {
      const row = downloadsRepo.get(id);
      if (row) shell.showItemInFolder(row.savePath);
    },
    [IPC.downloadsCancel]: (id: number): void => {
      opts.liveItems.get(id)?.cancel();
    },
  };
}
