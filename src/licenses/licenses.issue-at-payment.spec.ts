process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'spec-only-key';
import { LicensesService } from './licenses.service';
import { FakeModel, FakeRedis, digitalProduct, makeDb, paidOrder } from '../digital-access/testing/fake-db.kit-spec';

function setup(orderOver: any = {}) {
  const k = makeDb();
  const keys = new FakeModel({ status: 'active', activations: [] });
  k.orderModel.rows.push(paidOrder(orderOver));
  k.productModel.rows.push(digitalProduct({ digital: { ...digitalProduct().digital, licenseKeys: { enabled: true, activationLimit: 2 } } }));
  const svc = new LicensesService(k.db, new FakeRedis() as any, keys as any);
  return { ...k, keys, svc };
}

describe('license keys are issued when the order is paid', () => {
  it('the key exists at once, before the buyer ever opens /licenses', async () => {
    const s = setup();
    expect(s.keys.rows.length).toBe(0);
    expect(await s.svc.issueForOrder('o1')).toBe(1);
    expect(s.keys.rows.length).toBe(1);
    expect(s.keys.rows[0].customerId).toBe('c1');
    expect(s.keys.rows[0].activationLimit).toBe(2);
  });

  it('is idempotent: the hook running twice, or the buyer opening /licenses afterwards, never makes a second key', async () => {
    const s = setup();
    await s.svc.issueForOrder('o1');
    expect(await s.svc.issueForOrder('o1')).toBe(0);
    await s.svc.listMine('s1', 'c1');
    expect(s.keys.rows.length).toBe(1);
  });

  it('an unpaid order gets no key', async () => {
    const s = setup({ isPaid: false });
    expect(await s.svc.issueForOrder('o1')).toBe(0);
    expect(s.keys.rows.length).toBe(0);
  });

  it('a cancelled item gets no key', async () => {
    const s = setup({ sellerOrders: [{ storeId: 's1', items: [{ _id: 'i1', type: 'digital', productId: 'p1', status: 'cancelled' }] }] });
    expect(await s.svc.issueForOrder('o1')).toBe(0);
  });
});
