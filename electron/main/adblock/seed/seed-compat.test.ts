import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ElectronBlocker } from '@ghostery/adblocker-electron';

const SEED_PATH = join(__dirname, 'engine-seed.bin');

describe('engine seed snapshot', () => {
  it('deserializes the committed snapshot against the installed engine', () => {
    if (!existsSync(SEED_PATH)) {
      console.warn(
        `[seed-compat] ${SEED_PATH} is absent — run \`npm run generate-seed\` to build it. Skipping.`,
      );
      return; // scaffold task: no blob yet → pass-with-skip (§8.10)
    }
    const bytes = new Uint8Array(readFileSync(SEED_PATH));
    // ElectronBlocker.deserialize throws on a serialization-version/format
    // mismatch — catching "engine bumped, snapshot not regenerated".
    const engine = ElectronBlocker.deserialize(bytes);
    expect(engine).toBeInstanceOf(ElectronBlocker);
  });
});
