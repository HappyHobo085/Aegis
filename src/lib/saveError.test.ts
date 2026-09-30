// src/lib/saveError.test.ts
import { describe, it, expect } from 'vitest';
import { saveErrorText } from './saveError';

describe('saveErrorText', () => {
  it('passes the core’s own sentence through unchanged', () => {
    // A Rust `Err(String)` rejects the IPC call with a bare string, and the core
    // writes those for a human. Returning it verbatim is the honest copy; a
    // generic message here would throw away the only useful part of the refusal.
    expect(saveErrorText('homeUrl must be http(s), got "file"')).toBe(
      'homeUrl must be http(s), got "file"',
    );
  });

  it('reads the message out of a real Error', () => {
    expect(saveErrorText(new Error('searchEngines may hold at most 32 entries'))).toBe(
      'searchEngines may hold at most 32 entries',
    );
  });

  it('falls back to a sentence for a rejection that carries no text', () => {
    // The branch nothing reaches on the real IPC path, and the reason the
    // function exists at all: a user must never see a silent no-op.
    expect(saveErrorText(undefined)).toBe('The change was not saved.');
    expect(saveErrorText(null)).toBe('The change was not saved.');
    expect(saveErrorText({ code: 500 })).toBe('The change was not saved.');
  });

  it('does not treat a blank reason as a reason', () => {
    // An empty or whitespace-only string is a refusal with nothing to show. The
    // core never sends one, but `''` satisfies `trim().length > 0` unless the
    // check is a length check — and an empty error toast is worse than the
    // generic sentence, because the user is told the save failed and given no
    // reason at all.
    expect(saveErrorText('')).toBe('The change was not saved.');
    expect(saveErrorText('   ')).toBe('The change was not saved.');
    expect(saveErrorText(new Error('   '))).toBe('The change was not saved.');
  });
});
