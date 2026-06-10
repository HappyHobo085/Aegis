// electron/main/adblock/controller.ts
import type { Session, WebContents } from 'electron';
import type { ElectronBlocker } from '@ghostery/adblocker-electron';
import type { AdblockState, BlockedCount, ViewId } from '../../../shared/types';
import type { AdblockRepo } from '../db/adblockRepo';
import type { BlockedCounter } from './blockedCounter';

/**
 * Reconciles per-session blocking against the persisted enable/allowlist state at
 * the navigation boundary, swaps in a refreshed engine when one is pending, and
 * surfaces blocked counts. Pure logic over injected deps (no live Electron in
 * unit tests); real session binding is covered by Block-E e2e.
 */
export interface AdblockControllerOpts {
  viewId: ViewId;
  session: Session;
  contentWc: WebContents;
  repo: AdblockRepo;
  blocker: ElectronBlocker;
  counter: BlockedCounter;
  onBlockedCount: (c: BlockedCount) => void;
}

export class AdblockController {
  readonly contentWc: WebContents;
  private readonly opts: AdblockControllerOpts;
  private active: ElectronBlocker;
  private pending: ElectronBlocker | null = null;

  constructor(opts: AdblockControllerOpts) {
    this.opts = opts;
    this.contentWc = opts.contentWc;
    this.active = opts.blocker;
    this.opts.counter.attach(this.active);

    this.contentWc.on('did-start-navigation', (details: { url: string; isMainFrame: boolean; isSameDocument: boolean }) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.swapPendingIfAny();
      this.reconcile(details.url);
      this.opts.counter.resetPage();
    });

    this.contentWc.on('did-stop-loading', () => {
      this.opts.onBlockedCount(this.opts.counter.snapshot());
    });
  }

  /** Reconcile session enable/disable for the first nav (call BEFORE vc.navigate). */
  primeFor(firstUrl: string): void {
    this.reconcile(firstUrl);
  }

  setEnabled(enabled: boolean): AdblockState {
    this.opts.repo.setEnabled(enabled);
    return this.getState();
  }

  toggleAllowlist(host: string): AdblockState {
    this.opts.repo.toggleAllowlist(host);
    return this.getState();
  }

  /**
   * Remove `host` from the allowlist (DB-only). Re-blocking on `host` is deferred
   * to the next main-frame navigation's reconcile, consistent with toggleAllowlist.
   */
  removeAllowlist(host: string): AdblockState {
    this.opts.repo.removeAllowlist(host);
    return this.getState();
  }

  /**
   * Clear the entire allowlist (DB-only). Re-blocking on previously-allowlisted
   * hosts is deferred to their next navigation's reconcile (no direct reconcile).
   */
  clearAllowlist(): AdblockState {
    this.opts.repo.clearAllowlist();
    return this.getState();
  }

  getState(): AdblockState {
    const { enabled, allowlistedHosts } = this.opts.repo.getState();
    return { enabled, allowlistedHosts, sessionBlocked: this.opts.counter.snapshot().session };
  }

  /** Refresh produced a new engine; swap on the next navigation boundary. */
  setPendingBlocker(b: ElectronBlocker): void {
    this.pending = b;
  }

  snapshotCount(): BlockedCount {
    return this.opts.counter.snapshot();
  }

  /** True if blocking is currently enabled on the content session (e2e/readiness probe). */
  isBlockingActive(): boolean {
    return this.active.isBlockingEnabled(this.opts.session);
  }

  private swapPendingIfAny(): void {
    if (!this.pending) return;
    const old = this.active;
    if (old.isBlockingEnabled(this.opts.session)) {
      old.disableBlockingInSession(this.opts.session);
    }
    this.opts.counter.detach(old);
    this.active = this.pending;
    this.opts.counter.attach(this.active);
    this.pending = null;
  }

  private reconcile(url: string): void {
    const host = hostOf(url);
    const { enabled } = this.opts.repo.getState();
    const shouldBlock = enabled && !this.opts.repo.isAllowlisted(host);
    const isOn = this.active.isBlockingEnabled(this.opts.session);
    if (shouldBlock && !isOn) {
      this.active.enableBlockingInSession(this.opts.session);
    } else if (!shouldBlock && isOn) {
      this.active.disableBlockingInSession(this.opts.session);
    }
  }
}

/** hostname of a URL; '' if unparseable (treated as not-allowlisted). */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
