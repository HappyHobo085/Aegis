// src/lib/updateResult.ts
//
// The "Update all" button in the Filter Lists settings tab is a promise the user waits
// on. That promise is built from a ONE-SHOT event, and a one-shot event is a promise the
// core is under no obligation to ever fire.

import type { ListUpdateResult } from '../../shared/types';

/**
 * How long to wait for the core's `lists.updateResult` before declaring it lost.
 *
 * The core's pass is a background thread: every enabled list is fetched concurrently
 * with a 25 s per-request timeout, then the ad-block engine is reinstalled once. So a
 * healthy pass is bounded well under a minute and the generous margin is deliberate —
 * this bound exists to catch a pass that will NEVER report, not to enforce a deadline.
 * A slow machine gets its real result; only a dead thread hits this.
 */
export const UPDATE_RESULT_TIMEOUT_MS = 60_000;

/** The default timeout rejection — the filter-list wording, kept verbatim for `lists`. */
const LIST_TIMEOUT_MESSAGE =
  'The filter-list refresh never reported back. The core may have stopped ' +
  'mid-update; your lists are unchanged, so it is safe to try again.';

/**
 * Await the core's one-shot refresh result, settling on whichever of three things
 * happens first:
 *
 *  1. `lists.updateResult` fires  → resolve with the per-source result;
 *  2. the kick-off call itself rejects → reject with that reason (a transport failure
 *     means no refresh was ever started, so waiting out the timeout would be a lie);
 *  3. neither happens within `timeoutMs` → reject, so the caller can stop spinning.
 *
 * Why (3) exists: the refresh runs on a DETACHED thread in the core
 * (`subs::update_now` spawns one), and the result event is emitted as that thread's
 * LAST statement — after `reinstall_adblock`, which reloads the whole filter set. A
 * panic anywhere before the emit kills the thread, and a dead thread emits nothing.
 * A panic in a detached thread is not propagated anywhere: the caller already got
 * `Ok(Null)`, and the renderer would wait on an event that can never arrive. Before
 * this, the "Update all" button disabled itself and its `finally` never ran, so it
 * stayed disabled for the rest of the session with no way to retry and no message.
 *
 * `onResult` and `kick` are injected rather than imported so this is testable without
 * a mocked IPC surface — and so a test can pass a transport that never answers, which
 * is the whole failure being guarded.
 *
 * Generic over the result type, and the timeout message is a parameter, because the SAME
 * hand-off is now used by a second pair of channels: `data.export` / `data.import` are
 * also answered by a detached thread whose outcome arrives on a one-shot event
 * (`data.bulkDone`). Two copies of the settle-once bookkeeping would be two copies to
 * drift; `timeoutMessage` defaults to the filter-list wording, so the original caller and
 * its tests are unchanged.
 */
export function awaitUpdateResult<T = ListUpdateResult>(
  onResult: (cb: (r: T) => void) => () => void,
  kick: () => Promise<unknown>,
  timeoutMs: number,
  timeoutMessage = LIST_TIMEOUT_MESSAGE,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    // The unsubscribe handle and the timer handle are mutually referential: `finish`
    // needs the timer to clear it, and the timer's callback needs `finish`. They are
    // therefore properties of one mutable box rather than two `let` bindings — a `const`
    // for `off` would be in the temporal dead zone if a transport delivered the event
    // synchronously during registration, and `prefer-const` is right that each is
    // assigned exactly once.
    const io: { off?: () => void; timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      if (io.timer !== undefined) clearTimeout(io.timer);
      // Release the one-shot listener on EVERY path, including the timeout — otherwise
      // a lost refresh leaves a listener that will fire into nothing, forever.
      io.off?.();
      settle();
    };
    io.off = onResult((r) => finish(() => resolve(r)));
    io.timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
    void kick().catch((e: unknown) =>
      finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}
