/* eslint-disable prettier/prettier */
/**
 * Financial statements (Accounting Plan, Phase 3), PURE: profit & loss and balance sheet from per-account movement, and the sales tax
 * summary. No database access here; the service aggregates the journal and hands the rows in.
 */
import type { AccountType } from './chart.const';
import type { Channel } from './posting-rules.util';

export interface StatementAccount { key: string; code: string; name: string; type: AccountType; group: string }
/** Movement on one account for one bucket (month, channel or branch). */
export interface MovementRow { accountKey: string; bucket: string; debitMinor: number; creditMinor: number }

export const CHANNELS: Channel[] = ['pos', 'online', 'b2b', 'other'];
export const CHANNEL_LABEL: Record<string, string> = { pos: 'Point of sale', online: 'Online store', b2b: 'B2B / wholesale', other: 'Not channel-specific' };

/** Entries posted before Phase 3 carry no channel: derive it from what caused them. */
export function channelOf(sourceType: string, channel: string | null | undefined, salesB2b = false): string {
  if (channel) return channel;
  if (sourceType.startsWith('pos_') || sourceType === 'cash_movement' || sourceType === 'shift_close') return 'pos';
  if (sourceType === 'order' || sourceType === 'order_refund' || sourceType === 'order_cogs') return salesB2b ? 'b2b' : 'online';
  if (sourceType === 'fee' || sourceType === 'payout' || sourceType === 'settlement') return 'online';
  return 'other';
}

/** Months from `from` to `to` inclusive, as YYYY-MM. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

export interface PnlLine { key: string; code: string; name: string; values: Record<string, number>; total: number }
export interface PnlSection { id: 'income' | 'cost_of_sales' | 'expenses' | 'other_income'; title: string; lines: PnlLine[]; values: Record<string, number>; total: number }

/**
 * Profit & loss: income (credit − debit), cost of sales and operating expenses (debit − credit), per bucket and in total.
 * Income accounts are split into sales and other income (group "Other income"); expenses into cost of sales (group "Cost of sales") and the rest.
 */
export function profitAndLoss(accounts: StatementAccount[], rows: MovementRow[], buckets: string[]) {
  const byAcc = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const a = accounts.find(x => x.key === r.accountKey);
    if (!a || (a.type !== 'income' && a.type !== 'expense')) continue;
    const v = a.type === 'income' ? r.creditMinor - r.debitMinor : r.debitMinor - r.creditMinor;
    const m = byAcc.get(a.key) ?? new Map<string, number>();
    m.set(r.bucket, (m.get(r.bucket) ?? 0) + v);
    byAcc.set(a.key, m);
  }
  const sectionOf = (a: StatementAccount): PnlSection['id'] =>
    a.type === 'income' ? (a.group === 'Other income' ? 'other_income' : 'income') : a.group === 'Cost of sales' ? 'cost_of_sales' : 'expenses';
  const titles: Record<PnlSection['id'], string> = { income: 'Sales', cost_of_sales: 'Cost of sales', expenses: 'Operating expenses', other_income: 'Other income' };
  const sections: PnlSection[] = (['income', 'cost_of_sales', 'expenses', 'other_income'] as const).map(id => {
    const lines = accounts.filter(a => sectionOf(a) === id && byAcc.has(a.key))
      .sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }))
      .map(a => {
        const m = byAcc.get(a.key)!;
        const values = Object.fromEntries(buckets.map(b => [b, m.get(b) ?? 0]));
        return { key: a.key, code: a.code, name: a.name, values, total: buckets.reduce((t, b) => t + (m.get(b) ?? 0), 0) };
      })
      .filter(l => l.total !== 0 || Object.values(l.values).some(v => v !== 0));
    const values = Object.fromEntries(buckets.map(b => [b, lines.reduce((t, l) => t + l.values[b], 0)]));
    return { id, title: titles[id], lines, values, total: lines.reduce((t, l) => t + l.total, 0) };
  });
  const s = (id: PnlSection['id']) => sections.find(x => x.id === id)!;
  const per = (f: (b: string) => number) => Object.fromEntries(buckets.map(b => [b, f(b)]));
  const grossProfit = per(b => s('income').values[b] - s('cost_of_sales').values[b]);
  const netProfit = per(b => grossProfit[b] - s('expenses').values[b] + s('other_income').values[b]);
  const sum = (o: Record<string, number>) => Object.values(o).reduce((t, v) => t + v, 0);
  return {
    buckets, sections,
    grossProfit: { values: grossProfit, total: sum(grossProfit) },
    netProfit: { values: netProfit, total: sum(netProfit) },
  };
}

export interface BalanceLine { key: string; code: string; name: string; group: string; balanceMinor: number }

/**
 * Balance sheet as of a date: assets (debit − credit), liabilities and equity (credit − debit). The profit not yet closed to retained
 * earnings (income − expenses since go-live) is shown as its own equity line, so assets = liabilities + equity whenever the books balance.
 */
export function balanceSheet(accounts: StatementAccount[], sums: Array<{ accountKey: string; debitMinor: number; creditMinor: number }>) {
  const bal = new Map(sums.map(s => [s.accountKey, s]));
  const line = (a: StatementAccount): BalanceLine => {
    const s = bal.get(a.key); const d = s?.debitMinor ?? 0, c = s?.creditMinor ?? 0;
    return { key: a.key, code: a.code, name: a.name, group: a.group, balanceMinor: a.type === 'asset' ? d - c : c - d };
  };
  const pick = (t: AccountType) => accounts.filter(a => a.type === t).map(line).filter(l => l.balanceMinor !== 0).sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true }));
  const assets = pick('asset'), liabilities = pick('liability'), equity = pick('equity');
  const income = accounts.filter(a => a.type === 'income').reduce((t, a) => { const s = bal.get(a.key); return t + ((s?.creditMinor ?? 0) - (s?.debitMinor ?? 0)); }, 0);
  const expense = accounts.filter(a => a.type === 'expense').reduce((t, a) => { const s = bal.get(a.key); return t + ((s?.debitMinor ?? 0) - (s?.creditMinor ?? 0)); }, 0);
  const profit = income - expense;
  const total = (ls: BalanceLine[]) => ls.reduce((t, l) => t + l.balanceMinor, 0);
  const totalAssets = total(assets), totalLiabilities = total(liabilities), totalEquity = total(equity) + profit;
  return {
    assets, liabilities, equity, currentProfitMinor: profit,
    totals: { assetsMinor: totalAssets, liabilitiesMinor: totalLiabilities, equityMinor: totalEquity, balanced: totalAssets === totalLiabilities + totalEquity },
  };
}

/** Sales tax by month: output tax (on sales, net of returns) minus input tax (on purchases) = payable. */
export function salesTaxSummary(rows: MovementRow[], months: string[]) {
  const pick = (key: string, m: string, sign: 1 | -1) => rows.filter(r => r.accountKey === key && r.bucket === m).reduce((t, r) => t + sign * (r.creditMinor - r.debitMinor), 0);
  const lines = months.map(m => {
    const outputMinor = pick('output_tax', m, 1);
    const inputMinor = pick('input_tax', m, -1);
    return { month: m, outputMinor, inputMinor, payableMinor: outputMinor - inputMinor };
  });
  const sum = (k: 'outputMinor' | 'inputMinor' | 'payableMinor') => lines.reduce((t, l) => t + l[k], 0);
  return { months: lines, totals: { outputMinor: sum('outputMinor'), inputMinor: sum('inputMinor'), payableMinor: sum('payableMinor') } };
}
