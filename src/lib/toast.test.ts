import { describe, it, expect, beforeEach, vi } from 'vitest';
import { toast, subscribeToasts, __resetToasts, type ToastItem } from './toast';

describe('toast actions', () => {
  beforeEach(() => __resetToasts());

  it('attaches an action to the toast', () => {
    let latest: ToastItem[] = [];
    const off = subscribeToasts((t) => {
      latest = t;
    });
    const onClick = vi.fn();
    toast.info('Blocked a redirect to evil.com', { action: { label: 'Open anyway', onClick } });
    expect(latest).toHaveLength(1);
    expect(latest[0].message).toContain('evil.com');
    expect(latest[0].action?.label).toBe('Open anyway');
    latest[0].action?.onClick();
    expect(onClick).toHaveBeenCalledOnce();
    off();
  });

  it('respects a custom duration', () => {
    vi.useFakeTimers();
    let latest: ToastItem[] = [];
    subscribeToasts((t) => {
      latest = t;
    });
    toast.info('x', { durationMs: 6000 });
    vi.advanceTimersByTime(4000);
    expect(latest).toHaveLength(1); // not yet dismissed at the old 4s default
    vi.advanceTimersByTime(2000);
    expect(latest).toHaveLength(0);
    vi.useRealTimers();
  });
});
