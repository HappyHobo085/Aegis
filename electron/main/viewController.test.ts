// electron/main/viewController.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PRIMARY_VIEW_ID } from '../../shared/types';

// ---- mock the `electron` module ----------------------------------------------
// vi.hoisted holds the shared fake-WebContents factory so the vi.mock factory
// (hoisted above imports by Vitest) can reference it without TDZ errors.
const h = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  function makeWebContents() {
    const listeners = new Map<string, Listener[]>();
    return {
      _listeners: listeners,
      _emit(channel: string, ...args: any[]) {
        for (const l of listeners.get(channel) ?? []) l(...args);
      },
      _loading: false,
      _url: '',
      _title: '',
      on(channel: string, cb: Listener) {
        const arr = listeners.get(channel) ?? [];
        arr.push(cb);
        listeners.set(channel, arr);
        return this;
      },
      loadURL: vi.fn(function (this: any, url: string) {
        this._url = url;
      }),
      reload: vi.fn(),
      stop: vi.fn(),
      isLoading() {
        return this._loading;
      },
      getURL() {
        return this._url;
      },
      getTitle() {
        return this._title;
      },
      close: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        on: vi.fn(),
      },
      setWindowOpenHandler: vi.fn(),
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        goBack: vi.fn(),
        canGoForward: vi.fn(() => false),
        goForward: vi.fn(),
      },
    };
  }
  let last: ReturnType<typeof makeWebContents> | null = null;
  let lastOpts: any = null;
  class WebContentsView {
    webContents = makeWebContents();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor(opts?: any) {
      last = this.webContents;
      lastOpts = opts;
    }
  }
  return {
    WebContentsView,
    getLastWc: () => last,
    getLastOpts: () => lastOpts,
  };
});

vi.mock('electron', () => ({
  WebContentsView: h.WebContentsView,
}));

import { ViewController } from './viewController';

function makeOpts() {
  return {
    contentPreloadPath: '/tmp/contentPreload.js',
    onState: vi.fn(),
    onFailed: vi.fn(),
    onCrashed: vi.fn(),
  };
}

describe('ViewController construction & basics', () => {
  it('creates a WebContentsView with persist:content partition and security prefs', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    expect(vc.id).toBe(PRIMARY_VIEW_ID);
    expect(vc.view).toBeDefined();
    expect(vc.view.webContents).toBe(h.getLastWc());
  });

  it('navigate() with an allowed scheme loads the URL', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    vc.navigate('https://example.com');
    expect(h.getLastWc()!.loadURL).toHaveBeenCalledWith('https://example.com');
    expect(opts.onFailed).not.toHaveBeenCalled();
  });

  it('navigate() with a rejected scheme emits onFailed(kind:load) and does not load', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    vc.navigate('file:///etc/passwd');
    expect(h.getLastWc()!.loadURL).not.toHaveBeenCalled();
    expect(opts.onFailed).toHaveBeenCalledTimes(1);
    const arg = opts.onFailed.mock.calls[0][0];
    expect(arg.kind).toBe('load');
    expect(arg.validatedURL).toBe('file:///etc/passwd');
    expect(arg.viewId).toBe(PRIMARY_VIEW_ID);
  });

  it('getState() reflects current url/title/loading', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._url = 'https://a.test/';
    wc._title = 'A';
    wc._loading = true;
    const s = vc.getState();
    expect(s).toMatchObject({
      viewId: PRIMARY_VIEW_ID,
      url: 'https://a.test/',
      title: 'A',
      isLoading: true,
      crashed: false,
    });
  });

  it('sets content webPreferences: autoplay gated + plugins enabled (PDF) + locked sandbox', () => {
    new ViewController(makeOpts());
    const prefs = h.getLastOpts()!.webPreferences;
    expect(prefs.autoplayPolicy).toBe('document-user-activation-required');
    expect(prefs.plugins).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.partition).toBe('persist:content');
  });
});

describe('ViewController nav-state events', () => {
  it('did-start-loading emits state with isLoading:true', () => {
    const opts = makeOpts();
    new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('did-start-loading');
    expect(opts.onState).toHaveBeenCalled();
    expect(opts.onState.mock.calls.at(-1)![0].isLoading).toBe(true);
  });

  it('did-navigate emits state with the new url', () => {
    const opts = makeOpts();
    new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._url = 'https://nav.test/';
    wc._emit('did-navigate', {}, 'https://nav.test/');
    expect(opts.onState.mock.calls.at(-1)![0].url).toBe('https://nav.test/');
  });

  it('did-navigate-in-page emits state with the new url (SPA, no reload)', () => {
    const opts = makeOpts();
    new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._url = 'https://spa.test/page2';
    wc._emit('did-navigate-in-page', {}, 'https://spa.test/page2', true);
    expect(opts.onState.mock.calls.at(-1)![0].url).toBe('https://spa.test/page2');
  });
});

describe('ViewController title debounce (injected timer)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('coalesces same-URL title updates into one trailing emit after 400ms', () => {
    let scheduled: { fn: () => void; ms: number } | null = null;
    const setTimer = vi.fn((fn: () => void, ms: number) => {
      scheduled = { fn, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn();
    const opts = makeOpts();
    new ViewController(opts, { setTimer, clearTimer });
    const wc = h.getLastWc()!;
    wc._url = 'https://t.test/';

    wc._emit('page-title-updated', {}, 'T1');
    wc._emit('page-title-updated', {}, 'T2');
    wc._emit('page-title-updated', {}, 'T3');

    // schedule each time, clearing the prior pending timer
    expect(setTimer).toHaveBeenCalled();
    expect(scheduled!.ms).toBe(400);
    const titleEmitsBefore = opts.onState.mock.calls.filter(
      (c) => c[0].title === 'T3',
    ).length;
    expect(titleEmitsBefore).toBe(0); // nothing fired yet

    scheduled!.fn(); // fire the trailing timer
    const last = opts.onState.mock.calls.at(-1)![0];
    expect(last.title).toBe('T3');
  });

  it('did-navigate to a new URL flushes the title immediately (no pending timer)', () => {
    let scheduled: { fn: () => void } | null = null;
    const setTimer = vi.fn((fn: () => void) => {
      scheduled = { fn };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn();
    const opts = makeOpts();
    new ViewController(opts, { setTimer, clearTimer });
    const wc = h.getLastWc()!;
    wc._url = 'https://t.test/a';
    wc._emit('page-title-updated', {}, 'pending');

    wc._url = 'https://t.test/b';
    wc._emit('did-navigate', {}, 'https://t.test/b');

    expect(clearTimer).toHaveBeenCalled();
    expect(opts.onState.mock.calls.at(-1)![0].url).toBe('https://t.test/b');
  });
});

describe('ViewController bounds & visibility', () => {
  it('setBounds forwards to the view', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    vc.setBounds({ x: 0, y: 56, width: 800, height: 544 });
    expect((vc.view.setBounds as any)).toHaveBeenCalledWith({
      x: 0,
      y: 56,
      width: 800,
      height: 544,
    });
  });

  it('setVisible updates isContentVisible and forwards to the view', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    expect(vc.isContentVisible()).toBe(true); // default visible
    vc.setVisible(false);
    expect(vc.isContentVisible()).toBe(false);
    expect((vc.view.setVisible as any)).toHaveBeenLastCalledWith(false);
  });

  it('destroy closes the content webContents', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    vc.destroy();
    expect(h.getLastWc()!.close).toHaveBeenCalled();
  });
});

describe('ViewController history & recovery (Task 11)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  it('back() goes back only when canGoBack() is true', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    (wc.navigationHistory.canGoBack as any).mockReturnValue(false);
    vc.back();
    expect(wc.navigationHistory.goBack).not.toHaveBeenCalled();

    (wc.navigationHistory.canGoBack as any).mockReturnValue(true);
    vc.back();
    expect(wc.navigationHistory.goBack).toHaveBeenCalledTimes(1);
  });

  it('forward() goes forward only when canGoForward() is true', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    (wc.navigationHistory.canGoForward as any).mockReturnValue(false);
    vc.forward();
    expect(wc.navigationHistory.goForward).not.toHaveBeenCalled();

    (wc.navigationHistory.canGoForward as any).mockReturnValue(true);
    vc.forward();
    expect(wc.navigationHistory.goForward).toHaveBeenCalledTimes(1);
  });

  it('getState() surfaces canGoBack/canGoForward from navigationHistory', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    (wc.navigationHistory.canGoBack as any).mockReturnValue(true);
    (wc.navigationHistory.canGoForward as any).mockReturnValue(true);
    const s = vc.getState();
    expect(s.canGoBack).toBe(true);
    expect(s.canGoForward).toBe(true);
  });

  it('reloadOrStop() stops when loading, reloads when idle', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    wc._loading = true;
    vc.reloadOrStop();
    expect(wc.stop).toHaveBeenCalledTimes(1);
    expect(wc.reload).not.toHaveBeenCalled();

    wc._loading = false;
    vc.reloadOrStop();
    expect(wc.reload).toHaveBeenCalledTimes(1);
  });

  it('reloadOrStop() recovery: re-shows content on the next did-start-loading and clears crashed', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;

    // simulate a prior crash hiding the content
    vc.setVisible(false);
    (vc as any).crashed = true;
    expect(vc.isContentVisible()).toBe(false);

    wc._loading = false;
    vc.reloadOrStop(); // sets pendingShowOnStart + clears crashed
    expect(vc.getState().crashed).toBe(false);

    wc._emit('did-start-loading'); // recovery re-show
    expect(vc.isContentVisible()).toBe(true);
  });
});

describe('ViewController navigation gate & failures (Task 12)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  function makeEvent() {
    return { preventDefault: vi.fn() };
  }

  it('will-navigate to a disallowed scheme is prevented', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-navigate', ev, 'file:///etc/passwd');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('will-navigate to an allowed scheme is not prevented', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-navigate', ev, 'https://ok.test/');
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('will-redirect to a disallowed scheme is prevented', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-redirect', ev, 'javascript:alert(1)');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('upgradeNavigation hook: http nav is intercepted, https form is loaded', () => {
    const upgradeNavigation = vi.fn((url: string) =>
      url.startsWith('http:') ? url.replace('http:', 'https:') : null,
    );
    new ViewController({ ...makeOptsLocal(), upgradeNavigation });
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-navigate', ev, 'http://example.com/page');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com/page');
  });

  it('upgradeNavigation hook: https nav is not intercepted (hook returns null)', () => {
    const upgradeNavigation = vi.fn((_url: string) => null);
    new ViewController({ ...makeOptsLocal(), upgradeNavigation });
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-navigate', ev, 'https://already-secure.test/');
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(wc.loadURL).not.toHaveBeenCalled();
  });

  it('upgradeNavigation hook: disallowed scheme is still blocked even if hook is present', () => {
    const upgradeNavigation = vi.fn((_url: string) => 'https://hacked.test/');
    new ViewController({ ...makeOptsLocal(), upgradeNavigation });
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-navigate', ev, 'file:///etc/passwd');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    // hook must NOT be called for blocked schemes
    expect(upgradeNavigation).not.toHaveBeenCalled();
    expect(wc.loadURL).not.toHaveBeenCalled();
  });

  it('upgradeNavigation hook on will-redirect: http redirect is upgraded to https', () => {
    const upgradeNavigation = vi.fn((url: string) =>
      url.startsWith('http:') ? url.replace('http:', 'https:') : null,
    );
    new ViewController({ ...makeOptsLocal(), upgradeNavigation });
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-redirect', ev, 'http://redirect.test/dest');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
    expect(wc.loadURL).toHaveBeenCalledWith('https://redirect.test/dest');
  });

  it('did-fail-load (main frame, load error) emits onFailed kind:load and hides content', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    // errorCode -105 (NAME_NOT_RESOLVED) is a load error
    wc._emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://bad.test/', true);
    expect(opts.onFailed).toHaveBeenCalledTimes(1);
    const f = opts.onFailed.mock.calls[0][0];
    expect(f).toMatchObject({
      viewId: 1,
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://bad.test/',
      kind: 'load',
    });
    expect(vc.isContentVisible()).toBe(false);
  });

  it('did-fail-load with a cert-range errorCode emits kind:cert', () => {
    const opts = makeOptsLocal();
    new ViewController(opts);
    const wc = h.getLastWc()!;
    // -202 (ERR_CERT_AUTHORITY_INVALID): -200 >= code > -300 => cert
    wc._emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://self.test/', true);
    expect(opts.onFailed.mock.calls[0][0].kind).toBe('cert');
  });

  it('did-fail-load on a sub-frame does NOT emit onFailed and does NOT hide', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('did-fail-load', {}, -105, 'ERR', 'https://bad.test/iframe', false);
    expect(opts.onFailed).not.toHaveBeenCalled();
    expect(vc.isContentVisible()).toBe(true);
  });

  it('did-fail-load with errorCode -3 (ERR_ABORTED) is ignored', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://x.test/', true);
    expect(opts.onFailed).not.toHaveBeenCalled();
    expect(vc.isContentVisible()).toBe(true);
  });

  it('getState().url stays at the last committed URL after a failed load (url-poisoning fix)', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._url = 'https://good.test/';
    wc._emit('did-navigate', {}, 'https://good.test/');
    expect(vc.getState().url).toBe('https://good.test/');
    // failed nav: did-navigate is NOT emitted, only did-fail-load
    wc._url = 'https://evil-cert.test/';
    wc._emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://evil-cert.test/', true);
    expect(vc.getState().url).toBe('https://good.test/');
  });
});

describe('ViewController content-session security (Task 13)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  it('registers both permission handlers that deny', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    expect(wc.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(wc.session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);

    // request handler denies via callback(false)
    const reqHandler = (wc.session.setPermissionRequestHandler as any).mock.calls[0][0];
    const cb = vi.fn();
    reqHandler(wc, 'geolocation', cb);
    expect(cb).toHaveBeenCalledWith(false);

    // check handler returns false
    const checkHandler = (wc.session.setPermissionCheckHandler as any).mock.calls[0][0];
    expect(checkHandler()).toBe(false);
  });

  it('does NOT register a will-download floor (downloads are wired in boot, Task 12)', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const onCalls = (wc.session.on as any).mock.calls;
    const willDownload = onCalls.find((c: any[]) => c[0] === 'will-download');
    expect(willDownload).toBeUndefined();
  });

  it('setWindowOpenHandler denies popunder dispositions', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const handler = (wc.setWindowOpenHandler as any).mock.calls[0][0];
    for (const disposition of ['background-tab', 'other']) {
      expect(handler({ url: 'https://ok.test/', disposition })).toEqual({ action: 'deny' });
    }
    expect(wc.loadURL).not.toHaveBeenCalled();
  });

  it('setWindowOpenHandler routes an allowed foreground new-window in-place then denies', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const handler = (wc.setWindowOpenHandler as any).mock.calls[0][0];
    const res = handler({ url: 'https://ok.test/page', disposition: 'foreground-tab' });
    expect(res).toEqual({ action: 'deny' });
    expect(wc.loadURL).toHaveBeenCalledWith('https://ok.test/page');
  });

  it('setWindowOpenHandler denies an allowed-disposition but disallowed-scheme url without loading', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const handler = (wc.setWindowOpenHandler as any).mock.calls[0][0];
    const res = handler({ url: 'javascript:alert(1)', disposition: 'new-window' });
    expect(res).toEqual({ action: 'deny' });
    expect(wc.loadURL).not.toHaveBeenCalled();
  });
});

describe('ViewController content getters (Phase 1)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  it('contentWebContents returns the content WebContents (stable identity)', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    expect(vc.contentWebContents).toBe(wc);
    // stable across calls
    expect(vc.contentWebContents).toBe(vc.contentWebContents);
  });

  it('contentSession returns the content WebContents session (stable identity)', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    expect(vc.contentSession).toBe(wc.session);
    expect(vc.contentSession).toBe(vc.contentSession);
  });
});

describe('ViewController crash & hang (Task 14)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  it('render-process-gone emits onCrashed, sets crashed, and hides content', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('render-process-gone', {}, { reason: 'crashed' });
    expect(opts.onCrashed).toHaveBeenCalledTimes(1);
    expect(opts.onCrashed.mock.calls[0][0]).toMatchObject({ viewId: 1, reason: 'crashed' });
    expect(vc.getState().crashed).toBe(true);
    expect(vc.isContentVisible()).toBe(false);
  });

  it('unresponsive emits onCrashed and hides content', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('unresponsive');
    expect(opts.onCrashed).toHaveBeenCalledTimes(1);
    expect(opts.onCrashed.mock.calls[0][0]).toMatchObject({ viewId: 1, reason: 'unresponsive' });
    expect(vc.isContentVisible()).toBe(false);
  });

  it('reloadOrStop after a crash clears the crashed flag (recovery)', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('render-process-gone', {}, { reason: 'crashed' });
    expect(vc.getState().crashed).toBe(true);

    wc._loading = false;
    vc.reloadOrStop();
    expect(vc.getState().crashed).toBe(false);

    wc._emit('did-start-loading');
    expect(vc.isContentVisible()).toBe(true);
  });
});
