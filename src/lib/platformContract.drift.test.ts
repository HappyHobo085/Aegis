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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

describe('no popover reserves a content-top inset any more', () => {
  // This whole mechanism is DELETED, and the deletion is the guard.
  //
  // A popover used to measure itself and register its height; `App` added the tallest one to
  // the content-top inset so the opaque content webview would clear it. That is what made the
  // page jump, and for the omnibox it closed a feedback loop: the inset resized the content
  // webview, the resize re-laid-out the chrome, and the chrome re-measured the dropdown —
  // ~57 layout passes per second while typing. Every popover now renders on the popover
  // surface, a sibling webview that floats over the page, so there is no inset to reserve.
  //
  // Both halves matter and they are different kinds of check. The module being ABSENT stops
  // anyone reaching for the old hook; `App` not adding a term stops someone re-deriving the
  // arithmetic inline, which is the shape the bug had.

  it('the inset hook and its registry are gone, not merely unused', () => {
    for (const f of [
      join(ROOT, 'src', 'hooks', 'useChromePopover.tsx'),
      join(ROOT, 'src', 'hooks', 'useMeasuredHeight.ts'),
    ]) {
      expect(existsSync(f), `${f} must be deleted — the inset mechanism it served is gone`).toBe(
        false,
      );
    }
  });

  it('no renderer file imports the deleted hooks', () => {
    // A DERIVED scan, so a re-introduction is caught wherever it happens rather than only in
    // the three components this feature currently touches.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          // Comments stripped first, or every explanatory note about the deleted mechanism
          // reads as an import. Same rule as `subscribeBeforeFetch`'s scan.
          const text = readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
          if (/useChromePopover|useMeasuredHeight/.test(text)) offenders.push(full);
        }
      }
    };
    walk(join(ROOT, 'src'));
    // This file names both hooks on purpose (that is the scan's pattern), so it excludes
    // itself — otherwise the guard can only ever fail.
    expect(
      offenders.filter((f) => f !== __filename),
      `these files still reference the deleted inset hooks: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('App derives the content top from the chrome alone', () => {
    // The arithmetic, pinned. `contentTop` must be `chrome.topInset` and nothing else: the
    // FindBar is already inside `chrome.topInset` (useChromeHeights measures it), so adding a
    // term here would double-count it to 80px — which is exactly what happened before.
    const app = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8');
    const decl = app.match(/const contentTop = ([^;]+);/);
    expect(decl, 'App.tsx must still derive contentTop').not.toBeNull();
    expect(decl?.[1].trim()).toBe('chrome.topInset');
  });
});

describe('a popover measured for the SURFACE must place itself on it', () => {
  // `useMeasuredRect` measures a popover so `usePopoverSurface` can put the surface exactly over
  // it. Measured but never placed is a popover that is invisible AND still reserving nothing:
  // the user types and nothing appears anywhere. The reverse — placed without measuring — cannot
  // happen, because an unmeasured rect is treated as closed.
  //
  // This is the rule the spec's §9.5 asks for, ADDED alongside the height rule rather than
  // replacing it: three popovers still take the inset path until Phase 4, so both rules are
  // live and both have offenders to name.
  function surfaceComponents(): string[] {
    return desktopComponentFiles().filter((f) =>
      readFileSync(join(COMPONENTS, f), 'utf8').includes('useMeasuredRect'),
    );
  }

  it('finds the surface popovers at all, so the guard cannot pass by measuring nothing', () => {
    // ASCII order, not alphabetical-by-eye: 'Adb' sorts before 'Add' ('b' < 'd').
    expect(surfaceComponents()).toEqual([
      'AdblockShield.tsx',
      'AddressBar.tsx',
      'ZoomIndicator.tsx',
    ]);
  });

  it('every component that measures a rect for the surface also places it', () => {
    const offenders = surfaceComponents().filter(
      (f) => !readFileSync(join(COMPONENTS, f), 'utf8').includes('usePopoverSurface'),
    );
    expect(
      offenders,
      offenders.length
        ? `these components measure a popover for the popover surface but never call ` +
            `usePopoverSurface, so the surface is never placed and the popover shows nowhere. ` +
            `Call it — see hooks/usePopoverSurface.ts.`
        : '',
    ).toEqual([]);
  });

  it('declares both row actions the omnibox surface is allowed to report', () => {
    // `actions` is the surface's ALLOWLIST and Rust drops anything outside it, so an omitted
    // action is a silently dead control rather than a type error. `hover` in particular is
    // easy to forget and its absence only shows as Enter opening the wrong row.
    const src = readFileSync(join(COMPONENTS, 'AddressBar.tsx'), 'utf8');
    const declared = src.match(/OMNIBOX_ACTIONS[^=]*=\s*\[([^\]]*)\]/);
    expect(declared, 'AddressBar must declare OMNIBOX_ACTIONS as a literal').not.toBeNull();
    const actions = (declared?.[1] ?? '')
      .split(',')
      .map((a) => a.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(actions.sort()).toEqual(['hover', 'pick']);
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

describe('the two React roots must share one stylesheet', () => {
  // The app has two renderer entries: `src/index.html` (the chrome) and `src/popover.html`
  // (the popover surface, its own webview with its own capability and no `ipc`). Two roots
  // means two places where theming can drift: give the surface its own copy of the
  // variables and a light/dark switch in one root stops working in the other, which shows up
  // as a popover painted in the wrong theme with nothing in any test red.
  //
  // Both entries import the ONE `index.css`. This guards that, and it is a completeness
  // trigger: `htmlEntries()` globs, so a third `.html` dropped into src/ obliges this to
  // account for it.
  //
  // MUTATION RECIPE: change `src/popover.tsx` to import a copied stylesheet (or a second
  // one). The guard must go red and NAME the file.

  /** Every built HTML entry in `src/`, sorted for a stable failure message. */
  function htmlEntries(): string[] {
    return readdirSync(join(ROOT, 'src'))
      .filter((f) => f.endsWith('.html'))
      .sort();
  }

  /** The script each entry loads, resolved out of its `<script type="module" src>`. */
  function entryScript(html: string): string {
    const m = /<script[^>]*\bsrc="\/([^"]+)"/.exec(html);
    if (!m?.[1]) throw new Error(`no module script found in ${html}`);
    return m[1];
  }

  it('there are exactly two entries, and both are the ones Rust points at', () => {
    // `popover.rs` loads `WebviewUrl::App("popover.html")`. If this list drifts from that,
    // the surface gets a 404 into a blank rect that still covers the popover's area.
    expect(htmlEntries()).toEqual(['index.html', 'popover.html']);
    const rust = readFileSync(join(ROOT, 'src-tauri', 'src', 'popover.rs'), 'utf8');
    expect(rust).toContain('WebviewUrl::App("popover.html".into())');
  });

  it('every entry imports the one index.css', () => {
    const offenders: string[] = [];
    for (const html of htmlEntries()) {
      const script = entryScript(readFileSync(join(ROOT, 'src', html), 'utf8'));
      const src = readFileSync(join(ROOT, 'src', script), 'utf8');
      // Comments can mention the import; the guard is on a real import statement.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (!/import\s+['"]\.\/index\.css['"]/.test(code)) {
        offenders.push(`${html} -> ${script}`);
      }
    }
    expect(
      offenders,
      `these entries do not import src/index.css: ${offenders.join(', ')}. Two roots with ` +
        `separate stylesheets drift on theming — the popover surface would render in the ` +
        `wrong theme with no test failing.`,
    ).toEqual([]);
  });

  it('the surface is hidden from assistive tech, and the chrome keeps the real list', () => {
    // `aria-activedescendant` cannot cross a document boundary, so the address input must keep
    // pointing at a listbox in ITS OWN document — which is why the chrome still renders the
    // dropdown (hidden with `opacity: 0`, which leaves it in the accessibility tree) while the
    // visible copy lives here. That contract only holds while the surface is `aria-hidden`;
    // without it a screen reader sees the SAME list twice and announces every suggestion
    // twice, and `aria-activedescendant` on the input points at a row that is not the row
    // being read out.
    const html = readFileSync(join(ROOT, 'src', 'popover.html'), 'utf8');
    expect(html, 'popover.html must mark its mount point aria-hidden').toMatch(
      /id="root"[^>]*aria-hidden="true"/,
    );

    // …and the chrome's copy must stay in the accessibility tree, which rules out the two
    // properties that would remove it. `visibility: hidden` and `display: none` both do; the
    // rule the chrome uses is `opacity`.
    const css = readFileSync(join(ROOT, 'src', 'index.css'), 'utf8');
    // The rule is a GROUPED selector (four popovers share one body), so match that form.
    const rule = css.match(/\.address-bar__omnibox-source,[^}]*?\{([^}]*)\}/);
    expect(rule, 'the hidden-copy rule must exist').not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body, 'the chrome copy must stay measurable, so not display:none').not.toMatch(
      /display\s*:\s*none/,
    );
    expect(
      body,
      'the chrome copy must stay in the a11y tree, so not visibility:hidden',
    ).not.toMatch(/visibility\s*:\s*hidden/);
    expect(body, 'the chrome copy must be made invisible in the first place').toMatch(
      /opacity\s*:\s*0/,
    );
    expect(body, 'and it must never eat a click meant for the surface').toMatch(
      /pointer-events\s*:\s*none/,
    );

    // The rule is DESKTOP-ONLY, and that is the whole subtlety: the Android shell has no
    // surface, so its native content view is lowered with `view.setChromeOverlay` and the
    // chrome's own copy is the visible popover. Applying the rule there deletes the omnibox
    // dropdown AND all three dialogs on Android — invisible to every desktop test, and
    // invisible to the AppImage this repo builds.
    const mobile = css.match(/\.aegis-mobile \.address-bar__omnibox-source,[^}]*?\{([^}]*)\}/);
    expect(
      mobile,
      'the mobile override must exist, or the omnibox dropdown is invisible on Android',
    ).not.toBeNull();
    expect(mobile?.[1] ?? '').toMatch(/opacity\s*:\s*1/);
    expect(mobile?.[1] ?? '').toMatch(/pointer-events\s*:\s*auto/);
    // …and the override must cover all FOUR popovers, not just the omnibox. A grouped
    // selector is easy to extend on the desktop side and forget on the mobile side, and the
    // failure is an invisible popover on a platform with no automated gate at all.
    for (const sel of ['.site-identity', '.adblock-shield__popover', '.zoom-indicator__popover']) {
      expect(
        mobile?.[0] ?? '',
        `the mobile override must include ${sel}, or that popover is invisible on Android`,
      ).toContain(sel);
    }
  });

  it('every class a surface panel puts on its ROOT has a surface-scoped override', () => {
    // ★ THE PIN FOR THE WORST DEFECT IN THIS FEATURE, found by review rather than by a test.
    //
    // The panels under `src/popover/` reuse the chrome's class names so the appearance has one
    // source of truth. That reuse leaked the chrome's own rules into the surface document: the
    // hidden-copy rule made every panel `opacity: 0; pointer-events: none`, and the chrome's
    // `position: absolute; top: calc(100% + Npx)` resolved against chrome wrappers that do not
    // exist there, so the panel painted BELOW the surface webview's own bottom edge. Result on a
    // real desktop build: a correctly-sized opaque rectangle over the page and nothing in it.
    //
    // Nothing caught it. jsdom has no layout. The sibling pin checks the SELECTOR LIST, not
    // computed style. And the AppImage gate measures a Rust-side rect and fires a JS `.click()`
    // — neither can observe `opacity`, `pointer-events`, or where the box actually painted. So
    // the guard has to be structural, which is what this is.
    //
    // The panel→class pairs are ASSERTED, not derived by parsing TSX: the class is what both
    // documents key their styling on, and a wrong entry here would silently exempt a panel.
    const css = readFileSync(join(ROOT, 'src', 'index.css'), 'utf8');
    // The omnibox's root is `OmniboxDropdown`'s, which `OmniboxPanel` renders as a child
    // rather than emitting itself — so the file that owns the class is the shared component.
    const PANEL_ROOTS: Array<[string, string]> = [
      ['../components/OmniboxDropdown.tsx', 'omnibox'],
      ['SitePanel.tsx', 'site-identity'],
      ['ShieldPanel.tsx', 'adblock-shield__popover'],
      ['ZoomPanel.tsx', 'zoom-indicator__popover'],
    ];
    for (const [file, cls] of PANEL_ROOTS) {
      const src = readFileSync(join(ROOT, 'src', 'popover', file), 'utf8');
      // `className` and the class on the SAME line: three panels write `className="site-identity"`
      // and the shared dropdown writes `className={className ? \`omnibox ${className}\` : ...}`,
      // so a bare class-name search would pass on a mention in a comment.
      expect(src, `${file} must give its root the .${cls} class it shares with the chrome`).toMatch(
        new RegExp(`className[^\\n]*${cls}`),
      );
      // Grouped selectors mean the override may carry several classes; match the whole block.
      const override = css.match(new RegExp(`\\.aegis-surface[^{}]*\\.${cls}[^{}]*\\{([^}]*)\\}`));
      expect(override, `index.css must override .${cls} for the surface document`).not.toBeNull();
      const body = override?.[1] ?? '';
      // Must UNDO the chrome rules, not merely restate opacity.
      expect(body, `.${cls} must be opaque on the surface`).toMatch(/opacity\s*:\s*1/);
      expect(body, `.${cls} must take clicks on the surface`).toMatch(/pointer-events\s*:\s*auto/);
      expect(
        body,
        `.${cls} must not stay absolutely positioned (its chrome anchor is absent)`,
      ).toMatch(/position\s*:\s*(static|relative)/);
      expect(body, `.${cls} must not keep the chrome's top/left offsets`).toMatch(/top\s*:\s*auto/);
    }
  });

  it('the hidden-copy rule covers exactly the popovers that render on the surface', () => {
    // Two lists that must be the same set, stated as literals rather than derived from each
    // other, because deriving one from the other is what lets a drift in.
    const css = readFileSync(join(ROOT, 'src', 'index.css'), 'utf8');
    const rule = css.match(/\.address-bar__omnibox-source,[^}]*?\{([^}]*)\}/);
    expect(rule, 'the grouped hidden-copy rule must exist').not.toBeNull();
    const selectors = (rule?.[0] ?? '').slice(0, (rule?.[0] ?? '').indexOf('{'));
    const named = selectors
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    expect(named).toEqual([
      '.adblock-shield__popover',
      '.address-bar__omnibox-source',
      '.site-identity',
      '.zoom-indicator__popover',
    ]);

    // …and the components that must be feeding the surface at all. Derived from the code, so a
    // fifth popover cannot join the surface without this test noticing that the rule is
    // missing it.
    const onSurface = desktopComponentFiles()
      .filter((f) => readFileSync(join(COMPONENTS, f), 'utf8').includes('usePopoverSurface'))
      .sort();
    // ASCII order: 'Adb' before 'Add'.
    expect(onSurface).toEqual(['AdblockShield.tsx', 'AddressBar.tsx', 'ZoomIndicator.tsx']);
  });

  it('no stylesheet other than index.css exists to be imported instead', () => {
    // Without this, the assertion above could be satisfied by a copy named index.css in a
    // subdirectory, and the two roots would still be separate files.
    const css = readdirSync(join(ROOT, 'src'))
      .filter((f) => f.endsWith('.css'))
      .sort();
    expect(css).toEqual(['index.css']);
  });
});

// A deployment contract, in a renderer test file, because the failure it prevents is
// invisible to every other gate. The sync server's published port binds to a Tailscale
// address; when the host does not have that address yet, Docker's endpoint setup fails
// BEFORE the container process starts, so `restart: unless-stopped` has nothing to
// restart and the server stays down until a human intervenes. Measured on the deploy
// host: down for 23 hours after a reboot, with `docker ps` reporting `healthy`.
//
// Two halves, and BOTH are needed. The unit stops the outage recurring; the healthcheck
// is what stops it being INVISIBLE, because the old probe ran against loopback inside
// the container and passed on a container that nothing outside could reach.
//
// MUTATION RECIPES (each must go red, and only the relevant one):
//   1. drop `--force-recreate` from the unit's ExecStart -> the 'recreates' test
//      (a plain `up -d` only STARTS the stale networkless container back up).
//   2. revert the healthcheck to a bare `/healthz` probe -> the 'healthcheck' test.
describe('the sync server must start unattended, and must be able to report that it did not', () => {
  const SYNC = join(ROOT, 'sync-server');
  const compose = readFileSync(join(SYNC, 'docker-compose.yml'), 'utf8');
  const unit = readFileSync(join(SYNC, 'systemd', 'aegis-sync-server.service'), 'utf8');
  const wait = readFileSync(join(SYNC, 'systemd', 'wait-for-bind-address.sh'), 'utf8');

  /** Index of a real DIRECTIVE line, anchored at line start. */
  const at = (text: string, re: RegExp): number => {
    const m = re.exec(text);
    if (!m) throw new Error(`no line matching ${re} — is the directive gone or unanchored?`);
    return m.index;
  };

  it('the boot unit waits for the bind address and then recreates the container', () => {
    // The wait must come BEFORE the `up`, or the bind is attempted before the address
    // exists — which is the outage.
    //
    // These are matched as ANCHORED DIRECTIVES, not as bare substrings. The unit's
    // comment block names both `wait-for-bind-address` and `docker compose up` in prose
    // (explaining the failure they prevent), so a plain `indexOf('docker compose up')`
    // finds the COMMENT and orders the comparison backwards. A text pin must key on the
    // directive it means; that trap is what this first version of the test fell into.
    const waitAt = at(unit, /^ExecStartPre=.*wait-for-bind-address\.sh$/m);
    const upAt = at(unit, /^ExecStart=docker compose up -d --force-recreate$/m);
    expect(waitAt).toBeLessThan(upAt);

    // `--force-recreate` is load-bearing, not hygiene: a container left behind by the
    // failed restore keeps its stale networkless endpoint, and a plain `up -d` starts
    // that same container again rather than re-running endpoint setup. MEASURED.
    expect(unit).toContain('docker compose up -d --force-recreate');
  });

  it('the unit orders after docker AND declares the mount it runs from', () => {
    // `After=docker.service network-online.target` — the directive carries more than the
    // one unit name, so anchor the NAME with a word boundary rather than to end-of-line.
    expect(unit).toMatch(/^After=.*\bdocker\.service\b.*$/m);
    // And it must be a real dependency, not just a comment: `Requires=` means the unit
    // fails loudly if docker is absent instead of racing it.
    expect(unit).toMatch(/^Requires=docker\.service$/m);
    // `RequiresMountsFor` is a [Unit] directive. In [Service] systemd IGNORES it
    // silently (verified: systemd-analyze warns "Unknown key ... ignoring"), which
    // would leave the unit racing the mount as quietly as it raced the tailnet.
    // Section boundaries are likewise matched as ANCHORED HEADERS for the same reason
    // as above — `[Service]` appears in the comment block too.
    const serviceAt = at(unit, /^\[Service\]$/m);
    expect(unit.slice(0, serviceAt)).toMatch(/^RequiresMountsFor=@SYNC_SERVER_DIR@$/m);
    expect(unit.slice(serviceAt)).not.toMatch(/^RequiresMountsFor=/m);
  });

  it('the unit verifies reachability itself, because its "active" is a latch', () => {
    // MEASURED false green: with `RemainAfterExit=yes`, the unit latches
    // `active (exited)` and a later `systemctl start` is a NO-OP — it returned 0 and
    // logged nothing while the container was down and unreachable. So `is-active`
    // cannot mean "the server is up", and the unit must not leave that as the only
    // signal. An `ExecStartPost` that curls the PUBLISHED port makes the unit fail
    // loudly instead, which is the difference between "claims to have started" and
    // "did start".
    expect(unit).toMatch(/^ExecStartPost=/m);
    // It has to probe the PUBLISHED address, which is the address compose binds and
    // the one clients connect to, and never a hardcoded loopback: a loopback probe is
    // green for a container with no network at all.
    expect(unit).toMatch(/^ExecStartPost=.*\$\$\{AEGIS_SYNC_BIND:-127\.0\.0\.1\}\/8787/m);
    // `bash` /dev/tcp, not wget or curl: `rpm -q wget` reports "not installed" on the
    // host this was written on (busybox supplies it), so a wget probe would make the
    // unit fail on any host without busybox — a failure that looks like the outage.
    expect(unit).toMatch(/^ExecStartPost=\/bin\/bash /m);
    expect(unit).toMatch(/^ExecStartPost=.*\/dev\/tcp\//m);
    expect(unit).not.toMatch(/^ExecStartPost=.*\bwget\b/m);
  });

  it('the healthcheck can tell "serving" from "isolated"', () => {
    // A loopback-only probe passes on a container with no network at all, because a
    // failed endpoint leaves `lo` and nothing else. The `scope global` clause is what
    // excludes `lo` (it is `scope host`), and the discriminator is `grep -q .` finding a
    // line — `ip` itself exits 0 either way, so an exit-status check would be vacuous.
    expect(compose).toMatch(/ip -o -4 addr show scope global \| grep -q \./);
    expect(compose).toContain('/healthz');
  });

  it('the wait reads the same variable compose interpolates, and fails LOUDLY', () => {
    // Two independent readers of one setting is two things that can drift; the shared
    // variable name plus a matching default is what keeps them in agreement.
    expect(compose).toContain('${AEGIS_SYNC_BIND:-127.0.0.1}');
    expect(wait).toContain('AEGIS_SYNC_BIND:-127.0.0.1');
    // A silent success here IS the bug: the caller would proceed to `docker compose up`,
    // the bind would fail, and the unit would claim to have started.
    expect(wait).toMatch(/exit 1/);
    // Always-satisfiable binds must not add startup latency to the safe default.
    expect(wait).toMatch(/127\.\*.*exit 0/s);
  });

  it('anti-vacuity: the scan found the real files, not empty ones', () => {
    expect(compose.length).toBeGreaterThan(0);
    expect(unit).toContain('[Unit]');
    expect(wait).toContain('has_addr');
  });
});
