// electron/test/e2e/savedTags.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SavedItem } from '../../../shared/types';

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      AEGIS_E2E: '1',
      AEGIS_USER_DATA: userDataDir,
      AEGIS_HOME_URL: 'about:blank',
    },
  });
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(() => {
            const reg = (globalThis as any).__aegisTest;
            return reg?.primary ? reg.primary.getState().url : '';
          });
        } catch {
          return '';
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

/** Drive the constructed SavedRepo inside the booted app (tags moved here from favorites). */
function savedAdd(
  app: ElectronApplication,
  input: { url: string; title: string; tags: string[] },
): Promise<SavedItem[]> {
  return app.evaluate((_e, i) => (globalThis as any).__aegisTest.places.savedRepo.add(i), input);
}

function savedTagUnion(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.savedRepo.tagUnion());
}

function savedRenameTag(
  app: ElectronApplication,
  oldT: string,
  newT: string,
): Promise<SavedItem[]> {
  return app.evaluate(
    (_e, args) =>
      (globalThis as any).__aegisTest.places.savedRepo.renameTag(args.oldT, args.newT),
    { oldT, newT },
  );
}

function savedDeleteTag(app: ElectronApplication, tag: string): Promise<SavedItem[]> {
  return app.evaluate(
    (_e, t) => (globalThis as any).__aegisTest.places.savedRepo.deleteTag(t),
    tag,
  );
}

test('saved add → list/tagUnion reflect tags; renameTag/deleteTag span all rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-saved-tags-'));
  const app = await launchApp(dir);
  try {
    // Add two saved items with overlapping + distinct tags.
    let list = await savedAdd(app, {
      url: 'https://alpha.test/',
      title: 'Alpha',
      tags: ['news', 'work'],
    });
    expect(list.map((s) => s.title)).toEqual(['Alpha']);
    list = await savedAdd(app, {
      url: 'https://beta.test/',
      title: 'Beta',
      tags: ['work', 'fun'],
    });
    // saved_list is newest-first, so Beta precedes Alpha.
    expect(list.map((s) => s.title)).toEqual(['Beta', 'Alpha']);

    // tagUnion is the distinct, sorted set across all rows.
    expect(await savedTagUnion(app)).toEqual(['fun', 'news', 'work']);

    // Global rename: 'work' → 'job' updates BOTH items.
    const renamed = await savedRenameTag(app, 'work', 'job');
    expect(renamed.find((s) => s.title === 'Alpha')!.tags).toEqual(['news', 'job']);
    expect(renamed.find((s) => s.title === 'Beta')!.tags).toEqual(['job', 'fun']);
    expect(await savedTagUnion(app)).toEqual(['fun', 'job', 'news']);

    // Global delete: 'job' is removed from EVERY item.
    const afterDelete = await savedDeleteTag(app, 'job');
    expect(afterDelete.find((s) => s.title === 'Alpha')!.tags).toEqual(['news']);
    expect(afterDelete.find((s) => s.title === 'Beta')!.tags).toEqual(['fun']);
    expect(await savedTagUnion(app)).toEqual(['fun', 'news']);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
