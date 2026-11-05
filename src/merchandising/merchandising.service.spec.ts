/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MerchandisingService, weightKgFromText } from './merchandising.service';

const q = (v: any) => { const o: any = { select: () => o, lean: () => o, sort: () => o, limit: () => o, then: (r: any, j: any) => Promise.resolve(v).then(r, j) }; return o; };
const id = (n: number) => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;

function getPath(d: any, path: string): any[] { return path.split('.').reduce<any[]>((acc, k) => acc.flatMap((x) => (Array.isArray(x?.[k]) ? x[k] : [x?.[k]])), [d]); }
function matches(d: any, f: any): boolean {
  return Object.entries(f).every(([k, v]: [string, any]) => {
    const vals = getPath(d, k);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('$in' in v) return vals.some((x) => v.$in.map(String).includes(String(x)));
      if ('$nin' in v) return !vals.some((x) => v.$nin.map(String).includes(String(x)));
      if ('$ne' in v) return !vals.some((x) => String(x) === String(v.$ne)) && (v.$ne !== null || vals.some((x) => x != null));
      if ('$lt' in v) return vals.some((x) => x != null && new Date(x) < v.$lt);
    }
    return vals.some((x) => String(x ?? null) === String(v ?? null));
  });
}
const model = (docs: any[]) => ({
  docs,
  find: (f: any) => q(docs.filter((d) => matches(d, f))),
  findOne: (f: any) => q(docs.find((d) => matches(d, f)) ?? null),
  exists: async (f: any) => docs.some((d) => matches(d, f)),
  updateOne: async (f: any, u: any) => { const d = docs.find((x) => matches(x, f)); if (d) for (const [k, val] of Object.entries(u.$set ?? {})) { const parts = k.split('.'); let o = d; for (const part of parts.slice(0, -1)) o = o[part]; o[parts[parts.length - 1]] = val; } return { modifiedCount: d ? 1 : 0 }; },
});

function setup() {
  const products: any[] = [
    { _id: id(1), storeId: 's1', name: 'Kit', type: 'physical', status: 'active', isDelete: false, isBundle: false, bundleComponents: [], purchaseCount: 0, subCategoryId: 'c1' },
    { _id: id(2), storeId: 's1', name: 'Pen', type: 'physical', status: 'active', isDelete: false, isBundle: false, purchaseCount: 5, subCategoryId: 'c1' },
    { _id: id(3), storeId: 's1', name: 'Ink', type: 'physical', status: 'active', isDelete: false, isBundle: false, purchaseCount: 9, subCategoryId: 'c1' },
    { _id: id(4), storeId: 's2', name: 'Other store', type: 'physical', status: 'active', isDelete: false, isBundle: false },
    { _id: id(5), storeId: 's1', name: 'Draft', type: 'physical', status: 'draft', isDelete: false, isBundle: false },
    { _id: id(6), storeId: 's1', name: 'Sold out', type: 'physical', status: 'active', isDelete: false, isBundle: false, purchaseCount: 50, subCategoryId: 'c1' },
    { _id: id(7), storeId: 's1', name: 'Outer', type: 'physical', status: 'active', isDelete: false, isBundle: true, bundleComponents: [{ productId: id(2), variantId: id(22), quantity: 1 }] },
  ];
  const variants: any[] = [
    { _id: id(11), productId: id(1), isDelete: false, isDefault: true, price: 100, unlimitedStock: false, stock: 0 },
    { _id: id(22), productId: id(2), isDelete: false, isDefault: true, price: 10, stock: 9, committedStock: 0 },
    { _id: id(33), productId: id(3), isDelete: false, isDefault: true, price: 5, stock: 6, committedStock: 0 },
    { _id: id(44), productId: id(4), isDelete: false, isDefault: true, price: 1, stock: 9 },
    { _id: id(66), productId: id(6), isDelete: false, isDefault: true, price: 1, stock: 0, committedStock: 0 },
    { _id: id(77), productId: id(7), isDelete: false, isDefault: true, price: 1, unlimitedStock: true },
  ];
  const stores: any = { s1: { _id: 's1', sellerId: 'sel1', status: 'active', isDelete: false }, s2: { _id: 's2', sellerId: 'sel2', status: 'active', isDelete: false } };
  const storeModel: any = { findById: async (i: string) => stores[i] ?? null, findOne: (f: any) => q(stores[f._id] ?? null), updateOne: async (f: any, u: any) => { Object.assign(stores[f._id], u.$set); } };
  const productModel = model(products), variantModel = model(variants);
  const db: any = { repositories: { storeModel, productModel, productVariantModel: variantModel } };
  const activity: any = { log: jest.fn().mockResolvedValue(undefined) };
  return { svc: new MerchandisingService(db, activity), products, variants, stores };
}
const comp = (p: number, v: number, quantity = 1) => ({ productId: id(p), variantId: id(v), quantity });

describe('bundles', () => {
  it('creates a bundle, makes its own variant stockless and derives availability + compare-at', async () => {
    const { svc, products, variants } = setup();
    const res = await svc.setBundle('s1', 'sel1', id(1), [comp(2, 22, 3), comp(3, 33, 2)]);
    expect(products[0]).toMatchObject({ isBundle: true });
    expect(variants[0].unlimitedStock).toBe(true);
    expect(res.data).toMatchObject({ isBundle: true, available: 3, compareAtPrice: 40 }); // min(9/3, 6/2)=3 ; 3*10 + 2*5
    expect(res.data.components).toHaveLength(2);
  });
  it('rejects cross-store, nested, inactive, self and duplicate components, and non-owners', async () => {
    const { svc } = setup();
    await expect(svc.setBundle('s1', 'sel1', id(1), [comp(4, 44)])).rejects.toBeInstanceOf(BadRequestException); // other store's product
    await expect(svc.setBundle('s1', 'sel1', id(1), [comp(5, 99)])).rejects.toBeInstanceOf(BadRequestException); // draft / missing
    await expect(svc.setBundle('s1', 'sel1', id(1), [comp(7, 77)])).rejects.toThrow(/nested|itself a bundle/i);
    await expect(svc.setBundle('s1', 'sel1', id(1), [comp(1, 11)])).rejects.toThrow(/itself/i);
    await expect(svc.setBundle('s1', 'sel1', id(1), [comp(2, 22), comp(3, 22)])).rejects.toThrow(/once/i);
    await expect(svc.setBundle('s1', 'sel2', id(1), [comp(2, 22)])).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setBundle('s2', 'sel2', id(1), [comp(4, 44)])).rejects.toBeInstanceOf(NotFoundException); // s1's product via s2
  });
  it('refuses to turn a component of another bundle into a bundle (no nesting) and can remove a bundle', async () => {
    const { svc, variants } = setup();
    await expect(svc.setBundle('s1', 'sel1', id(2), [comp(3, 33)])).rejects.toThrow(/nested/i); // Pen is a component of Outer
    await svc.setBundle('s1', 'sel1', id(1), [comp(2, 22)]);
    await svc.removeBundle('s1', 'sel1', id(1));
    expect(variants[0].unlimitedStock).toBe(false);
  });
});

describe('pre-order settings', () => {
  it('sets/validates pre-order on a variant, refuses bundles and other stores', async () => {
    const { svc, variants } = setup();
    const out = await svc.setPreorder('s1', 'sel1', id(22), { enabled: true, limit: 3, message: 'Soon' });
    expect(out.data.preorder).toMatchObject({ enabled: true, limit: 3 });
    expect(variants[1].preorder.enabled).toBe(true);
    await expect(svc.setPreorder('s1', 'sel1', id(22), { enabled: true, limit: -1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setPreorder('s1', 'sel1', id(77), { enabled: true })).rejects.toThrow(/Bundles/);
    await expect(svc.setPreorder('s2', 'sel2', id(22), { enabled: true })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('expiry job switches off only passed-date, back-in-stock pre-orders, and is idempotent', async () => {
    const { svc, variants } = setup();
    variants[1].preorder = { enabled: true, expectedDate: new Date('2026-01-01'), limit: null, sold: 2 }; // in stock, date passed => off
    variants[4].preorder = { enabled: true, expectedDate: new Date('2026-01-01'), limit: null, sold: 0 }; // still 0 stock => stays on
    variants[2].preorder = { enabled: true, expectedDate: new Date('2027-01-01'), limit: null, sold: 0 }; // date in future => untouched
    expect(await svc.expirePreorders(new Date('2026-11-05'))).toMatchObject({ expired: 1 });
    expect(variants[1].preorder.enabled).toBe(false);
    expect(variants[4].preorder.enabled).toBe(true);
    expect(variants[2].preorder.enabled).toBe(true);
    expect((await svc.expirePreorders(new Date('2026-11-05'))).expired).toBe(0); // second run: nothing left to do
  });
});

describe('recommendations', () => {
  it('manual picks come first, then same-category fallback by best seller; unavailable/draft/other-store never appear', async () => {
    const { svc } = setup();
    await svc.setRecommendations('s1', 'sel1', id(1), { relatedProductIds: [id(2)], complementaryProductIds: [id(6)] }); // 6 is sold out
    const out = await svc.resolveRecommendations('s1', id(1), { limit: 5 });
    expect(out.map((x) => x.id)[0]).toBe(id(2));
    expect(out[0].source).toBe('manual');
    const ids = out.map((x) => x.id);
    expect(ids).not.toContain(id(6)); // sold out
    expect(ids).not.toContain(id(5)); // draft
    expect(ids).not.toContain(id(4)); // other store
    expect(ids).not.toContain(id(1)); // itself
    expect(ids).toContain(id(3));     // automatic fallback
    expect(out.find((x) => x.id === id(3))?.source).toBe('auto');
  });
  it('rejects other-store, draft, self, oversized and malformed lists', async () => {
    const { svc } = setup();
    await expect(svc.setRecommendations('s1', 'sel1', id(1), { relatedProductIds: [id(4)] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setRecommendations('s1', 'sel1', id(1), { relatedProductIds: [id(5)] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setRecommendations('s1', 'sel1', id(1), { relatedProductIds: [id(1)] })).rejects.toThrow(/itself/);
    await expect(svc.setRecommendations('s1', 'sel1', id(1), { relatedProductIds: 'x' as any })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setRecommendations('s1', 'sel1', id(1), { relatedProductIds: Array.from({ length: 13 }, (_, i) => id(10 + i)) })).rejects.toThrow(/At most/);
    await expect(svc.setRecommendations('s2', 'sel2', id(1), {})).rejects.toBeInstanceOf(NotFoundException);
  });
  it('a product with no manual lists (old data) still gets fallback suggestions', async () => {
    const { svc } = setup();
    expect((await svc.resolveRecommendations('s1', id(2))).length).toBeGreaterThan(0);
  });
  it('cart upsell: off => renders nothing; on => excludes cart items, respects maxItems and mode', async () => {
    const { svc } = setup();
    expect(await svc.cartSuggestions('s1', [id(2)])).toMatchObject({ enabled: false, items: [] });
    await svc.setCartUpsell('s1', 'sel1', { enabled: true, maxItems: 1, mode: 'best_sellers', title: 'Add these' });
    const r = await svc.cartSuggestions('s1', [id(3)]);
    expect(r.items).toHaveLength(1);
    expect(r.items.map((x: any) => x.id)).not.toContain(id(3));
    expect(r.title).toBe('Add these');
    await expect(svc.setCartUpsell('s1', 'sel1', { maxItems: 99 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setCartUpsell('s1', 'sel1', { mode: 'sql' })).rejects.toBeInstanceOf(BadRequestException);
    expect(await svc.cartSuggestions('s2', [id(2)])).toMatchObject({ enabled: false }); // other store has it off
  });
});

describe('bundle weight', () => {
  it('parses free-text weights to kg', () => {
    expect(weightKgFromText('0.5')).toBe(0.5);
    expect(weightKgFromText('500 g')).toBe(0.5);
    expect(weightKgFromText('2kg')).toBe(2);
    expect(weightKgFromText('1 lb')).toBeCloseTo(0.4536, 3);
    expect(weightKgFromText('heavy')).toBe(0);
    expect(weightKgFromText(null)).toBe(0);
  });
  it('a new bundle gets the sum of its components weights when it has none', async () => {
    const { svc, variants } = setup();
    variants[1].shippingWeight = '1 kg'; variants[2].shippingWeight = '500 g';
    await svc.setBundle('s1', 'sel1', id(1), [comp(2, 22, 2), comp(3, 33, 1)]);
    expect(variants[0].shippingWeight).toBe('2.5 kg');
  });
});
