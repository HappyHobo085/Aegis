// electron/main/ipc/adblock.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { AdblockState } from '../../../shared/types';
import { buildAdblockHandlers } from './adblock';

function makeController(state: AdblockState) {
  return {
    setEnabled: vi.fn((enabled: boolean): AdblockState => ({ ...state, enabled })),
    toggleAllowlist: vi.fn((host: string): AdblockState => ({
      ...state,
      allowlistedHosts: [...state.allowlistedHosts, host],
    })),
    getState: vi.fn((): AdblockState => state),
  };
}

describe('buildAdblockHandlers', () => {
  const base: AdblockState = { enabled: true, allowlistedHosts: [], sessionBlocked: 5 };

  it('registers exactly the three adblock channels', () => {
    const handlers = buildAdblockHandlers(makeController(base) as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.adblockSetEnabled, IPC.adblockToggleAllowlist, IPC.adblockGetState].sort(),
    );
  });

  it('adblockSetEnabled forwards the flag to controller.setEnabled and returns the state', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockSetEnabled](false);
    expect(c.setEnabled).toHaveBeenCalledWith(false);
    expect(result).toEqual({ ...base, enabled: false });
  });

  it('adblockToggleAllowlist forwards the host and returns the new state', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockToggleAllowlist]('example.com');
    expect(c.toggleAllowlist).toHaveBeenCalledWith('example.com');
    expect(result.allowlistedHosts).toContain('example.com');
  });

  it('adblockGetState returns controller.getState()', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockGetState]();
    expect(c.getState).toHaveBeenCalledTimes(1);
    expect(result).toEqual(base);
  });
});
