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

export default defineConfig({
  main: {
    plugins: [copySeedPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
        external: [
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
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
      },
    },
  },
});
