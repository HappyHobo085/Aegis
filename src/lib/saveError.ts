// src/lib/saveError.ts
//
// The settings-shaped save paths (Home URL, custom filters, search engines) all have
// the same failure mode: the core REFUSES the write, and the component is left looking
// like nothing happened. Every one of them swallowed that, so a user who hit a
// validator rejection (there are ~20 in `settings.rs::validate_setting` alone) saw a
// button that did nothing at all.

/**
 * Turn a rejected save into a sentence for the user.
 *
 * The rejection value is whatever crossed the IPC boundary, and the common case is a
 * bare STRING, not an `Error`: `lib/tauriInvoke.call` is a bare `invoke`, and a Rust
 * `Err(String)` rejects with that string. So the `err instanceof Error` test — the shape
 * almost every codebase reaches for first — is false for every real refusal and would
 * silently discard the core's reason in favour of the generic fallback. Read the string
 * case first.
 *
 * The core's own messages are already written for a human ("searchEngines may hold at
 * most 32 entries", 'homeUrl must be http(s), got "file"'), so passing them through is
 * the honest copy; the fallback exists only for a rejection that carries no text.
 */
export function saveErrorText(err: unknown): string {
  if (typeof err === 'string' && err.trim().length > 0) return err;
  if (err instanceof Error && err.message.trim().length > 0) return err.message;
  return 'The change was not saved.';
}
