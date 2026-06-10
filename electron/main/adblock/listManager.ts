// electron/main/adblock/listManager.ts

export interface FetchedSource {
  listId: string;
  url: string;
  ok: boolean;
  text: string;
  etag: string | null;
  hash: string;
  error?: string;
}

export interface FetchAllResult {
  sources: FetchedSource[];
  resources: string | null;
}

/**
 * Fetch a single list source with hardening:
 *  - per-request timeout via AbortController (caller-injectable clock through fetchImpl)
 *  - streaming size cap enforced as chunks arrive (throws before fully buffering)
 *  - non-2xx → throw
 * Returns the decoded UTF-8 text and the `etag` response header (or null).
 */
export async function fetchSource(
  url: string,
  opts: { timeoutMs: number; maxBytes: number; fetchImpl?: typeof fetch },
): Promise<{ text: string; etag: string | null }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
    }
    const etag = res.headers.get('etag');
    const body = res.body;
    if (body === null) {
      // No streamable body: fall back to text(), still cap-checked.
      const text = await res.text();
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > opts.maxBytes) {
        throw new Error(`fetch ${url} exceeded maxBytes (${bytes} > ${opts.maxBytes})`);
      }
      return { text, etag };
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel();
          throw new Error(`fetch ${url} exceeded maxBytes (${total} > ${opts.maxBytes})`);
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    const text = new TextDecoder('utf-8').decode(merged);
    return { text, etag };
  } finally {
    clearTimeout(timer);
  }
}
