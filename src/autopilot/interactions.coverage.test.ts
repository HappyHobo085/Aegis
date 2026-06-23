// src/autopilot/interactions.coverage.test.ts
// Drift guard: asserts that the INTERACTIONS registry stays consistent with
// INTERACTIVE_CONTROLS and that every interaction targets a real screen.
import { describe, it, expect } from 'vitest';
import { INTERACTIONS, INTERACTIVE_CONTROLS } from './interactions';
import { SCREENS } from './screens';

describe('interaction coverage drift guard', () => {
  const ids = INTERACTIONS.map((i) => i.id);
  it('interaction ids are unique', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every interaction targets a real screen and declares ≥1 layer', () => {
    const screens = new Set(SCREENS.map((s) => s.id));
    for (const i of INTERACTIONS) {
      expect(screens.has(i.screen), `${i.id} screen`).toBe(true);
      expect(i.layers.length, `${i.id} layers`).toBeGreaterThan(0);
    }
  });
  it('every registered interactive control has ≥1 interaction', () => {
    for (const control of INTERACTIVE_CONTROLS)
      expect(
        ids.some((id) => id.startsWith(control)),
        `control ${control} has no interaction`,
      ).toBe(true);
  });
});
