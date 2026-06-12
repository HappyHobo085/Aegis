import { describe, it, expect, vi } from 'vitest';
import { buildUpdateHandlers } from './update';
import { IPC, type UpdateState } from '../../../shared/types';

const state: UpdateState = { status: 'idle', version: null, percent: 0, error: null };

function fakeController() {
  return {
    getState: vi.fn(() => state),
    checkNow: vi.fn(async () => {}),
    restartToInstall: vi.fn(() => {}),
  };
}

describe('buildUpdateHandlers', () => {
  it('maps update.getState to controller.getState', () => {
    const c = fakeController();
    const h = buildUpdateHandlers(c);
    expect(h[IPC.updateGetState]()).toBe(state);
    expect(c.getState).toHaveBeenCalledOnce();
  });

  it('maps update.checkNow to controller.checkNow', async () => {
    const c = fakeController();
    const h = buildUpdateHandlers(c);
    await h[IPC.updateCheckNow]();
    expect(c.checkNow).toHaveBeenCalledOnce();
  });

  it('maps update.restartToInstall to controller.restartToInstall', () => {
    const c = fakeController();
    const h = buildUpdateHandlers(c);
    h[IPC.updateRestartToInstall]();
    expect(c.restartToInstall).toHaveBeenCalledOnce();
  });
});
