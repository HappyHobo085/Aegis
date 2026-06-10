// electron/main/ipc/permissions.ts
import { IPC } from '../../../shared/types';
import type { SitePermission } from '../../../shared/types';
import type { PermissionsRepo } from '../db/permissionsRepo';

/**
 * Builds the permissions IPC handler map (channel -> handler), args WITHOUT the
 * event. list/remove/clear manage remembered grants; resolve carries the
 * renderer's answer to a pending prompt back to the main pending-Map (resolvePrompt
 * is provided by buildPromptBridge in boot).
 */
export function buildPermissionsHandlers(
  permissionsRepo: PermissionsRepo,
  opts: { resolvePrompt: (requestId: number, decision: 'allow' | 'deny') => void },
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.permissionsList]: (): SitePermission[] => permissionsRepo.list(),
    [IPC.permissionsRemove]: (origin: string, permission: string): SitePermission[] => {
      permissionsRepo.remove(origin, permission);
      return permissionsRepo.list();
    },
    [IPC.permissionsClear]: (): SitePermission[] => {
      permissionsRepo.clear();
      return permissionsRepo.list();
    },
    [IPC.permissionsResolve]: (requestId: number, decision: 'allow' | 'deny'): void => {
      opts.resolvePrompt(requestId, decision);
    },
  };
}

/**
 * The main-side prompt bridge: a pending-Map correlating prompt request ids to
 * their pending resolvers. `prompt(origin, permission)` emits a permissions.prompt
 * event (via emit) with a fresh request id and returns a Promise the renderer
 * resolves through permissions.resolve → resolvePrompt(requestId, decision).
 */
export function buildPromptBridge(
  emit: (payload: { requestId: number; origin: string; permission: string }) => void,
): {
  prompt: (origin: string, permission: string) => Promise<'allow' | 'deny'>;
  resolvePrompt: (requestId: number, decision: 'allow' | 'deny') => void;
} {
  let nextId = 1;
  const pending = new Map<number, (decision: 'allow' | 'deny') => void>();
  return {
    prompt: (origin, permission) =>
      new Promise<'allow' | 'deny'>((resolve) => {
        const requestId = nextId++;
        pending.set(requestId, resolve);
        emit({ requestId, origin, permission });
      }),
    resolvePrompt: (requestId, decision) => {
      const resolve = pending.get(requestId);
      if (resolve) {
        pending.delete(requestId);
        resolve(decision);
      }
    },
  };
}
