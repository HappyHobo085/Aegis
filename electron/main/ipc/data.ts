// electron/main/ipc/data.ts
import { dialog } from 'electron';
import { writeFile, readFile } from 'node:fs/promises';
import { IPC } from '../../../shared/types';
import type { ImportMode } from '../../../shared/types';
import type { FavoritesRepo } from '../db/favoritesRepo';
import type { HistoryRepo } from '../db/historyRepo';
import type { SavedRepo } from '../db/savedRepo';
import type { SettingsRepo } from '../db/settingsRepo';
import { validateExport, planImport } from '../dataPort';
import type { ExportPayload } from '../dataPort';

export interface DataRepos {
  favoritesRepo: FavoritesRepo;
  historyRepo: HistoryRepo;
  savedRepo: SavedRepo;
  settingsRepo: SettingsRepo;
}

const JSON_FILTER = [{ name: 'JSON', extensions: ['json'] }];

/**
 * Builds the data export/import IPC handler map (channel -> handler), args WITHOUT
 * the event. Export serializes favorites+history+saved+settings to a save-dialog
 * path; import open-dialogs + validates + plans (pure dataPort) then applies the
 * chosen mode. History inserts preserve visitedAt via record(entry, ()=>visitedAt).
 */
export function buildDataHandlers(
  repos: DataRepos,
  win: Electron.BaseWindow,
): Record<string, (...a: any[]) => any> {
  const { favoritesRepo, historyRepo, savedRepo, settingsRepo } = repos;

  return {
    [IPC.dataExport]: async (): Promise<{ ok: boolean; path?: string }> => {
      const payload: ExportPayload = {
        version: 1,
        favorites: favoritesRepo.list(),
        history: historyRepo.list({ limit: 100000 }),
        saved: savedRepo.list(),
        settings: settingsRepo.get(),
      };
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: 'aegis-export.json',
        filters: JSON_FILTER,
      });
      if (canceled || !filePath) return { ok: false };
      await writeFile(filePath, JSON.stringify(payload, null, 2));
      return { ok: true, path: filePath };
    },

    [IPC.dataImport]: async (
      mode: ImportMode,
    ): Promise<{ ok: boolean; counts?: { favorites: number; history: number; saved: number }; error?: string }> => {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: JSON_FILTER,
      });
      if (canceled || filePaths.length === 0) return { ok: false };

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePaths[0], 'utf-8'));
      } catch {
        return { ok: false, error: 'unreadable file' };
      }
      const valid = validateExport(parsed);
      if (!valid.ok) return { ok: false, error: valid.error };

      const existing = {
        favorites: favoritesRepo.list(),
        saved: savedRepo.list(),
        historyUrls: new Set(historyRepo.list({ limit: 100000 }).map((h) => h.url)),
      };
      const plan = planImport(valid.payload, existing, mode);

      if (plan.replace) {
        favoritesRepo.clear();
        savedRepo.clear();
        historyRepo.clear();
      }
      for (const f of plan.favorites) favoritesRepo.add({ name: f.name, url: f.url, tags: f.tags });
      for (const s of plan.saved) savedRepo.add({ url: s.url, title: s.title });
      for (const h of plan.history) historyRepo.record({ url: h.url, title: h.title }, () => h.visitedAt);
      settingsRepo.set(plan.settings);

      return { ok: true, counts: plan.counts };
    },
  };
}
