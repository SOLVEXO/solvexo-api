/* eslint-disable prettier/prettier */
import { round } from '../common/number.util';
import { effectiveReturnStatus } from '../common/return-status.util';
import { releaseRefundCapacity } from '../common/refund-cap.util';
import { deriveSellerReturnStatus } from './order-exchange.util';

/** Per-line snapshot taken when the exchange was created (stored in `Order.exchangeOf.lines`). */
export interface ExchangeLineSnapshot {
  itemId: string;
  prevReturnStatus: string;
  prevRefundedAmount: number;
  /** true when the exchange restocked the returned units at creation (goods physically came back). */
  restocked?: boolean;
  restockChoice?: 'restock' | 'damaged' | null;
}

/**
 * Status a return line goes back to when its exchange order is cancelled: what it was before the exchange
 * (requested / approved / received); a line the exchange already restocked counts as `received` (the goods are back,
 * so a later "mark received" must not restock it twice).
 */
export function reopenedReturnStatus(snap: Pick<ExchangeLineSnapshot, 'prevReturnStatus' | 'restocked'>): string {
  if (snap.restocked) return 'received';
  return ['requested', 'approved', 'received'].includes(snap.prevReturnStatus) ? snap.prevReturnStatus : 'approved';
}

/** Refund budget to hand back: the credit granted at exchange time minus what was already paid out as the price difference. */
export function reopenReleasableCredit(credit: number, refundedOut: number): number {
  return round(Math.max(0, (credit || 0) - (refundedOut || 0)));
}

/**
 * Shopify: cancelling an exchange (replacement) order reopens the return it resolved. Puts the original order's lines back
 * to their pre-exchange return status, clears the exchange link, gives the unspent part of the credit back to the shared
 * refund budget and recomputes the sub-order roll-up. Idempotent: lines are claimed with a conditional update on
 * `exchangeOrderId`, so a second call (or a partial re-cancel) changes nothing. Returns the number of reopened lines.
 */
export async function reopenReturnsForCancelledExchange(orderModel: any, exchangeOrder: any): Promise<number> {
  const ex = exchangeOrder?.exchangeOf;
  if (!ex?.orderId) return 0;
  const exchangeId = String(exchangeOrder._id);
  const original: any = await orderModel.findById(ex.orderId).lean();
  if (!original) return 0;
  const so = (original.sellerOrders ?? []).findIndex((s: any) => (s.items ?? []).some((it: any) => it.exchangeOrderId === exchangeId));
  if (so === -1) return 0;
  const snaps: ExchangeLineSnapshot[] = ex.lines ?? [];
  const prefix = `sellerOrders.${so}.items`;
  const lineIdx: number[] = [];
  (original.sellerOrders[so].items as any[]).forEach((it, i) => { if (it.exchangeOrderId === exchangeId) lineIdx.push(i); });

  const filter: any = { _id: original._id };
  const set: any = {};
  for (const i of lineIdx) {
    const it = original.sellerOrders[so].items[i];
    const snap = snaps.find((s) => s.itemId === String(it._id)) ?? { itemId: String(it._id), prevReturnStatus: 'approved', prevRefundedAmount: 0 };
    filter[`${prefix}.${i}.exchangeOrderId`] = exchangeId;
    set[`${prefix}.${i}.returnStatus`] = reopenedReturnStatus(snap);
    set[`${prefix}.${i}.returnResolvedAt`] = null;
    set[`${prefix}.${i}.returnResolution`] = null;
    set[`${prefix}.${i}.exchangeOrderId`] = null;
    set[`${prefix}.${i}.exchangeOrderNumber`] = null;
    set[`${prefix}.${i}.refundedAmount`] = snap.prevRefundedAmount ?? 0;
    if (snap.restocked) {
      set[`${prefix}.${i}.returnReceivedAt`] = new Date();
      set[`${prefix}.${i}.returnRestock`] = snap.restockChoice ?? 'restock';
    }
  }
  const res: any = await orderModel.updateOne(filter, { $set: set });
  if ((res.modifiedCount ?? res.nModified ?? 0) === 0) return 0;

  const releasable = reopenReleasableCredit(ex.credit ?? 0, ex.refundedOut ?? 0);
  if (releasable > 0) await releaseRefundCapacity(orderModel, String(original._id), so, releasable).catch(() => undefined);

  const fresh: any = await orderModel.findById(original._id).select('sellerOrders').lean();
  const items = fresh?.sellerOrders?.[so]?.items ?? [];
  const statuses = items.filter((it: any) => it.type === 'physical' && it.status !== 'cancelled').map((it: any) => effectiveReturnStatus(it));
  await orderModel.updateOne({ _id: original._id }, { $set: { [`sellerOrders.${so}.returnStatus`]: deriveSellerReturnStatus(statuses) } }).catch(() => undefined);
  await orderModel.updateOne({ _id: original._id }, {
    $push: { timeline: { type: 'return', message: `Exchange order #${exchangeOrder.orderNumber} was cancelled - the return was reopened`, actorId: null, actorRole: 'system', createdAt: new Date() } },
  }).catch(() => undefined);
  return lineIdx.length;
}
