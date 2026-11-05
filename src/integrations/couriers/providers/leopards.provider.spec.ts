/* eslint-disable prettier/prettier */
import { LeopardsCourierProvider } from './leopards.provider';
import { mockRes, runCourierContract, SAMPLE_INPUT } from './courier-contract.testkit';

const ctx = { credentials: { apiKey: 'AK-111111', apiPassword: 'SECRET-KEY-VALUE-42' }, mode: 'sandbox' as const, config: {} };

runCourierContract({
  name: 'leopards',
  make: () => new LeopardsCourierProvider(),
  ctx,
  secretValue: 'SECRET-KEY-VALUE-42',
  bodies: {
    cities: { status: 1, error: 0, city_list: [{ id: 1, name: 'Lahore' }, { id: 2, name: 'Karachi' }] },
    book: { status: 1, error: 0, track_number: 'LE123456789', slip_link: 'https://slip.test/1' },
    expectedTracking: 'LE123456789',
    bookValidation: { status: 200, body: { status: 0, error: 'Consignee phone invalid SECRET-KEY-VALUE-42' } },
    authFailure: { status: 200, body: { status: 0, error: 'Invalid API key / password' } },
    track: { status: 1, packet_list: [{ track_number: 'LE123456789', booked_packet_status: 'Delivered', 'Tracking Detail': [{ Status: 'Pending', Activity_Date: '2026-11-01', Activity_Time: '09:00' }, { Status: 'Delivered', Activity_Date: '2026-11-02', Activity_Time: '14:00' }] }] },
    trackedNumber: 'LE123456789',
    expectedTrackStatus: 'delivered',
    cancel: { status: 1, error: 0 },
  },
});

describe('leopards specifics', () => {
  it('authenticates in the body, sends weight in grams, uses the test host in sandbox and the live host in live', async () => {
    const fetchMock = jest.fn().mockResolvedValue(mockRes(200, { status: 1, track_number: 'T1' }));
    (global as any).fetch = fetchMock;
    process.env.COURIER_ALLOW_UNVERIFIED = 'true';
    const p = new LeopardsCourierProvider();
    await p.bookShipment(ctx, { ...SAMPLE_INPUT, weightKg: 0.75 });
    await p.bookShipment({ ...ctx, mode: 'live' }, SAMPLE_INPUT);
    delete process.env.COURIER_ALLOW_UNVERIFIED;
    const [url1, init1] = fetchMock.mock.calls[0];
    const body = JSON.parse(init1.body);
    expect(url1).toContain('merchantapistaging');
    expect(body.api_key).toBe('AK-111111');
    expect(body.booked_packet_weight).toBe(750);
    expect(fetchMock.mock.calls[1][0]).toContain('merchantapi.leopardscourier.com');
  });
});
