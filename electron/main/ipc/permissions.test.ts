// electron/main/ipc/permissions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { SitePermission } from '../../../shared/types';
import { buildPermissionsHandlers } from './permissions';

function makeRepo(rows: SitePermission[] = []) {
  return {
    get: vi.fn(),
    set: vi.fn(),
    list: vi.fn(() => rows),
    remove: vi.fn(),
    clear: vi.fn(),
  };
}

describe('buildPermissionsHandlers', () => {
  it('registers exactly the four permissions channels', () => {
    const handlers = buildPermissionsHandlers(makeRepo() as any, { resolvePrompt: vi.fn() });
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.permissionsList, IPC.permissionsRemove, IPC.permissionsClear, IPC.permissionsResolve].sort(),
    );
  });

  it('list returns repo.list()', () => {
    const rows: SitePermission[] = [{ origin: 'https://x', permission: 'media', decision: 'allow' }];
    const handlers = buildPermissionsHandlers(makeRepo(rows) as any, { resolvePrompt: vi.fn() });
    expect(handlers[IPC.permissionsList]()).toEqual(rows);
  });

  it('remove deletes the (origin,permission) row and returns the fresh list', () => {
    const repo = makeRepo();
    const handlers = buildPermissionsHandlers(repo as any, { resolvePrompt: vi.fn() });
    handlers[IPC.permissionsRemove]('https://x', 'media');
    expect(repo.remove).toHaveBeenCalledWith('https://x', 'media');
    expect(repo.list).toHaveBeenCalled();
  });

  it('clear empties the store and returns the fresh list', () => {
    const repo = makeRepo();
    const handlers = buildPermissionsHandlers(repo as any, { resolvePrompt: vi.fn() });
    handlers[IPC.permissionsClear]();
    expect(repo.clear).toHaveBeenCalledTimes(1);
  });

  it('resolve forwards (requestId, decision) to resolvePrompt', () => {
    const resolvePrompt = vi.fn();
    const handlers = buildPermissionsHandlers(makeRepo() as any, { resolvePrompt });
    handlers[IPC.permissionsResolve](42, 'deny');
    expect(resolvePrompt).toHaveBeenCalledWith(42, 'deny');
  });
});
