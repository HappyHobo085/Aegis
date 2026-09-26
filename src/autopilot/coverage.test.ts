// src/autopilot/coverage.test.ts
import { describe, it, expect } from 'vitest';
import { IPC } from '../../shared/types';
import { CATALOG, UNTESTED_CHANNELS } from './catalog';

// Command channels (renderer -> core). Events (evt*) are excluded — they are
// inbound and covered by the screen walk / component tests.
const COMMAND_CHANNELS = Object.entries(IPC)
  .filter(([k]) => !k.startsWith('evt'))
  .map(([, v]) => v);

describe('catalog drift guard', () => {
  it('every command channel is covered by a catalog entry or explicitly excused', () => {
    const covered = new Set(CATALOG.flatMap((c) => c.channels));
    const missing = COMMAND_CHANNELS.filter((ch) => !covered.has(ch) && !UNTESTED_CHANNELS.has(ch));
    expect(missing, `uncovered IPC channels: ${missing.join(', ')}`).toEqual([]);
  });
  it('catalog entries have unique ids and reference real channels', () => {
    const all = new Set<string>(Object.values(IPC));
    expect(new Set(CATALOG.map((c) => c.id)).size).toBe(CATALOG.length);
    for (const c of CATALOG) for (const ch of c.channels) expect(all.has(ch), ch).toBe(true);
  });
  it('UNTESTED_CHANNELS is documentation, not an escape hatch: every excused channel still has a catalog entry', () => {
    const covered = new Set(CATALOG.flatMap((c) => c.channels));
    for (const ch of UNTESTED_CHANNELS) {
      expect(covered.has(ch), `${ch} is in UNTESTED_CHANNELS but no catalog entry lists it`).toBe(
        true,
      );
    }
  });

  // `FeatureCheck` used to have an optional `verify(api)` round-trip, and 19 entries
  // implemented it. Nothing called it: `tour.test.tsx` calls only `exercise`, and the
  // "live run" it referenced (`run.ts` / `RunDeps.live`) does not exist. So ~470 lines of
  // round-trip logic read as coverage while executing never — and the root `AGENTS.md`
  // *instructed* contributors to add one, which manufactured dead code on purpose.
  //
  // This test exists so nobody helpfully puts it back. It is deliberately narrow: it
  // pins the absence of the one field whose absence we decided on, not a general
  // "every property is exercised" rule. If you need a real round-trip, add it to
  // `src/autopilot/interactions/` (drives the UI, runs in `npm test`) or as a unit test in
  // the owning Rust module.
  it('no catalog entry carries a verify round-trip: nothing would call it', () => {
    const withVerify = CATALOG.filter((c) => 'verify' in c).map((c) => c.id);
    expect(
      withVerify,
      'FeatureCheck.verify was removed because no test invoked it. Put the round-trip in ' +
        'src/autopilot/interactions/ or a Rust unit test instead.',
    ).toEqual([]);
  });
});
