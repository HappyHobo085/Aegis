import { defineConfig } from 'vitest/config';
import { reactPlugins } from './vite.shared';

// Shared with vite.config.ts so the test pipeline runs the SAME React transform the
// production bundle does — including the React 19 Compiler. See vite.shared.ts for why
// that matters (the compiler bails out on unprovable components, so uncompiled tests
// would cover a different program than the one that ships).
export default defineConfig({
  plugins: reactPlugins(),
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['shared/**/*.test.ts', 'scripts/**/*.test.mjs'],
          exclude: ['node_modules/**', 'out/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./vitest.setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          // The React Compiler makes the transform ~5x more expensive (measured: the
          // whole suite's transform time went 6.2s -> 35.0s), and the default 5s
          // per-test budget was already tight for the specs that render the real
          // `<App/>` (compositor.test.tsx timed out on `setLayout overlay:true` twice
          // with the compiler enabled, and neither was an assertion failure). Raising
          // it here is the honest fix: the work is genuinely slower, and those specs
          // assert real layout behaviour worth waiting for.
          testTimeout: 15_000,
        },
      },
    ],
  },
});
