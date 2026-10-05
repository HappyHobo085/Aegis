// src/lib/surfaceApi.test.ts
//
// The surface's whole backend surface: three capability grants, one event in, one command
// out. The tests here pin the two things that are invisible in the app — the exact wire
// shape of `popover_picked`, and the fact that this module never routes through `ipc`.
//
// The `ipc` assertion matters more than it looks. If this module grew an `ipc` call, the
// surface would be invoking app commands it has no permission for — the call would fail at
// runtime with "Command ipc not allowed by ACL", which in a webview that renders a
// dropdown means a silently dead popover rather than an error anyone sees.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { picked, ready, start } from './surfaceApi';
import type { PopoverSurfacePayload } from '../../shared/types';

const mockInvoke = invoke as ReturnType<typeof vi.fn>;
const mockListen = listen as ReturnType<typeof vi.fn>;

const PAYLOAD: PopoverSurfacePayload = {
  id: 'address-omnibox',
  rect: { x: 120, y: 44, width: 640, height: 312 },
  payload: { kind: 'address-omnibox', items: [{ title: 'a' }] },
};

beforeEach(() => {
  mockInvoke.mockClear();
  mockListen.mockClear();
  mockInvoke.mockResolvedValue(undefined);
  mockListen.mockResolvedValue(() => {});
});

describe('the popover surface api', () => {
  it('listens for the payload on the WIRE name, with dots translated to colons', () => {
    // Tauri 2 rejects a '.' in an event name outright, so a listener registered on the
    // shared dotted name would never fire — the surface would sit blank and there would be
    // no error anywhere.
    start(() => {});
    expect(mockListen).toHaveBeenCalledTimes(1);
    expect(mockListen.mock.calls[0][0]).toBe('popover:payload');
  });

  it('delivers the payload to its subscriber', () => {
    const got: PopoverSurfacePayload[] = [];
    start((p: PopoverSurfacePayload) => got.push(p));
    const handler = mockListen.mock.calls[0][1] as (e: { payload: unknown }) => void;
    handler({ payload: PAYLOAD });
    expect(got).toStrictEqual([PAYLOAD]);
  });

  // THE ORDERING CONTRACT. `emit_to` is fire-and-forget, so a payload emitted before this
  // listener exists is lost permanently — which is what happens at every launch without the
  // handshake. Sending `ready()` BEFORE `listen()` resolves would reproduce the exact race the
  // handshake exists to close, and it is invisible in the app: the surface sits at the right
  // rect and stays empty.
  it('announces readiness only AFTER the backend listener is live', async () => {
    const order: string[] = [];
    let resolveListen: ((u: () => void) => void) | undefined;
    mockListen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );
    mockInvoke.mockImplementation((cmd: string) => {
      order.push(cmd);
      return Promise.resolve(undefined);
    });
    start(() => {});
    await Promise.resolve();
    // `listen` is still in flight, so nothing may have been announced yet.
    expect(order, 'ready() was called before listen() resolved').toEqual([]);
    resolveListen?.(() => {});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['popover_ready']);
  });

  it('releases the backend listener exactly once, even on a double teardown', async () => {
    // `listen` resolves its handle asynchronously, and every effect cleanup calls the
    // unsubscribe exactly once — but a double call (a StrictMode double-invoke, a retrying
    // caller) must not release the same backend listener twice.
    const unlisten = vi.fn();
    mockListen.mockResolvedValue(unlisten);
    const off = start(() => {});
    await Promise.resolve();
    off();
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  /// A StrictMode double-mount tears the subscription down while `listen` is still in flight.
  /// The handle exists only afterwards, so releasing it in the async continuation is the
  /// whole difference between a clean teardown and a live backend listener nothing can remove.
  it('releases a listener that resolves AFTER the teardown', async () => {
    const unlisten = vi.fn();
    let resolveListen: ((u: () => void) => void) | undefined;
    mockListen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );
    const off = start(() => {});
    off();
    expect(unlisten, 'the handle does not exist yet').not.toHaveBeenCalled();
    resolveListen?.(unlisten);
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten, 'the late handle must still be released').toHaveBeenCalledTimes(1);
  });

  /// A refused handshake (misconfigured capability, or no registry) must leave the surface
  /// empty rather than taking the whole webview down — a thrown error here would blank it.
  it('survives a refused handshake without throwing', async () => {
    mockInvoke.mockRejectedValueOnce('Command popover_ready not allowed by ACL');
    expect(() => start(() => {})).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockInvoke).toHaveBeenCalledWith('popover_ready');
  });

  it('ready() invokes the dedicated command with no payload', async () => {
    await ready();
    expect(mockInvoke).toHaveBeenCalledWith('popover_ready');
  });

  it('reports a pick through the dedicated command, never through ipc', async () => {
    await picked({ id: 'address-omnibox', index: 2 });
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [command, args] = mockInvoke.mock.calls[0] as [string, unknown];
    expect(command).toBe('popover_picked');
    expect(args).toStrictEqual({ id: 'address-omnibox', index: 2 });
  });

  it('omits absent optional keys instead of sending them as undefined', async () => {
    // `toStrictEqual` distinguishes `{}` from `{ index: undefined }`, so this pins the real
    // wire shape: Tauri's argument resolver reads a missing Option as None.
    await picked({ id: 'zoom-indicator', action: 'reset' });
    expect(mockInvoke.mock.calls[0][1]).toStrictEqual({
      id: 'zoom-indicator',
      action: 'reset',
    });
  });

  it('carries a value through when one is given', async () => {
    await picked({ id: 'adblock-shield', action: 'toggle-site', value: 'example.com' });
    expect(mockInvoke.mock.calls[0][1]).toStrictEqual({
      id: 'adblock-shield',
      action: 'toggle-site',
      value: 'example.com',
    });
  });

  it('never invokes the app-wide ipc chokepoint', async () => {
    // A capability hole is invisible until a user clicks something and nothing happens, so
    // this is pinned rather than reviewed. `ipcClient.ts` is deliberately not imported here:
    // this module existing at all is the reason the surface cannot reach app commands.
    await picked({ id: 'address-site', index: 0 });
    const commands = mockInvoke.mock.calls.map((c) => c[0]);
    expect(commands).not.toContain('ipc');
    expect(commands).toStrictEqual(['popover_picked']);
  });
});
