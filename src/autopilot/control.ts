import type { HistoryEntry } from '../../shared/types';

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
  /** Directly set the history entries (bypasses async refresh; autopilot vitest seeding only). */
  setHistoryEntries(entries: HistoryEntry[]): void;
}

const KEY = '__aegisAutopilot';

export function installAutopilotControl(c: AutopilotControl): () => void {
  (window as unknown as Record<string, AutopilotControl>)[KEY] = c;
  return () => { delete (window as unknown as Record<string, unknown>)[KEY]; };
}

export function getAutopilotControl(): AutopilotControl | undefined {
  return (window as unknown as Record<string, AutopilotControl | undefined>)[KEY];
}
