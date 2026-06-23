# CI Hardening Implementation Plan (Sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the CI gate from "JS unit tests + npm-audit only" into a full guard rail by adding, to `.github/workflows/ci.yml`, gates the repo runs only locally today: `cargo test` (the 119 Rust `#[test]`s in `src-tauri/src/`), a **scoped** `tsc --noEmit` type check (scoped so the known test-file type noise does not fail it), `cargo clippy` + `cargo fmt --check`, a brand-new **ESLint + Prettier** setup (none exists in the repo), and an optional `cargo-audit` gate for the crypto/keyring surface. Every gate must run **green on the current `feat/improvements-program` tree** the first time — no pre-existing code is allowed to fail it — by adopting a baseline-clean strategy for each new linter (scope-out / one-time normalize / triage-then-strict) before the gate is committed.

**Architecture:** Two CI workflows exist. `ci.yml` is the always-on, fast, Ubuntu-only gate (`npm ci` → `npm test` → `node scripts/check-npm-audit.mjs`). `tauri-build-check.yml` is the on-demand heavy multi-OS native build. This sub-project adds the new fast checks to **`ci.yml`** (so they run on every PR and weekly), splitting it into parallel jobs by toolchain: a **`web`** job (Node: `tsc`, ESLint/Prettier, `npm test`, npm-audit) and a **`rust`** job (cargo: `fmt --check`, `clippy`, `test`, optional `audit`). The native build workflow is **not** changed (it already runs `npm test`; we do not add the new gates there — they would just duplicate the fast job at much higher cost). New config files live at the repo root next to the existing `tsconfig.json` / `package.json`. The Rust gates target the `src-tauri/` crate (`--manifest-path src-tauri/Cargo.toml`); the standalone `sync-server/` crate is **out of scope** (it is its own non-workspace crate with its own `Cargo.lock`, deployed independently — adding its gate is sub-project follow-up, not A).

**Tech Stack:** GitHub Actions (Ubuntu runners, Node 22, `dtolnay/rust-toolchain@stable`). Node side: ESLint 10 flat config (`eslint.config.mjs`) + `typescript-eslint` 8 + `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh` + Prettier 3 + `eslint-config-prettier`; TypeScript 5.9 (`tsc --noEmit`). Rust side: `cargo fmt` (rustfmt), `cargo clippy`, `cargo test`, `cargo-audit`.

## Global Constraints

Per the repo's enforced conventions (CLAUDE.md + spec §6). This sub-project is **CI/tooling only** — it adds *no* IPC channels and *no* user-facing runtime behavior — so several cross-cutting rules are satisfied vacuously; they are restated so the implementer confirms, not assumes:

1. **IPC in three places:** a new channel goes in `shared/types.ts` (`IPC` const), the Rust `ipc()` dispatcher, and `src/lib/ipcClient.ts`. **This plan adds none** — there is nothing to wire. (Confirm: no edit in this plan touches `shared/types.ts`, `src-tauri/src/lib.rs`'s dispatcher, or `src/lib/ipcClient.ts`.)
2. **Autopilot coverage in the same commit (drift-guarded):** new channel → `catalog.ts`; new UI screen/overlay → `screens.ts` (+ `reach.ts`); new interactive control → an interaction test. **This plan adds none of those** — no new channel, screen, overlay, or control. The autopilot catalogs are **not touched**; the drift-guard tests (`src/autopilot/coverage.test.ts`, `interactions.coverage.test.ts`) are expected to pass **unchanged**.
3. **Gate per sub-project:** `npm test` green; for runtime-touching changes, the live autopilot `RESULT: … 0 failed` and `ad-block blocking (trace): PASS` on Linux. **This sub-project changes no runtime behavior** (it only adds CI config + lint/format config + a build tsconfig + a normalize/triage pass that must be byte-equivalent in *behavior*). Therefore the binding gate here is: **`npm test` green AND every new CI gate green locally** (Task 8). The live autopilot is **not required** by §6 for a no-runtime-change sub-project; run it once at the end only if the Rust baseline-format normalize (Task 4) touched any file under `src-tauri/src/` that the autopilot exercises, to confirm formatting alone changed nothing — see Task 8 Step 4.
4. **Parity before "done" (§4):** CI gates are platform-agnostic (they run on the Ubuntu CI runner and gate code for all targets equally). There is no per-OS parity gap to close here — the gate guards Linux/Windows/macOS/Android code identically because it type-checks/lints/tests the shared source. (The native *build* matrix in `tauri-build-check.yml` already covers Win/macOS/Android compilation; this plan does not regress it.)
5. **Living docs, enforced:** update `.github/CLAUDE.md` (the CI workflow descriptions) and `scripts/CLAUDE.md` if the audit gate gains a sibling, in the same commit as the workflow change (Task 7).
6. **No source-logic change.** The only edits to files under `src/` or `src-tauri/src/` permitted by this plan are (a) the single pre-existing `JSX.Element` → `React.JSX.Element` one-token fix in `src/hooks/useChromeSurfaces.tsx` (Task 2, required to make the scoped `tsc` gate green) and (b) a one-time, formatting-only `cargo fmt` normalization (Task 4) and clippy-triage `#[allow]`/mechanical fixes (Task 5) that must not alter behavior. No feature logic, no IPC, no events.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `tsconfig.build.json` | A tsconfig that `extends` the base but **excludes** `**/*.test.ts(x)` + `src/testFixtures` so `tsc --noEmit` type-checks production source only (the test-file noise is the known issue per spec §3.A). | Create |
| `src/hooks/useChromeSurfaces.tsx` | One-token fix: `JSX.Element` → `React.JSX.Element` (the lone non-test production type error; see Task 2). | Modify |
| `eslint.config.mjs` | ESLint 10 **flat config** (ESM `.mjs` because `package.json` has no `"type":"module"`). Idiomatic React 19 + TS + Vite ruleset, baseline-clean (see Task 3 for the rule downgrades). | Create |
| `.prettierrc.json` | Prettier 3 formatting options (matches the existing code's 2-space / single-quote / semicolon / 100-col style). | Create |
| `.prettierignore` | Excludes generated/vendored dirs (`dist`, `target`, `node_modules`, `src-tauri/gen`, the autopilot fixture HTML). | Create |
| `.eslintignore` is **not used** | ESLint 9+/flat config ignores via the `ignores` key inside `eslint.config.mjs`; a separate `.eslintignore` is deprecated. | (n/a — handled in config) |
| `rustfmt.toml` | Pin rustfmt to defaults explicitly (edition 2021) so `cargo fmt --check` is deterministic across CI's toolchain and a dev box. | Create |
| `src-tauri/.cargo/audit.toml` | (Optional gate) `cargo-audit` config: ignore-list for any advisory we consciously accept, mirroring the npm-audit allowlist pattern. | Create |
| `package.json` | Add devDependencies (eslint stack + prettier) and `scripts`: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`. | Modify |
| `.github/workflows/ci.yml` | Split `verify` into a `web` job (typecheck + lint + format:check + test + npm-audit) and a `rust` job (fmt --check + clippy + test + optional audit). | Modify |
| `.github/CLAUDE.md` | Update the `ci.yml` description to document the new gates/jobs. | Modify |

**Final CI gate set** (all on `ci.yml`, Ubuntu): `npm run typecheck` (scoped tsc), `npm run lint` (ESLint), `npm run format:check` (Prettier), `npm test` (vitest, unchanged), `node scripts/check-npm-audit.mjs` (unchanged), `cargo fmt --check`, `cargo clippy`, `cargo test`, and (optional) `cargo audit`.

---

### Task 1: Scoped `tsc --noEmit` — create the build tsconfig + npm script

**Files:**
- Create: `tsconfig.build.json`
- Modify: `package.json` (add `typecheck` script)

**Interfaces:**
- Produces: `npm run typecheck` → `tsc --noEmit -p tsconfig.build.json`, which type-checks `src` + `shared` **excluding** test files and `src/testFixtures`.

**Why scoped:** Running plain `tsc --noEmit` against the base `tsconfig.json` reports **29 errors across 22 files** today. Verified breakdown: every one is in a `*.test.ts(x)` file, `src/testFixtures/aegisMock.ts`, or the single production file `src/hooks/useChromeSurfaces.tsx` (fixed in Task 2). The test/fixture errors are the "known test-file noise" the spec calls out (stale `Settings` partials in test props, `as Record<string,unknown>` casts of `window`, vitest `Mock` typing) — they are test-only and do not affect shipped code. The gate therefore checks **production source** via a `tsconfig.build.json` that excludes them. (Test files are still type-aware-checked at runtime by vitest + the `dom`/`node` projects via the base config during `npm test`; the gate just doesn't *fail the build* on their type noise.)

- [ ] **Step 1: Create the build tsconfig**

Create `tsconfig.build.json` at the repo root:

```json
{
  "extends": "./tsconfig.json",
  "include": ["src", "shared"],
  "exclude": ["node_modules", "out", "**/*.test.ts", "**/*.test.tsx", "src/testFixtures"]
}
```

> Rationale: `extends` inherits every compiler option from the base (`strict`, `jsx: react-jsx`, the `types` array, etc.). Re-stating `include`/`exclude` is required because `extends` does **not** merge `include`/`exclude` — the child fully replaces them. The base `include` was `["src","shared","vitest.config.ts","vitest.setup.ts"]`; the build scope drops the two vitest config files (they're tooling, not shipped) and adds the test-glob + fixture exclusions.

- [ ] **Step 2: Run the gate against the CURRENT tree — observe the one residual error**

Run: `npx tsc --noEmit -p tsconfig.build.json`
Expected (BEFORE Task 2): **exactly one** error —
```
src/hooks/useChromeSurfaces.tsx(19,79): error TS2503: Cannot find namespace 'JSX'.
```
This is the lone production-source error; everything else is excluded. Task 2 fixes it. (This step proves the scope is correct: no test/fixture error leaks through.)

- [ ] **Step 3: Add the `typecheck` npm script**

In `package.json`, inside `"scripts"`, add after `"test": "vitest run"` (add a comma to the `test` line):

```json
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.build.json"
```

- [ ] **Step 4: Do NOT yet expect green** — the gate is green only after Task 2

Run: `npm run typecheck`
Expected: still the single `useChromeSurfaces.tsx` error. **Leave it failing for now** — Task 2 is the fix. (Committing Task 1 + Task 2 together is fine; this task's deliverable is the scoped config + script, proven to isolate exactly one fixable error.)

- [ ] **Step 5: Commit (with Task 2)** — see Task 2 Step 4 for the combined commit.

---

### Task 2: Fix the lone production type error (`JSX.Element` → `React.JSX.Element`)

**Files:**
- Modify: `src/hooks/useChromeSurfaces.tsx` (line 19)

**Interfaces:** none (a one-token type-annotation fix; the runtime value is unchanged).

**Why this is in scope and safe:** Under TypeScript's automatic-JSX runtime (`"jsx": "react-jsx"` in `tsconfig.json`) the **global** `JSX` namespace is not in scope; the React type for a returned element is `React.JSX.Element` (or `ReactElement`). The sibling file `src/components/RedirectBar.tsx:19` already uses the correct `React.JSX.Element`. `useChromeSurfaces.tsx:19` uses the bare `JSX.Element`, which is why it's the only production-source `tsc` error. This is a pure type annotation — `ChromeSurfaceProvider` returns the same JSX value at runtime — so there is **no behavior change** and no autopilot impact. This is the single source edit Global Constraint 6(a) permits.

- [ ] **Step 1: Confirm the current line**

Read `src/hooks/useChromeSurfaces.tsx` line 19. It is:

```tsx
export function ChromeSurfaceProvider({ children }: { children: ReactNode }): JSX.Element {
```

Note line 1 already imports React's hooks from `'react'` but the file does **not** import the `React` default namespace. Two options — pick the one matching the file's existing imports:

- (Preferred, no new import) change the return type to `ReactNode`'s sibling **`ReactElement`**, importing it from the existing `'react'` import.
- (Mirrors `RedirectBar.tsx`) add `import React from 'react';` and use `React.JSX.Element`.

Use the preferred option (no default-React import; matches the file's named-import style).

- [ ] **Step 2: Edit the import + return type**

Change line 2 from:

```tsx
import type { ReactNode } from 'react';
```

to:

```tsx
import type { ReactElement, ReactNode } from 'react';
```

Change line 19 from:

```tsx
export function ChromeSurfaceProvider({ children }: { children: ReactNode }): JSX.Element {
```

to:

```tsx
export function ChromeSurfaceProvider({ children }: { children: ReactNode }): ReactElement {
```

- [ ] **Step 3: Run the scoped gate — now green**

Run: `npm run typecheck`
Expected: **no output, exit 0** (zero errors).
Also run the existing suite to prove no behavior changed:
Run: `npm test`
Expected: PASS — all node + jsdom projects green (the compositor tests `src/hooks/useChromeSurfaces.test.tsx` and `src/autopilot/compositor.test.tsx` still pass; the return-type change is type-only).

- [ ] **Step 4: Commit Tasks 1 + 2 together**

```bash
git add tsconfig.build.json package.json src/hooks/useChromeSurfaces.tsx
git commit -m "ci: scoped tsc --noEmit gate (tsconfig.build.json) + fix lone JSX.Element type error"
```

---

### Task 3: ESLint flat config (baseline-clean) + Prettier

**Files:**
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `package.json` (devDependencies + `lint`/`lint:fix`/`format`/`format:check` scripts)

**Interfaces:**
- Produces: `npm run lint` (ESLint over `src` + `shared` + `scripts`), `npm run format:check` (Prettier `--check`), `npm run format` (Prettier `--write`), `npm run lint:fix` (ESLint `--fix`).

**Baseline strategy (decision):** ESLint has never run on this tree (187 `.ts`/`.tsx` source files + the `scripts/*.mjs`). To guarantee the gate is **green on first run** without a giant code-churn pass, the config uses the **non-type-aware** recommended sets (`@eslint/js` recommended + `typescript-eslint` *recommended*, NOT `recommendedTypeChecked` — the latter needs full type info and would flood the existing code with `no-unsafe-*` findings). A small set of rules that the existing code legitimately trips (e.g. `@typescript-eslint/no-explicit-any` in IPC-boundary casts, `no-empty` in catch fall-throughs) are downgraded to `'warn'` or `'off'` so they don't *fail* CI, while still surfacing. **`eslint-config-prettier` is applied last** to turn off every formatting rule (Prettier owns formatting; ESLint owns correctness). After the config is in place, Step 4 runs ESLint against the real tree and the implementer triages any remaining **errors** to zero (downgrade or fix), so the committed gate starts green — this is verified, not assumed.

- [ ] **Step 1: Add the devDependencies**

Run (installs the latest verified versions; pins them into `package.json`):

```bash
npm install --save-dev \
  eslint@^10 \
  @eslint/js@^10 \
  typescript-eslint@^8 \
  eslint-plugin-react-hooks@^7 \
  eslint-plugin-react-refresh@^0.5 \
  globals@^17 \
  prettier@^3 \
  eslint-config-prettier@^10
```

> Versions verified available on npm at plan time: `eslint` 10.5.0, `@eslint/js` 10.0.1, `typescript-eslint` 8.62.0, `eslint-plugin-react-hooks` 7.1.1, `eslint-plugin-react-refresh` 0.5.3, `globals` 17.7.0, `prettier` 3.8.4, `eslint-config-prettier` 10.1.8. The `^` ranges let Dependabot bump them (the repo already groups npm minors). This also updates `package-lock.json` — commit it.

- [ ] **Step 2: Create the flat config**

Create `eslint.config.mjs` at the repo root (ESM — `package.json` has no `"type":"module"`, so a flat config must be `.mjs` to use `import`/`export`):

```js
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
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
```

- [ ] **Step 3: Create the Prettier config + ignore**

Create `.prettierrc.json` (matches the existing code style — 2-space indent, single quotes, semicolons, trailing commas, 100-col, as seen in `src/lib/contentLayout.ts` / `eslint.config.mjs` above):

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always"
}
```

Create `.prettierignore`:

```
dist
out
node_modules
target
src-tauri/target
src-tauri/gen
scripts/autopilot/fixture
sync-server
package-lock.json
*.AppImage
```

- [ ] **Step 4: Run ESLint against the real tree and DRIVE ERRORS TO ZERO**

Run: `npx eslint .`
Expected on first run: some **warnings** (acceptable) and possibly a few **errors**. The gate (`npm run lint`, Step 6) fails on errors, not warnings — so triage every *error*:
- If an error is a genuine bug, fix it.
- If it's a false positive for this codebase's style, downgrade that rule to `'warn'` in `eslint.config.mjs` (add it to the appropriate `rules` block with a one-line comment).
Re-run `npx eslint .` until it reports **0 errors** (warnings allowed). Record the warning count in the commit message so drift is visible.

> Do NOT add `--max-warnings 0` to the gate yet — warnings are the migration backlog; failing on them would block this enabler. A follow-up (sub-project B docs note) can tighten to `--max-warnings 0` once the backlog is burned down.

- [ ] **Step 5: Run Prettier check and normalize**

Run: `npx prettier --check .`
Expected: it will list files that don't match (the repo has never been Prettier-formatted). Two acceptable resolutions:
- (Chosen) Run `npx prettier --write .` once to normalize all non-ignored files to the configured style, making `--check` green. This is a **formatting-only** change (no logic). Verify nothing broke: `npm test` (Expected: PASS) and `npm run typecheck` (Expected: PASS).
- Re-run `npx prettier --check .` → Expected: "All matched files use Prettier code style!" (exit 0).

> The `prettier --write` normalization is a large but mechanical diff. Keep it in **its own commit** (Step 7) so review can see it is formatting-only, separate from the config. If the diff is undesirably large, an alternative is to scope Prettier to new files only — but the spec asks for a real gate, so normalizing the tree once is the honest choice.

- [ ] **Step 6: Add the npm scripts**

In `package.json` `"scripts"`, add (after `typecheck`):

```json
    "typecheck": "tsc --noEmit -p tsconfig.build.json",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
```

Verify the gate scripts pass:
Run: `npm run lint` → Expected: exit 0 (0 errors; warnings OK).
Run: `npm run format:check` → Expected: exit 0 ("All matched files use Prettier code style!").

- [ ] **Step 7: Commit (config separate from the format-normalize)**

```bash
# Commit A: the tooling + config + package scripts/deps.
git add eslint.config.mjs .prettierrc.json .prettierignore package.json package-lock.json
git commit -m "ci: add ESLint (flat config) + Prettier with a baseline-clean ruleset"

# Commit B: the one-time formatting normalization (formatting only, no logic change).
git add -A
git commit -m "style: prettier --write the tree once so format:check passes (no logic change)"
```

---

### Task 4: `cargo fmt --check` gate (one-time normalize first)

**Files:**
- Create: `rustfmt.toml`
- (Possibly) Modify: many files under `src-tauri/src/**` — **formatting only**, from a single `cargo fmt` run.

**Interfaces:**
- Produces: a deterministic `cargo fmt --check --manifest-path src-tauri/Cargo.toml` gate.

**Baseline strategy:** rustfmt has likely never been enforced, so `cargo fmt --check` may report diffs on existing code. The standard way to introduce the gate without it failing on day one is a **one-time `cargo fmt` normalization commit**: run the formatter once (it only reflows whitespace/wrapping — no semantics), commit that, and from then on the `--check` gate stays green. `rustfmt.toml` pins the edition so CI and a dev box format identically.

- [ ] **Step 1: Pin rustfmt config**

Create `rustfmt.toml` at the repo root (rustfmt looks upward from the crate, finding the repo-root file; placing it at root keeps formatting uniform if `sync-server/` is later added):

```toml
# Deterministic rustfmt across CI and dev. Defaults are intentional — we only pin the
# edition so wrapping/derive-formatting matches src-tauri/Cargo.toml's `edition = "2021"`.
edition = "2021"
```

- [ ] **Step 2: Observe the current state**

Run: `cargo fmt --check --manifest-path src-tauri/Cargo.toml`

> If the active toolchain is missing the component, install it: `rustup component add rustfmt`. (Verified at plan time: a `rustfmt-x86_64-unknown-linux-gnu` component is installed for *a* toolchain but not necessarily the active `stable`; CI's `dtolnay/rust-toolchain@stable` includes `rustfmt` by default.)

Expected: either exit 0 (already conformant — then skip Step 3) **or** a non-zero exit with a diff (the existing code needs formatting — proceed to Step 3). **Do not assume which** — read the real output.

- [ ] **Step 3: One-time normalize (only if Step 2 showed diffs)**

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml`
This rewrites the affected `src-tauri/src/**.rs` files to rustfmt's canonical form (whitespace/wrapping only — no token/semantic change).
Verify nothing broke semantically:
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — the same 119 tests, green (formatting can't change behavior).

- [ ] **Step 4: Confirm the gate is now green**

Run: `cargo fmt --check --manifest-path src-tauri/Cargo.toml`
Expected: **exit 0**, no diff.

- [ ] **Step 5: Commit**

```bash
git add rustfmt.toml src-tauri/src
git commit -m "ci: cargo fmt --check gate + one-time rustfmt normalization (formatting only)"
```

> If Step 2 was already exit 0, the commit is just `git add rustfmt.toml && git commit -m "ci: pin rustfmt config for cargo fmt --check gate"`.

---

### Task 5: `cargo clippy` gate (triage-then-strict)

**Files:**
- (Possibly) Modify: files under `src-tauri/src/**` — mechanical clippy fixes and/or `#[allow]` annotations as needed to reach a clean run.

**Interfaces:**
- Produces: a `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` gate that passes on the current tree.

**Baseline strategy (decision):** The spec wants `cargo clippy -D warnings`. Existing code has never been clippy-gated, so a cold `-D warnings` run will almost certainly fail on lints like `clippy::needless_return`, `clippy::redundant_clone`, etc. The plan does **not** guess the findings — it runs clippy, then resolves each finding by (a) applying the mechanical fix (`cargo clippy --fix` for the autofixable ones) or (b) adding a scoped `#[allow(clippy::<lint>)]` with a one-line justification where the lint is a false positive for this code (e.g. the `!Send` engine thread patterns, the unsafe COM blocks). Only after the local run is clean is the `-D warnings` flag locked into CI — so the committed gate is green by construction, verified not assumed.

- [ ] **Step 1: Cold run to enumerate findings (warnings allowed)**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets 2>&1 | tee /tmp/clippy-baseline.txt`

> Install the component if the active toolchain lacks it: `rustup component add clippy`. CI's `dtolnay/rust-toolchain@stable` includes clippy.

Expected: a list of `warning:`/`note:` findings (count them: `grep -c '^warning' /tmp/clippy-baseline.txt`). This is the triage backlog. **Read it — do not assume it's empty.**

- [ ] **Step 2: Apply the safe autofixes**

Run: `cargo clippy --fix --manifest-path src-tauri/Cargo.toml --all-targets --allow-dirty --allow-staged`
This applies clippy's machine-applicable suggestions only (idiomatic rewrites — `cargo` guarantees these compile). Re-run Step 1's command to see what remains.

- [ ] **Step 3: Resolve the rest by fix or scoped allow**

For each remaining finding:
- If it's a clear improvement and safe, hand-fix it.
- If it's a false positive for an intentional pattern (the dedicated `!Send` adblock-engine thread, the `unsafe` WebView2 COM in `adblock_win.rs`, the JNI up-call patterns), add a **scoped** allow at the narrowest site, e.g.:

```rust
#[allow(clippy::too_many_arguments)] // linux_layout::layout mirrors the GtkFixed call shape
```

Avoid a crate-wide blanket allow; keep allows local + commented so they document intent.

- [ ] **Step 4: Verify the strict gate is green**

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: **exit 0** (no warnings → none promoted to errors).
Then confirm behavior unchanged:
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS (119 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src
git commit -m "ci: make src-tauri clippy-clean (autofixes + scoped #[allow]s) for the -D warnings gate"
```

> If Step 1 showed zero findings, there is nothing to commit here — clippy is already clean — and the gate flag is simply added in Task 6. Note that in the commit log / Task 6 PR description.

---

### Task 6: Wire the gates into `ci.yml` (web + rust jobs)

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the npm scripts from Tasks 1+3 (`typecheck`, `lint`, `format:check`) and the cargo gates from Tasks 4+5; the unchanged `npm test` + `node scripts/check-npm-audit.mjs`.
- Produces: a `web` job and a `rust` job, both gating every PR + the weekly schedule + manual dispatch (the existing triggers — unchanged).

- [ ] **Step 1: Replace the single `verify` job with two jobs**

Edit `.github/workflows/ci.yml`. Keep the header (`name`, the `on:` triggers, `permissions`, `concurrency`) **unchanged**. Replace the entire `jobs:` block (the current single `verify` job, lines 22-38) with:

```yaml
jobs:
  # Fast Node gate: type-check (scoped), lint, format, unit tests, supply-chain audit.
  web:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - name: Type-check (production source, scoped)
        run: npm run typecheck
      - name: ESLint
        if: ${{ !cancelled() }}
        run: npm run lint
      - name: Prettier (format check)
        if: ${{ !cancelled() }}
        run: npm run format:check
      - name: Unit tests (node + jsdom)
        if: ${{ !cancelled() }}
        run: npm test
      - name: Dependency audit gate (high/critical)
        if: ${{ !cancelled() }}
        run: node scripts/check-npm-audit.mjs

  # Rust gate for the src-tauri crate: format, lint, the 119 unit tests, supply-chain audit.
  rust:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      # src-tauri links webkit2gtk on Linux; cargo test/clippy compile the crate, so the
      # native build deps must be present (mirrors tauri-build-check.yml's Linux deps).
      - name: Install Linux dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            libxdo-dev \
            patchelf
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt
      - name: Cache cargo
        uses: actions/cache@v5
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            src-tauri/target
          key: ci-rust-${{ hashFiles('src-tauri/Cargo.lock') }}
      - name: cargo fmt --check
        run: cargo fmt --check --manifest-path src-tauri/Cargo.toml
      - name: cargo clippy (-D warnings)
        if: ${{ !cancelled() }}
        run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
      - name: cargo test
        if: ${{ !cancelled() }}
        run: cargo test --manifest-path src-tauri/Cargo.toml
```

> Notes grounding the YAML in this repo's reality:
> - The `web` job is the old `verify` job plus the three new Node steps; `npm test` + the npm-audit gate are byte-identical to today's.
> - The `rust` job installs the **same** Linux webkit deps as `tauri-build-check.yml` (without the GStreamer codec packages — `cargo test`/`clippy` only need the crate to *compile/link*, not to bundle media). `cargo clippy --all-targets` compiles the test targets too, so it also implicitly type-checks the Rust test code.
> - `cargo test` for `src-tauri` builds the desktop `cfg(target_os = "linux")` paths only; the Android/Windows/macOS `#[cfg]` blocks are not compiled here (they're covered by `tauri-build-check.yml`'s per-OS matrix). The 119 tests live in the platform-agnostic + Linux modules, so this gates them.
> - `if: ${{ !cancelled() }}` on later steps mirrors the existing audit step so one failure still reports the others (don't short-circuit on the first red gate).
> - The `rust` job has **no** `timeout-minutes: 15` — a cold cargo compile of `src-tauri` exceeds 15 min; `30` matches the heavier build-check job's headroom while the cargo cache makes warm runs fast.

- [ ] **Step 2: Add the optional `cargo audit` gate (decision: include it)**

The spec marks `cargo-audit` optional "for the crypto/keyring surface." The crate pulls `chacha20poly1305`, `argon2`, `ed25519-dalek`, `keyring`, `rustls`, `reqwest` — a real crypto/network surface npm-audit can't see. **Include it**, but make it **non-blocking initially** (advisory) so a transitive Rust advisory we can't immediately fix doesn't wedge the always-on gate — matching how npm-audit started. Add, at the end of the `rust` job's `steps:`:

```yaml
      - name: cargo audit (advisory — crypto/keyring/TLS surface)
        if: ${{ !cancelled() }}
        continue-on-error: true
        run: |
          cargo install cargo-audit --locked
          cargo audit --file src-tauri/Cargo.lock
```

> `continue-on-error: true` makes it report findings without failing the build (advisory). To promote it to a hard gate later, drop that line and add a `src-tauri/.cargo/audit.toml` ignore-list for any consciously-accepted advisory (created in Task 7 Step 2, mirroring `.audit-allowlist.json`'s justify-in-commit pattern). `--file src-tauri/Cargo.lock` points it at the app's lockfile (the repo has no root Cargo workspace; `sync-server/` has its own lockfile and is out of scope).

- [ ] **Step 3: Validate the workflow YAML locally**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Expected: `YAML OK` (well-formed). (If `actionlint` is available, also run `actionlint .github/workflows/ci.yml` for action-schema validation — optional, not required.)

- [ ] **Step 4: Locally reproduce each gate green (the spec's acceptance criterion)**

Run each, expecting exit 0:
```bash
npm run typecheck
npm run lint
npm run format:check
npm test
node scripts/check-npm-audit.mjs
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all green. This is the "CI runs all gates green on a clean checkout" acceptance, reproduced locally.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate PRs on tsc/eslint/prettier + cargo fmt/clippy/test (+ advisory cargo audit)"
```

---

### Task 7: Prove the gates actually catch regressions + update living docs

**Files:**
- Create: `src-tauri/.cargo/audit.toml` (the cargo-audit ignore-list scaffold, for when the gate is promoted to blocking)
- Modify: `.github/CLAUDE.md` (document the new jobs/gates)

**Interfaces:** none (verification + docs).

The spec's second acceptance criterion: "a deliberately-broken Rust test / type error / lint fails CI locally-reproduced." This task **proves the teeth** of each gate with a throwaway break (never committed), then documents.

- [ ] **Step 1: Prove the `tsc` gate fails on a type error**

Temporarily add a type error to a production file, e.g. in `src/lib/contentLayout.ts` change `width: s.sidebarWidth,` to `width: 'oops',` (a `string` where a `number` is required).
Run: `npm run typecheck`
Expected: FAIL with a `TS2322`/type error on that line.
**Revert** the change (`git checkout src/lib/contentLayout.ts`). Re-run `npm run typecheck` → Expected: green.

- [ ] **Step 2: Prove the ESLint gate fails on a lint error**

Temporarily introduce a hard ESLint error (not a downgraded-to-warn rule), e.g. add a line `const x = 1; const x = 2;` (a `no-redeclare`/`no-const-assign` class error) to a `src/` file, or a bare `debugger;` statement (`no-debugger` is an error in `js.configs.recommended`).
Run: `npm run lint`
Expected: FAIL with the rule violation (non-zero exit).
**Revert**. Re-run → green.

- [ ] **Step 3: Prove the Prettier gate fails on misformatting**

Temporarily mangle formatting in a `src/` file (e.g. collapse an object to one line with no spaces).
Run: `npm run format:check`
Expected: FAIL — lists the file as not matching Prettier style.
**Revert** (or `npm run format`). Re-run → green.

- [ ] **Step 4: Prove the Rust gates fail**

Test (broken assertion): temporarily change a passing assertion in some `src-tauri/src/*.rs` `#[test]` to a false one (e.g. flip an `assert!(content_visible(...))` to `assert!(!content_visible(...))`).
Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: FAIL (that test red). **Revert**, re-run → green.

Clippy: temporarily add an obvious lint, e.g. `let _x: Vec<i32> = vec![]; if _x.len() == 0 {}` (`clippy::len_zero`) in a function body.
Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
Expected: FAIL (warning promoted to error). **Revert**, re-run → green.

Fmt: temporarily add mis-indented Rust (e.g. random extra spaces).
Run: `cargo fmt --check --manifest-path src-tauri/Cargo.toml`
Expected: FAIL with a diff. **Revert**, re-run → green.

> None of these breaks are committed — they are one-off verifications of each gate's teeth, exactly as the spec's acceptance demands ("a deliberately-broken … fails CI locally-reproduced").

- [ ] **Step 5: Create the cargo-audit ignore scaffold (for promotion to blocking)**

Create `src-tauri/.cargo/audit.toml`:

```toml
# cargo-audit config. The gate runs advisory-only (continue-on-error) today; to promote
# it to blocking, drop `continue-on-error` in ci.yml and list any consciously-accepted
# advisory id here WITH justification in the commit — the Rust analog of
# scripts/.audit-allowlist.json. Empty = nothing accepted yet.
[advisories]
ignore = []
```

- [ ] **Step 6: Update `.github/CLAUDE.md`**

In `.github/CLAUDE.md`, replace the `ci.yml` bullet (the one starting **"`ci.yml`** (CI) — the always-on gate.") with:

```markdown
- **`ci.yml`** (CI) — the always-on gate. Runs on every PR, weekly (Mon 06:17 UTC),
  and on demand. Ubuntu only; two parallel jobs:
  - **`web`**: `npm ci` → `npm run typecheck` (scoped `tsc --noEmit` via
    `tsconfig.build.json`, which excludes test files + `src/testFixtures` to skip the
    known test-only type noise) → `npm run lint` (ESLint flat config, errors fail /
    warnings are the migration backlog) → `npm run format:check` (Prettier) →
    `npm test` (vitest node + jsdom) → `node scripts/check-npm-audit.mjs`.
  - **`rust`**: installs the webkit2gtk build deps, then
    `cargo fmt --check` → `cargo clippy -- -D warnings` → `cargo test` (the 119
    `src-tauri` unit tests, Linux-cfg paths) for `src-tauri/Cargo.toml`, plus an
    advisory (non-blocking) `cargo audit` over the crypto/keyring/TLS deps.
  The standalone `sync-server/` crate is NOT gated here (separate non-workspace crate).
```

- [ ] **Step 7: Commit**

```bash
git add src-tauri/.cargo/audit.toml .github/CLAUDE.md
git commit -m "ci: cargo-audit ignore scaffold + document the new CI gates in .github/CLAUDE.md"
```

---

### Task 8: Final full-gate verification

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run the entire web gate set clean**

```bash
npm run typecheck && npm run lint && npm run format:check && npm test && node scripts/check-npm-audit.mjs
```
Expected: every command exit 0.

- [ ] **Step 2: Run the entire rust gate set clean**

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml \
  && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings \
  && cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: every command exit 0 (119 Rust tests pass).

- [ ] **Step 3: Confirm the autopilot drift guards still pass (no catalog/screen change was made)**

Run: `npx vitest run src/autopilot/coverage.test.ts src/autopilot/interactions.coverage.test.ts`
Expected: PASS — this sub-project added no IPC channel / screen / control, so the drift guards are unaffected. (If they fail, something unrelated to A regressed — investigate, do not paper over.)

- [ ] **Step 4: (Conditional) live-autopilot sanity for the rustfmt/clippy normalize**

If Task 4 (rustfmt normalize) or Task 5 (clippy fixes) modified any file under `src-tauri/src/` that participates in the live autopilot's runtime path (anything in `nav.rs`, `view.rs`, `linux_layout.rs`, `adblock*.rs`, `redirect_guard.rs`, `tabs.rs`), run the live autopilot **once** to confirm the formatting/lint changes altered no behavior:

Run: `bash scripts/autopilot/run-autopilot.sh`
Expected: `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`.

> Per Global Constraint 3, the live autopilot is **not** mandated for this no-runtime-change sub-project, but a rustfmt/clippy pass that touched runtime modules is exactly when a one-time confirmation is cheap insurance. If Tasks 4/5 only touched non-runtime modules (e.g. `crypto.rs`, `sync_*.rs`, pure helpers) or made no source change at all, skip this step and note that in the PR.

- [ ] **Step 5: Final state confirmation**

Run: `git status`
Expected: clean working tree (all gate-verification breaks from Task 7 were reverted; only the intended commits remain). Confirm the commit log shows the Task 1-7 commits and nothing stray.

---

## Self-Review

**1. Spec coverage (sub-project A acceptance criteria + §6).**
- *"Add gates to `ci.yml`: cargo test, tsc --noEmit (scoped), cargo clippy -D warnings + cargo fmt --check, ESLint + Prettier, optionally cargo-audit"* → all present: `cargo test` (Task 6 rust job + Tasks 4/5 prove it green), scoped `tsc` (Tasks 1-2, scope **verified** to isolate exactly one fixable error), clippy `-D warnings` (Task 5 triage-then-strict + Task 6), `cargo fmt --check` (Task 4 normalize-first), ESLint flat config + Prettier (Task 3 baseline-clean), `cargo audit` included as advisory (Task 6 Step 2).
- *"the ~119 Rust tests run locally-only today — verify where they live"* → **verified**: `grep` found 119 `#[test]` across 20 modules in `src-tauri/src/` (no root workspace; `sync-server/` is a separate crate, correctly excluded).
- *"scope it to avoid the known pre-existing test-file type noise — investigate tsconfig and decide a non-failing scope"* → **investigated**: full `tsc` = 29 errors / 22 files; all are test/fixture files plus one production wart (`useChromeSurfaces.tsx`). Decision: `tsconfig.build.json` excludes `**/*.test.ts(x)` + `src/testFixtures`; the single production wart is fixed (Task 2, a no-behavior one-token change). Probe-confirmed this leaves the scoped gate at **zero** errors.
- *"decide how to keep clippy/eslint from failing on the existing code (baseline-clean ruleset or -W then tighten)"* → explicit per gate: ESLint = non-type-aware recommended + downgrade-to-warn for the rules existing code trips + triage-to-zero-errors (Task 3); clippy = `--fix` autofixes + scoped `#[allow]` triage **before** flipping `-D warnings` (Task 5); fmt = one-time normalize commit (Task 4). None assumes the existing code already conforms.
- *§6 cross-cutting* → Global Constraints section copies all four rules and resolves each: no IPC (1), no autopilot catalog change (2), gate = `npm test` + all new gates green, live autopilot only conditionally (3), CI is platform-agnostic so no parity gap (4); living docs updated (Task 7 Step 6).
- *No existing eslint/prettier config* → **confirmed** by directory scan (no `eslint.config.*`, `.eslintrc*`, `.prettierrc*`, `rustfmt.toml`, `clippy.toml`); the plan creates them.

**2. Placeholder scan.** No "TBD"/"add appropriate config"/"handle edge cases". Every config file has its full literal contents; every npm/cargo command is real and exact; version numbers are the actual latest verified on npm at plan time; the YAML is complete and was structured against the real current `ci.yml`. The two places the plan says "possibly modify many files" (Tasks 4/5) are honest — I could not run rustfmt/clippy on the active toolchain to enumerate the diff, so the plan instructs the implementer to **run the tool and read the real output** before/after, with a concrete fix strategy either way (this is "verify, don't guess," not a deferral). The "deliberately break it" steps (Task 7) use concrete, named breaks per gate.

**3. Consistency.** npm scripts defined in Tasks 1/3 (`typecheck`, `lint`, `format:check`) are exactly the ones invoked by the `web` job (Task 6) and the verification (Tasks 7/8). The `tsconfig.build.json` name is used identically in the script, the workflow, and the docs. The cargo gate commands use the same `--manifest-path src-tauri/Cargo.toml` everywhere. The advisory `cargo audit` (`continue-on-error`) is consistent with the `src-tauri/.cargo/audit.toml` scaffold's "promote later" note. The `.github/CLAUDE.md` rewrite (Task 7) matches the actual job/step set in the Task 6 YAML. The base `tsconfig.json` `include`/`exclude` interaction with `extends` (no merge) is correctly handled by fully re-specifying them in `tsconfig.build.json`.
