/**
 * Totals shown in the buyer's order-confirmation email, per STORE.
 *
 * An Order's real total is `subtotal + shippingFee + taxAmount` (`Order.totalAmount`, all in `Order.currency`;
 * item `totalPrice` is already net of coupon / gift-card / store-credit / auto discounts). A sub-order
 * (`sellerOrders[]`) carries only its own `subtotal` + `taxAmount`; shipping lives on the Order, so for an order
 * that spans several stores it is split pro-rata by sub-order subtotal (the whole fee when there is one store).
 * Read-only: never used for charging or the ledger.
 */
export interface StoreEmailTotals {
  items: any[];
  subtotal: number;
  shipping: number;
  tax: number;
  total: number;
  orderNumbers: string[];
  firstOrderId: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function buildStoreEmailTotals(orders: any[]): Map<string, StoreEmailTotals> {
  const byStore = new Map<string, StoreEmailTotals & { _nums: Set<string> }>();
  for (const order of orders) {
    const sellerOrders: any[] = order.sellerOrders ?? [];
    const orderSubtotal = sellerOrders.reduce((s, so) => s + (so.subtotal ?? 0), 0);
    const shippingFee = order.shippingFee ?? 0;
    for (const so of sellerOrders) {
      const share = sellerOrders.length <= 1 ? 1 : orderSubtotal > 0 ? (so.subtotal ?? 0) / orderSubtotal : 1 / sellerOrders.length;
      const entry =
        byStore.get(so.storeId) ??
        { items: [], subtotal: 0, shipping: 0, tax: 0, total: 0, orderNumbers: [], firstOrderId: String(order._id), _nums: new Set<string>() };
      entry.items.push(...(so.items ?? []));
      entry.subtotal += so.subtotal ?? 0;
      entry.shipping += shippingFee * share;
      entry.tax += so.taxAmount ?? 0;
      entry._nums.add(order.orderNumber);
      byStore.set(so.storeId, entry);
    }
  }
  const out = new Map<string, StoreEmailTotals>();
  for (const [storeId, e] of byStore) {
    const subtotal = round2(e.subtotal);
    const shipping = round2(e.shipping);
    const tax = round2(e.tax);
    out.set(storeId, {
      items: e.items, subtotal, shipping, tax,
      total: round2(subtotal + shipping + tax),
      orderNumbers: [...e._nums], firstOrderId: e.firstOrderId,
    });
  }
  return out;
}
