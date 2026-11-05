/* eslint-disable prettier/prettier */
import { PostexCourierProvider } from './postex.provider';
import { mockRes, runCourierContract } from './courier-contract.testkit';

const ctx = { credentials: { apiToken: 'SECRET-KEY-VALUE-42' }, mode: 'sandbox' as const, config: {} };

runCourierContract({
  name: 'postex',
  make: () => new PostexCourierProvider(),
  ctx,
  secretValue: 'SECRET-KEY-VALUE-42',
  bodies: {
    cities: { statusCode: '200', dist: [{ operationalCityName: 'Lahore' }, { operationalCityName: 'Karachi' }] },
    book: { statusCode: '200', statusMessage: 'ORDER HAS BEEN CREATED', dist: { trackingNumber: '2500100001' } },
    expectedTracking: '2500100001',
    // PostEx reports failures as HTTP 200 + a non-200 statusCode envelope.
    bookValidation: { status: 200, body: { statusCode: '400', statusMessage: 'Invalid phone SECRET-KEY-VALUE-42' } },
    authFailure: { status: 401, body: {} },
    track: {
      statusCode: '200',
      dist: [{ trackingNumber: '2500100001', transactionStatus: 'Delivered', transactionStatusHistory: [
        { transactionStatusMessage: 'Booked', updatedAt: '2026-11-01T08:00:00Z' },
        { transactionStatusMessage: 'Delivered', updatedAt: '2026-11-02T09:00:00Z' },
      ] }],
    },
    trackedNumber: '2500100001',
    expectedTrackStatus: 'delivered',
    cancel: { statusCode: '200', statusMessage: 'ORDER CANCELLED' },
  },
});

describe('postex specifics', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn(); (global as any).fetch = fetchMock; });

  it('sends the token header and the merchant pickup address code, and batches tracking by 10', async () => {
    const p = new PostexCourierProvider();
    fetchMock.mockResolvedValue(mockRes(200, { statusCode: '200', dist: [] }));
    await p.trackShipments(ctx, Array.from({ length: 23 }, (_, i) => `T${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][1].headers.token).toBe('SECRET-KEY-VALUE-42');
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(mockRes(200, { statusCode: '200', dist: { trackingNumber: 'X1' } }));
    await p.bookShipment(ctx, { referenceNumber: 'R', consignee: { name: 'a', phone: '1', address: 'x', city: 'Lahore' }, pickup: { name: 'b', phone: '2', address: 'y', city: 'Karachi', addressCode: 'PK-77' }, weightKg: 1, pieces: 1, codAmount: 0, currency: 'PKR', description: 'd' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.pickupAddressCode).toBe('PK-77');
    expect(body.invoicePayment).toBe('0');
  });

  it('returns airway-bill PDF bytes', async () => {
    const p = new PostexCourierProvider();
    fetchMock.mockResolvedValue(mockRes(200, '%PDF-1.4 fake', 'application/pdf'));
    const doc = await p.getAirwayBill(ctx, ['1']);
    expect(Buffer.isBuffer(doc.pdf)).toBe(true);
  });
});
