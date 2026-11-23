/* eslint-disable prettier/prettier */
/**
 * Gateway settlement import (Accounting Plan, Phase 3), PURE: read a settlement report (CSV as exported by JazzCash, Easypaisa, Safepay
 * or any gateway), find its columns by their headers, and turn each row into gross / fee / net in minor units. Matching to orders is done
 * by the service; `matchLine` decides the outcome from what it found.
 */
import { toMinor } from '../common/money-minor.util';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas / newlines inside quotes, CRLF. A leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = []; let row: string[] = []; let field = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

export type SettlementField = 'date' | 'reference' | 'gross' | 'fee' | 'net';
export type ColumnMap = Partial<Record<SettlementField, number>>;

/** Header words each field is recognised by (lower case, spaces and punctuation removed before comparing). */
const HINTS: Record<SettlementField, string[]> = {
  reference: ['txnrefno', 'transactionreference', 'transactionref', 'txnref', 'transactionid', 'txnid', 'referenceno', 'reference', 'orderid', 'orderno', 'ordernumber', 'orderref', 'trackerid', 'token', 'billreference'],
  gross: ['grossamount', 'transactionamount', 'txnamount', 'amount', 'gross', 'totalamount', 'paidamount'],
  fee: ['fee', 'fees', 'commission', 'mdr', 'charges', 'servicecharges', 'processingfee', 'merchantfee', 'totalfee'],
  net: ['netamount', 'net', 'settledamount', 'settlementamount', 'payable', 'netpayable', 'amountpayable'],
  date: ['transactiondate', 'txndate', 'date', 'datetime', 'createdat', 'paymentdate', 'settlementdate'],
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Best guess of which column holds which field; exact header matches win over partial ones. */
export function detectColumns(headers: string[]): ColumnMap {
  const n = headers.map(norm);
  const used = new Set<number>();
  const out: ColumnMap = {};
  for (const f of ['reference', 'net', 'fee', 'gross', 'date'] as SettlementField[]) {
    let idx = -1;
    for (const h of HINTS[f]) { idx = n.findIndex((x, i) => !used.has(i) && x === h); if (idx >= 0) break; }
    if (idx < 0) for (const h of HINTS[f]) { idx = n.findIndex((x, i) => !used.has(i) && x.includes(h)); if (idx >= 0) break; }
    if (idx >= 0) { out[f] = idx; used.add(idx); }
  }
  return out;
}

/** "1,250.50", "Rs. 1250.5", "(12.00)" (negative), "PKR 300" → number; null when there is no number. */
export function parseAmount(v: string | undefined): number | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  // The number starts at the first digit ("Rs. 1,250.50" → 1250.50); a minus just before it, or brackets around it, make it negative.
  const m = /(-?)\s*(\d[\d,]*(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return m[1] === '-' || /^\(.*\)$/.test(t) ? -n : n;
}

export interface ParsedLine { row: number; date: string | null; reference: string; grossMinor: number; feeMinor: number; netMinor: number }

/**
 * Rows → settlement lines. Two of gross / fee / net are enough (the third is derived); a row without a reference or any amount is
 * reported in `problems` and left out. Fees are taken as positive whatever sign the gateway uses.
 */
export function toLines(rows: string[][], map: ColumnMap, exp: number) {
  const lines: ParsedLine[] = []; const problems: Array<{ row: number; reason: string }> = [];
  rows.forEach((r, i) => {
    const rowNo = i + 2; // 1-based, after the header row
    const ref = map.reference != null ? String(r[map.reference] ?? '').trim() : '';
    const g = map.gross != null ? parseAmount(r[map.gross]) : null;
    const fRaw = map.fee != null ? parseAmount(r[map.fee]) : null;
    const nAmt = map.net != null ? parseAmount(r[map.net]) : null;
    const f = fRaw == null ? null : Math.abs(fRaw);
    if (!ref) { problems.push({ row: rowNo, reason: 'no reference' }); return; }
    let gross = g, fee = f, net = nAmt;
    if (gross == null && net != null) gross = net + (fee ?? 0);
    if (net == null && gross != null) net = gross - (fee ?? 0);
    if (fee == null && gross != null && net != null) fee = gross - net;
    if (gross == null || net == null) { problems.push({ row: rowNo, reason: 'no amount' }); return; }
    const grossMinor = toMinor(gross, exp), netMinor = toMinor(net, exp);
    const feeMinor = grossMinor - netMinor; // keeps gross = net + fee exactly in minor units
    lines.push({ row: rowNo, date: map.date != null ? String(r[map.date] ?? '').trim() || null : null, reference: ref, grossMinor, feeMinor, netMinor });
  });
  return { lines, problems };
}

/**
 * The outcome for one line once the service has looked up the reference: matched when the orders found expect the same gross
 * (a difference of up to 1 unit of the currency is allowed for rounding), amount_differs when they expect another amount,
 * unmatched when nothing was found, duplicate when the same reference already appears in this file or an earlier posted import.
 */
export function matchLine(grossMinor: number, found: { orderIds: string[]; orderNumbers: string[]; expectedMinor: number | null } | null, duplicate: boolean, exp: number) {
  if (duplicate) return { status: 'duplicate' as const, orderIds: found?.orderIds ?? [], orderNumbers: found?.orderNumbers ?? [], expectedMinor: found?.expectedMinor ?? null };
  if (!found || !found.orderIds.length) return { status: 'unmatched' as const, orderIds: [], orderNumbers: [], expectedMinor: null };
  const tolerance = 10 ** exp;
  const ok = found.expectedMinor != null && Math.abs(found.expectedMinor - grossMinor) <= tolerance;
  return { status: ok ? ('matched' as const) : ('amount_differs' as const), ...found };
}
