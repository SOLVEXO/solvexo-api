/**
 * Shopify-style saved views of the seller's orders list. Only whitelisted names are honoured (never client
 * operators). `matchFilter` is the order-level filter, `subFilter` the per-store sub-order filter ($elemMatch).
 */
export const SELLER_ORDER_VIEWS = ['unfulfilled', 'open', 'unpaid', 'cod_awaiting'] as const;
export type SellerOrderView = (typeof SELLER_ORDER_VIEWS)[number];

export function applySellerOrderView(view: unknown, matchFilter: Record<string, any>, subFilter: Record<string, any>): void {
  if (typeof view !== 'string') return;
  if (view === 'unfulfilled') subFilter.status = { $in: ['pending', 'processing'] };
  else if (view === 'open') subFilter.status = { $in: ['pending', 'processing', 'shipped'] };
  else if (view === 'unpaid') { matchFilter.isPaid = false; subFilter.status = { $nin: ['cancelled', 'refunded'] }; }
  else if (view === 'cod_awaiting') matchFilter['codProtection.confirmation.status'] = 'awaiting';
}
