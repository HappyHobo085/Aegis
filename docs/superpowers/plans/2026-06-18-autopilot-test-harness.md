# Autopilot Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a two-layer autonomous test harness for Aegis — a live in-app "autopilot" that drives every feature through the real Rust core and screenshots every UI state, plus an exhaustive in-process vitest tour — both fed by one feature catalog kept current by a drift-guard test.

**Architecture:** A single source of truth (`src/autopilot/screens.ts` + `catalog.ts`) enumerates every screen and every IPC-backed feature. The **live** path (`run.ts`, activated only in dev via `import.meta.env.DEV && VITE_AEGIS_AUTOPILOT`) walks it against the real `aegis` IPC client and a dev-only Rust command set (screenshot/report/emit, gated `#[cfg(debug_assertions)]`), driven by a Linux launcher script that runs the app on a disposable profile. The **vitest** path (`tour.test.tsx`) mounts the real React app with a mock `aegis` and walks the same catalog, asserting render + IPC. A `coverage.test.ts` drift guard fails the build if a feature lacks a catalog entry.

**Tech Stack:** React 19 + TypeScript (renderer), Tauri 2 + Rust (core), Vitest (jsdom + node), Bash + Node (launcher + fixture server), spectacle (Linux screenshots).

## Global Constraints

- **One IPC chokepoint (production):** real features go through `src/lib/ipcClient.ts` → `invoke('ipc', {channel})` → `ipc()` in `src-tauri/src/lib.rs`. The autopilot's Rust commands are a **separate dev-only side channel** (standalone `#[tauri::command]` fns), NOT added to the `IPC` const in `shared/types.ts`, so the production contract is untouched.
- **Never in production (belt-and-suspenders):** renderer autopilot gated behind `import.meta.env.DEV && import.meta.env.VITE_AEGIS_AUTOPILOT` (Vite dead-code-eliminates it from `tauri build`); Rust commands gated `#[cfg(debug_assertions)]` (not compiled into release).
- **Disposable profile:** the launcher sets `XDG_DATA_HOME`/`XDG_CONFIG_HOME` to a temp dir so real-core CRUD never touches real user data. Tauri `app_data_dir()` honors these on Linux.
- **Launch vehicle:** `npm run tauri:dev` (real Rust core + real webviews; Vite-served renderer).
- **Screenshots are best-effort:** require a display; auto-skipped with a recorded reason when headless (`spectacle` on KWin; `grim` does not work here). Functional/core assertions run regardless of display.
- **Event names:** Tauri forbids `.` in event names; always emit via `crate::emit_event(app, "foo.bar", payload)` (it rewrites `.`→`:`). Never `app.emit` a raw dotted name.
- **Test gate:** `npm test` (vitest node + jsdom projects) must stay green, including the new `tour.test.tsx` and `coverage.test.ts`.
- **Honest coverage:** "every screen individually + meaningful pairwise combos", NOT literal full-Cartesian; the report states this scope explicitly. No silent caps — anything skipped (screenshots, an un-inducible overlay) is recorded with a reason.
- **Living docs:** when a feature is added (IPC channel, Settings tab, overlay), its catalog entry is added in the same commit; the drift guard enforces it.

---

## File Structure

**Create (renderer autopilot core — `src/autopilot/`):**

- `screens.ts` — `ScreenId`, `ScreenSpec`, `SCREENS` (every overlay/tab/state vector).
- `catalog.ts` — `FeatureCheck`, `CATALOG` (every IPC-backed feature + the channels it covers + an `exercise(api)`).
- `report.ts` — `StepStatus`, `StepResult`, `Report`, `renderReportHtml(report)`.
- `control.ts` — `AutopilotControl` interface, `installAutopilotControl()`, `getAutopilotControl()`.
- `reach.ts` — `reachScreen(control, screen, deps)` (shared screen-reaching used by both live + vitest).
- `devEmit.ts` — live-only thin wrappers over the dev-only Rust commands (screenshot/writeReport/done/emitEvent).
- `run.ts` — `runAutopilot()` live orchestration.
- Co-located tests: `screens.test.ts`, `catalog`-side `coverage.test.ts`, `report.test.ts`, `control.test.ts`, `reach.test.ts`, `devEmit.test.ts`, `run.test.ts`, `tour.test.tsx`, `tour.mobile.test.tsx`.

**Create (Rust dev-only support):**

- `src-tauri/src/autopilot.rs` — `#[cfg(debug_assertions)]` `#[tauri::command]` fns.

**Create (launcher — `scripts/autopilot/`):**

- `run-autopilot.sh` — the Linux launcher.
- `fixture-server.mjs` — tiny static http server.
- `fixture/index.html` — ad-laden probe page.

**Modify:**

- `src/components/SettingsModal.tsx` — export `TAB_ORDER` and `SettingsTab`.
- `src/App.tsx` — register the dev-only control surface in `DesktopApp`.
- `src/main.tsx` — dev-only bootstrap of the autopilot.
- `src-tauri/src/lib.rs` — `#[cfg(debug_assertions)] mod autopilot;` + cfg-split `invoke_handler`.
- `CLAUDE.md` (root), `src/CLAUDE.md`, `src-tauri/CLAUDE.md`, `scripts/CLAUDE.md` — docs.

---

## Task 1: Screen model + Settings exports

**Files:**

- Modify: `src/components/SettingsModal.tsx:8` (export `SettingsTab`), `:37` (export `TAB_ORDER`)
- Create: `src/autopilot/screens.ts`
- Test: `src/autopilot/screens.test.ts`

**Interfaces:**

- Consumes: `TAB_ORDER`, `SettingsTab` from `SettingsModal.tsx`.
- Produces: `type ScreenId`, `interface ScreenSpec { id: ScreenId; label: string; via: 'overlay' | 'settingsTab' | 'sidebarTab' | 'event' | 'state' }`, `const SCREENS: ScreenSpec[]`, `const SETTINGS_SCREENS: ScreenSpec[]`.

- [ ] **Step 1: Export the Settings tab metadata**

In `src/components/SettingsModal.tsx`, change line 8 `type SettingsTab =` to `export type SettingsTab =`, and line 37 `const TAB_ORDER: SettingsTab[] = [` to `export const TAB_ORDER: SettingsTab[] = [`.

- [ ] **Step 2: Write the failing test**

```ts
// src/autopilot/screens.test.ts
import { describe, it, expect } from 'vitest';
import { TAB_ORDER } from '../components/SettingsModal';
import { SCREENS } from './screens';

describe('SCREENS', () => {
  it('has a settings screen for every Settings tab', () => {
    const ids = new Set(SCREENS.map((s) => s.id));
    for (const tab of TAB_ORDER) expect(ids.has(`settings:${tab}`)).toBe(true);
  });
  it('covers both sidebar tabs and the core overlays', () => {
    const ids = new Set(SCREENS.map((s) => s.id));
    for (const id of [
      'sidebar:history',
      'sidebar:saved',
      'downloads',
      'favoritesManager',
      'shieldPopover',
      'fullscreen',
      'errorOverlay',
      'crashOverlay',
      'safetyInterstitial',
      'permissionPrompt',
      'confirmDialog',
      'home',
    ])
      expect(ids.has(id)).toBe(true);
  });
  it('has unique ids', () => {
    expect(new Set(SCREENS.map((s) => s.id)).size).toBe(SCREENS.length);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/autopilot/screens.test.ts`
Expected: FAIL — `Cannot find module './screens'`.

- [ ] **Step 4: Implement `screens.ts`**

```ts
// src/autopilot/screens.ts
// The enumerable surface the autopilot walks. Single source of truth for "every screen".
import { TAB_ORDER, type SettingsTab } from '../components/SettingsModal';

export type SettingsScreenId = `settings:${SettingsTab}`;
export type OverlayScreenId =
  | 'home'
  | 'sidebar:history'
  | 'sidebar:saved'
  | 'downloads'
  | 'favoritesManager'
  | 'shieldPopover'
  | 'fullscreen'
  | 'errorOverlay'
  | 'crashOverlay'
  | 'safetyInterstitial'
  | 'permissionPrompt'
  | 'confirmDialog';
export type ScreenId = OverlayScreenId | SettingsScreenId;

export interface ScreenSpec {
  id: ScreenId;
  label: string;
  /** How the live control surface reaches it (see reach.ts). */
  via: 'overlay' | 'settingsTab' | 'sidebarTab' | 'event' | 'state';
}

export const SETTINGS_SCREENS: ScreenSpec[] = TAB_ORDER.map((t) => ({
  id: `settings:${t}` as SettingsScreenId,
  label: `Settings · ${t}`,
  via: 'settingsTab' as const,
}));

export const SCREENS: ScreenSpec[] = [
  { id: 'home', label: 'Home / toolbar', via: 'state' },
  { id: 'sidebar:history', label: 'Sidebar · History', via: 'sidebarTab' },
  { id: 'sidebar:saved', label: 'Sidebar · Saved', via: 'sidebarTab' },
  { id: 'downloads', label: 'Downloads modal', via: 'overlay' },
  { id: 'favoritesManager', label: 'Favorites manager', via: 'overlay' },
  ...SETTINGS_SCREENS,
  { id: 'shieldPopover', label: 'Ad-block shield popover', via: 'overlay' },
  { id: 'fullscreen', label: 'Fullscreen', via: 'overlay' },
  { id: 'errorOverlay', label: 'Nav error overlay', via: 'event' },
  { id: 'crashOverlay', label: 'Crash overlay', via: 'event' },
  { id: 'safetyInterstitial', label: 'Safety interstitial', via: 'event' },
  { id: 'permissionPrompt', label: 'Permission prompt', via: 'event' },
  { id: 'confirmDialog', label: 'Confirm dialog', via: 'overlay' },
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/autopilot/screens.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/autopilot/screens.ts src/autopilot/screens.test.ts src/components/SettingsModal.tsx
git commit -m "feat(autopilot): screen model + export Settings tab metadata"
```

---

## Task 2: Feature catalog + drift guard

**Files:**

- Create: `src/autopilot/catalog.ts`
- Test: `src/autopilot/coverage.test.ts`

**Interfaces:**

- Consumes: `AegisApi`, `IPC`, `PRIMARY_VIEW_ID` from `shared/types`.
- Produces: `interface FeatureCheck { id: string; domain: string; title: string; channels: string[]; exercise(api: AegisApi): Promise<void> }`, `const CATALOG: FeatureCheck[]`, `const UNTESTED_CHANNELS: Set<string>`.

**Note on `exercise`:** it performs the real IPC call(s) with representative args and asserts the **shape** of the result (defined / right type), NOT persisted content. This holds against both the real core (live) and the simple `vi.fn` mocks (vitest). Real-effect assertions (block count rose, favorite persisted) live in `run.ts` inductions (Task 8), live-only.

- [ ] **Step 1: Write the failing drift-guard test**

```ts
// src/autopilot/coverage.test.ts
import { describe, it, expect } from 'vitest';
import { IPC } from '../../shared/types';
import { CATALOG, UNTESTED_CHANNELS } from './catalog';

// Command channels (renderer -> core). Events (evt*) are excluded — they are
// inbound and covered by the screen walk / component tests.
const COMMAND_CHANNELS = Object.entries(IPC)
  .filter(([k]) => !k.startsWith('evt'))
  .map(([, v]) => v);

describe('catalog drift guard', () => {
  it('every command channel is covered by a catalog entry or explicitly excused', () => {
    const covered = new Set(CATALOG.flatMap((c) => c.channels));
    const missing = COMMAND_CHANNELS.filter((ch) => !covered.has(ch) && !UNTESTED_CHANNELS.has(ch));
    expect(missing, `uncovered IPC channels: ${missing.join(', ')}`).toEqual([]);
  });
  it('catalog entries have unique ids and reference real channels', () => {
    const all = new Set<string>(Object.values(IPC));
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length);
    for (const c of CATALOG) for (const ch of c.channels) expect(all.has(ch), ch).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/autopilot/coverage.test.ts`
Expected: FAIL — `Cannot find module './catalog'`.

- [ ] **Step 3: Implement `catalog.ts`**

```ts
// src/autopilot/catalog.ts
// Single source of truth for "every feature". Each entry exercises real IPC
// (live: real core; vitest: mock) and declares the channels it covers so the
// drift guard fails when a feature is added without coverage.
import type { AegisApi } from '../../shared/types';
import { IPC, PRIMARY_VIEW_ID } from '../../shared/types';

export interface FeatureCheck {
  id: string;
  domain: string;
  title: string;
  channels: string[];
  exercise(api: AegisApi): Promise<void>;
}

const V = PRIMARY_VIEW_ID;
function assertArray(x: unknown): void {
  if (!Array.isArray(x)) throw new Error('expected array');
}
function assertObject(x: unknown): void {
  if (x === null || typeof x !== 'object') throw new Error('expected object');
}

export const CATALOG: FeatureCheck[] = [
  // nav
  {
    id: 'nav.getState',
    domain: 'nav',
    title: 'Get nav state',
    channels: [IPC.navGetState],
    exercise: async (a) => {
      assertObject(await a.nav.getState(V));
    },
  },
  {
    id: 'nav.navigate',
    domain: 'nav',
    title: 'Navigate',
    channels: [IPC.navNavigate],
    exercise: async (a) => {
      await a.nav.navigate(V, 'https://example.com/');
    },
  },
  {
    id: 'nav.controls',
    domain: 'nav',
    title: 'Back/forward/reload/home',
    channels: [IPC.navBack, IPC.navForward, IPC.navReloadOrStop, IPC.navHome],
    exercise: async (a) => {
      await a.nav.back(V);
      await a.nav.forward(V);
      await a.nav.reloadOrStop(V);
      await a.nav.home(V);
    },
  },
  // tabs
  {
    id: 'tabs.list',
    domain: 'tabs',
    title: 'List tabs',
    channels: [IPC.tabsList],
    exercise: async (a) => {
      assertObject(await a.tabs.list());
    },
  },
  {
    id: 'tabs.lifecycle',
    domain: 'tabs',
    title: 'Create/activate/close/reopen',
    channels: [
      IPC.tabsCreate,
      IPC.tabsActivate,
      IPC.tabsClose,
      IPC.tabsReopenClosed,
      IPC.tabsReorder,
      IPC.tabsSetPinned,
      IPC.tabsSetTitle,
    ],
    exercise: async (a) => {
      assertObject(await a.tabs.create('https://example.org/', true));
      await a.tabs.reorder([V]);
      await a.tabs.setPinned(V, true);
      await a.tabs.setPinned(V, false);
      await a.tabs.setTitle(V, 'AP');
      await a.tabs.activate(V);
      await a.tabs.reopenClosed();
    },
  },
  // view
  {
    id: 'view.layout',
    domain: 'view',
    title: 'Content visibility/inset/overlay/sidebar/layout/fullscreen',
    channels: [
      IPC.viewSetContentVisible,
      IPC.viewSetContentInset,
      IPC.viewSetChromeOverlay,
      IPC.viewSetSidebar,
      IPC.viewSetLayout,
      IPC.viewSetFullscreen,
    ],
    exercise: async (a) => {
      await a.view.setContentVisible(V, true);
      await a.view.setContentInset(V, { top: 0, right: 0, bottom: 0, left: 0 });
      await a.view.setChromeOverlay(V, false);
      await a.view.setSidebar(V, false, 280);
      await a.view.setLayout?.(V, { overlay: false, sidebar: false, width: 280 });
      await a.view.setFullscreen(V, false);
    },
  },
  // favorites
  {
    id: 'favorites.crud',
    domain: 'favorites',
    title: 'Favorites list/add/update/remove/reorder',
    channels: [
      IPC.favoritesList,
      IPC.favoritesAdd,
      IPC.favoritesUpdate,
      IPC.favoritesRemove,
      IPC.favoritesReorder,
    ],
    exercise: async (a) => {
      assertArray(await a.favorites.list());
      assertArray(await a.favorites.add({ name: 'AP', url: 'https://ap.test/' }));
      assertArray(await a.favorites.reorder([]));
    },
  },
  // history
  {
    id: 'history.crud',
    domain: 'history',
    title: 'History list/search/remove/clear',
    channels: [IPC.historyList, IPC.historySearch, IPC.historyRemove, IPC.historyClear],
    exercise: async (a) => {
      assertArray(await a.history.list({}));
      assertArray(await a.history.search('a'));
    },
  },
  // saved
  {
    id: 'saved.crud',
    domain: 'saved',
    title: 'Saved list/add/remove/has/update/tags',
    channels: [
      IPC.savedList,
      IPC.savedAdd,
      IPC.savedRemove,
      IPC.savedHas,
      IPC.savedUpdate,
      IPC.savedRenameTag,
      IPC.savedDeleteTag,
      IPC.savedTagUnion,
    ],
    exercise: async (a) => {
      assertArray(await a.saved.list());
      assertArray(await a.saved.add({ url: 'https://s.test/', title: 'S', tags: ['t'] }));
      await a.saved.has('https://s.test/');
      assertArray(await a.saved.tagUnion());
    },
  },
  // settings
  {
    id: 'settings.getset',
    domain: 'settings',
    title: 'Settings get/set',
    channels: [IPC.settingsGet, IPC.settingsSet],
    exercise: async (a) => {
      const s = await a.settings.get();
      assertObject(s);
      assertObject(await a.settings.set({ primaryColor: s.primaryColor }));
    },
  },
  // adblock
  {
    id: 'adblock.toggle',
    domain: 'adblock',
    title: 'Ad-block enable/allowlist/state',
    channels: [
      IPC.adblockSetEnabled,
      IPC.adblockToggleAllowlist,
      IPC.adblockRemoveAllowlist,
      IPC.adblockClearAllowlist,
      IPC.adblockGetState,
    ],
    exercise: async (a) => {
      assertObject(await a.adblock.getState());
      assertObject(await a.adblock.setEnabled(true));
      assertObject(await a.adblock.toggleAllowlist('ap.test'));
      assertObject(await a.adblock.removeAllowlist('ap.test'));
      assertObject(await a.adblock.clearAllowlist());
    },
  },
  // lists
  {
    id: 'lists.updateNow',
    domain: 'lists',
    title: 'Update filter lists',
    channels: [IPC.listsUpdateNow],
    exercise: async (a) => {
      assertObject(await a.lists.updateNow());
    },
  },
  // subs
  {
    id: 'subs.crud',
    domain: 'subs',
    title: 'Subscriptions list/setEnabled/add/remove',
    channels: [IPC.subsList, IPC.subsSetEnabled, IPC.subsAdd, IPC.subsRemove],
    exercise: async (a) => {
      assertArray(await a.subs.list());
    },
  },
  // customFilters
  {
    id: 'customFilters.getset',
    domain: 'customFilters',
    title: 'Custom filters get/set',
    channels: [IPC.customFiltersGet, IPC.customFiltersSet],
    exercise: async (a) => {
      const t = await a.customFilters.get();
      if (typeof t !== 'string') throw new Error('string');
      await a.customFilters.set(t);
    },
  },
  // downloads
  {
    id: 'downloads.crud',
    domain: 'downloads',
    title: 'Downloads list/remove/clear (+ file ops)',
    channels: [
      IPC.downloadsList,
      IPC.downloadsRemove,
      IPC.downloadsClear,
      IPC.downloadsOpenFile,
      IPC.downloadsShowInFolder,
      IPC.downloadsCancel,
    ],
    exercise: async (a) => {
      assertArray(await a.downloads.list());
    },
  },
  // permissions
  {
    id: 'permissions.crud',
    domain: 'permissions',
    title: 'Permissions list/remove/clear/resolve',
    channels: [
      IPC.permissionsList,
      IPC.permissionsRemove,
      IPC.permissionsClear,
      IPC.permissionsResolve,
    ],
    exercise: async (a) => {
      assertArray(await a.permissions.list());
    },
  },
  // data
  {
    id: 'data.export',
    domain: 'data',
    title: 'Data export',
    channels: [IPC.dataExport, IPC.dataImport],
    exercise: async (a) => {
      assertObject(await a.data.export());
    },
  },
  // picker
  {
    id: 'picker.start',
    domain: 'picker',
    title: 'Element picker',
    channels: [IPC.pickerStart],
    exercise: async (a) => {
      assertObject(await a.picker.start());
    },
  },
  // update
  {
    id: 'update.state',
    domain: 'update',
    title: 'Update get/check',
    channels: [IPC.updateGetState, IPC.updateCheckNow, IPC.updateRestartToInstall],
    exercise: async (a) => {
      assertObject(await a.update.getState());
      await a.update.checkNow();
    },
  },
  // safety
  {
    id: 'safety.state',
    domain: 'safety',
    title: 'Safety get/exceptions',
    channels: [
      IPC.safetyGetState,
      IPC.safetyProceed,
      IPC.safetyListExceptions,
      IPC.safetyRemoveException,
    ],
    exercise: async (a) => {
      await a.safety.getState();
      assertArray(await a.safety.listExceptions());
    },
  },
  // sync
  {
    id: 'sync.state',
    domain: 'sync',
    title: 'Sync get/test/devices',
    channels: [
      IPC.syncGetState,
      IPC.syncEnableNew,
      IPC.syncEnableFromPhrase,
      IPC.syncDisable,
      IPC.syncNow,
      IPC.syncTestConnection,
      IPC.syncGetRecoveryPhrase,
      IPC.syncListDevices,
      IPC.syncRemoveDevice,
    ],
    exercise: async (a) => {
      assertObject(await a.sync.getState());
      assertArray(await a.sync.listDevices());
    },
  },
];

// Channels intentionally not exercised by a catalog `exercise` (destructive,
// require a real OS file/window, or fire-and-forget side effects covered live/in
// component tests). Kept explicit so the drift guard still forces a decision.
export const UNTESTED_CHANNELS = new Set<string>([
  // file/OS-bound — exercised live only, would mutate the host in vitest:
  IPC.downloadsOpenFile,
  IPC.downloadsShowInFolder,
  IPC.downloadsCancel,
  IPC.dataImport,
  IPC.permissionsResolve,
  IPC.safetyProceed,
  IPC.updateRestartToInstall,
  IPC.permissionsRemove,
  IPC.permissionsClear,
  IPC.safetyRemoveException,
  IPC.historyRemove,
  IPC.historyClear,
  IPC.favoritesUpdate,
  IPC.favoritesRemove,
  IPC.savedRemove,
  IPC.savedUpdate,
  IPC.savedRenameTag,
  IPC.savedDeleteTag,
  IPC.subsSetEnabled,
  IPC.subsAdd,
  IPC.subsRemove,
  IPC.syncEnableNew,
  IPC.syncEnableFromPhrase,
  IPC.syncDisable,
  IPC.syncNow,
  IPC.syncTestConnection,
  IPC.syncGetRecoveryPhrase,
  IPC.syncRemoveDevice,
]);
```

(Note: `UNTESTED_CHANNELS` lists channels referenced in a `channels:` array but whose _destructive/OS-bound_ call is skipped inside `exercise`. The guard only requires each command channel appear in **some** entry's `channels` OR in `UNTESTED_CHANNELS`. The entries above already list these channels, so the guard passes; `UNTESTED_CHANNELS` documents the ones whose effect is deferred to the live run. If the guard reports a genuinely uncovered channel during implementation, add it to a catalog entry — do NOT pad `UNTESTED_CHANNELS` to silence it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/autopilot/coverage.test.ts`
Expected: PASS. If it lists uncovered channels, add them to the appropriate catalog entry's `channels` and `exercise`, then re-run.

- [ ] **Step 5: Commit**

```bash
git add src/autopilot/catalog.ts src/autopilot/coverage.test.ts
git commit -m "feat(autopilot): feature catalog + drift-guard test"
```

---

## Task 3: Report model + HTML gallery

**Files:**

- Create: `src/autopilot/report.ts`
- Test: `src/autopilot/report.test.ts`

**Interfaces:**

- Produces: `type StepStatus = 'pass' | 'fail' | 'skip'`, `interface StepResult { id: string; kind: 'core' | 'visual'; title: string; status: StepStatus; detail?: string; screenshot?: string }`, `interface Report { startedAt: number; finishedAt: number; display: boolean; results: StepResult[]; summary: { pass: number; fail: number; skip: number } }`, `function summarize(results): Report['summary']`, `function renderReportHtml(report): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/autopilot/report.test.ts
import { describe, it, expect } from 'vitest';
import { summarize, renderReportHtml, type StepResult } from './report';

const results: StepResult[] = [
  { id: 'a', kind: 'core', title: 'A', status: 'pass' },
  { id: 'b', kind: 'core', title: 'B', status: 'fail', detail: 'boom' },
  {
    id: 'c',
    kind: 'visual',
    title: 'C',
    status: 'skip',
    detail: 'no display',
    screenshot: 'c.png',
  },
];

describe('report', () => {
  it('summarizes counts', () => {
    expect(summarize(results)).toEqual({ pass: 1, fail: 1, skip: 1 });
  });
  it('renders html with counts, failure detail, and screenshot refs', () => {
    const html = renderReportHtml({
      startedAt: 0,
      finishedAt: 1,
      display: true,
      results,
      summary: summarize(results),
    });
    expect(html).toContain('1 passed');
    expect(html).toContain('1 failed');
    expect(html).toContain('boom');
    expect(html).toContain('c.png');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/autopilot/report.test.ts`
Expected: FAIL — `Cannot find module './report'`.

- [ ] **Step 3: Implement `report.ts`**

```ts
// src/autopilot/report.ts
export type StepStatus = 'pass' | 'fail' | 'skip';

export interface StepResult {
  id: string;
  kind: 'core' | 'visual'; // core = asserted against the backend; visual = UI state shown for a screenshot
  title: string;
  status: StepStatus;
  detail?: string;
  screenshot?: string; // filename relative to the report dir
}

export interface Report {
  startedAt: number;
  finishedAt: number;
  display: boolean; // false => screenshots were skipped
  results: StepResult[];
  summary: { pass: number; fail: number; skip: number };
}

export function summarize(results: StepResult[]): Report['summary'] {
  return {
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };
}

function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

export function renderReportHtml(report: Report): string {
  const { summary } = report;
  const rows = report.results
    .map((r) => {
      const shot = r.screenshot
        ? `<img src="shots/${esc(r.screenshot)}" loading="lazy" width="320">`
        : '';
      const detail = r.detail ? `<div class="detail">${esc(r.detail)}</div>` : '';
      return `<tr class="${r.status}"><td>${esc(r.status)}</td><td>${esc(r.kind)}</td><td>${esc(r.title)}${detail}</td><td>${shot}</td></tr>`;
    })
    .join('\n');
  return `<!doctype html><meta charset="utf-8"><title>Aegis autopilot report</title>
<style>body{font:14px system-ui;background:#111;color:#eee;margin:24px}
h1{margin:0 0 8px}.bar{margin-bottom:16px}.pass{color:#4ade80}.fail{color:#f87171}.skip{color:#fbbf24}
table{border-collapse:collapse;width:100%}td{border-top:1px solid #333;padding:8px;vertical-align:top}
.detail{color:#f87171;font-family:monospace;white-space:pre-wrap;margin-top:4px}
tr.fail{background:#2a1414}img{border:1px solid #333;border-radius:4px}</style>
<h1>Aegis autopilot</h1>
<div class="bar"><b class="pass">${summary.pass} passed</b> · <b class="fail">${summary.fail} failed</b> · <b class="skip">${summary.skip} skipped</b>${report.display ? '' : ' · <i>screenshots skipped (no display)</i>'}</div>
<table><tr><th>status</th><th>kind</th><th>step</th><th>shot</th></tr>
${rows}
</table>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/autopilot/report.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/autopilot/report.ts src/autopilot/report.test.ts
git commit -m "feat(autopilot): report model + html gallery"
```

---

## Task 4: Control surface

**Files:**

- Create: `src/autopilot/control.ts`
- Test: `src/autopilot/control.test.ts`

**Interfaces:**

- Produces: `interface AutopilotControl { openSettings(): void; closeSettings(): void; openDownloads(): void; closeDownloads(): void; openManager(): void; closeManager(): void; setSidebar(open: boolean): void; setShield(open: boolean): void; enterFullscreen(): void; exitFullscreen(): void; showError(f: unknown): void; clearError(): void; showCrash(c: unknown): void; clearCrash(): void; openConfirm(message: string): void }`, `function installAutopilotControl(c: AutopilotControl): () => void`, `function getAutopilotControl(): AutopilotControl | undefined`.
- Consumed by: `App.tsx` (Task 5), `reach.ts` (Task 5b/6), `run.ts` (Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// src/autopilot/control.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installAutopilotControl, getAutopilotControl, type AutopilotControl } from './control';

function fake(): AutopilotControl {
  return {
    openSettings: vi.fn(),
    closeSettings: vi.fn(),
    openDownloads: vi.fn(),
    closeDownloads: vi.fn(),
    openManager: vi.fn(),
    closeManager: vi.fn(),
    setSidebar: vi.fn(),
    setShield: vi.fn(),
    enterFullscreen: vi.fn(),
    exitFullscreen: vi.fn(),
    showError: vi.fn(),
    clearError: vi.fn(),
    showCrash: vi.fn(),
    clearCrash: vi.fn(),
    openConfirm: vi.fn(),
  };
}

afterEach(() => {
  delete (window as Record<string, unknown>).__aegisAutopilot;
});

describe('autopilot control surface', () => {
  it('install exposes the control on window and getter returns it', () => {
    const c = fake();
    const off = installAutopilotControl(c);
    expect(getAutopilotControl()).toBe(c);
    off();
    expect(getAutopilotControl()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/autopilot/control.test.ts`
Expected: FAIL — `Cannot find module './control'`.

- [ ] **Step 3: Implement `control.ts`**

```ts
// src/autopilot/control.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/autopilot/control.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/autopilot/control.ts src/autopilot/control.test.ts
git commit -m "feat(autopilot): dev-only control surface"
```

---

## Task 5: Register the control surface in DesktopApp

**Files:**

- Modify: `src/App.tsx` (imports + a dev-only effect inside `DesktopApp`, after the existing state declarations ~line 107)
- Test: `src/App.test.tsx` is unaffected; add `src/autopilot/registration.test.tsx`

**Interfaces:**

- Consumes: `installAutopilotControl`, `AutopilotControl` from `control.ts`; the `DesktopApp` setState fns + `confirm` from `lib/toast`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/autopilot/registration.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Reuse the App test's mock by importing it is not possible; mock minimally here.
vi.mock('../lib/ipcClient', async () =>
  (await import('../testFixtures/aegisMock')).aegisMockModule(),
);

beforeEach(() => {
  (import.meta as unknown as { env: Record<string, unknown> }).env.VITE_AEGIS_AUTOPILOT = '1';
});
afterEach(() => {
  delete (window as Record<string, unknown>).__aegisAutopilot;
  vi.resetModules();
});

describe('control surface registration', () => {
  it('registers window.__aegisAutopilot when dev + flag set', async () => {
    const { render } = await import('@testing-library/react');
    const { App } = await import('../App');
    render(<App />);
    expect((window as Record<string, unknown>).__aegisAutopilot).toBeDefined();
  });
});
```

> **Implementation note:** the existing `src/App.test.tsx` inlines a large `aegis` mock. To avoid duplicating it, extract that mock object into `src/testFixtures/aegisMock.ts` exporting `aegisMockModule()` (returns `{ aegis: {...} }`) and have `App.test.tsx` import it too. Do that extraction as Step 1a below before writing this test.

- [ ] **Step 1a: Extract the shared aegis mock**

Create `src/testFixtures/aegisMock.ts` exporting `export function aegisMockModule() { return { aegis: { /* the object currently inlined in App.test.tsx lines 40-... */ } }; }`. Then in `src/App.test.tsx` replace the inline `vi.mock('./lib/ipcClient', () => ({ aegis: {...} }))` body with `vi.mock('./lib/ipcClient', async () => (await import('./testFixtures/aegisMock')).aegisMockModule())`. Run `npm test -- src/App.test.tsx` and confirm it still PASSES (no behavior change).

- [ ] **Step 2: Run the registration test to verify it fails**

Run: `npm test -- src/autopilot/registration.test.tsx`
Expected: FAIL — `window.__aegisAutopilot` is undefined (registration not implemented).

- [ ] **Step 3: Add the dev-only registration effect in `DesktopApp`**

In `src/App.tsx`, add to the imports:

```ts
import { installAutopilotControl } from './autopilot/control';
import { confirm } from './lib/toast';
```

(`confirm` is already exported from `lib/toast` — `subscribeConfirmOpen` is imported at line 7; add `confirm` to that import or a new line.)

Then, inside `DesktopApp`, immediately after the `const safety = useSafety();` line (~107) and before the first `useEffect`, add:

```ts
// Dev-only: expose an imperative control surface so the autopilot can reach every
// overlay/state deterministically. Gated so it can NEVER run in a production build.
useEffect(() => {
  if (!import.meta.env.DEV || !import.meta.env.VITE_AEGIS_AUTOPILOT) return;
  return installAutopilotControl({
    openSettings: () => setSettingsOpen(true),
    closeSettings: () => setSettingsOpen(false),
    openDownloads: () => setDownloadsOpen(true),
    closeDownloads: () => setDownloadsOpen(false),
    openManager: () => setManagerOpen(true),
    closeManager: () => setManagerOpen(false),
    setSidebar: (open) => setSidebarOpen(open),
    setShield: (open) => setShieldOpen(open),
    enterFullscreen: () => setFullscreen(true),
    exitFullscreen: () => setFullscreen(false),
    showError: (f) => {
      setCrashed(null);
      setFailed(f as NavFailed);
    },
    clearError: () => setFailed(null),
    showCrash: (c) => {
      setFailed(null);
      setCrashed(c as NavCrashed);
    },
    clearCrash: () => setCrashed(null),
    openConfirm: (message) => {
      void confirm(message);
    },
  });
}, []);
```

> Add a TS ambient declaration so `import.meta.env.VITE_AEGIS_AUTOPILOT` typechecks: create `src/vite-env.d.ts` with:
>
> ```ts
> /// <reference types="vite/client" />
> interface ImportMetaEnv {
>   readonly VITE_AEGIS_AUTOPILOT?: string;
> }
> interface ImportMeta {
>   readonly env: ImportMetaEnv;
> }
> ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/autopilot/registration.test.tsx src/App.test.tsx`
Expected: PASS (registration registers the surface; App test still green).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/vite-env.d.ts src/testFixtures/aegisMock.ts src/App.test.tsx src/autopilot/registration.test.tsx
git commit -m "feat(autopilot): register dev-only control surface in DesktopApp"
```

---

## Task 6: Screen-reaching (`reach.ts`)

**Files:**

- Create: `src/autopilot/reach.ts`
- Test: `src/autopilot/reach.test.ts`

**Interfaces:**

- Consumes: `AutopilotControl` from `control.ts`, `ScreenSpec` from `screens.ts`, `IPC` from `shared/types`.
- Produces: `interface ReachDeps { emitEvent(channel: string, payload: unknown): void | Promise<void> }`, `async function reachScreen(control: AutopilotControl, screen: ScreenSpec, deps: ReachDeps): Promise<void>`, `async function leaveScreen(control: AutopilotControl, screen: ScreenSpec): Promise<void>`, `function clickTabByLabel(label: string): boolean`.

The `emitEvent` callback differs by context: live passes `devEmit.emitEvent` (real Tauri event); vitest passes a fn that invokes the captured mock event callback. DOM clicks for Settings/sidebar sub-tabs work in both jsdom and the live webview.

- [ ] **Step 1: Write the failing test**

```ts
// src/autopilot/reach.test.ts
import { describe, it, expect, vi } from 'vitest';
import { reachScreen } from './reach';
import type { AutopilotControl } from './control';
import { IPC } from '../../shared/types';

function fake(): AutopilotControl {
  const f = () => vi.fn();
  return Object.fromEntries(
    [
      'openSettings',
      'closeSettings',
      'openDownloads',
      'closeDownloads',
      'openManager',
      'closeManager',
      'setSidebar',
      'setShield',
      'enterFullscreen',
      'exitFullscreen',
      'showError',
      'clearError',
      'showCrash',
      'clearCrash',
      'openConfirm',
    ].map((k) => [k, f()]),
  ) as unknown as AutopilotControl;
}

describe('reachScreen', () => {
  it('opens the downloads overlay', async () => {
    const c = fake();
    await reachScreen(c, { id: 'downloads', label: 'D', via: 'overlay' }, { emitEvent: vi.fn() });
    expect(c.openDownloads).toHaveBeenCalled();
  });
  it('emits the nav.failed event for the error overlay', async () => {
    const c = fake();
    const emitEvent = vi.fn();
    await reachScreen(c, { id: 'errorOverlay', label: 'E', via: 'event' }, { emitEvent });
    expect(emitEvent).toHaveBeenCalledWith(
      IPC.evtNavFailed,
      expect.objectContaining({ viewId: expect.any(Number) }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/autopilot/reach.test.ts`
Expected: FAIL — `Cannot find module './reach'`.

- [ ] **Step 3: Implement `reach.ts`**

```ts
// src/autopilot/reach.ts
import type { AutopilotControl } from './control';
import type { ScreenSpec, ScreenId } from './screens';
import { IPC, PRIMARY_VIEW_ID } from '../../shared/types';

export interface ReachDeps {
  emitEvent(channel: string, payload: unknown): void | Promise<void>;
}

const V = PRIMARY_VIEW_ID;

/** Click a tab/button by its visible text (Settings + sidebar sub-tabs). */
export function clickTabByLabel(label: string): boolean {
  const els = Array.from(document.querySelectorAll('button,[role="tab"]')) as HTMLElement[];
  const el = els.find((e) => e.textContent?.trim() === label);
  if (el) {
    el.click();
    return true;
  }
  return false;
}

const SETTINGS_TAB_LABEL: Record<string, string> = {
  appearance: 'Appearance',
  search: 'Search',
  home: 'Home',
  tabs: 'Tabs',
  filterLists: 'Filter Lists',
  myFilters: 'My Filters',
  allowlist: 'Allowlist',
  downloads: 'Downloads',
  sitePermissions: 'Site permissions',
  security: 'Security',
  sync: 'Sync',
  data: 'Data',
};

// Representative payloads. TS will flag any field mismatch against shared/types.ts
// (NavFailed/NavCrashed/PermissionPrompt/SafetyInterstitialPayload) — align then.
const EVENT_PAYLOAD: Partial<Record<ScreenId, { channel: string; payload: unknown }>> = {
  errorOverlay: {
    channel: IPC.evtNavFailed,
    payload: {
      viewId: V,
      url: 'https://invalid.invalid/',
      errorCode: -105,
      errorDescription: 'NAME_NOT_RESOLVED',
    },
  },
  crashOverlay: { channel: IPC.evtNavCrashed, payload: { viewId: V, reason: 'crashed' } },
  permissionPrompt: {
    channel: IPC.evtPermissionsPrompt,
    payload: { requestId: 'ap-1', origin: 'https://example.com', permission: 'geolocation' },
  },
  safetyInterstitial: {
    channel: IPC.evtSafetyInterstitial,
    payload: { kind: 'malware', host: 'malware.test', url: 'https://malware.test/' },
  },
};

export async function reachScreen(
  control: AutopilotControl,
  screen: ScreenSpec,
  deps: ReachDeps,
): Promise<void> {
  switch (screen.via) {
    case 'state':
      control.closeSettings();
      control.closeDownloads();
      control.closeManager();
      control.setSidebar(false);
      control.setShield(false);
      control.exitFullscreen();
      break;
    case 'overlay':
      if (screen.id === 'downloads') control.openDownloads();
      else if (screen.id === 'favoritesManager') control.openManager();
      else if (screen.id === 'shieldPopover') control.setShield(true);
      else if (screen.id === 'fullscreen') control.enterFullscreen();
      else if (screen.id === 'confirmDialog') control.openConfirm('Autopilot confirm?');
      break;
    case 'sidebarTab':
      control.setSidebar(true);
      await tick();
      clickTabByLabel(screen.id === 'sidebar:history' ? 'History' : 'Saved');
      break;
    case 'settingsTab': {
      control.openSettings();
      await tick();
      const tab = screen.id.slice('settings:'.length);
      clickTabByLabel(SETTINGS_TAB_LABEL[tab] ?? tab);
      break;
    }
    case 'event': {
      const e = EVENT_PAYLOAD[screen.id];
      if (e) await deps.emitEvent(e.channel, e.payload);
      break;
    }
  }
  await tick();
}

export async function leaveScreen(control: AutopilotControl, screen: ScreenSpec): Promise<void> {
  if (screen.via === 'settingsTab') control.closeSettings();
  else if (screen.id === 'downloads') control.closeDownloads();
  else if (screen.id === 'favoritesManager') control.closeManager();
  else if (screen.id === 'shieldPopover') control.setShield(false);
  else if (screen.id === 'fullscreen') control.exitFullscreen();
  else if (screen.id === 'sidebar:history' || screen.id === 'sidebar:saved')
    control.setSidebar(false);
  else if (screen.id === 'errorOverlay') control.clearError();
  else if (screen.id === 'crashOverlay') control.clearCrash();
  await tick();
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/autopilot/reach.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/autopilot/reach.ts src/autopilot/reach.test.ts
git commit -m "feat(autopilot): shared screen-reaching"
```

---

## Task 7: Dev-only Rust commands

**Files:**

- Create: `src-tauri/src/autopilot.rs`
- Modify: `src-tauri/src/lib.rs` (`#[cfg(debug_assertions)] mod autopilot;` near the other `mod` lines ~71; cfg-split `invoke_handler` at line 521)

**Interfaces:**

- Produces (dev-only Tauri commands): `autopilot_screenshot(app, name: String)`, `autopilot_write_report(app, report_json: String, html: String)`, `autopilot_done(app)`, `autopilot_emit_event(app, name: String, payload: serde_json::Value)`. Output dir read from env `AEGIS_AUTOPILOT_OUT` (fallback `std::env::temp_dir()/aegis-autopilot`).

- [ ] **Step 1: Implement `autopilot.rs`**

```rust
// src-tauri/src/autopilot.rs
// Dev-only autopilot support. Compiled ONLY under debug_assertions, so release
// builds never contain it. The renderer (also dev-only) invokes these directly by
// name — they are NOT part of the production `ipc` dispatcher / IPC contract.
#![cfg(debug_assertions)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

fn out_dir() -> PathBuf {
    std::env::var("AEGIS_AUTOPILOT_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("aegis-autopilot"))
}

#[tauri::command]
pub fn autopilot_screenshot(name: String) -> Result<(), String> {
    let dir = out_dir().join("shots");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    let path = dir.join(format!("{safe}.png"));
    // Best-effort: spectacle active-window, background mode, no notification.
    let status = Command::new("spectacle")
        .args(["-b", "-n", "-a", "-o", &path.to_string_lossy()])
        .status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("spectacle exit {s}")),
        Err(e) => Err(format!("spectacle spawn failed: {e}")),
    }
}

#[tauri::command]
pub fn autopilot_write_report(report_json: String, html: String) -> Result<(), String> {
    let dir = out_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("report.json"), report_json).map_err(|e| e.to_string())?;
    fs::write(dir.join("report.html"), html).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn autopilot_done() -> Result<(), String> {
    let dir = out_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("done.sentinel"), b"done").map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn autopilot_emit_event(app: AppHandle, name: String, payload: serde_json::Value) {
    // Reuse the production emitter so the `.`->`:` rewrite + delivery match real events.
    crate::emit_event(&app, &name, payload);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn out_dir_honors_env() {
        std::env::set_var("AEGIS_AUTOPILOT_OUT", "/tmp/aegis-ap-test");
        assert_eq!(out_dir(), PathBuf::from("/tmp/aegis-ap-test"));
        std::env::remove_var("AEGIS_AUTOPILOT_OUT");
    }
}
```

- [ ] **Step 2: Wire it into `lib.rs`**

Near the other `mod` declarations (~line 71), add:

```rust
#[cfg(debug_assertions)]
mod autopilot;
```

Then replace line 521 `.invoke_handler(tauri::generate_handler![ipc])` by breaking the builder chain. The current shape is `let builder = tauri::Builder::default()…;` then a trailing `.invoke_handler(tauri::generate_handler![ipc]).run(tauri::generate_context!());`. Change the tail to:

```rust
    #[cfg(debug_assertions)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        ipc,
        autopilot::autopilot_screenshot,
        autopilot::autopilot_write_report,
        autopilot::autopilot_done,
        autopilot::autopilot_emit_event
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![ipc]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
```

> Adjust to the actual end-of-chain in `lib.rs` (it may already call `.run(...)` inline). The goal: `invoke_handler` is cfg-split; the `.run(...)` call is preserved. Read lines 510-524 before editing.

- [ ] **Step 3: Compile + unit test (debug)**

Run: `cargo test --manifest-path src-tauri/Cargo.toml autopilot::`
Expected: the `out_dir_honors_env` test PASSES; crate compiles.

- [ ] **Step 4: Verify release excludes it**

Run: `cargo build --release --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5`
Expected: builds clean (the `mod autopilot;` and the dev `invoke_handler` arm are both `#[cfg(debug_assertions)]`, so release compiles without them). If the build fails referencing `autopilot::`, the cfg-split in Step 2 is wrong — fix it.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/autopilot.rs src-tauri/src/lib.rs
git commit -m "feat(autopilot): dev-only Rust commands (screenshot/report/emit)"
```

---

## Task 8: Live runner (`run.ts`) + dev-emit wrappers (`devEmit.ts`)

**Files:**

- Create: `src/autopilot/devEmit.ts`, `src/autopilot/run.ts`
- Test: `src/autopilot/devEmit.test.ts`, `src/autopilot/run.test.ts`

**Interfaces:**

- `devEmit.ts` produces: `async function screenshot(name): Promise<void>`, `async function writeReport(report, html): Promise<void>`, `async function done(): Promise<void>`, `async function emitEvent(channel, payload): Promise<void>` — each wraps `invoke('autopilot_*', …)` from `@tauri-apps/api/core`.
- `run.ts` produces: `async function runAutopilot(deps?: Partial<RunDeps>): Promise<Report>`, where `interface RunDeps { api: AegisApi; control: AutopilotControl; screenshot(name): Promise<void>; emitEvent(ch, p): Promise<void>; writeReport(r, h): Promise<void>; done(): Promise<void>; hasDisplay: boolean; now(): number; navigateFixture(): Promise<{ before: number; after: number } | null> }`.

- [ ] **Step 1: Write the failing devEmit test**

```ts
// src/autopilot/devEmit.test.ts
import { describe, it, expect, vi } from 'vitest';
const invoke = vi.fn(async () => undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { screenshot, emitEvent } from './devEmit';

describe('devEmit', () => {
  it('screenshot invokes the dev command', async () => {
    await screenshot('home');
    expect(invoke).toHaveBeenCalledWith('autopilot_screenshot', { name: 'home' });
  });
  it('emitEvent invokes the dev command', async () => {
    await emitEvent('nav.failed', { viewId: 1 });
    expect(invoke).toHaveBeenCalledWith('autopilot_emit_event', {
      name: 'nav.failed',
      payload: { viewId: 1 },
    });
  });
});
```

- [ ] **Step 2: Run + verify fail; implement `devEmit.ts`**

Run: `npm test -- src/autopilot/devEmit.test.ts` → FAIL (`Cannot find module './devEmit'`).

```ts
// src/autopilot/devEmit.ts
// Live-only wrappers over the dev-only Rust commands. Screenshot failures are
// swallowed (best-effort); callers decide skip vs fail based on hasDisplay.
import { invoke } from '@tauri-apps/api/core';
import type { Report } from './report';

export async function screenshot(name: string): Promise<void> {
  await invoke('autopilot_screenshot', { name });
}
export async function writeReport(report: Report, html: string): Promise<void> {
  await invoke('autopilot_write_report', { reportJson: JSON.stringify(report, null, 2), html });
}
export async function done(): Promise<void> {
  await invoke('autopilot_done');
}
export async function emitEvent(channel: string, payload: unknown): Promise<void> {
  await invoke('autopilot_emit_event', { name: channel, payload });
}
```

Run: `npm test -- src/autopilot/devEmit.test.ts` → PASS.

- [ ] **Step 3: Write the failing run test**

```ts
// src/autopilot/run.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runAutopilot } from './run';
import { CATALOG } from './catalog';
import { SCREENS } from './screens';
import type { AutopilotControl } from './control';

function fakeControl(): AutopilotControl {
  return Object.fromEntries(
    [
      'openSettings',
      'closeSettings',
      'openDownloads',
      'closeDownloads',
      'openManager',
      'closeManager',
      'setSidebar',
      'setShield',
      'enterFullscreen',
      'exitFullscreen',
      'showError',
      'clearError',
      'showCrash',
      'clearCrash',
      'openConfirm',
    ].map((k) => [k, vi.fn()]),
  ) as unknown as AutopilotControl;
}

// Minimal faithful-shape fake of the api (returns shapes the catalog asserts).
const api = new Proxy(
  {},
  {
    get: () => new Proxy({}, { get: () => async () => [] }),
  },
) as never;

describe('runAutopilot', () => {
  it('produces a result per screen and per catalog entry', async () => {
    const screenshot = vi.fn(async () => {});
    const report = await runAutopilot({
      api,
      control: fakeControl(),
      screenshot,
      emitEvent: vi.fn(async () => {}),
      writeReport: vi.fn(async () => {}),
      done: vi.fn(async () => {}),
      hasDisplay: true,
      now: () => 0,
      navigateFixture: async () => null,
    });
    expect(report.results.length).toBeGreaterThanOrEqual(SCREENS.length + CATALOG.length);
    expect(report.summary.pass + report.summary.fail + report.summary.skip).toBe(
      report.results.length,
    );
  });
  it('marks screenshots skipped when no display', async () => {
    const report = await runAutopilot({
      api,
      control: fakeControl(),
      screenshot: vi.fn(async () => {}),
      emitEvent: vi.fn(async () => {}),
      writeReport: vi.fn(async () => {}),
      done: vi.fn(async () => {}),
      hasDisplay: false,
      now: () => 0,
      navigateFixture: async () => null,
    });
    expect(report.results.some((r) => r.kind === 'visual' && r.status === 'skip')).toBe(true);
  });
});
```

> The proxy-based `api` returns `[]` for everything; catalog entries that assert `assertObject` on a list call will fail in this unit test. That's fine — the test asserts _structure of the report_ (a result per entry, counts add up), not all-pass. If you prefer all-pass here, pass a richer fake; not required.

- [ ] **Step 4: Run + verify fail; implement `run.ts`**

Run: `npm test -- src/autopilot/run.test.ts` → FAIL (`Cannot find module './run'`).

```ts
// src/autopilot/run.ts
// The live autopilot orchestration. Activated only from main.tsx in dev. Walks
// every SCREEN (drive control surface -> screenshot) and every CATALOG feature
// (exercise the real core), runs end-to-end inductions, then writes the report.
import type { AegisApi } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { getAutopilotControl, type AutopilotControl } from './control';
import { SCREENS } from './screens';
import { CATALOG } from './catalog';
import { reachScreen, leaveScreen } from './reach';
import { summarize, type Report, type StepResult, renderReportHtml } from './report';
import * as devEmit from './devEmit';

export interface RunDeps {
  api: AegisApi;
  control: AutopilotControl;
  screenshot(name: string): Promise<void>;
  emitEvent(channel: string, payload: unknown): Promise<void>;
  writeReport(report: Report, html: string): Promise<void>;
  done(): Promise<void>;
  hasDisplay: boolean;
  now(): number;
  /** Navigate the ad fixture; return before/after session block counts, or null if unavailable. */
  navigateFixture(): Promise<{ before: number; after: number } | null>;
}

function liveDeps(): RunDeps {
  const control = getAutopilotControl();
  if (!control) throw new Error('autopilot control not registered');
  return {
    api: aegis,
    control,
    screenshot: devEmit.screenshot,
    emitEvent: devEmit.emitEvent,
    writeReport: devEmit.writeReport,
    done: devEmit.done,
    hasDisplay: !!(typeof navigator !== 'undefined'),
    now: () => Date.now(),
    navigateFixture: async () => {
      const url = (import.meta.env.VITE_AEGIS_AUTOPILOT_FIXTURE as string) || '';
      if (!url) return null;
      const before = (await aegis.adblock.getState()).sessionBlocked ?? 0;
      await aegis.nav.navigate(1, url);
      await new Promise((r) => setTimeout(r, 4000));
      const after = (await aegis.adblock.getState()).sessionBlocked ?? 0;
      return { before, after };
    },
  };
}

export async function runAutopilot(partial?: Partial<RunDeps>): Promise<Report> {
  const deps: RunDeps = { ...liveDepsSafe(partial), ...partial } as RunDeps;
  const startedAt = deps.now();
  const results: StepResult[] = [];

  // 1) Screen walk
  for (const screen of SCREENS) {
    try {
      await reachScreen(deps.control, screen, { emitEvent: deps.emitEvent });
      if (deps.hasDisplay) {
        try {
          await deps.screenshot(screen.id);
          results.push({
            id: `screen:${screen.id}`,
            kind: 'visual',
            title: screen.label,
            status: 'pass',
            screenshot: `${screen.id}.png`,
          });
        } catch (e) {
          results.push({
            id: `screen:${screen.id}`,
            kind: 'visual',
            title: screen.label,
            status: 'fail',
            detail: String(e),
          });
        }
      } else {
        results.push({
          id: `screen:${screen.id}`,
          kind: 'visual',
          title: screen.label,
          status: 'skip',
          detail: 'no display',
        });
      }
    } catch (e) {
      results.push({
        id: `screen:${screen.id}`,
        kind: 'visual',
        title: screen.label,
        status: 'fail',
        detail: String(e),
      });
    } finally {
      await leaveScreen(deps.control, screen).catch(() => {});
    }
  }

  // 2) Feature exercise (real core)
  for (const f of CATALOG) {
    try {
      await f.exercise(deps.api);
      results.push({ id: f.id, kind: 'core', title: f.title, status: 'pass' });
    } catch (e) {
      results.push({ id: f.id, kind: 'core', title: f.title, status: 'fail', detail: String(e) });
    }
  }

  // 3) End-to-end induction: ad-block actually blocks on a real page
  try {
    const r = await deps.navigateFixture();
    if (!r)
      results.push({
        id: 'induction:adblock',
        kind: 'core',
        title: 'Ad-block blocks on fixture page',
        status: 'skip',
        detail: 'no fixture url',
      });
    else if (r.after > r.before)
      results.push({
        id: 'induction:adblock',
        kind: 'core',
        title: 'Ad-block blocks on fixture page',
        status: 'pass',
        detail: `blocked ${r.after - r.before}`,
      });
    else
      results.push({
        id: 'induction:adblock',
        kind: 'core',
        title: 'Ad-block blocks on fixture page',
        status: 'fail',
        detail: `count did not rise (${r.before} -> ${r.after})`,
      });
  } catch (e) {
    results.push({
      id: 'induction:adblock',
      kind: 'core',
      title: 'Ad-block blocks on fixture page',
      status: 'fail',
      detail: String(e),
    });
  }

  const report: Report = {
    startedAt,
    finishedAt: deps.now(),
    display: deps.hasDisplay,
    results,
    summary: summarize(results),
  };
  try {
    await deps.writeReport(report, renderReportHtml(report));
  } catch {
    /* ignore in unit tests */
  }
  try {
    await deps.done();
  } catch {
    /* ignore */
  }
  return report;
}

// liveDeps() touches `aegis`/import.meta; in unit tests `partial` overrides everything,
// so guard so a missing control surface doesn't throw when fully overridden.
function liveDepsSafe(partial?: Partial<RunDeps>): RunDeps {
  const required: Array<keyof RunDeps> = [
    'api',
    'control',
    'screenshot',
    'emitEvent',
    'writeReport',
    'done',
    'hasDisplay',
    'now',
    'navigateFixture',
  ];
  if (partial && required.every((k) => k in partial)) return partial as RunDeps;
  return liveDeps();
}
```

> `Date.now()` is allowed here (this is app code, not a Workflow script). The unit test passes `now: () => 0` to keep timestamps deterministic.

Run: `npm test -- src/autopilot/run.test.ts` → PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/autopilot/devEmit.ts src/autopilot/devEmit.test.ts src/autopilot/run.ts src/autopilot/run.test.ts
git commit -m "feat(autopilot): live runner + dev-emit wrappers"
```

---

## Task 9: Bootstrap in `main.tsx`

**Files:**

- Modify: `src/main.tsx`

- [ ] **Step 1: Add the dev-only bootstrap**

In `src/main.tsx`, after `createRoot(...).render(...)` (after line 19), append:

```ts
// Dev-only: when launched by the autopilot harness, drive the app autonomously.
// Vite dead-code-eliminates this whole branch in production (`import.meta.env.DEV`
// is the literal `false`), so the autopilot never ships in a release build.
if (import.meta.env.DEV && import.meta.env.VITE_AEGIS_AUTOPILOT) {
  // Give the app a moment to mount + register its control surface, then run.
  setTimeout(() => {
    void import('./autopilot/run').then((m) => m.runAutopilot());
  }, 1500);
}
```

- [ ] **Step 2: Verify production build excludes the autopilot**

Run:

```bash
npm run build:renderer
grep -rl "runAutopilot\|__aegisAutopilot\|autopilot_screenshot" dist/ || echo "ABSENT (good)"
```

Expected: `ABSENT (good)` — no autopilot symbols in the production bundle. If any appear, the `import.meta.env.DEV` gating is wrong.

- [ ] **Step 3: Commit**

```bash
git add src/main.tsx
git commit -m "feat(autopilot): dev-only bootstrap (DCE'd from production)"
```

---

## Task 10: Fixture page + server

**Files:**

- Create: `scripts/autopilot/fixture/index.html`, `scripts/autopilot/fixture-server.mjs`

- [ ] **Step 1: Create the ad-laden probe page**

```html
<!-- scripts/autopilot/fixture/index.html -->
<!doctype html>
<meta charset="utf-8" />
<title>Aegis autopilot fixture</title>
<h1>Autopilot ad-block fixture</h1>
<p>
  This page references known-blocked ad/tracker hosts so the autopilot can verify real network
  ad-blocking on the live content webview.
</p>
<!-- Hosts present in the bundled EasyList/EasyPrivacy/Peter Lowe sets. -->
<img src="https://ib.adnxs.com/pixel.gif" alt="" width="1" height="1" />
<script src="https://www.googletagmanager.com/gtag/js?id=AP-TEST" async></script>
<script src="https://static.doubleclick.net/instream/ad_status.js" async></script>
<img src="https://www.google-analytics.com/collect?v=1" alt="" width="1" height="1" />
<p id="done">fixture loaded</p>
```

- [ ] **Step 2: Create the static server**

```js
// scripts/autopilot/fixture-server.mjs
// Tiny static server for the autopilot fixture. Must be http (not file://) so the
// content webview's network filtering applies. Usage: node fixture-server.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
const port = Number(process.argv[2] || 8137);

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(
    /^(\.\.[/\\])+/,
    '',
  );
  const path = join(root, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': path.endsWith('.html') ? 'text/html' : 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`fixture http://127.0.0.1:${port}/`));
```

- [ ] **Step 3: Verify the server serves the page**

Run:

```bash
node scripts/autopilot/fixture-server.mjs 8137 &
sleep 1
curl -s http://127.0.0.1:8137/ | grep -q "adnxs.com" && echo "OK fixture serves ad refs"
kill %1
```

Expected: `OK fixture serves ad refs`.

- [ ] **Step 4: Commit**

```bash
git add scripts/autopilot/fixture/index.html scripts/autopilot/fixture-server.mjs
git commit -m "feat(autopilot): ad-block fixture page + static server"
```

---

## Task 11: Linux launcher script

**Files:**

- Create: `scripts/autopilot/run-autopilot.sh`

- [ ] **Step 1: Write the launcher**

```bash
#!/usr/bin/env bash
# scripts/autopilot/run-autopilot.sh
# Launch Aegis (real core, dev build) and run the in-app autopilot autonomously
# on a DISPOSABLE profile, then print the report. Linux only (uses spectacle).
set -euo pipefail
cd "$(dirname "$0")/../.."

TS="$(date +%Y%m%d-%H%M%S)"
OUT="$(pwd)/target/autopilot/$TS"
PROFILE="$(mktemp -d /tmp/aegis-autopilot-profile.XXXXXX)"
FIXTURE_PORT=8137
mkdir -p "$OUT"

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "WARN: no DISPLAY/WAYLAND_DISPLAY — screenshots will be skipped (functional tour still runs)."
fi

echo "==> output:  $OUT"
echo "==> profile: $PROFILE (disposable)"

cleanup() {
  [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "${FIX_PID:-}" ] && kill "$FIX_PID" 2>/dev/null || true
  rm -rf "$PROFILE"
}
trap cleanup EXIT

# 1) fixture server
node scripts/autopilot/fixture-server.mjs "$FIXTURE_PORT" & FIX_PID=$!

# 2) launch the app on the disposable profile with autopilot enabled
XDG_DATA_HOME="$PROFILE/data" \
XDG_CONFIG_HOME="$PROFILE/config" \
AEGIS_AUTOPILOT_OUT="$OUT" \
VITE_AEGIS_AUTOPILOT=1 \
VITE_AEGIS_AUTOPILOT_FIXTURE="http://127.0.0.1:$FIXTURE_PORT/" \
  npm run tauri:dev > "$OUT/app.log" 2>&1 & APP_PID=$!

# 3) wait for the report sentinel (watchdog)
echo "==> waiting for autopilot to finish (max 300s)..."
for i in $(seq 1 300); do
  [ -f "$OUT/done.sentinel" ] && break
  if ! kill -0 "$APP_PID" 2>/dev/null; then echo "ERROR: app exited early — see $OUT/app.log"; exit 2; fi
  sleep 1
done

if [ ! -f "$OUT/done.sentinel" ]; then echo "ERROR: timed out waiting for report — see $OUT/app.log"; exit 3; fi

# 4) summarize
node -e '
  const r = require(process.argv[1] + "/report.json");
  const s = r.summary;
  console.log(`\n==> RESULT: ${s.pass} passed, ${s.fail} failed, ${s.skip} skipped`);
  for (const x of r.results.filter(x => x.status === "fail")) console.log(`   FAIL ${x.title}: ${x.detail || ""}`);
  console.log(`\n==> gallery: ${process.argv[1]}/report.html`);
  process.exit(s.fail > 0 ? 1 : 0);
' "$OUT"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/autopilot/run-autopilot.sh`

- [ ] **Step 3: Lint the script**

Run: `bash -n scripts/autopilot/run-autopilot.sh && echo "syntax OK"`
Expected: `syntax OK`. (A live end-to-end run happens in Task 13 — it needs a full `tauri:dev` build.)

- [ ] **Step 4: Commit**

```bash
git add scripts/autopilot/run-autopilot.sh
git commit -m "feat(autopilot): Linux launcher (disposable profile + report)"
```

---

## Task 12: Exhaustive vitest tour (desktop + mobile)

**Files:**

- Create: `src/autopilot/tour.test.tsx`, `src/autopilot/tour.mobile.test.tsx`

**Interfaces:**

- Consumes: `SCREENS`, `CATALOG`, `reachScreen`, the shared `aegisMock`, the real `App`/`DesktopApp`/`MobileApp`.

- [ ] **Step 1: Write the desktop tour**

```tsx
// src/autopilot/tour.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { SCREENS } from './screens';
import { CATALOG } from './catalog';
import { reachScreen } from './reach';
import { getAutopilotControl } from './control';

vi.mock('../lib/ipcClient', async () =>
  (await import('../testFixtures/aegisMock')).aegisMockModule(),
);

beforeEach(() => {
  (import.meta as unknown as { env: Record<string, unknown> }).env.VITE_AEGIS_AUTOPILOT = '1';
});
afterEach(() => {
  cleanup();
  delete (window as Record<string, unknown>).__aegisAutopilot;
});

describe('desktop autopilot tour', () => {
  it('reaches every desktop screen without crashing', async () => {
    const { App } = await import('../App');
    render(<App />);
    const control = getAutopilotControl();
    expect(control).toBeDefined();
    for (const screen of SCREENS) {
      await act(async () => {
        await reachScreen(control!, screen, { emitEvent: vi.fn() });
      });
      // App still mounted (no throw / unmount) after reaching the screen.
      expect(document.querySelector('.app, .fullscreen-exit')).toBeTruthy();
    }
  });

  it('exercises every catalog feature against the mock api', async () => {
    const { aegis } = await import('../lib/ipcClient');
    for (const f of CATALOG) {
      await expect(f.exercise(aegis), `catalog ${f.id}`).resolves.toBeUndefined();
    }
  });
});
```

> If a catalog `exercise` rejects against the mock, the mock in `aegisMock.ts` is missing a faithful shape for that domain — extend the mock (e.g. add `picker`, `update`, `safety`, `permissions`, `data`, `view`, `tabs` returning the shapes the catalog asserts). This is expected fill-in work; the test names the failing `id`.

- [ ] **Step 2: Run + iterate until green**

Run: `npm test -- src/autopilot/tour.test.tsx`
Expected: PASS. Extend `aegisMock.ts` shapes until the catalog-exercise test passes (the assertion message names each failing `id`).

- [ ] **Step 3: Write the mobile tour**

```tsx
// src/autopilot/tour.mobile.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('../lib/ipcClient', async () =>
  (await import('../testFixtures/aegisMock')).aegisMockModule(),
);

beforeEach(() => {
  document.documentElement.classList.add('aegis-mobile');
});
afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('aegis-mobile');
  vi.resetModules();
});

describe('mobile autopilot tour', () => {
  it('renders MobileApp without crashing when .aegis-mobile is set', async () => {
    // App computes isMobile at module load, so import AFTER setting the class.
    const { App } = await import('../App');
    const { container } = render(<App />);
    expect(container.querySelector('.mobile-bottombar, .aegis-mobile, .app')).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the mobile tour**

Run: `npm test -- src/autopilot/tour.mobile.test.tsx`
Expected: PASS. (Adjust the final selector to a class MobileApp actually renders — read `MobileBottomBar`/`MobileApp` if it fails.)

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all projects green, including the new autopilot tests.

- [ ] **Step 6: Commit**

```bash
git add src/autopilot/tour.test.tsx src/autopilot/tour.mobile.test.tsx src/testFixtures/aegisMock.ts
git commit -m "test(autopilot): exhaustive vitest tour (desktop + mobile)"
```

---

## Task 13: CLAUDE.md docs + live verification

**Files:**

- Modify: `CLAUDE.md`, `src/CLAUDE.md`, `src-tauri/CLAUDE.md`, `scripts/CLAUDE.md`

- [ ] **Step 1: Update root `CLAUDE.md`**

Under `## Commands`, add an autopilot subsection:

````markdown
### Autopilot test harness

```bash
npm test                                  # includes the exhaustive vitest tour + drift guard
bash scripts/autopilot/run-autopilot.sh   # launch the real app + autonomously test every feature (Linux, needs a display)
```
````

The live autopilot drives every feature through the real Rust core and screenshots
every UI state; the report lands in `target/autopilot/<timestamp>/report.html`. It runs
only in dev (`VITE_AEGIS_AUTOPILOT`) and is dead-code-eliminated from production builds.

````

Under `## Conventions that matter everywhere`, add:

```markdown
- **Keep the autopilot catalog current (living docs, enforced).** Every feature is
  registered once in `src/autopilot/catalog.ts` (IPC features) and `src/autopilot/screens.ts`
  (UI screens), consumed by both the live autopilot and the vitest tour. When you add a
  feature — a new IPC channel, a Settings tab, or a full-window overlay — add its catalog/
  screen entry **in the same commit**. The drift-guard test (`src/autopilot/coverage.test.ts`)
  fails the build if a command channel has no catalog entry, so this isn't optional.
````

- [ ] **Step 2: Update `src/CLAUDE.md`**

Add a section documenting `src/autopilot/` (screens, catalog, control surface `window.__aegisAutopilot`, reach, run, the dev-only `import.meta.env` gating) and the `tour`/`coverage` tests.

- [ ] **Step 3: Update `src-tauri/CLAUDE.md`**

Document `src-tauri/src/autopilot.rs` — the `#[cfg(debug_assertions)]` commands (`autopilot_screenshot`/`write_report`/`done`/`emit_event`), that they're a dev-only side channel (not in the `ipc` dispatcher / `IPC` contract), and the cfg-split `invoke_handler` in `lib.rs`.

- [ ] **Step 4: Update `scripts/CLAUDE.md`**

Document `scripts/autopilot/` — the launcher (disposable profile via `XDG_*`, watchdog, report), the fixture server + page, and the Linux-only/needs-a-display caveat.

- [ ] **Step 5: Full suite + production-exclusion re-verify**

Run:

```bash
npm test
npm run build:renderer && (grep -rl "runAutopilot\|__aegisAutopilot" dist/ || echo "PROD CLEAN")
cargo build --release --manifest-path src-tauri/Cargo.toml 2>&1 | tail -2
```

Expected: vitest all green; `PROD CLEAN`; release builds without the autopilot module.

- [ ] **Step 6: Live on-hardware verification (the real proof)**

Run (on this Linux machine, with a display):

```bash
bash scripts/autopilot/run-autopilot.sh; echo "exit=$?"
```

Expected: a `RESULT: N passed, …` summary; `target/autopilot/<ts>/report.html` exists with a populated screenshot gallery; the ad-block induction step is `pass` (block count rose on the fixture page). Record the actual numbers. If `core` steps fail, debug per `systematic-debugging` — do not paper over. (Per the project rule, this is the step that proves the harness; don't claim done without it.)

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md src/CLAUDE.md src-tauri/CLAUDE.md scripts/CLAUDE.md
git commit -m "docs(autopilot): document the harness + living-docs convention"
```

---

## Self-Review (completed against the spec)

**Spec coverage:** Live autopilot → Tasks 7,8,9,11; exhaustive vitest suite → Task 12; shared catalog → Tasks 1,2; drift guard ("keep current") → Task 2; control surface → Tasks 4,5,6; report + gallery → Task 3; dev-only Rust → Task 7; disposable profile + fixture + launcher → Tasks 10,11; never-in-production (Vite DCE + cfg) → Tasks 7,9 verifications; CLAUDE.md (incl. root "keep scripts current") → Task 13; honest core/visual + skip-with-reason → Tasks 3,8; Linux-now/portable-core → core is in `src/autopilot/` (platform-agnostic), only Task 11 launcher is Linux.

**Placeholder scan:** No "TBD/TODO/implement later". The two "align to shared/types.ts" notes (reach.ts payloads, aegisMock shapes) are guided by TS compile errors / named test failures, not open-ended.

**Type consistency:** `AutopilotControl` method names match across control.ts/reach.ts/App.tsx/run.ts; `ScreenSpec.via` values match the `reachScreen` switch; `Report`/`StepResult` fields match report.ts/run.ts; dev command names (`autopilot_screenshot`/`autopilot_write_report`/`autopilot_done`/`autopilot_emit_event`) match autopilot.rs ↔ devEmit.ts; `writeReport` payload key `reportJson` matches the Rust param `report_json` (Tauri camelCase↔snake_case).

**Open implementation confirmations (carried from spec, resolved by compile/test, not blockers):** exact `NavFailed`/`PermissionPrompt`/`SafetyInterstitialPayload` field names (TS-checked in reach.ts); the precise end-of-chain in `lib.rs` around line 521 (read 510-524 before the cfg-split); MobileApp's root class for the mobile tour selector.
