/* eslint-disable prettier/prettier */
import { derivePayment } from './payment-status.util';

const ev = (seq: number, type: string, x: any = {}) => ({ seq, type, at: new Date(2026, 0, 1, 0, 0, seq), ...x });
const now = new Date(2026, 0, 1, 1, 0, 0);

describe('derivePayment — current status is the latest status event; confirmed is final', () => {
  it('walks created → presented → pending → confirmed', () => {
    expect(derivePayment([ev(1, 'created')], 100, now).status).toBe('created');
    expect(derivePayment([ev(1, 'created'), ev(2, 'presented')], 100, now).status).toBe('presented');
    expect(derivePayment([ev(1, 'created'), ev(2, 'presented'), ev(3, 'pending')], 100, now).status).toBe('pending');
    const d = derivePayment([ev(1, 'created'), ev(2, 'confirmed')], 100, now);
    expect(d).toMatchObject({ status: 'confirmed', confirmed: true, paidAfterExpiry: false });
  });
  it('is independent of the order the rows are read in', () => {
    expect(derivePayment([ev(3, 'expired'), ev(1, 'created'), ev(2, 'presented')], 100, now).status).toBe('expired');
  });
  it('a paid payment is never moved back by a later expired / failed event', () => {
    const d = derivePayment([ev(1, 'created'), ev(2, 'confirmed'), ev(3, 'expired'), ev(4, 'failed')], 100, now);
    expect(d.status).toBe('confirmed');
  });
  it('confirmed after expired is "paid after expiry" and needs attention until reconciled', () => {
    const base = [ev(1, 'created'), ev(2, 'expired'), ev(3, 'confirmed', { late: true })];
    expect(derivePayment(base, 100, now)).toMatchObject({ status: 'confirmed', paidAfterExpiry: true, attention: ['paid_after_expiry'] });
    expect(derivePayment([...base, ev(4, 'reconciled', { saleId: 's1' })], 100, now)).toMatchObject({ attention: [], saleId: 's1' });
  });
  it('confirmed but never consumed becomes "unattached" only after the grace period', () => {
    const e = [ev(1, 'created'), ev(2, 'confirmed')];
    expect(derivePayment(e, 100, new Date(2026, 0, 1, 0, 0, 30)).attention).toEqual([]);
    expect(derivePayment(e, 100, now).attention).toEqual(['confirmed_unattached']);
    expect(derivePayment([...e, ev(3, 'consumed', { saleId: 'S' })], 100, now)).toMatchObject({ attention: [], consumed: true, saleId: 'S' });
  });
  it('refund bookkeeping: pending, succeeded, failed, partial vs full', () => {
    const base = [ev(1, 'created'), ev(2, 'confirmed', {}), ev(3, 'consumed', { saleId: 'S' })];
    expect(derivePayment([...base, ev(4, 'refund_requested', { refundId: 'a', amountMinor: 40 })], 100, now)).toMatchObject({ refundPendingMinor: 40, refundedMinor: 0, refundStatus: 'pending' });
    expect(derivePayment([...base, ev(4, 'refund_requested', { refundId: 'a', amountMinor: 40 }), ev(5, 'refund_succeeded', { refundId: 'a', amountMinor: 40 })], 100, now)).toMatchObject({ refundedMinor: 40, refundStatus: 'partial' });
    expect(derivePayment([...base, ev(4, 'refund_requested', { refundId: 'a', amountMinor: 100 }), ev(5, 'refund_succeeded', { refundId: 'a', amountMinor: 100 })], 100, now).refundStatus).toBe('full');
    const failed = derivePayment([...base, ev(4, 'refund_requested', { refundId: 'a', amountMinor: 40 }), ev(5, 'refund_failed', { refundId: 'a', amountMinor: 40 })], 100, now);
    expect(failed).toMatchObject({ refundedMinor: 0, refundPendingMinor: 0, attention: ['refund_failed'] });
  });
  it('an amount-mismatch anomaly needs attention until reconciled', () => {
    expect(derivePayment([ev(1, 'created'), ev(2, 'anomaly', { note: 'amount_mismatch' })], 100, now).attention).toEqual(['anomaly']);
  });
});
