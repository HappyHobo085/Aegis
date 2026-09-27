import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

// WHY SUBPROCESSES. All three gates under test are top-level CLIs: they read
// their inputs at module load and call `process.exit()`. Importing one would run
// it and kill the test worker, so there is no in-process seam to assert against.
// `auditCheck.mjs` is the exception the repo already made — it holds the pure
// logic, `check-npm-audit.mjs` the I/O — and `auditCheck.test.mjs` covers that
// side. What is untested is the decision each CLI makes from a real audit report
// / a real dist/ / a real git ref, which is exactly the part that once failed
// OPEN. So: spawn, assert the exit code AND the operator-facing message.
//
// WHY SANDBOXES. Each gate resolves its repo root from its OWN location
// (`join(dirname(fileURLToPath(import.meta.url)), '..')`). Copying the script into
// a temp dir therefore re-roots it there, and the fixture `dist/`, `.git` and
// `.audit-allowlist.json` become ordinary files in that sandbox. Nothing in the
// real working tree is read or written — which matters: there is a REAL `dist/`
// in this repo, and the gate must be exercised against a synthetic one, not the
// live build output.
const sandboxes = [];

/** Copy `files` (basenames of real files in scripts/) into a fresh sandbox repo. */
function sandbox(...files) {
  const root = mkdtempSync(join(tmpdir(), 'aegis-gate-'));
  sandboxes.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const f of files) cpSync(join(SCRIPTS_DIR, f), join(root, 'scripts', f));
  return root;
}

const write = (path, contents) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
};

/** Spawn a sandboxed gate. Returns `{ status, out }` with stderr folded in. */
function run(root, script, { env = {}, args = [] } = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (r.error) throw r.error;
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

afterAll(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true });
});

/** A `git init`-ed sandbox whose `main` holds a committed tauri.conf.json. */
function gitSandbox(version) {
  const root = sandbox('check-android-versioncode.mjs');
  const conf = join(root, 'src-tauri', 'tauri.conf.json');
  const setVersion = (v) => write(conf, `{\n  "productName": "Aegis",\n  "version": "${v}"\n}\n`);
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout;
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'user.name', 'Gate Test');
  git('config', 'commit.gpgsign', 'false');
  setVersion(version);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, setVersion, git };
}

// ---------------------------------------------------------------- bundle size

describe('check-bundle-size.mjs (the size gate)', () => {
  /** A dist/assets fixture: `files` maps asset name to its raw contents. */
  const withDist = (files) => {
    const root = sandbox('check-bundle-size.mjs');
    for (const [name, body] of Object.entries(files)) {
      write(join(root, 'dist', 'assets', name), body);
    }
    return root;
  };

  it('passes a realistic build under both budgets', () => {
    const root = withDist({
      'index-a1b2.js': 'a'.repeat(200_000),
      'chunk-c3d4.js': 'b'.repeat(40_000),
      'index-a1b2.css': 'c'.repeat(8_000),
    });
    const { status, out } = run(root, 'check-bundle-size.mjs');
    expect(out).toContain('JS');
    expect(out).toContain('CSS');
    expect(out).not.toContain('::error::');
    expect(status).toBe(0);
  });

  it('FAILS when dist/assets is absent, naming the fix', () => {
    // The gate measures dist/; it does not build it. A missing dist must not read
    // as "0 bytes, well under budget".
    const root = sandbox('check-bundle-size.mjs');
    const { status, out } = run(root, 'check-bundle-size.mjs');
    expect(out).toContain('::error::No build output');
    expect(out).toContain('npm run build:renderer');
    expect(status).toBe(1);
  });

  it('SKIPS a kind with no assets instead of inventing a failure', () => {
    // Vite emits no stylesheet until one is imported, so an empty CSS glob is
    // normal and must not fail the build.
    const root = withDist({ 'index-a1b2.js': 'a'.repeat(2000) });
    const { status, out } = run(root, 'check-bundle-size.mjs');
    expect(out).toContain('no assets emitted — skipped');
    expect(status).toBe(0);
  });

  it('FAILS on a gzipped JS bundle over the 512 KB budget, with the percentage', () => {
    // Random bytes do not compress, so this crosses the budget for real rather
    // than by inflating the fixture until the number looks big.
    const root = withDist({ 'index-a1b2.js': randomBytes(600_000) });
    const { status, out } = run(root, 'check-bundle-size.mjs');
    expect(out).toContain('::error::gzipped JS  is 586 KB, 17% over the 500 KB budget');
    expect(out).toContain('BUDGETS.js');
    expect(status).toBe(1);
  });

  it('FAILS when the largest asset is suspiciously small (stale or truncated dist)', () => {
    // The trap this guards: a 40-byte "bundle" is far under budget, so without the
    // floor the gate would report a clean run on a build that never happened.
    //
    // The double space in "Largest JS  asset" is real, not a typo here: the script
    // builds `label` as `kind.toUpperCase().padEnd(3)` for its aligned table and
    // interpolates the same padded string into this prose message. Asserted
    // verbatim so a future refactor of the message is a visible, intentional diff.
    const root = withDist({ 'index-a1b2.js': 'x'.repeat(40) });
    const { status, out } = run(root, 'check-bundle-size.mjs');
    expect(out).toContain('::error::Largest JS  asset is only 40 bytes');
    expect(out).toContain('npm run build:renderer');
    expect(status).toBe(1);
  });

  it('FAILS on both conditions at once when a tiny bundle is also under budget', () => {
    // The two conditions live in one loop body: `r.over` and `r.biggest < 1024`.
    // A 40-byte asset is under budget, so this pins that the size line is still
    // printed (the run reports, it does not bail) and that the exit is non-zero.
    const root = withDist({ 'tiny.js': 'x'.repeat(40) });
    const { status, out } = run(root, 'check-bundle-size.mjs');
    expect(out).toContain('1 file'); // the size table still rendered
    expect(out).toContain('Largest JS  asset is only 40 bytes');
    expect(status).toBe(1);
  });
});

// ----------------------------------------------------------------- npm audit

describe('check-npm-audit.mjs (the advisory gate)', () => {
  // A stand-in `npm` that prints a fixture report and exits with a chosen code.
  // The gate recovers its stdout from execFileSync's throw, so the exit code of
  // the shim is itself a variable under test.
  const withNpm = (json, { exit = 0, allowlist } = {}) => {
    const root = sandbox('check-npm-audit.mjs', 'auditCheck.mjs');
    const fixture = join(root, 'audit.json');
    write(fixture, json);
    write(join(root, 'bin', 'npm'), `#!/bin/sh\ncat "$AEGIS_AUDIT_FIXTURE"\nexit ${exit}\n`);
    chmodSync(join(root, 'bin', 'npm'), 0o755);
    if (allowlist !== undefined) write(join(root, '.audit-allowlist.json'), allowlist);
    return {
      root,
      env: { PATH: `${join(root, 'bin')}:${process.env.PATH}`, AEGIS_AUDIT_FIXTURE: fixture },
    };
  };

  const CLEAN = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: {} },
  });
  const HIGH = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      lodash: {
        name: 'lodash',
        severity: 'high',
        via: [
          {
            source: 1065,
            name: 'lodash',
            title: 'Prototype Pollution in lodash',
            url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695',
            severity: 'high',
          },
        ],
      },
    },
    metadata: { vulnerabilities: { high: 1, total: 1 } },
  });

  it('passes a clean report', () => {
    const { root, env } = withNpm(CLEAN, { allowlist: '{"allow":[]}' });
    const { status, out } = run(root, 'check-npm-audit.mjs', { env });
    expect(out).toContain('OK — no blocking high/critical advisories');
    expect(status).toBe(0);
  });

  it('recovers the report when `npm audit` exits non-zero (vulnerabilities found)', () => {
    // npm exits 1 whenever it finds anything, so this is the NORMAL path for a
    // report with findings. If the throw were not caught-and-recovered, the gate
    // would report "could not run" rather than the advisory it just found.
    const { root, env } = withNpm(CLEAN, { exit: 1, allowlist: '{"allow":[]}' });
    const { status, out } = run(root, 'check-npm-audit.mjs', { env });
    expect(out).toContain('OK — no blocking high/critical advisories');
    expect(out).not.toContain('could not run/parse');
    expect(status).toBe(0);
  });

  it('FAILS on a blocking high advisory and names it', () => {
    const { root, env } = withNpm(HIGH, { allowlist: '{"allow":[]}' });
    const { status, out } = run(root, 'check-npm-audit.mjs', { env });
    expect(out).toContain('1 blocking high/critical advisory(ies)');
    expect(out).toContain('HIGH lodash');
    expect(out).toContain('GHSA-jf85-cpcp-j695');
    expect(out).toContain('.audit-allowlist.json');
    expect(status).toBe(1);
  });

  it('passes an allowlisted advisory and says it ignored it', () => {
    const { root, env } = withNpm(HIGH, { allowlist: '{"allow":[1065]}' });
    const { status, out } = run(root, 'check-npm-audit.mjs', { env });
    expect(out).toContain('1 allowlisted advisory(ies) ignored');
    expect(out).toContain('ALLOWED high lodash');
    expect(status).toBe(0);
  });

  it('FAILS CLOSED on the `{"error":…}` object npm emits when the audit itself dies', () => {
    // Valid JSON, but not an audit report. Reporting "OK" here is how the gate
    // passed while being unable to see anything at all.
    const { root, env } = withNpm(
      JSON.stringify({ error: { code: 'EINVALIDOVERRIDE', summary: 'Override without name: //' } }),
      { allowlist: '{"allow":[]}' },
    );
    const { status, out } = run(root, 'check-npm-audit.mjs', { env });
    expect(out).toContain('did not produce an audit report');
    expect(out).toContain('EINVALIDOVERRIDE');
    expect(out).not.toContain('OK — no blocking');
    expect(status).toBe(1);
  });

  it('FAILS when the report is not parseable JSON', () => {
    const { root, env } = withNpm('not json at all', { allowlist: '{"allow":[]}' });
    const { status, out } = run(root, 'check-npm-audit.mjs', { env });
    expect(out).toContain('could not run/parse `npm audit --json`');
    expect(status).toBe(1);
  });

  it('FAILS when npm cannot be run at all', () => {
    const { root, env } = withNpm(CLEAN, { allowlist: '{"allow":[]}' });
    // An empty PATH: process.execPath is absolute, so the gate still starts and
    // then fails at execFileSync('npm') with no stdout to recover.
    const { status, out } = run(root, 'check-npm-audit.mjs', { env: { ...env, PATH: root } });
    expect(out).toContain('could not run/parse `npm audit --json`');
    expect(status).toBe(1);
  });

  it('treats a missing allowlist as empty, so advisories still block', () => {
    const { root, env } = withNpm(HIGH);
    const { status, out } = run(root, 'check-npm-audit.mjs', { env });
    expect(out).toContain('1 blocking high/critical advisory(ies)');
    expect(status).toBe(1);
  });

  it('treats an unparseable allowlist as empty, so advisories still block', () => {
    const { root, env } = withNpm(HIGH, { allowlist: '{ this is not json' });
    const { status, out } = run(root, 'check-npm-audit.mjs', { env });
    expect(out).toContain('1 blocking high/critical advisory(ies)');
    expect(status).toBe(1);
  });
});

// ------------------------------------------------------- android versionCode

describe('check-android-versioncode.mjs (the Android bump gate)', () => {
  // This is the gate that prevents a silent "the update didn't land": a
  // duplicate or lowered versionCode is accepted by Play/adb and simply refuses
  // to replace the installed app, so nobody finds out until users complain.
  let box;
  beforeAll(() => {
    box = gitSandbox('1.2.3');
  });
  afterAll(() => box.setVersion('1.2.3'));

  const RUN = (extra = {}) =>
    run(box.root, 'check-android-versioncode.mjs', {
      env: { AEGIS_BASE_REF: 'main', ...extra },
    });

  it('passes an unchanged version (most PRs are not releases)', () => {
    box.setVersion('1.2.3');
    const { status, out } = RUN();
    expect(out).toContain('version 1.2.3 unchanged from main (versionCode 1002003)');
    expect(status).toBe(0);
  });

  it('passes an increased version and reports the derived versionCode pair', () => {
    box.setVersion('1.3.0');
    const { status, out } = RUN();
    // Tauri derives versionCode = major*1e6 + minor*1e3 + patch.
    expect(out).toContain('version 1.2.3 -> 1.3.0 (versionCode 1002003 -> 1003000)');
    expect(status).toBe(0);
  });

  it('passes a patch bump, which is the same derivation at another magnitude', () => {
    box.setVersion('1.2.10');
    const { status, out } = RUN();
    expect(out).toContain('1002003 -> 1002010');
    expect(status).toBe(0);
  });

  it('FAILS on a DECREASED version, naming the downgrade', () => {
    box.setVersion('1.1.9');
    const { status, out } = RUN();
    expect(out).toContain('::error::version was DECREASED: 1.2.3 (main) -> 1.1.9');
    expect(out).toContain('refuse the install as a downgrade');
    expect(status).toBe(1);
  });

  it('FAILS on a decreased MINOR even when the patch is much higher', () => {
    // 1.1.999 > 1.1.9 in a naive string/number comparison but is a downgrade by
    // the encoding Android actually uses.
    box.setVersion('1.1.999');
    const { status, out } = RUN();
    expect(out).toContain('version was DECREASED');
    expect(status).toBe(1);
  });

  it('FAILS on a non-semver version, since the derived code is not an integer', () => {
    box.setVersion('1.2');
    const { status, out } = RUN();
    expect(out).toContain('is not MAJOR.MINOR.PATCH');
    expect(out).toContain('Use semver');
    expect(status).toBe(1);
  });

  it('FAILS when the base ref cannot be read, naming the shallow-clone cause', () => {
    box.setVersion('1.3.0');
    const { status, out } = RUN({ AEGIS_BASE_REF: 'no-such-ref' });
    expect(out).toContain('::error::Cannot read src-tauri/tauri.conf.json at no-such-ref');
    expect(out).toContain('fetch-depth: 0');
    expect(status).toBe(1);
  });

  it('FAILS when the base version is not comparable as semver', () => {
    // Order matters: commit the non-semver BASE on a side branch first, then
    // restore a semver working tree. Writing 1.2.3-beta into the working tree
    // and committing it (the obvious way round) makes the HEAD check fire first
    // and this branch never runs.
    box.git('checkout', '-q', '-b', 'prerelease');
    write(
      join(box.root, 'src-tauri', 'tauri.conf.json'),
      '{"productName":"Aegis","version":"1.2.3-beta"}\n',
    );
    box.git('add', '-A');
    box.git('commit', '-q', '-m', 'prerelease base');
    box.git('checkout', '-q', 'main'); // working tree back to 1.2.3
    box.setVersion('1.2.4');
    const { status, out } = RUN({ AEGIS_BASE_REF: 'prerelease' });
    expect(out).toContain('Cannot compare version "1.2.4" against "1.2.3-beta"');
    expect(out).toContain('on prerelease as semver');
    expect(status).toBe(1);
  });

  it('FAILS when tauri.conf.json has no version field at all', () => {
    write(join(box.root, 'src-tauri', 'tauri.conf.json'), '{"productName":"Aegis"}\n');
    const { status, out } = RUN();
    expect(out).toContain('no "version" field found in src-tauri/tauri.conf.json');
    expect(status).toBe(1);
  });

  it('FAILS when tauri.conf.json is unreadable in the working tree', () => {
    const gone = gitSandbox('1.2.3');
    rmSync(join(gone.root, 'src-tauri', 'tauri.conf.json'));
    const { status, out } = run(gone.root, 'check-android-versioncode.mjs', {
      env: { AEGIS_BASE_REF: 'main' },
    });
    expect(out).toContain('::error::Cannot read src-tauri/tauri.conf.json');
    expect(status).toBe(1);
  });

  describe('the generated tauri.properties cross-check', () => {
    const PROPS_REL = join('src-tauri', 'gen', 'android', 'app', 'tauri.properties');
    const withProps = (contents, version = '1.3.0') => {
      box.setVersion(version);
      if (contents !== null) write(join(box.root, PROPS_REL), contents);
      return RUN();
    };
    afterEach(() => rmSync(join(box.root, PROPS_REL), { force: true }));

    it('SKIPS the cross-check when the file has not been generated', () => {
      const { status, out } = withProps(null);
      expect(out).toContain('tauri.properties not generated yet — skipped');
      expect(status).toBe(0);
    });

    it('passes when the generated versionCode agrees', () => {
      const { status, out } = withProps('tauri.android.versionCode=1003000\n');
      expect(out).toContain('tauri.properties agrees (versionCode=1003000)');
      expect(status).toBe(0);
    });

    it('FAILS when the generated file is stale, naming both numbers', () => {
      const { status, out } = withProps('tauri.android.versionCode=1002003\n');
      expect(out).toContain('says versionCode=1002003 but');
      expect(out).toContain('derives 1003000');
      expect(out).toContain('re-run the Android build');
      expect(status).toBe(1);
    });

    it('FAILS when the generated file has no parseable versionCode', () => {
      const { status, out } = withProps('# autogenerated, do not edit\n');
      expect(out).toContain('no parseable tauri.android.versionCode');
      expect(status).toBe(1);
    });

    it('never reaches the cross-check once the version itself has already failed', () => {
      // `fail()` exits, so the cross-check is unreachable after a version
      // failure. A properties file that WOULD have agreed with 1.1.0 must not
      // produce an "agrees" line, let alone rescue the run.
      const { status, out } = withProps('tauri.android.versionCode=1001000\n', '1.1.0');
      expect(out).toContain('version was DECREASED');
      expect(out).not.toContain('agrees');
      expect(status).toBe(1);
    });
  });

  // Uncovered by construction, stated rather than faked: the
  // `headCode <= baseCode` branch inside the increase arm is unreachable, because
  // `compare()` orders MAJOR, then MINOR, then PATCH — the same order the
  // `major*1e6 + minor*1e3 + patch` encoding uses, and the low field's range
  // (±999) is narrower than the next-high field's weight (1000). So "cmp > 0"
  // and "headCode <= baseCode" cannot both hold. It is a defensive re-check
  // against a future change to the derivation, not a live path.
});
