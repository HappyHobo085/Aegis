// src/hooks/subscribeBeforeFetch.test.tsx
//
// BUG(F2): every seeding hook used to dispatch its INITIAL FETCH first and subscribe
// afterwards. `aegis.X.onState(cb)` reaches the core through an async `listen()`, but the
// backend listener is only registered when the `listen` IPC is PROCESSED — and both
// requests ride the same transport, so the core handled the seed fetch strictly before the
// subscription existed. Any state event emitted in that window was LOST PERMANENTLY: no
// subscriber, and nothing that refetches behind it.
//
// This class of bug is invisible to the rest of the suite because `vitest.setup.ts` mocks
// `listen` as `vi.fn().mockResolvedValue(...)` — a microtask, i.e. a ZERO-width window. The
// harness below models the transport honestly instead:
//
//   * requests are DISPATCHED synchronously and PROCESSED strictly in dispatch order;
//   * a `listen` request registers its backend listener at PROCESS time;
//   * the transition is emitted after the FIRST queued request is processed and before the
//     rest — i.e. exactly "between the fetch being sent and the subscribe resolving";
//   * the seed fetch's own answer flips to the post-transition value the moment the event is
//     emitted, so it can never MASK a lost update (and, conversely, the pre-transition answer
//     is what a late subscription is stuck with).
//
// So each case passes iff the hook dispatched its subscription first. Swap the two
// statements in any hook listed below and its case fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAdblock } from './useAdblock';
import { useDownloads } from './useDownloads';
import { usePermissions } from './usePermissions';
import { useProxy } from './useProxy';
import { useSync } from './useSync';
import { useTabs } from './useTabs';
import { useZoom } from './useZoom';

// ── The queued transport ──────────────────────────────────────────────────────

type BackendListener = (payload: unknown) => void;

/** Per-test transport, installed by `installTransport` and read by the mocked `aegis`. */
const t = vi.hoisted(() => ({
  seed: (): Promise<unknown> => Promise.resolve({}),
  subscribe:
    (_name: string, _cb: (payload: unknown) => void): (() => void) =>
    () => {},
}));

/** Requests waiting to be processed, in dispatch order. */
let queue: (() => void)[] = [];
/** Backend listeners, by event name, registered at PROCESS time. */
const backend = new Map<string, Set<BackendListener>>();

/**
 * The mocked `aegis`. Event names are the logical (dotted) names from `shared/types.ts`;
 * `tauriInvoke.on` is what translates them to Tauri's `:` form, and that translation happens
 * on the way OUT of the real `ipcClient`, which these cases bypass on purpose.
 */
vi.mock('../lib/ipcClient', () => ({
  aegis: {
    tabs: {
      list: () => t.seed(),
      onState: (cb: BackendListener) => t.subscribe('tabs.state', cb),
    },
    sync: {
      getState: () => t.seed(),
      onState: (cb: BackendListener) => t.subscribe('sync.state', cb),
      onChanged: (cb: BackendListener) => t.subscribe('sync.changed', cb),
    },
    proxy: {
      getState: () => t.seed(),
      onState: (cb: BackendListener) => t.subscribe('proxy.state', cb),
    },
    adblock: {
      getState: () => t.seed(),
      onBlockedCount: (cb: BackendListener) => t.subscribe('adblock.blockedCount', cb),
    },
    zoom: {
      get: () => t.seed(),
      onChanged: (cb: BackendListener) => t.subscribe('zoom.changed', cb),
    },
    permissions: {
      list: () => t.seed(),
      onPrompt: (cb: BackendListener) => t.subscribe('permissions.prompt', cb),
    },
    downloads: {
      list: () => t.seed(),
      onChanged: (cb: BackendListener) => t.subscribe('downloads.changed', cb),
    },
  },
}));

/** Point the mocked `aegis` at a fresh backend snapshot for one test. */
function installTransport(before: unknown, after: unknown): () => void {
  let answer = before;
  t.seed = () =>
    new Promise((resolve) => {
      queue.push(() => resolve(answer));
    });
  t.subscribe = (name, cb) => {
    let cancelled = false;
    queue.push(() => {
      const set = backend.get(name) ?? new Set<BackendListener>();
      backend.set(name, set);
      set.add(cb);
      if (cancelled) set.delete(cb);
    });
    return () => {
      cancelled = true;
      backend.get(name)?.delete(cb);
    };
  };
  // The core has now transitioned, so subsequent seed answers carry the new value.
  return () => {
    answer = after;
  };
}

/** Process exactly `n` queued requests, flushing the microtask queue after each. */
async function process(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const work = queue.shift();
    if (!work) return;
    await act(async () => {
      work();
    });
    await act(async () => {});
  }
}

/** Process everything queued, including requests enqueued while processing. */
async function drain(): Promise<void> {
  // Bounded so a hook that refetches in a loop cannot hang the suite.
  for (let guard = 0; queue.length > 0 && guard < 50; guard++) {
    await process(1);
  }
}

/**
 * The backend emits `name` — delivered ONLY to the listeners registered so far.
 *
 * The payload is passed unwrapped, exactly as `tauriInvoke.on` does it
 * (`listen(name, (e) => cb(e.payload))`), so the hook sees the same value it would in the app.
 */
function emit(name: string, payload: unknown): void {
  act(() => {
    backend.get(name)?.forEach((cb) => cb(payload));
  });
}

// ── Cases ─────────────────────────────────────────────────────────────────────

interface Case {
  name: string;
  /** The core's answer before the transition. */
  before: unknown;
  /** The core's answer after the transition. */
  after: unknown;
  /** The event the hook must be subscribed to before its seed is processed. */
  event: string;
  /** The payload the backend emits mid-flight. */
  eventPayload: unknown;
  /** Mount the hook — its effect dispatches the seed + the subscription. */
  mount(): { unmount(): void; latest(): unknown };
  /** Read the observable the event drives. */
  read(result: unknown): unknown;
  /** What `read` must return after the event was live. */
  expected: unknown;
  /** What `read` returns if the event was LOST — must differ from `expected`. */
  lost: unknown;
}

const TAB = (title: string) => ({
  id: 1,
  pinned: false,
  live: true,
  title,
  url: 'https://example.com',
  private: false,
});

const SYNC_ENABLED = {
  enabled: true,
  status: 'idle',
  serverUrl: 'https://sync.example',
  lastSyncMs: 0,
  lastError: '',
  deviceId: 'dev-1',
  accountId: 'acct-1',
  vaultBacking: 'keychain',
  hasStoredRoot: true,
};
const SYNC_DISABLED = { ...SYNC_ENABLED, enabled: false, status: 'disabled' };

const PROXY_OFF = {
  mode: 'off',
  scheme: 'http',
  host: '',
  port: 8080,
  bypassHosts: [],
  active: false,
  uri: null,
};
const PROXY_ON = { ...PROXY_OFF, mode: 'proxy', host: 'p.example', active: true };

const ADBLOCK_IDLE = { enabled: true, allowlistedHosts: [], sessionBlocked: 0, pageBlocked: 0 };
const ADBLOCK_BUSY = { ...ADBLOCK_IDLE, sessionBlocked: 3, pageBlocked: 3 };

const CASES: Case[] = [
  {
    name: 'useTabs — a tabs.state emitted mid-seed is not lost',
    before: { tabs: [TAB('stale title')], activeId: 1 },
    after: { tabs: [TAB('live title')], activeId: 1 },
    event: 'tabs.state',
    eventPayload: { tabs: [TAB('live title')], activeId: 1 },
    mount: () => {
      const r = renderHook(() => useTabs());
      return { unmount: r.unmount, latest: () => r.result.current.tabs[0]?.title };
    },
    read: (r) => r,
    expected: 'live title',
    lost: 'stale title',
  },
  {
    name: 'useSync — a sync.state emitted mid-seed is not lost (the stranded-setup-view case)',
    before: SYNC_DISABLED,
    after: SYNC_ENABLED,
    event: 'sync.state',
    eventPayload: SYNC_ENABLED,
    mount: () => {
      const r = renderHook(() => useSync());
      return { unmount: r.unmount, latest: () => r.result.current.state.enabled };
    },
    read: (r) => r,
    expected: true,
    lost: false,
  },
  {
    name: 'useProxy — a proxy.state emitted mid-seed is not lost',
    before: PROXY_OFF,
    after: PROXY_ON,
    event: 'proxy.state',
    eventPayload: PROXY_ON,
    mount: () => {
      const r = renderHook(() => useProxy());
      return { unmount: r.unmount, latest: () => r.result.current.state.host };
    },
    read: (r) => r,
    expected: 'p.example',
    lost: '',
  },
  {
    name: 'useAdblock — a blockedCount emitted mid-seed is not lost',
    before: ADBLOCK_IDLE,
    after: ADBLOCK_BUSY,
    event: 'adblock.blockedCount',
    eventPayload: { viewId: 1, page: 3, session: 3 },
    mount: () => {
      const r = renderHook(() => useAdblock(1, 'https://example.com'));
      return { unmount: r.unmount, latest: () => r.result.current.page };
    },
    read: (r) => r,
    expected: 3,
    lost: 0,
  },
  {
    name: 'useZoom — a zoom.changed emitted mid-seed is not lost',
    before: { viewId: 1, factor: 1 },
    after: { viewId: 1, factor: 1.5 },
    event: 'zoom.changed',
    eventPayload: { viewId: 1, factor: 1.5 },
    mount: () => {
      const r = renderHook(() => useZoom(1));
      return { unmount: r.unmount, latest: () => r.result.current.factor };
    },
    read: (r) => r,
    expected: 1.5,
    lost: 1,
  },
  {
    name: 'usePermissions — a permission prompt emitted mid-seed is not lost',
    before: [],
    after: [],
    event: 'permissions.prompt',
    eventPayload: { requestId: 'req-1', origin: 'https://example.com', permission: 'geolocation' },
    mount: () => {
      const r = renderHook(() => usePermissions());
      return { unmount: r.unmount, latest: () => r.result.current.prompt?.requestId };
    },
    read: (r) => r,
    expected: 'req-1',
    lost: undefined,
  },
  {
    name: 'useDownloads — a downloads.changed emitted mid-seed is not lost',
    before: [{ id: 1, filename: 'old.bin' }],
    after: [{ id: 1, filename: 'new.bin' }],
    event: 'downloads.changed',
    eventPayload: undefined,
    mount: () => {
      const r = renderHook(() => useDownloads());
      return { unmount: r.unmount, latest: () => r.result.current.downloads[0]?.filename };
    },
    read: (r) => r,
    expected: 'new.bin',
    lost: 'old.bin',
  },
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('seeding hooks subscribe BEFORE they fetch (F2)', () => {
  beforeEach(() => {
    backend.clear();
    queue = [];
  });

  afterEach(() => {
    backend.clear();
    queue = [];
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const transitionOver = installTransport(c.before, c.after);
      const hook = c.mount();
      expect(queue.length).toBeGreaterThan(0);

      // Process the FIRST dispatched request only, then let the core emit the transition:
      // an event arriving between the fetch being sent and the subscribe landing.
      await process(1);
      expect(c.read(hook.latest())).not.toEqual(c.expected);

      transitionOver();
      emit(c.event, c.eventPayload);
      await drain();

      expect(c.read(hook.latest())).toEqual(c.expected);
      // Sanity: the "lost" value is genuinely different, so the assertion above has teeth.
      expect(c.lost).not.toEqual(c.expected);
      hook.unmount();
    });
  }
});
