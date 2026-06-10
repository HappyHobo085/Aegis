// electron/main/adblock/listManager.ts
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFileAtomic, readFileSafe } from '../../lib/atomicFile';

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
  const parsed = new URL(url);
  const isLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new Error(`Refusing non-HTTPS list URL: ${url}`);
  }
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

/** sha1 hex of list text — used as the per-source content hash in metadata. */
function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

/**
 * Fetch every subscription source. Per source: try `fetchSource`; on success
 * write the raw cache atomically and record ok + hash + etag; on failure fall
 * back to the on-disk cache (last-known-good) marked not-ok with the error, or
 * empty/not-ok if no cache exists. Resources are best-effort: a failure yields
 * `resources: null` (the engine still builds from list text).
 */
export async function fetchAll(
  subs: { listId: string; url: string }[],
  opts: {
    cacheDir: string;
    timeoutMs: number;
    maxBytes: number;
    resourcesUrl: string;
    fetchImpl?: typeof fetch;
  },
): Promise<FetchAllResult> {
  const sources: FetchedSource[] = [];
  for (const sub of subs) {
    const cachePath = join(opts.cacheDir, `${sub.listId}.txt`);
    try {
      const { text, etag } = await fetchSource(sub.url, {
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
        fetchImpl: opts.fetchImpl,
      });
      writeFileAtomic(cachePath, text);
      sources.push({
        listId: sub.listId,
        url: sub.url,
        ok: true,
        text,
        etag,
        hash: hashText(text),
      });
    } catch (err) {
      const cached = readFileSafe(cachePath);
      const text = cached ?? '';
      sources.push({
        listId: sub.listId,
        url: sub.url,
        ok: false,
        text,
        etag: null,
        hash: text.length > 0 ? hashText(text) : '',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let resources: string | null = null;
  try {
    const { text } = await fetchSource(opts.resourcesUrl, {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      fetchImpl: opts.fetchImpl,
    });
    resources = text;
  } catch {
    resources = null;
  }

  return { sources, resources };
}

type TimerHandle = unknown;

/**
 * Repeating refresh scheduler with an injectable timer (so tests use a fake
 * clock and CI never hits the wall). `start()` schedules the FIRST tick one
 * interval out (no immediate fire); each tick re-schedules the next. `stop()`
 * cancels the pending timer. `triggerNow()` runs `onTick` once immediately
 * WITHOUT touching the schedule — the manual "update now" path must not
 * double-fire the periodic tick.
 */
export class RefreshScheduler {
  private readonly intervalMs: number;
  private readonly onTick: () => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;
  private handle: TimerHandle | null = null;
  private running = false;

  constructor(deps: {
    intervalMs: number;
    onTick: () => Promise<void>;
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    clearTimer?: (h: TimerHandle) => void;
  }) {
    this.intervalMs = deps.intervalMs;
    this.onTick = deps.onTick;
    this.setTimer =
      deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
    this.clearTimer =
      deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
  }

  /** Run onTick once now without disturbing the periodic schedule. */
  async triggerNow(): Promise<void> {
    await this.onTick();
  }

  private schedule(): void {
    if (!this.running) return;
    this.handle = this.setTimer(() => {
      // fire the tick, then re-schedule the next interval
      void this.onTick().finally(() => {
        if (this.running) this.schedule();
      });
    }, this.intervalMs);
  }
}
