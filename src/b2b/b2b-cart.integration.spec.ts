/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests: wholesale prices in the cart view and the wholesale-only store gate.
 * Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-cart.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { CartService } from '../cart/cart.service';
import { CartSchema } from '../cart/schemas/cart.schema';
import { ProductSchema } from '../products/schemas/product.schema';
import { ProductVariantSchema } from '../products/schemas/productVariant.schema';
import { B2BContextService } from './b2b-context.service';
import { B2BApplicationSchema, B2BBuyerSchema, B2BCatalogItemSchema, B2BCatalogSchema, B2BCompanySchema, B2BLocationSchema } from './b2b.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const oid = () => String(new Types.ObjectId());

d('Cart: wholesale prices and wholesale-only stores on a real MongoDB', () => {
  let conn: Connection;
  let m: any;
  let cart: CartService;
  const A = oid();

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `b2bcart_it_${Date.now()}` }).asPromise();
    m = {
      companies: conn.model('B2BCompany', B2BCompanySchema), locations: conn.model('B2BLocation', B2BLocationSchema), buyers: conn.model('B2BBuyer', B2BBuyerSchema),
      applications: conn.model('B2BApplication', B2BApplicationSchema), catalogs: conn.model('B2BCatalog', B2BCatalogSchema), items: conn.model('B2BCatalogItem', B2BCatalogItemSchema),
      carts: conn.model('Cart', CartSchema), products: conn.model('Product', ProductSchema), variants: conn.model('ProductVariant', ProductVariantSchema),
      sellers: conn.model('Seller', new mongoose.Schema({}, { strict: false })), stores: conn.model('Store', new mongoose.Schema({}, { strict: false })),
    };
    await m.stores.collection.insertOne({ _id: new Types.ObjectId(A), name: 'S', isDelete: false, wholesaleOnly: false });
    const ctx = new B2BContextService(m.companies, m.locations, m.buyers, m.applications, m.catalogs, m.items);
    cart = new CartService({ repositories: { cartModel: m.carts, productModel: m.products, productVariantModel: m.variants, sellerModel: m.sellers, storeModel: m.stores } } as any, ctx);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const product = async (sku: string, price = 100) => {
    const pid = new Types.ObjectId();
    await m.products.collection.insertOne({ _id: pid, storeId: A, sellerId: oid(), isDelete: false, status: 'active', type: 'physical', name: 'P ' + sku, slug: 'p-' + pid, images: [] });
    const vid = new Types.ObjectId();
    await m.variants.collection.insertOne({ _id: vid, productId: String(pid), storeId: A, sku, price, stock: 100, status: 'active', isDelete: false, options: [], currency: 'PKR' });
    return { pid: String(pid), vid: String(vid) };
  };
  const company = async (catalog: any, items: (cid: string) => Promise<void>) => {
    const userId = oid();
    const cat: any = await m.catalogs.create({ storeId: A, name: 'C' + oid(), ...catalog });
    const co: any = await m.companies.create({ storeId: A, name: 'Co' + oid(), status: 'approved', catalogId: String(cat._id) });
    const loc: any = await m.locations.create({ storeId: A, companyId: String(co._id), name: 'L' });
    await m.buyers.create({ storeId: A, companyId: String(co._id), locationId: String(loc._id), userId, email: userId + '@x.com' });
    await items(String(cat._id));
    return userId;
  };
  const putInCart = (userId: string, p: { pid: string; vid: string }, quantity: number, price = 100) =>
    m.carts.collection.updateOne({ userId, storeId: A }, { $setOnInsert: { isDelete: false }, $push: { items: { productId: p.pid, productVariantId: p.vid, name: 'P', quantity, price, currency: 'PKR', images: [], options: [] } } }, { upsert: true });

  it('a company buyer sees the wholesale unit price and total; a retail customer sees retail', async () => {
    const p = await product('C-1');
    const buyer = await company({ includeAllProducts: true }, async (cid) => { await m.items.create({ storeId: A, catalogId: cid, productId: p.pid, variantId: p.vid, fixedPrice: 70, priceBreaks: [{ minQty: 10, price: 60 }] }); });
    const retail = oid();
    await putInCart(buyer, p, 12); await putInCart(retail, p, 12);

    const b: any = (await cart.getCart(buyer, A)).data;
    expect(b.items[0]).toMatchObject({ unitPrice: 60, itemTotal: 720, b2bPriced: true, b2bError: null, unavailable: false });
    expect(b.totalPrice).toBe(720);
    const r: any = (await cart.getCart(retail, A)).data;
    expect(r.items[0]).toMatchObject({ unitPrice: 100, itemTotal: 1200, b2bPriced: false });
  });

  it('the price follows the live variant price and the quantity (volume break), not the price snapshot from add-to-cart', async () => {
    const p = await product('C-2', 100);
    const buyer = await company({ includeAllProducts: true, defaultAdjustmentPercent: -10 }, async () => undefined);
    await putInCart(buyer, p, 1, 999);
    expect(((await cart.getCart(buyer, A)).data as any).items[0].unitPrice).toBe(90);
    await m.variants.collection.updateOne({ _id: new Types.ObjectId(p.vid) }, { $set: { price: 200 } });
    expect(((await cart.getCart(buyer, A)).data as any).items[0].unitPrice).toBe(180);
  });

  it('a line the company may not buy keeps retail price, carries the reason and blocks checkout; a quantity-rule line only warns', async () => {
    const hidden = await product('C-3'); const ruled = await product('C-4');
    const buyer = await company({ includeAllProducts: true }, async (cid) => {
      await m.items.create({ storeId: A, catalogId: cid, productId: hidden.pid, variantId: hidden.vid, available: false });
      await m.items.create({ storeId: A, catalogId: cid, productId: ruled.pid, variantId: ruled.vid, minQty: 6 });
    });
    await putInCart(buyer, hidden, 1); await putInCart(buyer, ruled, 2);
    const items = ((await cart.getCart(buyer, A)).data as any).items;
    expect(items[0]).toMatchObject({ unitPrice: 100, unavailable: true, b2bPriced: false });
    expect(items[0].b2bError).toMatch(/not available to your company/);
    expect(items[1]).toMatchObject({ unavailable: false });
    expect(items[1].b2bError).toMatch(/Minimum order quantity is 6/);
  });

  it('wholesale-only store: retail customers cannot add to cart, company buyers can, and switching it off reopens the store', async () => {
    const p = await product('C-5');
    const buyer = await company({ includeAllProducts: true }, async () => undefined);
    await m.stores.collection.updateOne({ _id: new Types.ObjectId(A) }, { $set: { wholesaleOnly: true } });
    try {
      await expect(cart.addToCart(oid(), A, { productId: p.pid, productVariantId: p.vid, quantity: 1 } as any)).rejects.toThrow(/approved wholesale customers only/);
      await expect(cart.addToCart(buyer, A, { productId: p.pid, productVariantId: p.vid, quantity: 1 } as any)).resolves.toBeTruthy();
    } finally {
      await m.stores.collection.updateOne({ _id: new Types.ObjectId(A) }, { $set: { wholesaleOnly: false } });
    }
    await expect(cart.addToCart(oid(), A, { productId: p.pid, productVariantId: p.vid, quantity: 1 } as any)).resolves.toBeTruthy();
  });
});
