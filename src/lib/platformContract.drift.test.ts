// src/lib/platformContract.drift.test.ts
//
// Two cross-boundary contracts that NOTHING in the test suite enforced. Both are
// DERIVED — the expected list is computed from the code that defines it — so a new
// surface cannot join either class silently. Neither has a user-facing symptom the
// existing tests would catch, which is why they were lost in the first place.
//
// Each guard is a completeness TRIGGER, not the assertion. The assertion is the
// mutation recipe recorded in each describe: break the relation and the guard must go
// red and NAME the file/selector at fault.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const COMPONENTS = join(ROOT, 'src', 'components');
const INDEX_CSS = join(ROOT, 'src', 'index.css');
const MAIN_ACTIVITY = join(
  ROOT,
  'src-tauri',
  'gen',
  'android',
  'app',
  'src',
  'main',
  'java',
  'com',
  'aegis',
  'browser',
  'MainActivity.kt',
);

/** Desktop component files, one level down — `components/mobile/**` is a separate shell. */
function desktopComponentFiles(): string[] {
  return readdirSync(COMPONENTS)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .sort();
}

describe('a chrome popover that measures itself must reserve its height', () => {
  // useChromePopover.tsx states the invariant in prose:
  //   "every popover measures itself (see useMeasuredHeight) and registers its height
  //    here. A new popover that forgets to register renders behind the content, which
  //    is exactly the bug the site-information popover shipped with."
  //
  // The registry itself is well covered (useChromePopover.test.tsx has 6 tests). What
  // nothing checked is the LINKAGE — so the prose above was the only enforcement, and
  // a new popover that measured itself without registering would render behind the
  // OPAQUE content webview and be invisible, with every test still green.
  //
  // Mobile is deliberately out of scope: MobileApp.tsx:133 records that the Android
  // shell is a single webview whose native content view is lowered through
  // `view.setChromeOverlay` instead, so a mobile surface has nothing to reserve.
  function popoverComponents(): string[] {
    return desktopComponentFiles().filter((f) =>
      readFileSync(join(COMPONENTS, f), 'utf8').includes('useMeasuredHeight'),
    );
  }

  it('finds the desktop popovers at all, so the guard cannot pass by measuring nothing', () => {
    // ASCII order, not alphabetical-by-eye: 'Adb' sorts before 'Add' ('b' < 'd').
    expect(popoverComponents()).toEqual([
      'AdblockShield.tsx',
      'AddressBar.tsx',
      'ZoomIndicator.tsx',
    ]);
  });

  it('every component that measures a popover also registers its height', () => {
    const offenders = popoverComponents().filter(
      (f) => !readFileSync(join(COMPONENTS, f), 'utf8').includes('useChromePopoverInset'),
    );
    expect(
      offenders,
      offenders.length
        ? `these components measure a chrome popover but never call useChromePopoverInset, so the ` +
            `OPAQUE content webview is never lowered for them and the popover renders BEHIND the page. ` +
            `Register it — see useChromePopover.tsx.`
        : '',
    ).toEqual([]);
  });
});

describe('every inset the Android shell pushes in must be consumed, and vice versa', () => {
  // MainActivity.kt:806-809 pushes the REAL system status/nav bar insets in as
  // --aegis-inset-{top,bottom,left,right}. index.css consumes them as
  // `var(--aegis-inset-top, env(safe-area-inset-top))`.
  //
  // Drift in EITHER direction is a real bug and neither was catchable:
  //  - a surface that forgets to consume an inset renders under the status bar;
  //  - a rule consuming a var the native side never sets silently falls back to
  //    env(safe-area-inset-*), which index.css:5181-5183 records as being only the
  //    DISPLAY CUTOUT on an Android WebView — so it cannot clear the system bars.
  function writtenInsets(): Set<string> {
    const kt = readFileSync(MAIN_ACTIVITY, 'utf8');
    return new Set([...kt.matchAll(/setProperty\('(--aegis-inset-[a-z]+)'/g)].map((m) => m[1]));
  }

  function consumedInsets(): Map<string, string[]> {
    const css = readFileSync(INDEX_CSS, 'utf8');
    const byVar = new Map<string, string[]>();
    for (const m of css.matchAll(/var\((--aegis-inset-[a-z]+)/g)) {
      const varName = m[1];
      // The rule's selector: walk back to the nearest selector line so a failure can
      // NAME the surface that is wrong, not just the variable.
      const before = css.slice(0, m.index);
      const sel =
        before
          .split('\n')
          .filter((l) => /^\s*[.#[][^{]*\{\s*$/.test(l))
          .pop() ?? '<unknown rule>';
      byVar.set(varName, [...(byVar.get(varName) ?? []), sel.trim()]);
    }
    return byVar;
  }

  it('finds the four insets the native side sets, so the guard cannot pass by reading nothing', () => {
    expect([...writtenInsets()].sort()).toEqual([
      '--aegis-inset-bottom',
      '--aegis-inset-left',
      '--aegis-inset-right',
      '--aegis-inset-top',
    ]);
  });

  it('no rule consumes an inset the Android shell never sets', () => {
    const written = writtenInsets();
    const consumed = [...consumedInsets().keys()].filter((v) => !written.has(v));
    expect(
      consumed,
      consumed.length
        ? `these CSS rules fall back to env(safe-area-inset-*), which on an Android WebView is only ` +
            `the display cutout and CANNOT clear the system bars — index.css:5181-5183. Either ` +
            `MainActivity.kt pushes this inset or the rule should not consume it.`
        : '',
    ).toEqual([]);
  });

  it('every inset the Android shell sets is consumed by at least one rule', () => {
    const consumed = consumedInsets();
    const unconsumed = [...writtenInsets()].filter((v) => !consumed.has(v));
    expect(
      unconsumed,
      unconsumed.length
        ? `MainActivity.kt pushes ${unconsumed.join(', ')} for the real system bars, but no rule in ` +
            `index.css consumes it — so the value is computed and thrown away, and the surfaces that ` +
            `need it render under the system UI.`
        : '',
    ).toEqual([]);
  });
});
