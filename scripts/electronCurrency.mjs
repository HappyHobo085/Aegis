// scripts/electronCurrency.mjs
// Pure classifier for "how far is the installed Electron behind the latest
// stable?" — the automated form of engine-update-policy.md's manual "bump on
// each security release" step. No I/O; the CLI (check-electron-current.mjs)
// supplies the installed + latest version strings.
//
// Electron supports the LATEST THREE stable majors with security fixes
// (electronjs.org/docs/latest/tutorial/electron-timelines: "The latest three
// stable major versions are supported"; the third-latest gets security fixes
// only). Falling 3+ majors behind means the bundled Chromium no longer receives
// security backports -> hard fail.
export const SECURITY_SUPPORT_WINDOW_MAJORS = 3;

/** Parse a semver string ("42.4.0" -> {major:42,minor:4,patch:0}). */
export function parseSemver(version) {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  if (!m) throw new Error(`unparseable version: ${version}`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Compare two semver strings: -1 if a<b, 0 if equal, 1 if a>b (ignores prerelease). */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * Classify installed-vs-latest Electron currency.
 * @param {string} installed e.g. "42.4.0"
 * @param {string} latest    e.g. "42.4.0" (npm `latest` dist-tag = newest stable)
 * @returns {{status:'ok'|'warn'|'fail', installed:string, latest:string,
 *           installedMajor:number, latestMajor:number, behindMajors:number,
 *           reason:string}}
 */
export function classifyElectronCurrency(installed, latest) {
  const installedMajor = parseSemver(installed).major;
  const latestMajor = parseSemver(latest).major;
  const behindMajors = latestMajor - installedMajor;
  const cmp = compareSemver(installed, latest);

  let status;
  let reason;
  if (behindMajors >= SECURITY_SUPPORT_WINDOW_MAJORS) {
    status = 'fail';
    reason =
      `Electron ${installed} is ${behindMajors} majors behind ${latest} — outside the ` +
      `${SECURITY_SUPPORT_WINDOW_MAJORS}-major security-support window; the bundled Chromium ` +
      `no longer receives security backports. Bump Electron and re-run the dual-ABI gate.`;
  } else if (behindMajors > 0) {
    status = 'warn';
    reason =
      `Electron ${installed} is ${behindMajors} major(s) behind ${latest} (still within the ` +
      `${SECURITY_SUPPORT_WINDOW_MAJORS}-major support window). Plan an upgrade.`;
  } else if (cmp < 0) {
    status = 'warn';
    reason =
      `Electron ${installed} is on the latest major but behind the latest stable ${latest} — ` +
      `a patch (possibly a security fix) is available.`;
  } else {
    status = 'ok';
    reason = `Electron ${installed} is the latest stable (or newer).`;
  }

  return { status, installed, latest, installedMajor, latestMajor, behindMajors, reason };
}
