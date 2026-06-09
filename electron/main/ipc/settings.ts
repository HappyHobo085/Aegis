// electron/main/ipc/settings.ts
import { IPC } from '../../../shared/types';
import type { Settings } from '../../../shared/types';
import type { SettingsRepo } from '../db/settingsRepo';

/**
 * Builds the settings IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it).
 */
export function buildSettingsHandlers(
  settingsRepo: SettingsRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.settingsGet]: (): Settings => settingsRepo.get(),
    [IPC.settingsSet]: (partial: Partial<Settings>): Settings => settingsRepo.set(partial),
  };
}
