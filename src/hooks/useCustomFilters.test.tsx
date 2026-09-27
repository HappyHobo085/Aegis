// src/hooks/useCustomFilters.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const get = vi.fn();
const set = vi.fn();
let pickedCb: ((p: { rule: string }) => void) | null = null;
const onPicked = vi.fn((cb: (p: { rule: string }) => void) => {
  pickedCb = cb;
  return () => undefined;
});

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    customFilters: {
      get: (...a: any[]) => get(...a),
      set: (...a: any[]) => set(...a),
    },
    picker: { onPicked: (cb: (p: { rule: string }) => void) => onPicked(cb) },
  },
}));

import { useCustomFilters } from './useCustomFilters';

beforeEach(() => {
  vi.clearAllMocks();
  pickedCb = null;
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

  // The element picker appends a rule to the SAME store this hook reads, and
  // `customfilters.rs` emits nothing of its own — `picker.picked` is the only signal
  // the core sends. Without this, a Settings > My Filters panel left open across a pick
  // kept showing the pre-pick text until the modal was reopened.
  it('refetches when the element picker appends a rule (picker.picked)', async () => {
    const { result } = renderHook(() => useCustomFilters());
    await waitFor(() => expect(result.current.text).toBe('||ads.example.com^'));
    expect(get).toHaveBeenCalledTimes(1);

    // The picker added a rule; the core now has a longer blob.
    get.mockResolvedValue('||ads.example.com^\nexample.com##.ad');
    await act(async () => {
      pickedCb?.({ rule: 'example.com##.ad' });
    });

    await waitFor(() => expect(result.current.text).toBe('||ads.example.com^\nexample.com##.ad'));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('unsubscribes from picker.picked on unmount', () => {
    const off = vi.fn();
    onPicked.mockReturnValueOnce(off);
    const { unmount } = renderHook(() => useCustomFilters());
    expect(onPicked).toHaveBeenCalledTimes(1);
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
