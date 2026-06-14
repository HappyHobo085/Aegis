import { useCallback, useEffect, useState } from 'react';
import type { TabsState, ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const EMPTY: TabsState = { tabs: [], activeId: 1 };

export function useTabs(): {
  tabs: TabsState['tabs'];
  activeId: ViewId;
  create(url?: string): Promise<void>;
  close(id: ViewId): Promise<void>;
  activate(id: ViewId): Promise<void>;
  reorder(ids: ViewId[]): Promise<void>;
  setPinned(id: ViewId, pinned: boolean): Promise<void>;
  reopenClosed(): Promise<void>;
} {
  const [state, setState] = useState<TabsState>(EMPTY);

  useEffect(() => {
    let active = true;
    void aegis.tabs.list().then((s) => { if (active) setState(s); });
    const off = aegis.tabs.onState((s) => setState(s));
    return () => { active = false; off(); };
  }, []);

  const create = useCallback(async (url?: string) => { setState(await aegis.tabs.create(url)); }, []);
  const close = useCallback(async (id: ViewId) => { setState(await aegis.tabs.close(id)); }, []);
  const activate = useCallback(async (id: ViewId) => { setState(await aegis.tabs.activate(id)); }, []);
  const reorder = useCallback(async (ids: ViewId[]) => { setState(await aegis.tabs.reorder(ids)); }, []);
  const setPinned = useCallback(async (id: ViewId, pinned: boolean) => { setState(await aegis.tabs.setPinned(id, pinned)); }, []);
  const reopenClosed = useCallback(async () => { setState(await aegis.tabs.reopenClosed()); }, []);

  return { tabs: state.tabs, activeId: state.activeId, create, close, activate, reorder, setPinned, reopenClosed };
}
