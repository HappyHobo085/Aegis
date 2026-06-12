// electron/main/ipc/update.ts
import { IPC } from '../../../shared/types';
import type { UpdateState } from '../../../shared/types';
import type { UpdateController } from '../update/UpdateController';

/**
 * Builds the update IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). Typed against the slice of
 * UpdateController the IPC surface needs.
 */
export function buildUpdateHandlers(
  controller: Pick<UpdateController, 'getState' | 'checkNow' | 'restartToInstall'>,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.updateGetState]: (): UpdateState => controller.getState(),
    [IPC.updateCheckNow]: (): Promise<void> => controller.checkNow(),
    [IPC.updateRestartToInstall]: (): void => controller.restartToInstall(),
  };
}
