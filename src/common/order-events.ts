import { EventEmitter } from 'events';

/**
 * In-process signal "this order was written in a way that may change who can use its digital items"
 * (paid, cancelled, refunded, item status changed). Emitted by the Order schema hooks, so EVERY write path
 * (checkout, gateway webhooks, mark-paid, manual transfer approval, draft orders, refunds, returns...) is
 * covered without each service knowing about digital delivery. Listeners must be idempotent: a webhook
 * retry or two writes in a row simply produce two events.
 */
export const orderEvents = new EventEmitter();
orderEvents.setMaxListeners(20);

export const ORDER_CHANGED = 'order.changed';

/** Update documents that can matter: payment flag or any status field. */
export function updateTouchesPaymentOrStatus(update: any): boolean {
  if (!update) return false;
  const keys = JSON.stringify(Object.keys(update.$set ?? {}).concat(Object.keys(update.$inc ?? {})));
  return /isPaid|[sS]tatus|refund/.test(keys) || (!!update && !update.$set && !update.$inc && /isPaid|[sS]tatus/.test(JSON.stringify(Object.keys(update))));
}

export const ORDER_DISPUTED = 'order.disputed';

/** A card chargeback was opened against these orders: digital access to them is withdrawn. */
export function emitOrdersDisputed(orderIds: string[]): void {
  try { orderEvents.emit(ORDER_DISPUTED, orderIds.map(String)); } catch { /* never break the webhook */ }
}

export function emitOrderChanged(orderId: string): void {
  try { orderEvents.emit(ORDER_CHANGED, String(orderId)); } catch { /* a listener must never break an order write */ }
}
