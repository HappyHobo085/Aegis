// electron/main/ipc/lists.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { ListUpdateResult } from '../../../shared/types';
import { buildListsHandlers } from './lists';

describe('buildListsHandlers', () => {
  it('registers exactly the listsUpdateNow channel', () => {
    const handlers = buildListsHandlers(async () => ({ perSource: [], lastUpdated: 0 }));
    expect(Object.keys(handlers)).toEqual([IPC.listsUpdateNow]);
  });

  it('listsUpdateNow invokes the injected updateNow and resolves its result', async () => {
    const result: ListUpdateResult = {
      perSource: [{ listId: 'easylist', ok: true }],
      lastUpdated: 1717977600000,
    };
    const updateNow = vi.fn(async () => result);
    const handlers = buildListsHandlers(updateNow);
    const out = await handlers[IPC.listsUpdateNow]();
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(out).toEqual(result);
  });
});
