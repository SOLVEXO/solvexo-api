/* eslint-disable prettier/prettier */
/**
 * The posting rules (Accounting Plan, "Posting rules"): pure functions that turn ONE money record into ONE balanced journal
 * entry draft, or say why it is left out. No database access here, so every rule is unit-tested on plain objects.
 *
 * Amounts are integer minor units of the store's base currency. A record in another currency is left out ('currency'):
 * converting it is Phase 3 work, and a guessed rate would put wrong numbers in the books.
 */
import { isDirectSale, sellerCashBasis } from '../common/seller-payout-basis.util';
import { toMinor } from '../common/money-minor.util';
import { EXPENSE_CATEGORY_ACCOUNT } from './chart.const';

export interface PostingCtx { base: string; exp: number }
export interface DraftLine { accountKey: string; debitMinor: number; creditMinor: number; memo?: string }
/** Sales channel an entry belongs to, for statements by channel (Phase 3). */
export type Channel = 'pos' | 'online' | 'b2b' | 'other';
export interface EntryDraft {
  sourceType: string; sourceId: string; sourceKey: string; date: Date; reference: string; memo: string; lines: DraftLine[];
  channel?: Channel; locationId?: string | null;
}
export interface Skip { skip: string }
export type RuleResult = EntryDraft | Skip;
export const isSkip = (r: RuleResult): r is Skip => 'skip' in r;

const dr = (accountKey: string, amount: number, memo = ''): DraftLine => ({ accountKey, debitMinor: amount, creditMinor: 0, memo });
const cr = (accountKey: string, amount: number, memo = ''): DraftLine => ({ accountKey, debitMinor: 0, creditMinor: amount, memo });
/** A signed amount on one account: positive = debit, negative = credit. */
const signed = (accountKey: string, amount: number, memo = ''): DraftLine => (amount >= 0 ? dr(accountKey, amount, memo) : cr(accountKey, -amount, memo));
const num = (v: any): number => (v == null ? 0 : Number(v) || 0);
/** A stored minor twin when present, else the major amount converted. */
const minorOr = (minor: any, major: any, exp: number): number => (minor != null && Number.isFinite(Number(minor)) ? Math.round(Number(minor)) : toMinor(num(major), exp));
const dateOf = (...ds: any[]): Date => { for (const d of ds) if (d) return new Date(d); return new Date(0); };

/** Drops zero lines and checks the entry balances. Throws on an unbalanced draft: that is a bug in a rule, never data. */
export function finalize(d: EntryDraft): EntryDraft {
  const lines = d.lines.filter(l => l.debitMinor !== 0 || l.creditMinor !== 0).map(l => {
    // A negative amount on one side is moved to the other side.
    if (l.debitMinor < 0) return { ...l, debitMinor: 0, creditMinor: l.creditMinor - l.debitMinor };
    if (l.creditMinor < 0) return { ...l, creditMinor: 0, debitMinor: l.debitMinor - l.creditMinor };
    return l;
  });
  const debit = lines.reduce((s, l) => s + l.debitMinor, 0);
  const credit = lines.reduce((s, l) => s + l.creditMinor, 0);
  if (debit !== credit) throw new Error(`Unbalanced entry ${d.sourceKey}: debit ${debit} ≠ credit ${credit}`);
  if (!lines.every(l => Number.isSafeInteger(l.debitMinor) && Number.isSafeInteger(l.creditMinor))) throw new Error(`Non-integer amount in ${d.sourceKey}`);
  return { ...d, lines };
}
export const entryTotal = (d: { lines: DraftLine[] }) => d.lines.reduce((s, l) => s + l.debitMinor, 0);

/** The same entry with every debit and credit swapped (used for reversals). */
export function swapped(lines: DraftLine[]): DraftLine[] {
  return lines.map(l => ({ ...l, debitMinor: l.creditMinor, creditMinor: l.debitMinor }));
}

// ── POS ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** POS tender → the account the money sits in until it is banked or settled. */
export function posTenderAccount(method: string | null | undefined): string {
  switch (method) {
    case 'cash': return 'cash';
    case 'card': case 'raast_qr': return 'card_clearing';
    case 'store_credit': return 'customer_advances';
    default: return 'other_clearing'; // 'other' (also how a sale goes on khata) and legacy 'split'
  }
}

const sameCurrency = (cur: string | null | undefined, ctx: PostingCtx) => !cur || String(cur).toUpperCase() === ctx.base;

const POS_FINAL = new Set(['completed', 'partially_refunded', 'refunded', 'voided']);

/** A POS sale: money in by tender; sales (net of tax) and output tax out. Voids and refunds post their own entries. */
export function posSaleEntry(sale: any, ctx: PostingCtx): RuleResult {
  if (!POS_FINAL.has(sale.status) || sale.deletedAt) return { skip: 'not_final' };
  if (!sameCurrency(sale.currency, ctx)) return { skip: 'currency' };
  const exp = sale.currencyExponent ?? ctx.exp;
  const total = minorOr(sale.totalMinor, sale.total, exp);
  const tax = minorOr(sale.taxMinor, sale.tax, exp);
  const tenders: Array<{ method: string; amount: number }> = (sale.payments ?? []).length
    ? sale.payments.map((p: any) => ({ method: p.method, amount: minorOr(p.amountMinor, p.amount, exp) }))
    : [{ method: sale.paymentMethod, amount: total }];
  const lines: DraftLine[] = tenders.map(t => dr(posTenderAccount(t.method), t.amount, `Paid by ${t.method}`));
  const paid = tenders.reduce((s, t) => s + t.amount, 0);
  if (paid !== total) {
    // Loyalty points, rounding or a recorded shortfall: the till took less (or more) than the invoice total.
    lines.push(paid < total ? dr('sales_returns', total - paid, 'Loyalty, rounding or shortfall') : cr('other_income', paid - total, 'Collected above the invoice total'));
  }
  lines.push(cr('sales_pos', total - tax, 'Sales'), cr('output_tax', tax, 'Sales tax'));
  return finalize({
    sourceType: 'pos_sale', sourceId: String(sale._id), sourceKey: `pos_sale:${sale._id}`, channel: 'pos', locationId: sale.locationId ?? null,
    date: dateOf(sale.invoice?.issuedAt, sale.createdAt), reference: sale.invoice?.number ?? sale.saleNumber ?? '',
    memo: `POS sale ${sale.invoice?.number ?? sale.saleNumber ?? ''}`.trim(), lines,
  });
}

/** Money out by tender; sales returns and output tax back. `taxMinor` comes from the refund's credit note (0 when there is none). */
function moneyBack(tenders: Array<{ method: string; amount: number }>, total: number, taxMinor: number): DraftLine[] {
  const tax = Math.max(0, Math.min(taxMinor, total));
  const lines: DraftLine[] = [dr('output_tax', tax, 'Sales tax reversed'), dr('sales_returns', total - tax, 'Returned sales')];
  for (const t of tenders) lines.push(cr(posTenderAccount(t.method), t.amount, `Refunded by ${t.method}`));
  const paid = tenders.reduce((s, t) => s + t.amount, 0);
  if (paid !== total) lines.push(signed('other_clearing', paid - total, 'Refund tenders differ from the refund total'));
  return lines;
}

/** A POS return (PosRefund), with its credit note's tax when found. */
export function posRefundEntry(refund: any, creditNote: any | null, ctx: PostingCtx, locationId: string | null = null): RuleResult {
  if (!sameCurrency(refund.currency, ctx)) return { skip: 'currency' };
  const exp = refund.currencyExponent ?? ctx.exp;
  const total = minorOr(refund.amountMinor, refund.amount, exp);
  const tenders = (refund.tenders ?? []).map((t: any) => ({ method: t.method, amount: minorOr(t.amountMinor, t.amount, exp) }));
  return finalize({
    sourceType: 'pos_refund', sourceId: String(refund._id), sourceKey: `pos_refund:${refund._id}`, date: dateOf(refund.createdAt), channel: 'pos', locationId,
    reference: refund.reference ?? '', memo: `POS refund ${refund.reference ?? ''}`.trim(),
    lines: moneyBack(tenders.length ? tenders : [{ method: 'cash', amount: total }], total, num(creditNote?.taxMinor)),
  });
}

/** A POS void: its credit note (kind 'void') takes the whole sale back. */
export function posVoidEntry(cn: any, ctx: PostingCtx, locationId: string | null = null): RuleResult {
  if (cn.kind !== 'void') return { skip: 'not_void' };
  if (!sameCurrency(cn.currency, ctx)) return { skip: 'currency' };
  const total = num(cn.totalMinor);
  const tenders = (cn.tenders ?? []).map((t: any) => ({ method: t.method, amount: num(t.amountMinor) }));
  return finalize({
    sourceType: 'pos_void', sourceId: String(cn._id), sourceKey: `pos_void:${cn._id}`, date: dateOf(cn.createdAt), channel: 'pos', locationId,
    reference: cn.number ?? '', memo: `POS void ${cn.number ?? ''}`.trim(),
    lines: moneyBack(tenders.length ? tenders : [{ method: 'cash', amount: total }], total, num(cn.taxMinor)),
  });
}

/** Where a payment method's money comes from or goes to (expenses, supplier payments, khata payments). */
export function paymentAccount(method: string | null | undefined): string {
  const m = String(method ?? '').toLowerCase();
  if (!m || m === 'cash') return 'cash';
  if (m.includes('bank') || m === 'cheque' || m === 'check') return 'bank';
  if (m.includes('card')) return 'card_clearing';
  if (/jazz|easy|raast|wallet|safepay|payfast/.test(m)) return 'gateway_clearing';
  if (m === 'other') return 'capital'; // paid from outside the business's accounts
  return 'cash';
}

/** A POS expense. `suffix` lets a re-approved expense post again after a rejection reversed it. */
export function expenseEntry(exp: any, ctx: PostingCtx, suffix = '', accounts: Record<string, string> = {}, locationId: string | null = null): RuleResult {
  if (!sameCurrency(exp.currency, ctx)) return { skip: 'currency' };
  const amount = num(exp.amountMinor);
  const account = accounts[exp.category] ?? EXPENSE_CATEGORY_ACCOUNT[exp.category] ?? 'exp_other';
  return finalize({
    sourceType: 'expense', sourceId: String(exp._id), sourceKey: `expense:${exp._id}${suffix}`, date: dateOf(exp.occurredAt, exp.createdAt),
    channel: exp.sessionId ? 'pos' : 'other', locationId,
    reference: exp.number ?? '', memo: `Expense: ${exp.category}${exp.payee ? ` (${exp.payee})` : ''}`,
    lines: [dr(account, amount, exp.note ?? ''), cr(paymentAccount(exp.method), amount, `Paid by ${exp.method}`)],
  });
}

const CASH_IN: Record<string, string> = { float_topup: 'cash_safe', owner_injection: 'capital', other_in: 'other_income' };
const CASH_OUT: Record<string, string> = { bank_deposit: 'bank', safe_drop: 'cash_safe', petty: 'petty_cash', owner_draw: 'drawings', other_out: 'exp_other' };

/** A cash in / cash out on a register. Expense cash-outs are skipped: the expense itself posts. */
export function cashMovementEntry(session: any, adj: any, index: number, ctx: PostingCtx): RuleResult {
  if (adj.category === 'expense' || adj.refType === 'expense') return { skip: 'posted_with_expense' };
  if (!sameCurrency(session.currency, ctx)) return { skip: 'currency' };
  const amount = minorOr(adj.amountMinor, adj.amount, session.currencyExponent ?? ctx.exp);
  const isIn = adj.type === 'cash_in';
  const other = isIn ? (CASH_IN[adj.category] ?? 'other_income') : (CASH_OUT[adj.category] ?? 'exp_other');
  const label = String(adj.category ?? (isIn ? 'cash in' : 'cash out')).replace(/_/g, ' ');
  return finalize({
    sourceType: 'cash_movement', sourceId: String(session._id), sourceKey: `cash:${session._id}:${adj.requestId ?? index}`, channel: 'pos', locationId: session.locationId ?? null,
    date: dateOf(adj.occurredAt, adj.createdAt), reference: '', memo: `Cash ${isIn ? 'in' : 'out'}: ${label}${adj.reason ? `, ${adj.reason}` : ''}`,
    lines: isIn ? [dr('cash', amount), cr(other, amount)] : [dr(other, amount), cr('cash', amount)],
  });
}

/** A closed shift whose counted cash differs from the expected cash. */
export function shiftCloseEntry(session: any, ctx: PostingCtx): RuleResult {
  if (session.status !== 'closed') return { skip: 'open' };
  if (!sameCurrency(session.currency, ctx)) return { skip: 'currency' };
  const diff = minorOr(session.cashDifferenceMinor, session.cashDifference, session.currencyExponent ?? ctx.exp);
  if (!diff) return { skip: 'zero' };
  const over = diff > 0;
  return finalize({
    sourceType: 'shift_close', sourceId: String(session._id), sourceKey: `shift:${session._id}`, date: dateOf(session.closedAt, session.updatedAt),
    channel: 'pos', locationId: session.locationId ?? null,
    reference: '', memo: `Shift closed ${over ? 'over' : 'short'}`,
    lines: over ? [dr('cash', diff), cr('cash_over_short', diff)] : [dr('cash_over_short', -diff), cr('cash', -diff)],
  });
}

// ── Stock ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One stock movement at its recorded unit cost. Sales, returns and voids move cost of goods sold; adjustments, counts,
 * write-offs and expiry go to inventory adjustments. Receipts and supplier returns post from purchasing; transfers stay
 * inside the one inventory account.
 */
export function stockMovementEntry(mv: any): RuleResult {
  const reason = String(mv.reason ?? '');
  let other: string | null = null;
  if (mv.type === 'sale' || mv.type === 'return' || mv.type === 'void') other = 'cogs';
  else if (mv.type === 'adjustment' && reason === 'return') other = 'cogs';
  else if (mv.type === 'adjustment' && (reason === 'purchase_received' || reason === 'supplier_return')) return { skip: 'posted_with_purchasing' };
  else if (['adjustment', 'count', 'write_off', 'expired'].includes(mv.type)) other = 'inventory_adjustments';
  if (!other) return { skip: 'not_posted_type' };
  const qty = num(mv.qtyDelta);
  if (!qty) return { skip: 'zero' };
  if (mv.unitCostMinor == null) return { skip: 'no_cost' };
  const value = Math.round(Math.abs(qty) * num(mv.unitCostMinor));
  if (!value) return { skip: 'zero' };
  const name = mv.productName ?? mv.sku ?? 'item';
  const memo = `${mv.type.replace(/_/g, ' ')}: ${Math.abs(qty)} × ${name}`;
  return finalize({
    sourceType: 'stock', sourceId: String(mv._id), sourceKey: `stock:${mv._id}`, date: dateOf(mv.createdAt), reference: mv.sku ?? '', memo,
    channel: ['sale', 'refund', 'void'].includes(mv.refType) || mv.sessionId ? 'pos' : 'other', locationId: mv.locationId ?? null,
    lines: qty < 0 ? [dr(other, value), cr('inventory', value)] : [dr('inventory', value), cr(other, value)],
  });
}

// ── Purchasing ────────────────────────────────────────────────────────────────────────────────────────────────────────

export function receiptEntry(rc: any, ctx: PostingCtx): RuleResult {
  if (!sameCurrency(rc.currency, ctx)) return { skip: 'currency' };
  const total = num(rc.totalMinor);
  return finalize({
    sourceType: 'receipt', sourceId: String(rc._id), sourceKey: `receipt:${rc._id}`, date: dateOf(rc.createdAt),
    reference: rc.receiptNumber ?? '', memo: `Goods received ${rc.receiptNumber ?? ''}`.trim(),
    lines: [dr('inventory', total), cr('grni', total)],
  });
}

/** A supplier ledger entry: bill (+), payment (−), credit (−), adjustment (±). */
export function supplierEntry(e: any, ctx: PostingCtx): RuleResult {
  if (!sameCurrency(e.currency, ctx)) return { skip: 'currency' };
  const amt = num(e.amountMinor);
  const a = Math.abs(amt);
  if (!a) return { skip: 'zero' };
  let lines: DraftLine[];
  switch (e.type) {
    case 'bill': lines = [dr(e.refType === 'receipt' ? 'grni' : 'inventory', a), cr('payables', a)]; break;
    case 'payment': lines = [dr('payables', a), cr(paymentAccount(e.method), a, `Paid by ${e.method ?? 'cash'}`)]; break;
    case 'credit': lines = [dr('payables', a), cr('inventory', a, 'Goods returned to the supplier')]; break;
    case 'adjustment': lines = amt > 0 ? [dr('inventory_adjustments', a), cr('payables', a)] : [dr('payables', a), cr('inventory_adjustments', a)]; break;
    default: return { skip: 'not_posted_type' };
  }
  return finalize({
    sourceType: 'supplier', sourceId: String(e._id), sourceKey: `supplier:${e._id}`, date: dateOf(e.createdAt),
    reference: e.reference ?? '', memo: `Supplier ${e.type}${e.note ? `: ${e.note}` : ''}`, lines,
  });
}

// ── Khata ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A khata entry (amount signed, major units, positive = the customer owes more). B2B sales post with their order (with the
 * tax split); a POS sale put on khata moves the amount from "other payments" to the customer's account.
 * `original` is the entry a reversal undoes.
 */
export function khataEntry(e: any, currency: string, ctx: PostingCtx, original?: any): RuleResult {
  if (!sameCurrency(currency, ctx)) return { skip: 'currency' };
  const base = { sourceType: 'khata', sourceId: String(e._id), sourceKey: `khata:${e._id}`, date: dateOf(e.entryDate, e.createdAt), reference: e.reference ?? '', channel: (e.source === 'pos' ? 'pos' : 'other') as Channel };
  if (e.type === 'reversal') {
    if (!original) return { skip: 'original_missing' };
    const o = khataEntry(original, currency, ctx);
    if (isSkip(o)) return { skip: o.skip };
    return finalize({ ...base, memo: `Khata reversal${e.note ? `: ${e.note}` : ''}`, lines: swapped(o.lines) });
  }
  const amt = toMinor(num(e.amount), ctx.exp);
  const a = Math.abs(amt);
  if (!a) return { skip: 'zero' };
  let lines: DraftLine[];
  if (e.type === 'sale') {
    if (e.source === 'b2b' || e.source === 'order') return { skip: 'posted_with_order' };
    const other = e.source === 'pos' ? 'other_clearing' : 'sales_khata';
    lines = amt > 0 ? [dr('receivables', a), cr(other, a)] : [dr(other, a), cr('receivables', a)];
  } else if (e.type === 'payment') {
    lines = amt < 0 ? [dr(paymentAccount(e.method), a, `Received by ${e.method ?? 'cash'}`), cr('receivables', a)] : [dr('receivables', a), cr(paymentAccount(e.method), a)];
  } else if (e.type === 'adjustment') {
    lines = amt < 0 ? [dr('sales_returns', a), cr('receivables', a)] : [dr('receivables', a), cr('other_income', a)];
  } else return { skip: 'not_posted_type' };
  return finalize({ ...base, memo: `Khata ${e.type}${e.note ? `: ${e.note}` : ''}`, lines });
}

// ── Online orders ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where an online order's money for this seller sits after the sale. */
export function orderPaymentAccount(order: any, so: any): string {
  if (!isDirectSale(so, order)) return 'solvexo_receivable'; // Solvexo collected it: it reaches the seller as a payout
  if (so.settledViaConnect) return 'gateway_clearing';
  switch (String(order.paymentType ?? '').toLowerCase()) {
    case 'cash_on_delivery': case 'cod': return 'cod_receivable';
    case 'manual_bank_transfer': case 'bank_transfer': return 'bank';
    case 'b2b_terms': return 'receivables';
    case 'store_credit': return 'customer_advances';
    case 'cash': case 'pos': case 'manual': return 'cash';
    default: return 'gateway_clearing';
  }
}

const PAID_STATUSES = new Set(['paid', 'partially_paid', 'refunded']);
const DELIVERED = new Set(['delivered', 'completed']);

/** When this seller's part of the order counts as a sale, or null while it does not yet. */
export function orderRecognisedAt(order: any, so: any): Date | null {
  const pt = String(order.paymentType ?? '').toLowerCase();
  const paid = !!order.isPaid || PAID_STATUSES.has(order.paymentStatus);
  if (pt === 'cash_on_delivery' || pt === 'cod') {
    if (DELIVERED.has(so.status) || paid) return dateOf(so.deliveredAt, order.paidAt, order.updatedAt);
    return null;
  }
  if (pt === 'b2b_terms') return so.status === 'cancelled' && !paid ? null : dateOf(order.createdAt);
  return paid ? dateOf(order.paidAt, order.createdAt) : null;
}

/** order-currency → base-currency factor for this sellerOrder (1 when the order is already in the base currency). */
function orderFactor(order: any, so: any, ctx: PostingCtx): number | null {
  if (so.settlementAmount != null && so.settlementCurrency) {
    if (String(so.settlementCurrency).toUpperCase() !== ctx.base) return null;
    const gross = num(so.subtotal) + num(so.platformSponsoredDiscountUSD) + num(so.taxAmount);
    return gross > 0 ? num(so.settlementAmount) / gross : 1;
  }
  return sameCurrency(order.currency, ctx) ? 1 : null;
}

/** The parts of a recognised sellerOrder, in base minor units. */
export function orderAmounts(order: any, so: any, ctx: PostingCtx): { cash: number; giftCard: number; storeCredit: number; tax: number } | null {
  const f = orderFactor(order, so, ctx);
  if (f == null) return null;
  const direct = isDirectSale(so, order);
  const items: any[] = so.items ?? [];
  const sum = (k: string) => items.reduce((s, i) => s + num(i?.[k]), 0);
  const cashMajor = so.settlementAmount != null ? sellerCashBasis(so) : num(so.subtotal) + num(so.platformSponsoredDiscountUSD) + num(so.taxAmount);
  return {
    cash: toMinor(cashMajor, ctx.exp),
    // Gift cards and store credit are ways of paying; for a platform-held card sale the platform never held that share.
    giftCard: direct ? toMinor(sum('giftCardDiscountUSD') * f, ctx.exp) : 0,
    storeCredit: direct ? toMinor(sum('storeCreditDiscountUSD') * f, ctx.exp) : 0,
    tax: toMinor((num(so.taxAmount) + num(so.includedTaxAmount)) * f, ctx.exp),
  };
}

function salesAccountFor(order: any): string { return (String(order.paymentType ?? '').toLowerCase() === 'b2b_terms' || order.b2b ? 'sales_b2b' : 'sales_online'); }
const orderChannel = (order: any): Channel => (salesAccountFor(order) === 'sales_b2b' ? 'b2b' : 'online');

/** One seller's part of an online order, once it counts as a sale. */
export function orderSaleEntry(order: any, so: any, ctx: PostingCtx): RuleResult {
  if (order.isDelete) return { skip: 'deleted' };
  const at = orderRecognisedAt(order, so);
  if (!at) return { skip: 'not_recognised' };
  const a = orderAmounts(order, so, ctx);
  if (!a) return { skip: 'currency' };
  const gross = a.cash + a.giftCard + a.storeCredit;
  if (!gross) return { skip: 'zero' };
  const tax = Math.min(a.tax, gross);
  return finalize({
    sourceType: 'order', sourceId: String(order._id), sourceKey: `order:${order._id}:${so.storeId}`, date: at, channel: orderChannel(order),
    reference: order.orderNumber ?? '', memo: `Online order ${order.orderNumber ?? ''}`.trim(),
    lines: [
      dr(orderPaymentAccount(order, so), a.cash, `Paid by ${order.paymentType ?? 'card'}`),
      dr('gift_cards', a.giftCard, 'Paid by gift card'),
      dr('customer_advances', a.storeCredit, 'Paid by store credit'),
      cr(salesAccountFor(order), gross - tax, 'Sales'),
      cr('output_tax', tax, 'Sales tax'),
    ],
  });
}

/** Everything refunded on this sellerOrder so far, in base minor units (all refund paths share `refundedTotal`). */
export function orderRefundedMinor(order: any, so: any, ctx: PostingCtx): number | null {
  const f = orderFactor(order, so, ctx);
  if (f == null) return null;
  const cum = so.refundedTotal != null ? num(so.refundedTotal) : (so.items ?? []).reduce((s: number, i: any) => s + num(i?.refundedAmount), 0) + num(so.manualRefundedAmount);
  return toMinor(cum * f, ctx.exp);
}

/** The refund not yet posted (`alreadyMinor` = refunds already in the journal for this sellerOrder). */
export function orderRefundEntry(order: any, so: any, ctx: PostingCtx, alreadyMinor: number, at: Date): RuleResult {
  const cum = orderRefundedMinor(order, so, ctx);
  if (cum == null) return { skip: 'currency' };
  const delta = cum - alreadyMinor;
  if (delta <= 0) return { skip: 'zero' };
  const a = orderAmounts(order, so, ctx);
  const gross = a ? a.cash + a.giftCard + a.storeCredit : 0;
  const tax = a && gross > 0 ? Math.round((delta * Math.min(a.tax, gross)) / gross) : 0;
  return finalize({
    sourceType: 'order_refund', sourceId: String(order._id), sourceKey: `order_refund:${order._id}:${so.storeId}:${cum}`, date: at, channel: orderChannel(order),
    reference: order.orderNumber ?? '', memo: `Refund on online order ${order.orderNumber ?? ''}`.trim(),
    lines: [dr('output_tax', tax, 'Sales tax reversed'), dr('sales_returns', delta - tax, 'Refunded sales'), cr(orderPaymentAccount(order, so), delta, 'Refunded')],
  });
}

/**
 * Cost of goods sold for one seller's part of an online order, posted when the sale is (Phase 3). Online stock leaves without a stock
 * movement, so the cost comes from the line: its batch (FIFO) cost when lots were consumed, else the variant's current average cost.
 * Cancelled and digital lines carry no cost; a line with no known cost is left out (`missing` counts them). Returns restock through a
 * stock adjustment, which posts the cost back.
 */
export function orderCogsEntry(order: any, so: any, ctx: PostingCtx, costOf: (variantId: string) => number | null, at: Date): RuleResult & { missing?: number } {
  let total = 0, missing = 0;
  for (const it of so.items ?? []) {
    if (it?.type === 'digital' || it?.status === 'cancelled') continue;
    const qty = num(it.quantity);
    if (!qty) continue;
    if (it.costOfGoodsSold != null && Number(it.costOfGoodsSold) > 0) { total += toMinor(Number(it.costOfGoodsSold), ctx.exp); continue; }
    const parts: Array<{ variantId: string; qty: number }> = (it.bundleComponents ?? []).length
      ? it.bundleComponents.map((c: any) => ({ variantId: String(c.variantId), qty: num(c.quantity) * qty }))
      : it.variantId ? [{ variantId: String(it.variantId), qty }] : [];
    if (!parts.length) { missing++; continue; }
    for (const p of parts) { const c = costOf(p.variantId); if (c == null) { missing++; continue; } total += Math.round(c * p.qty); }
  }
  if (!total) return { skip: missing ? 'no_cost' : 'zero' };
  const d = finalize({
    sourceType: 'order_cogs', sourceId: String(order._id), sourceKey: `order_cogs:${order._id}:${so.storeId}`, date: at, channel: orderChannel(order),
    reference: order.orderNumber ?? '', memo: `Cost of goods for online order ${order.orderNumber ?? ''}`.trim(),
    lines: [dr('cogs', total), cr('inventory', total)],
  });
  return Object.assign(d, { missing });
}

// ── Solvexo balance ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Solvexo fees and balance adjustments on the seller's Solvexo balance. Sales and refunds there mirror orders (posted above). */
export function financeTxEntry(tx: any, ctx: PostingCtx): RuleResult {
  if (!['fee', 'adjustment'].includes(tx.type)) return { skip: 'posted_with_order' };
  if (tx.status && tx.status !== 'completed') return { skip: 'not_final' };
  if (!sameCurrency(tx.currency, ctx)) return { skip: 'currency' };
  const amt = toMinor(num(tx.amount), ctx.exp);
  if (!amt) return { skip: 'zero' };
  const lines = amt < 0
    ? [dr('platform_fees', -amt, tx.description ?? ''), cr('solvexo_receivable', -amt)]
    : [dr('solvexo_receivable', amt), cr('other_income', amt, tx.description ?? '')];
  return finalize({
    sourceType: 'fee', sourceId: String(tx._id), sourceKey: `fee:${tx._id}`, date: dateOf(tx.createdAt), reference: '', channel: 'online',
    memo: tx.type === 'fee' ? 'Solvexo fee' : 'Solvexo balance adjustment', lines,
  });
}

/** A completed payout: money moves from the Solvexo balance to the seller's bank. */
export function payoutEntry(p: any, ctx: PostingCtx): RuleResult {
  if (p.status !== 'completed' && p.status !== 'reversed') return { skip: 'not_final' };
  if (!sameCurrency(p.currency, ctx)) return { skip: 'currency' };
  const amt = toMinor(Math.abs(num(p.amount)), ctx.exp);
  if (!amt) return { skip: 'zero' };
  return finalize({
    sourceType: 'payout', sourceId: String(p._id), sourceKey: `payout:${p._id}`, date: dateOf(p.processedAt, p.updatedAt, p.createdAt), channel: 'online',
    reference: '', memo: 'Payout from Solvexo', lines: [dr('bank', amt), cr('solvexo_receivable', amt)],
  });
}
