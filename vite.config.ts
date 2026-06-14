import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Standalone Vite dev server + production build of the React renderer, which is
 * hosted by Tauri. Invoked by the `dev:renderer` / `build:renderer` npm scripts,
 * which Tauri's beforeDevCommand / beforeBuildCommand call.
 *
 * The entire renderer reaches the backend through one module, src/lib/ipcClient.ts,
 * the Tauri client (invoke/listen).
 */
export default defineConfig({
  root: resolve(__dirname, 'src'),
  plugins: [react()],
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
});
