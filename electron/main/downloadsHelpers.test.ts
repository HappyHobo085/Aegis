// electron/main/downloadsHelpers.test.ts
import { describe, it, expect } from 'vitest';
import { uniquifyFilename, resolveDownloadDir } from './downloadsHelpers';

describe('uniquifyFilename', () => {
  const exists = (taken: string[]) => (p: string) => taken.includes(p);

  it('returns the name unchanged when it does not collide', () => {
    expect(uniquifyFilename('/d/file.pdf', exists([]))).toBe('/d/file.pdf');
  });

  it('appends " (1)" before the extension on the first collision', () => {
    expect(uniquifyFilename('/d/file.pdf', exists(['/d/file.pdf']))).toBe('/d/file (1).pdf');
  });

  it('increments until a free name is found', () => {
    const taken = ['/d/file.pdf', '/d/file (1).pdf', '/d/file (2).pdf'];
    expect(uniquifyFilename('/d/file.pdf', exists(taken))).toBe('/d/file (3).pdf');
  });

  it('handles names with no extension', () => {
    expect(uniquifyFilename('/d/README', exists(['/d/README']))).toBe('/d/README (1)');
  });

  it('handles dotfiles (leading dot is not an extension)', () => {
    expect(uniquifyFilename('/d/.env', exists(['/d/.env']))).toBe('/d/.env (1)');
  });

  it('treats only the final segment as the basename (dir kept verbatim)', () => {
    expect(uniquifyFilename('/a.b/c/file.tar.gz', exists(['/a.b/c/file.tar.gz']))).toBe(
      '/a.b/c/file (1).tar.gz',
    );
  });
});

describe('resolveDownloadDir', () => {
  it('uses the configured dir when non-empty', () => {
    expect(resolveDownloadDir('/custom/dl', '/home/u/Downloads')).toBe('/custom/dl');
  });

  it('falls back to the OS dir when the setting is empty', () => {
    expect(resolveDownloadDir('', '/home/u/Downloads')).toBe('/home/u/Downloads');
  });

  it('trims a whitespace-only setting to the OS dir', () => {
    expect(resolveDownloadDir('   ', '/home/u/Downloads')).toBe('/home/u/Downloads');
  });
});
