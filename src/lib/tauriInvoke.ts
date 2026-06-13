import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * Call a Rust command by its IPC channel name — the strings in shared/types.ts
 * `IPC` (e.g. 'nav.navigate'). Tauri command identifiers cannot contain '.', so
 * every channel is routed through a single Rust `ipc(channel, payload)` command
 * that dispatches internally. `T` defaults to void for the many action channels;
 * specify it for channels that return data.
 */
export function call<T = void>(channel: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>('ipc', { channel, payload: payload ?? {} });
}

/**
 * Subscribe to a Rust-emitted event (the `evt*` channels). Returns a synchronous
 * unsubscribe function, matching the AegisApi `onX(): () => void` contract even
 * though Tauri's `listen` resolves its unlisten handle asynchronously.
 */
export function on<T>(event: string, cb: (payload: T) => void): () => void {
  // Tauri 2 forbids '.' in event names; the Rust side (emit_event) emits the same
  // names with '.'→':'. Translate here so listen() registers and events arrive.
  const tauriEvent = event.replace(/\./g, ':');
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void listen<T>(tauriEvent, (e) => cb(e.payload)).then((u) => {
    if (cancelled) u();
    else unlisten = u;
  });
  return () => {
    cancelled = true;
    if (unlisten) unlisten();
  };
}
