// electron/main/permissions.ts
import type { PermissionsRepo } from './db/permissionsRepo';
import { resolvePermission, originOf, PHASE5_PERMISSIONS } from './permissionsHelpers';

// Re-export the pure helpers so the contract's "helpers live in permissions.ts"
// surface holds (implemented + unit-tested in permissionsHelpers.ts).
export { resolvePermission, originOf } from './permissionsHelpers';

export interface WirePermissionsOpts {
  permissionsRepo: PermissionsRepo;
  /** Raise a prompt to the chrome renderer; resolves with the user's choice. */
  prompt: (origin: string, permission: string) => Promise<'allow' | 'deny'>;
}

/**
 * RE-SET both content-session permission handlers (last-set wins over the
 * ViewController deny floor). Request: a remembered decision is honored; else an
 * in-set permission prompts the renderer (persisting + answering the original
 * callback with the result); everything else is denied. Check: returns true only
 * for a remembered allow (deny-by-default).
 */
export function wirePermissions(session: Electron.Session, opts: WirePermissionsOpts): void {
  const { permissionsRepo, prompt } = opts;

  session.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = originOf((details as { requestingUrl?: string }).requestingUrl ?? '');
    const remembered = permissionsRepo.get(origin, permission);
    const resolution = resolvePermission(remembered, PHASE5_PERMISSIONS.has(permission));
    if ('decision' in resolution) {
      callback(resolution.decision === 'allow');
      return;
    }
    if ('deny' in resolution) {
      callback(false);
      return;
    }
    // prompt path
    void prompt(origin, permission).then((decision) => {
      permissionsRepo.set(origin, permission, decision);
      callback(decision === 'allow');
    });
  });

  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permissionsRepo.get(requestingOrigin, permission) === 'allow';
  });
}
