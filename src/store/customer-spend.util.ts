/** Mongo expression for one sub-order's spend in the STORE's currency (items + tax converted at the order's frozen
 *  rate). `sellerOrders.subtotal` alone is in the BUYER's currency, so summing it mixes dollars, euros and rupees.
 *  Orders placed before `settlementAmount` existed fall back to `subtotal`. */
export const SUB_ORDER_SPEND_EXPR = { $ifNull: ['$sellerOrders.settlementAmount', '$sellerOrders.subtotal'] };
