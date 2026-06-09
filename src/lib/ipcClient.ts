// src/lib/ipcClient.ts
import type { AegisApi } from '../../shared/types';

/** The contextBridge-exposed API. Renderer code imports `aegis` from here. */
export const aegis: AegisApi = window.aegis;
