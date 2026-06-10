// electron/main/adblock/engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Request, ElectronBlocker } from '@ghostery/adblocker-electron';
import { createHash } from 'node:crypto';
import {
  buildEngine,
  loadCachedEngine,
  loadSnapshotEngine,
  serializeEngine,
  DEFAULT_LIST_URLS,
  RESOURCES_URL,
} from './engine';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('engine buildEngine', () => {
  it('builds an engine from inline list text that blocks a matching URL', () => {
    const engine = buildEngine(['||ads.example.com^'], null);
    const { match } = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://ads.example.com/tag.js',
        sourceUrl: 'https://publisher.test/',
      }),
    );
    expect(match).toBe(true);
  });

  it('does not block a URL that no filter matches', () => {
    const engine = buildEngine(['||ads.example.com^'], null);
    const { match } = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://cdn.publisher.test/app.js',
        sourceUrl: 'https://publisher.test/',
      }),
    );
    expect(match).toBe(false);
  });

  it('concatenates multiple list texts', () => {
    const engine = buildEngine(['||a.example^', '||b.example^'], null);
    const a = engine.match(
      Request.fromRawDetails({
        type: 'image',
        url: 'https://a.example/x.gif',
        sourceUrl: 'https://pub.test/',
      }),
    ).match;
    const b = engine.match(
      Request.fromRawDetails({
        type: 'image',
        url: 'https://b.example/y.gif',
        sourceUrl: 'https://pub.test/',
      }),
    ).match;
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('loads $redirect resources when resources content is provided (updateResources returns true)', () => {
    // Source-verified resources.json shape: Resources.parse reads top-level
    // `scriptlets[]` / `redirects[]` (NOT a `resources` key); an empty-but-valid
    // payload loads cleanly without throwing. (§8.2/§8.3, verified vs 2.18.0.)
    const resources = JSON.stringify({ scriptlets: [], redirects: [] });

    // buildEngine accepts it without throwing and the engine still blocks.
    const engine = buildEngine(['||tracker.example^'], resources);
    const { match } = engine.match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://tracker.example/t.js',
        sourceUrl: 'https://pub.test/',
      }),
    );
    expect(match).toBe(true);

    // And updateResources itself returns true for this payload (§8.3) — assert the
    // boolean directly, since buildEngine swallows it.
    const direct = ElectronBlocker.parse('||tracker.example^');
    const checksum = createHash('sha1').update(resources).digest('hex');
    expect(direct.updateResources(resources, checksum)).toBe(true);
  });

  it('exposes the default list URL set derived from adsAndTrackingLists', () => {
    expect(Array.isArray(DEFAULT_LIST_URLS)).toBe(true);
    expect(DEFAULT_LIST_URLS.length).toBeGreaterThan(0);
    for (const entry of DEFAULT_LIST_URLS) {
      expect(typeof entry.listId).toBe('string');
      expect(entry.listId.length).toBeGreaterThan(0);
      expect(entry.url.startsWith('https://')).toBe(true);
    }
    // listIds are unique
    const ids = DEFAULT_LIST_URLS.map((s) => s.listId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('exposes an HTTPS resources URL', () => {
    expect(RESOURCES_URL.startsWith('https://')).toBe(true);
    expect(RESOURCES_URL).toContain('resources.json');
  });
});

describe('engine serialize/load round-trip', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-engine-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serializeEngine writes a blob that loadCachedEngine deserializes (round-trip blocks the same URL)', () => {
    const cachePath = join(dir, 'engine.bin');
    const original = buildEngine(['||ads.example.com^'], null);
    serializeEngine(original, cachePath);

    const loaded = loadCachedEngine(cachePath);
    expect(loaded).not.toBeNull();
    const { match } = (loaded as NonNullable<typeof loaded>).match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://ads.example.com/tag.js',
        sourceUrl: 'https://pub.test/',
      }),
    );
    expect(match).toBe(true);
  });

  it('loadCachedEngine returns null when the cache file is missing', () => {
    expect(loadCachedEngine(join(dir, 'nope.bin'))).toBeNull();
  });

  it('loadCachedEngine returns null on a corrupt blob (deserialize mismatch)', () => {
    const cachePath = join(dir, 'corrupt.bin');
    writeFileSync(cachePath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(loadCachedEngine(cachePath)).toBeNull();
  });

  it('loadSnapshotEngine round-trips a serialized blob the same way', () => {
    const snapPath = join(dir, 'engine-seed.bin');
    const original = buildEngine(['||tracker.example^'], null);
    serializeEngine(original, snapPath);

    const loaded = loadSnapshotEngine(snapPath);
    expect(loaded).not.toBeNull();
    const { match } = (loaded as NonNullable<typeof loaded>).match(
      Request.fromRawDetails({
        type: 'script',
        url: 'https://tracker.example/t.js',
        sourceUrl: 'https://pub.test/',
      }),
    );
    expect(match).toBe(true);
  });

  it('loadSnapshotEngine returns null when the snapshot is missing', () => {
    expect(loadSnapshotEngine(join(dir, 'absent.bin'))).toBeNull();
  });
});
