import { app } from 'electron';
import { join } from 'node:path';
import type { NavState } from '../../shared/types';
import { createMainWindow, layout } from './window';
import { ViewController } from './viewController';
import { openDb, runMigrations } from './db/sqlite';
import { SettingsRepo } from './db/settingsRepo';
import { readLastSession, writeLastSession } from './session';
import { registerGuardedHandlers } from './ipc/guard';
import { buildNavHandlers, buildViewEventForwarders } from './ipc/nav';
import { buildSettingsHandlers } from './ipc/settings';

/** Resolve the data dir: AEGIS_USER_DATA override (e2e isolation) or app userData. */
function resolveUserData(): string {
  return process.env.AEGIS_USER_DATA ?? app.getPath('userData');
}

function boot(): void {
  const userData = resolveUserData();

  // Persistence: DB + migrations + settings repo.
  const db = openDb(join(userData, 'aegis.db'));
  runMigrations(db);
  const settingsRepo = new SettingsRepo(db);

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

  // Privileged IPC, sender-validated against the chrome WebContents id.
  registerGuardedHandlers(chromeWc.id, {
    ...buildNavHandlers(vc, settingsRepo),
    ...buildSettingsHandlers(settingsRepo),
  });

  // Test-only registry (never in production paths).
  if (process.env.AEGIS_E2E === '1') {
    (globalThis as any).__aegisTest = { primary: vc };
  }

  // Session restore on boot: last URL, else AEGIS_HOME_URL override (used by e2e to
  // avoid live network), else settings.homeUrl.
  const last = readLastSession(userData);
  const homeUrl = process.env.AEGIS_HOME_URL ?? settingsRepo.get().homeUrl;
  vc.navigate(last ? last.url : homeUrl);

  // Lifecycle cleanup: WebContentsView does not auto-destroy on BaseWindow close.
  win.on('closed', () => {
    vc.destroy();
    chromeWc.close();
  });
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
