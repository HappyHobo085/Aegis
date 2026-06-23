# Light / System Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Aegis a light palette and an Appearance setting — **System / Dark / Light** (`themeMode`) — so the chrome re-themes instantly on toggle and **System** follows the OS's `prefers-color-scheme`, keeping today's dark look as the default.

**Architecture:** This is sub-project **F** of the Improvements Program (renderer-mostly). The existing dark CSS custom properties move from a flat `:root` block into a **`[data-theme="dark"]`** token block; a parallel **`[data-theme="light"]`** block defines the light values for the same token names (so every existing rule that reads `var(--bg)` etc. is untouched). A pure `resolveTheme(mode, prefersDark)` function in `src/lib/theme.ts` maps `themeMode` + the OS preference to a concrete `'dark' | 'light'`; `applyTheme` writes `data-theme` + `color-scheme` onto `document.documentElement` (alongside the existing `--accent-color`). A new `themeMode` settings field (no new IPC channel — `settings.set` shallow-merges it) drives it; both `App` and `MobileApp` subscribe to a `matchMedia('(prefers-color-scheme: dark)')` change listener so **System** re-resolves live. An `AppearanceTab` segmented control sets it. The autopilot gains two `'state'` screen entries (`theme:dark` / `theme:light`) so both palettes are captured.

**Tech Stack:** React 19 + TypeScript, plain CSS custom properties (no CSS framework), Vitest (jsdom for `src/`, node for `shared/`), `window.matchMedia` (mocked in tests), Tauri `settings.*` IPC (existing). Rust `settings.rs` gains one default key.

## Global Constraints

*(From spec §6 — every task implicitly includes these.)*

- **IPC in three places (when adding a channel):** a new channel goes in `shared/types.ts` (`IPC` const), the Rust `ipc()` dispatcher, and `src/lib/ipcClient.ts`. **This sub-project adds NO new channel** — `themeMode` is a *settings field*, which per `shared/CLAUDE.md` needs no channel: add it to `settings.rs defaults()` + the `Settings` interface; `settings.set` shallow-merges it.
- **Event names stay dotted logically**, translated `.`↔`:` at the boundary. (Not exercised here — no events added.)
- **Autopilot coverage in the same commit (drift-guarded):** a new UI screen/overlay → `screens.ts` (+ `reach.ts`); a new interactive control → an interaction test driving the real UI. The drift-guard tests (`src/autopilot/coverage.test.ts`, `src/autopilot/interactions.coverage.test.ts`) fail the build otherwise. **No new IPC channel here, so `catalog.ts` is untouched** (settings channels already have a catalog entry).
- **Gate per sub-project:** `npm test` green; for runtime-touching changes, the live autopilot `RESULT: … 0 failed` and `ad-block blocking (trace): PASS` on Linux.
- **Parity before "done":** bring Linux / Windows / macOS / Android to the same level. This feature is renderer-only (`index.css` + `theme.ts` + `AppearanceTab.tsx` + `settings.rs` default) — **identical code runs on every platform's webview**, so desktop (Linux/Win/mac) and the Android mobile shell all get it from the same source. Verification reality (spec §4): Linux live-verified, Android device-verified, Win/mac CI-built + owner device-verified.

---

## Testing reality (read first)

- **`src/lib/theme.ts`** is pure TypeScript (DOM writes + a `matchMedia` read). It is unit-tested in Vitest **jsdom** with `window.matchMedia` mocked. **TDD it strictly (red → green).**
- **`AppearanceTab.tsx`** is a presentational React component, unit-tested in Vitest jsdom with the `update` callback mocked (existing `AppearanceTab.test.tsx` pattern). **TDD it.**
- **`shared/types.ts`** (`Settings.themeMode`) is a type-only change; the contract invariants run in the Vitest **node** project. No behavior to assert beyond the field existing (TypeScript enforces it where consumed).
- **`src-tauri/src/settings.rs`** `defaults()` gains one key. The existing `merge_projection_is_per_key_lww` test already proves per-key merge; adding a default needs only a `cargo check`. There is no Rust test asserting the literal default set, so the verification step is `cargo check` + reading `defaults()`.
- **The CSS refactor (`index.css`)** can't be unit-tested headlessly (no rendered browser in jsdom asserts computed colors reliably for a 3700-line sheet). Its "test" is: the `theme.ts` unit tests prove the `data-theme` attribute is set correctly, and the **live autopilot** (`screens.ts` `theme:dark` / `theme:light`) screenshots both palettes for owner eyeball confirmation. Per `[[test-after-every-change]]` the owner does the on-screen confirmation.

Verification commands used throughout:
- JS (one file): `npx vitest run <path>`
- JS (whole suite): `npm test`
- Rust compile: `cargo check --manifest-path src-tauri/Cargo.toml`
- Run app live: `npm run tauri:dev`
- Live autopilot (Linux, needs a display): `bash scripts/autopilot/run-autopilot.sh`

---

## File Structure

**New files**

*(none — every change extends an existing file)*

**Modified files**

- `shared/types.ts` — add `themeMode: 'system' | 'dark' | 'light'` to the `Settings` interface (after `webrtcPolicy`, before `syncServerUrl`).
- `src/hooks/useSettings.ts` — add `themeMode` to the `emptySettings` seed; re-apply the full theme (not just accent) when `themeMode` OR `primaryColor` is part of an `update` or a sync-merged change.
- `src/lib/theme.ts` — add the `ThemeMode` type, the pure `resolveTheme(mode, prefersDark)` and `prefersDarkScheme()` helpers, and extend `applyTheme` to write `data-theme` + `color-scheme`. Add `watchSystemTheme(onChange)` (a `matchMedia` change subscription).
- `src/lib/theme.test.ts` — add tests for `resolveTheme` (all three modes × both OS prefs) and the extended `applyTheme` (sets `data-theme`/`color-scheme`).
- `src/components/AppearanceTab.tsx` — add a **Theme** segmented radio group (System / Dark / Light) above the accent color picker, calling `update({ themeMode })`.
- `src/components/AppearanceTab.test.tsx` — extend the fixture with `themeMode`; add tests for the new control (shows current mode, fires `update`).
- `src/index.css` — refactor the flat `:root` token block into a base `:root` (radii/shadows/non-color tokens stay) + a `[data-theme="dark"]` color-token block + a new `[data-theme="light"]` block; default `<html>` to dark; drop the static `color-scheme: dark` (now set per-theme by `applyTheme`).
- `src/App.tsx` — replace the one-shot `applyTheme(s)` effect with one that applies the resolved theme AND installs `watchSystemTheme` so **System** re-resolves on OS change.
- `src/components/mobile/MobileApp.tsx` — same change as `App.tsx` (the mobile shell applies the theme itself; line 76 today calls `applyTheme(s)` one-shot).
- `src/autopilot/screens.ts` — add `theme:dark` and `theme:light` to `OverlayScreenId` + the `SCREENS` array (`via: 'state'`).
- `src/autopilot/reach.ts` — handle the two new screen ids in `reachScreen` (apply the theme to `:root`) and reset to dark in `leaveScreen`.
- `src/autopilot/interactions/settings.ts` — add an interaction spec driving the Appearance theme control (vitest layer).
- `src/autopilot/interactions/controls.ts` — register the new control id `settings.appearance.themeMode`.
- `src-tauri/src/settings.rs` — add `"themeMode": "system"` to `defaults()`.

---

## Task 1: Add the `themeMode` settings field to the contract + Rust default

**Files:**
- Modify: `shared/types.ts` (the `Settings` interface, ~line 293–298)
- Modify: `src-tauri/src/settings.rs` (`defaults()`, ~line 14–31)

**Interfaces:**
- Produces: `Settings.themeMode: 'system' | 'dark' | 'light'` — consumed by every later task (`theme.ts`, `useSettings`, `AppearanceTab`, both shells). Default value `'system'`.

- [ ] **Step 1: Add the field to the `Settings` interface**

In `shared/types.ts`, inside `export interface Settings { … }`, add the field right after the `webrtcPolicy` field and before `syncServerUrl?`:

```ts
  /** Chrome theme: `'system'` (default) follows the OS via `prefers-color-scheme`,
   * `'dark'` / `'light'` force a palette. Renderer-only — the resolved palette is a
   * `data-theme` attribute on <html> (see src/lib/theme.ts). */
  themeMode: 'system' | 'dark' | 'light';
```

- [ ] **Step 2: Add the default on the Rust side**

In `src-tauri/src/settings.rs`, in `defaults()`, add the key (after `"webrtcPolicy"`, before `"syncServerUrl"`):

```rust
        "webrtcPolicy": "public-only",
        "themeMode": "system",
        "syncServerUrl": ""
```

- [ ] **Step 3: Verify the Rust core still compiles**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean (the `defaults()` JSON gains one string key; nothing reads it on the Rust side — it's a renderer-only field that `settings.set` shallow-merges and `settings.get` returns via `load()`).

- [ ] **Step 4: Verify the existing contract tests still pass**

Run: `npx vitest run shared/types.test.ts`
Expected: PASS (the field is additive; the `IPC` naming invariants are unaffected — no channel added).

- [ ] **Step 5: Commit**

```bash
git add shared/types.ts src-tauri/src/settings.rs
git commit -m "feat(theme): add themeMode settings field (system/dark/light)"
```

---

## Task 2: Theme resolution + DOM application in `src/lib/theme.ts`

**Files:**
- Modify: `src/lib/theme.ts`
- Test: `src/lib/theme.test.ts`

**Interfaces:**
- Consumes: `Settings.themeMode` (Task 1), `Settings.primaryColor` (existing).
- Produces:
  - `export type ThemeMode = 'system' | 'dark' | 'light'`
  - `export type ResolvedTheme = 'dark' | 'light'`
  - `export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme` — pure; `'system'` → `prefersDark ? 'dark' : 'light'`, else the mode itself.
  - `export function prefersDarkScheme(): boolean` — reads `window.matchMedia('(prefers-color-scheme: dark)').matches`, defaulting to `true` when `matchMedia` is unavailable (so a missing API keeps the historic dark default).
  - `export function applyTheme(s: Pick<Settings, 'primaryColor' | 'themeMode'>): void` — sets `--accent-color` (unchanged) AND `data-theme` + the `color-scheme` style on `document.documentElement`, resolving `themeMode` via `resolveTheme(s.themeMode, prefersDarkScheme())`.
  - `export function watchSystemTheme(onChange: () => void): () => void` — subscribes to the `(prefers-color-scheme: dark)` media query's `change` event; returns an unsubscribe function. No-op (returns a no-op cleanup) when `matchMedia` is unavailable.

  **Note for the implementer:** `applyTheme` is currently called in places that pass `{ primaryColor }` only (e.g. `useSettings` line 39/53). Task 3 updates those call sites to pass `themeMode` too. To keep `applyTheme` robust if a caller omits `themeMode`, **default a missing `themeMode` to `'system'`** inside `applyTheme` before resolving.

- [ ] **Step 1: Write the failing tests**

Replace the contents of `src/lib/theme.test.ts` with:

```ts
// src/lib/theme.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyTheme, resolveTheme, prefersDarkScheme, watchSystemTheme } from './theme';

/** Install a matchMedia mock that reports `dark` and returns the listener controls. */
function mockMatchMedia(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    // Legacy fallback (some engines); our code prefers addEventListener.
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  return { fire: () => listeners.forEach((cb) => cb()), listenerCount: () => listeners.size };
}

afterEach(() => {
  document.documentElement.style.removeProperty('--accent-color');
  document.documentElement.style.removeProperty('color-scheme');
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

describe('resolveTheme', () => {
  it('returns the explicit mode for dark and light', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('follows the OS preference for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('prefersDarkScheme', () => {
  it('reads matchMedia (prefers-color-scheme: dark)', () => {
    mockMatchMedia(true);
    expect(prefersDarkScheme()).toBe(true);
    mockMatchMedia(false);
    expect(prefersDarkScheme()).toBe(false);
  });

  it('defaults to dark when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersDarkScheme()).toBe(true);
  });
});

describe('applyTheme', () => {
  it('sets --accent-color on :root from the primaryColor setting', () => {
    mockMatchMedia(true);
    applyTheme({ primaryColor: '#ff5500', themeMode: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#ff5500');
  });

  it('sets data-theme="dark" and color-scheme dark for themeMode dark', () => {
    mockMatchMedia(false); // OS prefers light, but explicit dark must win
    applyTheme({ primaryColor: '#111', themeMode: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark');
  });

  it('sets data-theme="light" and color-scheme light for themeMode light', () => {
    mockMatchMedia(true); // OS prefers dark, but explicit light must win
    applyTheme({ primaryColor: '#111', themeMode: 'light' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
  });

  it('resolves system to the OS preference', () => {
    mockMatchMedia(false);
    applyTheme({ primaryColor: '#111', themeMode: 'system' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    mockMatchMedia(true);
    applyTheme({ primaryColor: '#111', themeMode: 'system' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('treats a missing themeMode as system', () => {
    mockMatchMedia(false);
    // @ts-expect-error — exercise the runtime default for callers passing only primaryColor
    applyTheme({ primaryColor: '#111' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('watchSystemTheme', () => {
  it('invokes the callback when the OS preference changes and unsubscribes cleanly', () => {
    const m = mockMatchMedia(true);
    const onChange = vi.fn();
    const off = watchSystemTheme(onChange);
    expect(m.listenerCount()).toBe(1);
    m.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
    expect(m.listenerCount()).toBe(0);
  });

  it('is a no-op (returns a usable cleanup) when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    const off = watchSystemTheme(vi.fn());
    expect(() => off()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/theme.test.ts`
Expected: FAIL — `resolveTheme`, `prefersDarkScheme`, `watchSystemTheme` are not exported; `applyTheme` doesn't set `data-theme`/`color-scheme`.

- [ ] **Step 3: Implement the resolution + application logic**

Replace the contents of `src/lib/theme.ts` with:

```ts
// src/lib/theme.ts
import type { Settings } from '../../shared/types';

export type ThemeMode = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Map a theme mode + the OS preference to a concrete palette. Pure. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'dark' || mode === 'light') return mode;
  return prefersDark ? 'dark' : 'light';
}

/** Whether the OS currently prefers a dark color scheme. Defaults to `true`
 * (Aegis's historic default) when `matchMedia` is unavailable. */
export function prefersDarkScheme(): boolean {
  if (typeof matchMedia !== 'function') return true;
  return matchMedia(DARK_QUERY).matches;
}

/** Apply the chrome theme to <html>: accent color (always) + the resolved palette
 * (`data-theme` attribute, read by the [data-theme="…"] token blocks in index.css)
 * + the matching `color-scheme` (so native form controls / scrollbars match). A caller
 * that omits `themeMode` (legacy accent-only callers) is treated as `'system'`. */
export function applyTheme(s: Pick<Settings, 'primaryColor'> & Partial<Pick<Settings, 'themeMode'>>): void {
  const root = document.documentElement;
  root.style.setProperty('--accent-color', s.primaryColor);
  const resolved = resolveTheme(s.themeMode ?? 'system', prefersDarkScheme());
  root.setAttribute('data-theme', resolved);
  root.style.setProperty('color-scheme', resolved);
}

/** Subscribe to OS color-scheme changes (drives live re-resolve of `'system'`).
 * Returns an unsubscribe function. No-op when `matchMedia` is unavailable. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mql = matchMedia(DARK_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/theme.test.ts`
Expected: PASS (all `resolveTheme`, `prefersDarkScheme`, `applyTheme`, `watchSystemTheme` cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/theme.ts src/lib/theme.test.ts
git commit -m "feat(theme): resolveTheme + applyTheme writes data-theme/color-scheme + watchSystemTheme"
```

---

## Task 3: Re-apply the resolved theme on settings updates (`useSettings`)

**Files:**
- Modify: `src/hooks/useSettings.ts`

**Interfaces:**
- Consumes: `applyTheme` (Task 2, now takes `themeMode`), `Settings.themeMode` (Task 1).
- Produces: nothing new — extends the existing `useSettings()` hook so a `themeMode` edit (or a synced `themeMode`/`primaryColor` change) re-applies the full theme live.

  **Note:** `useSettings.ts` line 8–19 declares `emptySettings`. It currently OMITS `themeMode`, which would be a TypeScript error once Task 1 makes the field required. Add it.

- [ ] **Step 1: Add `themeMode` to the empty seed**

In `src/hooks/useSettings.ts`, in the `emptySettings` object, add the field (after `webrtcPolicy`):

```ts
  webrtcPolicy: 'public-only',
  themeMode: 'system',
  syncServerUrl: '',
```

- [ ] **Step 2: Re-apply the full theme on a sync-merged change**

In the `onSyncChange('settings', …)` callback (currently line 35–41), change the `applyTheme` call to pass the whole settings object (so a synced `themeMode` OR `primaryColor` recolors live):

```ts
    const off = onSyncChange('settings', () => {
      void aegis.settings.get().then((s) => {
        if (!active) return;
        setSettings(s);
        // Re-apply the resolved theme (accent + palette) so a synced primaryColor OR
        // themeMode recolors the chrome without a reload.
        applyTheme(s);
      });
    });
```

- [ ] **Step 3: Re-apply on a local update when accent OR theme mode changed**

Change the `update` callback's re-apply guard (currently line 51–54) to:

```ts
    // Theme re-applies live when the accent color OR theme mode was part of this edit.
    if (partial.primaryColor !== undefined || partial.themeMode !== undefined) {
      applyTheme(next);
    }
```

- [ ] **Step 4: Run the settings hook tests**

Run: `npx vitest run src/hooks/useSettings.test.ts`
Expected: PASS. (If the test file's settings fixture lacks `themeMode`, add `themeMode: 'system'` to it so the `Settings`-typed object compiles. If the file has no such fixture, no change is needed.)

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSettings.ts src/hooks/useSettings.test.ts
git commit -m "feat(theme): re-apply resolved theme on themeMode/primaryColor changes in useSettings"
```

---

## Task 4: The Theme segmented control in `AppearanceTab`

**Files:**
- Modify: `src/components/AppearanceTab.tsx`
- Test: `src/components/AppearanceTab.test.tsx`

**Interfaces:**
- Consumes: `Settings.themeMode` (Task 1), the existing `AppearanceTabProps { settings, update }`.
- Produces: a radio group (`role="radiogroup"`, `aria-label="Theme"`) with three radios — **System / Dark / Light** — each calling `update({ themeMode })`. The checked radio reflects `settings.themeMode`. Control id for the autopilot: `settings.appearance.themeMode` (Task 7).

- [ ] **Step 1: Write the failing tests**

Replace the contents of `src/components/AppearanceTab.test.tsx` with:

```tsx
// src/components/AppearanceTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Settings } from '../../shared/types';
import { AppearanceTab } from './AppearanceTab';

const settings = (over: Partial<Settings> = {}): Settings => ({
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
  httpsOnly: true,
  tabIdleTimeout: 30,
  webrtcPolicy: 'public-only',
  themeMode: 'system',
  syncServerUrl: '',
  ...over,
});

describe('AppearanceTab — accent color', () => {
  it('shows the current accent color in the color input', () => {
    render(<AppearanceTab settings={settings({ primaryColor: '#112233' })} update={vi.fn(async () => {})} />);
    expect(screen.getByLabelText(/accent color/i)).toHaveValue('#112233');
  });

  it('updates primaryColor when the color input changes', () => {
    const update = vi.fn(async () => {});
    render(<AppearanceTab settings={settings()} update={update} />);
    fireEvent.change(screen.getByLabelText(/accent color/i), { target: { value: '#00ff00' } });
    expect(update).toHaveBeenLastCalledWith({ primaryColor: '#00ff00' });
  });
});

describe('AppearanceTab — theme mode', () => {
  it('renders a Theme radiogroup with System/Dark/Light', () => {
    render(<AppearanceTab settings={settings()} update={vi.fn(async () => {})} />);
    const group = screen.getByRole('radiogroup', { name: /theme/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /system/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /light/i })).toBeInTheDocument();
  });

  it('marks the current themeMode radio as checked', () => {
    render(<AppearanceTab settings={settings({ themeMode: 'light' })} update={vi.fn(async () => {})} />);
    expect(screen.getByRole('radio', { name: /light/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /system/i })).not.toBeChecked();
  });

  it('calls update with the chosen themeMode', () => {
    const update = vi.fn(async () => {});
    render(<AppearanceTab settings={settings({ themeMode: 'system' })} update={update} />);
    fireEvent.click(screen.getByRole('radio', { name: /dark/i }));
    expect(update).toHaveBeenLastCalledWith({ themeMode: 'dark' });
    fireEvent.click(screen.getByRole('radio', { name: /light/i }));
    expect(update).toHaveBeenLastCalledWith({ themeMode: 'light' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/AppearanceTab.test.tsx`
Expected: FAIL — no `radiogroup` named "Theme" exists yet.

- [ ] **Step 3: Implement the Theme control**

Replace the contents of `src/components/AppearanceTab.tsx` with:

```tsx
// src/components/AppearanceTab.tsx
import type { Settings } from '../../shared/types';

export interface AppearanceTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

const THEME_OPTIONS: { value: Settings['themeMode']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

export function AppearanceTab({ settings, update }: AppearanceTabProps) {
  return (
    <div className="appearance-tab">
      <fieldset className="appearance-tab__field appearance-tab__theme" role="radiogroup" aria-label="Theme">
        <span className="appearance-tab__legend">Theme</span>
        <div className="appearance-tab__segments">
          {THEME_OPTIONS.map((opt) => (
            <label key={opt.value} className="appearance-tab__segment">
              <input
                type="radio"
                name="themeMode"
                value={opt.value}
                checked={settings.themeMode === opt.value}
                onChange={() => void update({ themeMode: opt.value })}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="appearance-tab__field">
        <span>Accent color</span>
        <input
          type="color"
          aria-label="Accent color"
          value={settings.primaryColor}
          onChange={(e) => void update({ primaryColor: e.target.value })}
        />
      </label>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/AppearanceTab.test.tsx`
Expected: PASS (all accent + theme-mode cases green).

- [ ] **Step 5: Add the segmented-control styles to `index.css`**

In `src/index.css`, in the `─── Appearance tab ───` section (after the `.appearance-tab__field` rule, around line 1876), add:

```css
/* Theme segmented radio group (System / Dark / Light) */
.appearance-tab__theme {
  border: none;
  margin: 0;
  padding: 0;
  min-width: 0;
}

.appearance-tab__legend {
  color: var(--fg-muted);
  font-size: 14px;
}

.appearance-tab__segments {
  display: inline-flex;
  gap: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-2);
  overflow: hidden;
  width: fit-content;
}

.appearance-tab__segment {
  display: inline-flex;
}

/* Hide the native radio dot; the whole segment is the affordance. */
.appearance-tab__segment input[type="radio"] {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.appearance-tab__segment span {
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg-muted);
  background: var(--bg-input);
  border-right: 1px solid var(--border);
  cursor: pointer;
  user-select: none;
}

.appearance-tab__segment:last-child span {
  border-right: none;
}

.appearance-tab__segment input[type="radio"]:checked + span {
  background: var(--accent-color);
  color: var(--text-on-accent);
}

.appearance-tab__segment input[type="radio"]:focus-visible + span {
  outline: 2px solid var(--accent-color);
  outline-offset: -2px;
}
```

- [ ] **Step 6: Run the AppearanceTab tests again (style added, behavior unchanged)**

Run: `npx vitest run src/components/AppearanceTab.test.tsx`
Expected: PASS (CSS doesn't affect jsdom assertions; this confirms nothing regressed).

- [ ] **Step 7: Commit**

```bash
git add src/components/AppearanceTab.tsx src/components/AppearanceTab.test.tsx src/index.css
git commit -m "feat(theme): Theme segmented control (System/Dark/Light) in AppearanceTab"
```

---

## Task 5: Refactor `index.css` tokens into dark + light palettes

**Files:**
- Modify: `src/index.css` (the top `:root` block, lines 2–28)

**Interfaces:**
- Consumes: the `data-theme` attribute written by `applyTheme` (Task 2).
- Produces: a `[data-theme="dark"]` color-token block (the current values, byte-for-byte) + a `[data-theme="light"]` block (the same token NAMES, light values). Every existing `var(--bg)` / `var(--fg)` / etc. rule in the sheet is **untouched** — this is the key decision: refactor the *definitions*, not the ~700 *usages*.

  **The refactor approach (read this before editing):** Today there is ONE flat `:root { color-scheme: dark; --accent-color; --bg; … }`. Split it into three:
  1. A base `:root` that keeps the **non-color, theme-independent** tokens (radii, shadows) and a sensible default so an un-attributed `<html>` still renders (default to the dark palette — Aegis's historic look — by setting `data-theme="dark"` as the document default in `src/index.html`'s `<html>` tag, Step 4).
  2. `[data-theme="dark"]` — every color token at its CURRENT value (copied verbatim from the existing block so dark is pixel-identical to today).
  3. `[data-theme="light"]` — the same token names with light values.
  The static `color-scheme: dark` is **removed** from `:root` — `applyTheme` now sets `color-scheme` per resolved theme on `<html>` inline (Task 2). `--accent-color` stays defined in BOTH palettes as the fallback, but `applyTheme` overrides it inline from `primaryColor` regardless, so it is theme-independent in practice (it's the user's accent).

- [ ] **Step 1: Replace the flat `:root` block with the three-block structure**

In `src/index.css`, replace lines 2–28 (the entire current `:root { … }` block, from `:root {` through its closing `}`) with:

```css
:root {
  /* Theme-independent tokens (shape/elevation). Color tokens live in the
     [data-theme="…"] blocks below and are selected by the data-theme attribute
     that src/lib/theme.ts writes on <html>. */
  --radius-1: 4px;
  --radius-2: 6px;
  --radius-3: 8px;
  --radius-4: 12px;
  --radius-pill: 999px;
  --chrome-top-height: 56px;
  /* Accent fallback (overridden inline by applyTheme from the primaryColor setting). */
  --accent-color: #3b82f6;
  --text-on-accent: #ffffff;
}

/* ── Dark palette (default; pixel-identical to the pre-refactor look) ── */
:root,
[data-theme="dark"] {
  color-scheme: dark;
  --bg: #121212;               /* app base / scrollbar track */
  --bg-elevated: #1f1f1f;      /* header, sidebar, modals, toasts */
  --bg-input: #2a2a2a;         /* inputs, cards/list rows, chips, hover */
  --fg: #e0e0e0;               /* primary text */
  --fg-muted: #888;            /* muted text, icons, placeholders */
  --border: #333;              /* default borders */
  --border-2: #444;            /* secondary border: search field, dividers, scrollbar hover */
  --danger: #ff5d5d;
  --success: #22c55e;
  --shadow-modal: 0 10px 25px rgba(0, 0, 0, 0.5);
  --shadow-float: 0 6px 24px rgba(0, 0, 0, 0.4);
}

/* ── Light palette ── */
[data-theme="light"] {
  color-scheme: light;
  --bg: #f5f5f7;               /* app base / scrollbar track */
  --bg-elevated: #ffffff;      /* header, sidebar, modals, toasts */
  --bg-input: #ececef;         /* inputs, cards/list rows, chips, hover */
  --fg: #1c1c1e;               /* primary text */
  --fg-muted: #6b6b70;         /* muted text, icons, placeholders */
  --border: #d6d6db;           /* default borders */
  --border-2: #c2c2c8;         /* secondary border: search field, dividers, scrollbar hover */
  --danger: #d92d2d;
  --success: #1a9e4b;
  --shadow-modal: 0 10px 25px rgba(0, 0, 0, 0.18);
  --shadow-float: 0 6px 24px rgba(0, 0, 0, 0.14);
}
```

  **Why `:root, [data-theme="dark"]`:** the bare `:root` selector seeds the dark palette even if `data-theme` is somehow absent (e.g. before `applyTheme` runs on first paint), so there is never an unstyled flash; the explicit `[data-theme="dark"]` then matches once the attribute is set. The `[data-theme="light"]` block has higher specificity than the bare `:root` for the same tokens (attribute selector > pseudo-class on the universal `:root`), so light correctly wins when selected.

- [ ] **Step 2: Audit for hardcoded dark colors that won't flip with the palette**

Several rules use literal `#fff` / `rgba(255,255,255,…)` for "text/overlay on a dark surface" rather than a token. These stay legible on the accent fill but look wrong on light surfaces. Replace the **surface-dependent** ones with tokens. Run this to find them, then fix the listed cases:

Run: `grep -n 'rgba(255, 255, 255\|color: #fff\|color: #ffffff' src/index.css`

Fix these specific occurrences (leave `color: #fff` that sits on the **accent fill** — e.g. `.skip-link:focus`, `.tag-filter__chip[aria-pressed="true"]`, `.saved-panel__add-save`, `.tag-filter` active — those are text-on-accent and correct in both themes):

  - The icon-button hover backgrounds `background: rgba(255, 255, 255, 0.08)` (toolbar buttons line ~254, shield button ~371, sidebar close ~820, settings close ~1668, downloads close ~1803) and `rgba(255, 255, 255, 0.12)` (tag-input chip remove ~625) and `rgba(255, 255, 255, 0.06)` (favorites-bar manage ~510): replace each with `var(--bg-input)` so the hover is visible on a light surface. Example:

```css
.nav-controls button:hover:not(:disabled),
.toolbar__gear:hover:not(:disabled),
.toolbar__picker:hover:not(:disabled),
.toolbar__sidebar-toggle:hover:not(:disabled),
.toolbar__fullscreen:hover:not(:disabled),
.bookmark-button:hover:not(:disabled),
.toolbar__downloads:hover:not(:disabled) {
  background: var(--bg-input);
  color: var(--fg);
  border-color: transparent;
}
```

  - `.address-bar input { … color: #fff; }` (line ~316) and `.fullscreen-exit:hover { color: #fff; }` (~281): change `color: #fff` to `color: var(--fg)` (the address-bar input sits on `--bg-input`, which is light in the light theme).

  **Note:** This step is bounded — it touches only surface-background hovers and the two `--fg`-should-be-token cases above. The scrim overlays (`rgba(0,0,0,0.5)` / `0.85`) intentionally stay dark in both themes (a dim scrim over content reads correctly either way), so leave them.

- [ ] **Step 3: Default `<html>` to the dark palette so first paint is never unstyled**

In `src/index.html`, add `data-theme="dark"` to the `<html>` tag so the very first frame (before React mounts and `applyTheme` runs) uses the dark palette:

```html
<html lang="en" data-theme="dark">
```

  (`applyTheme` overwrites this on mount with the resolved theme. Defaulting to dark matches Aegis's historic look and `prefersDarkScheme()`'s unavailable-default.)

- [ ] **Step 4: Verify the renderer still builds**

Run: `npm run build:renderer`
Expected: build succeeds (CSS is valid; no selector errors). If a Vite CSS error fires, it will name the offending line.

- [ ] **Step 5: Run the full JS suite (no regressions from the CSS/theme wiring)**

Run: `npm test`
Expected: PASS — the existing tours/interactions render `<App/>` with the dark default; the token refactor is transparent to jsdom.

- [ ] **Step 6: Commit**

```bash
git add src/index.css src/index.html
git commit -m "refactor(theme): split CSS tokens into [data-theme] dark + light palettes"
```

---

## Task 6: Apply + live-watch the theme in both shells (`App` + `MobileApp`)

**Files:**
- Modify: `src/App.tsx` (the `applyTheme` effect, ~line 198–200)
- Modify: `src/components/mobile/MobileApp.tsx` (the `applyTheme` effect, line 76)

**Interfaces:**
- Consumes: `applyTheme` + `watchSystemTheme` (Task 2).
- Produces: on mount each shell applies the resolved theme AND installs `watchSystemTheme` so **System** re-resolves when the OS flips, without a reload. (The component re-fetches `settings` on the OS change so the resolve uses the current `themeMode`.)

  **Note:** Both shells already import `applyTheme` from `'./lib/theme'` / `'../../lib/theme'`. Add `watchSystemTheme` to that import.

- [ ] **Step 1: Update the desktop shell effect**

In `src/App.tsx`, update the import (line 6) and replace the one-shot effect (lines 198–200).

Import:

```ts
import { applyTheme, watchSystemTheme } from './lib/theme';
```

Effect (replace lines 198–200):

```ts
  // Apply the resolved theme on mount, and re-resolve when the OS color scheme flips
  // (so themeMode === 'system' follows the OS live). Re-fetch settings on each OS change
  // so the resolve uses the user's current themeMode + accent.
  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
    return watchSystemTheme(() => {
      void aegis.settings.get().then((s) => applyTheme(s));
    });
  }, []);
```

- [ ] **Step 2: Update the mobile shell effect**

In `src/components/mobile/MobileApp.tsx`, update the import (line 3) and replace the one-shot effect (line 76).

Import (add `setFullscreen as setNativeFullscreen` already exists; just add `watchSystemTheme`):

```ts
import { applyTheme, watchSystemTheme } from '../../lib/theme';
```

Effect (replace line 76):

```ts
  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
    return watchSystemTheme(() => {
      void aegis.settings.get().then((s) => applyTheme(s));
    });
  }, []);
```

- [ ] **Step 3: Run the desktop + mobile tours (both shells still mount + theme applies)**

Run: `npx vitest run src/autopilot/tour.test.tsx src/autopilot/tour.mobile.test.tsx`
Expected: PASS — both shells render; the new `watchSystemTheme` returns a cleanup so the effect unmounts cleanly. (In jsdom `matchMedia` may be undefined unless the test mocks it; `watchSystemTheme` no-ops in that case — no crash.)

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/components/mobile/MobileApp.tsx
git commit -m "feat(theme): apply resolved theme + watch OS scheme in App and MobileApp"
```

---

## Task 7: Autopilot — screen states + interaction spec

**Files:**
- Modify: `src/autopilot/screens.ts` (`OverlayScreenId` + `SCREENS`)
- Modify: `src/autopilot/reach.ts` (`reachScreen` / `leaveScreen`)
- Modify: `src/autopilot/interactions/controls.ts` (`INTERACTIVE_CONTROLS`)
- Modify: `src/autopilot/interactions/settings.ts` (`SETTINGS_INTERACTIONS`)

**Interfaces:**
- Consumes: `applyTheme` (Task 2), the `data-theme` attribute, the AppearanceTab Theme control (Task 4).
- Produces:
  - Two `'state'` screens `theme:dark` / `theme:light` — captured screenshots of each palette. `reachScreen` applies the palette by calling `applyTheme({ primaryColor, themeMode })`; `leaveScreen` restores dark.
  - One interaction spec `settings.appearance.themeMode` driving the real Theme radios in the desktop tour and asserting `aegis.settings.set` was called with the chosen mode.
  - The control id `settings.appearance.themeMode` registered in `INTERACTIVE_CONTROLS`.

  **Why `'state'` and not `'overlay'`:** the two themes are not a distinct overlay — they are a root attribute on `<html>` that recolors the whole chrome. A `'state'` screen (like `home`) reaches the base layout, which `reachScreen` then re-themes before the screenshot. This is the cleanest fit for the existing `reach.ts` model.

- [ ] **Step 1: Add the two screens to `screens.ts`**

In `src/autopilot/screens.ts`, add `'theme:dark'` and `'theme:light'` to the `OverlayScreenId` union (after `'redirectBar'`, before `'confirmDialog'`):

```ts
  | 'redirectBar'
  | 'theme:dark'
  | 'theme:light'
  | 'confirmDialog';
```

And add the two entries to the `SCREENS` array (after the `redirectBar` entry, before `confirmDialog`):

```ts
  { id: 'theme:dark', label: 'Theme · Dark palette', via: 'state' },
  { id: 'theme:light', label: 'Theme · Light palette', via: 'state' },
```

- [ ] **Step 2: Handle the new screens in `reach.ts`**

In `src/autopilot/reach.ts`, add the theme import at the top (after the existing imports):

```ts
import { applyTheme } from '../lib/theme';
```

In `reachScreen`, the `case 'state':` already resets overlays. Extend it to apply the requested palette when the screen is a theme screen. Replace the `case 'state':` block (lines 59–62) with:

```ts
    case 'state':
      control.closeSettings(); control.closeDownloads(); control.closeManager();
      control.setSidebar(false); control.setShield(false); control.exitFullscreen();
      if (screen.id === 'theme:dark') applyTheme({ primaryColor: '#3b82f6', themeMode: 'dark' });
      else if (screen.id === 'theme:light') applyTheme({ primaryColor: '#3b82f6', themeMode: 'light' });
      break;
```

In `leaveScreen`, restore the dark palette after a theme screenshot. Add, before the final `await tick();` (after the `redirectBar` branch, line 115):

```ts
  else if (screen.id === 'theme:dark' || screen.id === 'theme:light') applyTheme({ primaryColor: '#3b82f6', themeMode: 'dark' });
```

- [ ] **Step 3: Register the interaction control id**

In `src/autopilot/interactions/controls.ts`, add `'settings.appearance.themeMode'` to the `INTERACTIVE_CONTROLS` array, **directly after the existing `'settings.appearance.primaryColor'` entry** (line 39) so appearance controls stay grouped:

```ts
  'settings.appearance.primaryColor',
  'settings.appearance.themeMode',
```

- [ ] **Step 4: Add the interaction spec**

In `src/autopilot/interactions/settings.ts`, add this spec to the `SETTINGS_INTERACTIONS` array, mirroring the existing `settings.appearance.primaryColor` spec's conventions exactly: **`domain: 'settings.appearance'`** (not `'settings'`), and `ctx.byRole(role, name)` takes a **RegExp** name (it forwards straight to Testing Library's `queryByRole(role, { name })`, which accepts a regex — see `interactionCtx.ts` line 126). The AppearanceTab radios are reachable by accessible name because each `<label>` wraps the `<input type="radio">` + its visible `<span>` text, so `getByRole('radio', { name: /Light/ })` resolves.

```ts
  {
    id: 'settings.appearance.themeMode',
    domain: 'settings.appearance',
    description: 'Appearance: choose the Light theme via the Theme segmented control → settings.set({themeMode})',
    screen: 'settings:appearance',
    layers: ['vitest'],
    mobile: true,
    run: async (ctx) => {
      ctx.calls.reset();
      const light = ctx.byRole('radio', /^Light$/);
      if (!light) throw new Error('Theme "Light" radio not found on Appearance tab');
      await ctx.click(light);
    },
    assert: async (ctx) => {
      if (!ctx.calls.called('settings.set'))
        throw new Error('settings.set not called for themeMode on Appearance tab');
      return 'Theme mode change → settings.set({themeMode})';
    },
  },
```

  **Note:** `screen: 'settings:appearance'` reaches the Appearance settings tab via the existing `reachScreen` `settingsTab` path. `layers: ['vitest']` matches the existing accent spec (the Appearance control isn't exercised in the live desktop step, only the vitest tours). `mobile: true` lets the mobile interaction tour run it too — the Appearance tab renders identically in `MobileApp`'s `SettingsModal`. The accent spec restores state in a live layer; this spec is vitest-only, so no restore is needed (the mocked `settings.set` is inert).

- [ ] **Step 5: Run the drift guards + interaction tours**

Run: `npx vitest run src/autopilot/screens.test.ts src/autopilot/coverage.test.ts src/autopilot/interactions.coverage.test.ts src/autopilot/interactions.test.tsx src/autopilot/interactions.mobile.test.tsx`
Expected: PASS —
  - `coverage.test.ts` (IPC drift) is unaffected (no new channel).
  - `interactions.coverage.test.ts` now sees a spec for `settings.appearance.themeMode` (the control id has a matching spec id) → green.
  - The interaction tours run the new spec and assert `settings.set` was called.
  - `screens.test.ts` accepts the two new `'state'` entries.

- [ ] **Step 6: Run the run-orchestration test (reach/leave for the new screens)**

Run: `npx vitest run src/autopilot/run.test.ts src/autopilot/reach.test.ts`
Expected: PASS — `reachScreen`/`leaveScreen` handle `theme:dark` / `theme:light` without throwing.

- [ ] **Step 7: Commit**

```bash
git add src/autopilot/screens.ts src/autopilot/reach.ts src/autopilot/interactions/controls.ts src/autopilot/interactions/settings.ts
git commit -m "test(theme): autopilot screen states (dark/light) + Theme control interaction"
```

---

## Task 8: Full-suite gate + live verification

**Files:** none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: PASS — all Vitest projects (node `shared/`+`scripts/`, jsdom `src/`) green, including the two drift guards and both interaction tours.

- [ ] **Step 2: Type-check the renderer**

Run: `npm run build:renderer`
Expected: build succeeds (TypeScript catches any place that constructs a `Settings` without `themeMode` — fix by adding `themeMode: 'system'` to that fixture).

- [ ] **Step 3: Compile the Rust core**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: compiles clean (the `defaults()` change is one JSON key).

- [ ] **Step 4: Live-run the app and toggle each mode (Linux)**

Run: `npm run tauri:dev`
Then in the running app: open **Settings → Appearance**, and for each of **System / Dark / Light** click the segment. Expected on-screen:
  - **Dark** → the chrome is the current dark look (toolbar `#1f1f1f`, page text light) — unchanged from before.
  - **Light** → the chrome flips to the light palette instantly (toolbar white `#ffffff`, dark text on `#f5f5f7` base) with no reload; the accent color and all icon hovers stay legible.
  - **System** → matches the OS setting; change the OS theme (KDE: System Settings → Appearance) and confirm the chrome flips live without re-opening Settings.

  Per `[[aegis-live-testing-setup]]`, capture with `spectacle` for the record.

- [ ] **Step 5: Run the live autopilot (Linux, needs a display)**

Run: `bash scripts/autopilot/run-autopilot.sh`
Expected: `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`; the report (`target/autopilot/<ts>/report.html`) contains `Theme · Dark palette` and `Theme · Light palette` screenshots showing the two distinct palettes. (Theme is renderer-only; the ad-block trace must be unaffected.)

- [ ] **Step 6: Android parity build (owner, on the device)**

Run: `JAVA_HOME=~/development/android-studio/jbr npm run android:build -- --target aarch64`
Then install + open on the device: **Settings → Appearance → Light** flips the mobile chrome to the light palette; **System** follows the phone's dark-mode toggle. (Android uses the same renderer + `applyTheme` path — `matchMedia('(prefers-color-scheme: dark)')` is supported in the Android WebView, so System works natively. No Kotlin change is needed.) Per spec §4 this is device-verified by the owner.

- [ ] **Step 7: Update living docs**

Per the repo's living-docs rule, note the theme tokens in `src/CLAUDE.md`'s `index.css` description: change "global **dark** theme" to "global theme (dark default + light palette via `[data-theme]`, selected by `lib/theme.ts`)". Commit with the verification.

```bash
git add src/CLAUDE.md
git commit -m "docs(theme): index.css now ships dark + light palettes selected by lib/theme.ts"
```

---

## Self-Review

Run against the spec (§6, sub-project **F**) with fresh eyes.

**1. Spec coverage**

| Spec requirement (sub-project F / §6) | Task |
|---|---|
| "Add a light palette to the design tokens" | Task 5 (`[data-theme="light"]` block, full token set) |
| "honor `prefers-color-scheme`" | Task 2 (`prefersDarkScheme` reads the media query) + Task 6 (`watchSystemTheme` live re-resolve) |
| "an Appearance setting: System / Dark / Light" | Task 4 (segmented control) |
| "settings field `themeMode`" | Task 1 (`Settings.themeMode` + Rust default) |
| "the mobile shell" | Task 6 (`MobileApp` effect) + Task 4 control renders in the mobile `SettingsModal` |
| "toggling re-themes chrome instantly" | Task 3 (`useSettings.update` re-applies on `themeMode` change) |
| "system mode follows OS" | Task 2 + Task 6 (`watchSystemTheme`) |
| "vitest + live screenshots both themes" | Task 2/4 vitest tests + Task 7 (`theme:dark`/`theme:light` screens) + Task 8 step 5 |
| §6.1 IPC-in-three-places | N/A by design — settings *field*, no channel (documented in Global Constraints); contract still updated in `shared/types.ts` (Task 1) |
| §6.2 autopilot coverage same commit, drift-guarded | Task 7 (screens + interaction) — committed; drift guards run in Task 7 step 5 |
| §6.3 gate (`npm test` + live autopilot) | Task 8 |
| §6.4 parity (Linux/Win/mac/Android) | Renderer-only → identical on all; Task 8 steps 4–6 cover Linux live + Android device; Win/mac inherit via CI build (no platform code) |

No gaps found. Currently-dark-only CSS tokens are handled by **Task 5's refactor**: the existing flat `:root` color tokens move verbatim into `[data-theme="dark"]` (so dark stays pixel-identical), a parallel `[data-theme="light"]` block redefines the same token *names*, and the ~700 `var(--…)` usages across the 3700-line sheet are left untouched — only the definitions move. Step 2 of Task 5 additionally retokenizes the handful of hardcoded `#fff` / `rgba(255,255,255,…)` surface hovers that would otherwise read wrong on a light surface (leaving text-on-accent `#fff` alone). `<html data-theme="dark">` in `index.html` + the bare-`:root` dark seed prevent any unstyled first-paint flash.

**2. Placeholder scan**

No `TBD` / `TODO` / "handle edge cases" / "similar to Task N" / "write tests for the above". Every code step shows complete code; every test step shows the full test; every run step states the exact command + expected result. The one soft spot — Task 7 Step 4's "mirror the accent-color spec's ctx selection" — is bounded by an explicit fallback (match the radio by `getByRole`/`aria-label`) and a concrete spec body, not a "figure it out". Acceptable: the interaction-ctx `byRole` helper signature (`role`, `name`) is given.

**3. Type consistency**

- `themeMode: 'system' | 'dark' | 'light'` — used identically in Task 1 (`Settings`), Task 2 (`ThemeMode`), Task 3 (`emptySettings`), Task 4 (`THEME_OPTIONS` typed `Settings['themeMode']`), Task 7 (`applyTheme({ themeMode: 'dark' })`).
- `applyTheme` signature `Pick<Settings,'primaryColor'> & Partial<Pick<Settings,'themeMode'>>` — Task 2 defines it; Task 3/6/7 call it with `{ primaryColor, themeMode }` (full settings or explicit), Task 2's "missing themeMode → system" test covers the partial call. Consistent.
- `resolveTheme(mode, prefersDark)` / `prefersDarkScheme()` / `watchSystemTheme(onChange)` — names match between Task 2's definition, its tests, and Task 6's usage.
- Screen ids `'theme:dark'` / `'theme:light'` — identical in Task 7 across `screens.ts`, `reach.ts`, and the union.
- Control id `'settings.appearance.themeMode'` — identical between `controls.ts` and the interaction spec `id` (drift guard matches spec ids that START WITH the control string — exact match qualifies).
- CSS token names (`--bg`, `--bg-elevated`, `--bg-input`, `--fg`, `--fg-muted`, `--border`, `--border-2`, `--danger`, `--success`, `--shadow-modal`, `--shadow-float`, `--accent-color`, `--text-on-accent`, `--radius-*`, `--chrome-top-height`) — Task 5 redefines the SAME names the rest of the sheet already consumes; no rename. `--text-primary` / `--text-muted` appear in two `.tabs-tab__field` rules (lines 1927/1939) but those are pre-existing typos referencing undefined vars (they fall back to inherited color) — out of scope, not introduced here.

All consistent. Plan is complete.
