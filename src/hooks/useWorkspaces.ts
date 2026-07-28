// src/hooks/useWorkspaces.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace, WorkspaceState } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const EMPTY: WorkspaceState = {
  workspaces: [],
  activeWorkspaceId: 'default',
};

export interface UseWorkspaces {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  create(name: string, color?: string): Promise<void>;
  switch(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  setColor(id: string, color: string): Promise<void>;
  remove(id: string): Promise<void>;
  reorder(ids: string[]): Promise<void>;
}

/**
 * Owns workspace state and exposes typed mutation methods. Follows the
 * one-hook-per-domain convention — kept separate from useTabs so each
 * hook stays focused.
 *
 * Seeds from `workspace.list()` on mount, subscribes to `workspace.state`
 * events, and exposes every workspace mutation. The Rust side filters
 * `tabs_state()` by active workspace, so `useTabs` already gets the
 * correct tab list — no workspace awareness needed there.
 */
export function useWorkspaces(): UseWorkspaces {
  const [state, setState] = useState<WorkspaceState>(EMPTY);

  // Seed from workspace.list() on mount. The Rust dispatcher returns
  // workspace_state_value() which is a WorkspaceState, but the TS type
  // on the ipc client declares Workspace[] — handle both shapes at runtime.
  useEffect(() => {
    let active = true;
    void aegis.workspace
      .list()
      .then((res: unknown) => {
        if (!active) return;
        if (res && typeof res === 'object' && 'workspaces' in res && 'activeWorkspaceId' in res) {
          // Correct shape: full WorkspaceState
          const ws = res as WorkspaceState;
          setState({
            workspaces: ws.workspaces ?? [],
            activeWorkspaceId: ws.activeWorkspaceId ?? 'default',
          });
        } else if (Array.isArray(res)) {
          // Fallback: just the array — keep current activeWorkspaceId
          setState((prev) => ({
            ...prev,
            workspaces: res as Workspace[],
          }));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Subscribe to workspace.state events (the authoritative state stream)
  useEffect(() => {
    const unsub = aegis.workspace.onState((ws: WorkspaceState) => {
      setState(ws);
    });
    return unsub;
  }, []);

  // Stable refs so the callbacks never re-trigger effects
  const create = useCallback(async (name: string, color?: string) => {
    await aegis.workspace.create(name, color);
  }, []);

  const switchWs = useCallback(async (id: string) => {
    await aegis.workspace.switch(id);
    // workspace.switch also triggers workspace.state + tabs.state events,
    // so the state updates flow in naturally.
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    await aegis.workspace.rename(id, name);
  }, []);

  const setColor = useCallback(async (id: string, color: string) => {
    await aegis.workspace.setColor(id, color);
  }, []);

  const remove = useCallback(async (id: string) => {
    await aegis.workspace.remove(id);
  }, []);

  const reorder = useCallback(async (ids: string[]) => {
    await aegis.workspace.reorder(ids);
  }, []);

  return {
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    create,
    switch: switchWs,
    rename,
    setColor,
    remove,
    reorder,
  };
}
