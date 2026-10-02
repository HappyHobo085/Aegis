// scripts/auditCheck.mjs
// Pure evaluation of `npm audit --json` (auditReportVersion 2) output against an
// allowlist of accepted advisories. No I/O — the CLI wrapper (check-npm-audit.mjs)
// spawns `npm audit` and reads the allowlist file, then calls evaluateAudit().
//
// npm audit v2 shape (verified against the npm shipped with Node 22):
//   { auditReportVersion: 2,
//     vulnerabilities: { <pkg>: { name, severity,
//        via: [ string | { source, url, severity, title, name } ] } },
//     metadata: { vulnerabilities: { info, low, moderate, high, critical, total } } }
// A `via` STRING is a transitive pointer to another package (no advisory of its
// own); the advisory OBJECT (numeric `source`) is what we gate on. Each distinct
// advisory is deduped by `source` (falling back to `url`).

/** Severities that block CI by default. */
export const BLOCKING_SEVERITIES = ['high', 'critical'];

/**
 * Why `auditJson` is NOT a usable audit report, or `null` if it is one.
 *
 * This exists because the gate used to fail OPEN. `npm audit --json` exits
 * non-zero both when it finds advisories (the report still goes to stdout) and when
 * it dies outright — e.g. a malformed `overrides` block, which makes npm emit a
 * *valid JSON* `{"error":{...}}` object on stdout. `JSON.parse` therefore succeeds,
 * `collectBlockingAdvisories` finds no `vulnerabilities` key, and the CLI reported
 * "OK — no blocking high/critical advisories" with exit 0. A supply-chain gate that
 * reports success because its own audit could not run is worse than no gate at all.
 *
 * A real audit report always carries a `vulnerabilities` OBJECT (possibly empty —
 * a clean tree legitimately reports `{}`) and a numeric `auditReportVersion`.
 * Anything else, or an `error` key, is a failed audit rather than a clean one.
 *
 * @param {unknown} auditJson parsed `npm audit --json` output
 * @returns {string|null} a human-readable reason, or null when the shape is valid
 */
export function auditReportProblem(auditJson) {
  if (!auditJson || typeof auditJson !== 'object' || Array.isArray(auditJson)) {
    return 'report is not a JSON object';
  }
  if (auditJson.error) {
    const code = auditJson.error.code ? ` (code ${auditJson.error.code})` : '';
    return `npm audit reported an error${code}: ${auditJson.error.summary || auditJson.error.detail || 'no detail'}`;
  }
  if (typeof auditJson.auditReportVersion !== 'number') {
    return 'report has no numeric `auditReportVersion`';
  }
  if (
    !auditJson.vulnerabilities ||
    typeof auditJson.vulnerabilities !== 'object' ||
    Array.isArray(auditJson.vulnerabilities)
  ) {
    return 'report has no `vulnerabilities` object';
  }
  return null;
}

/**
 * Collect distinct high/critical advisory objects from an npm-audit v2 report,
 * deduped by `source` (or `url` when source is absent).
 * @param {object} auditJson parsed `npm audit --json`
 * @returns {Array<{source:(number|undefined), url:(string|undefined), severity:string, title:(string|undefined), name:(string|undefined)}>}
 */
export function collectBlockingAdvisories(auditJson) {
  const out = new Map();
  const vulns = (auditJson && auditJson.vulnerabilities) || {};
  let unidentified = 0;
  for (const pkg of Object.values(vulns)) {
    const via = (pkg && pkg.via) || [];
    for (const entry of via) {
      if (!entry || typeof entry !== 'object') continue; // string => transitive pointer
      if (!BLOCKING_SEVERITIES.includes(entry.severity)) continue;
      // Identify by `source` (npm advisory id), then `url`; an advisory with
      // neither is unidentifiable (and un-allowlistable) -> give it a unique key
      // so two such advisories are never silently deduped into one.
      const key =
        entry.source != null
          ? `src:${entry.source}`
          : entry.url != null
            ? `url:${entry.url}`
            : `anon:${unidentified++}`;
      if (!out.has(key)) {
        out.set(key, {
          source: entry.source,
          url: entry.url,
          severity: entry.severity,
          title: entry.title,
          name: entry.name,
        });
      }
    }
  }
  return [...out.values()];
}

/**
 * True if `advisory` is covered by the allowlist (matched by numeric `source`
 * or by advisory `url`).
 * @param {{source?:number,url?:string}} advisory
 * @param {Array<number|string>} allow
 */
export function isAllowlisted(advisory, allow) {
  if (!Array.isArray(allow)) return false;
  return allow.some(
    (a) =>
      (advisory.source != null && a === advisory.source) ||
      (advisory.url != null && a === advisory.url),
  );
}

/**
 * Why reading the allowlist FAILED, or `null` when the failure is the one that means
 * "nothing is allowed".
 *
 * This is the decision that used to live inline in the CLI wrapper, where it was both
 * untestable and unmeasurable: `check-npm-audit.mjs` is a subprocess entry point, so v8
 * earns no coverage credit for it and a decision that can silently empty the allowlist had
 * no unit test at all. One unconditional `catch` made a missing file, a permissions error and
 * a one-character typo all read as `{ allow: [] }`.
 *
 * It failed CLOSED either way — a broken allowlist surfaced as "N new blocking advisories",
 * not as a pass — so this was never a silent-pass defect. The cost was diagnosability: the
 * report named the advisory and never the file that was actually broken.
 *
 * `ENOENT` is the ordinary "the operator has not allowlisted anything" case and is the ONLY
 * read failure allowed to mean an empty allowlist. Everything else is fatal, because a gate
 * that audits against an undeclared allowlist is auditing against nothing.
 *
 * @param {unknown} err the thrown value from `readFileSync`
 * @returns {string|null} a human-readable reason, or null when the allowlist is simply absent
 */
export function allowlistReadProblem(err) {
  if (err && err.code === 'ENOENT') return null;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The parsed allowlist, or the reason the text is not one.
 *
 * A malformed allowlist is NOT "no advisories are allowed". It used to be read as exactly
 * that, so a single stray comma turned a clean audit into a wall of unrelated red with nothing
 * naming the file at fault.
 *
 * @param {string} text the allowlist file's contents
 * @returns {{value?: object, problem?: string}}
 */
export function parseAllowlist(text) {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { problem: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Partition blocking advisories into { blocking, allowed } using the allowlist.
 * @param {object} auditJson parsed `npm audit --json`
 * @param {{allow?: Array<number|string>}} allowlist
 * @returns {{ blocking: Array<object>, allowed: Array<object> }}
 */
export function evaluateAudit(auditJson, allowlist) {
  const allow = (allowlist && allowlist.allow) || [];
  const blocking = [];
  const allowed = [];
  for (const adv of collectBlockingAdvisories(auditJson)) {
    if (isAllowlisted(adv, allow)) allowed.push(adv);
    else blocking.push(adv);
  }
  return { blocking, allowed };
}
