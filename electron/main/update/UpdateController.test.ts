import { describe, it, expect, vi } from 'vitest';
import { UpdateController, type UpdaterLike } from './UpdateController';
import type { UpdateState } from '../../../shared/types';

function makeFakeUpdater() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on(event: string, listener: (...args: any[]) => void) {
      handlers[event] = listener;
    },
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  };
  const emit = (event: string, ...args: any[]): void => handlers[event]?.(...args);
  return { updater, emit };
}

describe('UpdateController', () => {
  it('starts idle and enables autoDownload + autoInstallOnAppQuit', () => {
    const { updater } = makeFakeUpdater();
    const c = new UpdateController({ updater, onState: () => {} });
    expect(c.getState()).toEqual({ status: 'idle', version: null, percent: 0, error: null });
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('transitions checking -> available -> downloading -> downloaded and pushes each', () => {
    const { updater, emit } = makeFakeUpdater();
    const states: UpdateState[] = [];
    const c = new UpdateController({ updater, onState: (s) => states.push(s) });
    emit('checking-for-update');
    expect(c.getState().status).toBe('checking');
    emit('update-available', { version: '0.2.0' });
    expect(c.getState()).toMatchObject({ status: 'available', version: '0.2.0' });
    emit('download-progress', { percent: 42.7 });
    expect(c.getState()).toMatchObject({ status: 'downloading', percent: 43 });
    emit('update-downloaded', { version: '0.2.0' });
    expect(c.getState()).toMatchObject({ status: 'downloaded', version: '0.2.0', percent: 100 });
    expect(states).toHaveLength(4);
  });

  it('captures errors', () => {
    const { updater, emit } = makeFakeUpdater();
    const c = new UpdateController({ updater, onState: () => {} });
    emit('error', new Error('feed unreachable'));
    expect(c.getState()).toMatchObject({ status: 'error', error: 'feed unreachable' });
  });

  it('checkNow swallows a rejected check into error state', async () => {
    const { updater } = makeFakeUpdater();
    (updater.checkForUpdates as any).mockRejectedValueOnce(new Error('no network'));
    const c = new UpdateController({ updater, onState: () => {} });
    await c.checkNow();
    expect(c.getState()).toMatchObject({ status: 'error', error: 'no network' });
  });

  it('restartToInstall calls quitAndInstall', () => {
    const { updater } = makeFakeUpdater();
    const c = new UpdateController({ updater, onState: () => {} });
    c.restartToInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
