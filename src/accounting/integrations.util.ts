/* eslint-disable prettier/prettier */
/**
 * Accounting app integrations (Accounting Plan, Phase 4), PURE: turn journal entries into what Tally, Odoo and ERPNext take.
 * Every integration reads the same journal, so each is a translator, not new accounting logic. No network or database here.
 */
import type { AccountType } from './chart.const';

export interface IntAccount { key: string; code: string; name: string; type: AccountType; group: string; externalCode: string | null }
export interface IntLine { accountKey: string; debitMinor: number; creditMinor: number; memo?: string }
export interface IntEntry { id: string; seq: number; date: Date | string; reference: string; memo: string; lines: IntLine[] }

/** YYYY-MM-DD of an instant in a time zone. */
export const localDay = (d: Date | string, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const major = (minor: number, exp: number) => Number((minor / 10 ** exp).toFixed(exp));

/**
 * One entry per day: each account's debits and credits for the day netted, so the accountant's books get a short daily summary
 * (the recommended default for Tally). Accounts that net to zero are dropped.
 */
export function summarizeByDay(entries: IntEntry[], tz: string): IntEntry[] {
  const byDay = new Map<string, Map<string, number>>();
  for (const e of entries) {
    const day = localDay(e.date, tz);
    const m = byDay.get(day) ?? new Map<string, number>();
    for (const l of e.lines) m.set(l.accountKey, (m.get(l.accountKey) ?? 0) + l.debitMinor - l.creditMinor);
    byDay.set(day, m);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, m]) => ({
    id: `day:${day}`, seq: 0, date: `${day}T12:00:00Z`, reference: `SOLVEXO-${day}`, memo: `Solvexo daily summary ${day}`,
    lines: [...m.entries()].filter(([, v]) => v !== 0).map(([accountKey, v]) => (v > 0 ? { accountKey, debitMinor: v, creditMinor: 0 } : { accountKey, debitMinor: 0, creditMinor: -v })),
  })).filter(e => e.lines.length > 0);
}

/** The accounts an entry needs that have no code / name in the seller's app yet. */
export function unmappedAccounts(entries: IntEntry[], accounts: IntAccount[]): IntAccount[] {
  const used = new Set(entries.flatMap(e => e.lines.map(l => l.accountKey)));
  return accounts.filter(a => used.has(a.key) && !a.externalCode?.trim());
}

// ── Tally ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const xml = (s: string) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Tally's built-in group for each account (Tally ledgers must sit under a group). */
export function tallyGroup(a: IntAccount): string {
  switch (a.key) {
    case 'cash': case 'petty_cash': case 'cash_safe': return 'Cash-in-Hand';
    case 'bank': return 'Bank Accounts';
    case 'receivables': return 'Sundry Debtors';
    case 'payables': return 'Sundry Creditors';
    case 'inventory': return 'Stock-in-Hand';
    case 'output_tax': case 'input_tax': case 'wht_payable': return 'Duties & Taxes';
    case 'capital': case 'drawings': case 'opening_suspense': return 'Capital Account';
    case 'retained_earnings': return 'Reserves & Surplus';
    case 'cogs': case 'inventory_adjustments': return 'Direct Expenses';
    case 'other_income': return 'Indirect Incomes';
    default: break;
  }
  switch (a.type) {
    case 'asset': return 'Current Assets';
    case 'liability': return 'Current Liabilities';
    case 'equity': return 'Capital Account';
    case 'income': return a.group === 'Other income' ? 'Indirect Incomes' : 'Sales Accounts';
    default: return 'Indirect Expenses';
  }
}

/** The ledger name used in Tally: the accountant's own name when the seller mapped one, else the Solvexo account name. */
export const tallyLedger = (a: IntAccount) => (a.externalCode?.trim() || a.name);

/**
 * A Tally import file (TallyPrime / Tally.ERP 9 "Import Data" XML): ledger masters for every account used, then one Journal voucher
 * per entry. Tally's sign convention: a debit is a negative AMOUNT with ISDEEMEDPOSITIVE Yes; a credit is positive with No.
 * Each voucher carries a REMOTEID, so importing the same file twice does not duplicate it.
 */
export function tallyXml(input: { company: string | null; accounts: IntAccount[]; entries: IntEntry[]; exponent: number; tz: string }): string {
  const used = new Set(input.entries.flatMap(e => e.lines.map(l => l.accountKey)));
  const acc = new Map(input.accounts.map(a => [a.key, a]));
  const ledgerOf = (key: string) => { const a = acc.get(key); return a ? tallyLedger(a) : key; };
  const masters = input.accounts.filter(a => used.has(a.key)).map(a =>
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xml(tallyLedger(a))}" ACTION="Create"><NAME.LIST><NAME>${xml(tallyLedger(a))}</NAME></NAME.LIST><PARENT>${xml(tallyGroup(a))}</PARENT><ISBILLWISEON>No</ISBILLWISEON></LEDGER></TALLYMESSAGE>`);
  const vouchers = input.entries.map(e => {
    const lines = e.lines.map(l => {
      const debit = l.debitMinor > 0;
      const amt = major(debit ? -l.debitMinor : l.creditMinor, input.exponent);
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(ledgerOf(l.accountKey))}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt.toFixed(input.exponent)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    }).join('');
    const day = localDay(e.date, input.tz).replace(/-/g, '');
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER REMOTEID="solvexo-${xml(e.id)}" VCHTYPE="Journal" ACTION="Create"><DATE>${day}</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(e.reference || (e.seq ? `SX-${e.seq}` : ''))}</VOUCHERNUMBER><NARRATION>${xml(e.memo)}</NARRATION>${lines}</VOUCHER></TALLYMESSAGE>`;
  });
  const company = input.company ? `<STATICVARIABLES><SVCURRENTCOMPANY>${xml(input.company)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>${company}</REQUESTDESC><REQUESTDATA>${masters.join('')}${vouchers.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
}

// ── Odoo and ERPNext ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The reference every pushed entry carries in the other app: finds it again so a retry never posts twice. */
export const externalRef = (e: IntEntry) => (e.seq ? `SOLVEXO-${e.seq}` : e.reference);

/** Odoo `account.move` values (a posted journal entry). `accountId` maps a Solvexo account to the Odoo account's id. */
export function odooMove(e: IntEntry, accountId: (key: string) => number, journalId: number, exp: number, tz: string) {
  return {
    move_type: 'entry', journal_id: journalId, date: localDay(e.date, tz), ref: externalRef(e), narration: e.memo,
    line_ids: e.lines.map(l => [0, 0, { account_id: accountId(l.accountKey), name: (l.memo || e.memo || externalRef(e)).slice(0, 200), debit: major(l.debitMinor, exp), credit: major(l.creditMinor, exp) }]),
  };
}

/** ERPNext `Journal Entry` document, submitted (docstatus 1). `account` is the full ERPNext account name ("Cash - ABC"). */
export function erpnextJournal(e: IntEntry, accountName: (key: string) => string, company: string, exp: number, tz: string) {
  return {
    doctype: 'Journal Entry', voucher_type: 'Journal Entry', company, posting_date: localDay(e.date, tz), docstatus: 1,
    cheque_no: externalRef(e), cheque_date: localDay(e.date, tz), user_remark: `${externalRef(e)}: ${e.memo}`.slice(0, 500),
    accounts: e.lines.map(l => ({ account: accountName(l.accountKey), debit_in_account_currency: major(l.debitMinor, exp), credit_in_account_currency: major(l.creditMinor, exp), user_remark: (l.memo || '').slice(0, 140) })),
  };
}

/** The base URL a seller typed: https only, no credentials or query in it; trailing slashes dropped. Null when unusable. */
export function cleanBaseUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}
