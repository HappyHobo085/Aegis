import { join } from 'node:path';
import { BaseWindow, WebContentsView } from 'electron';
import { CHROME_TOP_HEIGHT } from './constants';

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

  // NOTE: chrome-renderer lockdown (setWindowOpenHandler + will-navigate guard)
  // is added in Task 4, which writes its failing test first.

  if (process.env.ELECTRON_RENDERER_URL) {
    chromeWc.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    chromeWc.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return { win, chromeView };
}

/**
 * Positions the chrome view over the whole window and, if given, the content
 * view below the top chrome band. Call on window resize.
 */
export function layout(
  win: BaseWindow,
  chromeView: WebContentsView,
  contentView?: WebContentsView,
): void {
  const { width, height } = win.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width, height });
  if (contentView) {
    contentView.setBounds({
      x: 0,
      y: CHROME_TOP_HEIGHT,
      width,
      height: height - CHROME_TOP_HEIGHT,
    });
  }
}
