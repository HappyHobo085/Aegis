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
    // Deliberately at the TOP level, not inside a project: both the `node` and the
    // `dom` project inherit it, so one `include` covers the whole tree.
    //
    // `include` is MANDATORY, not cosmetic. Vitest 4 removed `coverage.all` and now
    // defaults to reporting only files that were actually loaded during the run, so
    // without this a never-imported module is INVISIBLE and the run reads 100% while a
    // whole file sits untested. Listing `include` is what puts those files in the
    // report at ~0% instead. Verified: `scripts/check-bundle-size.mjs` and its two
    // siblings are imported by no test and show up in the report as 0%.
    coverage: {
      provider: 'v8',
      // `json-summary` is the one the baseline + ratchet scripts read: it carries
      // istanbul's own exact totals (no re-derivation of the line math on our side).
      reporter: ['text', 'lcov', 'json', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}', 'shared/**/*.ts', 'scripts/**/*.mjs'],
      exclude: [
        // Specs are not product code. Note `coverage.exclude` REPLACES Vitest's
        // defaults wholesale, so the entries that actually matter are all listed here.
        '**/*.test.{ts,tsx,mjs}',
        '**/*.spec.{ts,tsx,mjs}',
        'src/main.tsx', // entry point: mounts the app
        'src/vite-env.d.ts', // type declarations, no runtime
        'src/testFixtures/**', // the aegis mock the specs run against, not product code
        '**/node_modules/**',
        '**/dist/**',
        '**/coverage/**',
        '**/*.d.ts',
      ],
      // Thresholds live in the `coverage` ratchet script, not here, so that the
      // committed baseline in coverage-baseline.json is the single source of truth
      // and CI can fail when the baseline is LOWERED rather than silently relaxing.
    },
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
