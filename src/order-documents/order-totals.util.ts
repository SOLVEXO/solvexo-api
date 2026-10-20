/* eslint-disable prettier/prettier */

export interface OrderDocumentTotals {
  currency: string;
  subtotal: number;
  /** Coupon + automatic + campaign discounts on this store's lines (positive number). */
  discount: number;
  /** null when the order spans several stores (the shipping fee is one number for the whole order). */
  shipping: number | null;
  tax: number;
  /** Tax already inside the prices (tax-inclusive store): informational, never added. */
  includedTax: number;
  total: number;
  giftCard: number;
  storeCredit: number;
  /** What the customer pays by card / cash / transfer: total minus gift card and store credit. */
  payable: number;
  couponCode: string | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const round = (n: number): number => Math.round(n * 100) / 100;

/**
 * One place that turns an order + this store's sub-order into the figures printed on the invoice, so the
 * packing slip, invoice and screen can never disagree. Items that were cancelled are left out.
 */
export function computeOrderDocumentTotals(order: any, sellerOrder: any): OrderDocumentTotals {
  const lines: any[] = (sellerOrder?.items ?? []).filter((i: any) => i?.status !== 'cancelled');
  const subtotal = round(lines.reduce((s, i) => s + num(i.totalPrice), 0));
  const discount = round(lines.reduce((s, i) => s + num(i.couponDiscountUSD) + num(i.autoDiscountUSD) + num(i.campaignDiscountUSD), 0));
  const single = (order?.sellerOrders?.length ?? 1) <= 1;
  const shipping = single ? round(num(order?.shippingFee)) : null;
  const tax = round(lines.reduce((s, i) => s + num(i.taxUSD), 0));
  const includedTax = round(num(sellerOrder?.includedTaxAmount));
  const giftCard = single ? round(num(order?.giftCardDiscountTotal)) : round(lines.reduce((s, i) => s + num(i.giftCardDiscountUSD), 0));
  const storeCredit = single ? round(num(order?.storeCreditDiscountTotal)) : round(lines.reduce((s, i) => s + num(i.storeCreditDiscountUSD), 0));
  const total = round(Math.max(0, subtotal - discount + (shipping ?? 0) + tax));
  return {
    currency: String(order?.currency ?? 'USD'),
    subtotal,
    discount,
    shipping,
    tax,
    includedTax,
    total,
    giftCard,
    storeCredit,
    payable: round(Math.max(0, total - giftCard - storeCredit)),
    couponCode: order?.couponCode ?? null,
  };
}
