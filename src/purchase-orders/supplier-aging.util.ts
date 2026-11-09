/* eslint-disable prettier/prettier */
/**
 * Payables aging (G3.4), PURE: what is still owed to a supplier, by how old the bill is.
 * Payments and credits are applied to the OLDEST bills first (the usual rule); what is left of a bill keeps that bill's own date.
 * Buckets by age in whole days: current = under 30, d30 = 30–59, d60 = 60–89, d90 = 90 or more. All minor units. If payments + credits exceed the bills the store
 * is in credit with that supplier: the buckets are all 0 and `balanceMinor` is negative.
 */
export interface AgingEntry { type: 'bill' | 'payment' | 'credit' | 'adjustment'; amountMinor: number; at: Date | string }
export interface Aging { balanceMinor: number; currentMinor: number; d30Minor: number; d60Minor: number; d90Minor: number }

export function computeAging(entries: AgingEntry[], now: Date = new Date()): Aging {
  const sorted = [...entries].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const bills: { at: Date; left: number }[] = [];
  let reduce = 0; // payments + credits (+ negative adjustments) to apply to the oldest bills
  let balance = 0;
  for (const e of sorted) {
    balance += e.amountMinor;
    if (e.amountMinor > 0) bills.push({ at: new Date(e.at), left: e.amountMinor });
    else reduce += -e.amountMinor;
  }
  for (const b of bills) {
    if (reduce <= 0) break;
    const used = Math.min(b.left, reduce);
    b.left -= used; reduce -= used;
  }
  const out: Aging = { balanceMinor: balance, currentMinor: 0, d30Minor: 0, d60Minor: 0, d90Minor: 0 };
  for (const b of bills) {
    if (b.left <= 0) continue;
    const days = Math.floor((now.getTime() - b.at.getTime()) / 86_400_000);
    if (days >= 90) out.d90Minor += b.left; else if (days >= 60) out.d60Minor += b.left; else if (days >= 30) out.d30Minor += b.left; else out.currentMinor += b.left;
  }
  return out;
}
