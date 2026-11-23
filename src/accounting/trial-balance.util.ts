/* eslint-disable prettier/prettier */
import { isDebitNormal, type AccountType } from './chart.const';

export interface AccountSums { accountKey: string; debitMinor: number; creditMinor: number }
export interface AccountRow { key: string; code: string; name: string; type: AccountType; group: string; archived?: boolean }
export interface TrialBalanceRow extends AccountRow { debitMinor: number; creditMinor: number; balanceMinor: number }

/**
 * Trial balance: per account the debits, credits and the balance on its normal side (assets and expenses: debit − credit;
 * the rest: credit − debit). Accounts with no movement are listed only when `includeEmpty`. Totals of debits and credits must match.
 */
export function trialBalance(accounts: AccountRow[], sums: AccountSums[], includeEmpty = false) {
  const byKey = new Map(sums.map(s => [s.accountKey, s]));
  const rows: TrialBalanceRow[] = [];
  for (const a of accounts) {
    const s = byKey.get(a.key);
    if (!s && !includeEmpty) continue;
    const debitMinor = s?.debitMinor ?? 0, creditMinor = s?.creditMinor ?? 0;
    rows.push({ ...a, debitMinor, creditMinor, balanceMinor: isDebitNormal(a.type) ? debitMinor - creditMinor : creditMinor - debitMinor });
  }
  // Movement on an account key that is not in the chart (should never happen): shown, so it cannot hide.
  for (const s of sums) if (!accounts.some(a => a.key === s.accountKey)) {
    rows.push({ key: s.accountKey, code: '?', name: `Unknown account (${s.accountKey})`, type: 'asset', group: '', debitMinor: s.debitMinor, creditMinor: s.creditMinor, balanceMinor: s.debitMinor - s.creditMinor });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const debitMinor = rows.reduce((t, r) => t + r.debitMinor, 0);
  const creditMinor = rows.reduce((t, r) => t + r.creditMinor, 0);
  return { rows, totals: { debitMinor, creditMinor, balanced: debitMinor === creditMinor } };
}

/** Balances a set of opening amounts: whatever does not net to zero goes to the opening balance suspense account. */
export function openingLines(input: Array<{ accountKey: string; debitMinor: number; creditMinor: number }>) {
  const lines = input
    .map(l => ({ accountKey: l.accountKey, debitMinor: Math.max(0, Math.round(l.debitMinor || 0)), creditMinor: Math.max(0, Math.round(l.creditMinor || 0)), memo: 'Opening balance' }))
    .filter(l => l.debitMinor || l.creditMinor);
  const diff = lines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
  if (diff > 0) lines.push({ accountKey: 'opening_suspense', debitMinor: 0, creditMinor: diff, memo: 'Difference to balance the opening entry' });
  if (diff < 0) lines.push({ accountKey: 'opening_suspense', debitMinor: -diff, creditMinor: 0, memo: 'Difference to balance the opening entry' });
  return { lines, suspenseMinor: diff };
}
