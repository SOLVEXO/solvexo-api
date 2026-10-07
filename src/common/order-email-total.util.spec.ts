import { buildStoreEmailTotals } from './order-email-total.util';

describe('buildStoreEmailTotals', () => {
  it('single store: total = subtotal + shipping + tax = Order.totalAmount', () => {
    const order = {
      _id: 'o1', orderNumber: 'N1', shippingFee: 5, totalAmount: 125,
      sellerOrders: [{ storeId: 's1', subtotal: 100, taxAmount: 20, items: [{ name: 'a' }] }],
    };
    const t = buildStoreEmailTotals([order]).get('s1')!;
    expect(t.subtotal).toBe(100);
    expect(t.shipping).toBe(5);
    expect(t.tax).toBe(20);
    expect(t.total).toBe(order.totalAmount);
  });

  it('multi-store order splits shipping pro-rata and the stores add up to the order total', () => {
    const order = {
      _id: 'o2', orderNumber: 'N2', shippingFee: 10, totalAmount: 10 + 100 + 300 + 4,
      sellerOrders: [
        { storeId: 's1', subtotal: 100, taxAmount: 4, items: [] },
        { storeId: 's2', subtotal: 300, taxAmount: 0, items: [] },
      ],
    };
    const m = buildStoreEmailTotals([order]);
    expect(m.get('s1')!.shipping).toBe(2.5);
    expect(m.get('s2')!.shipping).toBe(7.5);
    expect(m.get('s1')!.total + m.get('s2')!.total).toBeCloseTo(order.totalAmount, 2);
  });

  it('physical + digital orders of one store are summed (digital has no shipping)', () => {
    const phys = { _id: 'p', orderNumber: 'P', shippingFee: 3, sellerOrders: [{ storeId: 's1', subtotal: 50, taxAmount: 2, items: [] }] };
    const dig = { _id: 'd', orderNumber: 'D', shippingFee: 0, sellerOrders: [{ storeId: 's1', subtotal: 10, taxAmount: 1, items: [] }] };
    const t = buildStoreEmailTotals([phys, dig]).get('s1')!;
    expect(t.total).toBe(66);
    expect(t.orderNumbers).toEqual(['P', 'D']);
  });
});
