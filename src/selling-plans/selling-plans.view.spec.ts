import { SellingPlansService } from './selling-plans.service';

// What a subscription is FOR: product name / photo / variant / price on every list, the detail with its orders, and the seller's pause reason.

const q = (value: unknown) => {
  const chain: any = { sort: () => chain, skip: () => chain, limit: () => chain, select: () => chain, lean: async () => value, then: (r: any) => Promise.resolve(value).then(r) };
  return chain;
};

function build() {
  const contract = (over: Record<string, unknown> = {}) => ({
    _id: 'c1', storeId: 's1', userId: 'u1', status: 'active', customerName: 'Muhammad Umer', nextBillingAt: new Date('2026-11-18'), cyclesDone: 2,
    terms: { name: 'Get More!', unit: 'month', count: 1, discountPercent: 10, shippingAmount: 100, taxPercent: 5, maxCycles: null },
    items: [{ productId: 'p1', variantId: 'v1', quantity: 2 }, { productId: 'p2', variantId: 'v2', quantity: 1 }],
    ...over,
  });
  const variants = [
    { _id: 'v1', productId: 'p1', price: 1000, options: [{ name: 'Color', value: 'Red' }, { name: 'Size', value: '25' }], sku: 'SKU-1', images: ['https://img/v1.png'], isDelete: false },
    { _id: 'v2', productId: 'p2', price: 500, options: [{ name: 'Title', value: 'Default Title' }], sku: 'SKU-2', images: [], isDelete: false },
  ];
  const products = [
    { _id: 'p1', name: 'Heat Therapy Belt', slug: 'heat-belt', images: ['https://img/p1.png'], isDelete: false, status: 'active' },
    { _id: 'p2', name: 'Compression T-Shirt', slug: 'tshirt', images: ['https://img/p2.png'], isDelete: false, status: 'active' },
  ];
  const updates: any[] = [];
  const stored = contract();
  const contracts: any = {
    find: () => q([stored]), countDocuments: async () => 1,
    findOne: (f: any) => q(f._id === 'c1' && f.storeId === 's1' ? stored : null),
    findOneAndUpdate: (_f: any, u: any) => { updates.push(u); return q({ ...stored, ...(u.$set ?? {}) }); },
  };
  const cycles: any = {
    find: () => q([{ contractId: 'c1', cycleNo: 2, orderId: '000000000000000000000022', amount: 2300, status: 'ordered', createdAt: new Date('2026-10-18') }, { contractId: 'c1', cycleNo: 1, orderId: '000000000000000000000021', amount: 2100, status: 'ordered', createdAt: new Date('2026-09-18') }]),
  };
  const repos: any = {
    productVariantModel: { find: () => q(variants) },
    productModel: { find: () => q(products) },
    storeModel: { findById: () => q({ baseCurrency: 'PKR' }) },
    orderModel: { find: () => q([{ _id: '000000000000000000000021', orderNumber: 'ORD-1', totalAmount: 2100, isPaid: true, paymentStatus: 'paid', orderStatus: 'delivered', createdAt: new Date('2026-09-18') }, { _id: '000000000000000000000022', orderNumber: 'ORD-2', totalAmount: 2300, isPaid: false, paymentStatus: 'pending_verification', orderStatus: 'processing', createdAt: new Date('2026-10-18') }]) },
  };
  const svc = new SellingPlansService({} as any, contracts, cycles, { repositories: repos } as any, { log: async () => undefined } as any, {} as any);
  return { svc, stored, variants, products, updates, repos };
}

const OID = (n: number) => String(n).padStart(24, '0');

describe('subscription lines (what each subscription is for)', () => {
  it('adds product name, photo, variant, discounted price and totals to every contract', async () => {
    const { svc, variants, products, stored } = build();
    // ids must look like Mongo ids for the lookups
    stored.items = [{ productId: OID(1), variantId: OID(11), quantity: 2 }, { productId: OID(2), variantId: OID(12), quantity: 1 }];
    variants[0]._id = OID(11); variants[0].productId = OID(1); variants[1]._id = OID(12); variants[1].productId = OID(2);
    products[0]._id = OID(1); products[1]._id = OID(2);
    const [c]: any[] = await svc.decorate('s1', [stored]);
    expect(c.currency).toBe('PKR');
    expect(c.lines.length).toBe(2);
    expect(c.lines[0]).toMatchObject({ name: 'Heat Therapy Belt', variantLabel: 'Red / 25', image: 'https://img/v1.png', quantity: 2, listPrice: 1000, unitPrice: 900, lineTotal: 1800, available: true, slug: 'heat-belt' });
    expect(c.lines[1].variantLabel).toBeNull(); // "Default Title" is not shown
    expect(c.lines[1].image).toBe('https://img/p2.png'); // falls back to the product photo
    expect(c.lines[1].unitPrice).toBe(450);
    // goods 1800 + 450 = 2250, shipping 100, tax 5% of goods = 112.5
    expect(c.estimatedTotal).toBe(2462.5);
    expect(c.items.length).toBe(2); // the original fields stay for older clients
  });

  it('a deleted product still gets a row, flagged unavailable', async () => {
    const { svc, variants, products, stored } = build();
    stored.items = [{ productId: OID(1), variantId: OID(11), quantity: 1 }, { productId: OID(3), variantId: OID(13), quantity: 1 }];
    variants[0]._id = OID(11); products[0]._id = OID(1);
    const [c]: any[] = await svc.decorate('s1', [stored]);
    expect(c.lines[1]).toMatchObject({ name: 'Product no longer available', available: false, unitPrice: null, lineTotal: null });
    expect(c.lines[0].available).toBe(true);
  });

  it('an empty list stays empty without any lookup', async () => {
    const { svc } = build();
    expect(await svc.decorate('s1', [])).toEqual([]);
  });

  it('the customer\'s own list is decorated too', async () => {
    const { svc, variants, products, stored } = build();
    stored.items = [{ productId: OID(1), variantId: OID(11), quantity: 1 }];
    variants[0]._id = OID(11); products[0]._id = OID(1);
    const list: any[] = await svc.mine('s1', 'u1');
    expect(list[0].lines[0].name).toBe('Heat Therapy Belt');
  });
});

describe('subscription detail', () => {
  it('lists every order it placed, newest first, with the order number and payment state', async () => {
    const { svc, variants, products, stored } = build();
    stored.items = [{ productId: OID(1), variantId: OID(11), quantity: 1 }];
    variants[0]._id = OID(11); products[0]._id = OID(1);
    const ID = 'c1'.padEnd(24, '0');
    (stored as any)._id = ID;
    (svc as any).contracts.findOne = (f: any) => q(String(f._id) === ID && f.storeId === 's1' ? stored : null);
    const d: any = await svc.contractDetail('s1', ID);
    expect(d.history.map((h: any) => h.orderNumber)).toEqual(['ORD-2', 'ORD-1']);
    expect(d.history[0]).toMatchObject({ cycleNo: 2, amount: 2300, isPaid: false, paymentStatus: 'pending_verification' });
    expect(d.history[1]).toMatchObject({ cycleNo: 1, isPaid: true });
    expect(d.lines.length).toBe(1);
  });

  it('refuses another store\'s subscription and a bad id', async () => {
    const { svc } = build();
    await expect(svc.contractDetail('other-store', 'c1'.padEnd(24, '0'))).rejects.toThrow('not found');
    await expect(svc.contractDetail('s1', 'nope')).rejects.toThrow('not found');
  });
});

describe('seller pause with a reason', () => {
  const ID = 'c1'.padEnd(24, '0');
  const setup = () => { const b = build(); (b.stored as any)._id = ID; (b.svc as any).contracts.findOne = (f: any) => q(String(f._id) === ID ? b.stored : null); return b; };

  it('keeps the reason the seller typed, tidied and shortened', async () => {
    const { svc, updates } = setup();
    await svc.sellerAction('s1', { id: 'sel1', role: 'seller' }, ID, 'pause', { reason: '  Out   of\nstock until Dec  ' });
    expect(updates[0].$set.pausedReason).toBe('Paused by the store: Out of stock until Dec');
    await svc.sellerAction('s1', { id: 'sel1', role: 'seller' }, ID, 'pause', { reason: 'x'.repeat(400) });
    expect(updates[1].$set.pausedReason.length).toBe('Paused by the store: '.length + 150);
  });

  it('without a reason it says what it always said', async () => {
    const { svc, updates } = setup();
    await svc.sellerAction('s1', { id: 'sel1', role: 'seller' }, ID, 'pause');
    expect(updates[0].$set.pausedReason).toBe('Paused by the store');
  });

  it('the customer pausing is unchanged', async () => {
    const { svc, updates } = setup();
    await svc.buyerAction('s1', 'u1', ID, 'pause', {});
    expect(updates[0].$set.pausedReason).toBe('Paused by the customer');
  });
});

describe('price lock (the price at subscribe time)', () => {
  it('a line charges the locked price, and says when today\'s price is different', async () => {
    const { svc, variants, products, stored } = build();
    stored.items = [{ productId: OID(1), variantId: OID(11), quantity: 2, lockedPrice: 800 } as any];
    variants[0]._id = OID(11); products[0]._id = OID(1); // today the variant costs 1000
    const [c]: any[] = await svc.decorate('s1', [stored]);
    expect(c.lines[0]).toMatchObject({ priceLocked: true, listPrice: 800, unitPrice: 720, lineTotal: 1440, todayPrice: 1000, priceChanged: true });
    expect(c.estimatedTotal).toBe(1440 + 100 + 72); // goods + plan shipping + 5% tax on goods
  });

  it('no change when the price is the same, and older contracts without a lock follow today\'s price', async () => {
    const { svc, variants, products, stored } = build();
    variants[0]._id = OID(11); variants[0].productId = OID(1); products[0]._id = OID(1);
    stored.items = [{ productId: OID(1), variantId: OID(11), quantity: 1, lockedPrice: 1000 } as any];
    expect(((await svc.decorate('s1', [stored]))[0] as any).lines[0]).toMatchObject({ priceLocked: true, priceChanged: false, unitPrice: 900 });
    stored.items = [{ productId: OID(1), variantId: OID(11), quantity: 1 }];
    expect(((await svc.decorate('s1', [stored]))[0] as any).lines[0]).toMatchObject({ priceLocked: false, priceChanged: false, unitPrice: 900, listPrice: 1000 });
  });

  it('the seller can move a subscription to today\'s prices', async () => {
    const { svc, variants, products, stored, updates } = build();
    const ID = 'c1'.padEnd(24, '0');
    (stored as any)._id = ID;
    stored.items = [{ productId: OID(1), variantId: OID(11), quantity: 2, lockedPrice: 800 } as any];
    variants[0]._id = OID(11); products[0]._id = OID(1);
    (svc as any).contracts.findOne = (f: any) => q(String(f._id) === ID ? stored : null);
    const res: any = await svc.sellerAction('s1', { id: 'sel1', role: 'seller' }, ID, 'reprice');
    expect(updates[0].$set.items).toEqual([{ productId: OID(1), variantId: OID(11), quantity: 2, lockedPrice: 1000 }]);
    expect(res.lines[0].priceChanged).toBe(false);
  });

  it('subscribing remembers the variant price', async () => {
    const G = new (require('mongoose').Types.ObjectId)().toHexString(); const V = new (require('mongoose').Types.ObjectId)().toHexString(); const P = new (require('mongoose').Types.ObjectId)().toHexString();
    let created: any = null;
    const groups: any = { findOne: () => q({ _id: G, name: 'Coffee', options: [{ id: 'o1', unit: 'month', count: 1, discountPercent: 10 }], trialDays: 3, shippingAmount: 0, taxPercent: 0, maxCycles: null, status: 'active', productIds: [P], variantIds: [] }) };
    const contracts: any = { countDocuments: async () => 0, create: async (d: any) => { created = d; return { _id: 'new', ...d }; } };
    const repos: any = {
      userModel: { findOne: () => q({ name: 'Umer', email: 'u@x.co', isGuest: false }) },
      productVariantModel: { findOne: () => q({ _id: V, productId: P, type: 'physical', price: 1250 }) },
      productModel: { findOne: () => q({ _id: P }) },
    };
    const svc = new SellingPlansService(groups, contracts, {} as any, { repositories: repos } as any, { log: async () => undefined } as any, {} as any);
    await svc.subscribe('s1', 'u1', { groupId: G, optionId: 'o1', variantId: V, quantity: 2, address: { recipientName: 'Umer', addressLine1: '12 Road', city: 'Lahore', phoneNumber: '0300111222' } });
    expect(created.items).toEqual([{ productId: P, variantId: V, quantity: 2, lockedPrice: 1250 }]);
  });
});
