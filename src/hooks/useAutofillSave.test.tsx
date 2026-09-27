// src/hooks/useAutofillSave.test.tsx
//
// The "Save password?" prompt driver. Note this hook is currently UNMOUNTED in the
// renderer (the chrome-side autofill chain was deleted as dead code; see
// src/AGENTS.md) — it is tested because `form.willSubmit`/`vault_inject.js` are real
// and this is the natural seam to finish the feature against.
//
// The security-relevant contracts:
//   - plaintext credentials live only in transient state, never in storage, and
//   - pending state is cleared on BOTH save and dismiss, including when the save fails.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { FormWillSubmit } from '../../shared/types';

const getState = vi.fn();
const autofillSuggestions = vi.fn();
const vaultAdd = vi.fn();
const onWillSubmit = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    form: { onWillSubmit: (...a: any[]) => onWillSubmit(...a) },
    vault: {
      getState: (...a: any[]) => getState(...a),
      autofillSuggestions: (...a: any[]) => autofillSuggestions(...a),
      add: (...a: any[]) => vaultAdd(...a),
    },
  },
}));

import { useAutofillSave } from './useAutofillSave';

const cred = (over: Partial<FormWillSubmit> = {}): FormWillSubmit =>
  ({
    domain: 'example.com',
    username: 'alice@example.com',
    password: 'hunter2',
    ...over,
  }) as FormWillSubmit;

const record = (over: Partial<{ username: string; password: string }> = {}) => ({
  site: 'https://example.com',
  username: 'alice@example.com',
  password: 'hunter2',
  ...over,
});

/** The registered `form.willSubmit` listener. */
const emit = (c: FormWillSubmit) =>
  act(async () => {
    (onWillSubmit.mock.calls[0][0] as (c: FormWillSubmit) => void)(c);
  });

beforeEach(() => {
  getState.mockReset().mockResolvedValue({ unlocked: true });
  autofillSuggestions.mockReset().mockResolvedValue([]);
  vaultAdd.mockReset().mockResolvedValue({});
  onWillSubmit.mockReset();
  onWillSubmit.mockReturnValue(() => {});
});

describe('useAutofillSave', () => {
  it('subscribes to form.willSubmit on mount', () => {
    renderHook(() => useAutofillSave());
    expect(onWillSubmit).toHaveBeenCalledTimes(1);
  });

  it('starts idle', () => {
    const { result } = renderHook(() => useAutofillSave());
    expect(result.current.pending).toBeNull();
    expect(result.current.alreadySaved).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const off = vi.fn();
    onWillSubmit.mockReturnValue(off);
    const { unmount } = renderHook(() => useAutofillSave());
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('holds a submitted credential as pending when the vault is unlocked', async () => {
    const { result } = renderHook(() => useAutofillSave());
    await emit(cred());
    await waitFor(() => expect(result.current.pending?.username).toBe('alice@example.com'));
  });

  // A locked vault cannot save, so prompting would be a dead end.
  it('drops the credential when the vault is locked', async () => {
    getState.mockResolvedValue({ unlocked: false });
    const { result } = renderHook(() => useAutofillSave());
    await emit(cred());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    expect(result.current.pending).toBeNull();
  });

  it('queries suggestions for the submitted DOMAIN', async () => {
    const { result } = renderHook(() => useAutofillSave());
    await emit(cred({ domain: 'shop.test' }));
    await waitFor(() => expect(autofillSuggestions).toHaveBeenCalledWith('shop.test'));
    await waitFor(() => expect(result.current.alreadySaved).toBe(false));
  });

  describe('alreadySaved detection', () => {
    it('is true when username AND password both match', async () => {
      autofillSuggestions.mockResolvedValue([record()]);
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.alreadySaved).toBe(true));
    });

    it('compares the username case-insensitively', async () => {
      autofillSuggestions.mockResolvedValue([record({ username: 'ALICE@EXAMPLE.COM' })]);
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.alreadySaved).toBe(true));
    });

    it('is false when only the username matches', async () => {
      autofillSuggestions.mockResolvedValue([record({ password: 'different' })]);
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(autofillSuggestions).toHaveBeenCalled());
      expect(result.current.alreadySaved).toBe(false);
    });

    it('is false when only the password matches', async () => {
      autofillSuggestions.mockResolvedValue([record({ username: 'bob@example.com' })]);
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(autofillSuggestions).toHaveBeenCalled());
      expect(result.current.alreadySaved).toBe(false);
    });

    // A locked/erroring vault must not suppress the prompt: the user can unlock and
    // then save, which is strictly better than silently dropping the credential.
    it('falls back to "not saved" when the suggestion query fails', async () => {
      autofillSuggestions.mockRejectedValue(new Error('vault is locked'));
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(autofillSuggestions).toHaveBeenCalled());
      expect(result.current.alreadySaved).toBe(false);
      expect(result.current.pending).not.toBeNull();
    });
  });

  describe('save', () => {
    it('adds the credential to the vault as an https URL', async () => {
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => {
        await result.current.save();
      });
      expect(vaultAdd).toHaveBeenCalledWith({
        site: 'https://example.com',
        username: 'alice@example.com',
        password: 'hunter2',
      });
    });

    it('clears pending + alreadySaved on success', async () => {
      autofillSuggestions.mockResolvedValue([record()]);
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.alreadySaved).toBe(true));
      await act(async () => {
        await result.current.save();
      });
      expect(result.current.pending).toBeNull();
      expect(result.current.alreadySaved).toBe(false);
    });

    // The dialog must close even when the write fails — a stuck modal over a failed
    // save is worse than a lost save the user can retry from the vault.
    it('clears pending even when vault.add rejects', async () => {
      vaultAdd.mockRejectedValue(new Error('disk full'));
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => {
        await result.current.save();
      });
      expect(result.current.pending).toBeNull();
      expect(result.current.alreadySaved).toBe(false);
    });

    it('save with nothing pending is a no-op, not a crash', async () => {
      const { result } = renderHook(() => useAutofillSave());
      await act(async () => {
        await result.current.save();
      });
      expect(vaultAdd).not.toHaveBeenCalled();
    });

    it('a second save after a first cannot double-write', async () => {
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      await act(async () => {
        await result.current.save();
      });
      await act(async () => {
        await result.current.save();
      });
      expect(vaultAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe('dismiss', () => {
    it('clears pending without touching the vault', async () => {
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      act(() => result.current.dismiss());
      expect(result.current.pending).toBeNull();
      expect(vaultAdd).not.toHaveBeenCalled();
    });

    it('clears alreadySaved too', async () => {
      autofillSuggestions.mockResolvedValue([record()]);
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.alreadySaved).toBe(true));
      act(() => result.current.dismiss());
      expect(result.current.alreadySaved).toBe(false);
    });

    it('a dismissed credential is NOT saveable afterwards', async () => {
      const { result } = renderHook(() => useAutofillSave());
      await emit(cred());
      await waitFor(() => expect(result.current.pending).not.toBeNull());
      act(() => result.current.dismiss());
      await act(async () => {
        await result.current.save();
      });
      expect(vaultAdd).not.toHaveBeenCalled();
    });
  });

  // SECURITY: a password must not be recoverable from anything the renderer persists.
  it('never writes the credential to any web storage', async () => {
    const { result } = renderHook(() => useAutofillSave());
    await emit(cred());
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    for (const store of [localStorage, sessionStorage]) {
      const dump = JSON.stringify({ ...store });
      expect(dump).not.toContain('hunter2');
      expect(dump).not.toContain('alice@example.com');
    }
    expect(document.cookie).not.toContain('hunter2');
  });
});
