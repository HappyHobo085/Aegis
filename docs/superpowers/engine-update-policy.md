# Aegis — Filter Engine & Chromium Update Policy

**Date:** 2026-06-11

## Filter-list refresh (built, Phase 4)

- **Source of truth:** `SubscriptionsRepo` (enabled filter lists) + Phase-4 `CustomFiltersRepo`
  (the user's "My filters" + element-picker output).
- **Scheduled refresh:** a 24h background scheduler in `electron/main/index.ts`
  (`REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000`, driven by `RefreshScheduler`) calls
  `runRefresh()`, which re-fetches each enabled list, writes per-listId caches, and rebuilds
  the engine via `assembleEngineTexts(listTexts, customFiltersRepo.get())` → `buildEngine(...)`.
  The rebuilt engine swaps in on the next navigation (engine-readiness gating).
- **Manual refresh:** the `lists.*` IPC (`updateNow`, wired to `runRefresh`) triggers the same
  path on demand from the Settings filter-list manager.
- **Cache-only rebuild:** `rebuildEngineFromCache()` reassembles `assembleEngineTexts(listTexts,
  customFiltersRepo.get())` from the existing per-list cache and the custom-filters blob (no
  network), so a my-filter save or element pick applies on the next nav without waiting for the
  24h cycle.
- **Bundled seed fallback:** a generated seed (`scripts/generate-seed.mjs`, npm script
  `generate-seed`; the source blob is copied into `out/main/adblock/seed/engine-seed.bin` by the
  `aegis-copy-seed` plugin in `electron.vite.config.ts`) ships so the app blocks ads on first
  run / fully offline before the first network refresh succeeds. Offline mode
  (`AEGIS_ADBLOCK_OFFLINE=1`) is exercised in e2e.
- **Custom-filter immediacy:** saving a my-filter or picking an element calls
  `rebuildEngineFromCache()` directly (no 24h wait) so the change applies on the next nav.
- **Adblock engine:** `@ghostery/adblocker-electron` (currently `2.18.0`, pinned exactly in
  `package.json`); the companion `@ghostery/adblocker-electron-preload@2.18.0` provides the
  content-side blocking hook. Bumping the engine library re-runs through the same dual-ABI gate.

## Chromium / Electron update stance

- The Chromium engine is whatever ships with the resolved Electron runtime (**42.4.0**, as
  installed; the manifest in `package.json` declares the range `electron: "^42.3.3"`). Security
  fixes in Chromium therefore arrive via an **Electron version bump**, which is a release-cadence
  activity — **deferred** under the current local-only/headless constraint (see
  `deferred-distribution.md`).
- **Policy for a real release:** track Electron stable releases; bump on each security release;
  re-run the full dual-ABI gate (`npm test` + `npm run build && npm run test:e2e`) and re-verify
  the security control matrix before publishing. Pin the Electron version exactly in
  `package.json` (replace the `^` range) and record the bundled Chromium version in release notes.
- Until then, the engine/Chromium version is fixed at the resolved Electron; this is documented
  and accepted, not silently stale.
