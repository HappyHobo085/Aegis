// electron/main/viewController.ts
import { WebContentsView } from 'electron';
import type { NavState, NavFailed, NavCrashed, ViewId } from '../../shared/types';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { isAllowedNavigationUrl } from '../lib/schemes';
import { decideWindowOpen } from './windowOpen';

const TITLE_DEBOUNCE_MS = 400;

export interface ViewControllerOpts {
  contentPreloadPath: string;
  onState: (s: NavState) => void;
  onFailed: (f: NavFailed) => void;
  onCrashed: (c: NavCrashed) => void;
  /** HTTPS-Only hook: given a navigation URL, return the https URL to load instead, or null to allow as-is. */
  upgradeNavigation?: (url: string) => string | null;
  /** Malware gate: return true to BLOCK this navigation (the hook raises its own interstitial). */
  onBlockedNavigation?: (url: string) => boolean;
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

  // last successfully committed URL (used by getState() instead of wc.getURL() after a
  // failed navigation, so cert/load failures do not adopt the attempted URL in the state).
  private lastCommittedUrl = '';

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
        // Phase 5: block autoplay-with-sound until a user gesture; enable
        // Chromium's PDF plugin so application/pdf renders inline in the view.
        autoplayPolicy: 'document-user-activation-required',
        plugins: true,
      },
    });

    this.wireNavEvents();
    this.wireSecurity();
  }

  private wc() {
    return this.view.webContents;
  }

  /** The content WebContents the adblock engine/counter binds to. */
  get contentWebContents(): Electron.WebContents {
    return this.view.webContents;
  }

  /** The content session ('persist:content') the adblock engine enables blocking on. */
  get contentSession(): Electron.Session {
    return this.view.webContents.session;
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

    wc.on('did-navigate', (_event: unknown, url: string) => {
      this.lastCommittedUrl = url;
      this.flushTitle();
      this.emitState();
    });

    wc.on('did-navigate-in-page', (_event: unknown, url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      this.lastCommittedUrl = url;
      this.emitState();
    });

    wc.on('page-title-updated', (_event: unknown, title: string) => {
      this.scheduleTitle(title);
    });

    const gate = (event: { preventDefault: () => void }, url: string) => {
      if (!isAllowedNavigationUrl(url)) {
        event.preventDefault();
        return;
      }
      if (this.opts.onBlockedNavigation?.(url)) {
        event.preventDefault();
        return;
      }
      const upgraded = this.opts.upgradeNavigation?.(url) ?? null;
      if (upgraded && upgraded !== url) {
        event.preventDefault();
        this.wc().loadURL(upgraded);
      }
    };
    wc.on('will-navigate', gate);
    wc.on('will-redirect', gate);

    wc.on(
      'did-fail-load',
      (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame) return;
        // ERR_ABORTED (-3): user/stop-initiated, not a real failure.
        if (errorCode === -3) return;
        const kind: NavFailed['kind'] =
          errorCode <= -200 && errorCode > -300 ? 'cert' : 'load';
        this.setVisible(false); // main owns the hide for failures
        this.opts.onFailed({
          viewId: this.id,
          errorCode,
          errorDescription,
          validatedURL,
          kind,
        });
      },
    );

    wc.on(
      'render-process-gone',
      (_event: unknown, details: { reason: string }) => {
        this.crashed = true;
        this.setVisible(false);
        this.opts.onCrashed({ viewId: this.id, reason: details.reason });
      },
    );

    wc.on('unresponsive', () => {
      this.crashed = true;
      this.setVisible(false);
      this.opts.onCrashed({ viewId: this.id, reason: 'unresponsive' });
    });
  }

  private wireSecurity(): void {
    const wc = this.wc();
    const ses = wc.session;

    // Permissions: deny-by-default via BOTH handlers. wirePermissions() (Phase 5,
    // boot) RE-SETS both on the content session (last-set wins); this stays as the
    // safe default before that runs.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    // Popup policy (§5): deny popunders; route a legitimate, allowed-scheme
    // new-window in-place; otherwise deny. Policy lives in ./windowOpen (pure,
    // unit-tested). HandlerDetails has no user-gesture bit → disposition+scheme only.
    wc.setWindowOpenHandler((details) => {
      const decision = decideWindowOpen(details);
      if ('loadInPlace' in decision) this.wc().loadURL(decision.loadInPlace);
      return { action: 'deny' };
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
    if (this.loading || this.wc().isLoading()) this.wc().stop();
    else this.wc().reload();
  }

  getState(): NavState {
    const wc = this.wc();
    // Use lastCommittedUrl when available so that failed navigations (cert/load
    // errors) do not adopt the attempted URL in the reported state — the state
    // URL should reflect the last *successfully committed* page, not the failed
    // navigation target. Fall back to wc.getURL() only on the very first load
    // before any commit has been recorded.
    const url = this.lastCommittedUrl || wc.getURL();
    return {
      viewId: this.id,
      url,
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
