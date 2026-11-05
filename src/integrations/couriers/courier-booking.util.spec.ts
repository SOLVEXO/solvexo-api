/* eslint-disable prettier/prettier */
import { codForShipment, lineKeyFor, orderDueInOrderCurrency, roundCod } from './courier-booking.util';

describe('lineKeyFor', () => {
  it("is 'all' for a whole order and order-independent for partial shipments", () => {
    expect(lineKeyFor(undefined)).toBe('all');
    expect(lineKeyFor([])).toBe('all');
    expect(lineKeyFor([{ itemId: 'b', quantity: 1 }, { itemId: 'a', quantity: 2 }])).toBe(lineKeyFor([{ itemId: 'a', quantity: 2 }, { itemId: 'b', quantity: 1 }]));
    expect(lineKeyFor([{ itemId: 'a', quantity: 1 }])).not.toBe(lineKeyFor([{ itemId: 'a', quantity: 2 }]));
  });
});

describe('COD amount', () => {
  it('is the order total for an unpaid (COD) order', () => {
    expect(orderDueInOrderCurrency({ isPaid: false, paymentStatus: 'unpaid', totalAmount: 2599.5 })).toBe(2599.5);
  });
  it('is 0 for an already-paid order (flag or status)', () => {
    expect(orderDueInOrderCurrency({ isPaid: true, paymentStatus: 'unpaid', totalAmount: 1000 })).toBe(0);
    expect(orderDueInOrderCurrency({ isPaid: false, paymentStatus: 'paid', totalAmount: 1000 })).toBe(0);
  });
  it('subtracts recorded part-payments and never goes negative', () => {
    expect(orderDueInOrderCurrency({ isPaid: false, paymentStatus: 'partially_paid', totalAmount: 1000, recordedPayments: 400 })).toBe(600);
    expect(orderDueInOrderCurrency({ isPaid: false, paymentStatus: 'partially_paid', totalAmount: 1000, recordedPayments: 1200 })).toBe(0);
  });
  it('takes only this seller\'s share on a multi-seller order', () => {
    expect(orderDueInOrderCurrency({ isPaid: false, paymentStatus: 'unpaid', totalAmount: 1000, orderSubtotal: 900, sellerOrderSubtotal: 300, sellerOrderCount: 2 })).toBeCloseTo(333.33, 2);
  });
  it('rounds PKR to whole rupees, others to 2dp', () => {
    expect(roundCod(1234.6, 'PKR')).toBe(1235);
    expect(roundCod(12.345, 'USD')).toBe(12.35);
  });
  it('partial shipments split proportionally and the final one takes the remainder (sum == due)', () => {
    const due = 1000;
    const a = codForShipment({ due, selectedValue: 100, allValue: 300, alreadyAssigned: 0, isFinal: false, currency: 'PKR' });
    const b = codForShipment({ due, selectedValue: 100, allValue: 300, alreadyAssigned: a, isFinal: false, currency: 'PKR' });
    const c = codForShipment({ due, selectedValue: 100, allValue: 300, alreadyAssigned: a + b, isFinal: true, currency: 'PKR' });
    expect(a + b + c).toBe(1000);
  });
  it('sends 0 for every shipment of a paid order', () => {
    expect(codForShipment({ due: 0, selectedValue: 1, allValue: 2, alreadyAssigned: 0, isFinal: true, currency: 'PKR' })).toBe(0);
  });
});
