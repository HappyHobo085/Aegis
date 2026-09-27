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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { useAdblock } from './useAdblock';
import { useAutofillSave } from './useAutofillSave';
import { useCustomFilters } from './useCustomFilters';
import { useDownloads } from './useDownloads';
import { useHistory } from './useHistory';
import { useNav } from './useNav';
import { usePermissions } from './usePermissions';
import { useProxy } from './useProxy';
import { useSafety } from './useSafety';
import { useSubscriptions } from './useSubscriptions';
import { useSync } from './useSync';
import { useTabs } from './useTabs';
import { useUpdate } from './useUpdate';
import { useVault } from './useVault';
import { useZoom } from './useZoom';

// ── The queued transport ──────────────────────────────────────────────────────

type BackendListener = (payload: unknown) => void;

/**
 * A queued request, tagged with what it is. The tag is what lets the DERIVED guard assert a
 * single uniform property — "the first thing a mounting hook dispatches is a subscribe" —
 * without every case needing its own observable.
 */
type Queued = { kind: 'sub'; run(): void } | { kind: 'fetch'; run(): void };

/** Per-test transport, installed by `installTransport` and read by the mocked `aegis`. */
const t = vi.hoisted(() => ({
  seed: (): Promise<unknown> => Promise.resolve({}),
  subscribe:
    (_name: string, _cb: (payload: unknown) => void): (() => void) =>
    () => {},
}));

/** Requests waiting to be processed, in dispatch order. */
let queue: Queued[] = [];
/** Backend listeners, by event name, registered at PROCESS time. */
const backend = new Map<string, Set<BackendListener>>();

/** The hook directory the derived guard reads to rebuild its own list. */
const HOOKS_DIR = path.dirname(new URL(import.meta.url).pathname);

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
    nav: {
      getState: () => t.seed(),
      onState: (cb: BackendListener) => t.subscribe('nav.state', cb),
    },
    settings: {
      get: () => t.seed(),
    },
    safety: {
      getState: () => t.seed(),
      onInterstitial: (cb: BackendListener) => t.subscribe('safety.interstitial', cb),
    },
    update: {
      getState: () => t.seed(),
      onState: (cb: BackendListener) => t.subscribe('update.state', cb),
      checkNow: () => t.seed(),
    },
    vault: {
      getState: () => t.seed(),
      onState: (cb: BackendListener) => t.subscribe('vault.state', cb),
      autofillSuggestions: () => t.seed(),
    },
    form: {
      onWillSubmit: (cb: BackendListener) => t.subscribe('form.willSubmit', cb),
    },
    customFilters: {
      get: () => t.seed(),
    },
    picker: {
      onPicked: (cb: BackendListener) => t.subscribe('picker.picked', cb),
    },
    subs: {
      list: () => t.seed(),
      onChanged: (cb: BackendListener) => t.subscribe('subs.changed', cb),
    },
    history: {
      list: () => t.seed(),
      onChanged: (cb: BackendListener) => t.subscribe('history.changed', cb),
    },
  },
}));

/** Point the mocked `aegis` at a fresh backend snapshot for one test. */
function installTransport(before: unknown, after: unknown): () => void {
  let answer = before;
  t.seed = () =>
    new Promise((resolve) => {
      queue.push({
        kind: 'fetch',
        run: () => resolve(answer),
      });
    });
  t.subscribe = (name, cb) => {
    let cancelled = false;
    queue.push({
      kind: 'sub',
      run: () => {
        const set = backend.get(name) ?? new Set<BackendListener>();
        backend.set(name, set);
        set.add(cb);
        if (cancelled) set.delete(cb);
      },
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
      work.run();
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
  /**
   * The hook's source stem (`useTabs`), which is how the DERIVED guard below matches a case
   * against a file in `src/hooks/`. It is not decoration: a case whose `hook` does not name a
   * real file is a case that can never be reached by a regression, and a file with no case is
   * a hook nothing holds to this rule.
   */
  hook: string;
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
    hook: 'useTabs',
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
    hook: 'useSync',
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
    hook: 'useProxy',
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
    hook: 'useAdblock',
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
    hook: 'useZoom',
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
    hook: 'usePermissions',
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
    hook: 'useDownloads',
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
  // ── The second wave: these seven had NO case, and six of the seven seed FIRST ──
  {
    hook: 'useNav',
    name: 'useNav — a nav.state emitted mid-seed is not lost (the address bar goes stale)',
    before: { viewId: 1, url: 'https://stale.test/', title: 'stale', canGoBack: false },
    after: { viewId: 1, url: 'https://live.test/', title: 'live', canGoBack: false },
    event: 'nav.state',
    eventPayload: { viewId: 1, url: 'https://live.test/', title: 'live', canGoBack: false },
    mount: () => {
      const r = renderHook(() => useNav(1));
      return { unmount: r.unmount, latest: () => r.result.current.state.title };
    },
    read: (r) => r,
    expected: 'live',
    lost: 'stale',
  },
  {
    hook: 'useSafety',
    name: 'useSafety — a safety.interstitial emitted mid-seed is not lost',
    before: null,
    after: { url: 'https://bad.test/', reason: 'malware' },
    event: 'safety.interstitial',
    eventPayload: { url: 'https://bad.test/', reason: 'malware' },
    mount: () => {
      const r = renderHook(() => useSafety());
      return { unmount: r.unmount, latest: () => r.result.current.interstitial?.reason };
    },
    read: (r) => r,
    expected: 'malware',
    lost: undefined,
  },
  {
    hook: 'useUpdate',
    name: 'useUpdate — an update.state emitted mid-seed is not lost',
    before: { status: 'idle', version: null, percent: 0, error: null },
    after: { status: 'downloading', version: '9.9.9', percent: 42, error: null },
    event: 'update.state',
    eventPayload: { status: 'downloading', version: '9.9.9', percent: 42, error: null },
    mount: () => {
      const r = renderHook(() => useUpdate());
      return { unmount: r.unmount, latest: () => r.result.current.state.percent };
    },
    read: (r) => r,
    expected: 42,
    lost: 0,
  },
  {
    hook: 'useVault',
    name: 'useVault — a vault.state emitted mid-seed is not lost (an unlock is not lost)',
    before: { exists: true, unlocked: false, count: 0, undecryptable: 0, syncEnabled: false },
    after: { exists: true, unlocked: true, count: 3, undecryptable: 0, syncEnabled: false },
    event: 'vault.state',
    eventPayload: { exists: true, unlocked: true, count: 3, undecryptable: 0, syncEnabled: false },
    mount: () => {
      const r = renderHook(() => useVault());
      return { unmount: r.unmount, latest: () => r.result.current.state.unlocked };
    },
    read: (r) => r,
    expected: true,
    lost: false,
  },
  {
    hook: 'useCustomFilters',
    // NOT the `onSyncChange` subscription — that is a local synchronous bus, so it has no
    // window. It is `picker.onPicked`, an async `listen()`, and the hook's own comment already
    // names the resulting bug: an open "My Filters" panel keeps showing pre-pick text.
    name: 'useCustomFilters — a picker.picked emitted mid-seed is not lost',
    before: '||old.test^',
    after: '||old.test^\n||picked.test^',
    event: 'picker.picked',
    eventPayload: undefined,
    mount: () => {
      const r = renderHook(() => useCustomFilters());
      return { unmount: r.unmount, latest: () => r.result.current.text };
    },
    read: (r) => r,
    expected: '||old.test^\n||picked.test^',
    lost: '||old.test^',
  },
  {
    hook: 'useSubscriptions',
    name: 'useSubscriptions — a subs.changed emitted mid-seed is not lost',
    before: [{ listId: 'l1', url: 'https://a.test/list.txt', enabled: false }],
    after: [{ listId: 'l1', url: 'https://a.test/list.txt', enabled: true }],
    event: 'subs.changed',
    eventPayload: undefined,
    mount: () => {
      const r = renderHook(() => useSubscriptions());
      return { unmount: r.unmount, latest: () => r.result.current.subs[0]?.enabled };
    },
    read: (r) => r,
    expected: true,
    lost: false,
  },
  {
    hook: 'useHistory',
    name: 'useHistory — a history.changed emitted mid-seed is not lost',
    before: [{ id: 1, url: 'https://stale.test/', title: 'stale', visitedAt: 1 }],
    after: [{ id: 2, url: 'https://live.test/', title: 'live', visitedAt: 2 }],
    event: 'history.changed',
    eventPayload: undefined,
    mount: () => {
      const r = renderHook(() => useHistory());
      return { unmount: r.unmount, latest: () => r.result.current.entries[0]?.title };
    },
    read: (r) => r,
    expected: 'live',
    lost: 'stale',
  },
  {
    // Already correctly ordered (its `vault.getState` lives INSIDE the subscription callback,
    // not on the mount path), so this case passes as shipped. It is a REGRESSION guard, NOT a
    // defect witness — kept because the derived guard below requires a case for the file, and a
    // case that is allowed to be trivially true is still better than an unheld hook.
    hook: 'useAutofillSave',
    name: 'useAutofillSave — subscribes before it reads (regression guard, already ordered)',
    before: { exists: true, unlocked: true, count: 1, undecryptable: 0, syncEnabled: false },
    after: { exists: true, unlocked: true, count: 1, undecryptable: 0, syncEnabled: false },
    event: 'form.willSubmit',
    eventPayload: { username: 'u', password: 'p', origin: 'https://example.com' },
    mount: () => {
      const r = renderHook(() => useAutofillSave());
      return { unmount: r.unmount, latest: () => r.result.current.pending?.username };
    },
    read: (r) => r,
    expected: 'u',
    lost: undefined,
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

  // The UNIFORM property, stated once for every hook in the table: whatever else a hook does on
  // mount, the FIRST request it puts on the transport must be a subscription. It needs no
  // per-hook observable, so it covers hooks whose seed feeds a shape this file never reads.
  for (const c of CASES) {
    it(`${c.hook} — its first request on mount is a subscribe, not a fetch`, () => {
      installTransport(c.before, c.after);
      const hook = c.mount();
      expect(queue.length).toBeGreaterThan(0);
      expect(queue[0].kind).toBe('sub');
      hook.unmount();
    });
  }
});

// ── The DERIVED guard: this list must not be hand-maintained ──────────────────
//
// The seven original cases were a hand-written list, which is exactly the shape that goes stale:
// a new seeding hook is added, it is correct today, and nothing holds it to the rule tomorrow.
// So the SET is re-derived from the source tree and compared.
//
// The scan is deliberately a SUPERSET, never the ordering assertion. Textual position cannot
// decide ordering — `useDownloads` has a `// BUG(F2): … the `downloads.list` round-trip …`
// comment above its subscribe, and a naive scan reads that comment as a seed that precedes it.
// Comments are stripped for that reason. Even after stripping, the scan is allowed to over- or
// under-report a POSITION, so it is only ever used to demand a case; a false positive costs an
// extra case, a false negative is the one thing that would matter, and a hook that both reads a
// seed and registers an `aegis.*.on*` cannot hide from it.
describe('the seeding-hook list is derived, not hand-maintained', () => {
  /** Remove comments so prose about a bug is not mistaken for the bug. */
  function stripComments(src: string): string {
    return (
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // A line comment only where `//` cannot be part of a URL scheme (`https://`).
        .split('\n')
        .map((line) => (/[^:]\/\//.test(line) ? line.replace(/[^:]\/\/.*$/, '') : line))
        .join('\n')
    );
  }

  const SEED = /aegis\.[A-Za-z0-9_]+\.(getState|get|list)\s*\(/;
  const ASYNC_SUB = /aegis\.[A-Za-z0-9_]+\.on[A-Z][A-Za-z0-9_]*\s*\(/;

  /** Every hook file that seeds from the core AND subscribes to a core event. */
  function seedingHookFiles(): string[] {
    return fs
      .readdirSync(HOOKS_DIR)
      .filter((f) => /^use[A-Z].*\.ts$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => {
        const src = stripComments(fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8'));
        return SEED.test(src) && ASYNC_SUB.test(src);
      })
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
  }

  it('every hook that seeds and subscribes has a case here', () => {
    const covered = new Set(CASES.map((c) => c.hook));
    const missing = seedingHookFiles().filter((h) => !covered.has(h));
    expect(missing).toEqual([]);
  });

  it('every case names a hook file that exists (a typoed case holds nothing)', () => {
    const onDisk = new Set(
      fs
        .readdirSync(HOOKS_DIR)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => f.replace(/\.ts$/, '')),
    );
    const bogus = CASES.map((c) => c.hook).filter((h) => !onDisk.has(h));
    expect(bogus).toEqual([]);
  });

  it('the derived set is non-empty, so the guard above cannot pass by scanning nothing', () => {
    // The anti-vacuity proof for the completeness test: a filter typo turns the scan into an
    // empty list, and an empty list satisfies "every hook has a case" for ever.
    expect(seedingHookFiles().length).toBeGreaterThanOrEqual(CASES.length);
  });
});
