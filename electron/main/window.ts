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

  // Transparent chrome: the content region of the chrome view paints nothing, so
  // when the chrome view is moved on top for the sidebar overlay the content view
  // composites through (toolbar/favbar/sidebar/scrim paint their own bg). See §4.
  chromeView.setBackgroundColor('#00000000');

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

export const FULLSCREEN_CORNER = 44; // px — top-right region that holds the exit button

/**
 * Positions the chrome view and, if given, the content view. Two modes:
 *  - normal: chrome fills the window; the content view is inset by `inset`
 *    (default { top: CHROME_TOP_HEIGHT, left: 0 } until the renderer reports
 *    its computed inset — avoids a boot race). The renderer owns chrome layout
 *    and reports the inset via view.setContentInset; index.ts holds the latest
 *    inset and re-applies it on resize.
 *  - fullscreen: the chrome view shrinks to a small top-right corner (holds the
 *    exit button); the content view fills the whole window.
 * Call on window resize via relayout().
 */
export function layout(
  win: BaseWindow,
  chromeView: WebContentsView,
  contentView?: WebContentsView,
  opts: { inset?: { top: number; left: number }; fullscreen?: boolean } = {},
): void {
  const { inset = { top: CHROME_TOP_HEIGHT, left: 0 }, fullscreen = false } = opts;
  const { width, height } = win.getContentBounds();
  if (fullscreen) {
    // Chrome shrinks to a small top-right corner (holds the exit button); content fills the window.
    chromeView.setBounds({ x: Math.max(0, width - FULLSCREEN_CORNER), y: 0, width: FULLSCREEN_CORNER, height: FULLSCREEN_CORNER });
    if (contentView) contentView.setBounds({ x: 0, y: 0, width, height });
  } else {
    chromeView.setBounds({ x: 0, y: 0, width, height });
    if (contentView) {
      contentView.setBounds({ x: inset.left, y: inset.top, width: width - inset.left, height: height - inset.top });
    }
  }
}
