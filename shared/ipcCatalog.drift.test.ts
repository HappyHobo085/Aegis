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
 * - `subs.changed` — a real defect, not a seam. `subs.rs:199` and `subs.rs:292` emit it after
 *   a background fetch or auto-refresh, but no renderer code subscribes (no `IPC.` key and no
 *   literal spelling appears anywhere under `src/`), and `git log -S 'subs.changed' -- '*.ts'`
 *   is empty, so no subscriber ever existed. `useSubscriptions` therefore shows a stale
 *   `lastUpdated`/etag/hash after a background refresh. This is a pre-existing audit finding
 *   recorded in the now-deleted `docs/CODE_AUDIT.md` (commit 811fa7f: "Rust `subs.changed`
 *   event is emitted but never subscribed by the renderer") and it was never fixed. The fix is
 *   a product decision — add `evtSubsChanged` + a `subs.onChanged` wrapper and re-fetch, or
 *   delete the two emits — so it is recorded here rather than silently resolved.
 */
const REVERSE_UNDECLARED: Record<string, string> = {
  'form:formStateChanged':
    'Deliberate inert seam. `form.rs:140` listens for it; nothing can send it (see the ' +
    'STATUS block atop `form.rs`). The core relays it to the chrome as `form.state`, which IS ' +
    'catalogued, so the relay is wired and only the inbound leg is missing.',
  'subs.changed':
    'Pre-existing defect, never fixed. `subs.rs:199` and `subs.rs:292` emit it; no renderer ' +
    'code subscribes and none ever did. A background subscription refresh therefore leaves an ' +
    'open Filter Lists tab showing stale metadata. Recorded in the deleted ' +
    '`docs/CODE_AUDIT.md` (811fa7f). Needs a product decision, not a test.',
};

/**
 * Catalogued EVENTS that no renderer source ever references.
 *
 * One entry, and it is the sibling finding of `subs.changed`: the audit called `picker.picked`
 * "the same dead-emit class". `picker.rs:301` emits it and `shared/types.ts:88` declares
 * `evtPickerPicked`, but `src/lib/ipcClient.ts` never grows an `on…` wrapper for it, so the
 * event is delivered to nobody. The remaining 27 catalog events are all referenced.
 */
const UNSUBSCRIBED_EVENTS: Record<string, string> = {
  evtPickerPicked:
    '`picker.rs:301` emits `picker.picked` and `shared/types.ts:88` declares `evtPickerPicked`, ' +
    'but no `src/` file references `IPC.evtPickerPicked` and no `on…` wrapper exists in ' +
    '`ipcClient.ts`. Add the rule through the picker overlay, or delete the event on both sides.',
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

  describe('direction 3 — every catalog event is subscribed to by the renderer', () => {
    it('has no unsubscribed event', () => {
      // A name in the catalog that no renderer source mentions is the same class of defect as
      // `subs.changed` in the other direction: the event fires and nobody hears it.
      const rendererText = rendererSources.map(({ src }) => src).join('\n');
      const unsubscribed = Object.entries(IPC)
        .filter(([key]) => key.startsWith('evt'))
        .filter(([key]) => !rendererText.includes(`IPC.${key}`) && !(key in UNSUBSCRIBED_EVENTS))
        .map(([key, value]) => `${key} => ${value}`)
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
      const rendererText = rendererSources.map(({ src }) => src).join('\n');
      const stale = Object.keys(UNSUBSCRIBED_EVENTS)
        .filter((key) => rendererText.includes(`IPC.${key}`))
        .map((key) => `${key} (now subscribed)`)
        .sort();
      expect(stale, 'UNSUBSCRIBED_EVENTS no longer describes reality.').toEqual([]);
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
});
