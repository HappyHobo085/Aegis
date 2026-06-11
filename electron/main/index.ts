import { app, dialog } from 'electron';
import { join } from 'node:path';
import type { NavState, ListUpdateResult, BlockedCount } from '../../shared/types';
import { IPC } from '../../shared/types';
import { createMainWindow, layout } from './window';
import { CHROME_TOP_HEIGHT } from './constants';
import { ViewController } from './viewController';
import { openDb, runMigrations } from './db/sqlite';
import { SettingsRepo } from './db/settingsRepo';
import { AdblockRepo } from './db/adblockRepo';
import { SubsRepo } from './db/subsRepo';
import { CustomFiltersRepo } from './db/customFiltersRepo';
import { FavoritesRepo } from './db/favoritesRepo';
import { HistoryRepo } from './db/historyRepo';
import { SavedRepo } from './db/savedRepo';
import { HistoryRecorder } from './historyRecorder';
import { readLastSession, writeLastSession } from './session';
import { registerGuardedHandlers } from './ipc/guard';
import { buildNavHandlers, buildViewEventForwarders } from './ipc/nav';
import { buildSettingsHandlers } from './ipc/settings';
import { buildAdblockHandlers } from './ipc/adblock';
import { buildListsHandlers } from './ipc/lists';
import { buildFavoritesHandlers } from './ipc/favorites';
import { buildHistoryHandlers } from './ipc/history';
import { buildSavedHandlers } from './ipc/saved';
import { buildSubsHandlers } from './ipc/subs';
import { buildCustomFiltersHandlers } from './ipc/customFilters';
import { buildViewLayoutHandlers } from './ipc/viewLayout';
import { DownloadsRepo } from './db/downloadsRepo';
import { PermissionsRepo } from './db/permissionsRepo';
import { wireDownloads } from './downloads';
import { wirePermissions } from './permissions';
import { buildDownloadsHandlers } from './ipc/downloads';
import { buildPermissionsHandlers, buildPromptBridge } from './ipc/permissions';
import { buildDataHandlers } from './ipc/data';
import { buildPickerHandlers } from './ipc/picker';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import {
  buildEngine,
  loadCachedEngine,
  loadSnapshotEngine,
  serializeEngine,
  DEFAULT_LIST_URLS,
  RESOURCES_URL,
} from './adblock/engine';
import { resolveRefreshSubs, assembleEngineTexts } from './adblock/refreshHelpers';
import { fetchAll, RefreshScheduler } from './adblock/listManager';
import { readFileSafe } from '../lib/atomicFile';
import { BlockedCounter } from './adblock/blockedCounter';
import { AdblockController } from './adblock/controller';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Split a multi-line filter blob (AEGIS_ADBLOCK_TEST_FILTER) into trimmed, non-empty
 * filter rules. A single-line value yields a 1-element array. Used by the e2e boot
 * hook so cosmetic (`##…`) + scriptlet (`##+js(…)`) + network rules can be supplied
 * together as one newline-delimited env var.
 */
function splitNonEmptyLines(blob: string): string[] {
  return blob
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

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
  const customFiltersRepo = new CustomFiltersRepo(db);
  const favoritesRepo = new FavoritesRepo(db);
  const historyRepo = new HistoryRepo(db);
  const savedRepo = new SavedRepo(db);
  const downloadsRepo = new DownloadsRepo(db);
  const permissionsRepo = new PermissionsRepo(db);

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

  // Content inset: the renderer reports { top, left } via view.setContentInset; main
  // holds the latest inset and re-applies it on resize (default top=56,left=0 until
  // the renderer reports — avoids a boot race).
  let contentInset = { top: CHROME_TOP_HEIGHT, left: 0 };
  const setContentInset = (top: number, left: number): void => {
    contentInset = { top, left };
    layout(win, chromeView, vc.view, contentInset);
  };
  layout(win, chromeView, vc.view, contentInset);
  win.on('resize', () => layout(win, chromeView, vc.view, contentInset));

  // Sidebar overlay: chrome (transparent) on top when open (scrim + right panel paint
  // over the content view); content view on top when closed (normal browsing). Bounds
  // never change for the sidebar — only the top inset applies (left always 0).
  const bringToTop = (v: Electron.WebContentsView): void => {
    win.contentView.removeChildView(v);
    win.contentView.addChildView(v);
  };
  const setSidebarOpen = (open: boolean): void => {
    bringToTop(open ? chromeView : vc.view);
  };

  // History recording: main-side, on the content WebContents' nav/title events.
  // onChanged pushes history.changed so an open renderer history panel refreshes.
  new HistoryRecorder({
    wc: vc.contentWebContents,
    repo: historyRepo,
    onChanged: fwd.onHistoryChanged,
  });

  // ---- Downloads pipeline (content session) ----
  const liveDownloads = new Map<number, Electron.DownloadItem>();
  const onDownloadsChanged = (): void => chromeWc.send(IPC.evtDownloadsChanged);
  wireDownloads(vc.contentSession, {
    downloadsRepo,
    settingsRepo,
    onChanged: onDownloadsChanged,
    liveItems: liveDownloads,
  });

  // ---- Remembered site-permissions (re-sets both content-session handlers) ----
  const promptBridge = buildPromptBridge((payload) =>
    chromeWc.send(IPC.evtPermissionsPrompt, payload),
  );
  wirePermissions(vc.contentSession, {
    permissionsRepo,
    prompt: promptBridge.prompt,
  });

  // ---- HTML5 fullscreen (content view drives the BaseWindow) ----
  vc.contentWebContents.on('enter-html-full-screen', () => win.setFullScreen(true));
  vc.contentWebContents.on('leave-html-full-screen', () => win.setFullScreen(false));

  // ---- Adblock subsystem (after ViewController, BEFORE the first navigate) ----
  const cachePath = join(userData, 'engine.bin');
  const snapshotPath = join(__dirname, 'adblock/seed/engine-seed.bin');
  const listsCacheDir = join(userData, 'lists');

  // E2E determinism hooks.
  const TEST_FILTER = process.env.AEGIS_ADBLOCK_TEST_FILTER;
  const TEST_RESOURCES = process.env.AEGIS_ADBLOCK_TEST_RESOURCES || null;
  const OFFLINE = process.env.AEGIS_ADBLOCK_OFFLINE === '1';
  const LIST_BASE = process.env.AEGIS_ADBLOCK_LIST_BASE;

  // Initial engine: deterministic test filter (e2e) | user cache | bundled snapshot | empty.
  // Track the source so e2e can assert first-run-on-seed deterministically (§8.4/§8.7).
  let initialBlocker: ElectronBlocker;
  let engineSource: 'filter' | 'cache' | 'snapshot' | 'built';
  if (TEST_FILTER) {
    // Multi-line filter set (network + cosmetic `##…` + scriptlet `##+js(…)` rules);
    // TEST_RESOURCES supplies the custom scriptlet resources.json so `##+js(...)` resolve.
    initialBlocker = buildEngine(splitNonEmptyLines(TEST_FILTER), TEST_RESOURCES);
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
  const refreshResourcesUrl = LIST_BASE ? `${LIST_BASE}/resources.json` : RESOURCES_URL;

  /**
   * Fetch-rebuild path (network). Sources the ENABLED subscription rows live from
   * subsRepo.all() (this is what finally reads filter_subscriptions.enabled — the
   * wiring gap) via resolveRefreshSubs, applying the LIST_BASE per-row override for
   * e2e. Builds the engine from the fetched list texts + the user's custom-filters
   * blob (assembleEngineTexts), swaps it in on the next nav, persists the cache, and
   * records per-source refresh metadata. Used by lists.updateNow, the 24h scheduler,
   * the boot kick, and subs.add (a new list must be fetched).
   */
  async function runRefresh(): Promise<ListUpdateResult> {
    const lastUpdated = Date.now();
    const refreshSubs = resolveRefreshSubs(subsRepo.all(), LIST_BASE);
    const { sources, resources } = await fetchAll(refreshSubs, {
      cacheDir: listsCacheDir,
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: FETCH_MAX_BYTES,
      resourcesUrl: refreshResourcesUrl,
      fetchImpl: refreshFetch as typeof fetch,
    });
    const usable = sources.filter((s) => s.ok && s.text.length > 0);
    if (usable.length > 0) {
      const texts = assembleEngineTexts(usable.map((s) => s.text), customFiltersRepo.get());
      const engine = buildEngine(texts, resources);
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

  /**
   * Cache-rebuild path (NO network). Reads the on-disk raw cache for each ENABLED
   * subscription (lists/<listId>.txt), skipping missing/empty files, appends the
   * user's custom-filters blob (assembleEngineTexts), rebuilds the engine, swaps it
   * in on the next nav, and re-serializes the cache. Used by subs.setEnabled,
   * subs.remove, and customFilters.set — none of which need a re-fetch. On a fresh
   * profile with no caches yet this yields a near-empty engine; the active engine
   * (cache/snapshot) stays until a successful runRefresh (documented caveat §2.1).
   */
  function rebuildEngineFromCache(): void {
    const listTexts: string[] = [];
    for (const sub of subsRepo.all()) {
      if (!sub.enabled) continue;
      const text = readFileSafe(join(listsCacheDir, `${sub.listId}.txt`));
      if (text !== null && text.length > 0) listTexts.push(text);
    }
    const texts = assembleEngineTexts(listTexts, customFiltersRepo.get());
    const engine = buildEngine(texts, null);
    controller.setPendingBlocker(engine);
    serializeEngine(engine, cachePath);
  }
  const updateNow = (): Promise<ListUpdateResult> => runRefresh();

  registerGuardedHandlers(chromeWc.id, {
    ...buildNavHandlers(vc, settingsRepo),
    ...buildSettingsHandlers(settingsRepo),
    ...buildAdblockHandlers(controller),
    ...buildListsHandlers(updateNow),
    ...buildSubsHandlers(subsRepo, { rebuildFromCache: rebuildEngineFromCache, refresh: updateNow }),
    ...buildCustomFiltersHandlers(customFiltersRepo, { rebuildFromCache: rebuildEngineFromCache }),
    ...buildFavoritesHandlers(favoritesRepo),
    ...buildHistoryHandlers(historyRepo),
    ...buildSavedHandlers(savedRepo),
    ...buildViewLayoutHandlers(setContentInset, setSidebarOpen),
    ...buildDownloadsHandlers(downloadsRepo, { liveItems: liveDownloads }),
    ...buildPermissionsHandlers(permissionsRepo, { resolvePrompt: promptBridge.resolvePrompt }),
    ...buildDataHandlers({ favoritesRepo, historyRepo, savedRepo, settingsRepo, db }, win),
    ...buildPickerHandlers({ vc, customFiltersRepo, rebuildFromCache: rebuildEngineFromCache }),
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
      places: { favoritesRepo, historyRepo, savedRepo, setContentInset, setSidebarOpen },
      view: {
        isChromeOnTop: () => win.contentView.children.at(-1) === chromeView,
        // Sample a single pixel's alpha byte from the chrome view's painted output.
        // capturePage returns a NativeImage; toBitmap() is BGRA, so index 3 is alpha.
        // In the content region (below the top inset) the transparent chrome paints
        // nothing → alpha ~0 (content composites through).
        sampleChromeAlpha: async (x: number, y: number) => {
          const img = await chromeView.webContents.capturePage({ x, y, width: 1, height: 1 });
          const bm = img.toBitmap();
          return bm[3];
        },
      },
      phase4: {
        settingsRepo,
        subsRepo,
        customFiltersRepo,
        rebuildFromCache: rebuildEngineFromCache,
        updateNow,
        navHome: () => vc.navigate(settingsRepo.get().homeUrl),
      },
      phase5: {
        downloadsRepo,
        permissionsRepo,
        // Test-only handle to the real picker.start() flow (the IIFE injection +
        // customFiltersRepo append + rebuildFromCache), so e2e can drive it headlessly.
        pickerStart: () =>
          buildPickerHandlers({ vc, customFiltersRepo, rebuildFromCache: rebuildEngineFromCache })[
            IPC.pickerStart
          ](),
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
