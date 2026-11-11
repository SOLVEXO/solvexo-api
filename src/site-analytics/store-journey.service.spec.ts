/* eslint-disable prettier/prettier */
import { StoreJourneyService } from './store-journey.service';

const now = new Date('2026-11-11T12:00:00Z');
const days = (n: number) => new Date(now.getTime() - n * 86_400_000);

/** A chainable stand-in for `model.find(...).select(...).sort(...).lean()`. */
const finder = (rows: any[]) => {
  const q: any = { select: () => q, sort: () => q, lean: async () => rows };
  return jest.fn(() => q);
};

function serviceWith(opts: { stores: any[]; productStores: string[]; planStores: string[]; orderStores: string[]; sellers: any[] }) {
  const repositories = {
    storeModel: { find: finder(opts.stores) },
    productModel: { distinct: jest.fn(async () => opts.productStores) },
    sellerPlatformSubscriptionModel: { distinct: jest.fn(async () => opts.planStores) },
    orderModel: { distinct: jest.fn(async () => opts.orderStores) },
    sellerModel: { find: finder(opts.sellers) },
  };
  return { svc: new StoreJourneyService({ repositories } as any), repositories };
}

describe('StoreJourneyService', () => {
  const stores = [
    { _id: 's1', name: 'Noor Crafts', slug: 'noor', sellerId: 'u1', createdAt: days(1) },
    { _id: 's2', name: 'Ali Mobiles', slug: 'ali', sellerId: 'u2', createdAt: days(2) },
    { _id: 's3', name: 'Hina Boutique', slug: 'hina', sellerId: 'u3', createdAt: days(3) },
    { _id: 's4', name: 'Zara Shoes', slug: null, sellerId: 'u4', createdAt: days(4) },
  ];

  it('counts how many new stores reached each step', async () => {
    const { svc } = serviceWith({
      stores, productStores: ['s1', 's2', 'other-old-store'], planStores: ['s1'], orderStores: ['s1', 'elsewhere'], sellers: [],
    });
    const { data } = await svc.journey('7d', now);
    expect(data.steps.map(s => [s.key, s.stores, s.fromPrevious])).toEqual([
      ['store_created', 4, null],
      ['product_added', 2, 50],
      ['plan_chosen', 1, 50],
      ['first_order', 1, 100],
    ]);
  });

  it('lists the stores without products, with the owner contact, newest first', async () => {
    const { svc, repositories } = serviceWith({
      stores, productStores: ['s1', 's2'], planStores: ['s4'], orderStores: [],
      sellers: [
        { _id: 'u3', name: 'Hina Ali', email: 'hina@example.com', phone: '+923001234567' },
        { _id: 'u4', name: 'Zara Khan', email: 'apple-relay@placeholder', phone: '', emailIsPlaceholder: true },
      ],
    });
    const { data } = await svc.journey('7d', now);
    expect(data.followUpTotal).toBe(2);
    expect(data.followUp).toEqual([
      { storeId: 's3', storeName: 'Hina Boutique', storeUrl: 'https://hina.solvexo.store', createdAt: days(3), ownerName: 'Hina Ali', email: 'hina@example.com', phone: '+923001234567', planChosen: false },
      { storeId: 's4', storeName: 'Zara Shoes', storeUrl: null, createdAt: days(4), ownerName: 'Zara Khan', email: '', phone: '', planChosen: true },
    ]);
    // Only stores from the period are looked at.
    expect((repositories.storeModel.find as jest.Mock).mock.calls[0][0]).toEqual({ isDelete: false, createdAt: { $gte: days(7) } });
  });

  it('handles a period with no new stores', async () => {
    const { svc, repositories } = serviceWith({ stores: [], productStores: [], planStores: [], orderStores: [], sellers: [] });
    const { data } = await svc.journey('28d', now);
    expect(data.steps.map(s => s.stores)).toEqual([0, 0, 0, 0]);
    expect(data.followUp).toEqual([]);
    expect(repositories.productModel.distinct).not.toHaveBeenCalled();
  });
});
