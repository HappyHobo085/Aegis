// src/lib/format.test.ts
import { describe, expect, it } from 'vitest';
import {
  dayBucket,
  dayBucketLabel,
  formatBytes,
  formatHost,
  formatRelativeTime,
  groupByDay,
} from './format';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

// A fixed local reference point so the assertions can't drift with the wall clock.
const NOW = new Date(2026, 2, 12, 15, 30, 0).getTime(); // Thu 12 Mar 2026, 15:30 local
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m, d, h, min, 0, 0).getTime();

describe('formatHost', () => {
  it('returns the hostname without a leading www.', () => {
    expect(formatHost('https://www.example.com/a/b?c=d')).toBe('example.com');
    expect(formatHost('http://example.com')).toBe('example.com');
  });

  it('keeps subdomains and ports that matter', () => {
    expect(formatHost('https://docs.example.com/x')).toBe('docs.example.com');
  });

  it('returns an empty string for non-web and unparseable URLs', () => {
    expect(formatHost('about:blank')).toBe('');
    expect(formatHost('data:text/html,hi')).toBe('');
    expect(formatHost('not a url')).toBe('');
  });
});

describe('formatRelativeTime', () => {
  it('collapses sub-minute ages to "just now"', () => {
    expect(formatRelativeTime(NOW - 0, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('just now');
  });

  it('uses minutes under an hour', () => {
    expect(formatRelativeTime(NOW - 1 * MINUTE, NOW)).toBe('1 min ago');
    expect(formatRelativeTime(NOW - 59 * MINUTE, NOW)).toBe('59 min ago');
  });

  it('uses hours within the same calendar day', () => {
    expect(formatRelativeTime(NOW - 2 * HOUR, NOW)).toBe('2 h ago');
  });

  it('switches to an absolute form across midnight', () => {
    expect(formatRelativeTime(at(2026, 2, 11, 22, 5), NOW)).toBe('Yesterday, 22:05');
  });

  it('uses a weekday inside the last week', () => {
    // Tue 10 Mar 2026.
    const text = formatRelativeTime(at(2026, 2, 10, 9, 12), NOW);
    expect(text).toMatch(/^Tue, 09:12$/);
  });

  it('uses a short date for the same year and adds the year when older', () => {
    // 15 Jan 2026 — same year as NOW, but more than a week back.
    expect(formatRelativeTime(at(2026, 0, 15, 9, 0), NOW)).not.toMatch(/2026/);
    expect(formatRelativeTime(at(2024, 2, 3, 9, 0), NOW)).toMatch(/2024/);
  });

  it('never prints a negative age for a future timestamp', () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, NOW)).not.toMatch(/-/);
  });

  it('returns an empty string for a non-finite timestamp', () => {
    expect(formatRelativeTime(Number.NaN, NOW)).toBe('');
  });
});

describe('dayBucket / dayBucketLabel', () => {
  it('assigns the four buckets by calendar distance', () => {
    expect(dayBucket(NOW, NOW)).toBe('today');
    expect(dayBucket(at(2026, 2, 11, 23, 59), NOW)).toBe('yesterday');
    expect(dayBucket(at(2026, 2, 10), NOW)).toBe('week');
    expect(dayBucket(at(2025, 0, 1), NOW)).toBe('older');
  });

  it('labels every bucket', () => {
    expect(dayBucketLabel('today')).toBe('Today');
    expect(dayBucketLabel('yesterday')).toBe('Yesterday');
    expect(dayBucketLabel('week')).toBeTruthy();
    expect(dayBucketLabel('older')).toBeTruthy();
  });
});

describe('groupByDay', () => {
  it('keeps a fixed group order regardless of input order', () => {
    const items = [
      { id: 1, at: at(2024, 1, 1) },
      { id: 2, at: NOW },
      { id: 3, at: at(2026, 2, 11, 8, 0) },
      { id: 4, at: at(2026, 2, 10) },
    ];
    const groups = groupByDay(items, (i) => i.at, NOW);
    expect(groups.map((g) => g.bucket)).toEqual(['today', 'yesterday', 'week', 'older']);
    expect(groups.flatMap((g) => g.items.map((i) => i.id))).toEqual([2, 3, 4, 1]);
  });

  it('omits empty buckets', () => {
    const groups = groupByDay([{ at: NOW }], (i) => i.at, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Today');
  });

  it('returns nothing for an empty list', () => {
    expect(groupByDay([], (i: { at: number }) => i.at, NOW)).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('formats each unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(4.5 * 1024 * 1024)).toBe('4.5 MB');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
  });

  it('drops the decimal above 10', () => {
    expect(formatBytes(20 * 1024)).toBe('20 KB');
  });

  it('treats negative and non-finite sizes as zero', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});
