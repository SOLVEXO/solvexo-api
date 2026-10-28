import { SUB_ORDER_SPEND_EXPR } from './customer-spend.util';

// Customers "total spent" must add the STORE-currency figure of every order (settlementAmount), never the raw
// buyer-currency subtotal: a 9.98 EUR order must not count as 9.98 PKR next to a 1500 PKR one.
describe('customer spend expression', () => {
  it('prefers settlementAmount and falls back to subtotal for old orders', () => {
    expect(SUB_ORDER_SPEND_EXPR).toEqual({ $ifNull: ['$sellerOrders.settlementAmount', '$sellerOrders.subtotal'] });
  });
});
