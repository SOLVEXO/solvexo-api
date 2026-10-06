/* eslint-disable prettier/prettier */
import { deriveSellerReturnStatus, isExchangeableReturnLine, quoteExchange } from './order-exchange.util';

describe('quoteExchange', () => {
  it('charges the difference when the replacement costs more', () => {
    const q = quoteExchange([{ unitPrice: 60, quantity: 1 }], 0.1, 55); // value 66, credit 55
    expect(q.replacementValue).toBe(66);
    expect(q.difference).toBe(11);
    expect(q.amountDue).toBeCloseTo(11, 1);
    expect(q.refundDue).toBe(0);
    expect(q.lines[0].netTotal + q.lines[0].netTax).toBeCloseTo(11, 1);
  });

  it('refunds the difference when the replacement is cheaper and bills nothing', () => {
    const q = quoteExchange([{ unitPrice: 20, quantity: 1 }], 0, 50);
    expect(q.difference).toBe(-30);
    expect(q.refundDue).toBe(30);
    expect(q.amountDue).toBe(0);
    expect(q.lines[0].netTotal).toBe(0);
  });

  it('is an even exchange when values match', () => {
    const q = quoteExchange([{ unitPrice: 25, quantity: 2 }], 0, 50);
    expect(q.difference).toBe(0);
    expect(q.amountDue).toBe(0);
    expect(q.refundDue).toBe(0);
  });

  it('spreads the net amount over several lines proportionally', () => {
    const q = quoteExchange([{ unitPrice: 10, quantity: 1 }, { unitPrice: 30, quantity: 1 }], 0, 20);
    expect(q.amountDue).toBe(20);
    expect(q.lines[0].netTotal).toBe(5);
    expect(q.lines[1].netTotal).toBe(15);
  });

  it('never goes negative on a negative credit', () => {
    const q = quoteExchange([{ unitPrice: 10, quantity: 1 }], 0, -5);
    expect(q.credit).toBe(0);
    expect(q.amountDue).toBe(10);
  });
});

describe('deriveSellerReturnStatus', () => {
  it('rolls item statuses up', () => {
    expect(deriveSellerReturnStatus(['approved', 'approved'])).toBe('approved');
    expect(deriveSellerReturnStatus(['approved', 'none'])).toBe('partial_approved');
    expect(deriveSellerReturnStatus(['requested', 'none'])).toBe('partial_requested');
    expect(deriveSellerReturnStatus([])).toBe('none');
  });
});

describe('isExchangeableReturnLine', () => {
  it('accepts a pending physical return', () => {
    expect(isExchangeableReturnLine({ type: 'physical', returnStatus: 'requested' }).ok).toBe(true);
  });
  it('rejects approved, rejected, none, digital and already exchanged lines', () => {
    expect(isExchangeableReturnLine({ type: 'physical', returnStatus: 'approved' }).ok).toBe(false);
    expect(isExchangeableReturnLine({ type: 'physical', returnStatus: 'rejected' }).ok).toBe(false);
    expect(isExchangeableReturnLine({ type: 'physical', returnStatus: 'none' }).ok).toBe(false);
    expect(isExchangeableReturnLine({ type: 'digital', returnStatus: 'requested' }).ok).toBe(false);
    expect(isExchangeableReturnLine({ type: 'physical', returnStatus: 'requested', exchangeOrderId: 'x' }).ok).toBe(false);
  });
});
