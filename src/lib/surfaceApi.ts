// src/lib/surfaceApi.ts
//
// The popover surface's ONLY route to the backend, and it is deliberately not
// `ipcClient.ts`.
//
// The surface runs in its own webview with its own capability
// (`src-tauri/capabilities/surface.json`) that grants three things: `listen`, `unlisten`,
// and the single `popover_picked` command. It has **no `ipc` permission**, so it cannot
// reach `settings.set`, `nav.navigate`, or any other app channel. That is the whole reason
// this file exists instead of the surface importing the shared client: one module that
// imports `ipcClient` would be a capability hole in a module the chrome already needs.
//
// Two functions, and both are exercised by tests with `@tauri-apps/api` mocked:
//
//   start      — subscribe to the targeted `popover:payload` event AND perform the readiness
//                handshake. Targeted, not broadcast: it carries browsing-history titles, and
//                Rust sends it with `emit_to` against the surface's label alone so no content
//                webview ever sees it.
//   picked     — the ONLY thing the surface can say. It calls the dedicated
//                `popover_picked` command (never `ipc`), and Rust re-validates the index
//                and the action against what the chrome last declared before re-emitting.
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { IPC } from '../../shared/types';
import type { PopoverPick, PopoverSurfacePayload } from '../../shared/types';

/** Tell Rust the surface can receive now, so it replays whatever popover is open.
 *
 * `emit_to` is fire-and-forget: a payload emitted before this listener exists is delivered to
 * nobody, permanently. That is the NORMAL case at launch — the surface webview boots with the
 * app and the chrome sends its first popover within a second of it — and it is also what a
 * WebKit web-process reload would do. Measured on the built AppImage without this call: the
 * surface was placed at exactly the right rect with `topmost=true visible=true` and never
 * received the payload at all.
 */
export async function ready(): Promise<void> {
  await invoke('popover_ready');
}

/**
 * Subscribe to popover payloads and announce readiness, in that order.
 *
 * The ORDER is the contract, and it is why this cannot be the shared `on()` helper: `on()`
 * returns a synchronous unsubscribe and resolves its backend listener in the background, so
 * calling `ready()` straight after it would ask Rust to replay into a listener that does not
 * exist yet — reproducing the race it exists to close. Here the handshake is only sent once
 * `listen()` has resolved, so by the time Rust replays, this webview is genuinely receiving.
 *
 * @returns a synchronous unsubscribe, matching every other `onX` in this codebase.
 */
export function start(cb: (p: PopoverSurfacePayload) => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;
  void (async () => {
    // Tauri 2 forbids '.' in event names; the Rust side emits the same logical name with
    // '.'→':'. This mirrors `tauriInvoke.on`, deliberately NOT by calling it — see above.
    unlisten = await listen<PopoverSurfacePayload>(IPC.evtPopoverPayload.replace(/\./g, ':'), (e) =>
      cb(e.payload),
    );
    if (cancelled) {
      // Torn down while `listen` was in flight: the handle exists NOW, so releasing it here
      // is what stops this from leaking a live backend listener nothing can remove.
      unlisten();
      unlisten = null;
      return;
    }
    try {
      await ready();
    } catch {
      // A refused handshake means the capability is misconfigured or Rust has no registry.
      // There is nothing useful to render, and throwing here would blank the whole webview —
      // so the surface simply stays empty until a `popover.set` reaches a live listener.
    }
  })();
  return () => {
    cancelled = true;
    // Null the handle after releasing it, so a second call cannot release it twice.
    if (unlisten) {
      const u = unlisten;
      unlisten = null;
      u();
    }
  };
}

/**
 * Report what the user picked.
 *
 * `index`/`action`/`value` are optional in the contract, and an absent key is genuinely
 * absent from the invoke arguments rather than sent as `undefined`: Tauri's command
 * argument resolver treats a missing `Option<T>` as `None`, and the test asserts the exact
 * wire shape with `toStrictEqual` (which, unlike `toEqual`, distinguishes `{}` from
 * `{ index: undefined }`).
 */
export async function picked(pick: PopoverPick): Promise<void> {
  await invoke('popover_picked', {
    id: pick.id,
    ...(pick.index === undefined ? {} : { index: pick.index }),
    ...(pick.action === undefined ? {} : { action: pick.action }),
    ...(pick.value === undefined ? {} : { value: pick.value }),
  });
}
