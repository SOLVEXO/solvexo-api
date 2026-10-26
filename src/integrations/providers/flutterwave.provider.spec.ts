/* eslint-disable prettier/prettier */
import { FlutterwavePaymentProvider } from './flutterwave.provider';

type Call = { url: string; method: string; body: any; headers: any };

describe('FlutterwavePaymentProvider', () => {
  const provider = new FlutterwavePaymentProvider();
  const realFetch = (global as any).fetch;
  let calls: Call[] = [];
  let reply: { status: number; body: any } = { status: 200, body: {} };

  const config: any = { credentials: { secretKey: 'FLWSECK_TEST-abc', webhookSecret: 'hash123' }, config: {}, mode: 'sandbox', webhookToken: null };
  const order: any = { orderId: 'chk_1234567890abcdef', amount: 25.5, currency: 'ngn', storeId: 's1', buyerEmail: 'a@b.com', buyerPhone: '0800', buyerName: 'Ada', returnUrl: 'https://shop.test/return', cancelUrl: 'https://shop.test/cancel' };

  beforeEach(() => {
    calls = [];
    reply = { status: 200, body: {} };
    (global as any).fetch = async (url: string, init: any) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers });
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => JSON.parse(text), text: async () => text };
    };
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  const hook = (event: any, hash: string | null = 'hash123') => {
    const headers: Record<string, string> = hash === null ? {} : { 'verif-hash': hash };
    return { raw: Buffer.from(JSON.stringify(event)), headers };
  };

  describe('initiatePayment', () => {
    it('requires the buyer email', async () => {
      await expect(provider.initiatePayment({ ...order, buyerEmail: undefined }, config)).rejects.toThrow('buyer email');
    });
    it('posts the payment body and returns the link', async () => {
      reply = { status: 200, body: { status: 'success', data: { link: 'https://checkout.flutterwave.com/v3/hosted/pay/xyz' } } };
      const s = await provider.initiatePayment(order, config);
      expect(s.redirectUrl).toBe('https://checkout.flutterwave.com/v3/hosted/pay/xyz');
      expect(s.sessionId).toMatch(/^SX-/);
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.flutterwave.com/v3/payments');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].headers.Authorization).toBe('Bearer FLWSECK_TEST-abc');
      expect(calls[0].body).toMatchObject({ tx_ref: s.sessionId, amount: 25.5, currency: 'NGN', redirect_url: 'https://shop.test/return', meta: { checkoutId: order.orderId, storeId: 's1' } });
      expect(calls[0].body.customer.email).toBe('a@b.com');
    });
    it('throws when no link comes back', async () => {
      reply = { status: 200, body: { status: 'success', data: {} } };
      await expect(provider.initiatePayment(order, config)).rejects.toThrow('payment link');
    });
    it('throws on HTTP errors', async () => {
      reply = { status: 401, body: { message: 'Invalid authorization key' } };
      await expect(provider.initiatePayment(order, config)).rejects.toThrow('HTTP 401');
    });
  });

  describe('verifyPayment', () => {
    it('maps successful to paid', async () => {
      reply = { status: 200, body: { status: 'success', data: { id: 99, status: 'successful', amount: 25.5, currency: 'NGN' } } };
      const r = await provider.verifyPayment('SX-1 a', config);
      expect(r).toMatchObject({ status: 'paid', paymentId: '99', amount: 25.5, currency: 'NGN', providerReference: 'SX-1 a' });
      expect(calls[0].url).toBe('https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=SX-1%20a');
    });
    it('maps failed and cancelled to failed', async () => {
      reply = { status: 200, body: { data: { id: 1, status: 'failed' } } };
      expect((await provider.verifyPayment('r', config)).status).toBe('failed');
      reply = { status: 200, body: { data: { id: 1, status: 'cancelled' } } };
      expect((await provider.verifyPayment('r', config)).status).toBe('failed');
    });
    it('maps pending to pending', async () => {
      reply = { status: 200, body: { data: { id: 1, status: 'pending' } } };
      expect((await provider.verifyPayment('r', config)).status).toBe('pending');
    });
    it('treats not found as pending', async () => {
      reply = { status: 404, body: { status: 'error', message: 'No transaction was found for this id' } };
      expect((await provider.verifyPayment('r', config)).status).toBe('pending');
      reply = { status: 200, body: { status: 'error', message: 'No transaction was found for this id', data: null } };
      expect((await provider.verifyPayment('r', config)).status).toBe('pending');
    });
    it('throws on auth errors', async () => {
      reply = { status: 401, body: {} };
      await expect(provider.verifyPayment('r', config)).rejects.toThrow('rejected');
    });
  });

  describe('handleWebhook', () => {
    const ok = { event: 'charge.completed', data: { id: 7, tx_ref: 'SX-1', status: 'successful', amount: 10, currency: 'ngn' } };
    it('accepts the right hash', async () => {
      const h = hook(ok);
      const e = await provider.handleWebhook(h.raw, h.headers, config);
      expect(e.type).toBe('payment_succeeded');
      expect(e.sessionId).toBe('SX-1');
      expect(e.externalEventId).toBe('charge.completed:7:successful');
      expect(e.status).toMatchObject({ status: 'paid', paymentId: '7', amount: 10, currency: 'NGN' });
    });
    it('rejects a wrong hash', async () => {
      const h = hook(ok, 'nope');
      await expect(provider.handleWebhook(h.raw, h.headers, config)).rejects.toThrow('Invalid');
    });
    it('rejects a missing header', async () => {
      const h = hook(ok, null);
      await expect(provider.handleWebhook(h.raw, h.headers, config)).rejects.toThrow('verif-hash');
    });
    it('rejects when no secret is configured', async () => {
      const h = hook(ok);
      await expect(provider.handleWebhook(h.raw, h.headers, { ...config, credentials: { secretKey: 'k' } })).rejects.toThrow('not configured');
    });
    it('maps failed and other statuses', async () => {
      let h = hook({ event: 'charge.completed', data: { id: 8, tx_ref: 'SX-2', status: 'failed' } });
      expect((await provider.handleWebhook(h.raw, h.headers, config)).type).toBe('payment_failed');
      h = hook({ event: 'charge.completed', data: { id: 9, tx_ref: 'SX-3', status: 'pending' } });
      expect((await provider.handleWebhook(h.raw, h.headers, config)).type).toBe('payment_pending');
    });
    it('treats other events as pending', async () => {
      const h = hook({ event: 'transfer.completed', data: { id: 5, status: 'successful' } });
      expect((await provider.handleWebhook(h.raw, h.headers, config)).type).toBe('payment_pending');
    });
  });

  describe('refund', () => {
    it('completed is succeeded', async () => {
      reply = { status: 200, body: { status: 'success', data: { id: 55, status: 'completed' } } };
      const r = await provider.refund('99', 10, config);
      expect(r).toEqual({ success: true, refundId: '55', amount: 10, status: 'succeeded' });
      expect(calls[0].url).toBe('https://api.flutterwave.com/v3/transactions/99/refund');
      expect(calls[0].body).toEqual({ amount: 10 });
    });
    it('pending is pending', async () => {
      reply = { status: 200, body: { status: 'success', data: { id: 56, status: 'pending-bank-transfer' } } };
      const r = await provider.refund('99', 10, config);
      expect(r.status).toBe('pending');
      expect(r.success).toBe(true);
    });
    it('rejection returns failure without throwing', async () => {
      reply = { status: 400, body: { status: 'error', message: 'Amount below minimum' } };
      const r = await provider.refund('99', 1, config);
      expect(r).toEqual({ success: false, refundId: '', amount: 1, status: 'failed' });
    });
  });

  describe('testConnection', () => {
    it('ok with a valid key', async () => {
      reply = { status: 200, body: { status: 'success', data: [] } };
      const r = await provider.testConnection(config);
      expect(r.ok).toBe(true);
      expect(calls[0].url).toBe('https://api.flutterwave.com/v3/balances');
    });
    it('clear message on 401', async () => {
      reply = { status: 401, body: {} };
      const r = await provider.testConnection(config);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/secret key/);
    });
  });

  it('getPublicConfig', () => {
    expect(provider.getPublicConfig({})).toEqual({ displayName: 'Flutterwave', currency: '', logo: undefined });
  });
});
