/* eslint-disable prettier/prettier */
import { BookShipmentInput, CourierContext, CourierError, CourierProvider, CourierStatus } from '../courier.types';
import { courierHttpTestHooks } from '../courier-http';

/** Mock fetch response helper (no live courier call is ever made in these tests). */
export function mockRes(status: number, body: any, contentType = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => contentType },
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
    arrayBuffer: () => Promise.resolve(Buffer.from(text)),
  } as any;
}

export const SAMPLE_INPUT: BookShipmentInput = {
  referenceNumber: 'ORD-1001-1',
  consignee: { name: 'Ali Khan', phone: '03001234567', address: 'House 1, Street 2', city: 'Lahore' },
  pickup: { name: 'Shop', phone: '03111111111', address: 'Warehouse Rd', city: 'Karachi', addressCode: '001' },
  weightKg: 0.5,
  pieces: 1,
  codAmount: 1500,
  currency: 'PKR',
  description: 'T-shirt x1',
};

export interface ContractFixtures {
  name: string;
  make: () => CourierProvider;
  ctx: CourierContext;
  /** A secret credential VALUE that must never appear in any thrown message. */
  secretValue: string;
  bodies: {
    cities: any;               // successful city list containing "Lahore" (and not "Atlantis")
    book: any;                 // successful booking
    expectedTracking: string;
    bookValidation: { status: number; body: any }; // courier-level validation failure (may be HTTP 200 envelope)
    authFailure: { status: number; body: any };
    track: any;                // successful tracking for `trackedNumber`
    trackedNumber: string;
    expectedTrackStatus: CourierStatus;
    cancel: any;
  };
}

export function runCourierContract(f: ContractFixtures) {
  describe(`${f.name} adapter (mocked HTTP)`, () => {
    let provider: CourierProvider;
    let fetchMock: jest.Mock;
    beforeEach(() => {
      courierHttpTestHooks.reset();
      courierHttpTestHooks.setSleep(() => Promise.resolve());
      provider = f.make();
      fetchMock = jest.fn();
      (global as any).fetch = fetchMock;
    });
    const code = async (p: Promise<any>) => (await p.then(() => null, (e) => e)) as CourierError | null;

    it('test connection succeeds with valid credentials', async () => {
      fetchMock.mockResolvedValue(mockRes(200, f.bodies.cities));
      await expect(provider.testConnection(f.ctx)).resolves.toMatchObject({ ok: true });
    });

    it('test connection reports an auth failure without leaking credentials', async () => {
      fetchMock.mockResolvedValue(mockRes(f.bodies.authFailure.status, f.bodies.authFailure.body));
      const r = await provider.testConnection(f.ctx);
      expect(r.ok).toBe(false);
      expect(r.message).not.toContain(f.secretValue);
    });

    it('books a shipment and returns the tracking number (COD amount + reference sent)', async () => {
      fetchMock.mockResolvedValue(mockRes(200, f.bodies.book));
      const out = await provider.bookShipment(f.ctx, SAMPLE_INPUT);
      expect(out.trackingNumber).toBe(f.bodies.expectedTracking);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sentBody = String(fetchMock.mock.calls[0][1]?.body ?? '');
      expect(sentBody).toContain('ORD-1001-1');
      expect(sentBody).toContain('1500');
    });

    it('sends 0 collect amount for an already-paid order', async () => {
      fetchMock.mockResolvedValue(mockRes(200, f.bodies.book));
      await provider.bookShipment(f.ctx, { ...SAMPLE_INPUT, codAmount: 0 });
      expect(String(fetchMock.mock.calls[0][1]?.body ?? '')).not.toContain('1500');
    });

    it('maps a courier validation failure to a validation error and never leaks the secret', async () => {
      fetchMock.mockResolvedValue(mockRes(f.bodies.bookValidation.status, f.bodies.bookValidation.body));
      const err = await code(provider.bookShipment(f.ctx, SAMPLE_INPUT));
      expect(err).toBeInstanceOf(CourierError);
      expect(['validation', 'city_not_serviceable']).toContain(err!.code);
      expect(err!.message).not.toContain(f.secretValue);
    });

    it('maps a timeout', async () => {
      fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      expect((await code(provider.bookShipment(f.ctx, SAMPLE_INPUT)))?.code).toBe('timeout');
    });

    it('does not retry a booking after a network failure (no double booking)', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));
      expect((await code(provider.bookShipment(f.ctx, SAMPLE_INPUT)))?.code).toBe('network');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('maps a malformed (non-JSON) response', async () => {
      fetchMock.mockResolvedValue(mockRes(200, '<html>gateway</html>'));
      expect((await code(provider.bookShipment(f.ctx, SAMPLE_INPUT)))?.code).toBe('malformed');
    });

    it('maps a well-formed JSON response missing the tracking number to malformed', async () => {
      fetchMock.mockResolvedValue(mockRes(200, { status: 1, statusCode: '200' }));
      expect((await code(provider.bookShipment(f.ctx, SAMPLE_INPUT)))?.code).toBe('malformed');
    });

    it('rejects a city the courier does not serve', async () => {
      fetchMock.mockResolvedValue(mockRes(200, f.bodies.cities));
      expect((await code(provider.validateCity(f.ctx, 'Atlantis')))?.code).toBe('city_not_serviceable');
    });

    it('accepts a served city (case/space-insensitive)', async () => {
      fetchMock.mockResolvedValue(mockRes(200, f.bodies.cities));
      await expect(provider.validateCity(f.ctx, '  lahore ')).resolves.toMatchObject({ name: expect.stringMatching(/lahore/i) });
    });

    it('tracks and normalizes the status', async () => {
      fetchMock.mockResolvedValue(mockRes(200, f.bodies.track));
      const [r] = await provider.trackShipments(f.ctx, [f.bodies.trackedNumber]);
      expect(r.trackingNumber).toBe(f.bodies.trackedNumber);
      expect(r.status).toBe(f.bodies.expectedTrackStatus);
    });

    it('cancels a booking', async () => {
      if (!provider.capabilities.cancel) return;
      fetchMock.mockResolvedValue(mockRes(200, f.bodies.cancel));
      await expect(provider.cancelShipment(f.ctx, f.bodies.trackedNumber)).resolves.toBeUndefined();
    });

    it('blocks LIVE calls while the mapping is unverified, but allows sandbox', async () => {
      delete process.env.COURIER_ALLOW_UNVERIFIED;
      const err = await code(provider.listCities({ ...f.ctx, mode: 'live' }));
      expect(err?.code).toBe('unverified');
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockResolvedValue(mockRes(200, f.bodies.cities));
      await expect(provider.listCities({ ...f.ctx, mode: 'sandbox' })).resolves.toBeTruthy();
    });
  });
}

export const PLACEHOLDER_BODIES = {
  cities: { cities: [{ id: 1, name: 'Lahore' }, { id: 2, name: 'Karachi' }] },
  book: { tracking_number: 'TRK123' },
  expectedTracking: 'TRK123',
  bookValidation: { status: 400, body: { message: 'Invalid consignee phone' } },
  authFailure: { status: 401, body: {} },
  track: { shipments: [{ tracking_number: 'TRK123', status: 'Delivered', events: [{ status: 'In Transit', time: '2026-11-01T10:00:00Z' }, { status: 'Delivered', time: '2026-11-02T10:00:00Z' }] }] },
  trackedNumber: 'TRK123',
  expectedTrackStatus: 'delivered' as CourierStatus,
  cancel: { success: true },
};
