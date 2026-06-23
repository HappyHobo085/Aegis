// ESLint 10 flat config for Aegis — React 19 + TypeScript + Vite renderer (src/),
// the shared IPC contract (shared/), and the Node ESM CI scripts (scripts/).
//
// Strategy (see plan Task 3): use the NON-type-aware recommended sets so the gate is
// green on the existing tree without a type-info-driven churn pass. Prettier owns
// formatting (eslint-config-prettier disables every stylistic rule); ESLint owns
// correctness. A handful of rules the existing code legitimately trips are downgraded
// so CI surfaces them as warnings instead of failing.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Never lint generated / vendored / build output.
  {
    ignores: [
      'dist/**',
      'out/**',
      'node_modules/**',
      'target/**',
      'src-tauri/target/**',
      'src-tauri/gen/**',
      'src-tauri/src/**',
      'scripts/autopilot/fixture/**',
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
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // IPC-boundary payloads and dev mocks legitimately use `any`/casts; surface, don't fail.
      '@typescript-eslint/no-explicit-any': 'warn',
      // The codebase has intentional empty catch/else fall-throughs.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Allow underscore-prefixed unused args (event handlers, _label in drift tests).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // react-hooks v7 introduced set-state-in-effect + refs as errors; the existing code
      // uses the setState-in-effect pattern intentionally (derived state from event listeners).
      // Downgrade to warn so CI doesn't fail — these are not bugs in the current architecture.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
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
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // MUST be last: disable all formatting rules so Prettier is the sole formatter.
  prettier,
);
