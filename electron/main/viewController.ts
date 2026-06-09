// electron/main/viewController.ts
import { WebContentsView } from 'electron';
import type { NavState, NavFailed, NavCrashed, ViewId } from '../../shared/types';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { isAllowedNavigationUrl } from '../lib/schemes';

const TITLE_DEBOUNCE_MS = 400;

export interface ViewControllerOpts {
  contentPreloadPath: string;
  onState: (s: NavState) => void;
  onFailed: (f: NavFailed) => void;
  onCrashed: (c: NavCrashed) => void;
}

/** Optional test-only injection: timer for the title debounce. */
export interface ViewControllerDeps {
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

export class ViewController {
  readonly id: ViewId = PRIMARY_VIEW_ID;
  readonly view: WebContentsView;

  private readonly opts: ViewControllerOpts;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;

  private visible = true;
  private crashed = false;
  private pendingShowOnStart = false;
  private loading = false;

  // title debounce state
  private titleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTitle: string | null = null;

  constructor(opts: ViewControllerOpts, deps?: ViewControllerDeps) {
    this.opts = opts;
    this.setTimer = deps?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps?.clearTimer ?? ((h) => clearTimeout(h));

    this.view = new WebContentsView({
      webPreferences: {
        preload: opts.contentPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: 'persist:content',
      },
    });

    this.wireNavEvents();
  }

  private wc() {
    return this.view.webContents;
  }

  private wireNavEvents(): void {
    const wc = this.wc();

    wc.on('did-start-loading', () => {
      this.loading = true;
      if (this.pendingShowOnStart) {
        this.pendingShowOnStart = false;
        this.setVisible(true);
      }
      this.emitState();
    });

    wc.on('did-stop-loading', () => {
      this.loading = false;
      this.emitState();
    });

    wc.on('did-navigate', () => {
      this.flushTitle();
      this.emitState();
    });

    wc.on('did-navigate-in-page', (_event: unknown, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      this.emitState();
    });

    wc.on('page-title-updated', (_event: unknown, title: string) => {
      this.scheduleTitle(title);
    });
  }

  private scheduleTitle(title: string): void {
    this.pendingTitle = title;
    if (this.titleTimer !== null) this.clearTimer(this.titleTimer);
    this.titleTimer = this.setTimer(() => {
      this.titleTimer = null;
      // Emit the trailing title BEFORE clearing pendingTitle so getState() reports it.
      this.emitState();
      this.pendingTitle = null;
    }, TITLE_DEBOUNCE_MS);
  }

  private flushTitle(): void {
    // Cancel a pending trailing-title emit WITHOUT emitting it; the caller
    // (did-navigate) emits fresh state immediately afterwards.
    if (this.titleTimer !== null) {
      this.clearTimer(this.titleTimer);
      this.titleTimer = null;
    }
    this.pendingTitle = null;
  }

  navigate(url: string): void {
    if (!isAllowedNavigationUrl(url)) {
      this.opts.onFailed({
        viewId: this.id,
        errorCode: 0,
        errorDescription: 'Blocked navigation scheme',
        validatedURL: url,
        kind: 'load',
      });
      return;
    }
    this.crashed = false;
    this.pendingShowOnStart = true;
    this.wc().loadURL(url);
  }

  back(): void {
    if (this.wc().navigationHistory.canGoBack()) this.wc().navigationHistory.goBack();
  }

  forward(): void {
    if (this.wc().navigationHistory.canGoForward()) this.wc().navigationHistory.goForward();
  }

  reloadOrStop(): void {
    this.crashed = false;
    this.pendingShowOnStart = true;
    if (this.wc().isLoading()) this.wc().stop();
    else this.wc().reload();
  }

  getState(): NavState {
    const wc = this.wc();
    return {
      viewId: this.id,
      url: wc.getURL(),
      title: this.pendingTitle ?? wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      isLoading: this.loading || wc.isLoading(),
      crashed: this.crashed,
    };
  }

  private emitState(): void {
    this.opts.onState(this.getState());
  }

  isContentVisible(): boolean {
    return this.visible;
  }

  setBounds(rect: { x: number; y: number; width: number; height: number }): void {
    this.view.setBounds(rect);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.view.setVisible(v);
  }

  destroy(): void {
    this.flushTitle();
    this.wc().close();
  }
}
