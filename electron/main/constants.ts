export const CHROME_TOP_HEIGHT = 56;

/**
 * True if the URL is the app's own chrome renderer: the electron-vite dev
 * renderer origin OR a file: URL under the packaged out/renderer directory.
 */
export function isAppUrl(url: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    try {
      const dev = new URL(devUrl);
      const candidate = new URL(url);
      if (candidate.origin === dev.origin) return true;
    } catch {
      // fall through to the file: check
    }
  }
  if (url.startsWith('file:')) {
    try {
      const { pathname } = new URL(url);
      return pathname.includes('/out/renderer/');
    } catch {
      return false;
    }
  }
  return false;
}
