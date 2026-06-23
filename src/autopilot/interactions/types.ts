// src/autopilot/interactions/types.ts
// Public interaction-layer types, shared by every per-domain spec file and the
// vitest/live ctx factories.  Split out of the former monolithic interactions.ts.
import type {
  AegisApi,
  NavState,
  TabsState,
  TabShortcut,
  Favorite,
  HistoryEntry,
  SavedItem,
  NavFailed,
  NavCrashed,
  SafetyInterstitialPayload,
  PermissionPrompt,
  RedirectBlocked,
  FindState,
  BlockedCount,
} from '../../../shared/types';
import type { ScreenId } from '../screens';

export type InteractionLayer = 'vitest' | 'live';

/** Recorded mock-call inspection (vitest); inert on live (asserts via real state instead). */
export interface CallLog {
  /** Call-argument arrays for a dotted aegis path, e.g. of('favorites.add'). [] on live. */
  of(path: string): unknown[][];
  /** True if `path` was called (optionally with a predicate on the first call's args). */
  called(path: string, match?: (args: unknown[]) => boolean): boolean;
  /** Clear recorded calls (the tour calls this before each interaction's run). */
  reset(): void;
}

export interface InteractionCtx {
  layer: InteractionLayer;
  click(el: Element): Promise<void>;
  type(el: Element, text: string): Promise<void>;
  press(key: 'Enter' | 'Escape' | 'ctrl+t' | 'ctrl+w' | 'ctrl+shift+t'): Promise<void>;
  /** Fire a contextmenu event on the element (used for tab pin via right-click). */
  contextMenu(el: Element): Promise<void>;
  byRole(role: string, name?: string | RegExp): HTMLElement | null;
  byText(text: string | RegExp): HTMLElement | null;
  byLabel(label: string | RegExp): HTMLElement | null;
  bySelector(sel: string): HTMLElement | null;
  aegis: AegisApi;
  calls: CallLog;
  reach(screen: ScreenId): Promise<void>;
  /**
   * Vitest-only: emit a NavState update to the subscribed useNav hook so React
   * re-renders with the new state (e.g. enables the Back/Forward buttons).
   * The callback is captured at ctx-creation time, BEFORE calls.reset() clears
   * the mock's call log.  No-op on live (live state comes from the real core).
   */
  emitNavState?(state: NavState): Promise<void>;
  /**
   * Vitest-only: push a TabsState update into useTabs so the TabStrip re-renders
   * with the desired tab list (e.g. 2 tabs so the activate/close interactions can
   * click a second tab).  No-op on live.
   */
  emitTabsState?(state: TabsState): Promise<void>;
  /**
   * Vitest-only: invoke the shortcut callback that App subscribed to via
   * aegis.tabs.onShortcut so keyboard-shortcut interactions can be exercised in
   * jsdom even though no native GTK/Win accelerator fires there.  No-op on live.
   */
  emitTabShortcut?(shortcut: TabShortcut): Promise<void>;
  /**
   * Vitest-only: seed the history panel with the given entries by resetting the
   * history.list mock return and firing the onChanged subscriber so the panel
   * re-renders with non-empty content.  No-op on live (live history comes from
   * real navigations in the disposable profile).
   */
  emitHistory?(entries: HistoryEntry[]): Promise<void>;
  /**
   * Vitest-only: seed the favorites list by resetting the favorites.list mock
   * return and triggering a sync-change re-fetch so useFavorites re-renders
   * with the seeded items.  No-op on live.
   */
  emitFavorites?(items: Favorite[]): Promise<void>;
  /**
   * Vitest-only: seed the saved panel with items + tagUnion via the control-surface seam
   * (setSavedItems → useSaved._setSavedItems), using flushSync so the DOM updates
   * synchronously before the next gesture fires.  No-op on live.
   */
  emitSaved?(items: SavedItem[], tagUnion: string[]): Promise<void>;
  /**
   * Vitest-only: seed the SitePermissionsTab with a list of remembered permissions via
   * the control-surface seam (setSitePermissions → usePermissions._setPermissions), using
   * flushSync so the DOM updates synchronously before the next gesture fires.  No-op on live.
   */
  emitSitePermissions?(
    permissions: import('../../../shared/types').SitePermission[],
  ): Promise<void>;
  /**
   * Vitest-only: seed the allowlist state in useAdblock by mocking adblock.getState
   * and publishing a syncBus 'allowlist' change (which triggers the hook's onSyncChange
   * callback → re-calls getState → setState with the seeded hosts).  No-op on live.
   */
  emitAllowlist?(hosts: string[]): Promise<void>;
  /**
   * Vitest-only: seed the DownloadsPanel with entries by calling setDownloadEntries on
   * the autopilot control (which calls useDownloads._setDownloads directly via flushSync),
   * so the Clear button becomes enabled.  No-op on live.
   */
  emitDownloadsChanged?(entries: import('../../../shared/types').DownloadEntry[]): Promise<void>;
  /**
   * Vitest-only: emit a NavFailed event by invoking the callback that App registered via
   * aegis.nav.onFailed — identical to the real core emitting nav.failed. The error overlay
   * renders synchronously (flushSync).  No-op on live.
   */
  emitNavFailed?(f: NavFailed): Promise<void>;
  /**
   * Vitest-only: emit a NavCrashed event by invoking the callback that App registered via
   * aegis.nav.onCrashed — identical to the real core emitting nav.crashed. The crash overlay
   * renders synchronously (flushSync).  No-op on live.
   */
  emitNavCrashed?(c: NavCrashed): Promise<void>;
  /**
   * Vitest-only: emit a SafetyInterstitialPayload (or null to dismiss) by invoking the
   * callback that useSafety registered via aegis.safety.onInterstitial.  No-op on live.
   */
  emitSafetyInterstitial?(p: SafetyInterstitialPayload | null): Promise<void>;
  /**
   * Vitest-only: emit a PermissionPrompt (or null to dismiss) by invoking the callback
   * that usePermissions registered via aegis.permissions.onPrompt.  No-op on live.
   */
  emitPermissionPrompt?(p: PermissionPrompt | null): Promise<void>;
  /**
   * Vitest-only: emit a RedirectBlocked event by invoking the callback that App registered
   * via aegis.redirect.onBlocked so the RedirectBar renders.  No-op on live.
   */
  emitRedirectBlocked?(r: RedirectBlocked): Promise<void>;
  /**
   * Vitest-only: push a FindState update into useFind so the FindBar re-renders with
   * the given match count (e.g. enables the Find next / Find previous buttons).
   * The callback is captured at ctx-creation time, BEFORE calls.reset() clears the
   * mock's call log.  No-op on live (live state comes from the real core).
   */
  emitFindState?(state: FindState): Promise<void>;
  /**
   * Vitest-only: push a BlockedCount update into useAdblock so the AdblockShield badge
   * re-renders with the given page count.  The callback is captured at ctx-creation time,
   * BEFORE calls.reset() clears the mock's call log.  No-op on live (live state comes
   * from real blocks; the badge is proven via the A/B trace, not a count assert).
   */
  emitBlockedCount?(count: BlockedCount): Promise<void>;
}

export interface InteractionSpec {
  id: string;
  domain: string;
  description: string;
  screen: ScreenId;
  layers: InteractionLayer[];
  /**
   * Whether this interaction can run in the mobile shell (MobileApp).
   * `true`  → included in the mobile interaction tour.
   * `false` or absent → desktop-only; excluded from the mobile tour.
   * Mobile-only controls (bottom bar, menu sheet, tab switcher) are
   * added as separate specs with `mobile: true` but no desktop analog.
   */
  mobile?: boolean;
  run(ctx: InteractionCtx): Promise<void>;
  assert(ctx: InteractionCtx): Promise<string>;
}
