/* eslint-disable prettier/prettier */
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const DAY = 86_400_000;

export type KhataEntryType = 'sale' | 'payment' | 'adjustment' | 'reversal';

export interface LedgerLine { type: KhataEntryType; amount: number; date: Date | string; dueDate?: Date | string | null }

/** A positive amount increases what the customer owes (sale, debit adjustment); a negative one lowers it (payment, credit adjustment). */
export function signedAmount(type: KhataEntryType, amount: number): number {
  const a = round2(Math.abs(amount));
  if (type === 'sale') return a;
  if (type === 'payment') return -a;
  return round2(amount); // adjustment: caller's sign; reversal: computed from the reversed entry
}

export function validateAmount(amount: unknown, { allowNegative = false }: { allowNegative?: boolean } = {}): number {
  const n = Number(amount);
  if (!Number.isFinite(n) || n === 0 || (!allowNegative && n < 0) || Math.abs(n) > 1e10) throw new Error('Enter a valid amount');
  return round2(n);
}

/** Would adding `amount` (> 0) to `balance` go above the seller's limit? A null limit means no limit. */
export function exceedsLimit(balance: number, amount: number, limit: number | null | undefined): boolean {
  if (limit === null || limit === undefined) return false;
  return amount > 0 && round2(balance + amount) > limit + 0.004;
}

export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90_plus'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function bucketOf(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return 'd1_30';
  if (daysPastDue <= 60) return 'd31_60';
  if (daysPastDue <= 90) return 'd61_90';
  return 'd90_plus';
}

/**
 * Aging of what is still owed. Money received (payments, credit adjustments) is applied to the OLDEST debits first (first in, first out);
 * what remains of each debit is placed in a bucket by days past its due date (entry date when no due date was set).
 * Pure: entries must be passed in ledger order.
 */
export function agingOf(lines: LedgerLine[], now: Date): { buckets: Record<AgingBucket, number>; total: number; open: { date: Date; dueDate: Date; remaining: number }[] } {
  const debits: { date: Date; dueDate: Date; remaining: number }[] = [];
  let credit = 0;
  for (const l of lines) {
    const a = round2(l.amount);
    if (a > 0) { const d = new Date(l.date); debits.push({ date: d, dueDate: l.dueDate ? new Date(l.dueDate) : d, remaining: a }); }
    else credit = round2(credit - a);
  }
  for (const d of debits) {
    if (credit <= 0) break;
    const used = Math.min(d.remaining, credit);
    d.remaining = round2(d.remaining - used); credit = round2(credit - used);
  }
  const buckets: Record<AgingBucket, number> = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  const open = debits.filter((d) => d.remaining > 0);
  for (const d of open) { const days = Math.floor((now.getTime() - d.dueDate.getTime()) / DAY); buckets[bucketOf(days)] = round2(buckets[bucketOf(days)] + d.remaining); }
  // Credit left over (customer paid in advance) is not an overdue amount; the caller reports it through a negative balance.
  const total = round2(Object.values(buckets).reduce((s, v) => s + v, 0));
  return { buckets, total, open };
}

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
