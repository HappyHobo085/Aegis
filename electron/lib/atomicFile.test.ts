// electron/lib/atomicFile.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeFileAtomic,
  readFileSafe,
  writeFileAtomicBytes,
  readBytesSafe,
} from './atomicFile';

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

    it('creates a missing parent directory tree before writing (regression: 7f90219)', () => {
      // The fix added mkdirSync(dirname(path), {recursive:true}); without it,
      // writing into a not-yet-existing subdir (e.g. <userData>/lists/) fails ENOENT.
      const target = join(dir, 'sub', 'nested', 'f.txt');
      expect(existsSync(join(dir, 'sub'))).toBe(false);
      writeFileAtomic(target, 'created-with-parents');
      expect(existsSync(target)).toBe(true);
      expect(readFileSafe(target)).toBe('created-with-parents');
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

describe('atomicFile bytes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-atomic-bytes-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('writeFileAtomicBytes', () => {
    it('round-trips arbitrary binary bytes', () => {
      const target = join(dir, 'engine.bin');
      const data = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 128]);
      writeFileAtomicBytes(target, data);
      const back = readBytesSafe(target);
      expect(back).not.toBeNull();
      expect(Array.from(back as Buffer)).toEqual(Array.from(data));
    });

    it('overwrites an existing binary file', () => {
      const target = join(dir, 'engine.bin');
      writeFileAtomicBytes(target, new Uint8Array([1, 1, 1]));
      writeFileAtomicBytes(target, new Uint8Array([9, 8, 7, 6]));
      expect(Array.from(readBytesSafe(target) as Buffer)).toEqual([9, 8, 7, 6]);
    });

    it('leaves no temp file behind after a successful write', () => {
      const target = join(dir, 'engine.bin');
      writeFileAtomicBytes(target, new Uint8Array([42]));
      const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    });

    it('creates a missing parent directory tree before writing (regression: 7f90219)', () => {
      // Mirrors the writeFileAtomic case for the binary path used by the engine
      // blob cache; without the mkdirSync, writing into <userData>/lists/ ENOENTs.
      const target = join(dir, 'sub', 'nested', 'f.bin');
      expect(existsSync(join(dir, 'sub'))).toBe(false);
      const data = new Uint8Array([10, 20, 30, 255]);
      writeFileAtomicBytes(target, data);
      expect(existsSync(target)).toBe(true);
      expect(Array.from(readBytesSafe(target) as Buffer)).toEqual(Array.from(data));
    });
  });

  describe('readBytesSafe', () => {
    it('returns a Buffer when the file exists', () => {
      const target = join(dir, 'present.bin');
      writeFileSync(target, Buffer.from([5, 6, 7]));
      const back = readBytesSafe(target);
      expect(Buffer.isBuffer(back)).toBe(true);
      expect(Array.from(back as Buffer)).toEqual([5, 6, 7]);
    });

    it('returns null when the file does not exist (ENOENT)', () => {
      const target = join(dir, 'missing.bin');
      expect(existsSync(target)).toBe(false);
      expect(readBytesSafe(target)).toBeNull();
    });

    it('returns null when the path is a directory (read error)', () => {
      expect(readBytesSafe(dir)).toBeNull();
    });
  });
});
