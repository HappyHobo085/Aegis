// electron/main/userAgent.ts
// Build a mainstream Chrome User-Agent for the content session so browsed pages
// see a common Chrome string (not "Electron/Aegis"), reducing UA fingerprintability
// and UA-sniffing breakage. DERIVED from the bundled Chromium version
// (process.versions.chrome) so it can never drift from the real engine — a version
// mismatch is itself a fingerprint tell. Modern Chrome reports a reduced UA
// (Chrome/<major>.0.0.0), which this mirrors.

/** Platform token used in the UA's parenthesized section. */
function platformToken(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    default:
      return 'X11; Linux x86_64';
  }
}

/**
 * @param platform e.g. process.platform
 * @param chromeVersion e.g. process.versions.chrome ("134.0.6998.88")
 */
export function chromeUserAgent(platform: NodeJS.Platform, chromeVersion: string): string {
  const major = chromeVersion.split('.')[0] || '0';
  const reduced = `${major}.0.0.0`;
  return `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reduced} Safari/537.36`;
}
