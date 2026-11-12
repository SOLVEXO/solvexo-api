/* eslint-disable prettier/prettier */
import { buildOrderB2B, companyOutstanding, receivableOf } from './b2b-order.util';

const snap = { companyId: 'c1', companyName: 'Acme', locationId: 'l1', poNumber: 'PO-1', paymentTerms: { type: 'net', netDays: 30 }, depositPercent: 25 };
const placed = new Date('2026-01-10T00:00:00Z');

describe('buildOrderB2B', () => {
  it('terms order: due date, deposit, empty payments', () => {
    const b = buildOrderB2B(snap, { total: 200, currency: 'PKR' }, { withTerms: true, placedAt: placed });
    expect(b).toMatchObject({ terms: { type: 'net', netDays: 30 }, dueDate: new Date('2026-02-09T00:00:00Z'), depositRequired: 50, paidTotal: 0, status: 'unpaid', poNumber: 'PO-1' });
  });
  it('a normal-payment order keeps the PO number but has no schedule, due date or deposit', () => {
    const b = buildOrderB2B(snap, { total: 200, currency: 'PKR' }, { withTerms: false, placedAt: placed });
    expect(b.terms).toBeNull();
    expect(b.dueDate).toBeNull();
    expect(b.depositRequired).toBe(0);
    expect(b.poNumber).toBe('PO-1');
  });
});

describe('receivableOf', () => {
  const base = () => buildOrderB2B(snap, { total: 100, currency: 'PKR' }, { withTerms: true, placedAt: placed });
  it('is null for orders without terms', () => {
    expect(receivableOf({ b2b: null })).toBeNull();
    expect(receivableOf({ b2b: buildOrderB2B(snap, { total: 1, currency: 'PKR' }, { withTerms: false }) })).toBeNull();
  });
  it('tracks outstanding, partial/paid, voids and overdue', () => {
    const b: any = base();
    b.payments = [{ _id: 1, amount: 40, method: 'bank', reference: null, date: placed, recordedBy: 's' }, { _id: 2, amount: 30, method: 'cash', reference: null, date: placed, recordedBy: 's', voided: true }];
    const r: any = receivableOf({ b2b: b, orderStatus: 'pending' }, new Date('2026-03-01T00:00:00Z'));
    expect(r).toMatchObject({ paid: 40, outstanding: 60, status: 'partial', overdue: true, depositMet: true });
    expect(receivableOf({ b2b: b }, new Date('2026-01-11T00:00:00Z'))!.overdue).toBe(false);
    b.payments.push({ _id: 3, amount: 60, method: 'bank', reference: null, date: placed, recordedBy: 's' });
    expect(receivableOf({ b2b: b }, new Date('2026-03-01T00:00:00Z'))).toMatchObject({ status: 'paid', outstanding: 0, overdue: false });
  });
  it('deposit not met until enough is recorded', () => {
    expect(receivableOf({ b2b: base() })!.depositMet).toBe(false);
  });
  it('due-on-fulfilment orders have no due date until they leave the shop', () => {
    const b: any = buildOrderB2B({ ...snap, paymentTerms: { type: 'due_on_fulfilment' } }, { total: 100, currency: 'PKR' }, { withTerms: true, placedAt: placed });
    expect(receivableOf({ b2b: b, orderStatus: 'pending' }, new Date('2030-01-01'))).toMatchObject({ dueDate: null, overdue: false });
    const shipped: any = receivableOf({ b2b: b, orderStatus: 'shipped', updatedAt: new Date('2026-01-20T00:00:00Z') }, new Date('2026-02-01T00:00:00Z'));
    expect(shipped).toMatchObject({ overdue: true });
  });
});

describe('companyOutstanding', () => {
  it('sums open terms orders, converts other currencies with their own rates, filters by store and company', async () => {
    const find = jest.fn().mockReturnValue({ select: () => ({ limit: () => ({ lean: async () => [
      { currency: 'PKR', b2b: { total: 100, payments: [{ amount: 30 }] } },
      { currency: 'USD', fxSnapshots: [{ currency: 'PKR', ratePerUSD: 280 }], b2b: { total: 1, payments: [{ amount: 0.5, voided: true }] } },
    ] }) }) });
    const out = await companyOutstanding({ find }, (n, _f, _t) => n * 280, 's1', 'c1', 'PKR');
    expect(out).toBe(70 + 280);
    expect(find.mock.calls[0][0]).toMatchObject({ 'b2b.companyId': 'c1', 'sellerOrders.storeId': 's1', isDelete: false, orderStatus: { $nin: ['cancelled', 'refunded'] } });
  });
});

import { filterPaymentMethodsForB2B } from './b2b-order.util';
describe('filterPaymentMethodsForB2B', () => {
  const terms = { type: 'net', netDays: 30 };
  it('leaves retail checkouts alone', () => {
    expect(filterPaymentMethodsForB2B(['stripe', 'cash_on_delivery'], null, true)).toEqual(['stripe', 'cash_on_delivery']);
  });
  it('adds terms for a single-store company with terms, never for multi-store or without terms', () => {
    expect(filterPaymentMethodsForB2B(['stripe'], { paymentTerms: terms }, true)).toEqual(['stripe', 'b2b_terms']);
    expect(filterPaymentMethodsForB2B(['stripe'], { paymentTerms: terms }, false)).toEqual(['stripe']);
    expect(filterPaymentMethodsForB2B(['stripe'], { paymentTerms: null }, true)).toEqual(['stripe']);
  });
  it('narrows by the allow-list (bank transfer + terms only)', () => {
    const b2b = { paymentTerms: terms, allowedPaymentMethods: ['manual_bank_transfer', 'b2b_terms'] };
    expect(filterPaymentMethodsForB2B(['stripe', 'cash_on_delivery', 'manual_bank_transfer'], b2b, true)).toEqual(['manual_bank_transfer', 'b2b_terms']);
  });
  it('terms excluded by the list are not added; split needs both halves', () => {
    expect(filterPaymentMethodsForB2B(['stripe'], { paymentTerms: terms, allowedPaymentMethods: ['stripe'] }, true)).toEqual(['stripe']);
    expect(filterPaymentMethodsForB2B(['stripe', 'split'], { allowedPaymentMethods: ['stripe'] }, true)).toEqual(['stripe']);
    expect(filterPaymentMethodsForB2B(['split'], { allowedPaymentMethods: ['stripe', 'cash_on_delivery'] }, true)).toEqual(['split']);
  });
});
