/* eslint-disable prettier/prettier */
import { PayPalPaymentProvider, formatPayPalAmount } from './paypal.provider';

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

const cfg = (over: any = {}): any => ({
  credentials: { clientId: 'cid', clientSecret: 'sec', webhookSecret: 'WH-ID' },
  config: {},
  mode: 'sandbox',
  webhookToken: null,
  ...over,
});

const reply = (status: number, data: any) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });

describe('PayPalPaymentProvider', () => {
  const realFetch = (global as any).fetch;
  let calls: Call[];
  let routes: Array<{ match: (url: string, method: string) => boolean; res: () => any }>;
  let provider: PayPalPaymentProvider;

  const route = (method: string, urlPart: string, res: () => any) => routes.push({ match: (u, m) => m === method && u.includes(urlPart), res });

  beforeEach(() => {
    calls = [];
    routes = [];
    provider = new PayPalPaymentProvider();
    route('POST', '/v1/oauth2/token', () => reply(200, { access_token: 'tok', expires_in: 3600 }));
    (global as any).fetch = async (url: string, init: any = {}) => {
      const headers = init.headers ?? {};
      calls.push({ url: String(url), method: init.method ?? 'GET', headers, body: init.body && typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body });
      const r = routes.find((x) => x.match(String(url), init.method ?? 'GET'));
      if (!r) throw new Error(`unrouted ${init.method} ${url}`);
      return r.res();
    };
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  const completedOrder = (captureStatus: string) => ({
    id: 'ORD1',
    status: 'COMPLETED',
    purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: captureStatus, amount: { value: '12.50', currency_code: 'USD' } }] } }],
  });

  describe('formatPayPalAmount', () => {
    it('uses 0 decimals for JPY/HUF/TWD and 2 otherwise', () => {
      expect(formatPayPalAmount(1500, 'JPY')).toBe('1500');
      expect(formatPayPalAmount(1500.4, 'huf')).toBe('1500');
      expect(formatPayPalAmount(99, 'TWD')).toBe('99');
      expect(formatPayPalAmount(12.5, 'USD')).toBe('12.50');
      expect(formatPayPalAmount(3, 'EUR')).toBe('3.00');
    });
  });

  describe('testConnection / token', () => {
    it('is ok when a token is issued, using Basic auth and the sandbox host', async () => {
      const r = await provider.testConnection(cfg());
      expect(r.ok).toBe(true);
      expect(calls[0].url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
      expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('cid:sec').toString('base64')}`);
      expect(calls[0].body).toBe('grant_type=client_credentials');
    });
    it('uses the live host in live mode', async () => {
      await provider.testConnection(cfg({ mode: 'live' }));
      expect(calls[0].url).toBe('https://api-m.paypal.com/v1/oauth2/token');
    });
    it('reports a 401 with the mode in the message', async () => {
      routes.length = 0;
      route('POST', '/v1/oauth2/token', () => reply(401, { error: 'invalid_client' }));
      const r = await provider.testConnection(cfg({ mode: 'live' }));
      expect(r.ok).toBe(false);
      expect(r.message).toContain('live');
    });
    it('caches the token between calls', async () => {
      route('GET', '/v2/checkout/orders/ORD1', () => reply(200, { id: 'ORD1', status: 'CREATED' }));
      await provider.verifyPayment('ORD1', cfg());
      await provider.verifyPayment('ORD1', cfg());
      expect(calls.filter((c) => c.url.includes('/oauth2/token'))).toHaveLength(1);
    });
    it('fails without credentials', async () => {
      const r = await provider.testConnection(cfg({ credentials: {} }));
      expect(r.ok).toBe(false);
    });
  });

  describe('initiatePayment', () => {
    const order = { orderId: 'o-1', amount: 25, currency: 'usd', storeId: 's1', returnUrl: 'https://s/return', cancelUrl: 'https://s/cancel' };
    it('creates a CAPTURE order and returns the payer-action link', async () => {
      route('POST', '/v2/checkout/orders', () =>
        reply(201, { id: 'ORD9', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://paypal.test/pay' }] }),
      );
      const s = await provider.initiatePayment(order, cfg());
      expect(s).toEqual({ redirectUrl: 'https://paypal.test/pay', sessionId: 'ORD9' });
      const c = calls.find((x) => x.url.endsWith('/v2/checkout/orders'))!;
      expect(c.body.intent).toBe('CAPTURE');
      expect(c.body.purchase_units).toHaveLength(1);
      expect(c.body.purchase_units[0]).toMatchObject({ reference_id: 'o-1', custom_id: 'o-1', amount: { currency_code: 'USD', value: '25.00' } });
      expect(c.body.payment_source.paypal.experience_context).toEqual({ return_url: 'https://s/return', cancel_url: 'https://s/cancel', user_action: 'PAY_NOW', landing_page: 'LOGIN' });
      expect(c.headers['PayPal-Request-Id']).toBeTruthy();
    });
    it('falls back to the approve link and uses a fresh request id each time', async () => {
      route('POST', '/v2/checkout/orders', () => reply(201, { id: 'ORD9', links: [{ rel: 'approve', href: 'https://paypal.test/approve' }] }));
      const s = await provider.initiatePayment(order, cfg());
      await provider.initiatePayment(order, cfg());
      expect(s.redirectUrl).toBe('https://paypal.test/approve');
      const ids = calls.filter((x) => x.url.endsWith('/v2/checkout/orders')).map((x) => x.headers['PayPal-Request-Id']);
      expect(ids[0] === ids[1]).toBe(false);
    });
    it('formats JPY without decimals', async () => {
      route('POST', '/v2/checkout/orders', () => reply(201, { id: 'O', links: [{ rel: 'payer-action', href: 'h' }] }));
      await provider.initiatePayment({ ...order, amount: 1500, currency: 'JPY' }, cfg());
      const c = calls.find((x) => x.url.endsWith('/v2/checkout/orders'))!;
      expect(c.body.purchase_units[0].amount).toEqual({ currency_code: 'JPY', value: '1500' });
    });
    it('throws when PayPal rejects the order', async () => {
      route('POST', '/v2/checkout/orders', () => reply(422, { name: 'UNPROCESSABLE_ENTITY', message: 'bad', details: [{ issue: 'CURRENCY_NOT_SUPPORTED' }] }));
      await expect(provider.initiatePayment(order, cfg())).rejects.toThrow('CURRENCY_NOT_SUPPORTED');
    });
  });

  describe('verifyPayment', () => {
    it('captures an APPROVED order and reports paid', async () => {
      route('GET', '/v2/checkout/orders/ORD1', () => reply(200, { id: 'ORD1', status: 'APPROVED' }));
      route('POST', '/v2/checkout/orders/ORD1/capture', () => reply(201, completedOrder('COMPLETED')));
      const s = await provider.verifyPayment('ORD1', cfg());
      expect(s).toMatchObject({ status: 'paid', providerReference: 'ORD1', paymentId: 'CAP1', amount: 12.5, currency: 'USD' });
      const cap = calls.find((c) => c.url.endsWith('/capture'))!;
      expect(cap.headers['PayPal-Request-Id']).toBe('capture-ORD1');
    });
    it('re-reads the order when the capture says ORDER_ALREADY_CAPTURED', async () => {
      let gets = 0;
      route('GET', '/v2/checkout/orders/ORD1', () => (gets++ === 0 ? reply(200, { id: 'ORD1', status: 'APPROVED' }) : reply(200, completedOrder('COMPLETED'))));
      route('POST', '/v2/checkout/orders/ORD1/capture', () => reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }));
      const s = await provider.verifyPayment('ORD1', cfg());
      expect(s.status).toBe('paid');
      expect(s.paymentId).toBe('CAP1');
    });
    it('does not capture an already COMPLETED order', async () => {
      route('GET', '/v2/checkout/orders/ORD1', () => reply(200, completedOrder('COMPLETED')));
      const s = await provider.verifyPayment('ORD1', cfg());
      expect(s.status).toBe('paid');
      expect(calls.some((c) => c.url.endsWith('/capture'))).toBe(false);
    });
    it('maps a PENDING capture to pending', async () => {
      route('GET', '/v2/checkout/orders/ORD1', () => reply(200, completedOrder('PENDING')));
      expect((await provider.verifyPayment('ORD1', cfg())).status).toBe('pending');
    });
    it('maps DECLINED and FAILED captures to failed', async () => {
      route('GET', '/v2/checkout/orders/ORD1', () => reply(200, completedOrder('DECLINED')));
      expect((await provider.verifyPayment('ORD1', cfg())).status).toBe('failed');
      routes.pop();
      route('GET', '/v2/checkout/orders/ORD1', () => reply(200, completedOrder('FAILED')));
      expect((await provider.verifyPayment('ORD1', cfg())).status).toBe('failed');
    });
    it('maps VOIDED to failed and CREATED/PAYER_ACTION_REQUIRED to pending', async () => {
      route('GET', '/v2/checkout/orders/V', () => reply(200, { id: 'V', status: 'VOIDED' }));
      route('GET', '/v2/checkout/orders/C', () => reply(200, { id: 'C', status: 'CREATED' }));
      route('GET', '/v2/checkout/orders/P', () => reply(200, { id: 'P', status: 'PAYER_ACTION_REQUIRED' }));
      expect((await provider.verifyPayment('V', cfg())).status).toBe('failed');
      expect((await provider.verifyPayment('C', cfg())).status).toBe('pending');
      expect((await provider.verifyPayment('P', cfg())).status).toBe('pending');
    });
    it('treats INSTRUMENT_DECLINED on capture as still pending, other capture errors throw', async () => {
      route('GET', '/v2/checkout/orders/ORD1', () => reply(200, { id: 'ORD1', status: 'APPROVED' }));
      route('POST', '/v2/checkout/orders/ORD1/capture', () => reply(422, { details: [{ issue: 'INSTRUMENT_DECLINED' }] }));
      expect((await provider.verifyPayment('ORD1', cfg())).status).toBe('pending');
      routes.pop();
      route('POST', '/v2/checkout/orders/ORD1/capture', () => reply(500, { name: 'INTERNAL_SERVER_ERROR' }));
      await expect(provider.verifyPayment('ORD1', cfg())).rejects.toThrow('capture failed');
    });
  });

  describe('handleWebhook', () => {
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.paypal.com/cert.pem',
      'paypal-transmission-id': 'tid-1',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-10-26T10:00:00Z',
    };
    const body = (ev: any) => Buffer.from(JSON.stringify(ev));
    const verify = (status: string) => route('POST', '/v1/notifications/verify-webhook-signature', () => reply(200, { verification_status: status }));
    const captureEvent = (type: string) => ({
      id: 'WH-EVT-1',
      event_type: type,
      resource: { id: 'CAP1', amount: { value: '12.50', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: 'ORD1' } } },
    });

    it('verifies with PayPal and maps PAYMENT.CAPTURE.COMPLETED', async () => {
      verify('SUCCESS');
      const ev = await provider.handleWebhook(body(captureEvent('PAYMENT.CAPTURE.COMPLETED')), headers, cfg());
      expect(ev).toMatchObject({ type: 'payment_succeeded', externalEventId: 'WH-EVT-1', sessionId: 'ORD1' });
      expect(ev.status).toMatchObject({ status: 'paid', paymentId: 'CAP1', amount: 12.5, currency: 'USD' });
      const c = calls.find((x) => x.url.includes('verify-webhook-signature'))!;
      expect(c.body).toMatchObject({ auth_algo: 'SHA256withRSA', cert_url: 'https://api.paypal.com/cert.pem', transmission_id: 'tid-1', transmission_sig: 'sig', transmission_time: '2026-10-26T10:00:00Z', webhook_id: 'WH-ID' });
      expect(c.body.webhook_event.id).toBe('WH-EVT-1');
    });
    it('accepts upper-case header names', async () => {
      verify('SUCCESS');
      const upper: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) upper[k.toUpperCase()] = v;
      const ev = await provider.handleWebhook(body(captureEvent('PAYMENT.CAPTURE.COMPLETED')), upper, cfg());
      expect(ev.type).toBe('payment_succeeded');
    });
    it('maps DENIED and DECLINED to payment_failed', async () => {
      verify('SUCCESS');
      expect((await provider.handleWebhook(body(captureEvent('PAYMENT.CAPTURE.DENIED')), headers, cfg())).type).toBe('payment_failed');
      expect((await provider.handleWebhook(body(captureEvent('PAYMENT.CAPTURE.DECLINED')), headers, cfg())).type).toBe('payment_failed');
    });
    it('maps CHECKOUT.ORDER.APPROVED and unknown events to payment_pending', async () => {
      verify('SUCCESS');
      const a = await provider.handleWebhook(body({ id: 'E2', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORD1' } }), headers, cfg());
      expect(a).toMatchObject({ type: 'payment_pending', sessionId: 'ORD1', externalEventId: 'E2' });
      const b = await provider.handleWebhook(body({ id: 'E3', event_type: 'BILLING.SOMETHING', resource: {} }), headers, cfg());
      expect(b.type).toBe('payment_pending');
    });
    it('falls back to the capture "up" link for the order id', async () => {
      verify('SUCCESS');
      const ev = { id: 'E4', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP2', amount: { value: '1.00', currency_code: 'USD' }, links: [{ rel: 'up', href: 'https://api.paypal.com/v2/checkout/orders/ORDX' }] } };
      expect((await provider.handleWebhook(body(ev), headers, cfg())).sessionId).toBe('ORDX');
    });
    it('rejects when verification_status is FAILURE', async () => {
      verify('FAILURE');
      await expect(provider.handleWebhook(body(captureEvent('PAYMENT.CAPTURE.COMPLETED')), headers, cfg())).rejects.toThrow('Invalid PayPal webhook signature');
    });
    it('rejects missing headers and missing webhook id without calling PayPal', async () => {
      const { ['paypal-transmission-sig']: _drop, ...partial } = headers;
      await expect(provider.handleWebhook(body(captureEvent('PAYMENT.CAPTURE.COMPLETED')), partial, cfg())).rejects.toThrow('Missing PayPal webhook signature headers');
      await expect(provider.handleWebhook(body(captureEvent('PAYMENT.CAPTURE.COMPLETED')), headers, cfg({ credentials: { clientId: 'a', clientSecret: 'b' } }))).rejects.toThrow('Webhook ID');
      expect(calls).toHaveLength(0);
    });
  });

  describe('refund', () => {
    const readCapture = () => route('GET', '/v2/payments/captures/CAP1', () => reply(200, { id: 'CAP1', amount: { value: '12.50', currency_code: 'EUR' } }));
    it('reads the capture currency and refunds', async () => {
      readCapture();
      route('POST', '/v2/payments/captures/CAP1/refund', () => reply(201, { id: 'REF1', status: 'COMPLETED' }));
      const r = await provider.refund('CAP1', 5, cfg());
      expect(r).toEqual({ success: true, refundId: 'REF1', amount: 5, status: 'succeeded' });
      const c = calls.find((x) => x.url.endsWith('/refund'))!;
      expect(c.body).toEqual({ amount: { value: '5.00', currency_code: 'EUR' } });
      expect(c.headers['PayPal-Request-Id']).toBe('refund-CAP1-5.00');
    });
    it('reports a pending refund as success/pending', async () => {
      readCapture();
      route('POST', '/v2/payments/captures/CAP1/refund', () => reply(201, { id: 'REF2', status: 'PENDING' }));
      expect(await provider.refund('CAP1', 5, cfg())).toMatchObject({ success: true, status: 'pending' });
    });
    it('returns success:false (never throws) when PayPal rejects', async () => {
      readCapture();
      route('POST', '/v2/payments/captures/CAP1/refund', () => reply(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'REFUND_AMOUNT_EXCEEDED' }] }));
      expect(await provider.refund('CAP1', 500, cfg())).toMatchObject({ success: false, status: 'failed' });
    });
    it('returns success:false when the capture cannot be read', async () => {
      route('GET', '/v2/payments/captures/CAP1', () => reply(404, { name: 'RESOURCE_NOT_FOUND' }));
      expect((await provider.refund('CAP1', 5, cfg())).success).toBe(false);
    });
  });

  describe('getPublicConfig', () => {
    it('returns display fields only', () => {
      expect(provider.getPublicConfig({})).toEqual({ displayName: 'PayPal', currency: '', logo: undefined });
      expect(provider.getPublicConfig({ displayName: 'Pay', currency: 'USD', logo: 'l' })).toEqual({ displayName: 'Pay', currency: 'USD', logo: 'l' });
    });
  });
});
