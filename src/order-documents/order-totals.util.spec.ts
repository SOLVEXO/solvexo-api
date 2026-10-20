/* eslint-disable prettier/prettier */
import { computeOrderDocumentTotals } from './order-totals.util';

const line = (over: any = {}) => ({ totalPrice: 100, status: 'pending', taxUSD: 0, couponDiscountUSD: 0, autoDiscountUSD: 0, campaignDiscountUSD: 0, ...over });

describe('computeOrderDocumentTotals', () => {
  it('adds shipping and tax, subtracts discounts, for a single-store order', () => {
    const so = { items: [line({ totalPrice: 200, taxUSD: 20, couponDiscountUSD: 10 })], includedTaxAmount: 0 };
    const t = computeOrderDocumentTotals({ currency: 'PKR', shippingFee: 15, sellerOrders: [so] }, so);
    expect(t).toMatchObject({ currency: 'PKR', subtotal: 200, discount: 10, shipping: 15, tax: 20, total: 225, payable: 225 });
  });

  it('skips cancelled lines', () => {
    const so = { items: [line({ totalPrice: 50 }), line({ totalPrice: 70, status: 'cancelled' })] };
    expect(computeOrderDocumentTotals({ shippingFee: 0, sellerOrders: [so] }, so).subtotal).toBe(50);
  });

  it('shows gift card and store credit as part-payments, never below zero', () => {
    const so = { items: [line({ totalPrice: 100 })] };
    const t = computeOrderDocumentTotals({ shippingFee: 0, giftCardDiscountTotal: 30, storeCreditDiscountTotal: 90, sellerOrders: [so] }, so);
    expect(t.total).toBe(100);
    expect(t.payable).toBe(0);
  });

  it('leaves shipping out when the order spans several stores', () => {
    const so = { items: [line()] };
    const t = computeOrderDocumentTotals({ shippingFee: 40, sellerOrders: [so, { items: [] }] }, so);
    expect(t.shipping).toBeNull();
    expect(t.total).toBe(100);
  });

  it('tolerates missing data', () => {
    expect(computeOrderDocumentTotals({}, {})).toMatchObject({ subtotal: 0, total: 0, currency: 'USD' });
  });
});
