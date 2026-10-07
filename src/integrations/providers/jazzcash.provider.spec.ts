/* eslint-disable prettier/prettier */
import { createHmac } from 'crypto';
import { JazzCashPaymentProvider } from './jazzcash.provider';
import { DecryptedPaymentConfig } from '../interfaces/payment-provider.interface';

const SALT = 'salt123';
const CONFIG: DecryptedPaymentConfig = {
  credentials: { merchantId: 'MC1', password: 'pw', integritySalt: SALT },
  config: {}, mode: 'sandbox', webhookToken: 'tok',
};

function signed(fields: Record<string, string>) {
  return new URLSearchParams({ ...fields, pp_SecureHash: JazzCashPaymentProvider.computeSecureHash(fields, SALT) }).toString();
}

describe('JazzCashPaymentProvider', () => {
  const provider = new JazzCashPaymentProvider();

  it('computes the secure hash: HMAC-SHA256(salt) over salt + sorted non-empty pp_ values, upper-case hex', () => {
    const fields = { pp_Version: '1.1', pp_Amount: '1000', pp_Empty: '', pp_MerchantID: 'MC1', other: 'ignored' };
    const expected = createHmac('sha256', SALT).update(`${SALT}&1000&MC1&1.1`).digest('hex').toUpperCase();
    expect(JazzCashPaymentProvider.computeSecureHash(fields, SALT)).toBe(expected);
  });

  it('initiatePayment returns a signed form in paisa for the right host, with our return route', async () => {
    const s = await provider.initiatePayment({ orderId: 'c1', amount: 150.5, currency: 'PKR', storeId: 's', returnUrl: 'https://x/r', cancelUrl: 'https://x/c' }, CONFIG);
    expect(s.redirectUrl).toContain('sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform');
    expect(s.formFields!.pp_Amount).toBe('15050');
    expect(s.formFields!.pp_ReturnURL).toContain('/webhooks/payments/jazzcash/tok/return');
    expect(s.sessionId).toBe(s.formFields!.pp_TxnRefNo);
    expect(JazzCashPaymentProvider.verifySecureHash(s.formFields!, SALT)).toBe(true);
  });

  it('rejects non-PKR', async () => {
    await expect(provider.initiatePayment({ orderId: 'c', amount: 1, currency: 'USD', storeId: 's', returnUrl: 'a', cancelUrl: 'b' }, CONFIG)).rejects.toThrow('PKR');
  });

  it('accepts a correctly signed success callback and maps amount from paisa', async () => {
    const body = signed({ pp_TxnRefNo: 'T1', pp_ResponseCode: '000', pp_Amount: '15050', pp_TxnCurrency: 'PKR' });
    const ev = await provider.handleWebhook(Buffer.from(body), {}, CONFIG);
    expect(ev.type).toBe('payment_succeeded');
    expect(ev.sessionId).toBe('T1');
    expect(ev.status.amount).toBe(150.5);
    expect(ev.status.currency).toBe('PKR');
  });

  it('REGRESSION: a tampered amount (hash computed for another amount) is rejected', async () => {
    const params = new URLSearchParams(signed({ pp_TxnRefNo: 'T1', pp_ResponseCode: '000', pp_Amount: '100' }));
    params.set('pp_Amount', '1');
    await expect(provider.handleWebhook(Buffer.from(params.toString()), {}, CONFIG)).rejects.toThrow('mismatch');
  });

  it('rejects a callback without / with a wrong hash', async () => {
    await expect(provider.handleWebhook(Buffer.from('pp_TxnRefNo=T1&pp_ResponseCode=000'), {}, CONFIG)).rejects.toThrow('Missing pp_SecureHash');
    await expect(provider.handleWebhook(Buffer.from('pp_TxnRefNo=T1&pp_ResponseCode=000&pp_SecureHash=ABC'), {}, CONFIG)).rejects.toThrow('mismatch');
  });

  it('maps response codes: 000 paid, 121/124 pending, others failed', () => {
    expect(JazzCashPaymentProvider.mapResponseCode('000')).toBe('paid');
    expect(JazzCashPaymentProvider.mapResponseCode('124')).toBe('pending');
    expect(JazzCashPaymentProvider.mapResponseCode('121')).toBe('pending');
    expect(JazzCashPaymentProvider.mapResponseCode('157')).toBe('failed');
  });

  it('a pending callback never finalizes and a failed one is payment_failed', async () => {
    const p = await provider.handleWebhook(Buffer.from(signed({ pp_TxnRefNo: 'T2', pp_ResponseCode: '124' })), {}, CONFIG);
    expect(p.type).toBe('payment_pending');
    const f = await provider.handleWebhook(Buffer.from(signed({ pp_TxnRefNo: 'T3', pp_ResponseCode: '999' })), {}, CONFIG);
    expect(f.type).toBe('payment_failed');
  });
});
