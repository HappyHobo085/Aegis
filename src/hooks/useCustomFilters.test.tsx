// src/hooks/useCustomFilters.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const get = vi.fn();
const set = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    customFilters: {
      get: (...a: any[]) => get(...a),
      set: (...a: any[]) => set(...a),
    },
  },
}));

import { useCustomFilters } from './useCustomFilters';

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue('||ads.example.com^');
  set.mockResolvedValue('||ads.example.com^');
});

describe('useCustomFilters', () => {
  it('seeds text from aegis.customFilters.get on mount', async () => {
    const { result } = renderHook(() => useCustomFilters());
    await waitFor(() => expect(result.current.text).toBe('||ads.example.com^'));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('starts with empty text before the get resolves', () => {
    const { result } = renderHook(() => useCustomFilters());
    expect(result.current.text).toBe('');
  });

  it('save() calls aegis.customFilters.set with the text and syncs the returned blob', async () => {
    set.mockResolvedValue('example.com##.ad-banner');
    const { result } = renderHook(() => useCustomFilters());
    await waitFor(() => expect(result.current.text).toBe('||ads.example.com^'));
    await act(async () => {
      await result.current.save('example.com##.ad-banner');
    });
    expect(set).toHaveBeenCalledWith('example.com##.ad-banner');
    expect(result.current.text).toBe('example.com##.ad-banner');
  });

  it('save() persists an empty string when the user clears the box', async () => {
    set.mockResolvedValue('');
    const { result } = renderHook(() => useCustomFilters());
    await waitFor(() => expect(result.current.text).toBe('||ads.example.com^'));
    await act(async () => {
      await result.current.save('');
    });
    expect(set).toHaveBeenCalledWith('');
    expect(result.current.text).toBe('');
  });
});
