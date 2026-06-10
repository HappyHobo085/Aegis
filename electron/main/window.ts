import { join } from 'node:path';
import { BaseWindow, WebContentsView } from 'electron';
import { CHROME_TOP_HEIGHT, isAppUrl } from './constants';

/**
 * Creates the BaseWindow and the chrome (privileged React shell) WebContentsView.
 * Owns chrome ONLY — the single content view is owned by ViewController and
 * added by index.ts (T19). Chrome-renderer lockdown is added in Task 4.
 */
export function createMainWindow(): { win: BaseWindow; chromeView: WebContentsView } {
  const win = new BaseWindow({ width: 1280, height: 800 });

  const chromeView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/chromePreload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Add chrome first so it sits beneath the (later-added) content view.
  win.contentView.addChildView(chromeView);

  const chromeWc = chromeView.webContents;

  // Chrome-renderer lockdown: deny all popups and allow navigation only to the app bundle.
  chromeWc.setWindowOpenHandler(() => ({ action: 'deny' }));
  chromeWc.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    chromeWc.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    chromeWc.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return { win, chromeView };
}

/**
 * Positions the chrome view over the whole window and, if given, the content
 * view inset by `inset` (default { top: CHROME_TOP_HEIGHT, left: 0 } until the
 * renderer reports its computed inset — avoids a boot race). The renderer owns
 * chrome layout and reports the inset via view.setContentInset; index.ts holds
 * the latest inset and re-applies it on resize. Call on window resize.
 */
export function layout(
  win: BaseWindow,
  chromeView: WebContentsView,
  contentView?: WebContentsView,
  inset: { top: number; left: number } = { top: CHROME_TOP_HEIGHT, left: 0 },
): void {
  const { width, height } = win.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width, height });
  if (contentView) {
    contentView.setBounds({
      x: inset.left,
      y: inset.top,
      width: width - inset.left,
      height: height - inset.top,
    });
  }
}
