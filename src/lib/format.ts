// src/lib/format.ts
// Display formatters shared by the history / saved / downloads lists.
//
// These are pure string helpers (no IPC, no React) so the panels stay presentational
// and the fiddly parts — "is this the same calendar day?", "is the timestamp in the
// future?", "1.2 kB or 1 KB?" — are unit-tested instead of eyeballed in a browser.
//
// Every function takes an explicit `now` (defaulting to `Date.now()`) so tests and
// any future snapshotting can pin the clock.

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The host of a URL, without a leading `www.` — the only part of a URL worth
 * spending a row's width on. Returns '' for anything we can't parse or that
 * isn't http(s) (about:blank, data:, the Android bridge's internal pages), so
 * callers can simply omit the meta line when it's empty.
 */
export function formatHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Calendar-day comparison in the viewer's local timezone. */
function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const clockTime = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * Compact, scannable timestamps.
 *
 *  - under a minute: "just now"
 *  - under an hour: "12 min ago"
 *  - same calendar day: "3 h ago"
 *  - yesterday: "Yesterday, 14:32"
 *  - within the last week: "Tue, 09:12"
 *  - this year: "12 Mar"      (older: "12 Mar 2024")
 *
 * A timestamp in the future (clock skew, or a machine whose clock moved) falls
 * back to the same absolute form rather than printing a negative "-4 min ago".
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp)) return '';
  const then = new Date(timestamp);
  const today = new Date(now);
  const diff = now - timestamp;

  if (diff >= 0 && diff < MINUTE) return 'just now';
  if (diff > 0 && diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff > 0 && isSameDay(then, today)) return `${Math.floor(diff / HOUR)} h ago`;

  // Future timestamps: no relative phrasing, just the absolute form.
  const dayDiff = Math.round((startOfDay(today) - startOfDay(then)) / DAY);
  if (dayDiff === 1) return `Yesterday, ${clockTime(then)}`;
  if (dayDiff > 1 && dayDiff < 7) {
    return `${then.toLocaleDateString(undefined, { weekday: 'short' })}, ${clockTime(then)}`;
  }
  const sameYear = then.getFullYear() === today.getFullYear();
  return then.toLocaleDateString(
    undefined,
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' },
  );
}

/** Buckets a timestamp for the history list's day-group headers. */
export type DayBucket = 'today' | 'yesterday' | 'week' | 'older';

export function dayBucket(timestamp: number, now: number = Date.now()): DayBucket {
  const dayDiff = Math.round((startOfDay(new Date(now)) - startOfDay(new Date(timestamp))) / DAY);
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'yesterday';
  if (dayDiff < 7) return 'week';
  return 'older';
}

const DAY_BUCKET_LABELS: Record<DayBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Earlier this week',
  older: 'Earlier',
};

export function dayBucketLabel(bucket: DayBucket): string {
  return DAY_BUCKET_LABELS[bucket];
}

/**
 * Groups entries (any order) into day buckets, newest first inside each group.
 * Group order is fixed (today → earlier) rather than derived from the data, so a
 * list can never render its groups out of order.
 */
export function groupByDay<T>(
  items: readonly T[],
  stamp: (item: T) => number,
  now: number = Date.now(),
): { bucket: DayBucket; label: string; items: T[] }[] {
  const order: DayBucket[] = ['today', 'yesterday', 'week', 'older'];
  const buckets = new Map<DayBucket, T[]>();
  for (const item of items) {
    const bucket = dayBucket(stamp(item), now);
    const list = buckets.get(bucket);
    if (list) list.push(item);
    else buckets.set(bucket, [item]);
  }
  return order
    .filter((bucket) => buckets.has(bucket))
    .map((bucket) => ({
      bucket,
      label: DAY_BUCKET_LABELS[bucket],
      items: buckets.get(bucket) ?? [],
    }));
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Human byte counts for the downloads list: "0 B", "512 B", "1.2 KB", "4.5 MB".
 * One decimal below 10, none above — "1.2 MB" reads better than "1.24 MB", and
 * "1,204 MB" is worse than "1.2 GB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(decimals)} ${UNITS[unit]}`;
}
