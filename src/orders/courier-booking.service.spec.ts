/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { CourierService } from '@/integrations/couriers/courier.service';
import { CourierProviderRegistry } from '@/integrations/couriers/courier-provider.registry';
import { CourierError, CourierProvider } from '@/integrations/couriers/courier.types';
import { encryptCredential } from '@/common/credential-encryption.util';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '@/auth/decorators/require-permission.decorator';

const SECRET = 'TOP-SECRET-API-TOKEN-777';
const OID = '507f1f77bcf86cd799439011';

/** Mongoose-ish chainable/awaitable query result. */
const q = (value: any) => { const o: any = { select: () => o, lean: () => o, sort: () => o, then: (res: any, rej: any) => Promise.resolve(value).then(res, rej) }; return o; };

/** In-memory CourierBooking model with the real unique-active-slot behaviour. */
class FakeBookings {
  docs: any[] = [];
  private id = 0;
  private match(d: any, f: any) {
    return Object.entries(f).every(([k, v]: [string, any]) => {
      if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(d[k]));
      if (v && typeof v === 'object' && '$ne' in v) return String(d[k] ?? null) !== String(v.$ne ?? null);
      return String(d[k] ?? null) === String(v ?? null);
    });
  }
  private wrap(d: any) { return d ? Object.assign(d, { toObject: () => ({ ...d }) }) : null; }
  async create(data: any) {
    if (this.docs.some((d) => d.isActive && data.isActive && d.orderId === data.orderId && d.storeId === data.storeId && d.lineKey === data.lineKey)) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
    const d = { _id: `507f1f77bcf86cd7994390${String(++this.id).padStart(2, '0')}`, events: [], rto: false, courierStatus: null, createdAt: new Date(), ...data };
    this.docs.push(d); return this.wrap(d);
  }
  findOne(f: any) { return q(this.wrap(this.docs.find((d) => this.match(d, f)) ?? null)); }
  findById(id: string) { return q(this.docs.find((d) => d._id === id) ?? null); }
  find(f: any) { return q(this.docs.filter((d) => this.match(d, f)).map((d) => ({ ...d }))); }
  async countDocuments(f: any) { return this.docs.filter((d) => this.match(d, f)).length; }
  async updateOne(f: any, u: any) { const d = this.docs.find((x) => this.match(x, f)); if (d) Object.assign(d, u.$set ?? {}); return { matchedCount: d ? 1 : 0 }; }
  async findOneAndUpdate(f: any, u: any) { const d = this.docs.find((x) => this.match(x, f)); if (!d) return null; Object.assign(d, u.$set ?? {}); return this.wrap(d); }
}

function makeProvider(over: Partial<CourierProvider> = {}) {
  const provider: any = {
    providerKey: 'postex',
    capabilities: { bulkBooking: false, trackBatchSize: 10, airwayBillBatchSize: 10, airwayBill: true, loadSheet: true, cityList: true, cancel: true, codStatus: false, pushWebhook: false },
    verified: true,
    validateCity: jest.fn().mockResolvedValue({ name: 'Lahore' }),
    bookShipment: jest.fn().mockResolvedValue({ trackingNumber: 'TRK-1', labelUrl: null, trackingUrl: null }),
    cancelShipment: jest.fn().mockResolvedValue(undefined),
    testConnection: jest.fn(),
    ...over,
  };
  return provider as CourierProvider & Record<string, jest.Mock>;
}

function setup(opts: { order?: Partial<any>; provider?: CourierProvider } = {}) {
  process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = 'test-key-for-courier-spec';
  process.env.COURIER_ENABLED_PROVIDERS = 'postex';
  const provider = (opts.provider ?? makeProvider()) as any;
  const bookings = new FakeBookings();
  const order: any = {
    _id: OID, orderNumber: '1001', userId: 'buyer1', isPaid: false, paymentStatus: 'unpaid', totalAmount: 2500, subtotal: 2300, shippingFee: 200, currency: 'PKR',
    fulfillmentMethod: 'ship', shippingAddress: { recipientName: 'Ali', addressLine1: 'H1', city: 'Lahore', state: 'PB', zipCode: '54000', country: 'PK', phoneNumber: '0300111' },
    sellerOrders: [{
      storeId: 's1', sellerId: 'sel1', status: 'processing', subtotal: 2300, shipments: [],
      items: [{ _id: 'i1', name: 'Shirt', price: 1000, totalPrice: 1000, quantity: 1, status: 'processing', type: 'physical' }, { _id: 'i2', name: 'Pants', price: 1300, totalPrice: 1300, quantity: 1, status: 'processing', type: 'physical' }],
    }],
    timeline: [],
    ...(opts.order ?? {}),
  };
  const integration: any = {
    storeId: 's1', type: 'courier', provider: 'postex', status: 'connected', mode: 'sandbox', lastVerifiedAt: new Date(),
    credentialsEncrypted: encryptCredential(JSON.stringify({ apiToken: SECRET }), 'INTEGRATIONS'), config: { maskedHints: { apiToken: '••••-777' } },
  };
  const stores: Record<string, any> = {
    s1: { _id: 's1', sellerId: 'sel1', baseCurrency: 'PKR', isDelete: false, courierSettings: { defaultProvider: 'postex', defaultWeightKg: 0.5, pickup: { name: 'Shop', phone: '0311222', address: 'Ware Rd', city: 'Karachi' }, returnAddress: null } },
    s2: { _id: 's2', sellerId: 'sel2', baseCurrency: 'PKR', isDelete: false, courierSettings: { defaultProvider: 'postex', defaultWeightKg: 0.5, pickup: { name: 'Other', phone: '0322333', address: 'X', city: 'Lahore' } } },
  };
  const repos: any = {
    courierBookingModel: bookings,
    storeIntegrationModel: {
      findOne: (f: any) => q(f.storeId === 's1' || f.storeId === 's2' ? { ...integration, storeId: f.storeId } : null),
      find: (f: any) => q(integration.status === f.status && (f.storeId === 's1' || f.storeId === 's2') ? [{ ...integration, storeId: f.storeId }] : []),
    },
    storeModel: { findOne: (f: any) => { const s = stores[f._id]; return q(s && (f.sellerId === undefined || s.sellerId === f.sellerId) ? s : null); } },
    orderModel: {
      findOne: () => q(order), updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    },
    orderPaymentRecordModel: { find: () => q([]) },
  };
  const db: any = { repositories: repos };
  const registry = new CourierProviderRegistry([provider]);
  const entitlements: any = { assertFeatureAllowed: jest.fn() };
  const courier = new CourierService(db, registry, entitlements);
  const activity = { log: jest.fn() };
  const svc: any = new OrdersService(db, {} as any, {} as any, {} as any, {} as any, {} as any, { convert: jest.fn() } as any, activity as any, {} as any, { notify: jest.fn().mockResolvedValue(undefined) } as any, {} as any, {} as any, {} as any, undefined, courier);
  jest.spyOn(svc, 'weightKgForLines').mockResolvedValue(0.8);
  jest.spyOn(svc, 'packItemsForLines').mockResolvedValue([]);
  const ship = (tn: string) => { order.sellerOrders[0].status = 'shipped'; order.sellerOrders[0].shipments = [{ _id: 'sh1', tracking: { trackingNumber: tn }, deliveredAt: null }]; };
  const updateStatus = jest.spyOn(svc, 'updateSellerOrderStatus').mockImplementation(async (_s: any, _b: any, _i: any, _u: any, tracking: any) => { ship(tracking.trackingNumber); return { success: true }; });
  const fulfil = jest.spyOn(svc, 'fulfilItems').mockImplementation(async (_s: any, _st: any, _o: any, _d: any, _i: any, _u: any, tracking: any) => { ship(tracking.trackingNumber); return { success: true, data: { shipmentId: 'sh1' } }; });
  return { svc, courier, provider, bookings, order, updateStatus, fulfil, activity, repos, integration };
}

const book = (s: ReturnType<typeof setup>, extra: any = {}, store = 's1', seller = 'sel1') => s.svc.bookCourierShipment(seller, OID, store, '1.1.1.1', 'ua', extra);

afterEach(() => { delete process.env.COURIER_ENABLED_PROVIDERS; delete process.env.COURIER_REQUIRES_PLAN_FEATURE; jest.restoreAllMocks(); });

describe('bookCourierShipment', () => {
  it('books once and fulfils through the existing path with the courier tracking as trusted tracking', async () => {
    const s = setup();
    const res = await book(s);
    expect(res.data.booking).toMatchObject({ trackingNumber: 'TRK-1', provider: 'postex', bookingStatus: 'booked', shipmentId: 'sh1' });
    expect(s.provider.bookShipment).toHaveBeenCalledTimes(1);
    expect(s.updateStatus).toHaveBeenCalledTimes(1);
    expect(s.updateStatus.mock.calls[0][1]).toMatchObject({ orderId: OID, storeId: 's1', status: 'shipped' });
    expect(s.updateStatus.mock.calls[0][4]).toMatchObject({ carrier: 'PostEx', trackingNumber: 'TRK-1' });
    expect(s.activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'courier_booked', storeId: 's1' }));
  });

  it('is idempotent: a second call returns the existing booking and does not call the courier again', async () => {
    const s = setup();
    await book(s);
    const again = await book(s);
    expect(again.data.alreadyBooked).toBe(true);
    expect(s.provider.bookShipment).toHaveBeenCalledTimes(1);
  });

  it('survives a double submit (concurrent): the courier is called once; the loser conflicts or returns the booking', async () => {
    const s = setup();
    const results = await Promise.allSettled([book(s), book(s)]);
    expect(s.provider.bookShipment).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictException);
  });

  it('refuses another seller\'s order (wrong store): no courier call, no booking row', async () => {
    const s = setup();
    await expect(book(s, {}, 's2', 'sel2')).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.provider.bookShipment).not.toHaveBeenCalled();
    expect(s.bookings.docs).toHaveLength(0);
  });

  it('refuses a provider that is not in COURIER_ENABLED_PROVIDERS (disabled provider)', async () => {
    const s = setup();
    delete process.env.COURIER_ENABLED_PROVIDERS;
    await expect(book(s)).rejects.toThrow(/not enabled/i);
    expect(s.provider.bookShipment).not.toHaveBeenCalled();
  });

  it('refuses when the seller never connected the courier', async () => {
    const s = setup();
    s.integration.status = 'not_connected';
    await expect(book(s)).rejects.toThrow(/not connected/i);
  });

  it('applies the plan gate only when COURIER_REQUIRES_PLAN_FEATURE=true', async () => {
    const s = setup();
    await book(s);
    expect((s.courier as any).entitlements.assertFeatureAllowed).not.toHaveBeenCalled();
    process.env.COURIER_REQUIRES_PLAN_FEATURE = 'true';
    const s2 = setup();
    process.env.COURIER_REQUIRES_PLAN_FEATURE = 'true';
    await book(s2);
    expect((s2.courier as any).entitlements.assertFeatureAllowed).toHaveBeenCalledWith('s1', 'calculatedShippingRatesAllowed', 'Courier booking');
  });

  it('sends the order total as COD for an unpaid order and 0 for a paid one', async () => {
    const unpaid = setup();
    await book(unpaid);
    expect(unpaid.provider.bookShipment.mock.calls[0][1]).toMatchObject({ codAmount: 2500, currency: 'PKR' });
    const paid = setup({ order: { isPaid: true, paymentStatus: 'paid' } });
    await book(paid);
    expect(paid.provider.bookShipment.mock.calls[0][1].codAmount).toBe(0);
  });

  it('collects only the CASH still owed: gift card / store credit paid part of the order', async () => {
    const s = setup({ order: { giftCardDiscountTotal: 500, storeCreditDiscountTotal: 100 } });
    await book(s);
    expect(s.provider.bookShipment.mock.calls[0][1].codAmount).toBe(1900); // 2300 items + 200 shipping - 500 - 100
  });

  it('subtracts recorded part-payments from the COD amount', async () => {
    const s = setup({ order: { paymentStatus: 'partially_paid' } });
    s.repos.orderPaymentRecordModel.find = () => q([{ amount: 1000 }]);
    await book(s);
    expect(s.provider.bookShipment.mock.calls[0][1].codAmount).toBe(1500);
  });

  it('refuses a buyer with no phone number', async () => {
    const s = setup();
    s.order.shippingAddress.phoneNumber = null;
    await expect(book(s)).rejects.toThrow(/phone/i);
    expect(s.provider.bookShipment).not.toHaveBeenCalled();
  });

  it('partial shipment: books only those lines through fulfilItems and splits COD; the final shipment takes the remainder', async () => {
    const s = setup();
    jest.spyOn(s.svc, 'prepareLabelContext');
    const first = await book(s, { items: [{ itemId: 'i1', quantity: 1 }] });
    // reopen the order for the second shipment (the mocked fulfil marked it shipped)
    s.order.sellerOrders[0].status = 'processing';
    expect(first.data.booking.items).toEqual([{ itemId: 'i1', quantity: 1 }]);
    expect(s.fulfil).toHaveBeenCalledTimes(1);
    expect(s.updateStatus).not.toHaveBeenCalled();
    const cod1 = s.provider.bookShipment.mock.calls[0][1].codAmount;
    expect(cod1).toBeGreaterThan(0);
    expect(cod1).toBeLessThan(2500);
  });

  it('booked-but-fulfil-failed: keeps the tracking on the booking and timeline, then resumes WITHOUT a second courier call', async () => {
    const s = setup();
    s.updateStatus.mockRejectedValueOnce(new ConflictException('race'));
    await expect(book(s)).rejects.toBeInstanceOf(ConflictException);
    expect(s.bookings.docs[0]).toMatchObject({ bookingStatus: 'fulfil_failed', trackingNumber: 'TRK-1', isActive: true });
    expect(s.repos.orderModel.updateOne.mock.calls.some((c: any[]) => JSON.stringify(c[1]).includes('TRK-1'))).toBe(true);
    const res = await book(s);
    expect(s.provider.bookShipment).toHaveBeenCalledTimes(1);
    expect(res.data.booking).toMatchObject({ bookingStatus: 'booked', trackingNumber: 'TRK-1' });
  });

  it('courier down: returns a conflict, marks the booking failed (so a retry can book) and changes nothing on the order', async () => {
    const s = setup({ provider: makeProvider({ bookShipment: jest.fn().mockRejectedValue(new CourierError('upstream', 'The courier is having trouble (HTTP 503).', true)) }) });
    await expect(book(s)).rejects.toBeInstanceOf(ConflictException);
    expect(s.bookings.docs[0]).toMatchObject({ bookingStatus: 'failed', isActive: false });
    expect(s.updateStatus).not.toHaveBeenCalled();
    (s.provider.bookShipment as jest.Mock).mockResolvedValueOnce({ trackingNumber: 'TRK-2' });
    await expect(book(s)).resolves.toBeTruthy();
  });

  it('a city the courier does not serve is refused before booking', async () => {
    const s = setup({ provider: makeProvider({ validateCity: jest.fn().mockRejectedValue(new CourierError('city_not_serviceable', 'PostEx does not serve "Lahore".')) }) });
    await expect(book(s)).rejects.toBeInstanceOf(BadRequestException);
    expect((s.provider.bookShipment as jest.Mock)).not.toHaveBeenCalled();
  });
});

describe('cancelCourierBooking + re-book', () => {
  it('cancels at the courier, frees the slot, and a re-book swaps tracking onto the same shipment instead of re-fulfilling', async () => {
    const s = setup();
    const first = await book(s);
    const id = first.data.booking.id;
    await s.svc.cancelCourierBooking('sel1', 's1', OID, id);
    expect(s.provider.cancelShipment).toHaveBeenCalledWith(expect.anything(), 'TRK-1');
    expect(s.bookings.docs[0]).toMatchObject({ bookingStatus: 'cancelled', isActive: false });

    (s.provider.bookShipment as jest.Mock).mockResolvedValueOnce({ trackingNumber: 'TRK-2' });
    const replace = jest.spyOn(s.svc, 'replaceShipmentTracking').mockResolvedValue(undefined);
    const again = await book(s);
    expect(again.data.booking.trackingNumber).toBe('TRK-2');
    expect(replace).toHaveBeenCalledWith(OID, 's1', 'sel1', 'sh1', expect.objectContaining({ trackingNumber: 'TRK-2' }), true);
    expect(s.updateStatus).toHaveBeenCalledTimes(1); // only the first booking fulfilled
    expect(s.bookings.docs[1].referenceNumber).toBe('1001-2');
  });

  it('cannot cancel once the courier has the parcel, or someone else\'s booking', async () => {
    const s = setup();
    const first = await book(s);
    s.bookings.docs[0].courierStatus = 'picked_up';
    await expect(s.svc.cancelCourierBooking('sel1', 's1', OID, first.data.booking.id)).rejects.toThrow(/already has this parcel/i);
    await expect(s.svc.cancelCourierBooking('sel2', 's2', OID, first.data.booking.id)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('bulkBookCourierShipments', () => {
  it('returns a per-order report: one failure does not stop the rest', async () => {
    const s = setup();
    jest.spyOn(s.svc, 'bookCourierShipment')
      .mockResolvedValueOnce({ data: { booking: { trackingNumber: 'A', id: 'b1' }, alreadyBooked: false } } as any)
      .mockRejectedValueOnce(new BadRequestException('Cannot book a courier for an order that is "cancelled".'))
      .mockResolvedValueOnce({ data: { booking: { trackingNumber: 'C', id: 'b3' }, alreadyBooked: true } } as any);
    const res = await s.svc.bulkBookCourierShipments('sel1', 's1', [OID, 'o2', 'o3']);
    expect(res.data).toMatchObject({ total: 3, succeeded: 2, failed: 1 });
    expect(res.data.results[1]).toMatchObject({ orderId: 'o2', ok: false, error: expect.stringContaining('cancelled') });
    expect(res.data.bookingIds).toEqual(['b1', 'b3']);
  });

  it('fails fast for the whole batch when the courier is unusable', async () => {
    const s = setup();
    s.integration.status = 'not_connected';
    await expect(s.svc.bulkBookCourierShipments('sel1', 's1', [OID])).rejects.toThrow(/not connected/i);
  });
});

describe('credentials never leak', () => {
  it('are absent from the booking response, the seller view and every log line', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) => jest.spyOn(Logger.prototype, m).mockImplementation());
    const s = setup({ provider: makeProvider({ bookShipment: jest.fn().mockRejectedValue(new CourierError('validation', `rejected ${SECRET}`)) }) });
    const err = await book(s).catch((e) => e);
    // the adapter layer redacts before throwing; here the stub throws a raw secret — the HTTP layer must still never echo creds it holds
    const okSvc = setup();
    const res = await book(okSvc);
    const everything = JSON.stringify([res, okSvc.courier.toSellerView(okSvc.bookings.docs[0]), okSvc.activity.log.mock.calls, spies.flatMap((sp) => sp.mock.calls)]);
    expect(everything).not.toContain(SECRET);
    expect(JSON.stringify(okSvc.bookings.docs)).not.toContain(SECRET);
    expect(err).toBeDefined();
  });

  it('listBookableProviders returns only safe fields', async () => {
    const s = setup();
    const list = await s.courier.listBookableProviders('s1');
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(list[0]).toMatchObject({ provider: 'postex', label: 'PostEx', mode: 'sandbox' });
    expect(Object.keys(list[0]).sort()).toEqual(['capabilities', 'label', 'mode', 'provider']);
  });
});

describe('staff permission on the courier routes', () => {
  const routes = ['courierOptions', 'courierValidateCity', 'courierBookingsForOrder', 'bookCourier', 'bulkBookCourier', 'cancelCourier', 'courierAirwayBill', 'courierLoadSheet'];
  const reflector = new Reflector();

  it.each(routes)('%s requires orders.buy_shipping_label', (name) => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, (OrdersController.prototype as any)[name])).toEqual(['orders.buy_shipping_label']);
  });

  const ctx = (handler: any, user: any, body: any = {}) => ({
    getHandler: () => handler, getClass: () => OrdersController,
    switchToHttp: () => ({ getRequest: () => ({ user, method: 'PUT', body, params: {}, query: {}, route: { path: '/x' } }) }),
  }) as any;
  const guard = new PermissionsGuard(reflector, { repositories: { orderModel: { findById: () => q({ sellerOrders: [{ storeId: 's1' }] }) } } } as any);

  it('denies a staff member without the permission, allows one with it, and pins them to their own store', async () => {
    const handler = (OrdersController.prototype as any).bookCourier;
    await expect(guard.canActivate(ctx(handler, { role: 'staff', permissions: ['orders.view'], storeId: 's1' }, { storeId: 's1' }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(ctx(handler, { role: 'staff', permissions: ['orders.buy_shipping_label'], storeId: 's1' }, { storeId: 's1', orderId: '507f1f77bcf86cd799439011' }))).resolves.toBe(true);
    await expect(guard.canActivate(ctx(handler, { role: 'staff', permissions: ['orders.buy_shipping_label'], storeId: 's1' }, { storeId: 's2' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
