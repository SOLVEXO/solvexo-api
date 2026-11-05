/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { CourierTrackingSyncService } from './courier-tracking-sync.service';
import { CourierError, CourierTrackResult } from '@/integrations/couriers/courier.types';

/** Tiny in-memory stand-in for the CourierBooking model: just the operators the sync service uses. */
class FakeBookingModel {
  docs = new Map<string, any>();
  add(d: any) { this.docs.set(String(d._id), { events: [], rto: false, deliveredAppliedAt: null, rtoNotifiedAt: null, syncFailures: 0, lastSyncedAt: null, isActive: true, bookingStatus: 'booked', ...d }); }
  private matches(doc: any, f: any): boolean {
    return Object.entries(f).every(([k, v]: [string, any]) => {
      if (k === 'events.hash') return !(doc.events ?? []).some((e: any) => v.$nin.includes(e.hash));
      if (v && typeof v === 'object' && '$in' in v) return v.$in.map(String).includes(String(doc[k]));
      return String(doc[k] ?? null) === String(v ?? null);
    });
  }
  private apply(doc: any, u: any) {
    for (const [k, v] of Object.entries(u.$set ?? {})) doc[k] = v;
    for (const [k, v] of Object.entries(u.$inc ?? {})) doc[k] = (doc[k] ?? 0) + (v as number);
    for (const [k, v] of Object.entries(u.$push ?? {})) doc[k] = [...(doc[k] ?? []), ...((v as any).$each ?? [v])];
  }
  async findById(id: string) { const d = this.docs.get(String(id)); return d ? { ...d } : null; }
  async findOneAndUpdate(f: any, u: any, o?: any) {
    const d = [...this.docs.values()].find((x) => this.matches(x, f));
    if (!d) return null; const before = { ...d }; this.apply(d, u); return o?.new ? { ...d } : before;
  }
  async updateOne(f: any, u: any) { const d = [...this.docs.values()].find((x) => this.matches(x, f)); if (d) this.apply(d, u); return { matchedCount: d ? 1 : 0 }; }
  async updateMany(f: any, u: any) { for (const d of this.docs.values()) if (this.matches(d, f)) this.apply(d, u); }
  find() { const self = this; return { sort() { return this; }, limit() { return this; }, lean: async () => [...self.docs.values()].map((x) => ({ ...x })) }; }
}

const ev = (status: any, raw: string, iso: string) => ({ status, rawStatus: raw, occurredAt: new Date(iso) });
const result = (status: any, events: any[], extra: Partial<CourierTrackResult> = {}): CourierTrackResult => ({ trackingNumber: 'TRK1', status, rawStatus: String(status), events, ...extra });

function setup() {
  const model = new FakeBookingModel();
  model.add({ _id: 'b1', storeId: 's1', sellerId: 'sel1', orderId: 'o1', provider: 'postex', trackingNumber: 'TRK1', shipmentId: 'sh1', courierStatus: 'booked' });
  const orderModel = { updateOne: jest.fn().mockResolvedValue({}) };
  const db: any = { repositories: { courierBookingModel: model, orderModel } };
  const courierSvc: any = { resolveConnection: jest.fn(), trackAtCourier: jest.fn() };
  const ordersService: any = { markShipmentDelivered: jest.fn().mockResolvedValue({ success: true }) };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const activity: any = { log: jest.fn() };
  const svc = new CourierTrackingSyncService(db, courierSvc, ordersService, notifications, activity);
  return { svc, model, orderModel, courierSvc, ordersService, notifications };
}

describe('CourierTrackingSyncService', () => {
  it('stores new events once and is idempotent on a repeated identical sync', async () => {
    const { svc, model } = setup();
    const r = result('in_transit', [ev('picked_up', 'Picked', '2026-11-01T08:00:00Z'), ev('in_transit', 'Moving', '2026-11-01T12:00:00Z')]);
    expect(await svc.applyTrackResult('b1', r)).toBe(true);
    expect(await svc.applyTrackResult('b1', r)).toBe(false);
    const b = model.docs.get('b1');
    expect(b.events).toHaveLength(2);
    expect(b.courierStatus).toBe('in_transit');
  });

  it('applies the delivered path exactly once even when delivered is seen repeatedly (duplicate delivered)', async () => {
    const { svc, ordersService } = setup();
    const r = result('delivered', [ev('delivered', 'Delivered', '2026-11-02T10:00:00Z')]);
    await svc.applyTrackResult('b1', r);
    await svc.applyTrackResult('b1', r);
    await svc.applyTrackResult('b1', r);
    expect(ordersService.markShipmentDelivered).toHaveBeenCalledTimes(1);
    expect(ordersService.markShipmentDelivered).toHaveBeenCalledWith('sel1', 's1', 'o1', 'sh1');
  });

  it('ignores an out-of-order status (in_transit arriving after out_for_delivery) and after a terminal state', async () => {
    const { svc, model, ordersService } = setup();
    await svc.applyTrackResult('b1', result('out_for_delivery', [ev('out_for_delivery', 'OFD', '2026-11-02T08:00:00Z')]));
    await svc.applyTrackResult('b1', result('in_transit', [ev('in_transit', 'Moving', '2026-11-01T08:00:00Z')]));
    expect(model.docs.get('b1').courierStatus).toBe('out_for_delivery');
    await svc.applyTrackResult('b1', result('delivered', [ev('delivered', 'D', '2026-11-02T10:00:00Z')]));
    await svc.applyTrackResult('b1', result('in_transit', [ev('in_transit', 'Late echo', '2026-11-02T11:00:00Z')]));
    expect(model.docs.get('b1').courierStatus).toBe('delivered');
    expect(ordersService.markShipmentDelivered).toHaveBeenCalledTimes(1);
  });

  it('RTO sets the seller-visible flag, timeline and one notification — and calls NO delivered/stock/refund path', async () => {
    const { svc, model, orderModel, notifications, ordersService } = setup();
    const r = result('returned', [ev('returned', 'Returned', '2026-11-03T10:00:00Z')]);
    await svc.applyTrackResult('b1', r);
    await svc.applyTrackResult('b1', r);
    expect(model.docs.get('b1').rto).toBe(true);
    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify.mock.calls[0][0]).toMatchObject({ recipientId: 'sel1', recipientRole: 'seller', storeId: 's1' });
    expect(orderModel.updateOne).toHaveBeenCalledTimes(1); // only the timeline push
    expect(ordersService.markShipmentDelivered).not.toHaveBeenCalled();
  });

  it('a delivered event after RTO is ignored (terminal)', async () => {
    const { svc, model, ordersService } = setup();
    await svc.applyTrackResult('b1', result('returned', [ev('returned', 'R', '2026-11-03T10:00:00Z')]));
    await svc.applyTrackResult('b1', result('delivered', [ev('delivered', 'D', '2026-11-04T10:00:00Z')]));
    expect(model.docs.get('b1').courierStatus).toBe('returned');
    expect(ordersService.markShipmentDelivered).not.toHaveBeenCalled();
  });

  it('courier-side cancellation frees the booking for re-booking and notes the order timeline', async () => {
    const { svc, model, orderModel } = setup();
    await svc.applyTrackResult('b1', result('cancelled', [ev('cancelled', 'Cancelled', '2026-11-01T09:00:00Z')]));
    expect(model.docs.get('b1')).toMatchObject({ bookingStatus: 'cancelled', isActive: false });
    expect(orderModel.updateOne).toHaveBeenCalled();
  });

  it('stores READ-ONLY COD info reported by the courier and never touches money paths', async () => {
    const { svc, model } = setup();
    await svc.applyTrackResult('b1', result('in_transit', [ev('in_transit', 'M', '2026-11-01T09:00:00Z')], { cod: { amount: 1500, status: 'Collected' } }));
    expect(model.docs.get('b1').cod).toEqual({ amount: 1500, status: 'Collected' });
  });

  it('a permanent 4xx from the delivered path keeps the claim (no endless retry); a server error releases it for retry', async () => {
    const a = setup();
    a.ordersService.markShipmentDelivered.mockRejectedValue(new BadRequestException('This order is cancelled.'));
    await a.svc.applyTrackResult('b1', result('delivered', [ev('delivered', 'D', '2026-11-02T10:00:00Z')]));
    expect(a.model.docs.get('b1').deliveredAppliedAt).not.toBeNull();

    const b = setup();
    b.ordersService.markShipmentDelivered.mockRejectedValueOnce(new Error('db blip'));
    await b.svc.applyTrackResult('b1', result('delivered', [ev('delivered', 'D', '2026-11-02T10:00:00Z')]));
    expect(b.model.docs.get('b1').deliveredAppliedAt).toBeNull();
    // the next sync retries and succeeds, still exactly one successful application
    await b.svc.applyTrackResult('b1', result('delivered', [ev('delivered', 'D', '2026-11-02T10:00:00Z')]));
    expect(b.ordersService.markShipmentDelivered).toHaveBeenCalledTimes(2);
    expect(b.model.docs.get('b1').deliveredAppliedAt).not.toBeNull();
  });

  describe('syncDueBookings', () => {
    it('records a failure (and keeps going) when the courier is down', async () => {
      const { svc, model, courierSvc } = setup();
      courierSvc.resolveConnection.mockResolvedValue({ provider: { capabilities: { trackBatchSize: 10 } }, key: 'postex' });
      courierSvc.trackAtCourier.mockRejectedValue(new CourierError('upstream', 'The courier is having trouble (HTTP 503).', true));
      const out = await svc.syncDueBookings();
      expect(out).toMatchObject({ checked: 1, failed: 1, updated: 0 });
      expect(model.docs.get('b1')).toMatchObject({ syncFailures: 1, lastSyncError: 'The courier is having trouble (HTTP 503).' });
    });

    it('records a failure when credentials/courier are no longer usable', async () => {
      const { svc, model, courierSvc } = setup();
      courierSvc.resolveConnection.mockRejectedValue(new BadRequestException('PostEx is not connected for this store'));
      const out = await svc.syncDueBookings();
      expect(out.failed).toBe(1);
      expect(model.docs.get('b1').syncFailures).toBe(1);
    });

    it('applies results through the real pipeline and resets the failure counter', async () => {
      const { svc, model, courierSvc } = setup();
      model.docs.get('b1').syncFailures = 0;
      courierSvc.resolveConnection.mockResolvedValue({ provider: { capabilities: { trackBatchSize: 10 } }, key: 'postex' });
      courierSvc.trackAtCourier.mockResolvedValue([result('picked_up', [ev('picked_up', 'P', '2026-11-01T08:00:00Z')])]);
      const out = await svc.syncDueBookings();
      expect(out).toMatchObject({ checked: 1, updated: 1, failed: 0 });
      expect(model.docs.get('b1').courierStatus).toBe('picked_up');
    });
  });
});
