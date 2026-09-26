// ESLint 10 flat config for Aegis — React 19 + TypeScript + Vite renderer (src/),
// the shared IPC contract (shared/), and the Node ESM CI scripts (scripts/).
//
// Strategy (see plan Task 3): use the NON-type-aware recommended sets so the gate is
// green on the existing tree without a type-info-driven churn pass. Prettier owns
// formatting (eslint-config-prettier disables every stylistic rule); ESLint owns
// correctness.
//
// About "downgraded so CI surfaces them as warnings instead of failing": that is NOT
// what this config does, and the distinction matters when you add a rule here. The
// lint script is `eslint . --max-warnings=0`, so `'off'` and `'warn'` are
// indistinguishable in CI — both gate exactly like `'error'`. The honest description
// of the two categories below is therefore:
//   - rules listed as 'off' are not checked at all, locally or in CI;
//   - rules enabled here are errors and fail the build on the first occurrence.
// There is no warning tier in this repo's ESLint setup.
//
// Two checks are still switched off, with the measured backlog recorded here so the
// decision is reviewable and the work to flip them is a checklist, not an archaeology
// dig. Both were re-measured against this exact tree; the counts are what
// `@typescript-eslint/no-unused-vars` (with `argsIgnorePattern`/`varsIgnorePattern`
// of `^_`, `caughtErrors: 'none'`) and `reportUnusedDisableDirectives: 'error'`
// actually report today.
//
// 1. `@typescript-eslint/no-unused-vars` — 11 hits, all genuinely dead:
//      src/App.tsx:142                      unused destructured `setSidebarInitialTab`
//      src/autopilot/interactions/toolbar.ts:726   unused spec arg `ctx`
//      src/components/CommandPalette.test.tsx:1     unused import `afterEach`
//      src/components/CommandPalette.tsx:12          unused import `FuzzyResult`
//      src/hooks/useVaultAutofill.test.ts:4          unused import `act`
//      src/hooks/useVaultDomainSuggestions.test.ts:11 unused spec arg `args`
//      src/hooks/useVaultDomainSuggestions.ts:2      unused import `useMemo`
//      src/hooks/useVaultDomainSuggestions.ts:21     unused local `hasLoginForm`
//      src/hooks/useWorkspaces.ts:2                  unused import `useRef`
//      src/lib/format.test.ts:14                     unused local `DAY`
//      src/lib/omnibox.ts:65                         unused function `hostOf`
//    Delete/prefix each, drop the two `'off'` entries below, and the rule is on.
//
// 2. `reportUnusedDisableDirectives` — 6 hits. One is fallout from (1)
//    (shared/types.ts:507 disables no-unused-vars for the whole `Settings` interface).
//    The other five are directives for TYPE-AWARE-ONLY rules this config
//    deliberately does not load, so they can never be "used" under the
//    non-type-aware strategy above and are not removable by any config change:
//      src/autopilot/interactionCtx.ts:250   @typescript-eslint/no-unsafe-assignment
//      src/lib/farbleShim.test.ts:122,368,449,830   @typescript-eslint/no-implied-eval
//    Turning the option on therefore means deleting those five lines, which is only
//    correct alongside a decision about the type-aware configs.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Never lint generated / vendored / build output.
  //
  // reportUnusedDisableDirectives is 'off' only because of the 6 measured hits
  // catalogued in the header — 5 of them are directives for rules this config does
  // not load. Flip it to 'error' in the same commit that deletes those directives.
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      'target/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'src-tauri/src/**',
      // (`scripts/autopilot/fixture/**` was ignored here for a live autopilot harness
      // that does not exist — see the "Autopilot test harness" section of AGENTS.md.)
      'sync-server/**',
      '*.config.js',
    ],
  },

  // Base correctness rules for every TS/JS file.
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Renderer + shared TypeScript (browser globals).
  {
    files: ['src/**/*.{ts,tsx}', 'shared/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'off',
      // IPC-boundary payloads, tests, and dev mocks intentionally use loose payloads.
      '@typescript-eslint/no-explicit-any': 'off',
      // The codebase has intentional empty catch/else fall-throughs.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Unused code is currently NOT checked — the 11-site backlog that keeps this off
      // is catalogued in the header, with the one-line fix for each. Enable it with
      // { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      // (the `^_` prefix is already the convention: 36 of the 47 raw hits are `_`-named
      // params) and delete those 11 sites in the same commit.
      '@typescript-eslint/no-unused-vars': 'off',
      // These React Compiler advisory rules are too noisy for this event/subscription-heavy
      // codebase today, so they are not checked at all (see the header: there is no
      // warning tier here). Exhaustive Rules of Hooks stays enabled.
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
    },
  },

  // Node ESM CI scripts (different globals: process, etc.).
  {
    files: ['scripts/**/*.mjs', 'vitest.config.ts', 'vitest.setup.ts'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // MUST be last: disable all formatting rules so Prettier is the sole formatter.
  prettier,
);
