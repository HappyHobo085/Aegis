// src/hooks/useWorkspaces.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Workspace, WorkspaceState } from '../../shared/types';

const list = vi.fn();
const create = vi.fn();
const switchFn = vi.fn();
const rename = vi.fn();
const setColor = vi.fn();
const remove = vi.fn();
const reorder = vi.fn();
const onState = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    workspace: {
      list: (...a: any[]) => list(...a),
      create: (...a: any[]) => create(...a),
      switch: (...a: any[]) => switchFn(...a),
      rename: (...a: any[]) => rename(...a),
      setColor: (...a: any[]) => setColor(...a),
      remove: (...a: any[]) => remove(...a),
      reorder: (...a: any[]) => reorder(...a),
      onState: (...a: any[]) => onState(...a),
    },
  },
}));

import { useWorkspaces } from './useWorkspaces';

const defaultWorkspace: Workspace = {
  id: 'default',
  name: 'General',
  color: 'slate',
  tabIndex: 0,
};

const work2: Workspace = {
  id: 'ws-2',
  name: 'Work',
  color: 'blue',
  tabIndex: 1,
};

const baseState: WorkspaceState = {
  workspaces: [defaultWorkspace, work2],
  activeWorkspaceId: 'default',
};

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(baseState);
  create.mockResolvedValue({ id: 'ws-3', name: 'New', color: 'green', tabIndex: 2 });
  switchFn.mockResolvedValue({ tabs: [], activeId: 1 });
  rename.mockResolvedValue({ ...work2, name: 'Renamed' });
  setColor.mockResolvedValue({ ...work2, color: 'red' });
  remove.mockResolvedValue({ tabs: [], activeId: 1 });
  reorder.mockResolvedValue([work2, defaultWorkspace]);
  onState.mockReturnValue(() => {});
});

describe('useWorkspaces', () => {
  it('seeds workspace list from aegis.workspace.list on mount', async () => {
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.workspaces[0].id).toBe('default');
    expect(result.current.activeWorkspaceId).toBe('default');
  });

  it('handles list returning WorkspaceState shape (with activeWorkspaceId)', async () => {
    list.mockResolvedValue(baseState);
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    expect(result.current.activeWorkspaceId).toBe('default');
  });

  it('handles list returning plain Workspace[] shape (fallback)', async () => {
    list.mockResolvedValue([defaultWorkspace, work2]);
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    // activeWorkspaceId stays default when list returns array shape
    expect(result.current.activeWorkspaceId).toBe('default');
  });

  it('create calls aegis.workspace.create', async () => {
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    await act(async () => result.current.create('New', 'green'));
    expect(create).toHaveBeenCalledWith('New', 'green');
  });

  it('switch calls aegis.workspace.switch', async () => {
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    await act(async () => result.current.switch('ws-2'));
    expect(switchFn).toHaveBeenCalledWith('ws-2');
  });

  it('rename calls aegis.workspace.rename', async () => {
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    await act(async () => result.current.rename('ws-2', 'Renamed'));
    expect(rename).toHaveBeenCalledWith('ws-2', 'Renamed');
  });

  it('setColor calls aegis.workspace.setColor', async () => {
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    await act(async () => result.current.setColor('ws-2', 'red'));
    expect(setColor).toHaveBeenCalledWith('ws-2', 'red');
  });

  it('remove calls aegis.workspace.remove', async () => {
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    await act(async () => result.current.remove('ws-2'));
    expect(remove).toHaveBeenCalledWith('ws-2');
  });

  it('reorder calls aegis.workspace.reorder', async () => {
    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));
    await act(async () => result.current.reorder(['ws-2', 'default']));
    expect(reorder).toHaveBeenCalledWith(['ws-2', 'default']);
  });

  it('subscribes to workspace.state events', async () => {
    renderHook(() => useWorkspaces());
    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
    expect(onState).toHaveBeenCalledWith(expect.any(Function));
  });

  it('updates state when onState callback fires', async () => {
    let stateCb: (ws: WorkspaceState) => void = () => {};
    onState.mockImplementation((cb: (ws: WorkspaceState) => void) => {
      stateCb = cb;
      return () => {};
    });

    const { result } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(result.current.workspaces).toHaveLength(2));

    // Simulate a workspace.state event
    const newState: WorkspaceState = {
      workspaces: [
        defaultWorkspace,
        work2,
        { id: 'ws-3', name: 'New', color: 'green', tabIndex: 2 },
      ],
      activeWorkspaceId: 'ws-2',
    };
    act(() => stateCb(newState));

    expect(result.current.workspaces).toHaveLength(3);
    expect(result.current.activeWorkspaceId).toBe('ws-2');
  });

  it('cleans up on unmount without error', async () => {
    const { unmount } = renderHook(() => useWorkspaces());
    await waitFor(() => expect(list).toHaveBeenCalled());
    unmount();
    // No assertion needed — just verify no crash / stale setState after unmount.
  });
});
