// electron/lib/atomicFile.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, readFileSafe } from './atomicFile';

describe('atomicFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('writeFileAtomic', () => {
    it('writes the file contents', () => {
      const target = join(dir, 'data.json');
      writeFileAtomic(target, '{"hello":"world"}');
      expect(readFileSafe(target)).toBe('{"hello":"world"}');
    });

    it('overwrites an existing file', () => {
      const target = join(dir, 'data.json');
      writeFileAtomic(target, 'first');
      writeFileAtomic(target, 'second');
      expect(readFileSafe(target)).toBe('second');
    });

    it('leaves no temp file behind after a successful write', () => {
      const target = join(dir, 'data.json');
      writeFileAtomic(target, 'payload');
      const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    });

    it('uses a pid-suffixed temp path then renames', () => {
      const target = join(dir, 'data.json');
      writeFileAtomic(target, 'payload');
      // only the final file should remain
      expect(readdirSync(dir)).toEqual(['data.json']);
    });
  });

  describe('readFileSafe', () => {
    it('returns the file contents when the file exists', () => {
      const target = join(dir, 'present.txt');
      writeFileSync(target, 'on disk');
      expect(readFileSafe(target)).toBe('on disk');
    });

    it('returns null when the file does not exist (ENOENT)', () => {
      const target = join(dir, 'missing.txt');
      expect(existsSync(target)).toBe(false);
      expect(readFileSafe(target)).toBeNull();
    });

    it('returns null when the path is a directory (read error)', () => {
      // reading a directory as a file throws EISDIR -> null
      expect(readFileSafe(dir)).toBeNull();
    });
  });
});
