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
  class WebContentsView {
    webContents = makeWebContents();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor() {
      last = this.webContents;
    }
  }
  return {
    WebContentsView,
    getLastWc: () => last,
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
