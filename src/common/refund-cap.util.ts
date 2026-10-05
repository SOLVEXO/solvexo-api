/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException } from '@nestjs/common';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * ONE shared refund budget per seller-order for EVERY refund mechanism (cancel, standalone "Refund $X", return approval,
 * approved refund request, order edit). Before this, each path only checked its own bookkeeping, so e.g. cancelling an item
 * after a manual refund of the same money refunded it twice.
 *
 * The budget is what the buyer paid for this seller-order: `subtotal + taxAmount`. `refundedTotal` is the running total
 * already refunded; for orders that predate the field it is derived once from the old per-mechanism counters.
 * The reservation is an atomic compare-and-set, so two concurrent refunds can never both take the last of the budget.
 *
 * `clamp: true` grants min(amount, remaining) (used where the item was already cancelled/returned and the money movement
 * must follow, but never beyond what is left); otherwise throws when `amount` does not fit.
 * Returns the amount actually reserved.
 */
export async function reserveRefundCapacity(
  orderModel: any,
  orderId: string,
  soIndex: number,
  amount: number,
  opts: { clamp?: boolean } = {},
): Promise<number> {
  if (!(amount > 0)) return 0;
  const path = `sellerOrders.${soIndex}.refundedTotal`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const o: any = await orderModel.findById(orderId).select('sellerOrders').lean();
    const so = o?.sellerOrders?.[soIndex];
    if (!so) throw new BadRequestException('Order not found');
    const legacy = (so.items ?? []).reduce((s: number, i: any) => s + (i.refundedAmount || 0), 0) + (so.manualRefundedAmount || 0);
    const current: number = so.refundedTotal == null ? legacy : so.refundedTotal;
    const cap = r2((so.subtotal ?? 0) + (so.taxAmount ?? 0));
    const remaining = Math.max(0, r2(cap - current));
    let grant = amount;
    if (amount > remaining + 0.005) {
      if (!opts.clamp) throw new BadRequestException(`Refund amount exceeds what's left to refund for this order (max ${remaining}).`);
      grant = remaining;
    }
    if (!(grant > 0)) return 0;
    const filter: any = { _id: orderId };
    filter[path] = so.refundedTotal == null ? { $exists: false } : so.refundedTotal;
    const res: any = await orderModel.updateOne(filter, { $set: { [path]: r2(current + grant) } });
    if ((res.modifiedCount ?? res.nModified ?? 0) === 1) return r2(grant);
  }
  throw new ConflictException('This order was refunded at the same moment — refresh and try again.');
}

/** Gives a reservation back when the money movement it was taken for did not happen. */
export async function releaseRefundCapacity(orderModel: any, orderId: string, soIndex: number, amount: number): Promise<void> {
  if (!(amount > 0)) return;
  await orderModel.updateOne({ _id: orderId }, { $inc: { [`sellerOrders.${soIndex}.refundedTotal`]: -r2(amount) } });
}

/** What is still refundable on a seller-order right now (same budget as `reserveRefundCapacity`, read-only). */
export function remainingRefundable(so: any): number {
  const legacy = (so.items ?? []).reduce((s: number, i: any) => s + (i.refundedAmount || 0), 0) + (so.manualRefundedAmount || 0);
  const current: number = so.refundedTotal == null ? legacy : so.refundedTotal;
  return Math.max(0, r2((so.subtotal ?? 0) + (so.taxAmount ?? 0) - current));
}
