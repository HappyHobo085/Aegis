// electron/main/adblock/controller.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import type { BlockedCount } from '../../../shared/types';
import { AdblockController } from './controller';

// ---- fakes (no live Electron / no real engine) ------------------------------

type Listener = (...args: any[]) => void;
function makeWc() {
  const listeners = new Map<string, Listener[]>();
  return {
    _emit(channel: string, ...args: any[]) {
      for (const l of listeners.get(channel) ?? []) l(...args);
    },
    on(channel: string, cb: Listener) {
      const arr = listeners.get(channel) ?? [];
      arr.push(cb);
      listeners.set(channel, arr);
      return this;
    },
  };
}

// A fake ElectronBlocker exposing only the methods the controller calls. Per-
// session enablement is tracked in a Set keyed by the session object.
function makeBlocker(name: string) {
  const enabled = new Set<object>();
  return {
    _name: name,
    enableBlockingInSession: vi.fn((session: object) => {
      enabled.add(session);
    }),
    disableBlockingInSession: vi.fn((session: object) => {
      if (!enabled.has(session)) throw new Error('Trying to disable blocking which was not enabled');
      enabled.delete(session);
    }),
    isBlockingEnabled: vi.fn((session: object) => enabled.has(session)),
  };
}

function makeCounter(initial: Partial<BlockedCount> = {}) {
  const snap: BlockedCount = {
    viewId: PRIMARY_VIEW_ID,
    page: initial.page ?? 0,
    session: initial.session ?? 0,
  };
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    resetPage: vi.fn(() => {
      snap.page = 0;
    }),
    snapshot: vi.fn((): BlockedCount => ({ ...snap })),
    _setSession: (n: number) => {
      snap.session = n;
    },
  };
}

function makeRepo(initial: { enabled: boolean; allowlistedHosts: string[] }) {
  let enabled = initial.enabled;
  let hosts = [...initial.allowlistedHosts];
  return {
    getState: vi.fn(() => ({ enabled, allowlistedHosts: [...hosts] })),
    setEnabled: vi.fn((e: boolean) => {
      enabled = e;
    }),
    isAllowlisted: vi.fn((host: string) => hosts.includes(host)),
    toggleAllowlist: vi.fn((host: string) => {
      hosts = hosts.includes(host) ? hosts.filter((h) => h !== host) : [...hosts, host];
      return [...hosts];
    }),
    removeAllowlist: vi.fn((host: string) => {
      hosts = hosts.filter((h) => h !== host);
      return [...hosts];
    }),
    clearAllowlist: vi.fn(() => {
      hosts = [];
      return [...hosts];
    }),
  };
}

function build(opts?: {
  repo?: ReturnType<typeof makeRepo>;
  counter?: ReturnType<typeof makeCounter>;
  blocker?: ReturnType<typeof makeBlocker>;
  session?: object;
  onBlockedCount?: ReturnType<typeof vi.fn>;
}) {
  const repo = opts?.repo ?? makeRepo({ enabled: true, allowlistedHosts: [] });
  const counter = opts?.counter ?? makeCounter();
  const blocker = opts?.blocker ?? makeBlocker('active');
  const session = opts?.session ?? {};
  const contentWc = makeWc();
  const onBlockedCount = opts?.onBlockedCount ?? vi.fn();
  const controller = new AdblockController({
    viewId: PRIMARY_VIEW_ID,
    session: session as any,
    contentWc: contentWc as any,
    repo: repo as any,
    blocker: blocker as any,
    counter: counter as any,
    onBlockedCount,
  });
  return { controller, repo, counter, blocker, session, contentWc, onBlockedCount };
}

describe('AdblockController construction', () => {
  it('attaches the counter to the initial blocker on construction', () => {
    const { counter, blocker } = build();
    expect(counter.attach).toHaveBeenCalledWith(blocker);
  });
});

describe('AdblockController.primeFor (first-nav reconcile)', () => {
  it('enables blocking for the first nav when enabled and host not allowlisted', () => {
    const { controller, blocker, session } = build();
    controller.primeFor('https://example.com/');
    expect(blocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(blocker.isBlockingEnabled(session)).toBe(true);
  });

  it('does NOT enable blocking when globally disabled', () => {
    const { controller, blocker, session } = build({
      repo: makeRepo({ enabled: false, allowlistedHosts: [] }),
    });
    controller.primeFor('https://example.com/');
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(false);
  });

  it('does NOT enable blocking when the host is allowlisted', () => {
    const { controller, blocker, session } = build({
      repo: makeRepo({ enabled: true, allowlistedHosts: ['example.com'] }),
    });
    controller.primeFor('https://example.com/path');
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(false);
  });
});

describe('AdblockController did-start-navigation reconcile gating', () => {
  it('reconciles + resets page on a main-frame, non-same-document navigation', () => {
    const { controller, contentWc, counter, blocker, session } = build();
    contentWc._emit('did-start-navigation', {
      url: 'https://example.com/',
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(blocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(counter.resetPage).toHaveBeenCalledTimes(1);
  });

  it('ignores sub-frame navigations (no reconcile, no resetPage)', () => {
    const { contentWc, counter, blocker } = build();
    contentWc._emit('did-start-navigation', {
      url: 'https://ads.example/',
      isMainFrame: false,
      isSameDocument: false,
    });
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(counter.resetPage).not.toHaveBeenCalled();
  });

  it('ignores same-document (SPA) navigations', () => {
    const { contentWc, counter, blocker } = build();
    contentWc._emit('did-start-navigation', {
      url: 'https://example.com/page2',
      isMainFrame: true,
      isSameDocument: true,
    });
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(counter.resetPage).not.toHaveBeenCalled();
  });
});

describe('AdblockController did-stop-loading push', () => {
  it('pushes the counter snapshot on did-stop-loading', () => {
    const counter = makeCounter({ page: 3, session: 11 });
    const onBlockedCount = vi.fn();
    const { contentWc } = build({ counter, onBlockedCount });
    contentWc._emit('did-stop-loading');
    expect(onBlockedCount).toHaveBeenCalledWith({ viewId: PRIMARY_VIEW_ID, page: 3, session: 11 });
  });
});

describe('AdblockController setEnabled / toggleAllowlist / getState', () => {
  it('setEnabled persists via repo and returns the new AdblockState', () => {
    const counter = makeCounter({ session: 7 });
    const { controller, repo } = build({ counter });
    const state = controller.setEnabled(false);
    expect(repo.setEnabled).toHaveBeenCalledWith(false);
    expect(state).toEqual({ enabled: false, allowlistedHosts: [], sessionBlocked: 7 });
  });

  it('setEnabled does NOT change session blocking until the next navigation', () => {
    const { controller, blocker, session } = build();
    controller.primeFor('https://example.com/'); // blocking on
    expect(blocker.isBlockingEnabled(session)).toBe(true);
    controller.setEnabled(false); // persisted, not applied yet
    expect(blocker.disableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(true);
    // next nav applies it
    blocker.disableBlockingInSession.mockClear();
    (controller as any).reconcile('https://example.com/');
    expect(blocker.disableBlockingInSession).toHaveBeenCalledWith(session);
    expect(blocker.isBlockingEnabled(session)).toBe(false);
  });

  it('toggleAllowlist persists via repo and returns the new AdblockState', () => {
    const counter = makeCounter({ session: 2 });
    const { controller, repo } = build({ counter });
    const state = controller.toggleAllowlist('example.com');
    expect(repo.toggleAllowlist).toHaveBeenCalledWith('example.com');
    expect(state).toEqual({
      enabled: true,
      allowlistedHosts: ['example.com'],
      sessionBlocked: 2,
    });
  });

  it('getState composes repo state with the live session count', () => {
    const counter = makeCounter({ session: 42 });
    const { controller } = build({
      counter,
      repo: makeRepo({ enabled: true, allowlistedHosts: ['x.test'] }),
    });
    expect(controller.getState()).toEqual({
      enabled: true,
      allowlistedHosts: ['x.test'],
      sessionBlocked: 42,
    });
  });

  it('snapshotCount returns the counter snapshot', () => {
    const counter = makeCounter({ page: 5, session: 9 });
    const { controller } = build({ counter });
    expect(controller.snapshotCount()).toEqual({ viewId: PRIMARY_VIEW_ID, page: 5, session: 9 });
  });

  it('isBlockingActive reflects whether the session has blocking enabled', () => {
    const { controller, session, blocker } = build();
    expect(controller.isBlockingActive()).toBe(false);
    controller.primeFor('https://example.com/');
    expect(controller.isBlockingActive()).toBe(true);
    expect(blocker.isBlockingEnabled(session)).toBe(true);
  });
});

describe('AdblockController engine swap', () => {
  it('on next nav: disables old (if enabled), detaches counter from old, attaches to new, then re-enables', () => {
    const oldBlocker = makeBlocker('old');
    const newBlocker = makeBlocker('new');
    const counter = makeCounter();
    const session = {};
    const { controller } = build({ blocker: oldBlocker, counter, session });
    controller.primeFor('https://example.com/'); // old enabled
    expect(oldBlocker.isBlockingEnabled(session)).toBe(true);
    counter.attach.mockClear();

    controller.setPendingBlocker(newBlocker as any);
    (controller as any).reconcile.mock; // no-op reference for clarity

    // simulate the next navigation boundary
    (controller.contentWc as any)._emit?.('did-start-navigation', {
      url: 'https://example.com/',
      isMainFrame: true,
      isSameDocument: false,
    });

    expect(oldBlocker.disableBlockingInSession).toHaveBeenCalledWith(session);
    expect(counter.detach).toHaveBeenCalledWith(oldBlocker);
    expect(counter.attach).toHaveBeenCalledWith(newBlocker);
    // after swap, reconcile re-enables on the NEW blocker
    expect(newBlocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(newBlocker.isBlockingEnabled(session)).toBe(true);
  });

  it('swap when old blocking was disabled does NOT call disableBlockingInSession (guard)', () => {
    const oldBlocker = makeBlocker('old');
    const newBlocker = makeBlocker('new');
    const counter = makeCounter();
    const { controller } = build({
      blocker: oldBlocker,
      counter,
      repo: makeRepo({ enabled: false, allowlistedHosts: [] }),
    });
    controller.primeFor('https://example.com/'); // disabled => never enabled
    controller.setPendingBlocker(newBlocker as any);
    (controller as any).swapPendingIfAny();
    expect(oldBlocker.disableBlockingInSession).not.toHaveBeenCalled();
    expect(counter.detach).toHaveBeenCalledWith(oldBlocker);
    expect(counter.attach).toHaveBeenCalledWith(newBlocker);
  });
});

describe('AdblockController removeAllowlist / clearAllowlist (deferred reconcile)', () => {
  it('removeAllowlist persists via repo and returns the new AdblockState', () => {
    const counter = makeCounter({ session: 4 });
    const { controller, repo } = build({
      counter,
      repo: makeRepo({ enabled: true, allowlistedHosts: ['a.com', 'b.com'] }),
    });
    const state = controller.removeAllowlist('a.com');
    expect(repo.removeAllowlist).toHaveBeenCalledWith('a.com');
    expect(state).toEqual({ enabled: true, allowlistedHosts: ['b.com'], sessionBlocked: 4 });
  });

  it('clearAllowlist persists via repo and returns the new AdblockState', () => {
    const counter = makeCounter({ session: 6 });
    const { controller, repo } = build({
      counter,
      repo: makeRepo({ enabled: true, allowlistedHosts: ['a.com', 'b.com'] }),
    });
    const state = controller.clearAllowlist();
    expect(repo.clearAllowlist).toHaveBeenCalled();
    expect(state).toEqual({ enabled: true, allowlistedHosts: [], sessionBlocked: 6 });
  });

  it('removeAllowlist does NOT change session blocking until the next navigation', () => {
    const { controller, blocker, session } = build({
      repo: makeRepo({ enabled: true, allowlistedHosts: ['example.com'] }),
    });
    controller.primeFor('https://example.com/'); // allowlisted => blocking stays OFF
    expect(blocker.isBlockingEnabled(session)).toBe(false);
    controller.removeAllowlist('example.com'); // persisted, not reconciled directly
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(false);
    // next nav to the now-un-allowlisted host re-enables blocking
    (controller as any).reconcile('https://example.com/');
    expect(blocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(blocker.isBlockingEnabled(session)).toBe(true);
  });

  it('clearAllowlist does NOT change session blocking until the next navigation', () => {
    const { controller, blocker, session } = build({
      repo: makeRepo({ enabled: true, allowlistedHosts: ['example.com'] }),
    });
    controller.primeFor('https://example.com/'); // allowlisted => blocking OFF
    expect(blocker.isBlockingEnabled(session)).toBe(false);
    controller.clearAllowlist();
    expect(blocker.enableBlockingInSession).not.toHaveBeenCalled();
    expect(blocker.isBlockingEnabled(session)).toBe(false);
    (controller as any).reconcile('https://example.com/');
    expect(blocker.enableBlockingInSession).toHaveBeenCalledWith(session);
    expect(blocker.isBlockingEnabled(session)).toBe(true);
  });
});
