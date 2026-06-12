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
