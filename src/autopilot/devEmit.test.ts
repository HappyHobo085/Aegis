// src/autopilot/devEmit.test.ts
import { describe, it, expect, vi } from 'vitest';
const invoke = vi.fn(async () => undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { screenshot, emitEvent } from './devEmit';

describe('devEmit', () => {
  it('screenshot invokes the dev command', async () => {
    await screenshot('home');
    expect(invoke).toHaveBeenCalledWith('autopilot_screenshot', { name: 'home' });
  });
  it('emitEvent invokes the dev command', async () => {
    await emitEvent('nav.failed', { viewId: 1 });
    expect(invoke).toHaveBeenCalledWith('autopilot_emit_event', { name: 'nav.failed', payload: { viewId: 1 } });
  });
});
