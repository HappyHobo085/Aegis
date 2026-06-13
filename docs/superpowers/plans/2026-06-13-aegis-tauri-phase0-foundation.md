# Aegis Tauri Phase 0 — Foundation & Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Tauri 2 app on Linux that reuses the existing React renderer and navigates a real content webview to arbitrary URLs — proving the cross-platform browser shell before any ad-blocking work.

**Architecture:** A Tauri window hosts two webviews — a *chrome* webview (the reused `src/` React UI) and a *content* webview (the browsed page). The renderer's single backend seam (`src/lib/ipcClient.ts`, which today is `window.aegis`) is reimplemented against Tauri `invoke()`/`listen()`. Phase 0 wires `nav.*` and `view.*` for real; all other `AegisApi` namespaces are typed stubs returning defaults so the UI renders without crashing (real backends land in Phases 2–3).

**Tech Stack:** Tauri 2 (Rust core), `wry` webviews, Vite (renderer build), `@tauri-apps/api` (invoke/listen), existing React 19 + TS renderer.

**Scope note:** This plan adapts strict TDD where it doesn't fit — scaffolding/integration tasks are verified by *running and observing* (build succeeds, window opens, page loads), and pure logic (URL normalization) gets real `cargo test` TDD. Every task states an exact command and the expected observation.

**API-honesty note:** Exact `tauri::webview` multi-webview method signatures vary across 2.x minor versions and MUST be confirmed against the installed crate docs (`cargo doc --open -p tauri` or docs.rs for the resolved version) before writing the Rust in Tasks 6–7. Where this plan shows Rust webview code, treat it as the intended shape to confirm, not a verbatim signature.

---

## File structure

**Created:**
- `src-tauri/Cargo.toml` — Rust crate manifest (tauri, serde, tauri-plugin-*).
- `src-tauri/tauri.conf.json` — Tauri app config (identifier, windows, bundle, security/CSP).
- `src-tauri/build.rs` — `tauri_build::build()`.
- `src-tauri/src/main.rs` — binary entry → `aegis_lib::run()`.
- `src-tauri/src/lib.rs` — Tauri `Builder`, command registration, window/webview setup.
- `src-tauri/src/nav.rs` — content-webview navigation commands + state events.
- `src-tauri/src/view.rs` — content-webview bounds/visibility commands.
- `src-tauri/src/url_input.rs` — URL/search normalization (TDD).
- `src-tauri/capabilities/default.json` — Tauri capabilities (IPC allowlist).
- `vite.config.ts` — plain Vite build of the React renderer for Tauri.
- `src/lib/ipcClient.tauri.ts` — `AegisApi` implemented over Tauri invoke/listen.
- `src/lib/tauriInvoke.ts` — thin typed wrappers around `invoke`/`listen`.

**Modified:**
- `package.json` — add `@tauri-apps/cli`, `@tauri-apps/api`; add `tauri:*` + renderer scripts.
- `.gitignore` — add `src-tauri/target/`, `dist/`.
- `src/lib/ipcClient.ts` — switch to re-export the platform client (alias-resolved); Electron path unchanged.

---

## Task 1: System prerequisites & Tauri tooling

**Files:**
- Modify: `package.json` (devDependencies + dependency)

- [ ] **Step 1: Install the Fedora webkit/build system deps (USER-run, needs sudo)**

The user runs this in the session (it needs root; rustup already installed Rust user-side):

```
! sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxdo-devel && sudo dnf group install -y c-development
```

Expected: dnf completes; packages installed.

- [ ] **Step 2: Verify the native toolchain is complete**

Run: `source "$HOME/.cargo/env"; cargo --version && pkg-config --exists webkit2gtk-4.1 && echo "webkit OK"`
Expected: `cargo 1.96.0 …` then `webkit OK`. (If `webkit2gtk-4.1` missing, Step 1 didn't complete.)

- [ ] **Step 3: Add Tauri CLI + API to the project**

Run: `npm install -D @tauri-apps/cli@^2 && npm install @tauri-apps/api@^2`
Then: `npx tauri --version`
Expected: prints `tauri-cli 2.x`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(tauri): add Tauri CLI + API deps for the cross-platform migration"
```

---

## Task 2: Plain-Vite renderer build for Tauri

The renderer is built today by `electron-vite` (Electron-specific). Tauri needs a standalone Vite dev server + build of `src/main.tsx`. This task adds that without touching the Electron build.

**Files:**
- Create: `vite.config.ts`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Standalone Vite build of the React renderer for the Tauri shell.
// Tauri sets TAURI_ENV_* during its build; we keep config minimal and let
// Tauri's beforeBuildCommand invoke `vite build`.
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src'),
  publicDir: resolve(__dirname, 'src/public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: { port: 5174, strictPort: true },
  // The Tauri build picks the Tauri client via this alias (see Task 4).
  resolve: { alias: { './ipcClient': resolve(__dirname, 'src/lib/ipcClient.tauri.ts') } },
});
```

- [ ] **Step 2: Provide an `index.html` Vite entry for the renderer**

The renderer needs an HTML entry that loads `main.tsx`. Create `src/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Aegis</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

(Note: confirm the Electron build does not also consume `src/index.html`; electron-vite uses its own entry config, so this file is Tauri/Vite-only. If a conflict appears, move the Vite root to a dedicated folder.)

- [ ] **Step 3: Add renderer scripts to `package.json`**

```jsonc
// inside "scripts"
"dev:renderer": "vite",
"build:renderer": "vite build",
```

- [ ] **Step 4: Verify the renderer bundles**

Run: `npm run build:renderer`
Expected: `dist/index.html` + hashed JS/CSS assets emitted, exit 0. (It bundles even though `window.aegis` is undefined at runtime — that's fixed in Tasks 4–5.)

- [ ] **Step 5: Commit**

```bash
git add vite.config.ts src/index.html package.json
git commit -m "build(tauri): standalone Vite build for the reused React renderer"
```

---

## Task 3: Scaffold `src-tauri` with a hello-world window

Prove Tauri compiles and launches on this machine *before* wiring the real renderer.

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- Modify: `.gitignore`, `package.json` (scripts)

- [ ] **Step 1: Generate the scaffold via the CLI (then hand-tune config)**

Run: `npx tauri init --ci --app-name Aegis --window-title Aegis --frontend-dist ../dist --dev-url http://localhost:5174 --before-dev-command "npm run dev:renderer" --before-build-command "npm run build:renderer"`
Expected: creates `src-tauri/` with `Cargo.toml`, `tauri.conf.json`, `build.rs`, `src/main.rs`, `src/lib.rs`.

- [ ] **Step 2: Set the identifier and bundle metadata in `src-tauri/tauri.conf.json`**

Ensure these keys (merge into generated file):

```jsonc
{
  "productName": "Aegis",
  "identifier": "com.aegis.browser",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5174",
    "beforeDevCommand": "npm run dev:renderer",
    "beforeBuildCommand": "npm run build:renderer"
  },
  "app": {
    "windows": [{ "title": "Aegis", "width": 1280, "height": 800, "label": "main" }],
    "security": { "csp": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'" }
  },
  "bundle": { "active": true, "targets": ["appimage", "deb"], "icon": ["icons/icon.png"] }
}
```

(Confirm exact schema against the installed Tauri version: `npx tauri --help` / the generated file's existing shape. Icons: copy `build/icon.png` → `src-tauri/icons/icon.png`, or run `npx tauri icon build/icon.png`.)

- [ ] **Step 3: Add `tauri:*` scripts to `package.json`**

```jsonc
"tauri": "tauri",
"tauri:dev": "tauri dev",
"tauri:build": "tauri build",
```

- [ ] **Step 4: Ignore build artifacts**

Add to `.gitignore`:
```
src-tauri/target/
dist/
```

- [ ] **Step 5: Build the Rust core once (compiles the dependency tree — slow first time)**

Run: `cd src-tauri && source "$HOME/.cargo/env" && cargo build && cd ..`
Expected: `Finished` with no errors (first build downloads + compiles many crates; minutes).

- [ ] **Step 6: Launch hello-world (temporarily point at generated default UI)**

For this step only, verify with Tauri's generated frontend or a placeholder `dist/index.html` (`<h1>Aegis Tauri OK</h1>`). Run: `xvfb-run -a npm run tauri:dev` (or run on the desktop session).
Expected: an Aegis window opens and renders the placeholder. Close it.

- [ ] **Step 7: Commit**

```bash
git add src-tauri .gitignore package.json && git rm --cached -r src-tauri/target 2>/dev/null; git commit -m "feat(tauri): scaffold src-tauri Rust core; hello-world window launches"
```

---

## Task 4: The seam — `AegisApi` over Tauri (stubs + real plumbing)

Reimplement the renderer's one backend dependency against Tauri. Data namespaces return defaults (so hooks don't throw); `nav`/`view` call real commands (wired in Tasks 6–7).

**Files:**
- Create: `src/lib/tauriInvoke.ts`, `src/lib/ipcClient.tauri.ts`
- Modify: `src/lib/ipcClient.ts`

- [ ] **Step 1: Thin typed Tauri transport (`src/lib/tauriInvoke.ts`)**

```ts
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Call a Rust command by its IPC channel name (e.g. 'nav.navigate'). */
export function call<T>(channel: string, args?: Record<string, unknown>): Promise<T> {
  // Tauri command names can't contain '.', so we route everything through one
  // `ipc` command that dispatches on `channel`. Rust side: #[command] ipc(channel, payload).
  return invoke<T>('ipc', { channel, payload: args ?? {} });
}

/** Subscribe to a Rust-emitted event; returns an unsubscribe fn (sync-usable). */
export function on<T>(event: string, cb: (payload: T) => void): () => void {
  let un: UnlistenFn | null = null;
  let cancelled = false;
  listen<T>(event, (e) => cb(e.payload)).then((u) => {
    if (cancelled) u();
    else un = u;
  });
  return () => {
    cancelled = true;
    if (un) un();
  };
}
```

- [ ] **Step 2: Implement `AegisApi` (`src/lib/ipcClient.tauri.ts`)**

Implement every namespace. Pattern: each method = `call('<IPC channel>', args)`; each `onX` = `on('<evt channel>', cb)`. Use the channel strings from `shared/types.ts`'s `IPC` map. Data namespaces may return defaults in Phase 0 by having the Rust `ipc` dispatcher return them; keep the TS faithful to the real channels so no client change is needed later. Example (abbreviated — implement ALL of `AegisApi`):

```ts
import type { AegisApi, NavState, /* …all types… */ } from '../../shared/types';
import { IPC } from '../../shared/types';
import { call, on } from './tauriInvoke';

export const aegis: AegisApi = {
  nav: {
    navigate: (viewId, url) => call(IPC.navNavigate, { viewId, url }),
    back: (viewId) => call(IPC.navBack, { viewId }),
    forward: (viewId) => call(IPC.navForward, { viewId }),
    reloadOrStop: (viewId) => call(IPC.navReloadOrStop, { viewId }),
    home: (viewId) => call(IPC.navHome, { viewId }),
    getState: (viewId) => call<NavState>(IPC.navGetState, { viewId }),
    onState: (cb) => on<NavState>(IPC.evtNavState, cb),
    onFailed: (cb) => on(IPC.evtNavFailed, cb),
    onCrashed: (cb) => on(IPC.evtNavCrashed, cb),
  },
  view: {
    setContentVisible: (viewId, visible) => call(IPC.viewSetContentVisible, { viewId, visible }),
    setContentInset: (viewId, inset) => call(IPC.viewSetContentInset, { viewId, inset }),
    setChromeOverlay: (viewId, active) => call(IPC.viewSetChromeOverlay, { viewId, active }),
    setFullscreen: (viewId, on) => call(IPC.viewSetFullscreen, { viewId, on }),
  },
  // favorites/history/saved/settings/adblock/lists/subs/customFilters/
  // downloads/permissions/data/picker/update/safety: implement each method as
  // call(IPC.x, args); each onX as on(IPC.evtX, cb). Phase 0 Rust returns defaults.
  // …(complete the remaining namespaces here)…
};
```

- [ ] **Step 3: Make `ipcClient.ts` platform-agnostic**

```ts
// src/lib/ipcClient.ts
// Electron build: `window.aegis` (preload bridge). Tauri build: Vite aliases
// this module's './ipcClient' import to ipcClient.tauri.ts (see vite.config.ts).
import type { AegisApi } from '../../shared/types';
export const aegis: AegisApi = window.aegis;
```

(The alias in `vite.config.ts` redirects renderer imports of `./ipcClient` to the Tauri client for Tauri builds; the Electron build keeps this file. Verify the alias resolves by checking the built bundle references the Tauri client.)

- [ ] **Step 4: Type-check the Tauri client satisfies `AegisApi`**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -i ipcClient.tauri || echo "no client type errors"`
Expected: `no client type errors` (the object must structurally match `AegisApi`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tauriInvoke.ts src/lib/ipcClient.tauri.ts src/lib/ipcClient.ts
git commit -m "feat(tauri): implement AegisApi seam over Tauri invoke/listen"
```

---

## Task 5: Render the real Aegis UI in Tauri (no content view yet)

**Files:**
- Modify: `src-tauri/src/lib.rs` (register the `ipc` dispatcher returning Phase-0 defaults)

- [ ] **Step 1: Add a single `ipc` command dispatcher returning safe defaults**

In `src-tauri/src/lib.rs`, register an `ipc(channel, payload)` command that, for Phase 0, returns JSON defaults for data channels (empty arrays, default `Settings`, `AdblockState{enabled:true,allowlistedHosts:[],sessionBlocked:0}`, etc.) and `Ok(())` for actions. Confirm command-registration syntax against installed docs. Intended shape:

```rust
#[tauri::command]
fn ipc(channel: String, payload: serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::json;
    let v = match channel.as_str() {
        "favorites.list" | "history.list" | "saved.list" | "downloads.list"
        | "permissions.list" | "subs.list" => json!([]),
        "settings.get" => json!({ "siteName":"Aegis","homeUrl":"about:blank","primaryColor":"#3b82f6","defaultSearchTemplate":"https://duckduckgo.com/?q=%s","searchEngines":[],"hideChromeByDefault":false,"downloadDir":"","httpsOnly":true }),
        "adblock.getState" => json!({ "enabled":true,"allowlistedHosts":[],"sessionBlocked":0 }),
        "customFilters.get" => json!(""),
        "update.getState" => json!({ "status":"idle","version":null,"percent":0,"error":null }),
        "safety.getState" => json!(null),
        _ => json!(null), // actions → null/ok in Phase 0
    };
    Ok(v)
}
```

(Real implementations replace these per namespace in Phases 2–3. The renderer never changes.)

- [ ] **Step 2: Launch the real renderer**

Run: `npm run tauri:dev`
Expected: the actual Aegis chrome (toolbar/address bar/home tab) renders with empty data and **no uncaught console errors** from `aegis.*` calls. There is no content webview yet (Task 6).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(tauri): Phase-0 ipc dispatcher returns defaults so the React UI renders"
```

---

## Task 6: Content webview — create, navigate, emit state

The core browser-shell mechanic. **Confirm the multi-webview API against installed docs first.**

**Files:**
- Create: `src-tauri/src/nav.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Confirm the Tauri 2.x multi-webview API**

Run: `cd src-tauri && source "$HOME/.cargo/env" && cargo doc -p tauri --no-deps && cd ..`
Read the `tauri::webview` module (`WebviewWindow`, `Webview`, `WebviewBuilder`, child-webview creation, `.navigate()`, `.eval()`, `on_web_resource_request`). Record the exact constructors used below.

- [ ] **Step 2: Create the content webview as a child of the main window**

In `nav.rs`, on setup, add a content webview to the `main` window positioned below a default chrome inset. Intended shape (confirm signatures):

```rust
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

pub fn spawn_content_webview(window: &tauri::Window) -> tauri::Result<()> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size()?.to_logical::<f64>(scale);
    let inset_top = 96.0; // default chrome height; refined by view.setContentInset
    let builder = tauri::webview::WebviewBuilder::new(
        "content",
        WebviewUrl::External("about:blank".parse().unwrap()),
    );
    window.add_child(
        builder,
        LogicalPosition::new(0.0, inset_top),
        LogicalSize::new(size.width, size.height - inset_top),
    )?;
    Ok(())
}
```

- [ ] **Step 3: Implement nav commands routed through the `ipc` dispatcher**

Handle `nav.navigate`/`back`/`forward`/`reloadOrStop`/`home`/`getState` by acting on the `content` webview (`webview.navigate(url)`, `webview.eval("history.back()")`, etc.). Normalize the URL via `url_input::normalize` (Task 8). After navigation, emit `nav.state` with a `NavState`.

- [ ] **Step 4: Emit `nav.state` on navigation**

Wire the content webview's navigation/title callbacks to `window.emit("nav.state", NavState{ … })`. Confirm the on-navigation hook name against docs (`on_navigation`, page-load events).

- [ ] **Step 5: Verify navigation end-to-end**

Run: `npm run tauri:dev`, type `example.com` in the address bar, press Enter.
Expected: the content webview loads example.com; the address bar shows the resolved `https://example.com/`; back/forward enable/disable correctly.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/nav.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): content webview navigation (nav.* commands + nav.state events)"
```

---

## Task 7: Content inset & visibility (layout under the chrome)

**Files:**
- Create: `src-tauri/src/view.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Implement `view.setContentInset` / `view.setContentVisible`**

`setContentInset({top,left})` repositions/resizes the `content` webview (`webview.set_position`/`set_size`); `setContentVisible(bool)` shows/hides it (`webview.hide()/show()`). On window resize, recompute size keeping the inset. Confirm method names against docs.

- [ ] **Step 2: Verify the content view sits below the toolbar**

Run: `npm run tauri:dev`; observe the page renders *below* the chrome toolbar (not under it), and resizing the window keeps the content view correctly sized.
Expected: no overlap; toolbar always visible; content fills the remainder.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/view.rs src-tauri/src/lib.rs
git commit -m "feat(tauri): content webview inset/visibility (view.* commands)"
```

---

## Task 8: URL/search input normalization (TDD)

Port the address-bar parsing rules so typed input becomes a URL or a search.

**Files:**
- Create: `src-tauri/src/url_input.rs`
- Reference: `src/lib/addressParse.ts` (existing rules to mirror)

- [ ] **Step 1: Write failing tests (`src-tauri/src/url_input.rs`)**

```rust
#[cfg(test)]
mod tests {
    use super::normalize;
    #[test] fn bare_host_gets_https() { assert_eq!(normalize("example.com", "https://duckduckgo.com/?q=%s"), "https://example.com/"); }
    #[test] fn keeps_explicit_scheme() { assert_eq!(normalize("http://foo.test/x", "https://duckduckgo.com/?q=%s"), "http://foo.test/x"); }
    #[test] fn spaces_become_search() { assert_eq!(normalize("hello world", "https://duckduckgo.com/?q=%s"), "https://duckduckgo.com/?q=hello%20world"); }
    #[test] fn single_word_no_dot_is_search() { assert_eq!(normalize("rustlang", "https://duckduckgo.com/?q=%s"), "https://duckduckgo.com/?q=rustlang"); }
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd src-tauri && source "$HOME/.cargo/env" && cargo test url_input && cd ..`
Expected: FAIL (`normalize` not found / assertions fail).

- [ ] **Step 3: Implement `normalize` mirroring `addressParse.ts`**

```rust
/// Turn address-bar input into a navigable URL, or a search URL via `search_tmpl`
/// (which contains `%s`). Rules mirror src/lib/addressParse.ts.
pub fn normalize(input: &str, search_tmpl: &str) -> String {
    let t = input.trim();
    if t.is_empty() { return "about:blank".into(); }
    if t.starts_with("https://") || t.starts_with("http://") || t == "about:blank" {
        return t.to_string();
    }
    let looks_like_host = !t.contains(' ') && t.contains('.') && !t.contains("..");
    if looks_like_host {
        return format!("https://{}", t.trim_end_matches('/').to_string())
            // normalize bare host to include a path so it matches the WHATWG form
            + if t.contains('/') { "" } else { "/" };
    }
    search_tmpl.replace("%s", &urlencoding::encode(t))
}
```

(Add `urlencoding = "2"` to `Cargo.toml`. Confirm the exact bare-host/path-normalization rules against `addressParse.ts` and adjust tests/impl to match its real behavior — that file is the source of truth.)

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd src-tauri && source "$HOME/.cargo/env" && cargo test url_input && cd ..`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/url_input.rs src-tauri/Cargo.toml
git commit -m "feat(tauri): URL/search normalization for the address bar (TDD)"
```

---

## Task 9: Phase 0 smoke gate + status update

**Files:**
- Create: `docs/superpowers/plans/2026-06-13-aegis-tauri-phase0-VERIFY.md`
- Modify: `docs/superpowers/specs/2026-06-13-aegis-tauri-cross-platform-design.md` (status)

- [ ] **Step 1: Produce a release build**

Run: `npm run tauri:build`
Expected: a Linux bundle under `src-tauri/target/release/bundle/` (AppImage and/or deb), exit 0.

- [ ] **Step 2: Launch the bundle and smoke-test**

Run the built AppImage/binary; type `wikipedia.org`, Enter.
Expected: the page loads in the content webview; back/forward work; chrome stays visible. Record the result (pass/fail + notes) in the VERIFY doc.

- [ ] **Step 3: Run the full Rust test suite**

Run: `cd src-tauri && source "$HOME/.cargo/env" && cargo test && cd ..`
Expected: all green.

- [ ] **Step 4: Flip the spec status & commit**

Update the spec's Phase 0 row to ✅ with the verified date; write the VERIFY doc (commands run + observed output).

```bash
git add docs/superpowers/
git commit -m "docs(tauri): Phase 0 verified — Tauri shell navigates with reused React UI"
```

---

## Self-review

**Spec coverage:** Phase 0 exit criteria from the design (toolchain installed; `src-tauri` scaffolded; renderer reused via Tauri-targeted client; app launches and navigates a content webview to an arbitrary URL on Linux; no ad-blocking) → Tasks 1 (toolchain), 2–5 (renderer reuse + client + render), 6–7 (content webview nav + layout), 8 (URL input), 9 (build + smoke). Covered.

**Placeholder scan:** Rust webview signatures are explicitly flagged "confirm against installed docs" (an honest verification step, not a TODO) because fabricating 2.x signatures would violate the no-invented-API rule; all other steps have concrete commands/code.

**Type consistency:** The seam uses `AegisApi` + `IPC` channel strings verbatim from `shared/types.ts`; the Rust `ipc(channel,payload)` dispatcher matches the TS `call(channel,args)` transport; `NavState`/`Settings`/`AdblockState` default shapes match `shared/types.ts`.

**Out of Phase 0 (later phases):** real data/security backends (Phase 2–3), ad-blocking (Phase 1), chrome-overlay z-swap & fullscreen (Phase 2), Tauri e2e harness/`tauri-driver` (Phase 2), packaging signing + auto-update (Phase 4), mobile (Phase 5).
