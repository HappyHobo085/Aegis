// electron/main/ipc/guard.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared registry captured from the mocked ipcMain.handle (vi.mock is hoisted,
// so the registry must be created via vi.hoisted to be referenceable inside the mock factory).
const h = vi.hoisted(() => ({
  registry: new Map<string, (event: any, ...args: any[]) => any>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: any, ...args: any[]) => any) => {
      h.registry.set(channel, handler);
    },
  },
}));

import { registerGuardedHandlers } from './guard';

const CHROME_ID = 7;

describe('registerGuardedHandlers', () => {
  beforeEach(() => {
    h.registry.clear();
  });

  it('registers each handler on ipcMain under its channel key', () => {
    registerGuardedHandlers(CHROME_ID, {
      'a.channel': () => 'a',
      'b.channel': () => 'b',
    });
    expect(h.registry.has('a.channel')).toBe(true);
    expect(h.registry.has('b.channel')).toBe(true);
  });

  it('calls the handler with args (without the event) for a valid sender', () => {
    const spy = vi.fn(() => 'ok');
    registerGuardedHandlers(CHROME_ID, { 'a.channel': spy });
    const wrapped = h.registry.get('a.channel')!;
    const result = wrapped({ sender: { id: CHROME_ID } }, 1, 'two', true);
    expect(spy).toHaveBeenCalledWith(1, 'two', true);
    expect(result).toBe('ok');
  });

  it('rejects (throws) and does NOT call the handler for a foreign sender id', () => {
    const spy = vi.fn(() => 'ok');
    registerGuardedHandlers(CHROME_ID, { 'a.channel': spy });
    const wrapped = h.registry.get('a.channel')!;
    expect(() => wrapped({ sender: { id: 999 } }, 'evil')).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
