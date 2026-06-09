// electron/main/ipc/guard.ts
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

/**
 * Registers each handler on ipcMain.handle, wrapping it with sender validation:
 * the invoke is processed only when event.sender.id === chromeWebContentsId,
 * closing the confused-deputy path where a compromised content renderer could
 * drive privileged IPC. The wrapped handler is called with the invoke args
 * WITHOUT the event.
 */
export function registerGuardedHandlers(
  chromeWebContentsId: number,
  handlers: Record<string, (...args: any[]) => any>,
): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: any[]) => {
      if (event.sender.id !== chromeWebContentsId) {
        throw new Error(`Rejected ${channel}: unauthorized sender id ${event.sender.id}`);
      }
      return handler(...args);
    });
  }
}
