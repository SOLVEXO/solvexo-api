/* eslint-disable prettier/prettier */

/**
 * Solvexo's revenue model: every way Solvexo earns money, month by month, next to what merchants sold (GMV), so the
 * take rate (Solvexo revenue ÷ merchant sales) is visible. Pure functions; RevenueModelService feeds them USD rows.
 */

export const REVENUE_STREAMS = ['plans', 'transactionFees', 'commission', 'addons', 'posPlans', 'promotions'] as const;
export type RevenueStream = (typeof REVENUE_STREAMS)[number];
export const STREAM_LABEL: Record<RevenueStream, string> = {
  plans: 'Plan fees', transactionFees: 'Transaction fees', commission: 'Sales commission', addons: 'Add-ons', posPlans: 'POS plans', promotions: 'Paid promotions',
};
/** Earned on merchants' sales (scales with GMV) vs paid for the software (subscriptions and one-off purchases). */
export const TRANSACTIONAL: ReadonlySet<RevenueStream> = new Set(['transactionFees', 'commission']);

export interface MonthRow { month: string; amount: number }
export interface StoreRow { storeId: string; amount: number }

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 10000) / 100 : null);
export const monthOf = (d: Date | string | number) => new Date(d).toISOString().slice(0, 7);

export function monthKeys(n: number, now: number): string[] {
  const d = new Date(now);
  return Array.from({ length: n }, (_, i) => monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (n - 1) + i, 1)));
}

export interface RevenueMonth {
  month: string;
  streams: Record<RevenueStream, number>;
  total: number;
  subscription: number;
  transactional: number;
  gmv: number;
  orders: number;
  /** Solvexo revenue ÷ GMV, %. Null with no GMV. */
  takeRatePercent: number | null;
  /** (commission + transaction fees) ÷ GMV, %: what Solvexo keeps of each sale. */
  transactionalTakeRatePercent: number | null;
}

export function buildMonths(keys: string[], streams: Record<RevenueStream, MonthRow[]>, gmv: { month: string; gmv: number; orders: number }[]): RevenueMonth[] {
  const get = (rows: MonthRow[], m: string) => rows.filter((x) => x.month === m).reduce((s, x) => s + x.amount, 0);
  return keys.map((month) => {
    const s = Object.fromEntries(REVENUE_STREAMS.map((k) => [k, r2(get(streams[k] ?? [], month))])) as Record<RevenueStream, number>;
    const total = r2(REVENUE_STREAMS.reduce((sum, k) => sum + s[k], 0));
    const transactional = r2(REVENUE_STREAMS.filter((k) => TRANSACTIONAL.has(k)).reduce((sum, k) => sum + s[k], 0));
    const g = gmv.find((x) => x.month === month);
    const gmvUSD = r2(g?.gmv ?? 0);
    return {
      month, streams: s, total, transactional, subscription: r2(total - transactional), gmv: gmvUSD, orders: g?.orders ?? 0,
      takeRatePercent: pct(total, gmvUSD), transactionalTakeRatePercent: pct(transactional, gmvUSD),
    };
  });
}

export interface StreamSummary { stream: RevenueStream; label: string; total: number; sharePercent: number | null; lastMonth: number; previousMonth: number; changePercent: number | null }

/** Period totals per stream, their share of revenue, and last full month vs the one before. */
export function summarizeStreams(months: RevenueMonth[]): StreamSummary[] {
  const total = months.reduce((s, m) => s + m.total, 0);
  // The current month is partial: compare the last two FULL months.
  const last = months[months.length - 2], prev = months[months.length - 3];
  return REVENUE_STREAMS.map((stream) => {
    const t = r2(months.reduce((s, m) => s + m.streams[stream], 0));
    const l = last?.streams[stream] ?? 0, p = prev?.streams[stream] ?? 0;
    return { stream, label: STREAM_LABEL[stream], total: t, sharePercent: pct(t, total), lastMonth: l, previousMonth: p, changePercent: p > 0 ? pct(l - p, p) : null };
  }).sort((a, b) => b.total - a.total);
}

export interface Concentration { top: { storeId: string; amount: number; sharePercent: number | null }[]; top10SharePercent: number | null; payingStores: number }

/** Who Solvexo's revenue comes from: the biggest stores and how much of the total the top 10 make up. */
export function concentration(rows: StoreRow[], limit = 10): Concentration {
  const byStore = new Map<string, number>();
  for (const x of rows) if (x.storeId) byStore.set(String(x.storeId), (byStore.get(String(x.storeId)) ?? 0) + x.amount);
  const sorted = [...byStore].filter(([, a]) => a > 0).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, a]) => s + a, 0);
  const top = sorted.slice(0, limit).map(([storeId, a]) => ({ storeId, amount: r2(a), sharePercent: pct(a, total) }));
  return { top, top10SharePercent: pct(sorted.slice(0, 10).reduce((s, [, a]) => s + a, 0), total), payingStores: sorted.length };
}
