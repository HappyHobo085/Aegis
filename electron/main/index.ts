import { app } from 'electron';
import { createMainWindow, layout } from './window';

// Minimal boot for Block 1: launch the window and show the chrome.
// Full wiring (DB, ViewController, IPC, session, __aegisTest) lands in Task 19.
app.whenReady().then(() => {
  const { win, chromeView } = createMainWindow();
  layout(win, chromeView);

  win.on('resize', () => layout(win, chromeView));
  win.on('closed', () => {
    chromeView.webContents.close();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
