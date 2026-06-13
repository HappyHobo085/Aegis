// electron/main/ipc/safety.ts
import { IPC } from '../../../shared/types';
import type { SafetyController } from '../safety/SafetyController';

/** Guarded IPC map for the safety/interstitial surface. */
export function buildSafetyHandlers(
  safety: SafetyController,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.safetyGetState]: () => safety.getState(),
    [IPC.safetyProceed]: (url: string) => safety.proceed(url),
    [IPC.safetyListExceptions]: () => safety.listExceptions(),
    [IPC.safetyRemoveException]: (host: string) => safety.removeException(host),
  };
}
