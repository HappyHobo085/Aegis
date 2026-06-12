import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveSeedPath } from './seedPath';

describe('resolveSeedPath', () => {
  it('uses the __dirname-relative path in dev/e2e (not packaged)', () => {
    const p = resolveSeedPath({ isPackaged: false, mainDir: '/app/out/main', resourcesPath: '/ignored' });
    expect(p).toBe(join('/app/out/main', 'adblock/seed/engine-seed.bin'));
  });

  it('uses process.resourcesPath in a packaged app', () => {
    const p = resolveSeedPath({ isPackaged: true, mainDir: '/ignored', resourcesPath: '/opt/Aegis/resources' });
    expect(p).toBe(join('/opt/Aegis/resources', 'engine-seed.bin'));
  });
});
