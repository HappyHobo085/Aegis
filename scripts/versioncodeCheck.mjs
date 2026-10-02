// Pure logic for the Android versionCode monotonicity gate. No I/O, no process.exit —
// see `check-android-versioncode.mjs` for the CLI wrapper. Same split as
// `auditCheck.mjs` / `check-npm-audit.mjs`, and the same reason it matters twice over:
// v8 instruments only the test worker's own runtime, so a spawned subprocess earns zero
// coverage credit, and logic written in the wrapper is both unmeasured and untestable.

/**
 * Read `version` out of tauri.conf.json with a real parse.
 *
 * This used to be `/"version"\s*:\s*"([^"]+)"/`, which matches the FIRST `"version"` key
 * anywhere in the file at ANY nesting depth — so a nested object preceding the top-level
 * key would silently supply the app version, and the gate would compare the wrong string
 * without saying so. A version check is exactly the kind of gate that must not fail in the
 * "looks fine" direction. The stated reason for the regex ("without pulling in a JSONC
 * parser") never applied: `tauri.conf.json` is machine-generated config that Tauri itself
 * reads, not JSONC.
 *
 * The reason codes are MACHINE-readable and the prose lives in the CLI wrapper, because
 * the operator-facing wording is part of this gate's contract: `cliGates.test.mjs` pins both
 * messages the gate has always printed, so a refactor that moves this logic must not quietly
 * reword what an operator reads. Codes, not prose, keep that promise cheap to keep.
 *
 * @param {string} jsonText the file's contents
 * @returns {{version?: string, problem?: string, detail?: string}}
 *   `problem` is one of `'not-json'`, `'not-an-object'`, `'no-version'`.
 */
export function versionOf(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { problem: 'not-json', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { problem: 'not-an-object' };
  }
  const version = parsed.version;
  if (typeof version !== 'string') {
    return { problem: 'no-version' };
  }
  return { version };
}

/**
 * Tauri/android versionCode = major * 1_000_000 + minor * 1_000 + patch.
 * @param {string} version a MAJOR.MINOR.PATCH string
 * @returns {number|null} null when it is not that shape
 */
export function versionCodeOf(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return null;
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]);
}

/**
 * Semver-ish ordering, or `null` when either side is not comparable.
 * @param {string} a
 * @param {string} b
 * @returns {number|null} negative / zero / positive
 */
export function compareVersions(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(b);
  if (!pa || !pb) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
