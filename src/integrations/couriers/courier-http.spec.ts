/* eslint-disable prettier/prettier */
import { courierHttpTestHooks, courierRequest, redactSecrets } from './courier-http';
import { canAdvanceCourierStatus, CourierError } from './courier.types';
import { enabledCourierProviders, isCourierEnabled } from './courier-catalog';

function res(status: number, body: any, contentType = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => contentType },
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: () => Promise.resolve(Buffer.from(text)),
  } as any;
}

describe('courierRequest', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    courierHttpTestHooks.reset();
    courierHttpTestHooks.setSleep(() => Promise.resolve());
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  const base = { provider: 'postex', url: 'https://x.test/a', method: 'GET' as const, secrets: ['sk_secret_value'] };

  it('returns parsed JSON on success', async () => {
    fetchMock.mockResolvedValue(res(200, { ok: 1 }));
    await expect(courierRequest(base)).resolves.toEqual({ status: 200, json: { ok: 1 } });
  });

  it('maps 401 to an auth error without retrying', async () => {
    fetchMock.mockResolvedValue(res(401, {}));
    await expect(courierRequest({ ...base, retries: 2 })).rejects.toMatchObject({ code: 'auth' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps 400 to a validation error carrying the (redacted) courier message', async () => {
    fetchMock.mockResolvedValue(res(400, { message: 'bad sk_secret_value city' }));
    const err: CourierError = await courierRequest(base).catch((e) => e);
    expect(err.code).toBe('validation');
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain('sk_secret_value');
  });

  it('retries 5xx with backoff for reads and succeeds', async () => {
    fetchMock.mockResolvedValueOnce(res(503, {})).mockResolvedValueOnce(res(200, { ok: true }));
    await expect(courierRequest({ ...base, retries: 2 })).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry when retries is 0 (booking calls)', async () => {
    fetchMock.mockResolvedValue(res(500, {}));
    await expect(courierRequest({ ...base, method: 'POST', body: {}, retries: 0 })).rejects.toMatchObject({ code: 'upstream' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps an aborted request to timeout and a thrown fetch to network', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'AbortError' }));
    await expect(courierRequest(base)).rejects.toMatchObject({ code: 'timeout' });
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(courierRequest(base)).rejects.toMatchObject({ code: 'network' });
  });

  it('maps a 200 with a non-JSON body to malformed', async () => {
    fetchMock.mockResolvedValue(res(200, '<html>oops</html>'));
    await expect(courierRequest(base)).rejects.toMatchObject({ code: 'malformed' });
  });

  it('opens the circuit after repeated failures and fails fast, then recovers after the window', async () => {
    let now = 1_000;
    courierHttpTestHooks.setNow(() => now);
    fetchMock.mockResolvedValue(res(500, {}));
    for (let i = 0; i < 5; i++) await courierRequest(base).catch(() => undefined);
    fetchMock.mockClear();
    await expect(courierRequest(base)).rejects.toMatchObject({ code: 'circuit_open' });
    expect(fetchMock).not.toHaveBeenCalled();
    now += 31_000;
    fetchMock.mockResolvedValue(res(200, {}));
    await expect(courierRequest(base)).resolves.toMatchObject({ status: 200 });
  });

  it('never opens the circuit for auth failures (wrong creds are not an outage)', async () => {
    fetchMock.mockResolvedValue(res(401, {}));
    for (let i = 0; i < 8; i++) await courierRequest(base).catch(() => undefined);
    fetchMock.mockResolvedValue(res(200, {}));
    await expect(courierRequest(base)).resolves.toMatchObject({ status: 200 });
  });
});

describe('redactSecrets', () => {
  it('removes known values and secret-looking key/value pairs', () => {
    const out = redactSecrets('token=abc123 and "password":"hunter22" plus mykey123', ['mykey123']);
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('hunter22');
    expect(out).not.toContain('mykey123');
  });
});

describe('canAdvanceCourierStatus', () => {
  it('moves forward, blocks stale/backward and terminal changes, always allows RTO/cancel from live states', () => {
    expect(canAdvanceCourierStatus(null, 'booked')).toBe(true);
    expect(canAdvanceCourierStatus('in_transit', 'picked_up')).toBe(false);
    expect(canAdvanceCourierStatus('picked_up', 'out_for_delivery')).toBe(true);
    expect(canAdvanceCourierStatus('out_for_delivery', 'returned')).toBe(true);
    expect(canAdvanceCourierStatus('delivered', 'in_transit')).toBe(false);
    expect(canAdvanceCourierStatus('returned', 'delivered')).toBe(false);
    expect(canAdvanceCourierStatus('failed', 'out_for_delivery')).toBe(true);
  });
});

describe('courier enablement gate', () => {
  const OLD = process.env.COURIER_ENABLED_PROVIDERS;
  afterEach(() => { if (OLD === undefined) delete process.env.COURIER_ENABLED_PROVIDERS; else process.env.COURIER_ENABLED_PROVIDERS = OLD; });
  it('defaults to nothing enabled', () => {
    delete process.env.COURIER_ENABLED_PROVIDERS;
    expect(enabledCourierProviders()).toEqual([]);
    expect(isCourierEnabled('postex')).toBe(false);
  });
  it('enables only listed known couriers', () => {
    process.env.COURIER_ENABLED_PROVIDERS = ' PostEx, leopards ,bogus';
    expect(enabledCourierProviders()).toEqual(['postex', 'leopards']);
    expect(isCourierEnabled('tcs')).toBe(false);
  });
});
