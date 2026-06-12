# Aegis Security — Phase 1: Release Pipeline & Tamper Resistance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Aegis a signed-ready auto-update channel (so it tracks Electron's security releases instead of freezing Chromium at build time), plus Electron fuses + ASAR-integrity hardening and packaged-app seed bundling.

**Architecture:** A main-process `UpdateController` wraps electron-updater's `autoUpdater`, pushes an `UpdateState` to the chrome renderer over a new sender-guarded `update.*` IPC namespace, and surfaces a toolbar "Restart to update" indicator. electron-builder publishes Windows + Linux artifacts to GitHub Releases on a `v*` tag (the updater feed); an `afterPack` hook flips security fuses; `extraResources` ships the filter seed inside the packaged app with an `app.isPackaged`-aware load path.

**Tech Stack:** Electron 42.4.0, electron-updater 6.x, @electron/fuses 1.x, electron-builder 26.x, electron-vite, React 19 + TypeScript, Vitest (node + jsdom projects), GitHub Actions.

**Source of truth:** spec at `docs/superpowers/specs/2026-06-12-aegis-security-upgrades-design.md` (this is Phase 1 of 4). Spec §7 open verifications apply.

**Repo conventions:**
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` (omitted from the short messages below for brevity — add it).
- Work happens on branch `feat/security-upgrades` (already created; the spec commit lives there). Do **not** push unless the user asks.
- Run a single test file with `npx vitest run <path>`; the full unit gate with `npm test`; the e2e gate with `npm run build && npm run test:e2e`.
- IPC channel keys are camelCase; values are `domain.action`; events use an `evt`-prefixed key with a `domain.noun` value. Handlers receive invoke args **without** the event (the guard strips it).

**Verification reality (honest):** auto-update cannot be fully exercised in the headless unit/e2e gate (it needs a real published feed + two builds). Tasks 1–12 are fully verifiable locally; the end-to-end update round-trip (Task 13) is verified by cutting a real `v*` tag and watching an installed older build update itself — called out explicitly, not asserted in CI.

---

## File Structure

**Created:**
- `electron/main/update/UpdateController.ts` — wraps `autoUpdater`, owns `UpdateState`, emits state changes.
- `electron/main/update/UpdateController.test.ts` — unit test (node project), fake updater.
- `electron/main/ipc/update.ts` — `buildUpdateHandlers(controller)` IPC map.
- `electron/main/ipc/update.test.ts` — unit test (node project).
- `electron/main/adblock/seedPath.ts` — pure `resolveSeedPath(...)` (dev vs packaged).
- `electron/main/adblock/seedPath.test.ts` — unit test (node project).
- `shared/types.update.test.ts` — guards the new IPC channel constants + `UpdateState` shape.
- `src/hooks/useUpdate.ts` — renderer hook (seed + subscribe to `update.state`).
- `src/hooks/useUpdate.test.tsx` — unit test (dom project).
- `src/components/UpdateIndicator.tsx` — toolbar "Restart to update" button.
- `src/components/UpdateIndicator.test.tsx` — unit test (dom project).
- `build/afterPack.js` — electron-builder afterPack hook flipping fuses.
- `.github/workflows/release.yml` — tag-triggered build + publish (Windows + Linux).

**Modified:**
- `package.json` — version, exact Electron pin, `repository`, deps, `build.publish`, `build.afterPack`, `build.extraResources`.
- `shared/types.ts` — `IPC.update*` constants, `UpdateState` interface, `AegisApi.update`.
- `electron/main/index.ts` — construct `UpdateController`, push state, register handlers, gated check loop, `resolveSeedPath` seed path.
- `electron/preload/chromePreload.ts` — `aegis.update` namespace.
- `src/App.tsx` — `useUpdate()` + `<UpdateIndicator/>` in the toolbar `downloads` slot.
- `.github/workflows/build-windows.yml` — drop the `v*` tag trigger (release.yml owns tags).

---

## Task 1: Pin Electron exact + bump version + add repository

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the app version** (electron-updater compares semver; releases must climb from a real baseline)

In `package.json`, change:
```json
  "version": "0.0.0",
```
to:
```json
  "version": "0.1.0",
```

- [ ] **Step 2: Add a `repository` field** (lets electron-builder/electron-updater resolve the GitHub feed locally, not only in CI)

Change:
```json
  "author": "HappyHobo085",
  "private": true,
```
to:
```json
  "author": "HappyHobo085",
  "repository": {
    "type": "git",
    "url": "https://github.com/HappyHobo085/Aegis.git"
  },
  "private": true,
```

- [ ] **Step 3: Pin Electron exactly** (the `engine-update-policy.md` mandate; also reproducible ABI)

Change:
```json
    "electron": "^42.3.3",
```
to:
```json
    "electron": "42.4.0",
```

- [ ] **Step 4: Reinstall to lock the pin and verify**

Run:
```bash
npm install
node -e "console.log(require('./node_modules/electron/package.json').version)"
```
Expected: prints `42.4.0`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(security): pin Electron 42.4.0, bump app to 0.1.0, add repository"
```

---

## Task 2: Add updater + fuses deps and the GitHub publish config

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install electron-updater (runtime) and @electron/fuses (dev)**

Run:
```bash
npm install electron-updater@^6
npm install -D @electron/fuses@^1
```

- [ ] **Step 2: Verify both resolved**

Run:
```bash
node -e "console.log('updater', require('electron-updater/package.json').version); console.log('fuses', require('@electron/fuses/package.json').version)"
```
Expected: prints an `updater 6.x` line and a `fuses 1.x` line.

- [ ] **Step 3: Add the GitHub publish provider to the electron-builder config**

In `package.json`, change:
```json
    "productName": "Aegis",
    "directories": {
```
to:
```json
    "productName": "Aegis",
    "publish": {
      "provider": "github",
      "owner": "HappyHobo085",
      "repo": "Aegis"
    },
    "directories": {
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(security): add electron-updater + @electron/fuses + github publish"
```

---

## Task 3: Update IPC contract in `shared/types.ts`

**Files:**
- Modify: `shared/types.ts`
- Test: `shared/types.update.test.ts`

- [ ] **Step 1: Write the failing test**

Create `shared/types.update.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { IPC, type UpdateState } from './types';

describe('update IPC contract', () => {
  it('exposes the update channel names', () => {
    expect(IPC.updateGetState).toBe('update.getState');
    expect(IPC.updateCheckNow).toBe('update.checkNow');
    expect(IPC.updateRestartToInstall).toBe('update.restartToInstall');
    expect(IPC.evtUpdateState).toBe('update.state');
  });

  it('UpdateState carries status/version/percent/error', () => {
    const sample: UpdateState = { status: 'downloaded', version: '0.2.0', percent: 100, error: null };
    expect(sample.status).toBe('downloaded');
    expect(sample.percent).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/types.update.test.ts`
Expected: FAIL — `IPC.updateGetState` is `undefined`, so `expect(undefined).toBe('update.getState')` fails.

- [ ] **Step 3: Add the IPC channel constants**

In `shared/types.ts`, change:
```ts
  evtDownloadsChanged: 'downloads.changed',
  evtPermissionsPrompt: 'permissions.prompt',
} as const;
```
to:
```ts
  evtDownloadsChanged: 'downloads.changed',
  evtPermissionsPrompt: 'permissions.prompt',
  // auto-update (Phase S1, chrome <-> main)
  updateGetState: 'update.getState',
  updateCheckNow: 'update.checkNow',
  updateRestartToInstall: 'update.restartToInstall',
  evtUpdateState: 'update.state',
} as const;
```

- [ ] **Step 4: Add the `UpdateState` interface**

In `shared/types.ts`, change:
```ts
export interface ListUpdateResult {
  perSource: ListSourceResult[];
  lastUpdated: number; // epoch ms of this refresh attempt
}
```
to:
```ts
export interface ListUpdateResult {
  perSource: ListSourceResult[];
  lastUpdated: number; // epoch ms of this refresh attempt
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version: string | null; // available/downloaded version, else null
  percent: number; // download progress 0..100
  error: string | null; // last error message, else null
}
```

- [ ] **Step 5: Add the `update` namespace to `AegisApi`**

In `shared/types.ts`, change:
```ts
  picker: {
    start(): Promise<{ ok: boolean; rule?: string }>;
  };
}
```
to:
```ts
  picker: {
    start(): Promise<{ ok: boolean; rule?: string }>;
  };
  update: {
    getState(): Promise<UpdateState>;
    checkNow(): Promise<void>;
    restartToInstall(): Promise<void>;
    onState(cb: (s: UpdateState) => void): () => void;
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run shared/types.update.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add shared/types.ts shared/types.update.test.ts
git commit -m "feat(update): add update IPC contract + UpdateState type"
```

---

## Task 4: `UpdateController`

**Files:**
- Create: `electron/main/update/UpdateController.ts`
- Test: `electron/main/update/UpdateController.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/main/update/UpdateController.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { UpdateController, type UpdaterLike } from './UpdateController';
import type { UpdateState } from '../../../shared/types';

function makeFakeUpdater() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on(event: string, listener: (...args: any[]) => void) {
      handlers[event] = listener;
    },
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  };
  const emit = (event: string, ...args: any[]): void => handlers[event]?.(...args);
  return { updater, emit };
}

describe('UpdateController', () => {
  it('starts idle and enables autoDownload + autoInstallOnAppQuit', () => {
    const { updater } = makeFakeUpdater();
    const c = new UpdateController({ updater, onState: () => {} });
    expect(c.getState()).toEqual({ status: 'idle', version: null, percent: 0, error: null });
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('transitions checking -> available -> downloading -> downloaded and pushes each', () => {
    const { updater, emit } = makeFakeUpdater();
    const states: UpdateState[] = [];
    const c = new UpdateController({ updater, onState: (s) => states.push(s) });
    emit('checking-for-update');
    expect(c.getState().status).toBe('checking');
    emit('update-available', { version: '0.2.0' });
    expect(c.getState()).toMatchObject({ status: 'available', version: '0.2.0' });
    emit('download-progress', { percent: 42.7 });
    expect(c.getState()).toMatchObject({ status: 'downloading', percent: 43 });
    emit('update-downloaded', { version: '0.2.0' });
    expect(c.getState()).toMatchObject({ status: 'downloaded', version: '0.2.0', percent: 100 });
    expect(states).toHaveLength(4);
  });

  it('captures errors', () => {
    const { updater, emit } = makeFakeUpdater();
    const c = new UpdateController({ updater, onState: () => {} });
    emit('error', new Error('feed unreachable'));
    expect(c.getState()).toMatchObject({ status: 'error', error: 'feed unreachable' });
  });

  it('checkNow swallows a rejected check into error state', async () => {
    const { updater } = makeFakeUpdater();
    (updater.checkForUpdates as any).mockRejectedValueOnce(new Error('no network'));
    const c = new UpdateController({ updater, onState: () => {} });
    await c.checkNow();
    expect(c.getState()).toMatchObject({ status: 'error', error: 'no network' });
  });

  it('restartToInstall calls quitAndInstall', () => {
    const { updater } = makeFakeUpdater();
    const c = new UpdateController({ updater, onState: () => {} });
    c.restartToInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/update/UpdateController.test.ts`
Expected: FAIL — `Cannot find module './UpdateController'`.

- [ ] **Step 3: Write the implementation**

Create `electron/main/update/UpdateController.ts`:
```ts
// electron/main/update/UpdateController.ts
import type { UpdateState } from '../../../shared/types';

/**
 * The slice of electron-updater's `autoUpdater` this controller depends on.
 * Declared locally so the controller is unit-testable in the node project
 * WITHOUT importing electron-updater (which pulls in electron).
 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateControllerOpts {
  updater: UpdaterLike;
  onState: (state: UpdateState) => void;
}

const INITIAL: UpdateState = { status: 'idle', version: null, percent: 0, error: null };

/**
 * Owns the auto-update lifecycle: wires autoUpdater events into an UpdateState,
 * pushes each change via onState (the boot layer forwards it to the chrome
 * renderer). autoDownload is on so an available update fetches in the background;
 * autoInstallOnAppQuit is on so a downloaded update lands on the next quit even
 * if the user never clicks "restart".
 */
export class UpdateController {
  private state: UpdateState = { ...INITIAL };
  private readonly updater: UpdaterLike;
  private readonly emit: (state: UpdateState) => void;

  constructor(opts: UpdateControllerOpts) {
    this.updater = opts.updater;
    this.emit = opts.onState;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.wire();
  }

  private set(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial };
    this.emit(this.state);
  }

  private wire(): void {
    this.updater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    this.updater.on('update-available', (info: { version?: string }) =>
      this.set({ status: 'available', version: info?.version ?? null }),
    );
    this.updater.on('update-not-available', () => this.set({ status: 'not-available' }));
    this.updater.on('download-progress', (p: { percent?: number }) =>
      this.set({ status: 'downloading', percent: Math.round(p?.percent ?? 0) }),
    );
    this.updater.on('update-downloaded', (info: { version?: string }) =>
      this.set({ status: 'downloaded', version: info?.version ?? null, percent: 100 }),
    );
    this.updater.on('error', (err: Error) =>
      this.set({ status: 'error', error: err?.message ?? String(err) }),
    );
  }

  getState(): UpdateState {
    return this.state;
  }

  async checkNow(): Promise<void> {
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  restartToInstall(): void {
    this.updater.quitAndInstall();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/main/update/UpdateController.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/update/UpdateController.ts electron/main/update/UpdateController.test.ts
git commit -m "feat(update): add UpdateController wrapping autoUpdater"
```

---

## Task 5: `buildUpdateHandlers` IPC map

**Files:**
- Create: `electron/main/ipc/update.ts`
- Test: `electron/main/ipc/update.test.ts`

- [ ] **Step 1: Write the failing test**

Create `electron/main/ipc/update.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildUpdateHandlers } from './update';
import { IPC, type UpdateState } from '../../../shared/types';

const state: UpdateState = { status: 'idle', version: null, percent: 0, error: null };

function fakeController() {
  return {
    getState: vi.fn(() => state),
    checkNow: vi.fn(async () => {}),
    restartToInstall: vi.fn(() => {}),
  };
}

describe('buildUpdateHandlers', () => {
  it('maps update.getState to controller.getState', () => {
    const c = fakeController();
    const h = buildUpdateHandlers(c);
    expect(h[IPC.updateGetState]()).toBe(state);
    expect(c.getState).toHaveBeenCalledOnce();
  });

  it('maps update.checkNow to controller.checkNow', async () => {
    const c = fakeController();
    const h = buildUpdateHandlers(c);
    await h[IPC.updateCheckNow]();
    expect(c.checkNow).toHaveBeenCalledOnce();
  });

  it('maps update.restartToInstall to controller.restartToInstall', () => {
    const c = fakeController();
    const h = buildUpdateHandlers(c);
    h[IPC.updateRestartToInstall]();
    expect(c.restartToInstall).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/ipc/update.test.ts`
Expected: FAIL — `Cannot find module './update'`.

- [ ] **Step 3: Write the implementation**

Create `electron/main/ipc/update.ts`:
```ts
// electron/main/ipc/update.ts
import { IPC } from '../../../shared/types';
import type { UpdateState } from '../../../shared/types';
import type { UpdateController } from '../update/UpdateController';

/**
 * Builds the update IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). Typed against the slice of
 * UpdateController the IPC surface needs.
 */
export function buildUpdateHandlers(
  controller: Pick<UpdateController, 'getState' | 'checkNow' | 'restartToInstall'>,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.updateGetState]: (): UpdateState => controller.getState(),
    [IPC.updateCheckNow]: (): Promise<void> => controller.checkNow(),
    [IPC.updateRestartToInstall]: (): void => controller.restartToInstall(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/main/ipc/update.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add electron/main/ipc/update.ts electron/main/ipc/update.test.ts
git commit -m "feat(update): add buildUpdateHandlers IPC map"
```

---

## Task 6: Wire `UpdateController` + handlers into `boot()`

**Files:**
- Modify: `electron/main/index.ts`

> Integration wiring at the composition root (no unit test; `index.ts` has none). Verified by `npm run build`. The end-to-end update path is verified in Task 13.

- [ ] **Step 1: Add the imports** (place with the other top-of-file imports in `electron/main/index.ts`)

```ts
import { autoUpdater } from 'electron-updater';
import { UpdateController, type UpdaterLike } from './update/UpdateController';
import { buildUpdateHandlers } from './ipc/update';
```

- [ ] **Step 2: Add the check-interval constant**

Change:
```ts
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
```
to:
```ts
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
```

- [ ] **Step 3: Construct the controller right after the chrome WebContents is available**

Change:
```ts
  const { win, chromeView } = createMainWindow();
  const chromeWc = chromeView.webContents;
```
to:
```ts
  const { win, chromeView } = createMainWindow();
  const chromeWc = chromeView.webContents;

  // Auto-update: wrap electron-updater's autoUpdater; push state to chrome.
  const updateController = new UpdateController({
    updater: autoUpdater as unknown as UpdaterLike,
    onState: (s) => chromeWc.send(IPC.evtUpdateState, s),
  });
```

- [ ] **Step 4: Register the update handlers** (add to the `registerGuardedHandlers` map)

Change:
```ts
    ...buildListsHandlers(updateNow),
```
to:
```ts
    ...buildListsHandlers(updateNow),
    ...buildUpdateHandlers(updateController),
```

- [ ] **Step 5: Start the gated check loop** (packaged builds only — electron-updater errors in dev without a feed)

Change:
```ts
  scheduler.start();
```
to:
```ts
  scheduler.start();

  // Auto-update checks run in packaged builds only (no feed in dev/e2e).
  if (app.isPackaged) {
    void updateController.checkNow();
    const updateTimer = setInterval(() => void updateController.checkNow(), UPDATE_CHECK_INTERVAL_MS);
    win.on('closed', () => clearInterval(updateTimer));
  }
```

- [ ] **Step 6: Verify the main bundle builds**

Run: `npm run build`
Expected: builds with no TypeScript errors; `out/main/index.js` is produced.

- [ ] **Step 7: Verify no unit regressions**

Run: `npm test`
Expected: the full unit suite passes (baseline + the new update tests).

- [ ] **Step 8: Commit**

```bash
git add electron/main/index.ts
git commit -m "feat(update): wire UpdateController, handlers, and gated check loop into boot"
```

---

## Task 7: Expose `aegis.update` in the chrome preload

**Files:**
- Modify: `electron/preload/chromePreload.ts`

> Thin contextBridge pass-through (the existing preload has no unit test); verified by `npm run build` and exercised end-to-end by the renderer hook test (Task 8) against a mock.

- [ ] **Step 1: Import the `UpdateState` type**

Change:
```ts
  DownloadEntry, SitePermission, PermissionPrompt, ImportMode,
} from '../../shared/types';
```
to:
```ts
  DownloadEntry, SitePermission, PermissionPrompt, ImportMode, UpdateState,
} from '../../shared/types';
```

- [ ] **Step 2: Add the `update` namespace to the `api` object**

Change:
```ts
  picker: {
    start: (): Promise<{ ok: boolean; rule?: string }> => ipcRenderer.invoke(IPC.pickerStart),
  },
};
```
to:
```ts
  picker: {
    start: (): Promise<{ ok: boolean; rule?: string }> => ipcRenderer.invoke(IPC.pickerStart),
  },
  update: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateGetState),
    checkNow: (): Promise<void> => ipcRenderer.invoke(IPC.updateCheckNow),
    restartToInstall: (): Promise<void> => ipcRenderer.invoke(IPC.updateRestartToInstall),
    onState: (cb: (s: UpdateState) => void) => subscribe<UpdateState>(IPC.evtUpdateState, cb),
  },
};
```

- [ ] **Step 3: Verify the preload builds**

Run: `npm run build`
Expected: builds clean; `out/preload/chromePreload.js` is produced.

- [ ] **Step 4: Commit**

```bash
git add electron/preload/chromePreload.ts
git commit -m "feat(update): expose aegis.update namespace in chrome preload"
```

---

## Task 8: `useUpdate` renderer hook

**Files:**
- Create: `src/hooks/useUpdate.ts`
- Test: `src/hooks/useUpdate.test.tsx`

- [ ] **Step 1: Write the failing test** (mirrors the `useDownloads.test.tsx` mock pattern: `vi.mock('../lib/ipcClient', …)` with module-scope `vi.fn()`s, hook import AFTER the mock, event simulated by capturing the subscriber callback)

Create `src/hooks/useUpdate.test.tsx`:
```tsx
// src/hooks/useUpdate.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { UpdateState } from '../../shared/types';

const getState = vi.fn();
const checkNow = vi.fn();
const restartToInstall = vi.fn();
const onState = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    update: {
      getState: (...a: any[]) => getState(...a),
      checkNow: (...a: any[]) => checkNow(...a),
      restartToInstall: (...a: any[]) => restartToInstall(...a),
      onState: (cb: (s: UpdateState) => void) => onState(cb),
    },
  },
}));

import { useUpdate } from './useUpdate';

const st = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle', version: null, percent: 0, error: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(st());
  checkNow.mockResolvedValue(undefined);
  restartToInstall.mockResolvedValue(undefined);
  onState.mockReturnValue(() => {});
});

describe('useUpdate', () => {
  it('seeds state from aegis.update.getState on mount', async () => {
    getState.mockResolvedValue(st({ status: 'available', version: '0.2.0' }));
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.state.status).toBe('available'));
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('updates state when an onState event fires', async () => {
    let pushed: ((s: UpdateState) => void) | undefined;
    onState.mockImplementation((cb: (s: UpdateState) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => expect(result.current.state.status).toBe('idle'));
    await act(async () => {
      pushed!(st({ status: 'downloaded', version: '0.3.0', percent: 100 }));
    });
    expect(result.current.state).toMatchObject({ status: 'downloaded', version: '0.3.0' });
  });

  it('restartToInstall() delegates to aegis.update.restartToInstall', async () => {
    const { result } = renderHook(() => useUpdate());
    await act(async () => {
      await result.current.restartToInstall();
    });
    expect(restartToInstall).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes on unmount', async () => {
    const unsubscribe = vi.fn();
    onState.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useUpdate());
    await waitFor(() => expect(onState).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/hooks/useUpdate.test.tsx`
Expected: FAIL — `Cannot find module './useUpdate'`.

- [ ] **Step 3: Write the implementation** (typed-payload subscribe, like `nav.onState` — set state straight from the event)

Create `src/hooks/useUpdate.ts`:
```ts
// src/hooks/useUpdate.ts
import { useCallback, useEffect, useState } from 'react';
import type { UpdateState } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const IDLE: UpdateState = { status: 'idle', version: null, percent: 0, error: null };

export function useUpdate(): {
  state: UpdateState;
  checkNow(): Promise<void>;
  restartToInstall(): Promise<void>;
} {
  const [state, setState] = useState<UpdateState>(IDLE);

  useEffect(() => {
    let active = true;
    void aegis.update.getState().then((s) => {
      if (active) setState(s);
    });
    const unsubscribe = aegis.update.onState((s) => {
      setState(s);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const checkNow = useCallback((): Promise<void> => aegis.update.checkNow(), []);
  const restartToInstall = useCallback((): Promise<void> => aegis.update.restartToInstall(), []);

  return { state, checkNow, restartToInstall };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/hooks/useUpdate.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useUpdate.ts src/hooks/useUpdate.test.tsx
git commit -m "feat(update): add useUpdate renderer hook"
```

---

## Task 9: `UpdateIndicator` toolbar button

**Files:**
- Create: `src/components/UpdateIndicator.tsx`
- Test: `src/components/UpdateIndicator.test.tsx`

> Mirrors `DownloadsIndicator` (lucide icon, `toolbar__*` class, `aria-label`/`title`, conditional `null`). Renders only once an update is downloaded.

- [ ] **Step 1: Write the failing test**

Create `src/components/UpdateIndicator.test.tsx`:
```tsx
// src/components/UpdateIndicator.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateIndicator } from './UpdateIndicator';
import type { UpdateState } from '../../shared/types';

const st = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle', version: null, percent: 0, error: null, ...over,
});

describe('UpdateIndicator', () => {
  it('renders nothing until an update is downloaded', () => {
    render(<UpdateIndicator state={st({ status: 'available', version: '0.2.0' })} onRestart={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a restart button once an update is downloaded', () => {
    render(<UpdateIndicator state={st({ status: 'downloaded', version: '0.2.0' })} onRestart={vi.fn()} />);
    expect(screen.getByRole('button', { name: /restart to update to 0\.2\.0/i })).toBeInTheDocument();
  });

  it('calls onRestart when clicked', async () => {
    const onRestart = vi.fn();
    render(<UpdateIndicator state={st({ status: 'downloaded', version: '0.2.0' })} onRestart={onRestart} />);
    await userEvent.click(screen.getByRole('button', { name: /restart to update/i }));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/UpdateIndicator.test.tsx`
Expected: FAIL — `Cannot find module './UpdateIndicator'`.

- [ ] **Step 3: Write the implementation**

Create `src/components/UpdateIndicator.tsx`:
```tsx
// src/components/UpdateIndicator.tsx
import { RefreshCw } from 'lucide-react';
import type { UpdateState } from '../../shared/types';

export interface UpdateIndicatorProps {
  state: UpdateState;
  /** Quit and install the downloaded update. */
  onRestart(): void;
}

export function UpdateIndicator({ state, onRestart }: UpdateIndicatorProps) {
  if (state.status !== 'downloaded') {
    return null;
  }
  const label = state.version ? `Restart to update to ${state.version}` : 'Restart to update';
  return (
    <button
      type="button"
      className="toolbar__update"
      aria-label={label}
      title={label}
      onClick={onRestart}
    >
      <RefreshCw size={18} aria-hidden="true" />
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/UpdateIndicator.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/UpdateIndicator.tsx src/components/UpdateIndicator.test.tsx
git commit -m "feat(update): add UpdateIndicator toolbar button"
```

---

## Task 10: Mount the indicator in `App.tsx`

**Files:**
- Modify: `src/App.tsx`

> Integration wiring; verified by `npm run build` + the Task 9 component test. The indicator goes into the existing `downloads` toolbar slot fragment, so it is always visible (no `chromeOverlayActive` change needed).

- [ ] **Step 1: Add the imports** (with the other component/hook imports at the top of `src/App.tsx`)

```tsx
import { useUpdate } from './hooks/useUpdate';
import { UpdateIndicator } from './components/UpdateIndicator';
```

- [ ] **Step 2: Call the hook** (add immediately after the `fullscreen` state line)

Change:
```tsx
  const [fullscreen, setFullscreen] = useState(false);
```
to:
```tsx
  const [fullscreen, setFullscreen] = useState(false);
  const update = useUpdate();
```

- [ ] **Step 3: Render the indicator in the toolbar `downloads` slot**

Change:
```tsx
        downloads={
          <>
            <PickerButton />
            <DownloadsIndicator
              activeCount={activeDownloads}
              onOpen={() => setDownloadsOpen(true)}
            />
          </>
        }
```
to:
```tsx
        downloads={
          <>
            <UpdateIndicator state={update.state} onRestart={() => void update.restartToInstall()} />
            <PickerButton />
            <DownloadsIndicator
              activeCount={activeDownloads}
              onOpen={() => setDownloadsOpen(true)}
            />
          </>
        }
```

- [ ] **Step 4: Verify build + full unit suite**

Run: `npm run build && npm test`
Expected: build clean; all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(update): surface UpdateIndicator in the toolbar"
```

---

## Task 11: Electron security fuses via `afterPack`

**Files:**
- Create: `build/afterPack.js`
- Modify: `package.json`

> Integration-verified (fuses are flipped on a real packed binary). On Linux the ASAR-integrity fuse is left OFF (unsupported on this Electron version's Linux build — spec §7).

- [ ] **Step 1: Write the afterPack hook**

Create `build/afterPack.js`:
```js
// build/afterPack.js
// electron-builder afterPack hook — flips Electron security "fuses" on the packed
// binary BEFORE signing. Hardens the runtime: no RunAsNode, no Node CLI inspect,
// no NODE_OPTIONS, only load the app from asar, encrypt cookies, and (Windows/
// macOS only) validate embedded asar integrity. Runs for every builder target.
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const executableName = packager.executableName || packager.appInfo.productFilename;

  let binaryPath;
  if (electronPlatformName === 'darwin') {
    binaryPath = path.join(appOutDir, `${executableName}.app`, 'Contents', 'MacOS', executableName);
  } else if (electronPlatformName === 'win32') {
    binaryPath = path.join(appOutDir, `${executableName}.exe`);
  } else {
    binaryPath = path.join(appOutDir, executableName);
  }

  await flipFuses(binaryPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
    // asar-integrity validation is supported on Windows/macOS but NOT Linux on
    // this Electron version; electron-builder injects the header hash when on.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: electronPlatformName !== 'linux',
  });

  // eslint-disable-next-line no-console
  console.log(`[afterPack] flipped security fuses on ${binaryPath}`);
};
```

- [ ] **Step 2: Register the hook in electron-builder**

In `package.json`, change:
```json
    "npmRebuild": false,
```
to:
```json
    "npmRebuild": false,
    "afterPack": "build/afterPack.js",
```

- [ ] **Step 3: Produce an unpacked build (runs afterPack without packaging an installer)**

Run:
```bash
npm run build
npx electron-builder --linux dir
```
Expected: ends with `[afterPack] flipped security fuses on …/release/linux-unpacked/<exe>` in the log.

- [ ] **Step 4: Read back the fuses on the packed binary to verify**

Run (use the actual executable name found in `release/linux-unpacked/`):
```bash
ls release/linux-unpacked/
npx @electron/fuses read --app release/linux-unpacked/aegis
```
Expected: `RunAsNode` is `Disabled`, `EnableNodeCliInspectArguments` `Disabled`, `EnableNodeOptionsEnvironmentVariable` `Disabled`, `OnlyLoadAppFromAsar` `Enabled`, `EnableCookieEncryption` `Enabled` (asar-integrity Disabled on Linux, as designed).

- [ ] **Step 5: Confirm the app still launches with fuses flipped** (sanity — `OnlyLoadAppFromAsar` can break a misconfigured pack)

Run:
```bash
./release/linux-unpacked/aegis --version || echo "launch check: inspect output above"
```
Expected: the app process starts (a window may open; close it). If it crashes with an asar-load error, the pack is misconfigured — stop and investigate before committing.

- [ ] **Step 6: Commit**

```bash
git add build/afterPack.js package.json
git commit -m "build(security): flip Electron fuses + asar integrity via afterPack"
```

---

## Task 12: Bundle the filter seed as `extraResources` with a packaged-aware load path

**Files:**
- Create: `electron/main/adblock/seedPath.ts`
- Test: `electron/main/adblock/seedPath.test.ts`
- Modify: `package.json`, `electron/main/index.ts`

> Today the seed resolves only via `join(__dirname, …)`, which lands INSIDE the asar when packaged and silently degrades first-run blocking to an empty engine. This ships the seed at `process.resourcesPath` and branches the load path on `app.isPackaged`.

- [ ] **Step 1: Write the failing test**

Create `electron/main/adblock/seedPath.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveSeedPath } from './seedPath';

describe('resolveSeedPath', () => {
  it('uses the __dirname-relative path in dev/e2e (not packaged)', () => {
    const p = resolveSeedPath({ isPackaged: false, mainDir: '/app/out/main', resourcesPath: '/ignored' });
    expect(p).toBe(join('/app/out/main', 'adblock/seed/engine-seed.bin'));
  });

  it('uses process.resourcesPath in a packaged app', () => {
    const p = resolveSeedPath({ isPackaged: true, mainDir: '/ignored', resourcesPath: '/opt/Aegis/resources' });
    expect(p).toBe(join('/opt/Aegis/resources', 'engine-seed.bin'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/main/adblock/seedPath.test.ts`
Expected: FAIL — `Cannot find module './seedPath'`.

- [ ] **Step 3: Write the implementation**

Create `electron/main/adblock/seedPath.ts`:
```ts
// electron/main/adblock/seedPath.ts
import { join } from 'node:path';

/**
 * Resolve the bundled filter-seed blob at runtime.
 * - Packaged: shipped via electron-builder `extraResources` → `process.resourcesPath/engine-seed.bin`.
 * - Dev/e2e: the `aegis-copy-seed` Vite plugin copies it next to the main bundle,
 *   so it's `out/main/adblock/seed/engine-seed.bin` (mainDir = __dirname).
 */
export function resolveSeedPath(opts: {
  isPackaged: boolean;
  mainDir: string;
  resourcesPath: string;
}): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, 'engine-seed.bin')
    : join(opts.mainDir, 'adblock/seed/engine-seed.bin');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/main/adblock/seedPath.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Use it in `boot()`** — add the import with the other top-of-file imports in `electron/main/index.ts`:

```ts
import { resolveSeedPath } from './adblock/seedPath';
```

Then change:
```ts
  const snapshotPath = join(__dirname, 'adblock/seed/engine-seed.bin');
```
to:
```ts
  const snapshotPath = resolveSeedPath({
    isPackaged: app.isPackaged,
    mainDir: __dirname,
    resourcesPath: process.resourcesPath,
  });
```

- [ ] **Step 6: Declare the seed as an extra resource** in `package.json` — change:
```json
    "asarUnpack": [
      "**/node_modules/better-sqlite3/**",
      "**/node_modules/bindings/**",
      "**/node_modules/file-uri-to-path/**",
      "**/node_modules/@ghostery/**"
    ],
```
to:
```json
    "asarUnpack": [
      "**/node_modules/better-sqlite3/**",
      "**/node_modules/bindings/**",
      "**/node_modules/file-uri-to-path/**",
      "**/node_modules/@ghostery/**"
    ],
    "extraResources": [
      {
        "from": "electron/main/adblock/seed/engine-seed.bin",
        "to": "engine-seed.bin"
      }
    ],
```

- [ ] **Step 7: Verify the seed lands in the packaged resources**

Run:
```bash
npm run generate-seed   # ensure the source blob exists (skip if already present)
npm run build
npx electron-builder --linux dir
ls -la release/linux-unpacked/resources/engine-seed.bin
```
Expected: `engine-seed.bin` exists under `release/linux-unpacked/resources/` (multi-MB). This is the path `process.resourcesPath` resolves to at runtime.

- [ ] **Step 8: Verify build + unit suite**

Run: `npm run build && npm test`
Expected: build clean; all unit tests pass.

- [ ] **Step 9: Commit**

```bash
git add electron/main/adblock/seedPath.ts electron/main/adblock/seedPath.test.ts electron/main/index.ts package.json
git commit -m "build(security): bundle filter seed via extraResources + packaged-aware load path"
```

---

## Task 13: Release CI — publish to GitHub Releases on a tag

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/build-windows.yml`

> The existing `build-windows.yml` stays a per-push artifact CI check; a new `release.yml` owns `v*` tags and publishes the updater feed for both OSes. Verified by actually cutting a tag (the only true end-to-end auto-update check).

- [ ] **Step 1: Stop `build-windows.yml` from also firing on tags** (so a tag doesn't double-build Windows). Change:
```yaml
on:
  workflow_dispatch: {}
  push:
    branches:
      - main
    tags:
      - 'v*'
```
to:
```yaml
on:
  workflow_dispatch: {}
  push:
    branches:
      - main
```

- [ ] **Step 2: Write the release workflow**

Create `.github/workflows/release.yml`:
```yaml
name: Release

# On a version tag (v*), build Aegis for Windows + Linux and publish the
# signed-ready installers to a GitHub Release — the electron-updater feed.
# Windows code-signing runs automatically IF the WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD
# secrets are present; otherwise the build publishes UNSIGNED but SHA512-verified
# over HTTPS (electron-updater checks the hash from latest.yml).
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch: {}

permissions:
  contents: write

jobs:
  release-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - name: Package + publish Windows installer
        run: npx electron-builder --win nsis portable --publish onTagOrDraft
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # Signing-ready: absent today → electron-builder skips signing. Add these
          # repo secrets later to sign without any further code change.
          WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}
          WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}

  release-linux:
    runs-on: ubuntu-latest
    needs: release-windows
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm run build
      - name: Package + publish Linux AppImage
        run: npx electron-builder --linux AppImage --publish onTagOrDraft
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 3: Lint the YAML locally** (syntax check before relying on CI)

Run:
```bash
node -e "const fs=require('fs'); for (const f of ['.github/workflows/release.yml','.github/workflows/build-windows.yml']) { const s=fs.readFileSync(f,'utf8'); if(!/jobs:/.test(s)) throw new Error('no jobs in '+f); console.log('ok', f); }"
```
Expected: prints `ok` for both files. (Optional, if installed: `npx yaml-lint .github/workflows/release.yml`.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/build-windows.yml
git commit -m "ci(security): publish Windows+Linux updater feed to GitHub Releases on v* tag"
```

- [ ] **Step 5: End-to-end auto-update verification** (MANUAL — cannot run in the unit/e2e gate)

This is the real proof the cadence gap is closed. Do it once after merge, with the user's go-ahead to push + tag:
1. Ensure `version` is `0.1.0`; push the branch and tag: `git tag v0.1.0 && git push origin v0.1.0`.
2. Confirm the `Release` workflow publishes a GitHub Release `v0.1.0` containing the installers + `latest.yml` + `latest-linux.yml`.
3. Install the `0.1.0` build locally.
4. Bump `version` to `0.2.0`, tag `v0.2.0`, let CI publish.
5. Launch the installed `0.1.0` app; within the check interval the `UpdateIndicator` appears ("Restart to update to 0.2.0"); click it and confirm it relaunches as `0.2.0`.

Expected: the installed older build updates itself from the GitHub Releases feed. Record the result (this is the spec §6 Phase-1 success criterion).

---

## Self-Review (completed by the plan author)

**Spec coverage (Phase-1 items from the spec §3.1):**
- Pin Electron exact + version bump → Task 1. ✅
- electron-updater + GitHub Releases feed + autoUpdater + `aegis.update.*` IPC + chrome indicator → Tasks 2–10. ✅
- Electron fuses + ASAR integrity (afterPack, Linux-integrity caveat) → Task 11. ✅
- Seed `extraResources` + packaged-aware load path → Task 12. ✅
- CI publish-on-tag + Linux publish job + signing-ready conditional step → Task 13. ✅

**Type consistency:** `UpdateState` (status/version/percent/error) is defined once in `shared/types.ts` (Task 3) and used identically in `UpdateController`, `buildUpdateHandlers`, the preload, `useUpdate`, and `UpdateIndicator`. IPC keys `updateGetState`/`updateCheckNow`/`updateRestartToInstall`/`evtUpdateState` are referenced by the exact same names in Tasks 3, 5, 6, 7. `UpdaterLike` is defined in Task 4 and reused (via cast) in Task 6.

**Placeholder scan:** no TBD/TODO; every code step shows complete code; commands have expected output. The only deliberately-manual step is Task 13 Step 5 (auto-update round-trip), explicitly flagged as un-gateable headless.

**Known caveats carried from spec §7:** ASAR-integrity is Linux-OFF (verify if a future Electron adds Linux support); signing stays off until `WIN_CSC_*` secrets exist; AppImage auto-update needs a writable app path.

---

## After Phase 1

Phases 2–4 are separate plan files (to be written next), each independently shippable:
- **Phase 2** — supply-chain hygiene & currency (Dependabot, Electron-behind CI, `npm audit`, SECURITY.md).
- **Phase 3** — network & malicious-site protections (HTTPS-Only top-level + interstitial, malware blocklist + interstitial; shared overlay registered in `chromeOverlayActive`).
- **Phase 4** — fingerprint/leak hardening & config cleanup (WebRTC IP policy, Chrome-like UA, download-dir validation).
