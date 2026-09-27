/** Returns the hostname of `url`, or null when `url` has no parseable host. */
export function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

/** Returns the origin of `url`, or null when `url` has no parseable origin. */
export function originOf(url: string): string | null {
  try {
    // `URL.origin` is the literal STRING "null" for an opaque origin (about:, data:,
    // file:), not the null value. Returning that string would break the declared
    // `string | null` contract and make every `origin === null` guard in the app a
    // no-op for those URLs (e.g. the redirect re-assert in App.tsx). Normalise it.
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}
