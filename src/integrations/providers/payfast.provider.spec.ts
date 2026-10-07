/* eslint-disable prettier/prettier */
import { createHash } from 'crypto';
import { PayFastPaymentProvider } from './payfast.provider';
import { DecryptedPaymentConfig } from '../interfaces/payment-provider.interface';

const CONFIG: DecryptedPaymentConfig = {
  credentials: { merchantId: 'M1', securedKey: 'KEY' },
  config: { merchantName: 'Shop' }, mode: 'sandbox', webhookToken: 'tok',
};

function ipn(fields: Record<string, string>, errCode = '000') {
  const hash = createHash('sha256').update(`${fields.basket_id}|KEY|M1|${errCode}`).digest('hex');
  return Buffer.from(new URLSearchParams({ ...fields, err_code: errCode, validation_hash: hash }).toString());
}

describe('PayFastPaymentProvider', () => {
  const provider = new PayFastPaymentProvider();
  afterEach(() => { (global as any).fetch = undefined; });

  it('validation hash = sha256(basket|key|merchant|err_code)', () => {
    expect(PayFastPaymentProvider.computeValidationHash('B1', 'KEY', 'M1', '000')).toBe(createHash('sha256').update('B1|KEY|M1|000').digest('hex'));
  });

  it('accepts a valid approved IPN but reports NO amount (not covered by the hash)', async () => {
    const ev = await provider.handleWebhook(ipn({ basket_id: 'B1', transaction_id: 't1', transaction_amount: '1.00' }), {}, CONFIG);
    expect(ev.type).toBe('payment_succeeded');
    expect(ev.sessionId).toBe('B1');
    expect(ev.status.amount).toBeUndefined();
  });

  it('maps a non-000 err_code to payment_failed', async () => {
    const ev = await provider.handleWebhook(ipn({ basket_id: 'B1' }, '106'), {}, CONFIG);
    expect(ev.type).toBe('payment_failed');
  });

  it('REGRESSION: forged IPN (changed err_code / missing hash) is rejected', async () => {
    const params = new URLSearchParams(ipn({ basket_id: 'B1' }, '106').toString());
    params.set('err_code', '000');
    await expect(provider.handleWebhook(Buffer.from(params.toString()), {}, CONFIG)).rejects.toThrow('mismatch');
    await expect(provider.handleWebhook(Buffer.from('basket_id=B1&err_code=000'), {}, CONFIG)).rejects.toThrow('mismatch');
  });

  it('initiatePayment fetches a token then returns the hosted form with our IPN url', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ACCESS_TOKEN: 'tkn' }), text: () => Promise.resolve('') });
    const s = await provider.initiatePayment({ orderId: 'c1', amount: 99.5, currency: 'PKR', storeId: 's', buyerPhone: '0300', returnUrl: 'https://x/r', cancelUrl: 'https://x/c' }, CONFIG);
    expect((global as any).fetch.mock.calls[0][0]).toContain('ipguat.apps.net.pk/Ecommerce/api/Transaction/GetAccessToken');
    expect(s.formFields!.TOKEN).toBe('tkn');
    expect(s.formFields!.TXNAMT).toBe('99.5');
    expect(s.formFields!.CHECKOUT_URL).toContain('/webhooks/payments/payfast/tok');
    expect(s.sessionId).toBe(s.formFields!.BASKET_ID);
  });

  it('requires the buyer mobile number', async () => {
    await expect(provider.initiatePayment({ orderId: 'c', amount: 1, currency: 'PKR', storeId: 's', returnUrl: 'a', cancelUrl: 'b' }, CONFIG)).rejects.toThrow('mobile');
  });

  it('testConnection reports a token failure honestly', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('bad') });
    const r = await provider.testConnection(CONFIG);
    expect(r.ok).toBe(false);
  });
});
