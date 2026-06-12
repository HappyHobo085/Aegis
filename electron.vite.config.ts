import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Copy the committed engine snapshot from the SOURCE tree into the main build
 * output on every main build (dev + build). At runtime __dirname for main is
 * out/main/, so Task 18 reads join(__dirname, 'adblock/seed/engine-seed.bin');
 * nothing else bridges the source blob to out/. If the blob has not been
 * generated yet, copyFileSync throws and we swallow it — loadSnapshotEngine
 * handles the resulting null. (Packaged-app extraResources is a Phase-5 item.)
 */
function copySeedPlugin() {
  return {
    name: 'aegis-copy-seed',
    writeBundle() {
      try {
        const dir = resolve(__dirname, 'out/main/adblock/seed');
        mkdirSync(dir, { recursive: true });
        copyFileSync(
          resolve(__dirname, 'electron/main/adblock/seed/engine-seed.bin'),
          resolve(dir, 'engine-seed.bin'),
        );
      } catch (err) {
        // seed not generated yet (ENOENT) is expected; surface any other failure.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}

/**
 * Inject a build-mode-aware Content-Security-Policy <meta> into the CHROME renderer
 * document only (the privileged React UI). Production/build = strict; dev/serve =
 * relaxed so Vite HMR (inline bootstrap script, eval, the ws: socket) works. The
 * static <meta> was removed from src/index.html so this is the single source. The
 * VISITED content view intentionally gets NO app CSP (correct browser behavior).
 *
 * dev vs build is discriminated by the transformIndexHtml context: ctx.server is
 * present only under `vite dev`/serve, absent during a production build.
 */
const CSP_PROD =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
  "base-uri 'none'; frame-src 'none'; form-action 'none'";
const CSP_DEV =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' ws:; font-src 'self'; object-src 'none'";

function cspPlugin() {
  return {
    name: 'aegis-chrome-csp',
    transformIndexHtml(html: string, ctx: { server?: unknown }) {
      const content = ctx && ctx.server ? CSP_DEV : CSP_PROD;
      const meta = `<meta http-equiv="Content-Security-Policy" content="${content}" />`;
      // Inject right after the <head> open tag.
      return html.replace(/<head>/, `<head>\n    ${meta}`);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [copySeedPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
        external: [
          'electron-updater',
          'better-sqlite3',
          '@ghostery/adblocker-electron',
          // resolved at runtime by adblocker-electron via require.resolve — must stay external + unpacked
          '@ghostery/adblocker-electron-preload',
        ],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          chromePreload: resolve(__dirname, 'electron/preload/chromePreload.ts'),
          contentPreload: resolve(__dirname, 'electron/preload/contentPreload.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
      },
    },
  },
});
