// electron/main/safety/SafetyController.ts
import type { NavFailed, SafetyInterstitialPayload } from '../../../shared/types';
import { upgradeUrl } from './httpsUpgrade';

export interface HttpExceptionsLike {
  has(host: string): boolean;
  add(host: string): void;
  remove(host: string): void;
  list(): string[];
}

export interface SafetyControllerDeps {
  /** Load a URL in the content view (ViewController.navigate). */
  navigateView: (url: string) => void;
  httpExceptions: HttpExceptionsLike;
  getHttpsOnly: () => boolean;
  onInterstitial: (p: SafetyInterstitialPayload | null) => void;
}

/**
 * Owns HTTPS-Only navigation upgrades and the safety interstitial. The pure
 * upgrade decision lives in ./httpsUpgrade; this class adds the stateful pieces:
 * recording the last upgrade so a did-fail-load on the https form can offer an
 * HTTP fallback, and the persisted per-host exception set.
 */
export class SafetyController {
  private current: SafetyInterstitialPayload | null = null;
  private lastUpgrade: { from: string; to: string } | null = null;

  constructor(private readonly deps: SafetyControllerDeps) {}

  /** Gate/entry hook: returns the https URL to load instead, or null. Records it. */
  resolveUpgrade(url: string): string | null {
    const upgraded = upgradeUrl(url, {
      httpsOnly: this.deps.getHttpsOnly(),
      isException: (h) => this.deps.httpExceptions.has(h),
    });
    if (upgraded) this.lastUpgrade = { from: url, to: upgraded };
    return upgraded;
  }

  /** Upgrade-aware navigation entry (address bar / home / first nav). */
  navigate(url: string): void {
    // A fresh navigation supersedes any showing interstitial and any in-flight
    // upgrade record (resolveUpgrade re-arms below if this URL is upgraded).
    if (this.current !== null) this.dismiss();
    this.lastUpgrade = null;
    const upgraded = this.resolveUpgrade(url);
    this.deps.navigateView(upgraded ?? url);
  }

  /**
   * did-navigate (commit) hook. A successful commit of the upgraded https URL
   * means the upgrade did NOT fail — disarm the record so a later, unrelated
   * failure of the same URL (e.g. a manual reload, an expiring cert) can't raise
   * a false HTTPS-failed interstitial. Keyed on the upgrade target because the
   * state stream also fires on did-start-loading, before the upgraded URL commits.
   */
  handleNavCommitted(url: string): void {
    if (this.lastUpgrade && url === this.lastUpgrade.to) {
      this.lastUpgrade = null;
    }
  }

  /**
   * did-fail-load hook. If the failed URL is the https form we just upgraded to,
   * raise the HTTPS-failed interstitial and return true (caller suppresses the
   * generic error page). Otherwise return false.
   */
  handleNavFailed(f: NavFailed): boolean {
    if (this.lastUpgrade && f.validatedURL === this.lastUpgrade.to) {
      const httpUrl = this.lastUpgrade.from;
      this.lastUpgrade = null;
      this.raise({ url: httpUrl, reason: 'https-failed' });
      return true;
    }
    return false;
  }

  getState(): SafetyInterstitialPayload | null {
    return this.current;
  }

  /** "Continue to HTTP for this site": persist the host + reload over http. */
  proceed(url: string): void {
    // Defense-in-depth: only act when this url matches the showing interstitial.
    if (this.current === null || url !== this.current.url) return;
    try {
      const host = new URL(url).hostname;
      if (host) this.deps.httpExceptions.add(host);
    } catch {
      /* malformed url — skip persistence, still attempt the load */
    }
    this.dismiss();
    this.deps.navigateView(url);
  }

  listExceptions(): string[] {
    return this.deps.httpExceptions.list();
  }

  removeException(host: string): void {
    this.deps.httpExceptions.remove(host);
  }

  private raise(p: SafetyInterstitialPayload): void {
    this.current = p;
    this.deps.onInterstitial(p);
  }

  private dismiss(): void {
    this.current = null;
    this.deps.onInterstitial(null);
  }
}
