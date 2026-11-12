/* eslint-disable prettier/prettier */
/** Feed field mapping + availability (pure) and the public/seller service on a real MongoDB (skipped without MONGO_TEST_URI). */
import mongoose, { Connection, Types } from 'mongoose';
import { availabilityOf, mapVariant, renderGoogleXml, renderMetaCsv, validGtin } from './feed-mapping.util';
import { ProductFeedsService } from './product-feeds.service';
import { ProductFeedConfigSchema } from './feed.schema';

const P = { _id: 'p1', name: 'Blue <Shirt>', slug: 'blue-shirt', description: '<p>Soft cotton</p>', images: ['https://img/1.jpg', 'https://img/2.jpg'], vendor: 'Acme', type: 'Apparel' };
const V = { _id: 'v1', sku: 'SH-1', barcode: '4006381333931', price: 100, compareAtPrice: null, stock: 5, committedStock: 0, options: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Blue' }] };
const ctx = { baseUrl: 'https://shop.solvexo.store', currency: 'PKR', price: (n: number) => n };

describe('feed mapping', () => {
  it('maps a variant with group id, link, options and identifiers', () => {
    const { item } = mapVariant(P, V, ctx);
    expect(item).toMatchObject({ id: 'v1', itemGroupId: 'p1', title: 'Blue <Shirt>', description: 'Soft cotton', price: '100.00 PKR', brand: 'Acme', gtin: '4006381333931', mpn: 'SH-1', size: 'M', color: 'Blue', availability: 'in stock' });
    expect(item!.link).toBe('https://shop.solvexo.store/product/blue-shirt?variant=v1');
  });
  it('a compare-at price becomes the price with the real price as sale_price', () => {
    const { item } = mapVariant(P, { ...V, compareAtPrice: 150 }, ctx);
    expect(item!.price).toBe('150.00 PKR'); expect(item!.salePrice).toBe('100.00 PKR');
  });
  it('reports every missing required field instead of emitting a broken item', () => {
    const r = mapVariant({ ...P, images: [], description: '', vendor: '' }, { ...V, barcode: '123', price: 0 }, ctx);
    expect(r.item).toBeUndefined();
    expect(r.issue!.missing).toEqual(expect.arrayContaining(['description', 'image', 'price', 'brand or gtin']));
  });
  it('only https images are used', () => { expect(mapVariant({ ...P, images: ['http://x/1.jpg'] }, V, ctx).issue!.missing).toContain('image'); });
  it('gtin must be 8/12/13/14 digits', () => { expect(validGtin('4006381333931')).toBeDefined(); expect(validGtin('12345')).toBeUndefined(); expect(validGtin('ABCDEFGH')).toBeUndefined(); });
  it('no brand and no gtin identifier is flagged; brand + sku counts as an identifier', () => {
    expect(mapVariant({ ...P, vendor: '' }, { ...V, barcode: null }, ctx).issue!.missing).toContain('brand or gtin');
    expect(mapVariant(P, { ...V, barcode: null }, ctx).item!.identifierExists).toBe(true);
  });
});

describe('availability', () => {
  it('in stock only for sellable units (committed/damaged/in transit/expired are not)', () => {
    expect(availabilityOf({ stock: 5, committedStock: 5 }).availability).toBe('out of stock');
    expect(availabilityOf({ stock: 5, committedStock: 2, damagedStock: 3 }).availability).toBe('out of stock');
    expect(availabilityOf({ stock: 5, committedStock: 2 }).availability).toBe('in stock');
  });
  it('unlimited stock is in stock; backorder and pre-order only when allowed', () => {
    expect(availabilityOf({ unlimitedStock: true, stock: 0 }).availability).toBe('in stock');
    expect(availabilityOf({ stock: 0, allowBackorder: true }).availability).toBe('backorder');
    expect(availabilityOf({ stock: 0, preorder: { enabled: true, expectedDate: '2026-12-01' } })).toEqual({ availability: 'preorder', date: '2026-12-01T00:00:00.000Z' });
    expect(availabilityOf({ stock: 0 }).availability).toBe('out of stock');
  });
  it('a bundle is limited by its weakest component', () => {
    expect(availabilityOf({ stock: 10 }, 0).availability).toBe('out of stock');
    expect(availabilityOf({ stock: 10 }, 3).availability).toBe('in stock');
    expect(availabilityOf({ unlimitedStock: true }, 0).availability).toBe('out of stock');
  });
});

describe('rendering', () => {
  it('escapes XML and strips control characters', () => {
    const { item } = mapVariant({ ...P, name: 'A & B <x> \u0001' }, V, ctx);
    const xml = renderGoogleXml({ name: 'Shop & Co', url: 'https://s' }, [item!]);
    expect(xml).toContain('Shop &amp; Co'); expect(xml).toContain('<g:title>A &amp; B &lt;x&gt;</g:title>'); expect(xml).not.toContain('\u0001');
  });
  it('csv quotes cells and neutralizes formulas', () => {
    const { item } = mapVariant({ ...P, name: '=HYPERLINK("x")', description: 'a, b' }, V, ctx);
    const csv = renderMetaCsv([item!]);
    expect(csv.split('\r\n')[0]).toContain('item_group_id'); expect(csv).toContain(`"'=HYPERLINK(""x"")"`); expect(csv).toContain('"a, b"');
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('ProductFeedsService on a real MongoDB', () => {
  let conn: Connection; let svc: ProductFeedsService; const store = new Types.ObjectId().toHexString(); const other = new Types.ObjectId().toHexString();
  const prods: any[] = []; const vars: any[] = [];
  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `feeds_it_${Date.now()}` }).asPromise();
    const cfg = conn.model('ProductFeedConfig', ProductFeedConfigSchema);
    const mk = (n: string) => conn.model(n, new mongoose.Schema({}, { strict: false }));
    const storeModel = mk('Store'); const productModel = mk('Product'); const productVariantModel = mk('Variant');
    await storeModel.create({ _id: store, name: 'Shop', slug: 'shop', baseCurrency: 'PKR', isDelete: false });
    const p1: any = await productModel.create({ storeId: store, isDelete: false, status: 'active', productType: 'physical', name: 'Shirt', slug: 'shirt', description: 'd', images: ['https://i/1.jpg'], vendor: 'Acme' });
    await productModel.create({ storeId: store, isDelete: false, status: 'inactive', productType: 'physical', name: 'Hidden', slug: 'hidden', description: 'd', images: ['https://i/1.jpg'], vendor: 'A' });
    await productModel.create({ storeId: store, isDelete: false, status: 'active', productType: 'digital', name: 'Ebook', slug: 'ebook', description: 'd', images: ['https://i/1.jpg'], vendor: 'A' });
    await productModel.create({ storeId: other, isDelete: false, status: 'active', productType: 'physical', name: 'Other store', slug: 'o', description: 'd', images: ['https://i/1.jpg'], vendor: 'A' });
    prods.push(p1);
    vars.push(await productVariantModel.create({ productId: String(p1._id), isDelete: false, status: 'active', sku: 'S1', price: 10, stock: 3 }));
    vars.push(await productVariantModel.create({ productId: String(p1._id), isDelete: false, status: 'active', sku: 'S2', price: 0, stock: 3 }));
    svc = new ProductFeedsService(cfg as any, { repositories: { storeModel, productModel, productVariantModel } } as any, undefined);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  it('a disabled feed or a wrong token looks exactly like no feed', async () => {
    const s = await svc.getSettings(store);
    const token = s.urls.googleXml.split('/').slice(-2)[0];
    await expect(svc.publicFeed(store, token, 'google')).rejects.toThrow(/not found/i);
    await svc.update(store, { enabled: true });
    await expect(svc.publicFeed(store, 'wrong', 'google')).rejects.toThrow(/not found/i);
    await expect(svc.publicFeed(other, token, 'google')).rejects.toThrow(/not found/i);
    expect((await svc.publicFeed(store, token, 'google')).body).toContain('<g:id>');
  });
  it('only this store active physical products are listed; a variant with a problem is reported, not emitted', async () => {
    const f = await svc.build(store);
    expect(f.items).toHaveLength(1); expect(f.items[0].mpn).toBe('S1');
    expect(f.issues).toHaveLength(1); expect(f.issues[0].missing).toContain('price');
    const h = await svc.health(store);
    expect(h.ready).toBe(1); expect(h.withProblems).toBe(1);
  });
  it('rotating the token switches the old URLs off', async () => {
    const before = (await svc.getSettings(store)).urls.metaCsv.split('/').slice(-2)[0];
    await svc.rotate(store);
    await expect(svc.publicFeed(store, before, 'meta')).rejects.toThrow(/not found/i);
  });
  it('a currency that is not offered is refused', async () => {
    const t = (await svc.getSettings(store)).urls.metaCsv.split('/').slice(-2)[0];
    await expect(svc.publicFeed(store, t, 'meta', 'EUR')).rejects.toThrow(/not offered/);
  });
});
