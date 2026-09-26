// src/autopilot/channelDrift.test.ts
//
// The Rust→TypeScript half of the IPC drift guard.
//
// `coverage.test.ts` asserts the OTHER direction: every `IPC.*` value must appear in some
// `CATALOG[*].channels` entry, so a new channel cannot be added without an autopilot
// exercise. That guard is one-directional, and it is blind to the failure that actually
// happens: a channel that exists in `shared/types.ts` but has NO Rust arm behind it.
//
// That failure is invisible by construction. `src/autopilot/catalog.ts` exercises channels
// against `testFixtures/aegisMock.ts`, so `exercise()` passes against a mock whether or not
// the Rust dispatcher implements the channel. The real instance was `vault.autofill` —
// declared, typed `Promise<VaultRecord[]>`, and unit-tested in a hook test (also against the
// mock), with no `"vault.autofill"` arm anywhere in `vault.rs`.
//
// This test closes that direction by reading the Rust source. It is a source scan, not a
// behavioural test — a behavioural test is impossible here: `ipc` takes a concrete wry
// `&AppHandle` and cannot be driven from a `MockRuntime` harness, which is the same
// limitation that keeps most `dispatch` entry points untested.
//
// Implementation note: this deliberately does NOT try to parse `dispatch` shapes. Channels
// are handled in at least four different ways in this codebase — a `match` arm, a combined
// `"a" | "b" =>` arm, a guard clause (`if channel != "picker.start"`, picker.rs:301), and
// constants — so an arm-shaped regex silently misses real channels. Instead it collects
// every channel-shaped string literal in comment-stripped Rust. Stripping comments matters:
// `data.rs` and `settings.rs` both name channels in prose, and a comment must never be able
// to satisfy the guard.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IPC } from '../../shared/types';

const RUST_DIR = join(__dirname, '..', '..', 'src-tauri', 'src');

/**
 * Declared channels with no Rust producer, and why that is deliberate.
 *
 * This is an INVENTORY, not an allowlist to make the test green: the test asserts the
 * orphan set equals exactly these keys, so a fourth unexplained orphan fails the build,
 * and every entry carries a verified reason. Do not add a key to silence a failure —
 * that is the same fabricated-rationale antipattern as the non-asserting assertion in
 * `CommandPalette.test.tsx`. Fix the code or the contract instead.
 */
const KNOWN_UNPRODUCED: Record<string, string> = {
  'redirect.blocked':
    'NOT EMITTED, and emitting it would be a bug. Desktop already opens the blocked ' +
    'destination in `redirect_guard::on_blocked_redirect_to_new_tab` and Android injects ' +
    '`window.__aegisOpenTab(...)`, while the renderer callback `App.tsx` ALSO calls ' +
    '`tabs.create(r.to, true)` — so an emit would open two background tabs per blocked ' +
    'redirect. The dead producer is load-bearing. If you wire it up, delete one open path.',
};

/** A channel name: lowercase head segment, then dot- or colon-separated segments. */
const CHANNEL_LITERAL = /^([a-z][A-Za-z0-9]*(?:[.:][A-Za-z0-9]+)+)$/;

function readRustSources(): { file: string; src: string }[] {
  return readdirSync(RUST_DIR)
    .filter((f) => f.endsWith('.rs'))
    .map((f) => ({ file: f, src: readFileSync(join(RUST_DIR, f), 'utf8') }));
}

/** Remove line comments and block comments, keeping string literals intact. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      // Only strip a `//` that is not inside a string, i.e. not preceded by an odd number of
      // unescaped quotes. Crude but adequate: a `//` inside a Rust string literal in this
      // codebase only ever appears in a URL, and dropping the rest of such a line is safe
      // because the channel literal we care about precedes it.
      const at = line.indexOf('//');
      if (at < 0) return line;
      const before = line.slice(0, at);
      const quotes = (before.match(/"/g) ?? []).length;
      return quotes % 2 === 1 ? line : before;
    })
    .join('\n');
}

/** Every channel-shaped string literal in the Rust sources, in BOTH the dotted (logical,
 *  as declared in `shared/types.ts`) and colon (wire, as Tauri 2 requires for event names)
 *  spellings. */
function collectRustChannels(sources: { src: string }[]): Set<string> {
  const out = new Set<string>();
  for (const { src } of sources) {
    for (const m of stripComments(src).matchAll(/"([^"\\\n]*)"/g)) {
      const name = m[1];
      if (CHANNEL_LITERAL.test(name)) out.add(name);
      // A URL like "https://x" also matches the shape above, so keep only names whose first
      // segment is a plausible channel head by requiring no `//`.
      if (name.includes('//')) out.delete(name);
    }
  }
  return out;
}

describe('IPC channel drift (Rust is the source of truth)', () => {
  const sources = readRustSources();
  const rustChannels = collectRustChannels(sources);

  it('reads the Rust sources at all', () => {
    // A path typo would make every assertion below vacuously pass, so check it loaded.
    expect(sources.length).toBeGreaterThan(30);
  });

  it('every channel declared in shared/types.ts is backed by Rust', () => {
    const orphans = Object.values(IPC).filter((ch) => {
      if (rustChannels.has(ch)) return false;
      // Events travel in the colon spelling; the renderer translates on the way in
      // (`ipcClient.ts` `on()`), so accept either form.
      if (rustChannels.has(ch.replace(/\./g, ':'))) return false;
      // A declared channel with no producer is only acceptable if it is listed below
      // WITH its reason. The set is asserted exactly, so a new orphan still fails.
      return !(ch in KNOWN_UNPRODUCED);
    });

    expect(
      orphans,
      `Declared in shared/types.ts but appearing in NO Rust source (comments stripped), so\n` +
        `nothing implements them. A renderer subscription or call for one of these waits\n` +
        `forever, or gets a rejected promise. Implement the arm, or delete the declaration\n` +
        `AND every renderer subscription to it:\n` +
        `  unexpected: ${orphans.join(', ')}\n` +
        `  known-and-explained: ${Object.keys(KNOWN_UNPRODUCED).join(', ') || '(none)'}\n\n` +
        Object.entries(KNOWN_UNPRODUCED)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join('\n'),
    ).toEqual([]);
  });

  it('sanity: the scan finds channels across all four dispatch shapes', () => {
    // If this file's scanning ever stops working, the test above goes green while checking
    // nothing. Pin one channel per shape actually used in the codebase.
    for (const known of [
      'tabs.create', // plain match arm
      'adblock.toggleAllowlist', // combined `"a" | "b" =>` arm (adblock.rs:234)
      'picker.start', // guard clause `if channel != "picker.start"` (picker.rs:301)
      'form:detectionResult', // colon-spelled event, listen() not emit()
    ]) {
      expect(rustChannels, `expected to find the Rust literal ${known}`).toContain(known);
    }
  });
});
