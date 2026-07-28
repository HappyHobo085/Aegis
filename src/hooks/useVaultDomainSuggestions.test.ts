// src/hooks/useVaultDomainSuggestions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { VaultRecord } from '../../shared/types';

// Mock useVaultAutofill hook
const autofillMock = vi.fn();
vi.mock('./useVaultAutofill', () => ({
  useVaultAutofill: () => ({
    autofill: (...args: unknown[]) => autofillMock(...args),
    autofillSuggestions: (...args: unknown[]) => [],
  }),
}));

// Mock useNav hook
const useNavMock = vi.fn();
vi.mock('./useNav', () => ({
  useNav: (vId: number) => {
    return useNavMock(vId);
  },
  PRIMARY_VIEW_ID: 1,
}));

// Mock useLoginFormDetector hook
const useLoginFormDetectorMock = vi.fn();
vi.mock('./useLoginFormDetector', () => ({
  useLoginFormDetector: () => {
    return useLoginFormDetectorMock();
  },
}));

import { useVaultDomainSuggestions } from './useVaultDomainSuggestions';

describe('useVaultDomainSuggestions', () => {
  const mockNavState = {
    url: 'https://example.com/somepage',
    title: 'Example',
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    crashed: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Set up the mock for useNav to return a fixed state
    useNavMock.mockReturnValue({ state: mockNavState });
    // Reset autofill mock
    autofillMock.mockReset();
    // Set up the mock for useLoginFormDetector
    useLoginFormDetectorMock.mockReturnValue({
      isChecking: false,
      hasLoginForm: true,
      loginFormDomain: 'https://example.com',
      checkForLoginForm: vi.fn(),
    });
  });

  it('should return initial state with empty suggestions, not loading, no error', async () => {
    // Default implementation - return empty array
    autofillMock.mockResolvedValue([]);

    const { result } = renderHook(() => useVaultDomainSuggestions());
    // Wait for initial loading state to complete
    await waitFor(() => result.current.loading === false);

    // Should have called autofill with the domain from the URL
    expect(autofillMock).toHaveBeenCalledWith({ domain: 'https://example.com', username: '' });
    // Should have empty suggestions (from our mock)
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.refetch).toBe('function');
  });

  it('should fetch suggestions when the URL changes', async () => {
    const mockResult: VaultRecord[] = [
      {
        uuid: '1',
        username: 'user1',
        password: 'pass1',
        updatedAt: 0,
        site: 'https://example.com',
        notes: '',
      },
    ];
    // Set up mock to return specific data
    autofillMock.mockResolvedValueOnce(mockResult);

    const { result } = renderHook(() => useVaultDomainSuggestions());
    // Wait for loading to complete (this ensures data has been set)
    await waitFor(() => result.current.loading === false);
    // Additional wait to ensure state is updated
    await waitFor(() => result.current.suggestions.length > 0);

    expect(autofillMock).toHaveBeenCalledWith({ domain: 'https://example.com', username: '' });
    expect(result.current.suggestions).toEqual(mockResult);
  });

  it('should handle empty URL', async () => {
    // Set navState to have empty URL
    useNavMock.mockReturnValue({ state: { ...mockNavState, url: '' } });
    // When URL is empty, simulate that no login form is detected
    useLoginFormDetectorMock.mockReturnValue({
      isChecking: false,
      hasLoginForm: false,
      loginFormDomain: null,
      checkForLoginForm: vi.fn(),
    });

    const { result } = renderHook(() => useVaultDomainSuggestions());
    await waitFor(() => result.current.loading === false);

    expect(autofillMock).not.toHaveBeenCalled();
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should handle errors during fetch', async () => {
    const errorMessage = 'vault is locked';
    autofillMock.mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => useVaultDomainSuggestions());
    // Wait for the error state directly — more robust than waiting for
    // loading=false then checking error, which is timing-sensitive under
    // React StrictMode (the double-effect-run can interleave setError(null)
    // from the second mount with the first mount's rejection).
    await waitFor(() => expect(result.current.error).toBe(errorMessage));

    expect(autofillMock).toHaveBeenCalledWith({ domain: 'https://example.com', username: '' });
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('should refetch when refetch is called', async () => {
    const firstResult: VaultRecord[] = [
      {
        uuid: '1',
        username: 'user1',
        password: 'pass1',
        updatedAt: 0,
        site: 'https://example.com',
        notes: '',
      },
    ];
    const secondResult: VaultRecord[] = [
      {
        uuid: '1',
        username: 'user1',
        password: 'pass1',
        updatedAt: 0,
        site: 'https://example.com',
        notes: '',
      },
      {
        uuid: '2',
        username: 'user2',
        password: 'pass2',
        updatedAt: 0,
        site: 'https://example.com/admin',
        notes: '',
      },
    ];

    // Set up sequential mock implementations
    autofillMock.mockResolvedValueOnce(firstResult).mockResolvedValueOnce(secondResult);

    const { result } = renderHook(() => useVaultDomainSuggestions());

    // Wait for initial fetch to complete
    await waitFor(() => result.current.loading === false);
    await waitFor(() => result.current.suggestions.length > 0);
    expect(result.current.suggestions).toEqual(firstResult);
    expect(autofillMock).toHaveBeenCalledTimes(1);

    // Call refetch
    act(() => {
      result.current.refetch();
    });

    // Wait for refetch to complete
    await waitFor(() => result.current.loading === false);
    await waitFor(() => result.current.suggestions.length > 1); // Should have more items now
    expect(result.current.suggestions).toEqual(secondResult);
    expect(autofillMock).toHaveBeenCalledTimes(2);
  });
});
