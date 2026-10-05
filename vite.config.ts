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
    build: {
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: true,
      // TWO entries, because the app has two React roots.
      //
      // `index.html` is the chrome: toolbar, sidebar, modals — it fills the window behind the
      // content webview. `popover.html` is the popover surface: one extra webview that renders
      // a popover OVER the page inside a rect the chrome measured, in a webview with its own
      // capability and no `ipc` (src-tauri/capabilities/surface.json). Without a second entry
      // the surface would have no document to load, and `WebviewUrl::App("popover.html")` in
      // popover.rs would 404 into a blank rect.
      //
      // Named explicitly rather than globbed: a glob would silently start building a third
      // entry if anyone dropped an .html into src/, and Tauri serves only what it is told to.
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/index.html'),
          popover: resolve(__dirname, 'src/popover.html'),
        },
      },
    },
    // Port is overridable via VITE_DEV_PORT so a second dev server can run on its own
    // port (e.g. 5199) alongside a normal `tauri dev` on 5174 without colliding.
    server: { port: Number(process.env.VITE_DEV_PORT) || 5174, strictPort: true },
  };
});
