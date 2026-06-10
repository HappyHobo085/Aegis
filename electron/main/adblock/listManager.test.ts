// electron/main/adblock/listManager.test.ts
import { describe, it, expect } from 'vitest';
import { fetchSource } from './listManager';

/** Build a Response whose body streams `chunks` (Uint8Array) one at a time. */
function streamingResponse(
  chunks: Uint8Array[],
  init: { status?: number; etag?: string | null } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  const headers = new Headers();
  if (init.etag != null) headers.set('etag', init.etag);
  return new Response(stream, { status: init.status ?? 200, headers });
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('listManager fetchSource', () => {
  it('returns the decoded text and the etag header on a 2xx response', async () => {
    const fetchImpl = (async () =>
      streamingResponse([enc('||ads.example^\n'), enc('||x.example^')], {
        etag: 'W/"abc123"',
      })) as unknown as typeof fetch;

    const result = await fetchSource('https://lists.test/a.txt', {
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      fetchImpl,
    });
    expect(result.text).toBe('||ads.example^\n||x.example^');
    expect(result.etag).toBe('W/"abc123"');
  });

  it('returns etag null when the response has no etag header', async () => {
    const fetchImpl = (async () =>
      streamingResponse([enc('||y.example^')])) as unknown as typeof fetch;
    const result = await fetchSource('https://lists.test/b.txt', {
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      fetchImpl,
    });
    expect(result.etag).toBeNull();
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () =>
      streamingResponse([enc('nope')], { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchSource('https://lists.test/c.txt', {
        timeoutMs: 1000,
        maxBytes: 1_000_000,
        fetchImpl,
      }),
    ).rejects.toThrow();
  });

  it('throws when the streamed body exceeds maxBytes (cap enforced before full buffering)', async () => {
    // Three 4-byte chunks = 12 bytes; cap at 8 → must throw on the chunk that crosses 8.
    const fetchImpl = (async () =>
      streamingResponse([enc('aaaa'), enc('bbbb'), enc('cccc')])) as unknown as typeof fetch;
    await expect(
      fetchSource('https://lists.test/big.txt', {
        timeoutMs: 1000,
        maxBytes: 8,
        fetchImpl,
      }),
    ).rejects.toThrow(/maxBytes|too large|size/i);
  });

  it('aborts and throws when the fetch exceeds timeoutMs', async () => {
    // fetchImpl honors the passed AbortSignal: reject when aborted.
    const fetchImpl = ((_url: string, opts: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal) {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }
      })) as unknown as typeof fetch;

    await expect(
      fetchSource('https://lists.test/slow.txt', {
        timeoutMs: 5,
        maxBytes: 1_000_000,
        fetchImpl,
      }),
    ).rejects.toThrow();
  });
});
