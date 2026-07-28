// src/hooks/useVaultAutofill.test.ts
// TDD: tests written first — mirror useVault.test.ts's structure.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { VaultRecord } from '../../shared/types';

// ---- mock ipcClient (vault namespace only) ----
const autofill = vi.fn();
const autofillSuggestions = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    vault: {
      autofill: (...a: unknown[]) => autofill(...a),
      autofillSuggestions: (...a: unknown[]) => autofillSuggestions(...a),
    },
  },
}));

import { useVaultAutofill } from './useVaultAutofill';

describe('useVaultAutofill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return autofill and autofillSuggestions functions', () => {
    const { result } = renderHook(() => useVaultAutofill());
    expect(typeof result.current.autofill).toBe('function');
    expect(typeof result.current.autofillSuggestions).toBe('function');
  });

  it('should call aegis.vault.autofill with correct arguments', async () => {
    const mockResult: VaultRecord[] = [
      { uuid: '1', updatedAt: 0, site: '', username: 'user1', password: 'pass1', notes: '' },
    ];
    autofill.mockResolvedValueOnce(mockResult);

    const { result } = renderHook(() => useVaultAutofill());
    const returnPromise = result.current.autofill({ domain: 'example.com', username: 'user1' });

    await waitFor(() =>
      expect(autofill).toHaveBeenCalledWith({ domain: 'example.com', username: 'user1' }),
    );
    const resultValue = await Promise.resolve(returnPromise);
    expect(resultValue).toEqual(mockResult);
  });

  it('should call aegis.vault.autofillSuggestions with correct arguments', async () => {
    const mockResult: VaultRecord[] = [
      { uuid: '1', updatedAt: 0, site: '', username: 'user1', password: 'pass1', notes: '' },
    ];
    autofillSuggestions.mockResolvedValueOnce(mockResult);

    const { result } = renderHook(() => useVaultAutofill());
    const returnPromise = result.current.autofillSuggestions('use');

    await waitFor(() => expect(autofillSuggestions).toHaveBeenCalledWith('use'));
    const resultValue = await Promise.resolve(returnPromise);
    expect(resultValue).toEqual(mockResult);
  });

  it('should handle errors from autofill', async () => {
    const errorMessage = 'vault is locked';
    autofill.mockRejectedValueOnce(new Error(errorMessage));

    const { result } = renderHook(() => useVaultAutofill());
    const returnPromise = result.current.autofill({ domain: 'example.com' });

    await expect(Promise.resolve(returnPromise)).rejects.toThrow(errorMessage);
  });

  it('should handle errors from autofillSuggestions', async () => {
    const errorMessage = 'vault is locked';
    autofillSuggestions.mockRejectedValueOnce(new Error(errorMessage));

    const { result } = renderHook(() => useVaultAutofill());
    const returnPromise = result.current.autofillSuggestions('test');

    await expect(Promise.resolve(returnPromise)).rejects.toThrow(errorMessage);
  });
});
