/* eslint-disable prettier/prettier */

const FULFILLED_STATES = ['shipped', 'delivered', 'completed'];

/**
 * Turns the checkout-time reservation (`committedStock`) into a real stock decrement for every physical
 * item of the sub-orders that are NOT already fulfilled — the same effect as the shipped/delivered/completed
 * transition in OrdersService.updateSellerOrderStatus, for the paths that jump an order straight to
 * "paid + completed" (mark-paid, record-payment, manual bank-transfer approval). Without it those orders left
 * the reservation stuck in `committedStock` and on-hand `stock` never dropped.
 * Atomic per variant and clamped at 0; unlimited-stock variants are skipped.
 */
export async function fulfilStockForSellerOrders(productVariantModel: any, sellerOrders: any[]): Promise<void> {
  for (const so of sellerOrders ?? []) {
    if (FULFILLED_STATES.includes(so.status) || ['cancelled', 'refunded'].includes(so.status) || so.stockAlreadyDeducted) continue;
    for (const item of so.items ?? []) {
      if (item.type !== 'physical' || !item.variantId || !(item.quantity > 0)) continue;
      await productVariantModel.updateOne(
        { _id: item.variantId, unlimitedStock: { $ne: true } },
        [{
          $set: {
            stock: { $max: [0, { $subtract: ['$stock', item.quantity] }] },
            committedStock: { $max: [0, { $subtract: ['$committedStock', item.quantity] }] },
          },
        }],
      );
    }
  }
}
