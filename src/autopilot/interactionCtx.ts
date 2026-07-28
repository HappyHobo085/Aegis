// src/autopilot/interactionCtx.ts
import { within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'react-dom';
import type {
  AegisApi,
  NavState,
  TabsState,
  TabShortcut,
  Favorite,
  HistoryEntry,
  SavedItem,
  SitePermission,
  NavFailed,
  NavCrashed,
  SafetyInterstitialPayload,
  PermissionPrompt,
  RedirectBlocked,
  FindState,
  BlockedCount,
  VaultState,
} from '../../shared/types';
import type { CallLog, InteractionCtx } from './interactions';
import type { ScreenId } from './screens';
import { getAutopilotControl } from './control';

type Reach = (screen: ScreenId) => Promise<void>;

/** Resolve a dotted path ('favorites.add') against an object; undefined if absent. */
function resolve(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
}

/** CallLog over a vitest-mocked aegis (every method is a vi.fn with a `.mock.calls`). */
function vitestCallLog(aegis: AegisApi): CallLog {
  const fn = (
    path: string,
  ): { mock?: { calls: unknown[][] }; mockClear?: () => void } | undefined =>
    resolve(aegis, path) as never;
  return {
    of: (path) => fn(path)?.mock?.calls ?? [],
    called: (path, match) => {
      const calls = fn(path)?.mock?.calls ?? [];
      return match ? calls.some((args) => match(args)) : calls.length > 0;
    },
    reset: () => {
      // Clear every vi.fn under aegis so each interaction asserts only its own calls.
      const walk = (o: unknown) => {
        if (o && typeof o === 'object') {
          for (const v of Object.values(o)) {
            if (typeof v === 'function' && (v as { mockClear?: () => void }).mockClear)
              (v as { mockClear: () => void }).mockClear();
            else if (v && typeof v === 'object') walk(v);
          }
        }
      };
      walk(aegis);
    },
  };
}

/** Inert CallLog for live (assertions there read real state via ctx.aegis). */
const liveCallLog: CallLog = { of: () => [], called: () => false, reset: () => {} };

export function makeVitestCtx(root: HTMLElement, aegis: AegisApi, reach: Reach): InteractionCtx {
  const user = userEvent.setup();
  const q = within(root);
  const keyMap: Record<string, string> = {
    Enter: '{Enter}',
    Escape: '{Escape}',
    'ctrl+t': '{Control>}t{/Control}',
    'ctrl+w': '{Control>}w{/Control}',
    'ctrl+shift+t': '{Control>}{Shift>}t{/Shift}{/Control}',
  };

  // Capture the nav onState callback NOW (before calls.reset() wipes mock.calls).
  // App mounts synchronously in render(), so onState is called before makeVitestCtx.
  // Guard: aegis.nav may be absent in unit-test fakes that only stub a single domain.
  type NavStateMockFn = { mock?: { calls: ((s: NavState) => void)[][] } };
  const navStateCallback: ((s: NavState) => void) | undefined = aegis.nav
    ? (aegis.nav.onState as unknown as NavStateMockFn).mock?.calls?.[0]?.[0]
    : undefined;

  // Capture the tabs.onState callback (used by useTabs) to emit a TabsState
  // without touching the aegis mock — same pattern as navStateCallback.
  type TabsStateMockFn = { mock?: { calls: ((s: TabsState) => void)[][] } };
  const tabsStateCallback: ((s: TabsState) => void) | undefined = aegis.tabs
    ? (aegis.tabs.onState as unknown as TabsStateMockFn).mock?.calls?.[0]?.[0]
    : undefined;

  // Capture the tabs.onShortcut callback (registered by App's useEffect) so
  // keyboard-shortcut interactions can invoke it directly — there is no DOM
  // keydown handler for Ctrl+T/W/Shift+T on Linux/macOS (native-only accelerator).
  type TabsShortcutMockFn = { mock?: { calls: ((s: TabShortcut) => void)[][] } };
  const tabsShortcutCallback: ((s: TabShortcut) => void) | undefined = aegis.tabs
    ? (aegis.tabs.onShortcut as unknown as TabsShortcutMockFn).mock?.calls?.[0]?.[0]
    : undefined;

  // Capture the nav.onFailed / nav.onCrashed callbacks (registered by App's useEffect) so
  // the errorOverlay / crashOverlay interactions can render those overlays synchronously.
  type NavFailedMockFn = { mock?: { calls: ((f: NavFailed) => void)[][] } };
  type NavCrashedMockFn = { mock?: { calls: ((c: NavCrashed) => void)[][] } };
  const navFailedCallback: ((f: NavFailed) => void) | undefined = aegis.nav
    ? (aegis.nav.onFailed as unknown as NavFailedMockFn).mock?.calls?.[0]?.[0]
    : undefined;
  const navCrashedCallback: ((c: NavCrashed) => void) | undefined = aegis.nav
    ? (aegis.nav.onCrashed as unknown as NavCrashedMockFn).mock?.calls?.[0]?.[0]
    : undefined;

  // Capture the safety.onInterstitial callback (registered by useSafety) so
  // the safetyInterstitial interaction can render the interstitial overlay.
  type SafetyInterstitialMockFn = {
    mock?: { calls: ((p: SafetyInterstitialPayload | null) => void)[][] };
  };
  const safetyInterstitialCallback: ((p: SafetyInterstitialPayload | null) => void) | undefined =
    aegis.safety
      ? (aegis.safety.onInterstitial as unknown as SafetyInterstitialMockFn).mock?.calls?.[0]?.[0]
      : undefined;

  // Capture the permissions.onPrompt callback (registered by usePermissions) so
  // the permissionPrompt interaction can render the permission dialog.
  type PermissionPromptMockFn = { mock?: { calls: ((p: PermissionPrompt | null) => void)[][] } };
  const permissionPromptCallback: ((p: PermissionPrompt | null) => void) | undefined =
    aegis.permissions
      ? (aegis.permissions.onPrompt as unknown as PermissionPromptMockFn).mock?.calls?.[0]?.[0]
      : undefined;

  // Capture the redirect.onBlocked callback (registered by App's useEffect) so
  // interaction specs can emit redirect.blocked events.
  type RedirectBlockedMockFn = { mock?: { calls: ((r: RedirectBlocked) => void)[][] } };
  const redirectBlockedCallback: ((r: RedirectBlocked) => void) | undefined = aegis.redirect
    ? (aegis.redirect.onBlocked as unknown as RedirectBlockedMockFn).mock?.calls?.[0]?.[0]
    : undefined;

  // (downloads.onChanged callback is NOT captured here — useDownloads._setDownloads is
  // used instead via the control-surface seam, which is synchronous via flushSync.)

  // Capture the find.onState callback (registered by useFind) so find interaction specs
  // can push a non-zero matchCount and enable the Find next / Find previous buttons.
  type FindStateMockFn = { mock?: { calls: ((s: FindState) => void)[][] } };
  const findStateCallback: ((s: FindState) => void) | undefined = aegis.find
    ? (aegis.find.onState as unknown as FindStateMockFn).mock?.calls?.[0]?.[0]
    : undefined;

  // Capture the adblock.onBlockedCount callback (registered by useAdblock) so the badge
  // interaction spec can push a BlockedCount and verify the AdblockShield badge re-renders.
  // Same pattern as emitNavState / emitFindState — captured BEFORE calls.reset() clears
  // the mock's call log.
  type BlockedCountMockFn = { mock?: { calls: ((c: BlockedCount) => void)[][] } };
  const blockedCountCallback: ((c: BlockedCount) => void) | undefined = aegis.adblock
    ? (aegis.adblock.onBlockedCount as unknown as BlockedCountMockFn).mock?.calls?.[0]?.[0]
    : undefined;

  // Capture the vault.onState callback (registered by useVault) so vault interaction specs
  // can push a VaultState and drive the VaultSettingsTab into the desired state
  // (create / locked / unlocked) without relying on re-mounting the Settings panel.
  // Same pattern as emitNavState — captured BEFORE calls.reset() clears the mock's calls.
  type VaultStateMockFn = { mock?: { calls: ((s: VaultState) => void)[][] } };
  const vaultStateCallback: ((s: VaultState) => void) | undefined = aegis.vault
    ? (aegis.vault.onState as unknown as VaultStateMockFn).mock?.calls?.[0]?.[0]
    : undefined;

  return {
    layer: 'vitest',
    click: (el) => user.click(el),
    type: async (el, text) => {
      await user.clear(el);
      await user.type(el, text);
    },
    press: (key) => user.keyboard(keyMap[key]),
    contextMenu: async (el) => {
      fireEvent.contextMenu(el);
    },
    byRole: (role, name) => q.queryByRole(role, name ? { name } : undefined) as HTMLElement | null,
    byText: (text) => q.queryByText(text) as HTMLElement | null,
    byLabel: (label) => q.queryByLabelText(label) as HTMLElement | null,
    bySelector: (sel) => root.querySelector(sel),
    aegis,
    calls: vitestCallLog(aegis),
    reach: (s) => reach(s),
    emitNavState: (state: NavState) => {
      // flushSync forces React to apply the state update synchronously, so the
      // DOM reflects the new state immediately after this call returns — without
      // needing to await a tick or re-enter act().  Without this, the Back/Forward
      // buttons would still be disabled when the next line of run() queries them.
      if (navStateCallback) flushSync(() => navStateCallback(state));
      return Promise.resolve();
    },
    emitTabsState: (state: TabsState) => {
      // Same pattern as emitNavState: push a TabsState into useTabs synchronously
      // so the TabStrip re-renders before the next line of run() queries the DOM.
      if (tabsStateCallback) flushSync(() => tabsStateCallback(state));
      return Promise.resolve();
    },
    emitTabShortcut: (shortcut: TabShortcut) => {
      // Invoke the onShortcut callback that App's useEffect registered — the only
      // way to exercise Ctrl+T/W/Shift+T in jsdom (no native accelerator fires there).
      if (tabsShortcutCallback) flushSync(() => tabsShortcutCallback(shortcut));
      return Promise.resolve();
    },
    emitHistory: (entries: HistoryEntry[]) => {
      // Seed the HistoryPanel by calling setHistoryEntries on the autopilot control,
      // which directly calls useHistory's setEntries React state setter.  This mirrors
      // the flushSync pattern used by emitNavState / emitTabsState — synchronous,
      // no async Promise chains, no nested act().  The DOM update is committed by
      // flushSync before this function returns.
      const control = getAutopilotControl();
      if (control) flushSync(() => control.setHistoryEntries(entries));
      return Promise.resolve();
    },
    emitFavorites: async (items: Favorite[]) => {
      // Seed the FavoritesBar / FavoritesManager by:
      // 1. Updating the favorites.list mock to return the seeded items.
      // 2. Publishing a sync-change for 'favorites' so useFavorites re-fetches
      //    (useFavorites subscribes via onSyncChange('favorites', load) and load()
      //    calls aegis.favorites.list() → setFavorites(result)).
      // 3. Dynamic import of syncBus so we use the SAME module instance as useFavorites
      //    (vitest's vi.resetModules() between tests would otherwise leave interactionCtx
      //    holding a stale static import of a different syncBus instance).
      const mock = aegis.favorites as unknown as {
        list: { mockResolvedValue(v: Favorite[]): void };
      };
      mock.list.mockResolvedValue(items);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { publishSyncChange } = await import('../lib/syncBus');
      await act(async () => {
        publishSyncChange('favorites', []);
        // Give the async .list().then(setFavorites) chain time to resolve.
        // NOTE: this relies on REAL timers (setTimeout(r, 0) must actually fire).
        // If the test suite ever adopts vi.useFakeTimers(), this await will hang
        // until fake time is advanced — revisit and replace with vi.runAllTimers()
        // or a flushSync alternative before enabling fake timers globally.
        await new Promise((r) => setTimeout(r, 0));
      });
    },
    emitSaved: (items: SavedItem[], tagUnion: string[]) => {
      // Seed the SavedPanel by calling setSavedItems on the autopilot control,
      // which directly calls useSaved's _setSavedItems React state setter (sets both
      // items and tagUnion atomically). Uses the same flushSync pattern as
      // emitHistory: synchronous, no async Promise chains, no nested act().
      const control = getAutopilotControl();
      if (control) flushSync(() => control.setSavedItems(items, tagUnion));
      return Promise.resolve();
    },
    emitSitePermissions: (permissions: SitePermission[]) => {
      // Seed the SitePermissionsTab by calling setSitePermissions on the autopilot
      // control, which directly calls usePermissions._setPermissions React state setter.
      // Uses flushSync so the DOM updates synchronously before the next gesture.
      const control = getAutopilotControl();
      if (control) flushSync(() => control.setSitePermissions(permissions));
      return Promise.resolve();
    },
    emitAllowlist: (hosts: string[]) => {
      // Seed useAdblock's allowlistedHosts via the control-surface seam
      // (setAllowlistedHosts → useAdblock._setAllowlistedHosts → React state update).
      // Uses flushSync so the DOM updates synchronously before the next gesture fires.
      // Same pattern as emitSitePermissions / emitHistory / emitSaved.
      const control = getAutopilotControl();
      if (control) flushSync(() => control.setAllowlistedHosts(hosts));
      return Promise.resolve();
    },
    emitDownloadsChanged: (entries: import('../../shared/types').DownloadEntry[]) => {
      // Seed the DownloadsPanel by calling setDownloadEntries on the autopilot control,
      // which directly calls useDownloads' _setDownloads React state setter (same seam
      // as setHistoryEntries / emitHistory).  Uses flushSync so the DOM updates
      // synchronously before the next gesture fires — exactly as emitHistory does.
      const control = getAutopilotControl();
      if (control) flushSync(() => control.setDownloadEntries(entries));
      return Promise.resolve();
    },
    emitNavFailed: (f: NavFailed) => {
      // Invoke the onFailed callback that App's useEffect registered so the error
      // overlay renders synchronously — identical to the real core emitting nav.failed.
      if (navFailedCallback) flushSync(() => navFailedCallback(f));
      return Promise.resolve();
    },
    emitNavCrashed: (c: NavCrashed) => {
      // Invoke the onCrashed callback that App's useEffect registered so the crash
      // overlay renders synchronously — identical to the real core emitting nav.crashed.
      if (navCrashedCallback) flushSync(() => navCrashedCallback(c));
      return Promise.resolve();
    },
    emitSafetyInterstitial: (p: SafetyInterstitialPayload | null) => {
      // Invoke the onInterstitial callback that useSafety registered so the
      // SafetyInterstitial renders (or clears when p is null).
      if (safetyInterstitialCallback) flushSync(() => safetyInterstitialCallback(p));
      return Promise.resolve();
    },
    emitPermissionPrompt: (p: PermissionPrompt | null) => {
      // Invoke the onPrompt callback that usePermissions registered so the
      // PermissionPromptDialog renders (or clears when p is null).
      if (permissionPromptCallback) flushSync(() => permissionPromptCallback(p));
      return Promise.resolve();
    },
    emitRedirectBlocked: (r: RedirectBlocked) => {
      // Invoke the onBlocked callback that App's useEffect registered so the
      // redirect auto-opens in a background tab.
      if (redirectBlockedCallback) flushSync(() => redirectBlockedCallback(r));
      return Promise.resolve();
    },
    emitFindState: (s: FindState) => {
      // Push a FindState update into useFind so the FindBar re-renders with the
      // given matchCount — e.g. enables Find next / Find previous buttons when
      // matchCount > 0.  Uses flushSync so the DOM updates synchronously before
      // the next gesture fires (same pattern as emitNavState / emitTabsState).
      if (findStateCallback) flushSync(() => findStateCallback(s));
      return Promise.resolve();
    },
    emitBlockedCount: (c: BlockedCount) => {
      // Push a BlockedCount update into useAdblock so the AdblockShield badge
      // re-renders with the given page count — mirroring what the real core emits
      // via adblock.blockedCount.  Uses flushSync so the DOM updates synchronously
      // before the next gesture fires (same pattern as emitNavState / emitFindState).
      if (blockedCountCallback) flushSync(() => blockedCountCallback(c));
      return Promise.resolve();
    },
    emitVaultState: (s: VaultState) => {
      // Push a VaultState update into useVault so VaultSettingsTab re-renders in the
      // desired state (create / locked / unlocked).  Uses flushSync so the DOM updates
      // synchronously before the next gesture fires — same pattern as emitNavState.
      if (vaultStateCallback) flushSync(() => vaultStateCallback(s));
      return Promise.resolve();
    },
    emitVaultRecords: (records: import('../../shared/types').VaultRecord[]) => {
      // Directly seed the VaultSettingsTab's displayed records list via the autopilot
      // control seam (vault._setRecordsRef → setRecords).  Uses flushSync so the DOM
      // updates synchronously before the next gesture fires — bypasses the async
      // vault.list() → setRecords chain that would need act() to commit in jsdom.
      const control = getAutopilotControl();
      if (control) flushSync(() => control.setVaultRecords(records));
      return Promise.resolve();
    },
    emitFingerprintState: (s: import('../../shared/types').FingerprintState) => {
      // Directly seed the fingerprint state via the autopilot control seam
      // (setFingerprintState → useFingerprint._setState).  Uses flushSync so the DOM
      // updates synchronously before the next gesture fires — same pattern as
      // emitAllowlist / emitSitePermissions.
      const control = getAutopilotControl();
      if (control) flushSync(() => control.setFingerprintState(s));
      return Promise.resolve();
    },
  };
}

export function makeLiveCtx(aegis: AegisApi, reach: Reach): InteractionCtx {
  const root = document.body;
  const setNativeValue = (el: Element, value: string) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  };
  const fire = (el: Element, key: string, mods: Partial<KeyboardEventInit> = {}) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }),
    );
  return {
    layer: 'live',
    click: async (el) => {
      (el as HTMLElement).click();
    },
    type: async (el, text) => {
      (el as HTMLElement).focus();
      setNativeValue(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    press: async (key) => {
      const target = (document.activeElement ?? root) as Element;
      if (key === 'Enter') fire(target, 'Enter');
      else if (key === 'Escape') fire(target, 'Escape');
      else if (key === 'ctrl+t') fire(target, 't', { ctrlKey: true });
      else if (key === 'ctrl+w') fire(target, 'w', { ctrlKey: true });
      else if (key === 'ctrl+shift+t') fire(target, 'T', { ctrlKey: true, shiftKey: true });
    },
    contextMenu: async (el) => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    },
    byRole: (role, name) => {
      // Minimal live role lookup: buttons + links + textboxes by accessible name.
      const sel =
        role === 'button'
          ? 'button,[role="button"]'
          : role === 'textbox'
            ? 'input,textarea'
            : `[role="${role}"]`;
      const els = Array.from(root.querySelectorAll(sel)) as HTMLElement[];
      if (!name) return els[0] ?? null;
      const re = name instanceof RegExp ? name : new RegExp(`^${name}$`);
      return (
        els.find((e) => re.test((e.getAttribute('aria-label') || e.textContent || '').trim())) ??
        null
      );
    },
    byText: (text) => {
      const re =
        text instanceof RegExp ? text : new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return (
        (Array.from(root.querySelectorAll('*')) as HTMLElement[]).find(
          (e) => e.children.length === 0 && re.test(e.textContent || ''),
        ) ?? null
      );
    },
    byLabel: (label) => {
      const re = label instanceof RegExp ? label : new RegExp(`^${label}$`);
      // 1. aria-label attribute (buttons, chips, icon controls).
      const byAria = (Array.from(root.querySelectorAll('[aria-label]')) as HTMLElement[]).find(
        (e) => re.test(e.getAttribute('aria-label') || ''),
      );
      if (byAria) return byAria;
      // 2. <label> association — `<label for=id>` or a wrapping `<label>` — so form
      //    inputs labelled the accessible way (not via aria-label) are also found.
      //    Mirrors testing-library's queryByLabelText, which the vitest ctx uses.
      for (const l of Array.from(root.querySelectorAll('label')) as HTMLLabelElement[]) {
        if (!re.test((l.textContent || '').trim())) continue;
        const forId = l.getAttribute('for');
        const target = forId
          ? root.querySelector(`#${CSS.escape(forId)}`)
          : l.querySelector('input,textarea,select');
        if (target) return target as HTMLElement;
      }
      return null;
    },
    bySelector: (sel) => root.querySelector(sel),
    aegis,
    calls: liveCallLog,
    reach: (s) => reach(s),
  };
}
