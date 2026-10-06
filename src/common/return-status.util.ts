/* eslint-disable prettier/prettier */

/**
 * Shopify-style return lifecycle of ONE order line (`OrderItem.returnStatus`):
 *   none -> requested -> approved -> received -> refunded | exchanged
 *   requested -> rejected (declined)        approved | received -> closed (return closed without a refund)
 * Approving a return moves NO money and NO stock. Stock moves when the goods are marked received, money when the received
 * line is resolved (refund / exchange).
 */
export const RETURN_ITEM_STATUSES = ['none', 'requested', 'approved', 'rejected', 'received', 'refunded', 'exchanged', 'closed'] as const;
export type ReturnItemStatus = (typeof RETURN_ITEM_STATUSES)[number];

/** Statuses that need the seller to do something / are still in progress. */
export const OPEN_RETURN_STATUSES = ['requested', 'approved', 'received'];
/** Statuses where the return is finished. */
export const FINAL_RETURN_STATUSES = ['rejected', 'refunded', 'exchanged', 'closed'];

interface ReturnLineLike { returnStatus?: string | null; refundedAmount?: number | null; exchangeOrderId?: string | null }

/**
 * Before the "receive, then resolve" flow existed, approving a return refunded it immediately and set `refundedAmount`
 * (or created an exchange). Such lines are `approved` AND already refunded/exchanged — they are finished, not "waiting
 * for the goods". New-flow approved lines never carry `refundedAmount` or `exchangeOrderId`.
 */
export function isLegacyResolvedReturn(item: ReturnLineLike): boolean {
  return item.returnStatus === 'approved' && ((item.refundedAmount ?? 0) > 0 || !!item.exchangeOrderId);
}

/** The status the UI should show: legacy approved+refunded lines read as `refunded` (or `exchanged`). */
export function effectiveReturnStatus(item: ReturnLineLike): string {
  const s = item.returnStatus || 'none';
  if (isLegacyResolvedReturn(item)) return item.exchangeOrderId ? 'exchanged' : 'refunded';
  return s;
}

/** Copy of an order line whose `returnStatus` is the effective one (use on every API response that exposes it). */
export function withEffectiveReturnStatus<T extends ReturnLineLike>(item: T): T {
  if (!item) return item;
  const eff = effectiveReturnStatus(item);
  return eff === (item.returnStatus || 'none') ? item : { ...item, returnStatus: eff };
}
