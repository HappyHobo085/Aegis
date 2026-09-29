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
import { aegis, AegisIpcError } from './ipcClient';
import { IPC } from '../../shared/types';

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockClear();
  // Default: return a ZoomState shape so the client's Promise resolves properly.
  mockInvoke.mockResolvedValue({ viewId: 1, factor: 1.0 });
});

// ---------------------------------------------------------------------------
// Android bridge: nav.home resolves the CONFIGURED home page
// ---------------------------------------------------------------------------
describe('aegis.nav.home Android branch', () => {
  // Android has no Tauri content webview, so the core's `nav.home` arm cannot run
  // there and the renderer has to resolve the home page itself. These tests pin that
  // the value it resolved is the one the user configured — and that it applies the
  // same two gates the core does, because whatever it hands the bridge IS loaded.
  const bridge = { navigate: vi.fn() };

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).AegisAndroid = bridge;
    // The bridge mock is shared by every test in this block, so its call log has to
    // be cleared here. Without this, `toHaveBeenCalledWith` would pass on a leftover
    // call from a previous test and stop meaning "this test navigated there".
    bridge.navigate.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).AegisAndroid;
  });

  /**
   * Prime the client's settings cache the way the shells do on mount, via `settings.get`.
   *
   * NOTE `settings.get` is a DEDUPED channel (a 300 ms window in `DEDUP_WINDOWS`), so this
   * helper is only usable by the FIRST test in this block -- every later `settings.get`
   * inside the same run is served the first one's cached reply, and a test would silently
   * assert the previous test's value. The other tests prime through `settings.set`, which
   * is deliberately NOT deduped (mutations are always issued) and is a real route: the
   * Home tab edits the setting this way.
   */
  const primeViaGet = (homeUrl: string) => {
    mockInvoke.mockResolvedValue({ homeUrl });
    return aegis.settings.get();
  };

  /** Prime through the non-deduped `settings.set`; the core replies with the whole object. */
  const primeViaSet = (homeUrl: string) => {
    mockInvoke.mockResolvedValue({ homeUrl });
    return aegis.settings.set({ homeUrl });
  };

  it('navigates to the configured home page, not a hardcoded about:blank', async () => {
    await primeViaGet('https://home.test/');
    await aegis.nav.home(1);
    expect(bridge.navigate).toHaveBeenCalledTimes(1);
    expect(bridge.navigate).toHaveBeenCalledWith('https://home.test/');
  });

  it('honours a home page that arrived over sync, not just one this device wrote', async () => {
    // A synced homeUrl used to display in HomeTab and then go unused on a phone. It
    // reaches the client as the full Settings object, whichever channel delivered it,
    // so both priming routes must end up in the same place.
    await primeViaSet('https://paired-device.test/start');
    await aegis.nav.home(1);
    expect(bridge.navigate).toHaveBeenCalledTimes(1);
    expect(bridge.navigate).toHaveBeenCalledWith('https://paired-device.test/start');
  });

  it('falls back to about:blank when no home page is configured', async () => {
    await primeViaSet('');
    await aegis.nav.home(1);
    expect(bridge.navigate).toHaveBeenCalledWith('about:blank');
  });

  it('refuses a non-http(s) home page, as the core does', async () => {
    // `settings::home_url` will parse this, but `nav.home` then calls
    // `require_navigable`, which allows only http, https and about:blank. A
    // settings.json written before that allowlist existed can still hold it.
    await primeViaSet('file:///etc/passwd');
    await aegis.nav.home(1);
    expect(bridge.navigate).toHaveBeenCalledWith('about:blank');
  });
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

// ---------------------------------------------------------------------------
// Rejection boundary
//
// The core returns Err(String) for ORDINARY conditions — the vault is locked,
// the proxy is unreachable. Those used to reach the
// renderer as a bare string thrown from ~58 uncaught `void aegis.*` sites, with
// nothing catching them: the only handler was the ErrorBoundary, which replaces
// the WHOLE chrome, so a locked vault could blank the entire window. Every
// channel now routes through one `call()` that wraps the rejection in a typed
// AegisIpcError, which `main.tsx` surfaces as a rate-limited toast.
// ---------------------------------------------------------------------------
describe('ipc rejection boundary', () => {
  it('wraps a core rejection in an AegisIpcError carrying the channel', async () => {
    mockInvoke.mockRejectedValueOnce('vault is locked');
    const err = await aegis.vault.list().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AegisIpcError);
    const typed = err as AegisIpcError;
    expect(typed.name).toBe('AegisIpcError');
    expect(typed.channel).toBe('vault.list');
    // Tauri rejects with the bare String a Rust Err(String) carried, so the message
    // must survive the wrapping verbatim — that string is what the user reads.
    expect(typed.message).toBe('vault is locked');
  });

  it('preserves the message when invoke rejects with an Error instead of a string', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'));
    const err = await aegis.zoom.get(1).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AegisIpcError);
    expect((err as AegisIpcError).message).toBe('boom');
  });

  it('a rejected dedupable call is not replayed to the next caller', async () => {
    // `nav.getState` is dedupable with a 100ms window. Without the rejection
    // eviction, the cached REJECTION would be handed to every caller inside that
    // window, so one transient failure (vault locked at that instant, proxy
    // briefly down) surfaced as a burst of unrelated-looking errors. The second
    // identical call must reach the backend again.
    mockInvoke.mockRejectedValueOnce('first failure');
    const first = await aegis.nav.getState(1).then(
      () => null,
      (e: unknown) => e,
    );
    expect(first).toBeInstanceOf(AegisIpcError);

    mockInvoke.mockResolvedValueOnce({ viewId: 1, url: 'https://recovered.example' });
    const second = await aegis.nav.getState(1);
    expect(second).toEqual({ viewId: 1, url: 'https://recovered.example' });
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('a RESOLVING dedupable call is still collapsed, so the optimization survives', async () => {
    // Guard against "fixing" the eviction by dropping dedup entirely: two identical
    // reads inside the window must still produce a single invoke.
    //
    // Uses `history.search` rather than `nav.getState` because the dedup cache is
    // module-global and outlives an individual test — the preceding test leaves a
    // RESOLVED `nav.getState` entry behind, which would be served from cache here
    // and make the invoke count 0. Each test needs a channel nothing else touched.
    mockInvoke.mockResolvedValue([]);
    await aegis.history.search('dedup-probe');
    await aegis.history.search('dedup-probe');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Android bridge: the find.* channels are the FALLBACK
// ---------------------------------------------------------------------------
describe('aegis.find.* with no AegisAndroid bridge', () => {
  // The premise the core's `find::dispatch` refusal rests on, pinned as an executable
  // fact. `ipcClient` routes `find.*` to the Kotlin bridge whenever `window.AegisAndroid`
  // exists, and this file's own module-level comment records that the bridge "is injected
  // slightly later" than module load — so a `find.start` issued before injection finds no
  // bridge and falls through to the `findStart` CHANNEL, on a phone, where the core has no
  // native find implementation. These tests assert that fallthrough really issues the
  // channel (rather than swallowing the call), which is what makes the core's refusal
  // reachable instead of theoretical.
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).AegisAndroid;
  });

  it.each([
    ['start', IPC.findStart, () => aegis.find.start(1, 'needle')],
    ['next', IPC.findNext, () => aegis.find.next(1)],
    ['prev', IPC.findPrev, () => aegis.find.prev(1)],
    ['close', IPC.findClose, () => aegis.find.close(1)],
  ])('find.%s issues the %s channel when there is no bridge', async (_name, channel, run) => {
    expect((window as unknown as Record<string, unknown>).AegisAndroid).toBeUndefined();
    await run();
    expect(mockInvoke).toHaveBeenCalledWith('ipc', expect.objectContaining({ channel }));
  });
});
