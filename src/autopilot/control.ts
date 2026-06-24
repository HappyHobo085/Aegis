import type {
  DownloadEntry,
  HistoryEntry,
  SavedItem,
  SitePermission,
  VaultRecord,
} from '../../shared/types';

// The dev-only imperative surface DesktopApp registers so the autopilot can reach
// each overlay/state without selector brittleness. Calls the SAME setState handlers
// the real buttons use. NEVER registered in production (gated by the caller).
export interface AutopilotControl {
  openSettings(): void;
  closeSettings(): void;
  openDownloads(): void;
  closeDownloads(): void;
  openManager(): void;
  closeManager(): void;
  setSidebar(open: boolean): void;
  setShield(open: boolean): void;
  enterFullscreen(): void;
  exitFullscreen(): void;
  showError(f: unknown): void;
  clearError(): void;
  showCrash(c: unknown): void;
  clearCrash(): void;
  openConfirm(message: string): void;
  /** Open the find bar (same as pressing Ctrl+F in the real UI). */
  openFind(): void;
  /** Close the find bar and end the find session. */
  closeFind(): void;
  /** Directly set the download entries (bypasses async refresh; autopilot vitest seeding only). */
  setDownloadEntries(entries: DownloadEntry[]): void;
  /** Directly set the history entries (bypasses async refresh; autopilot vitest seeding only). */
  setHistoryEntries(entries: HistoryEntry[]): void;
  /** Directly set saved items + tagUnion (bypasses async refresh; autopilot vitest seeding only). */
  setSavedItems(items: SavedItem[], tagUnion: string[]): void;
  /** Directly set the remembered site-permissions list (bypasses async refresh; autopilot vitest seeding only). */
  setSitePermissions(permissions: SitePermission[]): void;
  /** Directly set the allowlisted hosts in the adblock state (bypasses async refresh; autopilot vitest seeding only). */
  setAllowlistedHosts(hosts: string[]): void;
  /**
   * Directly seed the VaultSettingsTab's displayed records list (bypasses the async
   * vault.list() → setRecords chain; autopilot vitest seeding only).
   * Writes through vault._setRecordsRef.current, which VaultSettingsTab registers on mount.
   */
  setVaultRecords(records: VaultRecord[]): void;
  /**
   * Directly seed the fingerprint state (bypasses the async fingerprint.getState() path;
   * autopilot vitest seeding only). Writes through useFingerprint._setState.
   */
  setFingerprintState(s: import('../../shared/types').FingerprintState): void;
  /**
   * Directly seed the proxy state (bypasses the async proxy.getState() path;
   * autopilot vitest seeding only). Writes through useProxy._setState.
   */
  setProxyState(s: import('../../shared/types').ProxyState): void;
}

const KEY = '__aegisAutopilot';

export function installAutopilotControl(c: AutopilotControl): () => void {
  (window as unknown as Record<string, AutopilotControl>)[KEY] = c;
  return () => {
    delete (window as unknown as Record<string, unknown>)[KEY];
  };
}

export function getAutopilotControl(): AutopilotControl | undefined {
  return (window as unknown as Record<string, AutopilotControl | undefined>)[KEY];
}
