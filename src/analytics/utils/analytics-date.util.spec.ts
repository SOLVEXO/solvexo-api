/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import {
  absoluteChange,
  bucketExpr,
  enumerateBuckets,
  enumerateDayKeys,
  isValidTimeZone,
  localDateKey,
  nextBucket,
  percentChange,
  rangeCacheKey,
  resolveDateRange,
  trendFor,
  zonedMidnight,
  zonedParts,
} from './analytics-date.util';

describe('percentChange', () => {
  it('computes a normal percent increase', () => {
    expect(percentChange(150, 100)).toBe(50);
  });

  it('computes a normal percent decrease', () => {
    expect(percentChange(50, 100)).toBe(-50);
  });

  it('returns null when previous is 0 and current is non-zero (undefined % change)', () => {
    expect(percentChange(100, 0)).toBeNull();
  });

  it('returns 0 when both current and previous are 0', () => {
    expect(percentChange(0, 0)).toBe(0);
  });

  it('computes a full -100% drop when current falls to 0 from a positive previous value', () => {
    expect(percentChange(0, 100)).toBe(-100);
  });

  it('rounds to one decimal place', () => {
    expect(percentChange(133, 100)).toBe(33);
    expect(percentChange(101, 100)).toBe(1);
  });
});

describe('absoluteChange', () => {
  it('matches the "+182 vs last period" style — a plain delta, not a percent', () => {
    expect(absoluteChange(736, 554)).toBe(182);
  });

  it('handles a decrease as a negative delta', () => {
    expect(absoluteChange(50, 80)).toBe(-30);
  });
});

describe('trendFor', () => {
  it('reports improving when the metric rose meaningfully', () => {
    expect(trendFor(31, 25)).toBe('improving');
  });

  it('reports declining when the metric fell meaningfully', () => {
    expect(trendFor(20, 28)).toBe('declining');
  });

  it('reports flat for sub-threshold noise', () => {
    expect(trendFor(30.2, 30.0)).toBe('flat');
  });
});

describe('resolveDateRange — bucket granularity auto-selection', () => {
  it('selects daily buckets for a 7-day range', () => {
    const { granularity } = resolveDateRange({ range: '7d' });
    expect(granularity).toBe('day');
  });

  it('selects daily buckets for a 30-day range (boundary at 31 days)', () => {
    const { granularity } = resolveDateRange({ range: '30d' });
    expect(granularity).toBe('day');
  });

  it('selects weekly buckets for a 90-day range', () => {
    const { granularity } = resolveDateRange({ range: '90d' });
    expect(granularity).toBe('week');
  });

  it('selects monthly buckets for a 6-month range', () => {
    const { granularity } = resolveDateRange({ range: '6m' });
    expect(granularity).toBe('month');
  });

  it('selects monthly buckets for a 12-month range', () => {
    const { granularity } = resolveDateRange({ range: '12m' });
    expect(granularity).toBe('month');
  });

  it('auto-selects granularity for a custom range the same way as a preset of equal length', () => {
    const { granularity } = resolveDateRange({ range: 'custom', from: '2026-01-01', to: '2026-01-15' });
    expect(granularity).toBe('day');
  });
});

describe('resolveDateRange — previous period', () => {
  it('computes an immediately-preceding period of equal length', () => {
    const { from, to, previousFrom, previousTo } = resolveDateRange({
      range: 'custom',
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-02-11T00:00:00.000Z',
    });
    const spanMs = to.getTime() - from.getTime();
    expect(previousTo.getTime()).toBe(from.getTime());
    expect(from.getTime() - previousFrom.getTime()).toBe(spanMs);
  });
});

describe('resolveDateRange — validation', () => {
  it('rejects a custom range missing "to"', () => {
    expect(() => resolveDateRange({ range: 'custom', from: '2026-01-01' })).toThrow(BadRequestException);
  });

  it('rejects a custom range missing "from"', () => {
    expect(() => resolveDateRange({ range: 'custom', to: '2026-01-01' })).toThrow(BadRequestException);
  });

  it('rejects from >= to', () => {
    expect(() =>
      resolveDateRange({ range: 'custom', from: '2026-02-01', to: '2026-01-01' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a range spanning more than 2 years', () => {
    expect(() =>
      resolveDateRange({ range: 'custom', from: '2020-01-01', to: '2026-01-01' }),
    ).toThrow(BadRequestException);
  });

  it('rejects an unknown range preset', () => {
    expect(() => resolveDateRange({ range: 'decade' })).toThrow(BadRequestException);
  });
});

describe('enumerateBuckets', () => {
  it('zero-fills every day between from/to inclusive of both ends', () => {
    const buckets = enumerateBuckets(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-04T00:00:00Z'), 'day');
    expect(buckets).toHaveLength(4);
  });

  it('produces monotonically increasing monthly buckets', () => {
    const buckets = enumerateBuckets(new Date('2026-01-15T00:00:00Z'), new Date('2026-04-01T00:00:00Z'), 'month');
    expect(buckets.map((b) => b.getUTCMonth())).toEqual([0, 1, 2, 3]);
  });
});

describe('store time zone (Shopify reports in the store time zone)', () => {
  it('a date-only custom range covers BOTH whole days, and a single day is valid', () => {
    const r = resolveDateRange({ range: 'custom', from: '2026-03-10', to: '2026-03-10' }, 'Asia/Karachi');
    // Karachi is UTC+5: local 00:00 = 19:00Z the day before.
    expect(r.from.toISOString()).toBe('2026-03-09T19:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-03-10T18:59:59.999Z');
  });

  it('REGRESSION: the last day of a custom range is no longer dropped (UTC)', () => {
    const r = resolveDateRange({ range: 'custom', from: '2026-01-01', to: '2026-01-15' });
    expect(r.to.toISOString()).toBe('2026-01-15T23:59:59.999Z');
  });

  it('presets start at local midnight', () => {
    const r = resolveDateRange({ range: '7d' }, 'Asia/Karachi');
    expect(zonedParts(r.from, 'Asia/Karachi')).toMatchObject({ hour: 0, minute: 0, second: 0 });
  });

  it('zonedMidnight is DST-safe (New York, spring-forward day)', () => {
    expect(zonedMidnight(2026, 3, 8, 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(zonedMidnight(2026, 3, 9, 'America/New_York').toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('day buckets are local midnights in the store zone', () => {
    const b = enumerateBuckets(new Date('2026-03-09T19:00:00Z'), new Date('2026-03-11T18:00:00Z'), 'day', 'Asia/Karachi');
    expect(b.map((d) => d.toISOString())).toEqual(['2026-03-09T19:00:00.000Z', '2026-03-10T19:00:00.000Z', '2026-03-11T19:00:00.000Z'].slice(0, b.length));
    expect(b).toHaveLength(2);
  });

  it('week buckets start on Monday (same as bucketExpr startOfWeek monday)', () => {
    const b = enumerateBuckets(new Date('2026-01-07T12:00:00Z'), new Date('2026-01-20T12:00:00Z'), 'week');
    expect(b.map((d) => d.getUTCDay())).toEqual([1, 1, 1]);
    expect(bucketExpr('$createdAt', 'week', 'UTC').$dateTrunc).toMatchObject({ startOfWeek: 'monday' });
    expect(bucketExpr('$createdAt', 'day', 'UTC').$dateTrunc).not.toHaveProperty('startOfWeek');
  });

  it('nextBucket steps one local period', () => {
    expect(nextBucket(new Date('2026-03-09T19:00:00Z'), 'day', 'Asia/Karachi').toISOString()).toBe('2026-03-10T19:00:00.000Z');
  });

  it('localDateKey and enumerateDayKeys follow the store zone', () => {
    expect(localDateKey(new Date('2026-03-09T20:00:00Z'), 'Asia/Karachi')).toBe('2026-03-10');
    expect(enumerateDayKeys(new Date('2026-03-09T19:00:00Z'), new Date('2026-03-11T18:59:59Z'), 'Asia/Karachi')).toEqual(['2026-03-10', '2026-03-11']);
  });

  it('validates IANA zones', () => {
    expect(isValidTimeZone('Asia/Karachi')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('honours an explicit granularity override', () => {
    expect(resolveDateRange({ range: '7d', granularity: 'month' }).granularity).toBe('month');
    expect(resolveDateRange({ range: '7d', granularity: 'year' }).granularity).toBe('day');
  });

  it('REGRESSION: the cache key is stable for a preset (no millisecond timestamps)', () => {
    expect(rangeCacheKey({ range: '30d' }, 'Asia/Karachi')).toBe(rangeCacheKey({ range: '30d' }, 'Asia/Karachi'));
    expect(rangeCacheKey({ range: '30d' }, 'UTC')).not.toBe(rangeCacheKey({ range: '30d' }, 'Asia/Karachi'));
    expect(rangeCacheKey({ range: 'custom', from: '2026-01-01', to: '2026-01-02' })).toContain('2026-01-01~2026-01-02');
  });
});
