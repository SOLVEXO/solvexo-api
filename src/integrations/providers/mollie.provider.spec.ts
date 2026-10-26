/* eslint-disable prettier/prettier */
import { MolliePaymentProvider, formatMollieAmount } from './mollie.provider';

type Call = { url: string; method: string; body: any; auth: string };

describe('MolliePaymentProvider', () => {
  const realFetch = (global as any).fetch;
  let calls: Call[];
  let routes: Record<string, { status: number; body: any }>;
  const provider = new MolliePaymentProvider();
  const cfg: any = { credentials: { apiKey: 'test_abc' }, config: {}, mode: 'sandbox', webhookToken: 'tok123' };

  beforeEach(() => {
    calls = [];
    routes = {};
    (global as any).fetch = async (url: string, init: any) => {
      const method = (init && init.method) || 'GET';
      calls.push({ url, method, body: init && init.body ? JSON.parse(init.body) : undefined, auth: init && init.headers ? init.headers.Authorization : '' });
      const r = routes[`${method} ${url.replace('https://api.mollie.com/v2', '')}`];
      if (!r) return { ok: false, status: 404, json: async () => ({}), text: async () => '{"detail":"not found"}' };
      return { ok: r.status < 400, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) };
    };
  });
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  const payment = (status: string, id = 'tr_abc123') => ({ id, status, amount: { currency: 'EUR', value: '10.00' } });

  it('formats amounts', () => {
    expect(formatMollieAmount(10, 'EUR')).toBe('10.00');
    expect(formatMollieAmount(10.005, 'usd')).toBe('10.01');
    expect(formatMollieAmount(1500.4, 'JPY')).toBe('1500');
    expect(formatMollieAmount(99, 'ISK')).toBe('99');
  });

  it('initiates a payment', async () => {
    routes['POST /payments'] = { status: 201, body: { id: 'tr_new1', _links: { checkout: { href: 'https://pay.mollie.com/x' } } } };
    const s = await provider.initiatePayment(
      { orderId: 'co1', amount: 12.5, currency: 'EUR', storeId: 's1', returnUrl: 'https://a.com/r', cancelUrl: 'https://a.com/c' },
      cfg,
    );
    expect(s).toEqual({ redirectUrl: 'https://pay.mollie.com/x', sessionId: 'tr_new1' });
    const b = calls[0].body;
    expect(b.amount).toEqual({ currency: 'EUR', value: '12.50' });
    expect(b.redirectUrl).toBe('https://a.com/r');
    expect(b.cancelUrl).toBe('https://a.com/c');
    expect(b.webhookUrl).toMatch(/\/webhooks\/payments\/mollie\/tok123$/);
    expect(b.metadata).toEqual({ checkoutId: 'co1', storeId: 's1' });
    expect(calls[0].auth).toBe('Bearer test_abc');
  });

  it('initiates JPY without decimals', async () => {
    routes['POST /payments'] = { status: 201, body: { id: 'tr_new2', _links: { checkout: { href: 'https://pay.mollie.com/y' } } } };
    await provider.initiatePayment({ orderId: 'c', amount: 1000, currency: 'JPY', storeId: 's', returnUrl: 'https://a/r', cancelUrl: 'https://a/c' }, cfg);
    expect(calls[0].body.amount.value).toBe('1000');
  });

  it('refuses to initiate without webhook token', async () => {
    await expect(
      provider.initiatePayment({ orderId: 'c', amount: 1, currency: 'EUR', storeId: 's', returnUrl: 'x', cancelUrl: 'y' }, { ...cfg, webhookToken: null }),
    ).rejects.toThrow('webhook token');
  });

  it('maps verify statuses', async () => {
    const cases: Array<[string, string]> = [
      ['paid', 'paid'], ['failed', 'failed'], ['canceled', 'failed'], ['expired', 'failed'],
      ['open', 'pending'], ['pending', 'pending'], ['authorized', 'pending'],
    ];
    for (const [mollie, ours] of cases) {
      routes['GET /payments/tr_abc123'] = { status: 200, body: payment(mollie) };
      const st = await provider.verifyPayment('tr_abc123', cfg);
      expect(st.status).toBe(ours);
    }
    routes['GET /payments/tr_abc123'] = { status: 200, body: payment('paid') };
    const paid = await provider.verifyPayment('tr_abc123', cfg);
    expect(paid).toMatchObject({ amount: 10, currency: 'EUR', paymentId: 'tr_abc123', providerReference: 'tr_abc123' });
  });

  it('handles a form webhook', async () => {
    routes['GET /payments/tr_abc123'] = { status: 200, body: payment('paid') };
    const ev = await provider.handleWebhook(Buffer.from('id=tr_abc123'), {}, cfg);
    expect(ev.type).toBe('payment_succeeded');
    expect(ev.externalEventId).toBe('tr_abc123:paid');
    expect(ev.sessionId).toBe('tr_abc123');
    expect(ev.status.status).toBe('paid');
  });

  it('handles a JSON webhook and other states', async () => {
    routes['GET /payments/tr_abc123'] = { status: 200, body: payment('expired') };
    const ev = await provider.handleWebhook(Buffer.from('{"id":"tr_abc123"}'), {}, cfg);
    expect(ev.type).toBe('payment_failed');
    routes['GET /payments/tr_abc123'] = { status: 200, body: payment('open') };
    const ev2 = await provider.handleWebhook(Buffer.from('id=tr_abc123'), {}, cfg);
    expect(ev2.type).toBe('payment_pending');
  });

  it('rejects malformed ids, failed fetches and forged ids', async () => {
    await expect(provider.handleWebhook(Buffer.from('id=../evil'), {}, cfg)).rejects.toThrow('valid payment id');
    await expect(provider.handleWebhook(Buffer.from(''), {}, cfg)).rejects.toThrow('valid payment id');
    routes['GET /payments/tr_boom'] = { status: 500, body: { detail: 'down' } };
    await expect(provider.handleWebhook(Buffer.from('id=tr_boom'), {}, cfg)).rejects.toThrow('HTTP 500');
    // forged id: not found under this seller's key
    await expect(provider.handleWebhook(Buffer.from('id=tr_forged'), {}, cfg)).rejects.toThrow('HTTP 404');
  });

  it('refunds: queued, refunded, rejected', async () => {
    routes['GET /payments/tr_abc123'] = { status: 200, body: payment('paid') };
    routes['POST /payments/tr_abc123/refunds'] = { status: 201, body: { id: 're_1', status: 'queued' } };
    const r1 = await provider.refund('tr_abc123', 4, cfg);
    expect(r1).toEqual({ success: true, refundId: 're_1', amount: 4, status: 'pending' });
    expect(calls[calls.length - 1].body).toEqual({ amount: { currency: 'EUR', value: '4.00' } });
    routes['POST /payments/tr_abc123/refunds'] = { status: 201, body: { id: 're_2', status: 'refunded' } };
    expect((await provider.refund('tr_abc123', 4, cfg)).status).toBe('succeeded');
    routes['POST /payments/tr_abc123/refunds'] = { status: 422, body: { detail: 'too much' } };
    const r3 = await provider.refund('tr_abc123', 400, cfg);
    expect(r3.success).toBe(false);
    expect(r3.status).toBe('failed');
  });

  it('tests the connection', async () => {
    routes['GET /methods'] = { status: 200, body: { count: 1 } };
    const ok = await provider.testConnection(cfg);
    expect(ok.ok).toBe(true);
    expect(ok.message).toContain('test');
    routes['GET /methods'] = { status: 401, body: { detail: 'Invalid key' } };
    const bad = await provider.testConnection(cfg);
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('live_');
  });

  it('exposes public config', () => {
    expect(provider.getPublicConfig({})).toEqual({ displayName: 'Mollie', currency: '', logo: undefined });
  });
});
