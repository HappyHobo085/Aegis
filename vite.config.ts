import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { reactPlugins } from './vite.shared';

/**
 * Standalone Vite dev server + production build of the React renderer, which is
 * hosted by Tauri. Invoked by the `dev:renderer` / `build:renderer` npm scripts,
 * which Tauri's beforeDevCommand / beforeBuildCommand call.
 *
 * The entire renderer reaches the backend through one module, src/lib/ipcClient.ts,
 * the Tauri client (invoke/listen).
 */
export default defineConfig(async () => {
  // Bundle analysis: dynamic import avoids adding the plugin to normal builds.
  // ESM-only package needs await inside an async config (CJS config bundler
  // rejects top-level await but handles async function returns fine).
  const analyzePlugins = process.env.ANALYZE
    ? [
        (await import('rollup-plugin-visualizer')).visualizer({
          filename: 'dist/bundle-analysis.html',
          gzipSize: true,
          brotliSize: false,
        }),
      ]
    : [];

  return {
    root: resolve(__dirname, 'src'),
    plugins: [
      // React 19 Compiler: auto-memoizes components/hooks at build time, so the renderer
      // doesn't depend on hand-written React.memo/useCallback to avoid re-renders. It bails
      // out safely (leaving a component un-optimized) on any code it can't prove safe, so
      // enabling it never changes behavior — it only removes unnecessary re-renders.
      //
      // Shared with vitest.config.ts via vite.shared.ts so the test suite exercises the
      // compiled output too. This comment previously claimed the compiler ran in the
      // vitest pipeline as well; it did not.
      ...reactPlugins(),
      ...analyzePlugins,
    ],
    clearScreen: false,
    // Port is overridable via VITE_DEV_PORT so a second dev server can run on its own
    // port (e.g. 5199) alongside a normal `tauri dev` on 5174 without colliding.
    server: { port: Number(process.env.VITE_DEV_PORT) || 5174, strictPort: true },
    build: {
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: true,
    },
  };
});
