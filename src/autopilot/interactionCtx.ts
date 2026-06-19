// src/autopilot/interactionCtx.ts
import { within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'react-dom';
import type { AegisApi, NavState, TabsState, TabShortcut, Favorite, HistoryEntry } from '../../shared/types';
import type { CallLog, InteractionCtx } from './interactions';
import type { ScreenId } from './screens';
import { getAutopilotControl } from './control';

type Reach = (screen: ScreenId) => Promise<void>;

/** Resolve a dotted path ('favorites.add') against an object; undefined if absent. */
function resolve(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o == null ? o : (o as Record<string, unknown>)[k]), obj);
}

/** CallLog over a vitest-mocked aegis (every method is a vi.fn with a `.mock.calls`). */
function vitestCallLog(aegis: AegisApi): CallLog {
  const fn = (path: string): { mock?: { calls: unknown[][] }; mockClear?: () => void } | undefined =>
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
            if (typeof v === 'function' && (v as { mockClear?: () => void }).mockClear) (v as { mockClear: () => void }).mockClear();
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
    Enter: '{Enter}', Escape: '{Escape}',
    'ctrl+t': '{Control>}t{/Control}', 'ctrl+w': '{Control>}w{/Control}',
    'ctrl+shift+t': '{Control>}{Shift>}t{/Shift}{/Control}',
  };

  // Capture the nav onState callback NOW (before calls.reset() wipes mock.calls).
  // App mounts synchronously in render(), so onState is called before makeVitestCtx.
  // Guard: aegis.nav may be absent in unit-test fakes that only stub a single domain.
  type NavStateMockFn = { mock?: { calls: ((s: NavState) => void)[][] } };
  const navStateCallback: ((s: NavState) => void) | undefined =
    aegis.nav
      ? (aegis.nav.onState as unknown as NavStateMockFn).mock?.calls?.[0]?.[0]
      : undefined;

  // Capture the tabs.onState callback (used by useTabs) to emit a TabsState
  // without touching the aegis mock — same pattern as navStateCallback.
  type TabsStateMockFn = { mock?: { calls: ((s: TabsState) => void)[][] } };
  const tabsStateCallback: ((s: TabsState) => void) | undefined =
    aegis.tabs
      ? (aegis.tabs.onState as unknown as TabsStateMockFn).mock?.calls?.[0]?.[0]
      : undefined;

  // Capture the tabs.onShortcut callback (registered by App's useEffect) so
  // keyboard-shortcut interactions can invoke it directly — there is no DOM
  // keydown handler for Ctrl+T/W/Shift+T on Linux/macOS (native-only accelerator).
  type TabsShortcutMockFn = { mock?: { calls: ((s: TabShortcut) => void)[][] } };
  const tabsShortcutCallback: ((s: TabShortcut) => void) | undefined =
    aegis.tabs
      ? (aegis.tabs.onShortcut as unknown as TabsShortcutMockFn).mock?.calls?.[0]?.[0]
      : undefined;

  return {
    layer: 'vitest',
    click: (el) => user.click(el),
    type: async (el, text) => { await user.clear(el); await user.type(el, text); },
    press: (key) => user.keyboard(keyMap[key]),
    contextMenu: async (el) => { fireEvent.contextMenu(el); },
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
        await new Promise((r) => setTimeout(r, 0));
      });
    },
  };
}

export function makeLiveCtx(aegis: AegisApi, reach: Reach): InteractionCtx {
  const root = document.body;
  const setNativeValue = (el: Element, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  };
  const fire = (el: Element, key: string, mods: Partial<KeyboardEventInit> = {}) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }));
  return {
    layer: 'live',
    click: async (el) => { (el as HTMLElement).click(); },
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
      const sel = role === 'button' ? 'button,[role="button"]' : role === 'textbox' ? 'input,textarea' : `[role="${role}"]`;
      const els = Array.from(root.querySelectorAll(sel)) as HTMLElement[];
      if (!name) return els[0] ?? null;
      const re = name instanceof RegExp ? name : new RegExp(`^${name}$`);
      return els.find((e) => re.test((e.getAttribute('aria-label') || e.textContent || '').trim())) ?? null;
    },
    byText: (text) => {
      const re = text instanceof RegExp ? text : new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return (Array.from(root.querySelectorAll('*')) as HTMLElement[]).find((e) => e.children.length === 0 && re.test(e.textContent || '')) ?? null;
    },
    byLabel: (label) => {
      const re = label instanceof RegExp ? label : new RegExp(`^${label}$`);
      return (Array.from(root.querySelectorAll('[aria-label]')) as HTMLElement[]).find((e) => re.test(e.getAttribute('aria-label') || '')) ?? null;
    },
    bySelector: (sel) => root.querySelector(sel),
    aegis,
    calls: liveCallLog,
    reach: (s) => reach(s),
  };
}

// Suppress unused import warning — fireEvent is part of the public API surface
// even though this factory file doesn't use it directly (interaction specs will).
void fireEvent;
