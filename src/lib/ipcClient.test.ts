// src/lib/ipcClient.test.ts
// Verifies that aegis.zoom.* routes to the correct IPC channels with the correct
// payloads. Mirror of the channel-routing assertion pattern established for other
// ipcClient namespaces.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @tauri-apps/api/core BEFORE importing ipcClient so the module picks up the mock.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

// Mock tauriListen (used by `on()` inside tauriInvoke) so event subscriptions are no-ops.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { invoke } from '@tauri-apps/api/core';
import { aegis } from './ipcClient';

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockClear();
  // Default: return a ZoomState shape so the client's Promise resolves properly.
  mockInvoke.mockResolvedValue({ viewId: 1, factor: 1.0 });
});

describe('aegis.zoom IPC routing', () => {
  it('zoom.set calls invoke with zoom.set channel and correct payload', async () => {
    await aegis.zoom.set(1, 1.25);
    expect(mockInvoke).toHaveBeenCalledWith('ipc', {
      channel: 'zoom.set',
      payload: { viewId: 1, factor: 1.25 },
    });
  });

  it('zoom.reset delegates to zoom.set with factor 1.0', async () => {
    mockInvoke.mockResolvedValue({ viewId: 1, factor: 1.0 });
    await aegis.zoom.reset(1);
    expect(mockInvoke).toHaveBeenCalledWith('ipc', {
      channel: 'zoom.set',
      payload: { viewId: 1, factor: 1.0 },
    });
  });

  it('zoom.get calls invoke with zoom.get channel', async () => {
    await aegis.zoom.get(1);
    expect(mockInvoke).toHaveBeenCalledWith('ipc', {
      channel: 'zoom.get',
      payload: { viewId: 1 },
    });
  });
});
