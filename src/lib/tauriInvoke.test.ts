// src/lib/tauriInvoke.test.ts
//
// The ONE transport both IPC directions ride. `ipcClient.test.ts` mocks this whole
// module, so nothing else covers the two things only it can get wrong:
//
//  1. Every renderer→core call is `invoke('ipc', {channel, payload})` — Tauri command
//     ids cannot contain '.', so a channel must never be used as a command name.
//  2. `on()` translates '.' → ':' because Tauri 2 FORBIDS dots in event names, and it
//     must also tear down a subscription that is torn down BEFORE `listen` resolves
//     (the "subscribe before you seed" race the repo documents in
//     `hooks/subscribeBeforeFetch.test.tsx`).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { call, on } from './tauriInvoke';

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('call', () => {
  it('routes the channel through the single `ipc` command, never as a command id', async () => {
    invokeMock.mockResolvedValue(undefined);
    await call('nav.navigate', { url: 'https://example.com' });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('ipc', {
      channel: 'nav.navigate',
      payload: { url: 'https://example.com' },
    });
  });

  // The payload key is always present: a `payload: undefined` reaches Rust as a
  // missing key, and every `payload.get(...)` in the dispatcher then sees a null that
  // the arm did not intend. Normalising here keeps the Rust side's shape assumption.
  it('sends an empty payload object when none is given', async () => {
    invokeMock.mockResolvedValue(undefined);
    await call('tab.close');
    expect(invokeMock).toHaveBeenCalledWith('ipc', { channel: 'tab.close', payload: {} });
  });

  it('preserves a falsy-but-present payload', async () => {
    invokeMock.mockResolvedValue(undefined);
    await call('zoom.set', { factor: 0 });
    expect(invokeMock).toHaveBeenCalledWith('ipc', { channel: 'zoom.set', payload: { factor: 0 } });
  });

  it('resolves with the deserialized value the core returned', async () => {
    invokeMock.mockResolvedValue({ id: 7, private: true });
    await expect(call<{ id: number; private: boolean }>('tabs.get')).resolves.toEqual({
      id: 7,
      private: true,
    });
  });

  it('propagates a rejected invoke (a refusing channel must not look like success)', async () => {
    invokeMock.mockRejectedValue('form.detectLoginForm is not available on this platform');
    await expect(call('form.detectLoginForm')).rejects.toBe(
      'form.detectLoginForm is not available on this platform',
    );
  });
});

describe('on', () => {
  it('registers the event with `.` translated to `:` (Tauri 2 forbids dots)', () => {
    listenMock.mockResolvedValue(() => {});
    on('nav.state', () => {});
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0][0]).toBe('nav:state');
  });

  it('translates EVERY dot in a nested event name, not just the first', () => {
    listenMock.mockResolvedValue(() => {});
    on('a.b.c', () => {});
    expect(listenMock.mock.calls[0][0]).toBe('a:b:c');
  });

  it('leaves a dot-free event name alone', () => {
    listenMock.mockResolvedValue(() => {});
    on('ready', () => {});
    expect(listenMock.mock.calls[0][0]).toBe('ready');
  });

  it('unwraps the Tauri event envelope and hands the callback the payload', async () => {
    listenMock.mockResolvedValue(() => {});
    const cb = vi.fn();
    on('nav.state', cb);
    // Invoke the registered handler the way Tauri's event system does.
    listenMock.mock.calls[0][1]?.({ payload: { url: 'https://example.com' } } as never);
    expect(cb).toHaveBeenCalledWith({ url: 'https://example.com' });
  });

  it('unsubscribes through the handle listen() resolved', () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const off = on('nav.state', () => {});
    // The unlisten handle only exists after the listen promise settles.
    return Promise.resolve().then(() => {
      off();
      expect(unlisten).toHaveBeenCalledTimes(1);
    });
  });

  // The whole reason `cancelled` exists: a component that unsubscribes in its cleanup
  // while `listen` is still in flight would otherwise leak a live backend listener that
  // nothing can ever remove (every later `off()` is a no-op, the handle having been
  // dropped). This is the leak the "subscribe before you seed" ordering depends on.
  it('unlistens a subscription torn down BEFORE listen() resolved', async () => {
    const unlisten = vi.fn();
    let release: ((u: () => void) => void) | undefined;
    listenMock.mockReturnValue(
      new Promise<() => void>((resolve) => {
        release = resolve;
      }),
    );
    const off = on('nav.state', () => {});
    off(); // torn down while listen is still pending
    expect(unlisten, 'cannot have run yet — the handle does not exist').not.toHaveBeenCalled();
    release?.(unlisten); // listen finally resolves
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten, 'the late handle must still be released').toHaveBeenCalledTimes(1);
  });

  // Every effect cleanup calls `off()` exactly once, but making the teardown idempotent
  // costs one line and means a double-call (StrictMode double-invoke, a retrying caller)
  // cannot release the backend listener twice.
  it('a later `off()` after the handle resolved does not unlisten twice', async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const off = on('nav.state', () => {});
    await Promise.resolve();
    off();
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
