/* eslint-disable prettier/prettier */
import { createHmac } from 'crypto';
import { PaystackPaymentProvider, fromPaystackSubunit, toPaystackSubunit } from './paystack.provider';

const SECRET = 'sk_test_abc123';
const CONFIG: any = { mode: 'sandbox', webhookToken: 'tok', config: {}, credentials: { secretKey: SECRET } };
const ORDER: any = { orderId: 'chk_1', amount: 1500.5, currency: 'NGN', storeId: 's1', buyerEmail: 'b@x.com', returnUrl: 'https://shop.solvexo.store/return', cancelUrl: 'https://shop.solvexo.store/cart' };

type Call = { url: string; method: string; body: any; headers: any };

describe('PaystackPaymentProvider', () => {
  const realFetch = (global as any).fetch;
  let calls: Call[];
  let routes: Array<{ match: (url: string, method: string) => boolean; status: number; body: any }>;
  let provider: PaystackPaymentProvider;

  const route = (method: string, urlPart: string, status: number, body: any) =>
    routes.push({ match: (u, m) => m === method && u.includes(urlPart), status, body });

  beforeEach(() => {
    calls = [];
    routes = [];
    provider = new PaystackPaymentProvider();
    (global as any).fetch = async (url: string, init: any) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers });
      const r = routes.find((x) => x.match(url, method));
      if (!r) throw new Error(`unrouted ${method} ${url}`);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    };
  });
  afterEach(() => { (global as any).fetch = realFetch; });

  it('converts to and from the subunit', () => {
    expect(toPaystackSubunit(1500.5)).toBe(150050);
    expect(toPaystackSubunit(19.99)).toBe(1999);
    expect(fromPaystackSubunit(150050)).toBe(1500.5);
  });

  it('identifies itself', () => {
    expect(provider.providerKey).toBe('paystack');
    expect(provider.callbackIsAuthoritative).toBe(false);
    expect(provider.getPublicConfig({})).toEqual({ displayName: 'Paystack', currency: '', logo: undefined });
  });

  describe('initiatePayment', () => {
    it('needs the buyer email', async () => {
      await expect(provider.initiatePayment({ ...ORDER, buyerEmail: undefined }, CONFIG)).rejects.toThrow('buyer email');
    });
    it('posts kobo amount, reference and metadata, returns the hosted URL', async () => {
      route('POST', '/transaction/initialize', 200, { status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', access_code: 'abc', reference: 'ignored-by-test' } });
      const s = await provider.initiatePayment(ORDER, CONFIG);
      expect(s.redirectUrl).toBe('https://checkout.paystack.com/abc');
      const c = calls[0];
      expect(c.url).toBe('https://api.paystack.co/transaction/initialize');
      expect(c.headers.Authorization).toBe(`Bearer ${SECRET}`);
      expect(c.body.amount).toBe(150050);
      expect(c.body.currency).toBe('NGN');
      expect(c.body.email).toBe('b@x.com');
      expect(c.body.callback_url).toBe(ORDER.returnUrl);
      expect(c.body.metadata).toEqual({ checkoutId: 'chk_1', storeId: 's1' });
      expect(c.body.reference).toMatch(/^chk1-[0-9a-f]{12}$/);
    });
    it('uses only allowed reference characters and a fresh reference per attempt', async () => {
      route('POST', '/transaction/initialize', 200, { status: true, data: { authorization_url: 'u', reference: 'r' } });
      await provider.initiatePayment({ ...ORDER, orderId: 'a b/c_d' }, CONFIG);
      await provider.initiatePayment({ ...ORDER, orderId: 'a b/c_d' }, CONFIG);
      expect(calls[0].body.reference).toMatch(/^[A-Za-z0-9\-.=]+$/);
      expect(calls[0].body.reference === calls[1].body.reference).toBe(false);
    });
    it('throws on an API error', async () => {
      route('POST', '/transaction/initialize', 400, { status: false, message: 'Invalid key' });
      await expect(provider.initiatePayment(ORDER, CONFIG)).rejects.toThrow('Invalid key');
    });
  });

  describe('verifyPayment', () => {
    it('success => paid, major amount, currency, payment id', async () => {
      route('GET', '/transaction/verify/', 200, { status: true, data: { status: 'success', id: 4099260516, amount: 150050, currency: 'NGN' } });
      const r = await provider.verifyPayment('ref 1', CONFIG);
      expect(r).toMatchObject({ status: 'paid', amount: 1500.5, currency: 'NGN', paymentId: '4099260516', providerReference: 'ref 1' });
      expect(calls[0].url).toBe('https://api.paystack.co/transaction/verify/ref%201');
    });
    it('failed and abandoned => failed', async () => {
      route('GET', '/transaction/verify/', 200, { status: true, data: { status: 'failed', id: 1, amount: 100, currency: 'NGN' } });
      expect((await provider.verifyPayment('r', CONFIG)).status).toBe('failed');
      routes = [];
      route('GET', '/transaction/verify/', 200, { status: true, data: { status: 'abandoned', id: 1, amount: 100, currency: 'NGN' } });
      expect((await provider.verifyPayment('r', CONFIG)).status).toBe('failed');
    });
    it('ongoing => pending', async () => {
      route('GET', '/transaction/verify/', 200, { status: true, data: { status: 'ongoing', id: 1, amount: 100, currency: 'NGN' } });
      const r = await provider.verifyPayment('r', CONFIG);
      expect(r.status).toBe('pending');
      expect(r.amount).toBeUndefined();
    });
    it('reference not found => pending', async () => {
      route('GET', '/transaction/verify/', 404, { status: false, message: 'Transaction reference not found' });
      expect((await provider.verifyPayment('r', CONFIG)).status).toBe('pending');
    });
    it('other HTTP errors throw', async () => {
      route('GET', '/transaction/verify/', 500, { status: false, message: 'boom' });
      await expect(provider.verifyPayment('r', CONFIG)).rejects.toThrow('500');
    });
  });

  describe('handleWebhook', () => {
    const body = (o: any) => Buffer.from(JSON.stringify(o));
    const sign = (raw: Buffer) => createHmac('sha512', SECRET).update(raw).digest('hex');
    const success = { event: 'charge.success', data: { id: 77, reference: 'chk_1-abc', amount: 150050, currency: 'NGN', status: 'success' } };

    it('accepts a valid signature and maps charge.success', async () => {
      const raw = body(success);
      const e = await provider.handleWebhook(raw, { 'x-paystack-signature': sign(raw) }, CONFIG);
      expect(e.type).toBe('payment_succeeded');
      expect(e.externalEventId).toBe('charge.success:77');
      expect(e.sessionId).toBe('chk_1-abc');
      expect(e.status).toMatchObject({ status: 'paid', amount: 1500.5, currency: 'NGN', paymentId: '77' });
    });
    it('rejects a tampered body', async () => {
      const raw = body(success);
      const sig = sign(raw);
      const tampered = body({ ...success, data: { ...success.data, amount: 1 } });
      await expect(provider.handleWebhook(tampered, { 'x-paystack-signature': sig }, CONFIG)).rejects.toThrow('mismatch');
    });
    it('rejects a missing or wrong-length signature', async () => {
      const raw = body(success);
      await expect(provider.handleWebhook(raw, {}, CONFIG)).rejects.toThrow('Missing');
      await expect(provider.handleWebhook(raw, { 'x-paystack-signature': 'abcd' }, CONFIG)).rejects.toThrow('mismatch');
    });
    it('maps charge.failed and other events', async () => {
      const f = body({ event: 'charge.failed', data: { id: 5, reference: 'r1', currency: 'NGN' } });
      expect((await provider.handleWebhook(f, { 'x-paystack-signature': sign(f) }, CONFIG)).type).toBe('payment_failed');
      const o = body({ event: 'transfer.success', data: { id: 6, reference: 'r2' } });
      const e = await provider.handleWebhook(o, { 'x-paystack-signature': sign(o) }, CONFIG);
      expect(e.type).toBe('payment_pending');
      expect(e.externalEventId).toBe('transfer.success:6');
    });
  });

  describe('refund', () => {
    it('pending/processing => pending', async () => {
      route('POST', '/refund', 200, { status: true, data: { id: 555, status: 'pending' } });
      const r = await provider.refund('4099260516', 10.25, CONFIG);
      expect(r).toEqual({ success: true, refundId: '555', amount: 10.25, status: 'pending' });
      expect(calls[0].body).toEqual({ transaction: '4099260516', amount: 1025 });
    });
    it('processed => succeeded', async () => {
      route('POST', '/refund', 200, { status: true, data: { id: 556, status: 'processed' } });
      expect((await provider.refund('x', 5, CONFIG)).status).toBe('succeeded');
    });
    it('rejection => success false, never throws', async () => {
      route('POST', '/refund', 400, { status: false, message: 'Transaction has already been fully reversed' });
      expect(await provider.refund('x', 5, CONFIG)).toEqual({ success: false, refundId: '', amount: 5, status: 'failed' });
    });
  });

  describe('testConnection', () => {
    it('ok', async () => {
      route('GET', '/bank', 200, { status: true, data: [] });
      const r = await provider.testConnection(CONFIG);
      expect(r.ok).toBe(true);
      expect(r.message).toContain('test');
    });
    it('401 gives a clear message', async () => {
      route('GET', '/bank', 401, { status: false, message: 'Invalid key' });
      const r = await provider.testConnection(CONFIG);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('rejected');
    });
  });
});
