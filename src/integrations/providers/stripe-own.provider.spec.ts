/* eslint-disable prettier/prettier */
import { createHmac } from 'crypto';
import { StripeOwnPaymentProvider } from './stripe-own.provider';

describe('StripeOwnPaymentProvider', () => {
  const SECRET = 'whsec_test_secret';
  const CONFIG: any = { mode: 'sandbox', webhookToken: 'tok', config: {}, credentials: { secretKey: 'sk_test_abc', webhookSecret: SECRET } };
  const ORDER: any = { orderId: 'chk_123', amount: 12.5, currency: 'USD', storeId: 's1', buyerEmail: 'b@x.com', returnUrl: 'https://shop.solvexo.store/checkout/chk_123/return', cancelUrl: 'https://shop.solvexo.store/checkout' };

  let provider: StripeOwnPaymentProvider;
  let calls: { url: string; init: any }[] = [];
  let queue: any[] = [];
  const realFetch = (global as any).fetch;

  const respond = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const form = (c: { init: any }) => new URLSearchParams(String(c.init.body));

  beforeEach(() => {
    provider = new StripeOwnPaymentProvider();
    calls = [];
    queue = [];
    (global as any).fetch = async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next ?? respond(200, {});
    };
  });
  afterEach(() => { (global as any).fetch = realFetch; });

  const sign = (body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')},v0=deadbeef`;
  const event = (type: string, obj: any, id = 'evt_1') => Buffer.from(JSON.stringify({ id, type, data: { object: obj } }));

  describe('initiatePayment', () => {
    it('creates a hosted Checkout Session with the seller key', async () => {
      queue.push(respond(200, { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' }));
      const s = await provider.initiatePayment(ORDER, CONFIG);
      expect(s).toEqual({ redirectUrl: 'https://checkout.stripe.com/c/pay/cs_test_1', sessionId: 'cs_test_1' });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
      expect(calls[0].init.method).toBe('POST');
      expect(calls[0].init.headers.Authorization).toBe('Bearer sk_test_abc');
      expect(calls[0].init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
      const f = form(calls[0]);
      expect(f.get('mode')).toBe('payment');
      expect(f.get('line_items[0][price_data][currency]')).toBe('usd');
      expect(f.get('line_items[0][price_data][unit_amount]')).toBe('1250');
      expect(f.get('line_items[0][quantity]')).toBe('1');
      expect(f.get('line_items[0][price_data][product_data][name]')).toBe('Order chk_123');
      expect(f.get('success_url')).toBe('https://shop.solvexo.store/checkout/chk_123/return?session_id={CHECKOUT_SESSION_ID}');
      expect(f.get('cancel_url')).toBe(ORDER.cancelUrl);
      expect(f.get('client_reference_id')).toBe('chk_123');
      expect(f.get('customer_email')).toBe('b@x.com');
      expect(f.get('metadata[checkoutId]')).toBe('chk_123');
      expect(f.get('metadata[storeId]')).toBe('s1');
    });

    it('uses whole units for zero-decimal JPY and appends with & when the return url has a query', async () => {
      queue.push(respond(200, { id: 'cs_2', url: 'https://u' }));
      await provider.initiatePayment({ ...ORDER, amount: 1500, currency: 'JPY', buyerEmail: undefined, returnUrl: 'https://s.example/return?x=1' }, CONFIG);
      const f = form(calls[0]);
      expect(f.get('line_items[0][price_data][currency]')).toBe('jpy');
      expect(f.get('line_items[0][price_data][unit_amount]')).toBe('1500');
      expect(f.get('success_url')).toBe('https://s.example/return?x=1&session_id={CHECKOUT_SESSION_ID}');
      expect(f.get('customer_email')).toBeNull();
    });

    it('throws with Stripe error message on non-2xx', async () => {
      queue.push(respond(400, { error: { message: 'Invalid currency' } }));
      await expect(provider.initiatePayment(ORDER, CONFIG)).rejects.toThrow('Invalid currency');
    });
  });

  describe('verifyPayment', () => {
    it('maps a paid session with amount, currency and payment intent id', async () => {
      queue.push(respond(200, { id: 'cs_1', payment_status: 'paid', status: 'complete', amount_total: 1250, currency: 'usd', payment_intent: { id: 'pi_9' } }));
      const r = await provider.verifyPayment('cs_1', CONFIG);
      expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1?expand[]=payment_intent');
      expect(calls[0].init.method).toBe('GET');
      expect(r).toMatchObject({ status: 'paid', providerReference: 'cs_1', paymentId: 'pi_9', amount: 12.5, currency: 'USD' });
    });
    it('maps zero-decimal amounts back correctly', async () => {
      queue.push(respond(200, { id: 'cs_1', payment_status: 'paid', amount_total: 1500, currency: 'jpy', payment_intent: 'pi_1' }));
      const r = await provider.verifyPayment('cs_1', CONFIG);
      expect(r.amount).toBe(1500);
      expect(r.paymentId).toBe('pi_1');
    });
    it('unpaid open session is pending', async () => {
      queue.push(respond(200, { id: 'cs_1', payment_status: 'unpaid', status: 'open', amount_total: 100, currency: 'usd' }));
      expect((await provider.verifyPayment('cs_1', CONFIG)).status).toBe('pending');
    });
    it('no_payment_required is pending', async () => {
      queue.push(respond(200, { id: 'cs_1', payment_status: 'no_payment_required', status: 'complete', amount_total: 0, currency: 'usd' }));
      expect((await provider.verifyPayment('cs_1', CONFIG)).status).toBe('pending');
    });
    it('expired session is failed', async () => {
      queue.push(respond(200, { id: 'cs_1', payment_status: 'unpaid', status: 'expired', amount_total: 100, currency: 'usd' }));
      expect((await provider.verifyPayment('cs_1', CONFIG)).status).toBe('failed');
    });
    it('throws on gateway error', async () => {
      queue.push(respond(404, { error: { message: 'No such checkout.session' } }));
      await expect(provider.verifyPayment('cs_x', CONFIG)).rejects.toThrow('No such checkout.session');
    });
  });

  describe('handleWebhook', () => {
    const paidSession = { id: 'cs_1', payment_status: 'paid', status: 'complete', amount_total: 1250, currency: 'usd', payment_intent: 'pi_1' };

    it('accepts a valid signature and maps a paid completed event', async () => {
      const body = event('checkout.session.completed', paidSession, 'evt_42');
      const e = await provider.handleWebhook(body, { 'stripe-signature': sign(body.toString()) }, CONFIG);
      expect(e.type).toBe('payment_succeeded');
      expect(e.externalEventId).toBe('evt_42');
      expect(e.sessionId).toBe('cs_1');
      expect(e.status).toMatchObject({ status: 'paid', amount: 12.5, currency: 'USD', paymentId: 'pi_1' });
    });
    it('accepts when one of several v1 signatures matches', async () => {
      const body = event('checkout.session.completed', paidSession);
      const t = Math.floor(Date.now() / 1000);
      const good = createHmac('sha256', SECRET).update(`${t}.${body.toString()}`).digest('hex');
      const e = await provider.handleWebhook(body, { 'stripe-signature': `t=${t},v1=${'0'.repeat(64)},v1=${good}` }, CONFIG);
      expect(e.type).toBe('payment_succeeded');
    });
    it('rejects a tampered body', async () => {
      const body = event('checkout.session.completed', paidSession);
      const sig = sign(body.toString());
      const tampered = event('checkout.session.completed', { ...paidSession, amount_total: 1 });
      await expect(provider.handleWebhook(tampered, { 'stripe-signature': sig }, CONFIG)).rejects.toThrow('signature');
    });
    it('rejects a wrong secret', async () => {
      const body = event('checkout.session.completed', paidSession);
      await expect(provider.handleWebhook(body, { 'stripe-signature': sign(body.toString(), 'whsec_other') }, CONFIG)).rejects.toThrow('signature');
    });
    it('rejects a stale timestamp even with a valid signature', async () => {
      const body = event('checkout.session.completed', paidSession);
      const old = Math.floor(Date.now() / 1000) - 600;
      await expect(provider.handleWebhook(body, { 'stripe-signature': sign(body.toString(), SECRET, old) }, CONFIG)).rejects.toThrow('timestamp');
    });
    it('rejects a missing header', async () => {
      const body = event('checkout.session.completed', paidSession);
      await expect(provider.handleWebhook(body, {}, CONFIG)).rejects.toThrow('Stripe-Signature');
    });
    it('rejects when the webhook secret is not configured', async () => {
      const body = event('checkout.session.completed', paidSession);
      await expect(provider.handleWebhook(body, { 'stripe-signature': sign(body.toString()) }, { ...CONFIG, credentials: { secretKey: 'sk_test_abc' } })).rejects.toThrow('secret');
    });
    it('rejects a v0-only header', async () => {
      const body = event('checkout.session.completed', paidSession);
      await expect(provider.handleWebhook(body, { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v0=abc` }, CONFIG)).rejects.toThrow('Malformed');
    });

    const run = async (type: string, obj: any) => {
      const body = event(type, obj);
      return provider.handleWebhook(body, { 'stripe-signature': sign(body.toString()) }, CONFIG);
    };
    it('completed + unpaid (delayed method) is pending', async () => {
      const e = await run('checkout.session.completed', { ...paidSession, payment_status: 'unpaid' });
      expect(e.type).toBe('payment_pending');
      expect(e.status.status).toBe('pending');
    });
    it('async_payment_succeeded is succeeded', async () => {
      const e = await run('checkout.session.async_payment_succeeded', { ...paidSession, payment_status: 'paid' });
      expect(e.type).toBe('payment_succeeded');
      expect(e.status.status).toBe('paid');
    });
    it('async_payment_failed is failed', async () => {
      const e = await run('checkout.session.async_payment_failed', { ...paidSession, payment_status: 'unpaid' });
      expect(e.type).toBe('payment_failed');
      expect(e.status.status).toBe('failed');
    });
    it('expired is failed', async () => {
      const e = await run('checkout.session.expired', { ...paidSession, payment_status: 'unpaid', status: 'expired' });
      expect(e.type).toBe('payment_failed');
    });
    it('unknown events are pending', async () => {
      const e = await run('customer.created', { id: 'cus_1' });
      expect(e.type).toBe('payment_pending');
    });
  });

  describe('refund', () => {
    it('reads the payment intent currency then refunds in minor units', async () => {
      queue.push(respond(200, { id: 'pi_1', currency: 'usd' }), respond(200, { id: 're_1', status: 'succeeded' }));
      const r = await provider.refund('pi_1', 5.25, CONFIG);
      expect(r).toEqual({ success: true, refundId: 're_1', amount: 5.25, status: 'succeeded' });
      expect(calls[0].url).toBe('https://api.stripe.com/v1/payment_intents/pi_1');
      expect(calls[1].url).toBe('https://api.stripe.com/v1/refunds');
      const f = form(calls[1]);
      expect(f.get('payment_intent')).toBe('pi_1');
      expect(f.get('amount')).toBe('525');
    });
    it('uses whole units for a JPY payment', async () => {
      queue.push(respond(200, { id: 'pi_1', currency: 'jpy' }), respond(200, { id: 're_1', status: 'pending' }));
      const r = await provider.refund('pi_1', 300, CONFIG);
      expect(form(calls[1]).get('amount')).toBe('300');
      expect(r.status).toBe('pending');
      expect(r.success).toBe(true);
    });
    it('resolves a checkout session id (cs_...) to its payment intent', async () => {
      queue.push(respond(200, { id: 'cs_1', payment_intent: 'pi_7' }), respond(200, { id: 'pi_7', currency: 'eur' }), respond(200, { id: 're_2', status: 'succeeded' }));
      const r = await provider.refund('cs_1', 2, CONFIG);
      expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1');
      expect(calls[1].url).toBe('https://api.stripe.com/v1/payment_intents/pi_7');
      expect(form(calls[2]).get('payment_intent')).toBe('pi_7');
      expect(r.success).toBe(true);
    });
    it('returns failed (never throws) when Stripe rejects the refund', async () => {
      queue.push(respond(200, { id: 'pi_1', currency: 'usd' }), respond(400, { error: { message: 'Charge already refunded' } }));
      const r = await provider.refund('pi_1', 5, CONFIG);
      expect(r).toEqual({ success: false, refundId: '', amount: 5, status: 'failed' });
    });
    it('returns failed on a network error', async () => {
      queue.push(new Error('socket hang up'));
      const r = await provider.refund('pi_1', 5, CONFIG);
      expect(r.success).toBe(false);
      expect(r.status).toBe('failed');
    });
  });

  describe('testConnection', () => {
    it('ok on 200', async () => {
      queue.push(respond(200, { object: 'balance' }));
      const r = await provider.testConnection(CONFIG);
      expect(r.ok).toBe(true);
      expect(calls[0].url).toBe('https://api.stripe.com/v1/balance');
      expect(calls[0].init.headers.Authorization).toBe('Bearer sk_test_abc');
    });
    it('401 gives a message that mentions the mode', async () => {
      queue.push(respond(401, { error: { message: 'Invalid API Key provided' } }));
      const r = await provider.testConnection({ ...CONFIG, mode: 'live' });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch('live');
    });
    it('network error is not ok', async () => {
      queue.push(new Error('getaddrinfo ENOTFOUND'));
      const r = await provider.testConnection(CONFIG);
      expect(r.ok).toBe(false);
      expect(r.message).toContain('ENOTFOUND');
    });
  });

  describe('misc', () => {
    it('is not callback-authoritative and has the right key', () => {
      expect(provider.providerKey).toBe('stripe_own');
      expect(provider.callbackIsAuthoritative).toBe(false);
    });
    it('getPublicConfig defaults', () => {
      expect(provider.getPublicConfig({})).toEqual({ displayName: 'Stripe', currency: '', logo: undefined });
      expect(provider.getPublicConfig({ displayName: 'Card', currency: 'USD' })).toMatchObject({ displayName: 'Card', currency: 'USD' });
    });
  });
});
