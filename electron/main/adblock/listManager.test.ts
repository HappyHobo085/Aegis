// electron/main/adblock/listManager.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchSource, fetchAll } from './listManager';

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

describe('listManager fetchAll', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'aegis-lists-'));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const okFetch = (bodyByUrl: Record<string, string>): typeof fetch =>
    (async (url: string) => {
      const body = bodyByUrl[url];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { etag: `etag-${body.length}` } });
    }) as unknown as typeof fetch;

  it('fetches each source, writes its raw cache, and returns ok with hash + etag', async () => {
    const subs = [
      { listId: 'easylist', url: 'https://lists.test/easylist.txt' },
      { listId: 'easyprivacy', url: 'https://lists.test/easyprivacy.txt' },
    ];
    const fetchImpl = okFetch({
      'https://lists.test/easylist.txt': '||ads.example^',
      'https://lists.test/easyprivacy.txt': '||track.example^',
      'https://lists.test/resources.json': '{"scriptlets":[],"redirects":[]}',
    });

    const result = await fetchAll(subs, {
      cacheDir,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      resourcesUrl: 'https://lists.test/resources.json',
      fetchImpl,
    });

    expect(result.sources.map((s) => s.listId).sort()).toEqual(['easylist', 'easyprivacy']);
    for (const s of result.sources) {
      expect(s.ok).toBe(true);
      expect(s.text.length).toBeGreaterThan(0);
      expect(s.hash.length).toBeGreaterThan(0);
      expect(s.etag).toMatch(/^etag-/);
      expect(existsSync(join(cacheDir, `${s.listId}.txt`))).toBe(true);
    }
    expect(result.resources).toBe('{"scriptlets":[],"redirects":[]}');
  });

  it('falls back to the cached copy when a source fetch fails', async () => {
    const subs = [{ listId: 'easylist', url: 'https://lists.test/easylist.txt' }];
    // Pre-seed the cache as the last-known-good copy.
    writeFileSync(join(cacheDir, 'easylist.txt'), '||cached.example^');

    const failingFetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch;

    const result = await fetchAll(subs, {
      cacheDir,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      resourcesUrl: 'https://lists.test/resources.json',
      fetchImpl: failingFetch,
    });

    expect(result.sources).toHaveLength(1);
    const s = result.sources[0];
    expect(s.ok).toBe(false);
    expect(s.error).toBeTruthy();
    expect(s.text).toBe('||cached.example^');
    expect(s.hash.length).toBeGreaterThan(0);
  });

  it('marks a source not-ok with empty text when fetch fails and no cache exists', async () => {
    const subs = [{ listId: 'novel', url: 'https://lists.test/novel.txt' }];
    const failingFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await fetchAll(subs, {
      cacheDir,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      resourcesUrl: 'https://lists.test/resources.json',
      fetchImpl: failingFetch,
    });

    const s = result.sources[0];
    expect(s.ok).toBe(false);
    expect(s.text).toBe('');
    expect(s.error).toBeTruthy();
  });

  it('returns resources=null (best-effort) when the resources fetch fails', async () => {
    const subs = [{ listId: 'easylist', url: 'https://lists.test/easylist.txt' }];
    const fetchImpl = (async (url: string) => {
      if (url === 'https://lists.test/easylist.txt') {
        return new Response('||ads.example^', { status: 200 });
      }
      return new Response('no resources', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await fetchAll(subs, {
      cacheDir,
      timeoutMs: 1000,
      maxBytes: 1_000_000,
      resourcesUrl: 'https://lists.test/resources.json',
      fetchImpl,
    });

    expect(result.sources[0].ok).toBe(true);
    expect(result.resources).toBeNull();
  });
});
