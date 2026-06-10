// electron/main/permissions.test.ts
import { describe, it, expect, vi } from 'vitest';
import { wirePermissions } from './permissions';

function makeSession() {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  };
}

function makeRepo(memory: Record<string, 'allow' | 'deny'> = {}) {
  return {
    get: vi.fn((origin: string, permission: string) => memory[`${origin}|${permission}`]),
    set: vi.fn((origin: string, permission: string, decision: 'allow' | 'deny') => {
      memory[`${origin}|${permission}`] = decision;
    }),
    list: vi.fn(() => []),
    remove: vi.fn(),
    clear: vi.fn(),
  };
}

describe('wirePermissions', () => {
  it('re-sets BOTH handlers on the session (last-set wins over the deny floor)', () => {
    const session = makeSession();
    wirePermissions(session as any, { permissionsRepo: makeRepo() as any, prompt: vi.fn() });
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);
  });

  it('request: a remembered allow answers callback(true) without prompting', () => {
    const session = makeSession();
    const repo = makeRepo({ 'https://x.test|geolocation': 'allow' });
    const prompt = vi.fn();
    wirePermissions(session as any, { permissionsRepo: repo as any, prompt });
    const reqHandler = session.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    reqHandler({}, 'geolocation', cb, { requestingUrl: 'https://x.test/page' });
    expect(cb).toHaveBeenCalledWith(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('request: a remembered deny answers callback(false)', () => {
    const session = makeSession();
    const repo = makeRepo({ 'https://x.test|media': 'deny' });
    wirePermissions(session as any, { permissionsRepo: repo as any, prompt: vi.fn() });
    const reqHandler = session.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    reqHandler({}, 'media', cb, { requestingUrl: 'https://x.test/' });
    expect(cb).toHaveBeenCalledWith(false);
  });

  it('request: an unremembered in-set permission prompts, persists, then answers', async () => {
    const session = makeSession();
    const repo = makeRepo();
    const prompt = vi.fn(async () => 'allow' as const);
    wirePermissions(session as any, { permissionsRepo: repo as any, prompt });
    const reqHandler = session.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    await reqHandler({}, 'notifications', cb, { requestingUrl: 'https://y.test/a' });
    expect(prompt).toHaveBeenCalledWith('https://y.test', 'notifications');
    expect(repo.set).toHaveBeenCalledWith('https://y.test', 'notifications', 'allow');
    expect(cb).toHaveBeenCalledWith(true);
  });

  it('request: an out-of-set permission is denied without a prompt', () => {
    const session = makeSession();
    const prompt = vi.fn();
    wirePermissions(session as any, { permissionsRepo: makeRepo() as any, prompt });
    const reqHandler = session.setPermissionRequestHandler.mock.calls[0][0];
    const cb = vi.fn();
    reqHandler({}, 'usb', cb, { requestingUrl: 'https://z.test/' });
    expect(cb).toHaveBeenCalledWith(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('check: returns true only for a remembered allow', () => {
    const session = makeSession();
    const repo = makeRepo({ 'https://x.test|geolocation': 'allow' });
    wirePermissions(session as any, { permissionsRepo: repo as any, prompt: vi.fn() });
    const checkHandler = session.setPermissionCheckHandler.mock.calls[0][0];
    expect(checkHandler({}, 'geolocation', 'https://x.test', {})).toBe(true);
    expect(checkHandler({}, 'media', 'https://x.test', {})).toBe(false);
  });
});
