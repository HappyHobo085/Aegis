import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Anchor on process.cwd() (repo root) — import.meta.url is not a file URL in jsdom.
const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

/** Return the declaration block (between `{` and the next `}`) for an EXACT selector.
 *  The target selectors contain no nested braces, so matching to the next `}` is safe. */
function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
  if (!m) throw new Error(`selector not found in src/index.css: ${selector}`);
  return m[1];
}

// Each mobile full-window surface must reference the inset var(s) for the edges it touches.
const REQUIRED: Array<[string, string[]]> = [
  ['.mobile-topbar', ['--aegis-inset-top', '--aegis-inset-left', '--aegis-inset-right']],
  ['.mobile-bottombar', ['--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right']],
  [
    '.mobile-sheet',
    ['--aegis-inset-top', '--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right'],
  ],
  [
    '.aegis-mobile .settings-modal__content',
    ['--aegis-inset-top', '--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right'],
  ],
  [
    '.aegis-mobile .downloads-modal',
    ['--aegis-inset-top', '--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right'],
  ],
  [
    '.aegis-mobile .onboarding',
    ['--aegis-inset-top', '--aegis-inset-bottom', '--aegis-inset-left', '--aegis-inset-right'],
  ],
  ['.aegis-mobile .toaster', ['--aegis-inset-bottom', '--aegis-inset-right']],
];

describe('mobile chrome stays within the safe area (all four edges)', () => {
  for (const [selector, vars] of REQUIRED) {
    it(`${selector} references ${vars.join(', ')}`, () => {
      const body = block(selector);
      for (const v of vars) expect(body, `${selector} missing ${v}`).toContain(v);
    });
  }
});
