/* eslint-disable prettier/prettier */
import { createHmac } from 'crypto';
import { RazorpayPaymentProvider } from './razorpay.provider';
import { DecryptedPaymentConfig, PaymentOrderContext } from '../interfaces/payment-provider.interface';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

describe('RazorpayPaymentProvider', () => {
  const provider = new RazorpayPaymentProvider();
  const realFetch = (globalThis as any).fetch;
  let calls: Call[] = [];
  let routes: Record<string, { status?: number; body: any }> = {};

  const config: DecryptedPaymentConfig = {
    credentials: { keyId: 'rzp_test_abc', keySecret: 'shh', webhookSecret: 'whsec' },
    config: {},
    mode: 'sandbox',
    webhookToken: null,
  };
  const order: PaymentOrderContext = {
    orderId: 'order_12345', amount: 499.5, currency: 'INR', storeId: 's1',
    buyerEmail: 'b@x.com', buyerPhone: '+919876543210', buyerName: 'Buyer',
    returnUrl: 'https://shop.example.com/return', cancelUrl: 'https://shop.example.com/cancel',
  };

  beforeEach(() => {
    calls = [];
    routes = {};
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
      const key = `${init.method ?? 'GET'} ${url.replace('https://api.razorpay.com/v1', '')}`;
      const r = routes[key];
      if (!r) throw new Error(`unrouted ${key}`);
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    };
  });
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  const sign = (raw: string, secret = 'whsec') => createHmac('sha256', secret).update(raw).digest('hex');

  describe('initiatePayment', () => {
    it('creates a payment link in paise with Basic auth and callback fields', async () => {
      routes['POST /payment_links'] = { body: { id: 'plink_1', short_url: 'https://rzp.io/i/abc' } };
      const s = await provider.initiatePayment(order, config);
      expect(s).toEqual({ redirectUrl: 'https://rzp.io/i/abc', sessionId: 'plink_1' });
      const c = calls[0];
      expect(c.headers.Authorization).toBe(`Basic ${Buffer.from('rzp_test_abc:shh').toString('base64')}`);
      expect(c.body.amount).toBe(49950);
      expect(c.body.currency).toBe('INR');
      expect(c.body.callback_url).toBe('https://shop.example.com/return');
      expect(c.body.callback_method).toBe('get');
      expect(c.body.notify).toEqual({ sms: false, email: false });
      expect(c.body.reminder_enable).toBe(false);
      expect(c.body.customer).toMatchObject({ email: 'b@x.com', contact: '+919876543210' });
      expect(c.body.reference_id).toMatch(/^order_12345-[0-9a-f]{8}$/);
      expect(c.body.reference_id.length <= 40).toBeTruthy();
      const nowS = Math.floor(Date.now() / 1000);
      expect(c.body.expire_by > nowS + 15 * 60).toBeTruthy();
    });
    it('uses a different reference id each attempt', async () => {
      routes['POST /payment_links'] = { body: { id: 'plink_1', short_url: 'u' } };
      await provider.initiatePayment(order, config);
      await provider.initiatePayment(order, config);
      expect(calls[0].body.reference_id === calls[1].body.reference_id).toBeFalsy();
    });
    it('throws when Razorpay rejects', async () => {
      routes['POST /payment_links'] = { status: 400, body: { error: { description: 'bad amount' } } };
      await expect(provider.initiatePayment(order, config)).rejects.toThrow('bad amount');
    });
  });

  describe('verifyPayment', () => {
    const get = (body: any) => { routes['GET /payment_links/plink_1'] = { body }; };
    it('paid -> paid with payment id and major-unit amount', async () => {
      get({ id: 'plink_1', status: 'paid', currency: 'INR', amount: 49950, amount_paid: 49950, payments: [{ payment_id: 'pay_9', status: 'captured', amount: 49950 }] });
      const r = await provider.verifyPayment('plink_1', config);
      expect(r).toMatchObject({ status: 'paid', paymentId: 'pay_9', amount: 499.5, currency: 'INR', providerReference: 'plink_1' });
    });
    it('paid without payments array still paid', async () => {
      get({ id: 'plink_1', status: 'paid', currency: 'INR', amount_paid: 100, payments: null });
      const r = await provider.verifyPayment('plink_1', config);
      expect(r.status).toBe('paid');
      expect(r.paymentId).toBeUndefined();
    });
    it('cancelled and expired -> failed', async () => {
      get({ id: 'plink_1', status: 'cancelled', currency: 'INR' });
      expect((await provider.verifyPayment('plink_1', config)).status).toBe('failed');
      get({ id: 'plink_1', status: 'expired', currency: 'INR' });
      expect((await provider.verifyPayment('plink_1', config)).status).toBe('failed');
    });
    it('created and partially_paid -> pending', async () => {
      get({ id: 'plink_1', status: 'created', currency: 'INR' });
      expect((await provider.verifyPayment('plink_1', config)).status).toBe('pending');
      get({ id: 'plink_1', status: 'partially_paid', currency: 'INR', amount_paid: 10 });
      expect((await provider.verifyPayment('plink_1', config)).status).toBe('pending');
    });
    it('throws on HTTP error', async () => {
      routes['GET /payment_links/plink_1'] = { status: 404, body: { error: { description: 'not found' } } };
      await expect(provider.verifyPayment('plink_1', config)).rejects.toThrow('not found');
    });
  });

  describe('handleWebhook', () => {
    const paid = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: 'plink_1', status: 'paid', amount_paid: 49950, currency: 'INR' } },
        payment: { entity: { id: 'pay_9', amount: 49950, currency: 'INR', status: 'captured' } },
      },
    });
    const hdr = (raw: string, extra: Record<string, string> = {}) => ({ 'x-razorpay-signature': sign(raw), ...extra });

    it('valid signature -> payment_succeeded with event id header', async () => {
      const e = await provider.handleWebhook(Buffer.from(paid), hdr(paid, { 'x-razorpay-event-id': 'evt_1' }), config);
      expect(e.type).toBe('payment_succeeded');
      expect(e.externalEventId).toBe('evt_1');
      expect(e.sessionId).toBe('plink_1');
      expect(e.status).toMatchObject({ status: 'paid', paymentId: 'pay_9', amount: 499.5, currency: 'INR' });
    });
    it('falls back to event:entity id without the header', async () => {
      const e = await provider.handleWebhook(Buffer.from(paid), hdr(paid), config);
      expect(e.externalEventId).toBe('payment_link.paid:pay_9');
    });
    it('rejects a tampered body', async () => {
      const sig = sign(paid);
      await expect(provider.handleWebhook(Buffer.from(paid.replace('49950', '1')), { 'x-razorpay-signature': sig }, config)).rejects.toThrow('signature');
    });
    it('rejects a wrong secret', async () => {
      await expect(provider.handleWebhook(Buffer.from(paid), { 'x-razorpay-signature': sign(paid, 'other') }, config)).rejects.toThrow('signature');
    });
    it('rejects a missing header and a missing secret', async () => {
      await expect(provider.handleWebhook(Buffer.from(paid), {}, config)).rejects.toThrow('Missing');
      const noSecret = { ...config, credentials: { keyId: 'a', keySecret: 'b' } };
      await expect(provider.handleWebhook(Buffer.from(paid), hdr(paid), noSecret)).rejects.toThrow('secret');
    });
    it('accepts mixed-case header names', async () => {
      const e = await provider.handleWebhook(Buffer.from(paid), { 'X-Razorpay-Signature': sign(paid) }, config);
      expect(e.type).toBe('payment_succeeded');
    });
    it('cancelled and expired -> payment_failed', async () => {
      for (const ev of ['payment_link.cancelled', 'payment_link.expired']) {
        const raw = JSON.stringify({ event: ev, payload: { payment_link: { entity: { id: 'plink_1', currency: 'INR' } } } });
        const e = await provider.handleWebhook(Buffer.from(raw), hdr(raw), config);
        expect(e.type).toBe('payment_failed');
        expect(e.sessionId).toBe('plink_1');
        expect(e.externalEventId).toBe(`${ev}:plink_1`);
      }
    });
    it('other events -> payment_pending', async () => {
      const raw = JSON.stringify({ event: 'payment.authorized', payload: { payment: { entity: { id: 'pay_1' } } } });
      const e = await provider.handleWebhook(Buffer.from(raw), hdr(raw), config);
      expect(e.type).toBe('payment_pending');
    });
  });

  describe('refund', () => {
    it('processed -> succeeded, sends paise + normal speed', async () => {
      routes['POST /payments/pay_9/refund'] = { body: { id: 'rfnd_1', amount: 20000, currency: 'INR', status: 'processed' } };
      const r = await provider.refund('pay_9', 200, config);
      expect(r).toEqual({ success: true, refundId: 'rfnd_1', amount: 200, status: 'succeeded' });
      expect(calls[0].body).toEqual({ amount: 20000, speed: 'normal' });
    });
    it('pending -> pending success', async () => {
      routes['POST /payments/pay_9/refund'] = { body: { id: 'rfnd_2', amount: 20000, currency: 'INR', status: 'pending' } };
      const r = await provider.refund('pay_9', 200, config);
      expect(r).toMatchObject({ success: true, status: 'pending', refundId: 'rfnd_2' });
    });
    it('rejection returns success:false, never throws', async () => {
      routes['POST /payments/pay_9/refund'] = { status: 400, body: { error: { description: 'too much' } } };
      const r = await provider.refund('pay_9', 200, config);
      expect(r).toMatchObject({ success: false, status: 'failed', amount: 200 });
    });
  });

  describe('testConnection', () => {
    it('ok', async () => {
      routes['GET /payments?count=1'] = { body: { items: [] } };
      const r = await provider.testConnection(config);
      expect(r.ok).toBe(true);
      expect(r.message).toContain('test');
    });
    it('401 mentions the mode', async () => {
      routes['GET /payments?count=1'] = { status: 401, body: { error: { description: 'Authentication failed' } } };
      const r = await provider.testConnection(config);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('test-mode');
    });
  });

  it('getPublicConfig', () => {
    expect(provider.getPublicConfig({})).toEqual({ displayName: 'Razorpay', currency: '', logo: undefined });
  });
});
