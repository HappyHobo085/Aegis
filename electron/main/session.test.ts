// electron/main/session.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastSession, writeLastSession } from './session';

describe('session', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-session-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('readLastSession', () => {
    it('returns null when session.json does not exist', () => {
      expect(readLastSession(dir)).toBeNull();
    });

    it('returns null when session.json is not valid JSON', () => {
      writeFileSync(join(dir, 'session.json'), 'not json {{{');
      expect(readLastSession(dir)).toBeNull();
    });

    it('returns null when the stored shape is missing url/title', () => {
      writeFileSync(join(dir, 'session.json'), JSON.stringify({ foo: 'bar' }));
      expect(readLastSession(dir)).toBeNull();
    });

    it('reads back a valid session', () => {
      writeFileSync(
        join(dir, 'session.json'),
        JSON.stringify({ url: 'https://example.com', title: 'Example' }),
      );
      expect(readLastSession(dir)).toEqual({ url: 'https://example.com', title: 'Example' });
    });
  });

  describe('writeLastSession', () => {
    it('writes session.json into the data dir', () => {
      writeLastSession(dir, { url: 'https://aegis.test', title: 'Aegis' });
      const path = join(dir, 'session.json');
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        url: 'https://aegis.test',
        title: 'Aegis',
      });
    });

    it('round-trips through readLastSession', () => {
      writeLastSession(dir, { url: 'https://round.trip', title: 'RT' });
      expect(readLastSession(dir)).toEqual({ url: 'https://round.trip', title: 'RT' });
    });

    it('overwrites a previous session atomically (no temp file left behind)', () => {
      writeLastSession(dir, { url: 'https://first', title: 'First' });
      writeLastSession(dir, { url: 'https://second', title: 'Second' });
      expect(readLastSession(dir)).toEqual({ url: 'https://second', title: 'Second' });
      // atomicFile cleans up its pid-suffixed temp on success
      const path = join(dir, 'session.json');
      expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
    });
  });
});
