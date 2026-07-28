# Phase 5 — Performance & Polish: Spec Summary

## What

A performance optimization pass targeting faster startup, lower memory footprint, and smoother interaction latency across the Aegis browser. This phase adds observability (bundle analysis, startup profiling), applies targeted optimizations (lazy loading, injection pre-warming, rendering efficiency), and establishes guardrails (CI performance budget) to prevent regressions.

## Why

Browser UX demands instant responsiveness. Users judge a browser within the first 500 ms of interaction. Current pain points:

- **Startup:** All 14 settings tabs mount eagerly (including heavy tabs like FilterListsTab and VaultSettingsTab), and the Rust setup path has no timing instrumentation — slow paths are invisible.
- **Bundle:** Single Vite bundle with no code splitting — the entire renderer ships as one chunk. Heavy tabs (filter list parsing, vault crypto) load even when never opened.
- **Injection pipeline:** `adblock_inject::script()` composes WebRTC shim + pop-under guard + (on Win/macOS) the ~1 MB ad-block body + farble shim on every tab spawn. The `OnceLock` caches the ad-block body, but the per-call string concatenation and farble/WebRTC shim lookups happen synchronously at spawn time.
- **Tab idle sweep:** Background-created tabs are discarded after a hardcoded 30 s timeout; idle tabs use a single configurable timeout with no distinction between tabs with heavy memory footprints (e.g. media-heavy pages) and lightweight ones.
- **Rendering:** TabStrip renders all tabs as DOM nodes — no virtualization for power users with 50+ tabs.
- **Memory:** No audit of React effect cleanup patterns — leaked subscriptions or timers silently grow the renderer's footprint over time.

## Design Areas

### 1. Lazy-load Settings Tabs

**Current:** `SettingsModal.tsx` receives all 14 tab panels as ReactNode props, and the parent (`App.tsx`) eagerly imports every tab component (AppearanceTab, FilterListsTab, VaultSettingsTab, etc.) at the module level.

**Target:** Convert heavy tabs to `React.lazy()` + `<Suspense>`. Only mount the tab content when the user selects it. Keep light tabs (Appearance, Search, Home, Tabs) eagerly loaded since they are small and the default view.

**Heavy tabs to lazy-load:**

- `FilterListsTab` — parses subscription data, renders list of filter rules
- `VaultSettingsTab` — vault crypto operations, credential list rendering
- `MyFiltersTab` — custom filter rule editor
- `SyncSettingsTab` — sync state, device list
- `ProxySettingsTab` — proxy config form with test-connection logic
- `SecurityTab` — fingerprinting allowlist manager

**Light tabs (keep eager):**

- `AppearanceTab`, `SearchTab`, `HomeTab`, `TabsTab`, `DownloadsTab`, `DataTab`, `AllowlistTab`, `SitePermissionsTab`

### 2. Bundle Analysis

Add `rollup-plugin-visualizer` to the Vite config to generate a treemap of the production bundle. Use the output to identify oversized chunks and opportunities for splitting.

### 3. Startup Profiling

Instrument the Rust `setup()` function in `lib.rs` to log elapsed time for each major initialization phase (filter list loading, engine warm-up, session restore, adblock install). On the React side, measure time-to-first-paint and React mount duration via `performance.mark()` / `performance.measure()`.

### 4. React Effect Cleanup Audit

Audit every hook in `src/hooks/` for proper cleanup of:

- Event subscriptions (Tauri `on()` listeners)
- `setTimeout` / `setInterval` timers
- Abort controllers
- DOM observers (IntersectionObserver, ResizeObserver)
- Async state guards (`let active = true` patterns)

Current hooks with subscriptions that need verification: `useNav`, `useAdblock`, `useTabs`, `useHistory`, `useSaved`, `useFind`, `useZoom`, `useFingerprint`, `useProxy`, `useVault`, `useUpdate`, `useSafety`, `usePermissions`, `useDownloads`.

### 5. Injection Pipeline Optimization

**Current per-spawn flow** (`adblock_inject::script()`):

1. Read `webrtcPolicy` setting → call `webrtc_shim::shim_for()`
2. Read `antiFingerprint` setting → check `farble::host_allowlisted()` → call `farble::shim_for()`
3. Call `vault_inject::script()`
4. `compose()` concatenates all parts

**Optimization opportunities:**

- Pre-warm the common WebRTC shim variants (`public-only` / `default` / `disable`) as `OnceLock<String>` at boot, since there are only 3 possible values and the setting changes rarely.
- Pre-compute the farble shim for `off` level (the empty string, the most common case for default settings) to avoid the level-check + allowlist-lookup path entirely.
- Cache the composed output for the most common spawn configuration (default WebRTC policy + farble off) so repeated spawns with the same settings skip concatenation.

### 6. Tab Idle Sweep Tuning

**Current:** Background-created tabs are discarded after a hardcoded 30-second timeout. Normal idle tabs use a single `tabIdleTimeout` setting.

**Target improvements:**

- Pinned tabs are already exempt (verified in `sweep_idle`). No change needed.
- Add a separate, shorter timeout for background-created tabs that were never activated (already 30 s — make it configurable via `settings`).
- When the total tab count exceeds a threshold (e.g. 20), reduce the idle timeout to reclaim memory faster.
- Skip sweep for tabs with pending downloads (expose download state to the sweep logic).

### 7. TabStrip Virtualization

When tab count exceeds 50, render only visible tabs plus an overscan buffer. Use a simple scroll-aware renderer (no virtual list library needed — the tab strip is a horizontal single-row layout). Below the threshold, render all tabs as today.

### 8. CI Performance Budget (Optional, Non-blocking)

Add a Lighthouse-style performance budget check to CI: fail (or warn) if the JS bundle exceeds a threshold (e.g. 500 KB gzipped) or if the total chunk count exceeds a limit. Gate on `npm run build:renderer` output size.

## Non-Goals

- **Rust-side algorithmic optimization** — the ad-block engine, crypto, and sync algorithms are already efficient; tuning them is out of scope.
- **Network-level changes** — DNS prefetch, HTTP/2 push, or CDN configuration are not part of this phase.
- **WebView engine tuning** — WebKit/WebView2 internals are platform-managed; we don't patch them.
- **Server-side optimization** — the sync server performance is a separate concern.
- **Code splitting beyond settings tabs** — the rest of the renderer is small enough that further splitting adds complexity without measurable benefit.

## Success Criteria

1. **Startup time reduced by 20%+** — measured via `performance.measure('aegis-mount')` from DOMContentLoaded to React mount complete
2. **Memory usage reduced by 15%+** — measured via `performance.memory` (Chromium) or RSS delta after opening 10 tabs + switching through all settings tabs
3. **No interaction jank** — no frame drops during tab switching, settings navigation, or scroll; measured via `requestAnimationFrame` timing in dev mode
4. **`npm test` passes** — zero regressions from lazy loading, injection changes, or effect cleanup
5. **Bundle analysis complete** — treemap generated and reviewed; no chunk exceeds 300 KB gzipped
6. **Injection pipeline measurably faster** — time `adblock_inject::script()` across 100 spawns; target <100 μs average (pre-warmed path)
