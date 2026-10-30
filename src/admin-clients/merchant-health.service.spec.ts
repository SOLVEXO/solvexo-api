/* eslint-disable prettier/prettier */
import { MerchantHealthService } from './merchant-health.service';

const q = (rows: any) => { const p: any = Promise.resolve(rows); p.select = () => p; p.lean = () => p; return p; };
const NOW = new Date('2026-10-30T12:00:00Z').getTime();
const ago = (d: number) => new Date(NOW - d * 86_400_000);

function build() {
  const stores = [
    { _id: 'st1', name: 'Bloom Florist', slug: 'bloom', sellerId: 'se1', status: 'active', createdAt: ago(300) },
    { _id: 'st2', name: 'Quiet Books', slug: 'quiet', sellerId: 'se2', status: 'active', createdAt: ago(300) },
  ];
  const orderAggregate = jest.fn()
    .mockResolvedValueOnce([{ _id: 'st1', lastOrderAt: ago(2) }, { _id: 'st2', lastOrderAt: ago(100) }]) // all-time last order
    .mockResolvedValueOnce([{ _id: 'st1', rev30: 900, prev30: 800, gross90: 2500, refunded90: 10 }]); // last 90 days
  const r: any = {
    storeModel: { find: jest.fn(() => q(stores)) },
    sellerModel: { find: jest.fn(() => q([{ _id: 'se1', name: 'Ana', email: 'ana@bloom.test' }, { _id: 'se2', name: 'Bo', email: 'bo@quiet.test' }])) },
    sellerPlatformSubscriptionModel: { find: jest.fn(() => q([
      { storeId: 'st1', status: 'active', amountUSD: 49, billingInterval: 'monthly' },
      { storeId: 'st2', status: 'past_due', amountUSD: 29, billingInterval: 'monthly', failedPaymentAttempts: 3 },
    ])) },
    orderModel: { aggregate: orderAggregate },
    activityLogModel: { aggregate: jest.fn(async () => [{ _id: 'st1', at: ago(1) }]) },
    productModel: { find: jest.fn(() => q([...Array.from({ length: 25 }, (_, i) => ({ _id: `p${i}`, storeId: 'st1' })), { _id: 'b1', storeId: 'st2' }])) },
    productVariantModel: { find: jest.fn(() => q([{ productId: 'b1', stock: 0 }])) },
  };
  return { svc: new MerchantHealthService({ repositories: r } as any), r };
}

describe('MerchantHealthService', () => {
  it('scores every store from its orders, sign-ins, catalog and plan, lowest first, with the at-risk summary', async () => {
    const { svc } = build();
    const { data } = await svc.list({}, NOW);
    expect(data.items.map((x: any) => [x.storeName, x.band])).toEqual([['Quiet Books', 'at_risk'], ['Bloom Florist', 'healthy']]);
    const quiet = data.items[0];
    expect(quiet).toMatchObject({ sellerEmail: 'bo@quiet.test', planStatus: 'past_due', mrr: 29, activeProducts: 1 });
    expect(quiet.reasons.map((x: any) => x.text)).toEqual(expect.arrayContaining(['Payment failed (3 attempts)', 'Last order 100 days ago', "Seller hasn't signed in for over 90 days"]));
    expect(data.items[1]).toMatchObject({ score: 100, revenueLast30: 900 });
    expect(data.summary).toMatchObject({ stores: 2, healthy: 1, atRisk: 1, mrrAtRisk: 29 });
  });

  it('filters by band and search; keeps the result for 5 minutes', async () => {
    const { svc, r } = build();
    expect((await svc.list({ band: 'healthy' }, NOW)).data.items.map((x: any) => x.storeName)).toEqual(['Bloom Florist']);
    expect((await svc.list({ search: 'bo@quiet' }, NOW + 1000)).data.items.map((x: any) => x.storeName)).toEqual(['Quiet Books']);
    expect(r.storeModel.find).toHaveBeenCalledTimes(1);
  });

  it('exports every matching row as CSV with the reasons', async () => {
    const { svc } = build();
    await svc.list({}, Date.now()); // warm the cache at the real clock (export uses it)
    const csv = await svc.exportCsv({ band: 'at_risk' });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('store,seller,email,score,band,mrr_usd,plan_status,last_order,last_seller_login,active_products,revenue_last_30_usd,reasons');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^Quiet Books,Bo,bo@quiet\.test,\d+,at_risk,29,past_due,.*Payment failed \(3 attempts\)/);
  });
});
