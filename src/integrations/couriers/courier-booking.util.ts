/* eslint-disable prettier/prettier */
/** Pure helpers for courier booking (no DB, no HTTP) — unit-tested in courier-booking.util.spec.ts. */

/** 'all' for a whole-order booking, else a stable "itemId:qty|…" key (order of the request does not matter). */
export function lineKeyFor(items?: { itemId: string; quantity: number }[] | null): string {
  if (!items || items.length === 0) return 'all';
  return [...items].map((i) => `${i.itemId}:${i.quantity}`).sort().join('|');
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What the buyer still owes on this order, in the ORDER's currency — the amount a courier would have to collect.
 * Already paid (isPaid / paymentStatus 'paid') => 0. Partially paid => total minus recorded payments (never < 0).
 * A multi-seller order owes only this sub-order's share (by subtotal) — a single-seller order owes the whole total.
 */
export function orderDueInOrderCurrency(input: {
  isPaid: boolean;
  paymentStatus: string;
  totalAmount: number;
  recordedPayments?: number;
  orderSubtotal?: number;
  sellerOrderSubtotal?: number;
  sellerOrderCount?: number;
}): number {
  if (input.isPaid || input.paymentStatus === 'paid') return 0;
  const remaining = Math.max(0, round2((input.totalAmount ?? 0) - (input.recordedPayments ?? 0)));
  const multi = (input.sellerOrderCount ?? 1) > 1 && (input.orderSubtotal ?? 0) > 0;
  return multi ? round2(remaining * Math.min(1, (input.sellerOrderSubtotal ?? 0) / (input.orderSubtotal as number))) : remaining;
}

/** PKR has no minor unit in practice (couriers take whole rupees); other currencies keep 2 decimals. */
export function roundCod(amount: number, currency: string): number {
  return String(currency).toUpperCase() === 'PKR' ? Math.round(amount) : round2(amount);
}

/**
 * Splits a sub-order's COD due across partial shipments. The FINAL shipment takes whatever has not been assigned yet,
 * so the amounts handed to couriers always sum to exactly the amount owed (no drift from rounding).
 */
export function codForShipment(input: {
  due: number;
  selectedValue: number;
  allValue: number;
  alreadyAssigned: number;
  isFinal: boolean;
  currency: string;
}): number {
  if (input.due <= 0) return 0;
  const left = Math.max(0, input.due - input.alreadyAssigned);
  if (input.isFinal || input.allValue <= 0) return roundCod(left, input.currency);
  const proportional = roundCod(input.due * (input.selectedValue / input.allValue), input.currency);
  return Math.min(proportional, roundCod(left, input.currency));
}
