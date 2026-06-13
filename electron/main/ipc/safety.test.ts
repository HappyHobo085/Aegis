import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import { buildSafetyHandlers } from './safety';

function fakeController() {
  return {
    getState: vi.fn(() => null),
    proceed: vi.fn(),
    listExceptions: vi.fn(() => ['a.com']),
    removeException: vi.fn(),
  };
}

describe('buildSafetyHandlers', () => {
  it('maps the safety channels to controller methods', () => {
    const c = fakeController();
    const h = buildSafetyHandlers(c as never);
    expect(typeof h[IPC.safetyGetState]).toBe('function');
    h[IPC.safetyProceed]('http://x/');
    expect(c.proceed).toHaveBeenCalledWith('http://x/');
    expect(h[IPC.safetyListExceptions]()).toEqual(['a.com']);
    h[IPC.safetyRemoveException]('a.com');
    expect(c.removeException).toHaveBeenCalledWith('a.com');
  });
});
