// src/autopilot/interactionCtx.ts
import { within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AegisApi } from '../../shared/types';
import type { CallLog, InteractionCtx } from './interactions';
import type { ScreenId } from './screens';

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
  return {
    layer: 'vitest',
    click: (el) => user.click(el),
    type: async (el, text) => { await user.clear(el); await user.type(el, text); },
    press: (key) => user.keyboard(keyMap[key]),
    byRole: (role, name) => q.queryByRole(role, name ? { name } : undefined) as HTMLElement | null,
    byText: (text) => q.queryByText(text) as HTMLElement | null,
    byLabel: (label) => q.queryByLabelText(label) as HTMLElement | null,
    bySelector: (sel) => root.querySelector(sel),
    aegis,
    calls: vitestCallLog(aegis),
    reach: (s) => reach(s),
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
