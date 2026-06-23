import { describe, it, expect } from 'vitest';
import { IPC, type UpdateState } from './types';

describe('update IPC contract', () => {
  it('exposes the update channel names', () => {
    expect(IPC.updateGetState).toBe('update.getState');
    expect(IPC.updateCheckNow).toBe('update.checkNow');
    expect(IPC.updateRestartToInstall).toBe('update.restartToInstall');
    expect(IPC.evtUpdateState).toBe('update.state');
  });

  it('UpdateState carries status/version/percent/error', () => {
    const sample: UpdateState = {
      status: 'downloaded',
      version: '0.2.0',
      percent: 100,
      error: null,
    };
    expect(sample.status).toBe('downloaded');
    expect(sample.percent).toBe(100);
  });
});
