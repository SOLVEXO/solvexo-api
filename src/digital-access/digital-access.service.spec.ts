import { DigitalAccessService } from './digital-access.service';
import { FakeModel, digitalProduct, makeDb, paidOrder } from './testing/fake-db.kit-spec';
import { ORDER_CHANGED, emitOrderChanged, orderEvents } from '../common/order-events';

function setup(orderOver: any = {}) {
  const k = makeDb();
  const accessModel = new FakeModel({ status: 'active', downloadCount: 0, audit: [] });
  const logModel = new FakeModel();
  k.orderModel.rows.push(paidOrder(orderOver));
  k.productModel.rows.push(digitalProduct());
  const mailer: any = { purchaseDelivered: jest.fn(), fileUpdated: jest.fn() };
  const access = new DigitalAccessService(k.db, accessModel as any, logModel as any, mailer);
  return { ...k, accessModel, logModel, mailer, access, item: () => k.orderModel.rows[0].sellerOrders[0].items[0] };
}

describe('DigitalAccessService.can()', () => {
  it('lets the buyer of a paid order in', async () => {
    const s = setup();
    const r = await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' });
    expect(r.allowed).toBe(true);
  });

  it('denies another customer and another store', async () => {
    const s = setup();
    expect((await s.access.can('s1', 'c2', { kind: 'file', ref: 'p1' })).allowed).toBe(false);
    expect((await s.access.can('s2', 'c1', { kind: 'file', ref: 'p1' })).allowed).toBe(false);
  });

  it('denies an unpaid order', async () => {
    const s = setup({ isPaid: false });
    expect((await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' })).allowed).toBe(false);
  });

  it('a refunded or cancelled item revokes the access (pull-based safety net)', async () => {
    for (const status of ['refunded', 'cancelled']) {
      const s = setup();
      expect((await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' })).allowed).toBe(true);
      s.item().status = status;
      const r = await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' });
      expect(r.allowed).toBe(false);
      expect(s.accessModel.rows[0].status).toBe('revoked');
    }
  });

  it('access expires after linkExpiryDays', async () => {
    const s = setup();
    await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' });
    s.accessModel.rows[0].expiresAt = new Date(Date.now() - 1000);
    const r = await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('expired');
  });

  it('a revoked record is never re-activated by a later grant', async () => {
    const s = setup();
    await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' });
    await s.access.revoke(s.accessModel.rows[0], 'seller', 'test');
    expect((await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' })).allowed).toBe(false);
    expect(s.accessModel.rows.length).toBe(1);
  });
});

describe('event-driven grant and revoke', () => {
  it('grants at payment time and mails once, even when the paid event arrives twice (webhook retry)', async () => {
    const s = setup();
    await s.access.onOrderChanged('o1');
    await s.access.onOrderChanged('o1');
    expect(s.accessModel.rows.length).toBe(1);
    expect(s.mailer.purchaseDelivered.mock.calls.length).toBe(1);
  });

  it('parallel paid events (two API copies / duplicate webhook) still produce ONE mail and ONE record', async () => {
    const s = setup();
    await Promise.all([s.access.onOrderChanged('o1'), s.access.onOrderChanged('o1'), s.access.onOrderChanged('o1')]);
    expect(s.accessModel.rows.length).toBe(1);
    expect(s.mailer.purchaseDelivered.mock.calls.length).toBe(1);
    expect(!!s.accessModel.rows[0].mailedAt).toBe(true);
  });

  it('a crash between the grant and the mail is repaired by the next event (mail never missing)', async () => {
    const s = setup();
    await s.access.onOrderChanged('o1');
    s.accessModel.rows[0].mailedAt = null; // the process died before the mail was claimed
    s.mailer.purchaseDelivered.mock.calls.length = 0;
    await s.access.onOrderChanged('o1');
    expect(s.mailer.purchaseDelivered.mock.calls.length).toBe(1);
    await s.access.onOrderChanged('o1');
    expect(s.mailer.purchaseDelivered.mock.calls.length).toBe(1);
  });

  it('records granted long ago (before the mail guard existed) never get a surprise mail', async () => {
    const s = setup();
    await s.access.onOrderChanged('o1');
    s.accessModel.rows[0].mailedAt = null;
    s.accessModel.rows[0].createdAt = new Date(Date.now() - 3 * 86_400_000);
    s.mailer.purchaseDelivered.mock.calls.length = 0;
    s.item().status = 'pending';
    await s.access.onOrderChanged('o1');
    expect(s.mailer.purchaseDelivered.mock.calls.length).toBe(0);
  });

  it('a duplicate-key race on one item does not stop the other items of the order from being granted', async () => {
    const s = setup({ sellerOrders: [{ storeId: 's1', items: [
      { _id: 'i1', type: 'digital', productId: 'p1', status: 'pending' },
      { _id: 'i2', type: 'digital', productId: 'p2', status: 'pending' },
    ] }] });
    s.productModel.rows.push(digitalProduct({ _id: 'p2', name: 'Second' }));
    const real = s.accessModel.updateOne.bind(s.accessModel);
    let first = true;
    (s.accessModel as any).updateOne = async (f: any, u: any, o: any) => {
      if (first && f.resourceRef === 'p1' && o?.upsert) { first = false; throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 }); }
      return real(f, u, o);
    };
    await s.access.onOrderChanged('o1');
    expect(s.accessModel.rows.some((r) => r.resourceRef === 'p2')).toBe(true);
  });

  it('does not grant for an unpaid order, and grants as soon as it is paid', async () => {
    const s = setup({ isPaid: false });
    await s.access.onOrderChanged('o1');
    expect(s.accessModel.rows.length).toBe(0);
    s.orderModel.rows[0].isPaid = true;
    await s.access.onOrderChanged('o1');
    expect(s.accessModel.rows.length).toBe(1);
  });

  it('digital items in a mixed cart do not wait for shipping', async () => {
    const s = setup({
      fulfillmentType: 'mixed',
      sellerOrders: [{ storeId: 's1', items: [
        { _id: 'i1', type: 'digital', productId: 'p1', status: 'pending' },
        { _id: 'i2', type: 'physical', productId: 'p9', status: 'pending' },
      ] }],
    });
    await s.access.onOrderChanged('o1');
    expect(s.accessModel.rows.length).toBe(1);
    expect((await s.access.can('s1', 'c1', { kind: 'file', ref: 'p1' })).allowed).toBe(true);
  });

  it('refund and cancel revoke through the event, without anyone opening the library', async () => {
    const s = setup();
    await s.access.onOrderChanged('o1');
    s.item().status = 'refunded';
    await s.access.onOrderChanged('o1');
    expect(s.accessModel.rows[0].status).toBe('revoked');
  });

  it('a chargeback revokes every access of the order', async () => {
    const s = setup();
    await s.access.onOrderChanged('o1');
    const n = await s.access.revokeDisputed(['o1']);
    expect(n).toBe(1);
    expect(s.accessModel.rows[0].status).toBe('revoked');
    expect(JSON.stringify(s.accessModel.rows[0].audit)).toContain('chargeback');
  });

  it('orders without digital items are ignored cheaply', async () => {
    const s = setup({ sellerOrders: [{ storeId: 's1', items: [{ _id: 'i1', type: 'physical', productId: 'p9', status: 'pending' }] }] });
    await s.access.onOrderChanged('o1');
    expect(s.accessModel.rows.length).toBe(0);
  });

  it('the order event bus reaches a subscribed service', async () => {
    const s = setup();
    s.access.onModuleInit();
    emitOrderChanged('o1');
    await new Promise((r) => setTimeout(r, 400));
    expect(s.accessModel.rows.length).toBe(1);
    orderEvents.removeAllListeners(ORDER_CHANGED);
  });
});

describe('seller actions', () => {
  it('resend / reset limit / revoke are scoped to the store (wrong store = 404)', async () => {
    const s = setup();
    await s.access.onOrderChanged('o1');
    const id = s.accessModel.rows[0]._id;
    await expect(s.access.sellerRevoke('s2', id, 'x')).rejects.toThrow('Access not found');
    await expect(s.access.sellerResetLimit('s2', id, 'x')).rejects.toThrow('Access not found');
    s.accessModel.rows[0].downloadCount = 3;
    await s.access.sellerResetLimit('s1', id, 'seller');
    expect(s.accessModel.rows[0].downloadCount).toBe(0);
    await s.access.sellerRevoke('s1', id, 'seller');
    expect(s.accessModel.rows[0].status).toBe('revoked');
    await expect(s.access.sellerResend('s1', id, 'seller')).rejects.toThrow('revoked');
  });
});
