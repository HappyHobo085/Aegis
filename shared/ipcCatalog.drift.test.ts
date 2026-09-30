// shared/ipcCatalog.drift.test.ts
//
// The IPC contract drift guard, in BOTH directions, over the whole tree.
//
// ## Why this is a source scan and not a behavioural test
//
// A behavioural test is impossible here. `ipc()` in `src-tauri/src/lib.rs` is a
// `#[tauri::command]` that takes a concrete wry `&AppHandle`, so it cannot be driven from a
// `MockRuntime` harness — the same limitation that keeps most `dispatch` entry points
// untested. Worse, the renderer specs run against `src/testFixtures/aegisMock.ts`, so an
// `invoke` there succeeds whether or not the Rust dispatcher implements the channel. The
// real instance was `vault.autofill`: declared, typed `Promise<VaultRecord[]>`, and
// unit-tested in a hook test against the mock, with no `"vault.autofill"` arm in `vault.rs`.
// It silently resolved to `null` in a release build and the declared type was a lie.
//
// So the guard reads the Rust sources. The failure it exists to catch is verified: renaming
// four channels in `shared/types.ts` to shape-preserving wrong values (`nav.back` →
// `nav.backk`, `vault.unlock` → `vault.unlockX`, `sync.syncNow` → `sync.syncNowY`,
// `fingerprint.clearAllowlist` → `fingerprint.clearallowlist`) leaves the rest of the suite
// fully green, because every renderer spec is talking to the mock. At runtime the call falls
// through to the `_ =>` arm in `lib.rs` and comes back `Err("unknown IPC channel: …")`.
//
// ## The near-miss that shaped this file
//
// A first attempt at proving the gap used `nav.back` → `nav.back.MUTANT`, and the suite DID
// go red — but only on the incidental shape regex in `shared/types.test.ts`
// (`/^[a-z][a-zA-Z]*\.[a-zA-Z]+$/`, exactly one dot). That is a spelling check, not a name
// guard: it would stay green if the channel were renamed to a different real-looking name.
// The four mutations above are chosen to preserve the shape AND pass that regex, which is
// what makes them a real proof. See the "anti-vacuity" test at the bottom — it pins the
// shape-preserving property so a future rename cannot quietly weaken the proof either.
//
// ## Why there are two different scanners
//
// A single whole-file scan cannot serve both directions:
//
//   - FORWARD (catalog → Rust) wants MAXIMUM sensitivity. A name merely *mentioned* in Rust
//     satisfies it. That is the conservative direction: it can only ever under-report an
//     orphan, never invent one, so it never cries wolf.
//   - REVERSE (Rust → catalog) wants MINIMUM noise. Scanning every dotted literal in every
//     Rust file yields 49 hits, of which 45 are false positives: store filenames
//     (`favorites.json`, `settings.json`, `tabs.json`, `vault.json`), test hostnames
//     (`proxy.local`, `sync.example.com`), a shared library (`libgstcoreelements.so`), a JS
//     member (`realOpen.apply`) and a CSS selector (`div.slot`). A 45-entry allowlist would
//     be worse than no guard — it would be a list nobody reads and everybody extends.
//
// So REVERSE is scoped to the four SITES that actually constitute a channel contract. A miss
// there is safe (it weakens the guard); a false positive is not (it is a build failure). The
// trade-off is deliberate and is pinned by the "scanner still sees every shape" test.
//
// ## What "acted on" means, and why the colon spelling is accepted
//
// Tauri 2 forbids dots in event names, so `emit_event` rewrites `.` → `:` on the way out
// (`lib.rs`) and `src/lib/tauriInvoke.ts:23` rewrites it back on the way in. That makes two
// spellings of one name legitimate:
//
//   - dotted — a `match channel` arm (chrome → core request) or an `emit_event` argument
//     (core → chrome event);
//   - colon — a `listen` argument (content webview → core), e.g. `form:detectionResult`.
//
// Both spellings are accepted in both directions. Note what that does and does not prove:
// finding `form:detectionResult` in `form.rs:115` means the core is WAITING for that event,
// not that anything sends it. Whether a content webview can emit at all is a capability
// question (`capabilities/default.json` grants no `remote` block), and `form.rs`'s own STATUS
// block documents that it cannot. This guard cannot see that, and does not pretend to.
//
// ## The inventories below are INVENTORIES, not allowlists
//
// Each is asserted as an exact set equality in BOTH directions, so:
//
//   - a new unexplained orphan fails the build, and
//   - an entry that is no longer an orphan ALSO fails the build, because a stale inventory
//     entry hides a code change that the author forgot to write down.
//
// Do not add a key to silence a failure. That is the same fabricated-rationale antipattern as
// the non-asserting assertion in `CommandPalette.test.tsx`. Fix the code or the contract.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from './types';

// `process.cwd()` is the repo root when vitest runs; the same anchor
// `src/lib/webrtcShim.test.ts` uses, and unlike `__dirname` it survives the jsdom/node split.
const RUST_DIR = join(process.cwd(), 'src-tauri', 'src');
const RENDERER_DIR = join(process.cwd(), 'src');

/**
 * A channel name in either spelling: a lowercase head segment, then one or more
 * dot- or colon-separated segments.
 *
 * Deliberately loose. Hostnames (`example.com`) and filenames (`store.json`) match it too,
 * which is exactly why the REVERSE scan is site-scoped rather than file-scoped.
 */
const CHANNEL_LITERAL = /^([a-z][A-Za-z0-9]*(?:[.:][A-Za-z0-9]+)+)$/;

/**
 * Catalog entries with NO Rust implementation of any kind.
 *
 * **Currently EMPTY, and that is the goal state.** Every name in the catalog is implemented in
 * Rust, so a renderer's `invoke` reaches an arm and a renderer's `listen` reaches a relay.
 *
 * This inventory used to hold one entry, `redirect.blocked`, and the history is the reason the
 * guard above exists. Nothing ever emitted it: `redirect_guard.rs` contains zero `emit_event`
 * calls, and no Kotlin called `__aegisRedirectBlocked` (`MainActivity`'s `showRedirectBlocked`
 * calls `__aegisOpenTab` directly). The blocked-redirect behaviour is real but opens the
 * destination NATIVELY — `redirect_guard::on_blocked_redirect_to_new_tab` →
 * `tabs::open_redirect_background` (`linux_layout.rs:434`, `nav_policy_win.rs:74`) — so the
 * renderer's `App.tsx` subscription was dead on every platform. Worse, the dead producer was
 * load-bearing in the OTHER direction: the renderer callback itself called
 * `tabs.create(r.to, true)`, so adding the Rust emit would have opened TWO background tabs per
 * blocked redirect. The whole chain (declaration, `ipcClient` wrapper, `App.tsx` subscription,
 * Android `window` bridge, and the `src-tauri`/`shared` AGENTS.md text that claimed the emit
 * existed) was deleted together. Add an entry here ONLY for a name you can explain in the value
 * string; every unexplained orphan fails direction 1.
 */
const FORWARD_UNPRODUCED: Record<string, string> = {};

/**
 * Names Rust ACTS ON that the catalog does not declare.
 *
 * These are the reverse-direction orphans: the renderer has no way to name them, so a
 * subscription for one can never be written, and a dispatch to one can never arrive.
 *
 * - `form:formStateChanged` — the inbound event for form-detection mode 2. `form.rs:140`
 *   registers a listener for it, but no platform can send it: a content webview has no Tauri
 *   capability (`capabilities/default.json` declares no `remote` block) so
 *   `window.__TAURI__` is `undefined` there, and the MutationObserver the mode is built on was
 *   described in a comment and never written. `form.rs`'s own STATUS block says so. It is kept
 *   deliberately: "This module is the seam, not the mechanism." If the transport is ever built,
 *   add the name to the catalog in the same commit.
 * - `subs.changed` — WAS a real defect, and was here from 2026-09-27 until the same
 *   day. `subs.rs:199` and `subs.rs:292` emit it after a background fetch or
 *   auto-refresh; no renderer code subscribed, and `git log -S 'subs.changed' -- '*.ts'`
 *   is empty, so no subscriber ever existed. It is the pre-existing audit finding from
 *   the now-deleted `docs/CODE_AUDIT.md` (commit 811fa7f: "Rust `subs.changed` event is
 *   emitted but never subscribed by the renderer"). It is FIXED: `evtSubsChanged` is in
 *   the catalog, `aegis.subs.onChanged` exists, and `useSubscriptions` re-reads
 *   `aegis.subs.list()` on it. The entry was removed rather than left to rot — which is
 *   what the "no stale entry" test below is for.
 *
 * Two corrections to the original entry, both made by reading the code rather than the
 * audit's summary, and both worth keeping in mind if this ever regresses:
 *   - It was NOT a visible-staleness bug. `FilterListsTab` renders only `enabled`,
 *     `listId`, `url`, `builtin` and a Remove button — never `lastUpdated`/`etag`/`hash`
 *     — so nothing stale was ever displayed. And `subs` is NOT in
 *     `sync_stores::SYNCABLE` (`["favorites", "saved", "allowlist"]`), so there was no
 *     second device to diverge from either. The core re-reads those fields from disk, so
 *     its own logic was never affected. It was a trap for the next person to add a
 *     "last updated" column, not a live bug.
 */
const REVERSE_UNDECLARED: Record<string, string> = {
  'form:formStateChanged':
    'Deliberate inert seam. `form.rs:140` listens for it; nothing can send it (see the ' +
    'STATUS block atop `form.rs`). The core relays it to the chrome as `form.state`, which IS ' +
    'catalogued, so the relay is wired and only the inbound leg is missing.',
};

/**
 * Catalogued EVENTS that no renderer source ever references.
 *
 * Empty, and the emptiness is the goal state. It held exactly one entry until
 * 2026-09-27: `evtPickerPicked`, the sibling finding the audit called "the same dead-emit
 * class". `picker.rs:301` emitted `picker.picked` and `shared/types.ts:88` declared it, but
 * `ipcClient.ts` never grew an `on…` wrapper, so the event went to nobody — and the UI that
 * wanted it was wired to `picker.start()`'s RETURN value instead, which no platform arm of
 * `start` ever populates with a `rule`. The confirmation toast was therefore unreachable
 * everywhere. Fixed: `aegis.picker.onPicked` exists and `PickerButton` subscribes.
 *
 * Like `REVERSE_UNDECLARED`, an entry here is an admission that a real defect exists, so the
 * "no stale entry" test below makes fixing a defect oblige deleting its excuse.
 */
const UNSUBSCRIBED_EVENTS: Record<string, string> = {
  // Found by rewriting direction 3 (it searched for a literal `IPC.evt<Key>` that the
  // TRANSPORT itself defines, so it had no signal for any event with a wrapper — which is
  // every event by construction). `form.state` was the first thing it caught and is reported,
  // not fixed: closing it is a product decision, because the core emits BOTH `form.state` and
  // `form.detectionResult` and only one of them is meant to be the contract.
  evtFormState:
    'REPORTED, not fixed. form.rs emits BOTH form.state (emit_form_state, relayed at :152) and ' +
    'form.detectionResult, and this file has a wrapper for each. Picking one is a product ' +
    'decision, and guessing here would delete a live contract on a hunch. The wrapper is ' +
    'deliberate — aegisMock.ts:44 names form.onState as a known member.',
  // Also caught by the rewritten direction 3. `vault.rs:1047` emit_changed is called from six
  // sites and its own doc says it exists "so sync and other listeners know the vault data
  // mutated" — but `aegis.vault.onState` is already subscribed and carries the same mutation,
  // so this looks like a redundant twin rather than a missing subscriber. Deleting either event
  // needs the same decision, so it is reported with the evidence rather than resolved by guess.
  evtVaultChanged:
    'REPORTED, not fixed. vault.rs:1047 emit_changed has six call sites but no renderer ' +
    'subscriber, and vault.onState already reports the same mutation — so the open question is ' +
    'WHICH event is the contract, not who should subscribe. Guessing would either delete a live ' +
    'event or add a second subscription to a payload a component already receives.',
  // Surfaced by widening the wrapper-key regex above, and the reason is STRONGER than the two
  // above rather than a third open question: this event is UNREACHABLE, not merely unwatched.
  // `form.onLoginFormDetected` is a method-shorthand wrapper, so the old regex (which required a
  // `:`) never saw it and direction 3 dropped the binding and exempted this key for free. It
  // was exempt for the right OUTCOME by accident. `form.rs:184` answers `form.detectLoginForm`
  // with `Err(DETECT_UNSUPPORTED)`, and `form.rs:24` states that nothing emits
  // `form:detectionResult` from ANY platform: a content webview is built with no Tauri
  // capability and `withGlobalTauri` is absent, so the injected `window.__TAURI__.emit` in the
  // content JS cannot run. No subscriber could ever be woken. Building the content->core
  // transport is a feature, not a guard change, so it is recorded here rather than guessed at.
  evtFormDetectResult:
    'UNREACHABLE, not unwatched. form.rs:24 states nothing emits form:detectionResult from any ' +
    'platform, and form.rs:13-19 gives the reason: a content webview has no Tauri capability and ' +
    'no withGlobalTauri, so the injected window.__TAURI__.emit cannot run. form.rs:184 also ' +
    'refuses form.detectLoginForm outright. Wiring the content->core transport is a feature, not ' +
    'a guard change — a subscriber here would be dead code.',
};

/** Read every `.rs` file in `src-tauri/src`. */
function readRustSources(): { file: string; src: string }[] {
  return readdirSync(RUST_DIR)
    .filter((f) => f.endsWith('.rs'))
    .map((f) => ({ file: f, src: readFileSync(join(RUST_DIR, f), 'utf8') }));
}

/** Read every non-spec renderer source file (the mock and specs are not subscribers). */
function readRendererSources(): { file: string; src: string }[] {
  const out: { file: string; src: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'testFixtures') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({ file: p.slice(RENDERER_DIR.length + 1), src: readFileSync(p, 'utf8') });
      }
    }
  };
  walk(RENDERER_DIR);
  return out;
}

/**
 * Remove line and block comments, keeping string literals intact.
 *
 * This matters for correctness, not tidiness: `data.rs` and `settings.rs` both name channels
 * in prose, and a comment must NEVER be able to satisfy this guard — otherwise deleting the
 * real implementation and leaving the comment behind would pass.
 *
 * The line rule strips a `//` only when it is not inside a string, detected by an odd number
 * of quotes before it. Crude, but sufficient here: a `//` inside a Rust string literal in this
 * codebase only ever appears in a URL, and the channel literal of interest precedes it.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      if (at < 0) return line;
      const before = line.slice(0, at);
      return (before.match(/"/g) ?? []).length % 2 === 1 ? line : before;
    })
    .join('\n');
}

/** The text between the brace at `openIdx` and its match, for brace-balanced slicing. */
function balancedBlock(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return '';
}

/**
 * Every channel-shaped string literal anywhere in the Rust sources (comments stripped).
 *
 * FORWARD scanner: deliberately blunt. "Rust mentions this name somewhere" is the weakest
 * possible producer claim, which is what makes it safe — it under-reports orphans, never
 * invents them. URLs are dropped explicitly: `https://x` also matches `CHANNEL_LITERAL`.
 */
function collectMentioned(sources: { src: string }[]): Set<string> {
  const out = new Set<string>();
  for (const { src } of sources) {
    for (const m of stripComments(src).matchAll(/"([^"\\\n]*)"/g)) {
      if (m[1].includes('//')) continue;
      if (CHANNEL_LITERAL.test(m[1])) out.add(m[1]);
    }
  }
  return out;
}

/**
 * Every channel-shaped name Rust ACTS ON, with the files that do it — the four sites that
 * make up the contract:
 *
 *   1. `match channel` arms, including the combined `"a" | "b" =>` form (`adblock.rs:238`);
 *   2. guard clauses, `channel == "x"` / `channel != "x"` (`picker.rs:310`, `proxy.rs:347`,
 *      `adblock.rs:251`);
 *   3. `emit_event(app, "name", …)` — core → chrome, dotted (multi-line calls put the name
 *      on its own line, hence `\s*` after the comma);
 *   4. `.listen("name", …)` — content webview → core, colon (`form.rs:115`, `form.rs:140`).
 *
 * REVERSE scanner: only these sites count, so a filename or a test hostname can never be
 * mistaken for an undeclared channel.
 */
function collectActed(sources: { file: string; src: string }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (name: string, file: string): void => {
    const set = out.get(name) ?? new Set<string>();
    set.add(file);
    out.set(name, set);
  };
  for (const { file, src } of sources) {
    const clean = stripComments(src);

    // 1. `match channel` / `match channel.as_str()` arms, at a line start so that a
    //    `"…"` literal in an arm's BODY is not mistaken for an arm name.
    for (const m of clean.matchAll(/match\s+channel(?:\.as_str\(\))?\s*\{/g)) {
      const body = balancedBlock(clean, clean.indexOf('{', m.index + m[0].length - 1));
      for (const arm of body.matchAll(/(?:^|\n)\s*((?:"[^"\n]*"\s*\|\s*)*"[^"\n]*")\s*=>/g)) {
        for (const lit of arm[1].matchAll(/"([^"\n]*)"/g)) add(lit[1], file);
      }
    }
    // 2. guard clauses
    for (const m of clean.matchAll(/channel\s*[!=]=\s*"([^"\n]+)"/g)) add(m[1], file);
    // 3. emit_event
    for (const m of clean.matchAll(/emit_event\(\s*[^,]+,\s*"([^"\n]+)"/g)) add(m[1], file);
    // 4. inbound listeners
    for (const m of clean.matchAll(/\.listen\(\s*"([^"\n]+)"/g)) add(m[1], file);
  }
  return out;
}

const CATALOG_VALUES = new Set<string>(Object.values(IPC));
/**
 * Normalise any spelling to the catalog's, which is always dotted: Tauri 2 forbids dots in
 * event names, so `emit_event` rewrites `.` → `:` on the way out (`lib.rs`) and
 * `src/lib/tauriInvoke.ts:23` rewrites it back on the way in. Both spellings therefore name
 * the same thing, and a one-directional conversion is NOT enough — converting dotted → colon
 * leaves an already-colon name untouched, so `form:detectionResult` would never be matched
 * against the catalogued `form.detectionResult`.
 */
const catalogForm = (name: string): string => name.replace(/:/g, '.');
const isCatalogued = (name: string): boolean => CATALOG_VALUES.has(catalogForm(name));

/**
 * The transport itself. Direction 3 must not search it — see `collectSubscribed` for why,
 * which is the whole point of this constant existing.
 */
const TRANSPORT_FILE = 'src/lib/ipcClient.ts';
/**
 * The same file as `readRendererSources` NAMES it.
 *
 * That helper returns paths relative to `src/`, so the transport arrives as
 * `lib/ipcClient.ts`. Comparing the two constants directly - which is what the exclusion in
 * `collectSubscribed` used to do - compared `src/lib/ipcClient.ts` against `lib/ipcClient.ts`,
 * matched nothing, and excluded nothing. The direction still passed, because the transport
 * holds no `aegis.<ns>.on…` reference of its own, so the no-op happened to be harmless; the
 * guard it claimed to enforce was not being enforced. There is now a test that the exclusion
 * removes a file, because "harmless by luck" is not a property to leave in place.
 */
const TRANSPORT_RENDERER_PATH = TRANSPORT_FILE.slice('src/'.length);

/**
 * `evt*` catalog key → the `aegis` surface a renderer must actually CALL, parsed out of the
 * transport's own wrapper bodies.
 *
 * This is the load-bearing half of the rewritten direction 3. The old guard searched for the
 * literal `IPC.evtNavState` anywhere under `src/`, and `ipcClient.ts` is under `src/` — so the
 * file that DEFINES the wrapper satisfied the search for itself, and the guard could not
 * distinguish "some component listens to this" from "the transport offers it". Measured: the
 * only non-spec renderer file containing `IPC.evt*` at all was `ipcClient.ts` itself (27
 * distinct keys), so the direction had **no** signal — replacing a real
 * `aegis.nav.onState(...)` subscription in `useNav.ts` with a no-op stub left all 12 tests
 * green.
 *
 * The binding is not derivable from the key alone (`evtNavState` → `nav.onState`,
 * `evtPickerPicked` → `picker.onPicked`, `evtSubsChanged` → `subs.onChanged` are all
 * irregular), so it is parsed from the one place the two are bound together. Parsing the
 * wrapper also means a wrapper RENAMED without its catalog key updated shows up as a
 * direction-3 failure rather than silently vanishing from the map.
 *
 * Shape-pinned to the file's layout: `aegis` is a top-level object literal, its namespaces
 * are 2-space-indented, and the `on…` wrappers are 4-space-indented inside them. That is
 * asserted below, so a reformat that breaks the parse fails loudly instead of quietly
 * emptying the map.
 */
/**
 * The wrapper NAME a 4-space line introduces, or `null` when the line is not an object member.
 *
 * THREE member shapes carry a wrapper name at 4 spaces and the transport uses all three:
 * `key: (cb) => on<T>(IPC.evtX, cb),` (property, one line), `key: (cb) => {` (property, block)
 * and `key(cb) {` (METHOD SHORTHAND — `form.onLoginFormDetected` and `form.detectLoginForm` are
 * the two in the file). Requiring a `:` matched only the first two, so for the third `wrapper`
 * stayed null, the `IPC.evt…` on the next line was dropped, and `evtFormDetectResult` was
 * silently EXEMPT from direction 3 — the guard exempted an event without ever having seen its
 * wrapper, which is the exact failure mode this file exists to stop.
 *
 * The terminator test is what keeps this from ALSO matching the 4-space CLASS statements in the
 * same file (`super(message);`, `cleanupCache();`): they end in `;`, and matching one would set
 * `wrapper` to a name that is not an `on…` wrapper and misattribute the next event. The accepted
 * terminators are ENUMERATED over every 4-space `name(`/`name:` line in the transport, not
 * guessed: 104 end in `,` (the one-line property), 24 in `{` (the property-and-block form and the
 * method-shorthand form) and 20 in `=>` (the property whose `IPC.evt…` is on the NEXT line, e.g.
 * `onWillSubmit`). The only 2 that end in `;` are those class statements. `=>` was missing from
 * an earlier version of this rule, which did not merely lose an event: it left `wrapper` holding
 * `onState`, so the live, subscribed `evtFormWillSubmit` was reported as an orphan of a DIFFERENT
 * wrapper. Named and module-level so the anti-vacuity test asserts this rule rather than a copy
 * of it — a copy would be the second source of truth this fix is about removing.
 */
function wrapperKeyOnLine(line: string): string | null {
  const member = /^ {4}([A-Za-z][A-Za-z0-9]*)[(:]/.exec(line);
  return member && /(?:[,{]|=>)\s*$/.test(line.trimEnd()) ? member[1] : null;
}

function collectWrapperSurfaces(): Map<string, string> {
  const src = readFileSync(join(process.cwd(), TRANSPORT_FILE), 'utf8');
  const out = new Map<string, string>();
  let namespace: string | null = null;
  // The active 4-space wrapper key. TWO shapes exist in the file and both must parse:
  //   onState: (cb) => on<NavState>(IPC.evtNavState, cb),          (4-space, one line)
  //   onLoaded: (cb) => {                                         (4-space, opens a block)
  //     return on<TabsState>(IPC.evtTabsState, cb);               (6-space, the binding)
  //   },
  // Reading the key from the 4-space line and the event from whichever line carries it handles
  // both without a brace walk. The first shape alone would have silently dropped every
  // block-bodied wrapper — including `evtNavState`, the one this whole guard hinges on.
  let wrapper: string | null = null;
  for (const line of src.split('\n')) {
    const ns = /^ {2}([A-Za-z][A-Za-z0-9]*): \{$/.exec(line);
    if (ns) {
      namespace = ns[1];
      wrapper = null;
      continue;
    }
    // THREE member shapes carry a wrapper name at 4 spaces, and the transport uses all three:
    // `key: (cb) => on<T>(IPC.evtX, cb),` (property, one line), `key: (cb) => {` (property,
    // block) and `key(cb) {` (METHOD SHORTHAND — `form.onLoginFormDetected` and `form
    // .detectLoginForm` are the two in the file). Requiring a `:` matched only the first two,
    // so for the third `wrapper` stayed null, the `IPC.evt…` on the next line was dropped, and
    // `evtFormDetectResult` was silently EXEMPT from direction 3 — the guard exempted it
    // without ever having seen the wrapper, which is the failure mode this file exists to stop.
    // Deliberately NOT `continue`d: the single-line wrapper shape carries its own
    // `IPC.evt…` on the same line, so skipping the rest of the line dropped those events.
    const key = wrapperKeyOnLine(line);
    if (key) wrapper = key;
    const bound = /IPC\.(evt[A-Za-z0-9]+)/.exec(line);
    if (bound && wrapper && wrapper.startsWith('on') && namespace) {
      out.set(bound[1], `${namespace}.${wrapper}`);
    }
  }
  return out;
}

const WRAPPER_SURFACE = collectWrapperSurfaces();

/**
 * The `aegis.<ns>.<on…>` surfaces a real renderer file CALLS, keyed by catalog event.
 *
 * The transport is excluded by path, comments are stripped, and a call must be a real
 * `aegis.…` reference rather than the `aegis.X.onState` shape that appears in prose — which
 * is why this cannot be a plain `includes` over the joined sources.
 */
function collectSubscribed(sources: { file: string; src: string }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { file, src } of sources) {
    if (file === TRANSPORT_RENDERER_PATH) continue;
    for (const m of stripComments(src).matchAll(
      /\baegis\.([A-Za-z][A-Za-z0-9]*)\.(on[A-Za-z0-9]*)/g,
    )) {
      const surface = `${m[1]}.${m[2]}`;
      for (const [key, want] of WRAPPER_SURFACE) {
        if (want !== surface) continue;
        const set = out.get(key) ?? new Set<string>();
        set.add(file);
        out.set(key, set);
      }
    }
  }
  return out;
}

/**
 * Catalogued REQUEST channels that no renderer source ever NAMES.
 *
 * **Currently EMPTY, and that is the goal state.** It held exactly one entry when this
 * direction was written: `zoomReset` (`zoom.reset`). `src/lib/ipcClient.ts` implements
 * `aegis.zoom.reset(viewId)` as `aegis.zoom.set(viewId, 1.0)` — deliberately, so the clamp
 * lives in one place — so nothing in the product could ever emit the channel. It was
 * nevertheless declared in `shared/types.ts`, dispatched in `zoom.rs`, named in
 * `src-tauri/AGENTS.md`, and covered by three Rust unit tests. 2,400 green tests passed,
 * because the three tests drove the dead arm directly and the contract test had parked the
 * channel in `UNPINNED_REQUEST` with a note explaining that nothing emits it. That is a
 * description of a defect filed as if it were a decision, which is why an INVENTORY alone
 * could not catch it: the entry existed, was accurate, and still let the bug through.
 * Deleting the channel is only half the fix; this direction is the other half, so the next
 * one cannot be filed this way.
 *
 * Like `UNSUBSCRIBED_EVENTS`, an entry here is an admission that a real defect exists, and the
 * "no stale entry" test below makes fixing a defect oblige deleting its excuse.
 */
const UNCALLED_REQUESTS: Record<string, string> = {};

/**
 * The catalog keys that are REQUESTS (chrome → core), i.e. everything that is not an event.
 *
 * An event's whole contract lives in the renderer — the core emits it whether or not anyone
 * listens, which is what direction 3 is for. A request's contract lives in BOTH halves: an
 * un-emittable channel is unreachable, and an un-implemented one comes back `Err` from
 * lib.rs's `_` arm (direction 1). This direction covers the remaining failure, the one that
 * needs no bug report and no crash: a channel that is declared, implemented, documented and
 * tested, that the product simply never uses.
 */
const REQUEST_KEYS = Object.keys(IPC).filter((key) => !key.startsWith('evt'));

/**
 * Catalog keys a renderer source actually NAMES, mapped to the files that name them.
 *
 * Comments are stripped first, so a channel cannot be satisfied by a file that merely talks
 * about it — `ipcClient.contract.test.ts` and the docs name channels in prose, and the
 * transport's own header does too.
 *
 * The search space INCLUDES the transport, which is the opposite of direction 3's rule and
 * the single most important difference between the two. A request channel's one and only
 * legitimate reference is the `dedupedCall(IPC.<key>, …)` (or bridge) call inside the wrapper
 * that sends it: the wrappers are the chokepoint every renderer call goes through, so
 * excluding the transport here would report all 100+ channels as uncalled. Direction 3 has
 * the opposite requirement because an `on…` wrapper only proves the core MIGHT be asked; a
 * request wrapper is the send itself.
 *
 * What this does NOT prove: that the wrapper is CALLED. A wrapper nobody calls is a dead
 * renderer method (there is a known one — `aegis.form.onLoginFormDetected`, with no
 * subscriber for the event it wraps, per `UNSUBSCRIBED_EVENTS`), and that is a different
 * defect with a different blast radius. This direction is deliberately "declared but never
 * named", which is the defect that was actually found.
 */
function collectCatalogReferences(
  sources: { file: string; src: string }[],
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { file, src } of sources) {
    for (const m of stripComments(src).matchAll(/\bIPC\.([A-Za-z][A-Za-z0-9]*)/g)) {
      const set = out.get(m[1]) ?? new Set<string>();
      set.add(file);
      out.set(m[1], set);
    }
  }
  return out;
}

/** The keys in `keys` that no source in `sources` names. Pure, so the tests below can drive it. */
function uncalledRequestKeys(keys: string[], sources: { file: string; src: string }[]): string[] {
  const referenced = collectCatalogReferences(sources);
  return keys.filter((key) => !referenced.has(key)).sort();
}

/** The same scan over the real renderer tree, built once for the anti-vacuity assertions. */
const CATALOG_REFERENCES = collectCatalogReferences(readRendererSources());

describe('IPC catalog drift', () => {
  const rustSources = readRustSources();
  const mentioned = collectMentioned(rustSources);
  const acted = collectActed(rustSources);
  const rendererSources = readRendererSources();

  describe('anti-vacuity', () => {
    it('reads the Rust sources at all', () => {
      // A path typo would make every assertion below vacuously pass.
      expect(rustSources.length).toBeGreaterThan(30);
    });

    it('reads the renderer sources at all', () => {
      expect(rendererSources.length).toBeGreaterThan(50);
    });

    it('the FORWARD scanner sees channels across all four dispatch shapes', () => {
      // The deleted `channelDrift.test.ts` warned that an arm-shaped regex silently misses
      // real channels, which is why FORWARD is a blunt whole-file scan. Pin one name per
      // shape actually used, so a future refactor cannot quietly blind it.
      for (const shape of [
        'tabs.create', // plain `match channel` arm
        'adblock.toggleAllowlist', // combined `"a" | "b" =>` arm (adblock.rs:238)
        'picker.start', // guard clause `if channel != "picker.start"` (picker.rs:310)
        'form:detectionResult', // colon-spelled inbound listener (form.rs:115)
      ]) {
        expect(mentioned, `FORWARD scan lost shape: ${shape}`).toContain(shape);
      }
    });

    it('the wrapper scan sees a METHOD-SHORTHAND member, not only a property', () => {
      // The regression this pins: the 4-space key regex required a `:`, and the transport's
      // two method-shorthand members (`form.detectLoginForm`, `form.onLoginFormDetected`) use
      // `(`. One of them was invisible, so `evtFormDetectResult` was exempt from direction 3
      // without the guard ever having seen the wrapper. The anti-vacuity job here is the same
      // as the FORWARD test above — pin one name per SHAPE actually used, so a future regex
      // change cannot quietly blind a shape again.
      expect(WRAPPER_SURFACE.get('evtFormDetectResult')).toBe('form.onLoginFormDetected');
      // The other method/property shape, and the one a first attempt at the fix RE-BROKE:
      // `onWillSubmit: (cb) =>` puts its `IPC.evtFormWillSubmit` on the NEXT line, so the key
      // line ends in `=>` rather than `,` or `{`. Accepting only `,`/`{` made the guard report
      // this event with the PREVIOUS wrapper's name — which is exactly the kind of plausible
      // wrong answer a source scan can produce, and the only reason it was caught.
      expect(WRAPPER_SURFACE.get('evtFormWillSubmit')).toBe('form.onWillSubmit');
      // …and the terminator test, in the other direction: it must reject EXACTLY the 4-space
      // class statements, which the key regex matches but which are not object members. Read the
      // REAL transport rather than asserting against two hardcoded line strings — a rename would
      // leave a hardcoded fixture testing nothing, and "the test still passes" is the failure
      // this file exists to prevent. Pinning the exact rejected SET, rather than only that every
      // rejected line ends in `;`, is what makes a new 4-space non-member shape a failure instead
      // of a silent growth of the rejected list.
      const transport = readFileSync(join(process.cwd(), TRANSPORT_FILE), 'utf8');
      const nonMembers = transport
        .split('\n')
        .filter((l) => /^ {4}[A-Za-z][A-Za-z0-9]*[(:]/.test(l) && wrapperKeyOnLine(l) === null)
        .map((l) => l.trim());
      expect(
        nonMembers,
        'the 4-space lines the key regex matches but must NOT read as members',
      ).toEqual(['super(message);', 'cleanupCache();']);
    });

    it('the REVERSE scanner sees every contract site', () => {
      // Same job for the site-scoped scanner: one name per site kind. If any of these goes
      // missing the REVERSE guard below is checking less than it claims to.
      expect([...acted.keys()]).toEqual(
        expect.arrayContaining([
          'tabs.create', // match arm
          'adblock.removeAllowlist', // combined arm
          'proxy.clear', // guard clause `channel == "proxy.clear"` (proxy.rs:347)
          'proxy.state', // emit_event
          'form:formStateChanged', // listen
        ]),
      );
    });

    it('the catalog parser sees the whole IPC const', () => {
      // Guards the slice in `types.ts` this file depends on: if the const's delimiters move,
      // every direction below would compare against a partial set.
      expect(CATALOG_VALUES.size).toBe(Object.keys(IPC).length);
      expect(CATALOG_VALUES.size).toBeGreaterThan(140);
    });
  });

  describe('direction 1 — every catalog entry has a Rust implementation', () => {
    // A catalog value is dotted; its Rust spelling may be dotted (arm/emit) or colon (listen).
    const isUnimplemented = (ch: string): boolean =>
      !mentioned.has(ch) && !mentioned.has(ch.replace(/\./g, ':'));

    it('has no unexplained orphan', () => {
      const orphans = [...CATALOG_VALUES]
        .filter((ch) => isUnimplemented(ch) && !(ch in FORWARD_UNPRODUCED))
        .sort();

      expect(
        orphans,
        `Declared in shared/types.ts but appearing in NO Rust source (comments stripped), so\n` +
          `nothing implements them. A renderer call for one of these comes back\n` +
          `Err("unknown IPC channel: …") from the \`_\` arm in lib.rs, and a renderer\n` +
          `subscription for one waits forever. Implement the arm, or delete the declaration AND\n` +
          `every renderer reference to it:\n` +
          `  unexplained: ${orphans.join(', ') || '(none)'}\n` +
          `  known-and-explained: ${Object.keys(FORWARD_UNPRODUCED).join(', ') || '(none)'}\n\n` +
          Object.entries(FORWARD_UNPRODUCED)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n'),
      ).toEqual([]);
    });

    it('the FORWARD inventory has no stale entry', () => {
      // Catches an inventory entry that is not a catalog value, and one whose code has since
      // been implemented — so the inventory cannot outlive the defect it records.
      const stale = Object.keys(FORWARD_UNPRODUCED)
        .filter((ch) => !CATALOG_VALUES.has(ch))
        .concat(
          Object.keys(FORWARD_UNPRODUCED)
            .filter((ch) => !isUnimplemented(ch))
            .map((ch) => `${ch} (now implemented in Rust)`),
        )
        .sort();
      expect(
        stale,
        'FORWARD_UNPRODUCED no longer describes reality. Remove the entry (the code is fixed) ' +
          'or rename the key (it is not a catalog entry at all).',
      ).toEqual([]);
    });
  });

  describe('direction 2 — every name Rust acts on is in the catalog', () => {
    it('has no undeclared name', () => {
      const extras = [...acted.keys()]
        .filter((name) => !isCatalogued(name) && !(name in REVERSE_UNDECLARED))
        .sort()
        .map((name) => `${name} (${[...acted.get(name)!].join(', ')})`);

      expect(
        extras,
        `Rust dispatches on, emits, or listens for these names, but shared/types.ts does not\n` +
          `declare them, so the renderer has no way to name one. Either the core is acting on a\n` +
          `name nothing can reach, or the catalog is missing an entry:\n` +
          `  unexplained: ${extras.join(', ') || '(none)'}\n` +
          `  known-and-explained: ${Object.keys(REVERSE_UNDECLARED).join(', ') || '(none)'}\n\n` +
          Object.entries(REVERSE_UNDECLARED)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n'),
      ).toEqual([]);
    });

    it('the REVERSE inventory has no stale entry', () => {
      const stale = Object.keys(REVERSE_UNDECLARED)
        .filter((name) => !acted.has(name))
        .map((name) => `${name} (no longer acted on)`)
        .sort();
      expect(stale, 'REVERSE_UNDECLARED no longer describes reality.').toEqual([]);
    });
  });

  describe('direction 3 — every catalog event is actually subscribed to', () => {
    // The name says "actually" for a reason, and the distinction is the whole fix. This used
    // to read "is subscribed to by the renderer" while searching for the literal `IPC.evtKey`
    // under `src/` — and `ipcClient.ts`, which is under `src/`, defines that literal for every
    // event it wraps. So the transport satisfied the search for itself: stubbing out a REAL
    // `aegis.nav.onState(...)` subscription left all 12 tests green. A name in the catalog that
    // no component actually listens to is the same defect class as `subs.changed` and
    // `picker.picked`, and this direction is now the one that can see it.
    const subscribed = collectSubscribed(rendererSources);

    it('has no unsubscribed event', () => {
      const unsubscribed = Object.entries(IPC)
        .filter(([key]) => key.startsWith('evt'))
        .filter(([key, value]) => {
          if (key in UNSUBSCRIBED_EVENTS) return false;
          // An event with no wrapper at all is a DIFFERENT defect, and it is already
          // gated by `ipcClient.contract.test.ts`'s derived ratchet (which expects the
          // unaccounted set to be `[]`). Reporting it here too would blame this direction for
          // a missing wrapper, so say which half is missing instead.
          const surface = WRAPPER_SURFACE.get(key);
          if (!surface) return false;
          return !subscribed.has(key);
        })
        .map(
          ([key, value]) => `${key} => ${value} (wrapper ${WRAPPER_SURFACE.get(key)}, no caller)`,
        )
        .sort();

      expect(
        unsubscribed,
        `These catalog events are never referenced by any src/ file (specs and the IPC mock\n` +
          `excluded, since neither is a real subscriber), so the core emits into the void:\n` +
          `  unexplained: ${unsubscribed.join(', ') || '(none)'}\n` +
          `  known-and-explained: ${Object.keys(UNSUBSCRIBED_EVENTS).join(', ') || '(none)'}\n\n` +
          Object.entries(UNSUBSCRIBED_EVENTS)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n'),
      ).toEqual([]);
    });

    it('the UNSUBSCRIBED_EVENTS inventory has no stale entry', () => {
      // Was `rendererText.includes('IPC.' + key)`, which the transport alone satisfied — the
      // same blind spot as the direction above, in the test that is supposed to catch a stale
      // excuse. It now asks the real question.
      const stale = Object.keys(UNSUBSCRIBED_EVENTS)
        .filter((key) => subscribed.has(key))
        .map((key) => `${key} (now subscribed by ${[...subscribed.get(key)!].join(', ')})`)
        .sort();
      expect(stale, 'UNSUBSCRIBED_EVENTS no longer describes reality.').toEqual([]);
    });

    describe('anti-vacuity — the two things that could make the above pass for nothing', () => {
      it('the wrapper map is parsed out of the transport, not empty', () => {
        // An empty map would make every event "has no wrapper" and therefore exempt.
        expect(WRAPPER_SURFACE.size).toBeGreaterThan(20);
        expect(WRAPPER_SURFACE.get('evtNavState')).toBe('nav.onState');
        expect(WRAPPER_SURFACE.get('evtPickerPicked')).toBe('picker.onPicked');
        // The irregular names are the point: a mechanical `evtKey -> ns.onKey` derivation
        // would get both of these wrong, which is why it is parsed.
        expect(WRAPPER_SURFACE.get('evtSubsChanged')).toBe('subs.onChanged');
      });

      it('the subscriber search sees files other than the transport', () => {
        // If `readRendererSources` were narrowed until only the transport remained, every
        // event would look unsubscribed and the direction would fail loudly — fine. The
        // dangerous case is the opposite: a search space of ONE file, which is what the old
        // guard actually had. So assert the space is plural.
        // The exclusion must actually exclude: `rendererSources` names files relative to
        // `src/`, so an exclusion written with the repo-relative path matches nothing and
        // this count is one too high for the wrong reason.
        expect(rendererSources.map(({ file }) => file)).toContain(TRANSPORT_RENDERER_PATH);
        const searched = rendererSources.filter(({ file }) => file !== TRANSPORT_RENDERER_PATH);
        expect(searched.length).toBe(rendererSources.length - 1);
        expect(searched.length).toBeGreaterThan(50);
        expect(subscribed.get('evtNavState')?.size ?? 0).toBeGreaterThan(0);
      });

      it('the transport itself can never satisfy the search', () => {
        // Pins the actual fix. If `TRANSPORT_FILE` were ever dropped from the exclusion, this
        // fails before the direction silently stops working again.
        // The fixture is named the way `readRendererSources` names files, which is the only
        // way it can exercise the exclusion at all - with the repo-relative path it would
        // not match and the assertion below would pass for the wrong reason.
        const viaTransport = collectSubscribed([
          { file: TRANSPORT_RENDERER_PATH, src: 'aegis.nav.onState(() => {});' },
        ]);
        expect(viaTransport.size, 'the transport must not be able to subscribe to itself').toBe(0);
      });

      it('a comment naming a subscription is not a subscription', () => {
        // `ipcClient.ts`'s own header contains `aegis.X.onState` in prose, and other files
        // document their listeners. Stripping comments is what keeps those from passing.
        const viaComment = collectSubscribed([
          { file: 'src/components/Commented.tsx', src: '// aegis.nav.onState(() => {})\n' },
        ]);
        expect(viaComment.size).toBe(0);
      });
    });
  });

  describe('direction 4 — event names go through emit_event, never raw', () => {
    it('no channel-shaped literal reaches a raw Tauri emit', () => {
      // Tauri 2 REJECTS a dotted event name, so a raw `app.emit("nav.state", …)` is not a
      // working shortcut — it is a silent no-op. Every event must go through
      // `lib.rs::emit_event`, which rewrites `.` → `:`. That one call is allowed to contain a
      // string (it is the rewrite itself, `":"`), which CHANNEL_LITERAL correctly rejects.
      const RAW_EMIT = /\.(?:emit|emit_to|emit_all|emit_filter|emit_to_all)\s*\(/g;
      const offenders: string[] = [];
      for (const { file, src } of rustSources) {
        const clean = stripComments(src);
        clean.split('\n').forEach((line, i) => {
          RAW_EMIT.lastIndex = 0;
          if (!RAW_EMIT.test(line)) return;
          for (const m of line.matchAll(/"([^"\\\n]*)"/g)) {
            if (CHANNEL_LITERAL.test(m[1])) {
              offenders.push(`${file}:${i + 1}: ${line.trim()}`);
            }
          }
        });
      }
      expect(
        offenders,
        'These call a Tauri emit directly with a channel-shaped name. Tauri 2 forbids dots in ' +
          'event names, so this silently delivers nothing. Use `crate::emit_event`, which ' +
          'rewrites `.` to `:`:\n  ' +
          (offenders.join('\n  ') || '(none)'),
      ).toEqual([]);
    });
  });

  describe('direction 5 - every declared request channel is actually named by the renderer', () => {
    it('has no uncalled request channel', () => {
      const uncalled = uncalledRequestKeys(REQUEST_KEYS, readRendererSources()).filter(
        (key) => !(key in UNCALLED_REQUESTS),
      );

      expect(
        uncalled,
        `Declared in shared/types.ts as a REQUEST, but no renderer source ever writes\n` +
          `IPC.<key> for it (specs, the mock and comments excluded), so no user action can\n` +
          `reach it. The Rust arm, its unit tests and its documentation are all real code\n` +
          `exercising a path the product does not take. Either make the renderer send it, or\n` +
          `delete the declaration, the dispatch arm, the tests and the docs together:\n` +
          `  unexplained: ${uncalled.join(', ') || '(none)'}\n` +
          `  known-and-explained: ${Object.keys(UNCALLED_REQUESTS).join(', ') || '(none)'}\n\n` +
          Object.entries(UNCALLED_REQUESTS)
            .map(([k, v]) => `  ${k}: ${v}`)
            .join('\n'),
      ).toEqual([]);
    });

    it('the UNCALLED_REQUESTS inventory has no stale entry', () => {
      // Bidirectional, like the three inventories above: an entry must be a catalog REQUEST
      // key, and it must genuinely be unreferenced. The second half is the one that matters -
      // an entry left behind after a channel got wired would keep the gate quiet forever.
      const stale = Object.keys(UNCALLED_REQUESTS)
        .filter((key) => !REQUEST_KEYS.includes(key))
        .concat(
          uncalledRequestKeys(Object.keys(UNCALLED_REQUESTS), readRendererSources()).length === 0
            ? Object.keys(UNCALLED_REQUESTS).map((key) => `${key} (now named by the renderer)`)
            : [],
        )
        .sort();
      expect(
        stale,
        'UNCALLED_REQUESTS no longer describes reality. Remove the entry (the channel is ' +
          'called now) or rename the key (it is not a request channel in the catalog).',
      ).toEqual([]);
    });

    describe('anti-vacuity - the three things that could make the above pass for nothing', () => {
      it('the search sees the transport, which is where a request is actually sent', () => {
        // The inverse of direction 3's "the transport can never satisfy the search". If the
        // transport were excluded here, every channel would look uncalled and the direction
        // would fail loudly - the dangerous case is a search space that cannot see a real
        // reference at all, so assert a real one is visible, in the real file.
        expect(
          [...(CATALOG_REFERENCES.get('zoomSet') ?? [])],
          'a live request channel must be visible, and through the transport',
        ).toContain(TRANSPORT_RENDERER_PATH);
        expect(CATALOG_REFERENCES.size).toBeGreaterThan(50);
        expect(readRendererSources().length).toBeGreaterThan(50);
      });

      it('a comment naming a request channel is not a call', () => {
        // `ipcClient.contract.test.ts` and the AGENTS.md files name channels in prose. Without
        // comment stripping a channel deleted from the transport would stay green.
        expect(
          collectCatalogReferences([
            { file: 'src/lib/Commented.ts', src: '// dedupedCall(IPC.zoomSet, { viewId: 1 })\n' },
          ]).size,
        ).toBe(0);
      });

      it('the predicate reports a channel that nothing names', () => {
        // The direction above is a `toEqual([])`, which passes just as happily if the
        // predicate is vacuous. Drive it with a REAL catalog key and a source set that does
        // not name it: a predicate that always returned `[]`, or one that counted comments,
        // fails here.
        expect(uncalledRequestKeys(['zoomSet'], readRendererSources())).toEqual([]);
        expect(
          uncalledRequestKeys(
            ['zoomSet'],
            [{ file: 'src/components/Quiet.tsx', src: 'export {};\n' }],
          ),
        ).toEqual(['zoomSet']);
      });
    });
  });
});
