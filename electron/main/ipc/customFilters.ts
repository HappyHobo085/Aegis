// electron/main/ipc/customFilters.ts
import { IPC } from '../../../shared/types';
import type { CustomFiltersRepo } from '../db/customFiltersRepo';

/**
 * Builds the custom-filters (my-filters) IPC handler map (channel -> handler).
 * Handlers receive the invoke args WITHOUT the event (the guard strips it).
 * Saving persists the blob then rebuilds the engine from the on-disk list cache
 * (the new blob is folded in by assembleEngineTexts) so the rules take effect on
 * the NEXT navigation. set returns the stored text so the renderer syncs.
 */
export function buildCustomFiltersHandlers(
  repo: CustomFiltersRepo,
  opts: { rebuildFromCache(): void },
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.customFiltersGet]: (): string => repo.get(),
    [IPC.customFiltersSet]: (text: string): string => {
      repo.set(text);
      opts.rebuildFromCache();
      return repo.get();
    },
  };
}
