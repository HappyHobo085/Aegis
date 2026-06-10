import { app, dialog } from 'electron';
import { join } from 'node:path';
import type { NavState, ListUpdateResult, BlockedCount } from '../../shared/types';
import { IPC } from '../../shared/types';
import { createMainWindow, layout } from './window';
import { ViewController } from './viewController';
import { openDb, runMigrations } from './db/sqlite';
import { SettingsRepo } from './db/settingsRepo';
import { AdblockRepo } from './db/adblockRepo';
import { SubsRepo } from './db/subsRepo';
import { readLastSession, writeLastSession } from './session';
import { registerGuardedHandlers } from './ipc/guard';
import { buildNavHandlers, buildViewEventForwarders } from './ipc/nav';
import { buildSettingsHandlers } from './ipc/settings';
import { buildAdblockHandlers } from './ipc/adblock';
import { buildListsHandlers } from './ipc/lists';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import {
  buildEngine,
  loadCachedEngine,
  loadSnapshotEngine,
  serializeEngine,
  DEFAULT_LIST_URLS,
  RESOURCES_URL,
} from './adblock/engine';
import { fetchAll, RefreshScheduler } from './adblock/listManager';
import { BlockedCounter } from './adblock/blockedCounter';
import { AdblockController } from './adblock/controller';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 16 * 1024 * 1024;

/** Resolve the data dir: AEGIS_USER_DATA override (e2e isolation) or app userData. */
function resolveUserData(): string {
  return process.env.AEGIS_USER_DATA ?? app.getPath('userData');
}

function boot(): void {
  const userData = resolveUserData();

  // Persistence: DB + migrations + repos.
  const db = openDb(join(userData, 'aegis.db'));
  runMigrations(db);
  const settingsRepo = new SettingsRepo(db);
  const adblockRepo = new AdblockRepo(db);
  const subsRepo = new SubsRepo(db);
  subsRepo.seedDefaults(DEFAULT_LIST_URLS);

  // Window + chrome (window.ts owns the BaseWindow + chromeView ONLY).
  const { win, chromeView } = createMainWindow();
  const chromeWc = chromeView.webContents;

  // Main->chrome event forwarders.
  const fwd = buildViewEventForwarders(chromeWc);

  // onState wrapper: forward to chrome AND persist last session when the URL changes.
  let lastPersistedUrl: string | null = null;
  const onState = (s: NavState): void => {
    fwd.onState(s);
    if (s.url && s.url !== lastPersistedUrl) {
      lastPersistedUrl = s.url;
      writeLastSession(userData, { url: s.url, title: s.title });
    }
  };

  // The ONE content view is owned by ViewController.
  const contentPreloadPath = join(__dirname, '../preload/contentPreload.js');
  const vc = new ViewController({
    contentPreloadPath,
    onState,
    onFailed: fwd.onFailed,
    onCrashed: fwd.onCrashed,
  });

  // Compose: chrome added first by window.ts; index.ts adds the content view over it.
  win.contentView.addChildView(vc.view);
  layout(win, chromeView, vc.view);
  win.on('resize', () => layout(win, chromeView, vc.view));

  // ---- Adblock subsystem (after ViewController, BEFORE the first navigate) ----
  const cachePath = join(userData, 'engine.bin');
  const snapshotPath = join(__dirname, 'adblock/seed/engine-seed.bin');
  const listsCacheDir = join(userData, 'lists');

  // E2E determinism hooks.
  const TEST_FILTER = process.env.AEGIS_ADBLOCK_TEST_FILTER;
  const OFFLINE = process.env.AEGIS_ADBLOCK_OFFLINE === '1';
  const LIST_BASE = process.env.AEGIS_ADBLOCK_LIST_BASE;

  // Initial engine: deterministic test filter (e2e) | user cache | bundled snapshot | empty.
  // Track the source so e2e can assert first-run-on-seed deterministically (§8.4/§8.7).
  let initialBlocker: ElectronBlocker;
  let engineSource: 'filter' | 'cache' | 'snapshot' | 'built';
  if (TEST_FILTER) {
    initialBlocker = buildEngine([TEST_FILTER], null);
    engineSource = 'filter';
  } else {
    const cached = loadCachedEngine(cachePath);
    const snapshot = cached ? null : loadSnapshotEngine(snapshotPath);
    if (cached) {
      initialBlocker = cached;
      engineSource = 'cache';
    } else if (snapshot) {
      initialBlocker = snapshot;
      engineSource = 'snapshot';
    } else {
      initialBlocker = buildEngine([], null);
      engineSource = 'built';
    }
  }

  const counter = new BlockedCounter(vc.id);
  const onBlockedCount = (c: BlockedCount): void => chromeWc.send(IPC.evtAdblockBlockedCount, c);
  const controller = new AdblockController({
    viewId: vc.id,
    session: vc.contentSession,
    contentWc: vc.contentWebContents,
    repo: adblockRepo,
    blocker: initialBlocker,
    counter,
    onBlockedCount,
  });

  // Privileged IPC, sender-validated against the chrome WebContents id.
  // updateNow is the ONE canonical refresh (never triggerNow) — defined below.
  const refreshFetch = OFFLINE ? () => Promise.reject(new Error('offline')) : globalThis.fetch;
  const refreshSubs = LIST_BASE
    ? DEFAULT_LIST_URLS.map((s) => ({ listId: s.listId, url: `${LIST_BASE}/${s.listId}.txt` }))
    : DEFAULT_LIST_URLS;
  const refreshResourcesUrl = LIST_BASE ? `${LIST_BASE}/resources.json` : RESOURCES_URL;

  async function runRefresh(): Promise<ListUpdateResult> {
    const lastUpdated = Date.now();
    const { sources, resources } = await fetchAll(refreshSubs, {
      cacheDir: listsCacheDir,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
      resourcesUrl: refreshResourcesUrl,
      fetchImpl: refreshFetch as typeof fetch,
    });
    const usable = sources.filter((s) => s.ok && s.text.length > 0);
    if (usable.length > 0) {
      const engine = buildEngine(usable.map((s) => s.text), resources);
      controller.setPendingBlocker(engine);
      serializeEngine(engine, cachePath);
      for (const s of usable) {
        subsRepo.updateMeta(s.listId, { lastUpdated, etag: s.etag, hash: s.hash });
      }
    }
    return {
      perSource: sources.map((s) => ({ listId: s.listId, ok: s.ok, error: s.error })),
      lastUpdated,
    };
  }
  const updateNow = (): Promise<ListUpdateResult> => runRefresh();

  registerGuardedHandlers(chromeWc.id, {
    ...buildNavHandlers(vc, settingsRepo),
    ...buildSettingsHandlers(settingsRepo),
    ...buildAdblockHandlers(controller),
    ...buildListsHandlers(updateNow),
  });

  // Test-only registry (never in production paths).
  if (process.env.AEGIS_E2E === '1') {
    (globalThis as any).__aegisTest = {
      primary: vc,
      chromeWcId: chromeWc.id,
      adblock: {
        controller,
        engineSource,
        snapshotCount: () => controller.snapshotCount(),
        isBlockingActive: () => controller.isBlockingActive(),
        setEnabled: (b: boolean) => controller.setEnabled(b),
        toggleAllowlist: (h: string) => controller.toggleAllowlist(h),
        getState: () => controller.getState(),
        updateNow,
      },
    };
  }

  // Session restore on boot: last URL, else AEGIS_HOME_URL override (used by e2e to
  // avoid live network), else settings.homeUrl.
  const last = readLastSession(userData);
  const homeUrl = process.env.AEGIS_HOME_URL ?? settingsRepo.get().homeUrl;
  const firstUrl = last ? last.url : homeUrl;

  // Prime blocking for the first nav BEFORE navigating (engine-readiness gating).
  controller.primeFor(firstUrl);
  vc.navigate(firstUrl);

  // ---- Background refresh + 24h scheduler (AFTER navigate; non-blocking) ----
  // Skip the automatic first-run kick under deterministic e2e (offline / test filter);
  // handlers + updateNow are still registered so explicit calls work.
  const scheduler = new RefreshScheduler({
    intervalMs: REFRESH_INTERVAL_MS,
    onTick: () =>
      runRefresh()
        .then(() => {})
        .catch((err) => console.error('[adblock] scheduled refresh failed', err)),
  });
  if (!OFFLINE && !TEST_FILTER) {
    runRefresh().catch((err) => console.error('[adblock] background refresh failed', err));
  }
  scheduler.start();

  // Lifecycle cleanup: WebContentsView does not auto-destroy on BaseWindow close.
  win.on('closed', () => {
    scheduler.stop();
    vc.destroy();
    chromeWc.close();
  });
}

app.whenReady().then(() => {
  try {
    boot();
  } catch (err) {
    dialog.showErrorBox('Aegis failed to start', String(err instanceof Error ? err.stack ?? err.message : err));
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
