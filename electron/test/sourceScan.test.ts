// electron/test/sourceScan.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const SCAN_DIRS = ['src', 'electron'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json']);

// This test file references the forbidden tokens verbatim, so it must exclude itself.
const SELF = resolve(__dirname, 'sourceScan.test.ts');

// Forbidden UW proxy artifacts (§10.9 / spec §1 explicit non-goals).
const FORBIDDEN: { token: string; why: string }[] = [
  { token: '_px_host', why: 'URL-rewriting / subdomain proxy routing' },
  { token: 'directHosts', why: 'hardcoded proxy host allowlist' },
  { token: 'clearanceHosts', why: 'anti-bot clearance host allowlist' },
  { token: 'streamExtractHosts', why: 'media extraction host allowlist' },
  { token: '/api/wrapper', why: 'proxy wrapper API layer' },
  { token: 'postMessage', why: 'address-bar postMessage bridge (use contextBridge IPC instead)' },
];

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory may not exist yet during early scaffolding
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'out' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (SCAN_EXTS.has(full.slice(full.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
}

function allScannedFiles(): string[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) {
    files.push(...collectFiles(join(ROOT, d)));
  }
  return files.filter((f) => f !== SELF);
}

describe('source scan: no forbidden proxy artifacts (§10.9)', () => {
  for (const { token, why } of FORBIDDEN) {
    it(`contains no "${token}" (${why})`, () => {
      const hits: string[] = [];
      for (const file of allScannedFiles()) {
        const text = readFileSync(file, 'utf8');
        if (text.includes(token)) {
          hits.push(relative(ROOT, file).split(sep).join('/'));
        }
      }
      expect(hits, `forbidden token "${token}" found in: ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('scans at least one real source file (guards against a no-op pass)', () => {
    // If the globber silently matched nothing, the FORBIDDEN loop would vacuously pass.
    expect(allScannedFiles().length).toBeGreaterThan(0);
  });
});
