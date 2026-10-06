/* eslint-disable prettier/prettier */
import { round } from '../common/number.util';
import { isLegacyResolvedReturn } from '../common/return-status.util';

export interface ExchangeReplacementInput {
  /** Unit price in the ORDER's currency. */
  unitPrice: number;
  quantity: number;
}

export interface ExchangeLineQuote {
  /** Full replacement price (unit * qty), before the exchange credit. */
  gross: number;
  /** What the customer still owes for this line after the returned-items credit (0 when fully covered). */
  netTotal: number;
  netTax: number;
}

export interface ExchangeQuote {
  replacementSubtotal: number;
  replacementTax: number;
  /** replacement subtotal + tax. */
  replacementValue: number;
  /** Value of the returned lines (price + tax share) that is credited against the replacement. */
  credit: number;
  /** replacementValue - credit: > 0 the customer pays, < 0 the store refunds, 0 even exchange. */
  difference: number;
  amountDue: number;
  refundDue: number;
  lines: ExchangeLineQuote[];
}

/**
 * Shopify-style exchange maths, in the order's own currency.
 *
 * The returned items' value (`credit`) is set against the replacement items' value (price + tax at the original order's
 * effective tax rate). The exchange order only carries the NEW money: each replacement line is scaled down by the same
 * factor so that  sum(netTotal + netTax) == amountDue  (0 when the credit covers everything). That keeps revenue,
 * the ledger and later cancel/refund caps on the exchange order honest — the part covered by the credit was already paid
 * on the original order and is not counted twice.
 */
export function quoteExchange(lines: ExchangeReplacementInput[], effTaxRate: number, credit: number): ExchangeQuote {
  const rate = effTaxRate > 0 ? effTaxRate : 0;
  const grossLines = lines.map((l) => round(l.unitPrice * l.quantity));
  const replacementSubtotal = round(grossLines.reduce((s, g) => s + g, 0));
  const replacementTax = round(replacementSubtotal * rate);
  const replacementValue = round(replacementSubtotal + replacementTax);
  const safeCredit = round(Math.max(0, credit));
  const difference = round(replacementValue - safeCredit);
  const factor = difference > 0 && replacementValue > 0 ? difference / replacementValue : 0;
  const quoted: ExchangeLineQuote[] = grossLines.map((gross) => ({
    gross,
    netTotal: round(gross * factor),
    netTax: round(gross * rate * factor),
  }));
  const amountDue = difference > 0 ? round(quoted.reduce((s, l) => s + l.netTotal + l.netTax, 0)) : 0;
  return {
    replacementSubtotal, replacementTax, replacementValue, credit: safeCredit, difference,
    amountDue, refundDue: difference < 0 ? round(-difference) : 0, lines: quoted,
  };
}

/**
 * Roll-up of a sub-order's return status from its per-item statuses (pass EFFECTIVE statuses — see `effectiveReturnStatus`).
 * Open work wins: approved (waiting for the goods) / received (waiting for a refund or exchange) / requested; once every
 * return line is finished the roll-up is `resolved` (all declined = `rejected`).
 */
export function deriveSellerReturnStatus(itemStatuses: string[]): string {
  if (itemStatuses.length === 0) return 'none';
  const allApproved = itemStatuses.every((s) => s === 'approved');
  const anyApproved = itemStatuses.some((s) => s === 'approved');
  const allReceived = itemStatuses.every((s) => s === 'received');
  const anyReceived = itemStatuses.some((s) => s === 'received');
  const allRequested = itemStatuses.every((s) => s === 'requested');
  const anyRequested = itemStatuses.some((s) => s === 'requested');
  const used = itemStatuses.filter((s) => s !== 'none');
  const allRejected = used.every((s) => s === 'rejected');
  const allFinished = used.length > 0 && used.every((s) => ['rejected', 'refunded', 'exchanged', 'closed'].includes(s));
  if (allApproved) return 'approved';
  if (anyApproved) return 'partial_approved';
  if (allReceived) return 'received';
  if (anyReceived) return 'partial_received';
  if (allRequested) return 'requested';
  if (anyRequested) return 'partial_requested';
  if (allRejected) return 'rejected';
  if (allFinished) return 'resolved';
  return 'none';
}

/** A return line may be resolved by an exchange while it is requested, approved or received (not once refunded/exchanged/closed). */
export function isExchangeableReturnLine(item: { type?: string; returnStatus?: string; exchangeOrderId?: string | null; status?: string; refundedAmount?: number | null }): { ok: boolean; reason?: string } {
  if (item.type !== 'physical') return { ok: false, reason: 'Only physical items can be exchanged' };
  if (item.exchangeOrderId) return { ok: false, reason: 'This item was already exchanged' };
  if (isLegacyResolvedReturn(item)) return { ok: false, reason: 'This return was already approved and refunded — create a new order for the replacement instead' };
  if (!['requested', 'approved', 'received'].includes(item.returnStatus ?? '')) return { ok: false, reason: 'This item has no open return request' };
  if (item.status === 'cancelled' || item.status === 'refunded') return { ok: false, reason: 'This item was already cancelled or refunded' };
  return { ok: true };
}
