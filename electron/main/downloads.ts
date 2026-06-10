// electron/main/downloads.ts
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DownloadEntry } from '../../shared/types';
import type { DownloadsRepo } from './db/downloadsRepo';
import type { SettingsRepo } from './db/settingsRepo';
import { uniquifyFilename, resolveDownloadDir } from './downloadsHelpers';

// Re-export the pure helpers so the contract's "helpers live in downloads.ts"
// surface holds (they are implemented + unit-tested in downloadsHelpers.ts).
export { uniquifyFilename, resolveDownloadDir } from './downloadsHelpers';

export interface WireDownloadsOpts {
  downloadsRepo: DownloadsRepo;
  settingsRepo: SettingsRepo;
  onChanged: () => void;
  liveItems: Map<number, Electron.DownloadItem>;
}

/**
 * Attach the real download pipeline to a session. On will-download (a SESSION
 * event in Electron 42) the save path is resolved + set SYNCHRONOUSLY in the
 * callback (required by Electron), a DownloadsRepo row is recorded, the live item
 * is tracked for cancel(), and progress/final state are persisted with onChanged()
 * pushes so an open Downloads panel refreshes.
 */
export function wireDownloads(session: Electron.Session, opts: WireDownloadsOpts): void {
  const { downloadsRepo, settingsRepo, onChanged, liveItems } = opts;

  session.on('will-download', (_event, item) => {
    const dir = resolveDownloadDir(settingsRepo.get().downloadDir, app.getPath('downloads'));
    const savePath = uniquifyFilename(join(dir, item.getFilename()), existsSync);
    // setSavePath MUST be called synchronously inside this callback.
    item.setSavePath(savePath);

    const row = downloadsRepo.record({
      url: item.getURL(),
      filename: item.getFilename(),
      savePath,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
    });
    liveItems.set(row.id, item);

    const persist = (state: DownloadEntry['state']): void => {
      downloadsRepo.update(row.id, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state,
      });
      onChanged();
    };

    item.on('updated', (_e, state) => persist(state));
    item.on('done', (_e, state) => {
      persist(state);
      liveItems.delete(row.id);
    });
  });
}
