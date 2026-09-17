/* eslint-disable prettier/prettier */
/** Lightweight, dependency-free demand forecasting for Reorder Suggestions —
 *  Holt's linear exponential smoothing (level + trend) over a variant's
 *  daily sales, plus a day-of-week seasonality multiplier. This is a real,
 *  genuinely adaptive time-series technique (it responds to a rising/falling
 *  trend and to weekly patterns like "sells more on Fridays") — a real step
 *  up from a flat 30-day average — without needing a separate ML training
 *  pipeline/runtime (no Python/TensorFlow stack exists in this NestJS/Mongo
 *  backend, and none is warranted at this data scale).
 *
 *  Deliberately returns `null` (the caller falls back to the plain 30-day
 *  average, unchanged from before) whenever there isn't enough history to
 *  forecast responsibly — a new store/product with a handful of sales gets
 *  an honest simple average instead of a confident-looking but meaningless
 *  "smart" number. This is the hybrid design: every seller gets a real
 *  number regardless of how much data they have, and sellers with enough
 *  history get a genuinely smarter one. */

/** Needs at least this many distinct days with a sale... */
const MIN_SALE_DAYS = 10;
/** ...spread across at least this many calendar days, so weekly
 *  seasonality (6+ weeks) is actually meaningful rather than noise. */
const MIN_HISTORY_DAYS = 42;

const ALPHA = 0.3; // level smoothing
const BETA = 0.1; // trend smoothing

/**
 * @param dailyQty Map of 'YYYY-MM-DD' -> units sold that day, for one variant.
 *   Only needs to cover the lookback window the caller queried (e.g. 90 days) —
 *   a variant whose real sales history is longer than that window is fine;
 *   this only forecasts off what's provided.
 * @returns a forecasted average units-per-day figure for the near future, or
 *   `null` if there isn't enough history to forecast responsibly.
 */
export function forecastDailyDemand(dailyQty: Map<string, number>): number | null {
  if (dailyQty.size < MIN_SALE_DAYS) return null;

  const days = Array.from(dailyQty.keys()).sort();
  const first = new Date(`${days[0]}T00:00:00.000Z`);
  const today = new Date();
  const spanDays = Math.round((today.getTime() - first.getTime()) / 86_400_000);
  if (spanDays < MIN_HISTORY_DAYS) return null;

  // Build a dense daily series (0 for no-sale days) from first sale to today,
  // and day-of-week totals for the seasonality factor.
  const series: number[] = [];
  const dowTotals = [0, 0, 0, 0, 0, 0, 0];
  const dowCounts = [0, 0, 0, 0, 0, 0, 0];
  const cursor = new Date(first);
  while (cursor <= today) {
    const key = cursor.toISOString().slice(0, 10);
    const qty = dailyQty.get(key) ?? 0;
    series.push(qty);
    const dow = cursor.getUTCDay();
    dowTotals[dow] += qty;
    dowCounts[dow] += 1;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  if (series.length < 2) return null;

  // Holt's linear exponential smoothing: tracks a "level" and a "trend"
  // that update every day, so a sustained rise/fall in sales is reflected
  // in the forecast instead of being averaged away.
  let level = series[0];
  let trend = series[1] - series[0];
  for (let i = 1; i < series.length; i++) {
    const prevLevel = level;
    level = ALPHA * series[i] + (1 - ALPHA) * (level + trend);
    trend = BETA * (level - prevLevel) + (1 - BETA) * trend;
  }
  const baseForecast = Math.max(0, level + trend);

  // Day-of-week seasonality: scale today's forecast by how that weekday
  // historically compares to this variant's own overall daily average —
  // capped to [0.5x, 2x] so one sparse/noisy weekday can't wildly distort
  // the number.
  const overallAvg = series.reduce((a, b) => a + b, 0) / series.length;
  const todayDow = today.getUTCDay();
  const dowAvg = dowCounts[todayDow] > 0 ? dowTotals[todayDow] / dowCounts[todayDow] : overallAvg;
  const seasonalFactor = overallAvg > 0 ? Math.min(2, Math.max(0.5, dowAvg / overallAvg)) : 1;

  return Math.max(0, baseForecast * seasonalFactor);
}
