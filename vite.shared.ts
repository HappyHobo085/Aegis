import { reactCompilerPreset, default as react } from '@vitejs/plugin-react';
import babel from '@rolldown/plugin-babel';
import type { PluginOption } from 'vite';

/**
 * The one place the React plugin is configured, shared by `vite.config.ts` (dev + build)
 * and `vitest.config.ts` (the test transform pipeline).
 *
 * These two used to configure the plugin independently, which is how the React Compiler
 * ended up in a state nobody could trust: `vite.config.ts` passed a `babel` option and
 * carried a comment claiming the compiler "Runs in dev, prod, AND the vitest transform
 * pipeline, so the test suite exercises the compiled output", while `vitest.config.ts`
 * passed a bare `react()`. Sharing the array removes that whole class of drift — a change
 * to the transform can no longer be applied to one pipeline and forgotten in the other.
 *
 * ## The React Compiler
 *
 * The old config here was `react({ babel: { plugins: [['babel-plugin-react-compiler', {}]] } })`.
 * That was **dead configuration**: `@vitejs/plugin-react` v6 (this repo is on 6.0.3)
 * REMOVED the `babel` option — its `Options` type is only `include`, `exclude`,
 * `jsxImportSource`, `jsxRuntime` and `reactRefreshHost` — so the compiler plugin was
 * silently ignored in dev, in the production build, and (because `vitest.config.ts` never
 * passed it at all) in tests. The `babel` key is a type error, which is how it was found:
 * the full `tsconfig.json` includes this file via `vitest.config.ts`, and `tsc` rejected the
 * unknown property. Which is exactly why build tooling is typechecked — an invalid plugin
 * option in a config is invisible until someone notices the transform is a no-op.
 *
 * v6 ships the compiler behind `reactCompilerPreset()`, applied through a Babel plugin
 * (`@rolldown/plugin-babel`, with `@babel/core` as a peer) rather than through
 * plugin-react itself. That is the wiring below, and because `reactPlugins()` is shared,
 * dev, the production build and the test pipeline now all compile the same way — so the
 * suite actually exercises the output that ships, including the paths the compiler bails
 * out on.
 */
export function reactPlugins(): PluginOption[] {
  return [react(), babel({ presets: [reactCompilerPreset()] })];
}
