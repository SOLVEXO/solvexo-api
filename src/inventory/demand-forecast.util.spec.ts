/* eslint-disable prettier/prettier */
import { forecastDailyDemand } from './demand-forecast.util';

/** 'YYYY-MM-DD' for `daysAgo` days before today (UTC) — every test builds its
 *  series relative to "now" since the util itself measures history length
 *  off the real current date, not a fixed reference point. */
function dateKey(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

describe('forecastDailyDemand', () => {
  it('returns null for an empty series', () => {
    expect(forecastDailyDemand(new Map())).toBeNull();
  });

  it('returns null when there are fewer than 10 distinct sale-days, even if very recent', () => {
    const series = new Map<string, number>();
    for (let i = 0; i < 5; i++) series.set(dateKey(i), 3);
    expect(forecastDailyDemand(series)).toBeNull();
  });

  it('returns null when there are enough sale-days but they span fewer than 42 calendar days', () => {
    // 15 distinct sale-days, all crammed into the last 20 days — enough
    // volume, not enough calendar spread for a weekly-seasonality read.
    const series = new Map<string, number>();
    for (let i = 0; i < 15; i++) series.set(dateKey(i), 4);
    expect(forecastDailyDemand(series)).toBeNull();
  });

  it('forecasts a real number once both thresholds (10+ sale-days, 42+ day span) are met', () => {
    const series = new Map<string, number>();
    // A sale every 3rd day for 60 days back — 20 sale-days, 60-day span.
    for (let i = 0; i <= 60; i += 3) series.set(dateKey(i), 5);
    const forecast = forecastDailyDemand(series);
    expect(forecast).not.toBeNull();
    expect(forecast!).toBeGreaterThan(0);
  });

  it('reflects a genuine upward trend — a series ramping up forecasts higher than its own early average', () => {
    const series = new Map<string, number>();
    // 63 days of daily sales, linearly ramping from 1 unit/day to ~64 units/day.
    for (let i = 0; i <= 63; i++) series.set(dateKey(63 - i), i + 1);
    const forecast = forecastDailyDemand(series)!;
    const earlyAverage = 10; // the first ~20 days' worth, roughly
    expect(forecast).toBeGreaterThan(earlyAverage);
  });

  it('reflects a genuine downward trend — a series ramping down forecasts below its own early average', () => {
    const series = new Map<string, number>();
    for (let i = 0; i <= 63; i++) series.set(dateKey(63 - i), 64 - i);
    const forecast = forecastDailyDemand(series)!;
    const earlyAverage = 55; // the first ~10 days were all in the high 50s/60s
    expect(forecast).toBeLessThan(earlyAverage);
  });

  it('never returns a negative forecast even for a series trending toward zero', () => {
    const series = new Map<string, number>();
    for (let i = 0; i <= 50; i++) series.set(dateKey(50 - i), Math.max(0, 20 - i));
    const forecast = forecastDailyDemand(series)!;
    expect(forecast).toBeGreaterThanOrEqual(0);
  });

  it('a flat, stable series forecasts close to that flat value', () => {
    const series = new Map<string, number>();
    for (let i = 0; i <= 60; i++) series.set(dateKey(i), 10);
    const forecast = forecastDailyDemand(series)!;
    expect(forecast).toBeGreaterThan(8);
    expect(forecast).toBeLessThan(12);
  });
});
