import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Standalone Vite dev server + production build of the React renderer when it is
 * hosted by Tauri. Invoked by the `dev:renderer` / `build:renderer` npm scripts,
 * which Tauri's beforeDevCommand / beforeBuildCommand call.
 *
 * This file is used ONLY by the Tauri build. The Electron build keeps using
 * electron.vite.config.ts and the unit tests keep using vitest.config.ts —
 * neither reads this file, so the working Electron app and the test suite are
 * unaffected.
 *
 * The entire renderer reaches the backend through one module, src/lib/ipcClient.ts
 * (which under Electron is the `window.aegis` preload bridge). For the Tauri build
 * we alias that single module to the Tauri client (invoke/listen). The regex
 * matches every `./lib/ipcClient` / `../lib/ipcClient` import in the tree.
 */
export default defineConfig({
  root: resolve(__dirname, 'src'),
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: [
      {
        find: /^(\.\.?\/)+lib\/ipcClient$/,
        replacement: resolve(__dirname, 'src/lib/ipcClient.tauri.ts'),
      },
    ],
  },
  server: { port: 5174, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
