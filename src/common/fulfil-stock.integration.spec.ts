/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB test of the "paid + completed" stock path (mark-paid / record-payment / bank-transfer approval) with the REAL
 * ProductVariant + VariantLocationStock schemas: the aggregation-pipeline update must work under Mongoose 9 (updatePipeline),
 * clamp at 0, skip unlimited stock and keep location rows in step. Skipped unless STOCK_IT_MONGO is set, e.g.
 *   STOCK_IT_MONGO="mongodb://127.0.0.1:27095"
 * Creates a throw-away database and drops it. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Model } from 'mongoose';
import { fulfilStockForSellerOrders } from './fulfil-stock.util';
import { ProductVariantSchema } from '../products/schemas/productVariant.schema';
import { VariantLocationStockSchema } from '../inventory/schemas/variant-location-stock.schema';

const URI = process.env.STOCK_IT_MONGO;
const d = URI ? describe : describe.skip;

d('fulfilStockForSellerOrders on a real MongoDB', () => {
  let conn: Connection;
  let variants: Model<any>;
  let locs: Model<any>;
  let n = 0;

  const variant = async (extra: any = {}) => {
    const id = new mongoose.Types.ObjectId();
    await variants.collection.insertOne({ _id: id, productId: 'P' + ++n, storeId: 'S1', sku: 'SKU' + n, stock: 10, committedStock: 3, isDelete: false, ...extra });
    return String(id);
  };
  const get = async (id: string) => (await variants.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })) as any;
  const order = (vid: string, qty: number, status = 'pending', extra: any = {}) => ({ status, ...extra, items: [{ type: 'physical', variantId: vid, quantity: qty }] });

  beforeAll(async () => {
    conn = await mongoose.createConnection(`${URI}/stock_it`).asPromise();
    variants = conn.model('ProductVariant', ProductVariantSchema, 'productvariants');
    locs = conn.model('VariantLocationStock', VariantLocationStockSchema, 'variantlocationstocks');
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('drops on-hand stock and the reservation together (pipeline update works under Mongoose 9)', async () => {
    const v = await variant();
    await fulfilStockForSellerOrders(variants, [order(v, 2)]);
    const r = await get(v);
    expect([r.stock, r.committedStock]).toEqual([8, 1]);
  });

  it('clamps at zero instead of going negative', async () => {
    const v = await variant({ stock: 1, committedStock: 0 });
    await fulfilStockForSellerOrders(variants, [order(v, 5)]);
    const r = await get(v);
    expect([r.stock, r.committedStock]).toEqual([0, 0]);
  });

  it('leaves unlimited-stock variants untouched', async () => {
    const v = await variant({ unlimitedStock: true });
    await fulfilStockForSellerOrders(variants, [order(v, 2)]);
    const r = await get(v);
    expect([r.stock, r.committedStock]).toEqual([10, 3]);
  });

  it('skips cancelled, refunded, already-fulfilled and already-deducted sub-orders', async () => {
    const v = await variant();
    await fulfilStockForSellerOrders(variants, [order(v, 2, 'cancelled'), order(v, 2, 'refunded'), order(v, 2, 'shipped'), order(v, 2, 'delivered'), order(v, 2, 'completed'), order(v, 2, 'pending', { stockAlreadyDeducted: true })]);
    const r = await get(v);
    expect([r.stock, r.committedStock]).toEqual([10, 3]);
  });

  it('ignores digital items and bad quantities', async () => {
    const v = await variant();
    await fulfilStockForSellerOrders(variants, [{ status: 'pending', items: [{ type: 'digital', variantId: v, quantity: 2 }, { type: 'physical', variantId: v, quantity: 0 }, { type: 'physical', variantId: v, quantity: -3 }] }]);
    const r = await get(v);
    expect([r.stock, r.committedStock]).toEqual([10, 3]);
  });

  it('keeps the per-location rows in step with the variant total', async () => {
    const v = await variant();
    await locs.collection.insertMany([
      { variantId: v, locationId: 'L1', stock: 6, storeId: 'S1' },
      { variantId: v, locationId: 'L2', stock: 4, storeId: 'S1' },
    ]);
    await fulfilStockForSellerOrders(variants, [order(v, 3)], { variantLocationStockModel: locs });
    const rows = (await locs.collection.find({ variantId: v }).toArray()) as any[];
    expect(rows.reduce((s, x) => s + x.stock, 0)).toBe(7);
    expect(rows.find((x) => x.locationId === 'L1').stock).toBe(3); // the row holding the most stock is drained first
    expect((await get(v)).stock).toBe(7);
  });

  it('two orders for the same variant apply both decrements (no lost update)', async () => {
    const v = await variant({ stock: 10, committedStock: 6 });
    await Promise.all([
      fulfilStockForSellerOrders(variants, [order(v, 2)]),
      fulfilStockForSellerOrders(variants, [order(v, 3)]),
    ]);
    const r = await get(v);
    expect([r.stock, r.committedStock]).toEqual([5, 1]);
  });
});
