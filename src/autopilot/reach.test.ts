// src/autopilot/reach.test.ts
import { describe, it, expect, vi } from 'vitest';
import { reachScreen } from './reach';
import type { AutopilotControl } from './control';
import { IPC } from '../../shared/types';

function fake(): AutopilotControl {
  const f = () => vi.fn();
  return Object.fromEntries(
    ['openSettings','closeSettings','openDownloads','closeDownloads','openManager','closeManager','setSidebar','setShield','enterFullscreen','exitFullscreen','showError','clearError','showCrash','clearCrash','openConfirm'].map((k) => [k, f()]),
  ) as unknown as AutopilotControl;
}

describe('reachScreen', () => {
  it('opens the downloads overlay', async () => {
    const c = fake();
    await reachScreen(c, { id: 'downloads', label: 'D', via: 'overlay' }, { emitEvent: vi.fn() });
    expect(c.openDownloads).toHaveBeenCalled();
  });
  it('emits the nav.failed event for the error overlay', async () => {
    const c = fake(); const emitEvent = vi.fn();
    await reachScreen(c, { id: 'errorOverlay', label: 'E', via: 'event' }, { emitEvent });
    expect(emitEvent).toHaveBeenCalledWith(IPC.evtNavFailed, expect.objectContaining({ viewId: expect.any(Number) }));
  });
});
