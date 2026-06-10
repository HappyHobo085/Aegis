// electron/main/adblock/blockedCounter.ts
import type { ViewId, BlockedCount } from '../../../shared/types';

/**
 * Structural type for the engine's counting surface. The core FiltersEngine is
 * an EventEmitter that emits 'request-blocked' / 'request-redirected' from
 * match(); we type only the methods we use so this module needs no value import
 * of ElectronBlocker (keeps it node-testable — contract §8.2).
 */
interface CountingBlocker {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  unsubscribe(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Per-view blocked-request counter. `page` resets each top-frame navigation
 * (driven by the controller's did-start-navigation handler); `session` is
 * monotonic for the process lifetime. Counts both blocked and redirected
 * (neutered-stub) requests via the engine's events — the Electron wrapper emits
 * none of its own and allows only one onBeforeRequest listener (contract §1).
 */
export class BlockedCounter {
  private readonly viewId: ViewId;
  private pageCount = 0;
  private sessionCount = 0;
  private readonly onEvent = (): void => {
    this.pageCount += 1;
    this.sessionCount += 1;
  };

  constructor(viewId: ViewId) {
    this.viewId = viewId;
  }

  /** Add request-blocked + request-redirected listeners to `blocker`. */
  attach(blocker: CountingBlocker): void {
    blocker.on('request-blocked', this.onEvent);
    blocker.on('request-redirected', this.onEvent);
  }

  /** Remove the listeners (used when swapping to a new engine). */
  detach(blocker: CountingBlocker): void {
    blocker.unsubscribe('request-blocked', this.onEvent);
    blocker.unsubscribe('request-redirected', this.onEvent);
  }

  /** Reset the per-page count to 0; the session total is untouched. */
  resetPage(): void {
    this.pageCount = 0;
  }

  /** Current counts for this view. */
  snapshot(): BlockedCount {
    return { viewId: this.viewId, page: this.pageCount, session: this.sessionCount };
  }
}
