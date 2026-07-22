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
    return new URL(url).origin;
  } catch {
    return null;
  }
}
