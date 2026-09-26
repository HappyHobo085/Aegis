// src/hooks/usePermissions.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SitePermission, PermissionPrompt, PermissionDecision } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function usePermissions(): {
  permissions: SitePermission[];
  prompt: PermissionPrompt | null;
  remove(origin: string, permission: string): Promise<void>;
  clear(): Promise<void>;
  resolve(decision: PermissionDecision): Promise<void>;
  /** Autopilot seeding only — directly sets the permissions list without an IPC round-trip. */
  _setPermissions(permissions: SitePermission[]): void;
} {
  const [permissions, setPermissions] = useState<SitePermission[]>([]);
  const [prompt, setPrompt] = useState<PermissionPrompt | null>(null);

  // Read the active prompt at call time inside resolve() without re-binding the
  // callback on every prompt change (mirrors useAdblock's urlRef pattern).
  const promptRef = useRef<PermissionPrompt | null>(prompt);
  promptRef.current = prompt;

  const refresh = useCallback(async (): Promise<void> => {
    setPermissions(await aegis.permissions.list());
  }, []);

  useEffect(() => {
    let active = true;
    // BUG(F2): subscribe BEFORE the seed fetch. `permissions.onPrompt` registers its backend
    // listener only when the `listen` IPC is processed, so a prompt emitted while the
    // `permissions.list` round-trip was still queued used to be dropped on the floor and
    // never re-surfaced — the user never saw the permission dialog at all.
    const unsubscribe = aegis.permissions.onPrompt((p: PermissionPrompt) => {
      setPrompt(p);
    });
    void aegis.permissions.list().then((next) => {
      if (active) setPermissions(next);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const remove = useCallback(async (origin: string, permission: string): Promise<void> => {
    setPermissions(await aegis.permissions.remove(origin, permission));
  }, []);

  const clear = useCallback(async (): Promise<void> => {
    setPermissions(await aegis.permissions.clear());
  }, []);

  const resolve = useCallback(
    async (decision: PermissionDecision): Promise<void> => {
      const active = promptRef.current;
      if (active === null) return;
      // Clear optimistically so the dialog dismisses immediately; the resolve
      // round-trip then persists the decision and refresh() pulls the freshly
      // remembered (origin, permission) row into the list.
      setPrompt(null);
      await aegis.permissions.resolve(active.requestId, decision);
      await refresh();
    },
    [refresh],
  );

  return { permissions, prompt, remove, clear, resolve, _setPermissions: setPermissions };
}
