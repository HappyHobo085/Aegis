# Autopilot Interaction Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third enumerable catalog of _user interactions_ (real gestures on real
controls) that drives the chrome UI the way a user does and asserts the effect — run in
both a continuous vitest tour (mocked core) and the live autopilot (real core) — so the
tests catch UI-wiring / validation / combination bugs a real user would hit.

**Architecture:** `src/autopilot/interactions.ts` exports `INTERACTIONS: InteractionSpec[]`.
A layer-agnostic `InteractionCtx` (built per layer by `interactionCtx.ts`) provides
gesture helpers (`click`/`type`/`press`), DOM queries, the aegis client (mock or real), and
a `CallLog` (vitest call assertions). The vitest tour (`interactions.test.tsx`) renders the
real `<App/>` + mocked core and runs every `'vitest'` interaction; `run.ts` step 2c runs
every `'live'` interaction against the real core. A drift guard fails the build when an
interactive control has no interaction entry.

**Tech Stack:** React 19 + TypeScript, vitest (jsdom project for `src/**`),
`@testing-library/react` (already a dep) + `@testing-library/user-event` (already
installed — DO NOT add a dependency), the existing autopilot harness.

## Global Constraints

- **Never in production.** All new files live under `src/autopilot/`; nothing is imported
  outside the autopilot entry (`main.tsx` dev gate). Do not import `interactions.ts` from
  app code.
- **`assert` must be test-framework-agnostic.** `run`/`assert` run in BOTH vitest and the
  live renderer. NEVER call `expect`/`vi` inside an `InteractionSpec`. `assert` THROWS on
  failure (like the existing `verify` round-trips) and returns a short success string. The
  vitest tour translates a throw into a failed test.
- **Selectors are semantic.** Query by role/text/aria-label/`data-testid`, never by brittle
  CSS class chains. If a control has no accessible name, ADD an `aria-label` to its
  component (small justified UI improvement) and select by it.
- **Live is non-destructive-safe** (disposable XDG profile) and **degrades to skip, never
  false-fail** when a real effect can't be observed (bounded polls, mirror the existing
  `verify` round-trips in `catalog.ts`).
- **Drift guard is enforcement, not decoration:** every interactive control appears in
  `INTERACTIVE_CONTROLS` and has ≥1 `INTERACTIONS` entry; ids unique; `screen` valid; ≥1
  `layer` each.
- **Living docs:** when a task adds a catalog/screen/interaction, update `src/CLAUDE.md` +
  `scripts/CLAUDE.md` in the same task. The root `CLAUDE.md` pre-push gate already requires
  interaction coverage.
- **Gate per task:** `npm test` green before commit. Final task also runs the live
  autopilot.

---

## File Structure

| File                                                   | Responsibility                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/autopilot/interactions.ts` (create)               | `InteractionSpec`/`InteractionLayer`/`InteractionCtx`/`CallLog` types + `INTERACTIONS` array + `INTERACTIVE_CONTROLS` registry. |
| `src/autopilot/interactionCtx.ts` (create)             | `makeVitestCtx(...)` + `makeLiveCtx(...)` factories; gesture + query + CallLog implementations per layer.                       |
| `src/autopilot/interactions.test.tsx` (create)         | Desktop vitest interaction tour (iterates `'vitest'` entries against real `<App/>` + mock).                                     |
| `src/autopilot/interactions.mobile.test.tsx` (create)  | Mobile-shell interaction tour.                                                                                                  |
| `src/autopilot/interactions.coverage.test.ts` (create) | Drift guard for interactions + `INTERACTIVE_CONTROLS`.                                                                          |
| `src/autopilot/interactionCtx.test.tsx` (create)       | Unit tests for the ctx factories + CallLog.                                                                                     |
| `src/autopilot/run.ts` (modify)                        | Step 2c: run `'live'` interactions → `interaction:<id>` result rows.                                                            |
| `src/autopilot/report.ts` (modify)                     | Add `'interaction'` to `StepResult.kind`.                                                                                       |
| Component files (modify, as needed)                    | Add `aria-label`s where a control has no accessible name.                                                                       |
| `src/CLAUDE.md`, `scripts/CLAUDE.md` (modify)          | Document the third catalog.                                                                                                     |

---

### Task 1: Interaction catalog types + ctx factories + CallLog

**Files:**

- Create: `src/autopilot/interactions.ts`
- Create: `src/autopilot/interactionCtx.ts`
- Test: `src/autopilot/interactionCtx.test.tsx`

**Interfaces:**

- Produces: `InteractionSpec`, `InteractionLayer` (`'vitest'|'live'`), `InteractionCtx`,
  `CallLog`, `INTERACTIONS: InteractionSpec[]` (empty for now), `INTERACTIVE_CONTROLS:
Set<string>` (empty for now); `makeVitestCtx(root: HTMLElement, aegis: AegisApi,
reach): InteractionCtx`, `makeLiveCtx(aegis: AegisApi, reach): InteractionCtx`.

- [ ] **Step 1: Write `interactions.ts` types + empty registries**

```ts
// src/autopilot/interactions.ts
import type { AegisApi } from '../../shared/types';
import type { ScreenId } from './screens';

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
  byRole(role: string, name?: string | RegExp): HTMLElement | null;
  byText(text: string | RegExp): HTMLElement | null;
  byLabel(label: string | RegExp): HTMLElement | null;
  bySelector(sel: string): HTMLElement | null;
  aegis: AegisApi;
  calls: CallLog;
  reach(screen: ScreenId): Promise<void>;
}

export interface InteractionSpec {
  id: string;
  domain: string;
  description: string;
  screen: ScreenId;
  layers: InteractionLayer[];
  run(ctx: InteractionCtx): Promise<void>;
  assert(ctx: InteractionCtx): Promise<string>;
}

/** Filled in per-domain by later tasks. */
export const INTERACTIONS: InteractionSpec[] = [];

/** Documented registry of every interactive control id; the drift guard asserts each has
 *  an INTERACTIONS entry. Filled in per-domain by later tasks (mirrors UNTESTED_CHANNELS). */
export const INTERACTIVE_CONTROLS = new Set<string>([]);
```

- [ ] **Step 2: Write `interactionCtx.ts` — both factories + CallLog**

```ts
// src/autopilot/interactionCtx.ts
import { within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AegisApi } from '../../shared/types';
import type { CallLog, InteractionCtx, ScreenId } from './interactions';
import type { ScreenId as SID } from './screens';

type Reach = (screen: SID) => Promise<void>;

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
  return {
    layer: 'vitest',
    click: (el) => user.click(el),
    type: async (el, text) => {
      await user.clear(el);
      await user.type(el, text);
    },
    press: (key) => user.keyboard(keyMap[key]),
    byRole: (role, name) => q.queryByRole(role, name ? { name } : undefined) as HTMLElement | null,
    byText: (text) => q.queryByText(text) as HTMLElement | null,
    byLabel: (label) => q.queryByLabelText(label) as HTMLElement | null,
    bySelector: (sel) => root.querySelector(sel),
    aegis,
    calls: vitestCallLog(aegis),
    reach: (s) => reach(s as SID),
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
      return (
        (Array.from(root.querySelectorAll('[aria-label]')) as HTMLElement[]).find((e) =>
          re.test(e.getAttribute('aria-label') || ''),
        ) ?? null
      );
    },
    bySelector: (sel) => root.querySelector(sel),
    aegis,
    calls: liveCallLog,
    reach: (s) => reach(s as SID),
  };
}
```

- [ ] **Step 3: Write the failing ctx unit test**

```tsx
// src/autopilot/interactionCtx.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { makeVitestCtx } from './interactionCtx';

describe('makeVitestCtx', () => {
  it('click fires the handler; type sets the value; CallLog records + resets', async () => {
    const onClick = vi.fn();
    const fakeAegis = { favorites: { add: vi.fn(async () => []) } } as never;
    const { container } = render(
      <div>
        <button aria-label="Add" onClick={onClick}>
          +
        </button>
        <input aria-label="URL" defaultValue="" />
      </div>,
    );
    const ctx = makeVitestCtx(container, fakeAegis, async () => {});
    await ctx.click(ctx.byLabel('Add')!);
    expect(onClick).toHaveBeenCalledTimes(1);
    await ctx.type(ctx.byLabel('URL')!, 'example.com');
    expect((ctx.byLabel('URL') as HTMLInputElement).value).toBe('example.com');
    await (fakeAegis as { favorites: { add: () => Promise<unknown> } }).favorites.add();
    expect(ctx.calls.of('favorites.add').length).toBe(1);
    ctx.calls.reset();
    expect(ctx.calls.of('favorites.add').length).toBe(0);
  });
});
```

- [ ] **Step 4: Run it** — `npx vitest run src/autopilot/interactionCtx.test.tsx` — Expected: PASS.
- [ ] **Step 5: Commit** — `git add src/autopilot/interactions.ts src/autopilot/interactionCtx.ts src/autopilot/interactionCtx.test.tsx && git commit -m "feat(autopilot): interaction catalog types + ctx factories"`

---

### Task 2: Tour runner + drift guard + live step 2c + first interaction

**Files:**

- Create: `src/autopilot/interactions.test.tsx`
- Create: `src/autopilot/interactions.coverage.test.ts`
- Modify: `src/autopilot/interactions.ts` (add the first interaction + control)
- Modify: `src/autopilot/run.ts` (step 2c), `src/autopilot/report.ts` (`'interaction'` kind)

**Interfaces:**

- Consumes: `INTERACTIONS`, `makeVitestCtx`, `makeLiveCtx`, `reachScreen`, `RunDeps.live`.
- Produces: the running tours + the `interaction:<id>` report rows.

- [ ] **Step 1: Add `'interaction'` to `report.ts` `StepResult.kind`**

In `src/autopilot/report.ts`, change the `kind` union to include `'interaction'`:

```ts
// find:    kind: 'visual' | 'core';
// replace: kind: 'visual' | 'core' | 'interaction';
```

(Apply to the `StepResult` interface and any `summarize` typing that enumerates kinds.)

- [ ] **Step 2: Add the first interaction (address bar → navigate) to `interactions.ts`**

```ts
// append to INTERACTIONS in src/autopilot/interactions.ts
{
  id: 'toolbar.addressBar.navigate',
  domain: 'toolbar',
  description: 'Type a URL in the address bar and press Enter → navigates',
  screen: 'home',
  layers: ['vitest', 'live'],
  run: async (ctx) => {
    const bar = ctx.byRole('textbox', /address|url|search/i) ?? ctx.bySelector('input[type="text"]');
    if (!bar) throw new Error('address bar input not found');
    await ctx.type(bar, 'example.com');
    await ctx.press('Enter');
  },
  assert: async (ctx) => {
    if (ctx.layer === 'vitest') {
      if (!ctx.calls.called('nav.navigate', (a) => String(a[1]).includes('example.com')))
        throw new Error('nav.navigate not called with example.com');
      return 'address bar Enter → nav.navigate(example.com)';
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if ((await ctx.aegis.nav.getState(1)).url.includes('example.com')) return 'address bar Enter → page navigated';
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('live: url never became example.com');
  },
},
```

And add `'toolbar.addressBar'` to `INTERACTIVE_CONTROLS`.

> NOTE for the implementer: open `src/components/Toolbar.tsx` + `AddressBar.tsx` and confirm
> the address input's accessible name. If it has none, add `aria-label="Address bar"` and
> query `ctx.byLabel('Address bar')` instead of the role/selector fallback above.

- [ ] **Step 3: Write the vitest tour runner**

```tsx
// src/autopilot/interactions.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { INTERACTIONS } from './interactions';
import { makeVitestCtx } from './interactionCtx';
import { reachScreen } from './reach';
import { getAutopilotControl } from './control';
import { SCREENS, type ScreenId } from './screens';

vi.mock('../lib/ipcClient', async () =>
  (await import('../testFixtures/aegisMock')).aegisMockModule(),
);

const screenById = (id: ScreenId) => SCREENS.find((s) => s.id === id)!;

beforeEach(() => {
  vi.stubEnv('VITE_AEGIS_AUTOPILOT', '1');
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  delete (window as Record<string, unknown>).__aegisAutopilot;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('desktop interaction tour', () => {
  for (const spec of INTERACTIONS.filter((s) => s.layers.includes('vitest'))) {
    it(`interaction: ${spec.id}`, async () => {
      const { App } = await import('../App');
      const { aegis } = await import('../lib/ipcClient');
      const { container } = render(<App />);
      const control = getAutopilotControl()!;
      const ctx = makeVitestCtx(container, aegis, (s) =>
        reachScreen(control, screenById(s), { emitEvent: vi.fn() }),
      );
      await act(async () => {
        await ctx.reach(spec.screen);
      });
      ctx.calls.reset();
      await act(async () => {
        await spec.run(ctx);
      });
      await expect(spec.assert(ctx), spec.id).resolves.toBeTruthy();
    });
  }
});
```

> Note: event-driven screens (errorOverlay, safety, permission, redirectBar) won't render
> from `reachScreen` here because the tour passes a no-op `emitEvent` — those interactions
> are handled specially in Task 8 (the `emitViaMock` helper), so Task 3–7 interactions
> target control-/overlay-/settings-/sidebar-reachable screens only.

- [ ] **Step 4: Write the drift guard**

```ts
// src/autopilot/interactions.coverage.test.ts
import { describe, it, expect } from 'vitest';
import { INTERACTIONS, INTERACTIVE_CONTROLS } from './interactions';
import { SCREENS } from './screens';

describe('interaction coverage drift guard', () => {
  const ids = INTERACTIONS.map((i) => i.id);
  it('interaction ids are unique', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every interaction targets a real screen and declares ≥1 layer', () => {
    const screens = new Set(SCREENS.map((s) => s.id));
    for (const i of INTERACTIONS) {
      expect(screens.has(i.screen), `${i.id} screen`).toBe(true);
      expect(i.layers.length, `${i.id} layers`).toBeGreaterThan(0);
    }
  });
  it('every registered interactive control has ≥1 interaction', () => {
    for (const control of INTERACTIVE_CONTROLS)
      expect(
        ids.some((id) => id.startsWith(control)),
        `control ${control} has no interaction`,
      ).toBe(true);
  });
});
```

- [ ] **Step 5: Wire live step 2c in `run.ts`**

After the "2b) Functional verification" block, add (live-only):

```ts
// 2c) Interaction tour (LIVE ONLY): drive real gestures on the real chrome UI.
if (deps.live) {
  const { INTERACTIONS } = await import('./interactions');
  const { makeLiveCtx } = await import('./interactionCtx');
  const ctx = makeLiveCtx(deps.api, (s) =>
    reachScreen(deps.control, screenById(s), { emitEvent: deps.emitEvent }),
  );
  for (const spec of INTERACTIONS.filter((s) => s.layers.includes('live'))) {
    try {
      await ctx.reach(spec.screen);
      await spec.run(ctx);
      const detail = await spec.assert(ctx);
      results.push({
        id: `interaction:${spec.id}`,
        kind: 'interaction',
        title: spec.description,
        status: 'pass',
        detail,
      });
    } catch (e) {
      results.push({
        id: `interaction:${spec.id}`,
        kind: 'interaction',
        title: spec.description,
        status: 'fail',
        detail: String(e),
      });
    } finally {
      await leaveScreen(deps.control, screenById(spec.screen), { emitEvent: deps.emitEvent }).catch(
        () => {},
      );
    }
  }
}
```

Add a `screenById` helper in `run.ts`: `const screenById = (id: ScreenId) => SCREENS.find((s) => s.id === id)!;` (import `SCREENS` + `ScreenId`).

- [ ] **Step 6: Run** — `npm test` — Expected: PASS (new tour has 1 interaction; coverage + run.test.ts green).
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat(autopilot): interaction tour runner + drift guard + live step 2c"`

---

### Tasks 3–9: Per-domain interaction sets

**For every domain task below, follow this exact recipe:**

1. For each control, open its component, confirm/add an accessible name (`aria-label`),
   and add an `InteractionSpec` to `INTERACTIONS` and the control id to
   `INTERACTIVE_CONTROLS`. Use the **canonical pattern**:

```ts
{
  id: '<domain>.<control>.<action>',
  domain: '<domain>',
  description: '<what the user does>',
  screen: '<ScreenId the control is on>',
  layers: ['vitest', 'live'],          // or ['vitest']/['live'] per the notes
  run: async (ctx) => {
    const el = ctx.byRole('button', /Accessible Name/) /* or byLabel/byText */;
    if (!el) throw new Error('<control> not found');
    await ctx.click(el);               // or ctx.type(el, '…') / ctx.press('…')
  },
  assert: async (ctx) => {
    if (ctx.layer === 'vitest') {
      if (!ctx.calls.called('<aegis.path>', (a) => /* args match */ true))
        throw new Error('<aegis.path> not called as expected');
      return '<success detail>';
    }
    // live: read real state via ctx.aegis (bounded poll), throw on mismatch, return detail.
    return '<success detail>';
  },
},
```

2. Run `npx vitest run src/autopilot/interactions.test.tsx src/autopilot/interactions.coverage.test.ts` — all green.
3. Update `src/CLAUDE.md` (the interactions section) if the task adds a new pattern.
4. Commit `feat(autopilot): <domain> interactions`.

> **Live `layers` guidance:** include `'live'` when the effect is observable via real state
> (favorites/saved/history/tabs/adblock/settings stores, real nav). Use `['vitest']` only
> when the live core won't emit the precondition (e.g. a synthesized crash/permission event)
> or the live effect is non-deterministic. When unsure, include both and have the live
> branch degrade to a returned skip-detail rather than throw.

#### Task 3: toolbar + shield popover

**Screen:** `home` (toolbar), `shieldPopover`. Add interactions + controls:

| id                            | gesture                          | expected effect (vitest call / live state)                                | layers |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------- | ------ |
| `toolbar.back`                | click Back (`aria-label="Back"`) | `nav.back` called                                                         | both   |
| `toolbar.forward`             | click Forward                    | `nav.forward` called                                                      | both   |
| `toolbar.reload`              | click Reload/Stop                | `nav.reloadOrStop` called                                                 | both   |
| `toolbar.home`                | click Home                       | `nav.home` called                                                         | both   |
| `toolbar.addressBar.search`   | type `hello world` + Enter       | `nav.navigate` called with a search URL containing `hello`                | both   |
| `toolbar.bookmarkStar.add`    | click star                       | `favorites.add` called; live: `favorites.list()` contains the current url | both   |
| `toolbar.bookmarkStar.remove` | click star again                 | `favorites.remove` called; live: url gone from list                       | both   |
| `toolbar.picker`              | click picker                     | `picker.start` called                                                     | vitest |
| `shieldPopover.toggleAdblock` | open popover → click toggle      | `adblock.setEnabled` called                                               | both   |
| `shieldPopover.allowlistSite` | open popover → click allowlist   | `adblock.toggleAllowlist` called                                          | both   |

Full example (`toolbar.bookmarkStar.add`):

```ts
{
  id: 'toolbar.bookmarkStar.add', domain: 'toolbar',
  description: 'Click the bookmark star → adds the current page to favorites',
  screen: 'home', layers: ['vitest', 'live'],
  run: async (ctx) => {
    const star = ctx.byRole('button', /bookmark|favorite/i);
    if (!star) throw new Error('bookmark star not found');
    await ctx.click(star);
  },
  assert: async (ctx) => {
    if (ctx.layer === 'vitest') {
      if (!ctx.calls.called('favorites.add')) throw new Error('favorites.add not called');
      return 'bookmark star → favorites.add';
    }
    const url = (await ctx.aegis.nav.getState(1)).url;
    if (!(await ctx.aegis.favorites.list()).some((f) => f.url === url)) throw new Error('live: url not in favorites');
    return 'bookmark star → favorite persisted';
  },
},
```

> The bookmark `add`/`remove` pair must run in sequence and clean up (live: ensure the
> probe favorite is removed at the end). Confirm the star's `aria-label` in
> `BookmarkButton.tsx`; add one if missing.

#### Task 4: tabs + keyboard shortcuts

**Screen:** `home`. Controls: TabStrip new/activate/close/pin/reorder + Ctrl+T/W/Shift+T.

| id                   | gesture                            | expected                                     | layers |
| -------------------- | ---------------------------------- | -------------------------------------------- | ------ |
| `tabs.newButton`     | click `+` (`aria-label="New tab"`) | `tabs.create` called; live: tab count +1     | both   |
| `tabs.activate`      | click a second tab                 | `tabs.activate` called                       | both   |
| `tabs.close`         | click a tab's X                    | `tabs.close` called; live: count −1          | both   |
| `tabs.setPinned`     | pin via context/menu               | `tabs.setPinned` called                      | vitest |
| `keyboard.newTab`    | `press('ctrl+t')`                  | `tabs.create` called OR `tabs.shortcut` path | both   |
| `keyboard.closeTab`  | `press('ctrl+w')`                  | close path invoked                           | vitest |
| `keyboard.reopenTab` | `press('ctrl+shift+t')`            | `tabs.reopenClosed` path                     | vitest |

> Implementer: confirm how the desktop tab shortcuts are delivered to the chrome (native
> accelerator vs a DOM key handler). In vitest there is no native layer, so a shortcut that
> is ONLY a native accelerator can't be exercised in jsdom — mark it `['live']` and assert
> the live effect, OR if App has a `keydown` handler, keep `['vitest','live']`. Verify in
> `App.tsx`/`TabStrip.tsx` before choosing layers; do not guess.

#### Task 5: favorites bar/manager + sidebar history

**Screens:** `home` (favbar), `favoritesManager`, `sidebar:history`.

| id                            | gesture               | expected                                      | layers |
| ----------------------------- | --------------------- | --------------------------------------------- | ------ |
| `favbar.openFavorite`         | click a favorite chip | `nav.navigate` to its url                     | both   |
| `favManager.add`              | open manager → add    | `favorites.add` called                        | both   |
| `favManager.rename`           | edit a name → save    | `favorites.update` called; live: name changed | both   |
| `favManager.delete`           | click delete          | `favorites.remove` called; live: gone         | both   |
| `sidebar.history.openEntry`   | click a history row   | `nav.navigate`                                | both   |
| `sidebar.history.deleteEntry` | click row delete      | `history.remove` called                       | both   |
| `sidebar.history.search`      | type in search box    | `history.search` called with the query        | both   |
| `sidebar.history.clear`       | click Clear (confirm) | `history.clear` called                        | both   |

> Seeding: in the live run, history/favorites may be empty when the sidebar opens. For
> `openEntry`/`deleteEntry`, first ensure a row exists (navigate, or `favorites.add`) then
> interact; clean up after. In vitest the mock returns fixed lists — confirm the mock's
> `favorites.list`/`history.list` return ≥1 row, or seed via the mock before rendering.

#### Task 6: sidebar saved + tags

**Screen:** `sidebar:saved`. Controls: saved add/edit/delete + tag add/rename/delete + tag-chip filter.

| id                          | gesture              | expected                                                | layers |
| --------------------------- | -------------------- | ------------------------------------------------------- | ------ |
| `sidebar.saved.openEntry`   | click a saved row    | `nav.navigate`                                          | both   |
| `sidebar.saved.delete`      | click delete         | `saved.remove` called                                   | both   |
| `sidebar.saved.addTag`      | add a tag to an item | `saved.update` called with the new tags                 | both   |
| `sidebar.saved.renameTag`   | rename a tag         | `saved.renameTag` called                                | both   |
| `sidebar.saved.deleteTag`   | delete a tag         | `saved.deleteTag` called                                | both   |
| `sidebar.saved.filterByTag` | click a tag chip     | list filters (UI assertion: only matching rows visible) | vitest |

> The tag-edit UI affordances live in `SavedPanel.tsx`. Open it and confirm the exact
> controls (an input + add button? inline chips with an X?) before writing selectors; add
> `aria-label`s as needed. `filterByTag` asserts a UI effect (visible rows) not an aegis
> call — assert via `ctx.byText`/row count.

#### Task 7: settings (every tab)

**Screens:** `settings:<tab>` for each `SettingsTab` in `TAB_ORDER`. One interaction per
control. Representative set (add ALL controls on each tab):

| id                                 | gesture                       | expected                          | layers |
| ---------------------------------- | ----------------------------- | --------------------------------- | ------ |
| `settings.appearance.primaryColor` | change color input            | `settings.set({primaryColor})`    | both   |
| `settings.search.engine`           | pick an engine / set template | `settings.set`                    | both   |
| `settings.home.homeUrl`            | type a home URL               | `settings.set({homeUrl})`         | both   |
| `settings.tabs.idleTimeout`        | change timeout                | `settings.set({tabIdleTimeout})`  | both   |
| `settings.filterLists.toggleSub`   | toggle a subscription         | `subs.setEnabled`                 | both   |
| `settings.myFilters.save`          | edit textarea + Save          | `customFilters.set` with the text | both   |
| `settings.allowlist.add`           | type host + Add               | `adblock.toggleAllowlist`         | both   |
| `settings.allowlist.remove`        | click remove on a host        | `adblock.removeAllowlist`         | both   |
| `settings.security.httpsOnly`      | toggle                        | `settings.set({httpsOnly})`       | both   |
| `settings.security.webrtc`         | change policy                 | `settings.set({webrtcPolicy})`    | both   |
| `settings.data.export`             | click Export                  | `data.export` called              | both   |

> Reach each tab with `screen: 'settings:<tab>'` (the existing `reachScreen` opens Settings
> and clicks the tab). Confirm each control's accessible name in its `*Tab.tsx` component.
> `data.import`/clear-data may open a native dialog — mark those `['vitest']` (assert the
> handler fires) and do not trigger a real import live.

#### Task 8: overlays

**Screens:** `downloads`, `confirmDialog`, `errorOverlay`, `crashOverlay`,
`safetyInterstitial`, `permissionPrompt`, `redirectBar`.

| id                       | gesture                             | expected                              | layers |
| ------------------------ | ----------------------------------- | ------------------------------------- | ------ |
| `downloads.clear`        | open modal → Clear                  | `downloads.clear` called              | vitest |
| `confirm.confirm`        | open confirm → OK                   | the confirm resolver runs (UI closes) | vitest |
| `confirm.cancel`         | open confirm → Cancel               | dialog closes, no action              | vitest |
| `errorOverlay.retry`     | emit nav.failed → click Retry       | `nav.reloadOrStop`/reload path        | vitest |
| `crashOverlay.reload`    | emit nav.crashed → click Reload     | reload path                           | vitest |
| `safety.proceed`         | emit interstitial → Proceed         | `safety.proceed` called               | vitest |
| `safety.back`            | emit interstitial → Back            | `nav.back`/dismiss                    | vitest |
| `permission.allow`       | emit prompt → Allow                 | `permissions.resolve(allow)`          | vitest |
| `permission.deny`        | emit prompt → Deny                  | `permissions.resolve(deny)`           | vitest |
| `redirectBar.openAnyway` | emit redirect.blocked → Open anyway | `tabs.create(to)` called              | vitest |
| `redirectBar.dismiss`    | emit redirect.blocked → X           | bar hidden (UI assertion)             | vitest |

> These are mostly `['vitest']`: their preconditions are synthesized events the live core
> won't emit on demand. In vitest, the tour's `reachScreen` for these event-screens calls
> `emitEvent` — but the tour passes a real `emitEvent`? NO: the desktop tour mocks emitEvent
> as a no-op, so the overlay won't render. FIX in this task: the interaction tour must use a
> **real event dispatch** for event-screens — pass an `emitEvent` that drives the dev event
> path used in tests (call the same window/event mechanism `useSafety`/`usePermissions`
> subscribe to). Confirm how those hooks receive events in jsdom (they subscribe via
> `aegis.safety.onState` etc., which are vi.fn mocks returning unsubscribe). To render the
> overlay in vitest you must invoke the subscribed callback: capture the callback passed to
> the mock (`aegis.safety.onState.mock.calls[0][0]`) and call it with the payload. Implement
> a small `emitViaMock(aegis, screenId, payload)` helper in this task and use it for the
> event-screen interactions. Verify each hook's subscription method name before wiring.

#### Task 9: edge/error inputs + state combinations

**Screens:** various. These assert graceful handling (no crash, no bad call).

| id                          | gesture                          | expected                                          | layers |
| --------------------------- | -------------------------------- | ------------------------------------------------- | ------ |
| `edge.addressBar.empty`     | focus address bar, clear, Enter  | NO `nav.navigate` (or navigate to home), no crash | both   |
| `edge.addressBar.malformed` | type `ht!tp://x`, Enter          | navigates as search or no-op, no crash            | both   |
| `edge.favorite.duplicate`   | bookmark the same url twice      | only one favorite (live: list has 1)              | live   |
| `edge.tag.whitespace`       | add a `'   '` tag                | tag rejected/trimmed (no empty tag)               | both   |
| `edge.bookmark.doubleClick` | click star twice rapidly         | net toggle correct (not double-add)               | vitest |
| `combo.settingsOverSidebar` | open sidebar, then Settings      | both states correct, no crash                     | vitest |
| `combo.tabSwitchWithModal`  | open downloads modal, switch tab | modal state consistent                            | vitest |

> Each `assert` checks the absence of a bad effect (e.g. `ctx.calls.of('nav.navigate')`
> length is 0 for empty input) AND that `<App/>` is still mounted (`document.querySelector('.app')`).

---

### Task 10: mobile interactions + docs + final drift-guard enforcement

**Files:**

- Create: `src/autopilot/interactions.mobile.test.tsx`
- Modify: `src/autopilot/interactions.ts` (mobile-only controls if any), `src/CLAUDE.md`,
  `scripts/CLAUDE.md`

- [ ] **Step 1:** Write `interactions.mobile.test.tsx` mirroring `interactions.test.tsx` but
      rendering the mobile shell (set the `.aegis-mobile` path as `tour.mobile.test.tsx` does —
      open that file and copy its mobile-bootstrap). Run only interactions whose `screen`/control
      exists on mobile (filter by a `mobile?: boolean` flag added to the relevant specs, or a
      `domain` allowlist). Add mobile-only controls (bottom bar, menu sheet, tab switcher) as
      new interactions if not already covered.
- [ ] **Step 2:** Document the third catalog in `src/CLAUDE.md` (a new "Interactions" bullet
      in the autopilot section: `interactions.ts` + `interactionCtx.ts` + the two tours + the
      drift guard + live step 2c) and in `scripts/CLAUDE.md` (the live run now also reports
      `interaction:*` rows).
- [ ] **Step 3:** Confirm `INTERACTIVE_CONTROLS` lists every interactive control across all
      domains and the drift guard passes; if any control is intentionally not interaction-tested
      (truly OS/dialog-bound), document why in a comment next to the registry (mirroring
      `UNTESTED_CHANNELS`).
- [ ] **Step 4:** Run `npm test` — Expected: all green.
- [ ] **Step 5: Live verification** — `bash scripts/autopilot/run-autopilot.sh` — Expected:
      `RESULT: … 0 failed`, the new `interaction:*` rows pass, `ad-block blocking (trace): PASS`.
      Paste the result. Any failing `interaction:*` row is a real bug — triage before final commit.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(autopilot): mobile interactions + docs + drift-guard enforcement"`

---

## Notes for all tasks

- Run the focused tests during a task (`npx vitest run src/autopilot/...`), the full
  `npm test` before each commit.
- If a control lacks an accessible name, prefer adding an `aria-label` (improves real
  accessibility too) over a CSS-class selector.
- Keep each `InteractionSpec` small and single-purpose; the `id` is `domain.control.action`.
- Live interactions that mutate user data must restore state (the profile is disposable, but
  leave it clean so later interactions/inductions aren't perturbed).
