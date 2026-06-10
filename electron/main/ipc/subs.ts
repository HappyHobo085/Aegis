// electron/main/ipc/subs.ts
import { IPC } from '../../../shared/types';
import type { Subscription } from '../../../shared/types';
import type { SubsRepo } from '../db/subsRepo';

/**
 * Reuse the listManager HTTPS guard predicate: a list URL must be `https:`, unless
 * it is `http:` to a loopback host (127.0.0.1 / localhost / ::1 / [::1]) — the e2e
 * fixture case. Throws on a disallowed or unparseable URL so a bad add rejects
 * BEFORE the row is inserted (contract §6 T6). Mirrors fetchSource (listManager.ts).
 */
function assertListUrlAllowed(url: string): void {
  const parsed = new URL(url);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`Refusing non-HTTPS list URL: ${url}`);
  }
}

/**
 * Builds the subscriptions IPC handler map (channel -> handler). Handlers receive
 * the invoke args WITHOUT the event (the guard strips it). Every handler returns
 * the updated Subscription[] so the renderer syncs from the result.
 *
 * Engine-affecting mutations rebuild the live engine on the NEXT navigation:
 *  - setEnabled / remove rebuild from the on-disk list cache (no re-fetch needed).
 *  - add kicks a full refresh() because the new list must be fetched first.
 */
export function buildSubsHandlers(
  subsRepo: SubsRepo,
  opts: { rebuildFromCache(): void; refresh(): Promise<unknown> },
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.subsList]: (): Subscription[] => subsRepo.all(),
    [IPC.subsSetEnabled]: (listId: string, enabled: boolean): Subscription[] => {
      subsRepo.setEnabled(listId, enabled);
      opts.rebuildFromCache();
      return subsRepo.all();
    },
    [IPC.subsAdd]: (url: string): Subscription[] => {
      assertListUrlAllowed(url);
      subsRepo.add(url);
      void opts.refresh();
      return subsRepo.all();
    },
    [IPC.subsRemove]: (listId: string): Subscription[] => {
      subsRepo.remove(listId);
      opts.rebuildFromCache();
      return subsRepo.all();
    },
  };
}
