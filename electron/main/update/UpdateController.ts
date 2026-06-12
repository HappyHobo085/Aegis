// electron/main/update/UpdateController.ts
import type { UpdateState } from '../../../shared/types';

/**
 * The slice of electron-updater's `autoUpdater` this controller depends on.
 * Declared locally so the controller is unit-testable in the node project
 * WITHOUT importing electron-updater (which pulls in electron).
 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface UpdateControllerOpts {
  updater: UpdaterLike;
  onState: (state: UpdateState) => void;
}

const INITIAL: UpdateState = { status: 'idle', version: null, percent: 0, error: null };

/**
 * Owns the auto-update lifecycle: wires autoUpdater events into an UpdateState,
 * pushes each change via onState (the boot layer forwards it to the chrome
 * renderer). autoDownload is on so an available update fetches in the background;
 * autoInstallOnAppQuit is on so a downloaded update lands on the next quit even
 * if the user never clicks "restart".
 */
export class UpdateController {
  private state: UpdateState = { ...INITIAL };
  private readonly updater: UpdaterLike;
  private readonly emit: (state: UpdateState) => void;

  constructor(opts: UpdateControllerOpts) {
    this.updater = opts.updater;
    this.emit = opts.onState;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = true;
    this.wire();
  }

  private set(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial };
    this.emit(this.state);
  }

  private wire(): void {
    this.updater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    this.updater.on('update-available', (info: { version?: string }) =>
      this.set({ status: 'available', version: info?.version ?? null }),
    );
    this.updater.on('update-not-available', () => this.set({ status: 'not-available' }));
    this.updater.on('download-progress', (p: { percent?: number }) =>
      this.set({ status: 'downloading', percent: Math.round(p?.percent ?? 0) }),
    );
    this.updater.on('update-downloaded', (info: { version?: string }) =>
      this.set({ status: 'downloaded', version: info?.version ?? null, percent: 100 }),
    );
    this.updater.on('error', (err: Error) =>
      this.set({ status: 'error', error: err?.message ?? String(err) }),
    );
  }

  getState(): UpdateState {
    return this.state;
  }

  async checkNow(): Promise<void> {
    try {
      await this.updater.checkForUpdates();
    } catch (err) {
      this.set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  restartToInstall(): void {
    this.updater.quitAndInstall();
  }
}
