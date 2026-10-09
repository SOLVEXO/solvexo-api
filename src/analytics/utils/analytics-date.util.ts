/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';

export type RangePreset = '7d' | '30d' | '90d' | '6m' | '12m' | 'custom';
export type BucketGranularity = 'day' | 'week' | 'month';

export interface ResolvedRange {
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
  granularity: BucketGranularity;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366 * 2; // 2 years
const GRANULARITIES: BucketGranularity[] = ['day', 'week', 'month'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// ─── Time zone helpers (Shopify reports in the STORE's time zone) ─────────────
// Pure Intl-based — no tz library. Every helper takes an IANA zone ("Asia/Karachi") and defaults to UTC.

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `instant` in `timeZone`. */
export function zonedParts(instant: Date, timeZone = 'UTC'): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`, in ms. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight on calendar day year-month-day in `timeZone` (DST-safe). */
export function zonedMidnight(year: number, month: number, day: number, timeZone = 'UTC'): Date {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  return new Date(second);
}

/** Start of the local day containing `instant`, shifted by `addDays` local days. */
export function zonedStartOfDay(instant: Date, timeZone = 'UTC', addDays = 0): Date {
  const p = zonedParts(instant, timeZone);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
  return zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), timeZone);
}

/** `YYYY-MM-DD` of `instant` in `timeZone` — same format `$dateToString` produces with that zone. */
export function localDateKey(instant: Date, timeZone = 'UTC'): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Mongo `$dateTrunc` for chart buckets, in the report's zone, Monday-start weeks (matches `enumerateBuckets`). */
export function bucketExpr(dateField: string, unit: BucketGranularity, timeZone = 'UTC') {
  return { $dateTrunc: { date: dateField, unit, timezone: timeZone, ...(unit === 'week' ? { startOfWeek: 'monday' } : {}) } };
}

/** Parses a custom-range boundary: a date-only string is a whole local calendar day; anything else is an exact instant. */
function parseBoundary(value: string, timeZone: string, end: boolean): Date {
  if (DATE_ONLY.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return end ? new Date(zonedMidnight(y, m, d + 1, timeZone).getTime() - 1) : zonedMidnight(y, m, d, timeZone);
  }
  return new Date(value);
}

/**
 * Resolves a `range` preset (or an explicit `from`/`to` custom range) into concrete boundaries in the report's time
 * zone, the immediately-preceding period of equal length (period-over-period comparisons), and the chart bucket
 * granularity — daily up to a month, weekly up to a quarter, monthly beyond (or `granularity` when given).
 *
 * Presets are whole local days ending now: "30d" = today plus the 29 days before it. A date-only custom range is
 * inclusive of both days (from 00:00 on `from` to 23:59:59.999 on `to`), so a single day (`from === to`) is valid.
 */
export function resolveDateRange(
  params: { range?: string; from?: string; to?: string; granularity?: string; compareTo?: string },
  timeZone = 'UTC',
): ResolvedRange {
  const { range, from, to } = params;

  let resolvedFrom: Date;
  let resolvedTo: Date;

  if (range === 'custom' || (!range && (from || to))) {
    if (!from || !to) {
      throw new BadRequestException('Custom range requires both "from" and "to"');
    }
    resolvedFrom = parseBoundary(from, timeZone, false);
    resolvedTo = parseBoundary(to, timeZone, true);
    if (isNaN(resolvedFrom.getTime()) || isNaN(resolvedTo.getTime())) {
      throw new BadRequestException('Invalid "from"/"to" date');
    }
    if (resolvedFrom >= resolvedTo) {
      throw new BadRequestException('"from" must be before "to"');
    }
  } else {
    const now = new Date();
    resolvedTo = now;
    const today = zonedParts(now, timeZone);
    const monthsBack = (n: number) => {
      const d = new Date(Date.UTC(today.year, today.month - 1 - n, today.day));
      return zonedMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), timeZone);
    };
    switch (range ?? '30d') {
      case '7d': resolvedFrom = zonedStartOfDay(now, timeZone, -6); break;
      case '30d': resolvedFrom = zonedStartOfDay(now, timeZone, -29); break;
      case '90d': resolvedFrom = zonedStartOfDay(now, timeZone, -89); break;
      case '6m': resolvedFrom = monthsBack(6); break;
      case '12m': resolvedFrom = monthsBack(12); break;
      default:
        throw new BadRequestException(`Unknown range "${range}"`);
    }
  }

  const spanMs = resolvedTo.getTime() - resolvedFrom.getTime();
  const spanDays = spanMs / MS_PER_DAY;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new BadRequestException(`Range cannot exceed ${MAX_RANGE_DAYS} days`);
  }

  // Shopify comparison periods: the period right before (default) or the same dates one year earlier.
  let previousFrom: Date;
  let previousTo: Date;
  if (params.compareTo === 'previous_year') {
    const yearBack = (d: Date) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() - 1); return x; };
    previousFrom = yearBack(resolvedFrom);
    previousTo = yearBack(resolvedTo);
  } else {
    previousTo = new Date(resolvedFrom.getTime());
    previousFrom = new Date(resolvedFrom.getTime() - spanMs);
  }

  const override = GRANULARITIES.find((g) => g === params.granularity);
  const granularity: BucketGranularity = override ?? (spanDays <= 31 ? 'day' : spanDays <= 90 ? 'week' : 'month');

  return { from: resolvedFrom, to: resolvedTo, previousFrom, previousTo, granularity };
}

/**
 * Stable cache-key part for a date range: the preset name (or the custom boundaries) — never the computed
 * millisecond timestamps, which change on every request and made the analytics cache miss every time.
 */
export function rangeCacheKey(params: { range?: string; from?: string; to?: string; granularity?: string; compareTo?: string }, timeZone = 'UTC'): string {
  const base = params.range && params.range !== 'custom' ? params.range : `${params.from ?? ''}~${params.to ?? ''}`;
  return `${base}|${params.granularity ?? 'auto'}|${params.compareTo ?? 'previous_period'}|${timeZone}`;
}

/** Percent change, current vs previous. Null (not Infinity/NaN) when previous was 0 — there's no meaningful "% change" from zero. */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

/** Absolute delta, current vs previous — matches the "+182 vs last period" style. */
export function absoluteChange(current: number, previous: number): number {
  return current - previous;
}

export type Trend = 'improving' | 'declining' | 'flat';

/** Flat within +/-0.5 percentage points — avoids noisy "improving"/"declining" flip-flops on tiny moves. */
export function trendFor(currentPercent: number, previousPercent: number): Trend {
  const delta = currentPercent - previousPercent;
  if (Math.abs(delta) < 0.5) return 'flat';
  return delta > 0 ? 'improving' : 'declining';
}

/** Local calendar day (UTC-noon anchor, for safe day arithmetic) of the bucket containing `instant`. */
function bucketDay(instant: Date, granularity: BucketGranularity, timeZone: string): Date {
  const p = zonedParts(instant, timeZone);
  if (granularity === 'month') return new Date(Date.UTC(p.year, p.month - 1, 1, 12));
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day, 12));
  if (granularity === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday-start weeks
  return d;
}

function stepDay(day: Date, granularity: BucketGranularity): Date {
  const next = new Date(day);
  if (granularity === 'day') next.setUTCDate(next.getUTCDate() + 1);
  else if (granularity === 'week') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

const dayToInstant = (day: Date, timeZone: string) => zonedMidnight(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), timeZone);

/** Every bucket start between from/to (local midnight in `timeZone`, as `bucketExpr` returns it) — zero-fills chart series so gaps don't disappear. */
export function enumerateBuckets(from: Date, to: Date, granularity: BucketGranularity, timeZone = 'UTC'): Date[] {
  const buckets: Date[] = [];
  let cursor = bucketDay(from, granularity, timeZone);
  const end = bucketDay(to, granularity, timeZone);
  while (cursor <= end) {
    buckets.push(dayToInstant(cursor, timeZone));
    cursor = stepDay(cursor, granularity);
  }
  return buckets;
}

/** The bucket start immediately after `bucket` — used to test whether a timestamp falls inside a specific bucket. */
export function nextBucket(bucket: Date, granularity: BucketGranularity, timeZone = 'UTC'): Date {
  return dayToInstant(stepDay(bucketDay(bucket, granularity, timeZone), granularity), timeZone);
}

/** Every local calendar day key (`YYYY-MM-DD`) from `from` to `to` inclusive. */
export function enumerateDayKeys(from: Date, to: Date, timeZone = 'UTC'): string[] {
  return enumerateBuckets(from, to, 'day', timeZone).map((d) => localDateKey(d, timeZone));
}
