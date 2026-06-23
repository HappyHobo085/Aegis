// src/lib/ipcClient.test.ts
// Verifies that aegis.zoom.* routes to the correct IPC channels with the correct
// payloads. Mirror of the channel-routing assertion pattern established for other
// ipcClient namespaces.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ---------------------------------------------------------------------------
// Android bridge: adblock.onBlockedCount
// ---------------------------------------------------------------------------
describe('aegis.adblock.onBlockedCount Android branch', () => {
  // Install a minimal AegisAndroid stub before each test so androidBridge() returns truthy.
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).AegisAndroid = { navigate: vi.fn() };
    // Clean up any previously installed globals.
    delete (window as unknown as Record<string, unknown>).__aegisBlockedCount;
    delete (window as unknown as Record<string, unknown>).__aegisBlockedCountCbs;
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).AegisAndroid;
    delete (window as unknown as Record<string, unknown>).__aegisBlockedCount;
    delete (window as unknown as Record<string, unknown>).__aegisBlockedCountCbs;
  });

  it('installs window.__aegisBlockedCount when AegisAndroid is present', () => {
    const cb = vi.fn();
    aegis.adblock.onBlockedCount(cb);
    expect(typeof (window as unknown as Record<string, unknown>).__aegisBlockedCount).toBe(
      'function',
    );
  });

  it('invokes the subscriber callback with the BlockedCount payload', () => {
    const cb = vi.fn();
    aegis.adblock.onBlockedCount(cb);
    const payload = { viewId: 1, page: 42, session: 100 };
    (
      window as unknown as {
        __aegisBlockedCount: (c: { viewId: number; page: number; session: number }) => void;
      }
    ).__aegisBlockedCount(payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('unsubscribe removes the callback so it is no longer invoked', () => {
    const cb = vi.fn();
    const unsub = aegis.adblock.onBlockedCount(cb);
    unsub();
    const payload = { viewId: 1, page: 5, session: 10 };
    (
      window as unknown as {
        __aegisBlockedCount: (c: { viewId: number; page: number; session: number }) => void;
      }
    ).__aegisBlockedCount(payload);
    expect(cb).not.toHaveBeenCalled();
  });

  it('supports multiple subscribers — all are called, each unsubscribes independently', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = aegis.adblock.onBlockedCount(cb1);
    aegis.adblock.onBlockedCount(cb2);
    const payload = { viewId: 1, page: 1, session: 1 };
    (
      window as unknown as {
        __aegisBlockedCount: (c: { viewId: number; page: number; session: number }) => void;
      }
    ).__aegisBlockedCount(payload);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    // Unsubscribe cb1; cb2 should still fire.
    unsub1();
    (
      window as unknown as {
        __aegisBlockedCount: (c: { viewId: number; page: number; session: number }) => void;
      }
    ).__aegisBlockedCount(payload);
    expect(cb1).toHaveBeenCalledTimes(1); // not called again
    expect(cb2).toHaveBeenCalledTimes(2);
  });
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
