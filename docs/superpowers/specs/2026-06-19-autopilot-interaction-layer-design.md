# Autopilot Interaction Layer — Design

**Date:** 2026-06-19
**Status:** approved (design); spec for review
**Builds on:** the autopilot harness (`src/autopilot/`, `scripts/autopilot/`), branch `feat/autopilot-impl`.

## Goal

Make the autopilot **exhaustively exercise everything a real user can do, via real
gestures, to catch real bugs.** Today the harness reaches UI states through the control
surface (`setState`) and calls the IPC layer directly — it never fires a real gesture
(click / type / keypress) on a real control. That leaves the entire **UI-wiring layer**
untested: a button bound to the wrong handler or swapped args, a form that doesn't
validate, a modal that won't close, a shortcut that doesn't fire, a broken state
combination — all pass today. This adds the missing layer.

## Success criteria

- Every interactive control and user action in the chrome has a registered interaction
  that drives the real UI the way a user does and asserts the effect.
- The coverage runs in **two layers**: a continuous **vitest interaction tour** (real
  components + mocked core, every `npm test`) and the **live autopilot** (real gestures
  against the real Rust core, in the chrome webview).
- A **drift guard** fails the build when an interactive control has no interaction entry.
- A failed interaction assertion is a reported, actionable bug (with detail), not a crash.

## Architecture

### A third enumerable catalog

Alongside `CATALOG` (IPC features) and `SCREENS` (UI states), add
`src/autopilot/interactions.ts` exporting `INTERACTIONS: InteractionSpec[]`. One entry per
user gesture:

```ts
export interface InteractionSpec {
  id: string; // unique, e.g. 'toolbar.bookmarkStar.add'
  domain: string; // 'toolbar' | 'tabs' | 'sidebar' | 'settings' | ...
  description: string; // human summary of the user action
  screen: ScreenId; // screen to reach first (control must be on-screen)
  layers: InteractionLayer[]; // ['vitest','live'] — where it can run (see below)
  /** Perform the real gesture (click/type/keyboard) via ctx. */
  run(ctx: InteractionCtx): Promise<void>;
  /** Assert the effect; throw on failure. Returns a short success detail. */
  assert(ctx: InteractionCtx): Promise<string>;
}

export type InteractionLayer = 'vitest' | 'live';
```

`InteractionCtx` abstracts the two layers behind one surface so a spec is written once:

```ts
export interface InteractionCtx {
  layer: InteractionLayer;
  // Real gestures. vitest: @testing-library/user-event. live: real DOM dispatch helpers.
  click(el: Element): Promise<void>;
  type(el: Element, text: string): Promise<void>; // focuses, types
  press(key: string): Promise<void>; // keyboard, e.g. 'Enter', '{Control>}t{/Control}'
  // Queries scoped to the rendered chrome (role/text/label/selector — NOT brittle CSS).
  byRole(role: string, name?: string | RegExp): HTMLElement | null;
  byText(text: string | RegExp): HTMLElement | null;
  byLabel(label: string | RegExp): HTMLElement | null;
  bySelector(sel: string): HTMLElement | null;
  // Effect-assertion surface.
  aegis: AegisApi; // vitest: the mock; live: the real client
  calls: CallLog; // vitest only: recorded mock calls (e.g. calls.of('favorites.add'))
  // Reach a screen before running (delegates to reach.ts).
  reach(screen: ScreenId): Promise<void>;
}
```

- **vitest layer** asserts wiring: the gesture caused the right `aegis.*` call with the
  right args (via `ctx.calls`), and/or the UI updated (via queries). Mocked core.
- **live layer** asserts real effect: after the gesture, real state changed (e.g.
  `await ctx.aegis.favorites.list()` contains the probe) and the UI reflects it. `calls`
  is empty/ignored live; assertions key on real state + DOM.

A spec lists the layers it supports. Most are `['vitest','live']`. A gesture whose effect
can only be confirmed against the real core (real page navigation) is `['live']`; one that
can't run deterministically live (needs a synthesized event the live core won't emit) is
`['vitest']`. Each spec's `assert` may branch on `ctx.layer` for the few that differ.

### Consumers

1. **`src/autopilot/interactions.test.tsx`** (vitest, jsdom) — render the real `<App/>`
   with the mocked `aegis`; for each `INTERACTIONS` entry whose `layers` includes
   `'vitest'`: reach its screen, `run`, then `assert`. A failed assert fails the test with
   the interaction id. A mobile counterpart (`interactions.mobile.test.tsx`) covers the
   mobile shell's distinct controls.
2. **`run.ts`** (live) — a new step "2c) Interactions": for each entry whose `layers`
   includes `'live'`: reach its screen, `run` against the real core, `assert`, screenshot
   on failure. Each becomes an `interaction:<id>` result row in the report.

### Drift guard

Extend `coverage.test.ts` (or add `interactions.coverage.test.ts`): assert every
interactive control is covered. Mechanically: maintain `INTERACTIVE_CONTROLS` derived from
the components (a documented registry, mirroring `UNTESTED_CHANNELS`), and assert each has
≥1 `INTERACTIONS` entry; assert interaction ids are unique; assert every `screen` is a
valid `ScreenId`; assert every entry declares ≥1 layer. New control without an interaction
→ build fails.

## Interaction inventory (exhaustive)

Grouped by domain. Each line is ≥1 `InteractionSpec` (happy path; edge cases noted).

**toolbar** — address bar: type URL + Enter → `nav.navigate`; type a search term + Enter →
search-engine URL; back / forward / reload-or-stop / home buttons; **bookmark star** →
`favorites.add` then (toggled) remove; shield button → opens popover; picker button →
`picker.start`; downloads + update indicators open their surfaces; menu (mobile).

**shield popover** — toggle ad-block on/off → `adblock.setEnabled`; allowlist this site →
`adblock.toggleAllowlist`; counts render.

**tabs** — `+` → `tabs.create`; click a tab → `tabs.activate`; close (X) → `tabs.close`;
pin/unpin → `tabs.setPinned`; reorder (drag) → `tabs.reorder`; Ctrl+T / Ctrl+W /
Ctrl+Shift+T shortcuts.

**favorites bar / manager** — click a favorite → `nav.navigate`; manager add / edit
(rename) / delete / reorder.

**sidebar — history** — open; click an entry → `nav.navigate`; delete an entry →
`history.remove`; search box → `history.search`; clear → `history.clear` (confirm dialog).

**sidebar — saved** — open; click an entry → navigate; add / edit / delete; **tags**: add a
tag, rename, delete, filter by a tag chip; tag-union renders.

**settings (every tab)** — Appearance (primary color, theme); Search (engine select, custom
URL); Home (homeUrl input); Tabs (idle-timeout); Filter Lists (subscription toggle / add /
remove); My Filters (textarea + Save → `customFilters.set`); Allowlist (add / remove host);
Downloads (dir, behavior); Site permissions (remove / clear); Security (HTTPS-only,
WebRTC policy, malware toggle); Sync (enable/test/disable — UI-state only, no real server);
Data (Export / Import buttons, clear-data).

**overlays** — downloads modal (open-file / remove / clear); confirm dialog (Confirm /
Cancel); error overlay (Retry); crash overlay (Reload); safety interstitial (Proceed /
Back); permission prompt (Allow / Deny / Remember); **redirect bar** (Open anyway → new
tab / Dismiss).

**keyboard** — Enter in address bar; Esc exits fullscreen / closes top overlay;
Ctrl+T/W/Shift+T (also under tabs).

**edge / error inputs** — empty URL (no nav, no crash); malformed URL (`ht!tp://`);
very-long URL/title; duplicate favorite (no dupe); special chars + whitespace-only tag
(rejected/trimmed); rapid double-click (no double add).

**state combinations** — open Settings while the sidebar is open; switch tabs with a modal
open (modal state correct); open the shield popover mid-navigation; open a second overlay
over a first.

## Files

- **Create:** `src/autopilot/interactions.ts` (catalog + `InteractionCtx` types),
  `src/autopilot/interactionCtx.ts` (the vitest + live ctx factories, incl. the live
  real-DOM gesture helpers and a `CallLog` over the aegis mock),
  `src/autopilot/interactions.test.tsx`, `src/autopilot/interactions.mobile.test.tsx`,
  `src/autopilot/interactions.coverage.test.ts`.
- **Modify:** `run.ts` (step 2c: live interactions + `interaction:<id>` results),
  `report.ts` (a `kind: 'interaction'` row if needed), `coverage.test.ts` (or the new
  coverage test), `src/CLAUDE.md` + `scripts/CLAUDE.md` (document the third catalog),
  root `CLAUDE.md` (the pre-push gate already references interaction tests).

## Risks & decisions

- **Selector brittleness.** Use role/text/aria queries (testing-library semantics) shared
  by both layers, never raw CSS class chains. Where a control lacks an accessible name,
  add an `aria-label` to the component (small, justified UI improvement) rather than
  selecting by class.
- **Live determinism.** Real navigation/timing is flaky; live interactions poll with
  bounded deadlines (mirroring the existing verify round-trips) and degrade to an honest
  skip when an effect can't be observed in the environment — never a false fail.
- **Live destructive actions** are safe (disposable XDG profile, as with the verify
  round-trips); interactions restore state where practical.
- **Scope.** Large but cohesive. Build incrementally per domain (toolbar → tabs → sidebar
  → settings → overlays → keyboard → edge/combination), each a reviewable task; the drift
  guard enforces completeness as the inventory grows.

## Out of scope

- OS/file/network/interaction-bound actions already documented as untestable (real
  downloads' file ops, real permission prompts, real malware navigation, a real sync
  server, app restart). Their _UI affordances_ (the buttons) are tested via mocked/event
  paths; their real effects remain manual.
- Visual/pixel regression of screenshots (the gallery stays a human artifact).

## Test gate

`npm test` green (incl. the new vitest interaction tours + drift guard), and
`bash scripts/autopilot/run-autopilot.sh` → `0 failed` + `ad-block blocking (trace): PASS`,
with the new `interaction:*` rows passing on real hardware.
