/* eslint-disable prettier/prettier */
import { QisstpayPaymentProvider, installmentMessage } from './qisstpay.provider';
import { catalogEntry } from '../payment-provider-catalog';
import { paymentAvailability } from '../payment-availability.util';

describe('Qisstpay (disabled, unverified)', () => {
  const p = new QisstpayPaymentProvider();
  it('never charges and never claims a working connection', async () => {
    expect(p.verified).toBe(false);
    expect((await p.testConnection({} as any)).ok).toBe(false);
    await expect(p.initiatePayment({} as any, {} as any)).rejects.toThrow(/not available yet/);
    await expect(p.verifyPayment('x', {} as any)).rejects.toThrow(/not available yet/);
    await expect(p.handleWebhook(Buffer.from(''), {}, {} as any)).rejects.toThrow(/not available yet/);
  });
  it('is flagged unverified in the catalog (so it cannot be connected)', () => { expect(catalogEntry('qisstpay')?.unverified).toBe(true); });
  it('is a Pakistan-only provider', () => {
    expect(paymentAvailability('qisstpay', 'PK').available).toBe(true);
    expect(paymentAvailability('qisstpay', 'US').available).toBe(false);
  });
  it('installment wording states no fee and rounds up', () => {
    expect(installmentMessage(1000, 'PKR', 3)).toBe('Or pay in 3 installments of PKR 333.34');
    expect(installmentMessage(0, 'PKR')).toBeNull();
  });
});
