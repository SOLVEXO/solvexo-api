/**
 * The single source of truth for rolling up an order's status — used both
 * for `SellerOrder.status` (rolled up from its `OrderItem.status` values)
 * and for `Order.orderStatus` (rolled up from its `SellerOrder.status`
 * values). Before this existed, at least 5 independent call sites across
 * `orders.service.ts`/`manual-payments.service.ts`/`refund-request.service.ts`
 * each hand-computed their own version of this — with real, confirmed drift
 * (a partial cancellation never updated `SellerOrder.status`/`orderStatus`
 * at all; `updateSellerOrderStatus` silently left `orderStatus` stale for a
 * `['pending','processing']` mix; a refund never touched `status`/
 * `orderStatus` at all). Every write path that mutates an item's or
 * seller-order's status must re-derive through this function immediately
 * afterward instead of hand-rolling its own logic.
 *
 * Both `SellerOrder.status` and `Order.orderStatus` share ONE enum now (see
 * `order.schema.ts`) specifically so this one function's return type is
 * valid at both rollup levels.
 */

const PROGRESS_ORDER = ['pending', 'processing', 'shipped', 'delivered', 'completed'] as const;
type ProgressStatus = (typeof PROGRESS_ORDER)[number];

export type RollupStatus =
  | ProgressStatus
  | 'cancelled'
  | 'refunded'
  | 'partially_cancelled'
  | 'partially_refunded'
  | 'partially_shipped';

/**
 * Rolls up a list of child statuses (an `OrderItem[]`'s statuses, or a
 * `SellerOrder[]`'s statuses) into one summary status.
 *
 * Rules, in order:
 * 1. Every child in the same terminal state → that terminal state
 *    (`cancelled` / `refunded`).
 * 2. Some (not all) children are cancelled/refunded, regardless of what the
 *    rest are doing → `partially_cancelled`/`partially_refunded`. This is a
 *    deliberate simplification: it doesn't also track "and the remaining
 *    active items are at stage X" in the rollup word itself — that detail
 *    stays fully available at the item level (a real Order Detail page
 *    shows each item's own status), the rollup is a summary label, not a
 *    replacement for the detail view.
 * 3. No cancellations/refunds — roll up by fulfillment progress: all children
 *    at the same stage → that stage; mixed stages → `partially_shipped`
 *    (reusing the one "mixed, still in progress" word the vocabulary
 *    already had, at both rollup levels for consistency).
 */
export function deriveRollupStatus(childStatuses: string[]): RollupStatus {
  if (childStatuses.length === 0) return 'pending';

  const cancelledCount = childStatuses.filter((s) => s === 'cancelled').length;
  const refundedCount = childStatuses.filter((s) => s === 'refunded').length;
  const terminalCount = cancelledCount + refundedCount;

  if (cancelledCount === childStatuses.length) return 'cancelled';
  if (refundedCount === childStatuses.length) return 'refunded';
  if (terminalCount > 0) {
    return refundedCount > 0 ? 'partially_refunded' : 'partially_cancelled';
  }

  const indices = childStatuses
    .map((s) => PROGRESS_ORDER.indexOf(s as ProgressStatus))
    .filter((i) => i >= 0);
  if (indices.length === 0) return 'pending';

  const min = Math.min(...indices);
  const max = Math.max(...indices);
  if (min === max) return PROGRESS_ORDER[min];
  return 'partially_shipped';
}

/** Named wrapper for the `OrderItem[] -> SellerOrder.status` rollup — same function as `deriveOrderStatus`, kept as two names only for call-site readability. */
export function deriveSellerOrderStatus(items: { status: string }[]): RollupStatus {
  return deriveRollupStatus(items.map((i) => i.status));
}

/** Named wrapper for the `SellerOrder[] -> Order.orderStatus` rollup. */
export function deriveOrderStatus(sellerOrders: { status: string }[]): RollupStatus {
  return deriveRollupStatus(sellerOrders.map((so) => so.status));
}
