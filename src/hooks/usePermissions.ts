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
} {
  const [permissions, setPermissions] = useState<SitePermission[]>([]);
  // FIFO queue of pending prompts; the head is the one on screen (audit 5.2). A second prompt
  // used to REPLACE the first, so the first request was never answered.
  const [queue, setQueue] = useState<PermissionPrompt[]>([]);
  const prompt = queue[0] ?? null;

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
      // A duplicate delivery of an already-queued request is not shown twice.
      setQueue((q) => (q.some((x) => x.requestId === p.requestId) ? q : [...q, p]));
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
      // Dequeue optimistically so the dialog moves on immediately (to the next queued prompt,
      // if any); the resolve round-trip then persists the decision and refresh() pulls the
      // freshly remembered (origin, permission) row into the list.
      setQueue((q) => q.filter((x) => x.requestId !== active.requestId));
      await aegis.permissions.resolve(active.requestId, decision);
      await refresh();
    },
    [refresh],
  );

  return { permissions, prompt, remove, clear, resolve };
}
