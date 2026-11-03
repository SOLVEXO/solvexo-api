/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import { CartService } from '../cart/cart.service';
import { AVAILABLE_STOCK_EXPR, isPurchasableOnline } from '../common/stock-availability.util';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/**
 * 5D.1: an offline POS oversell leaves stock <= 0. The storefront/buyer side must refuse it everywhere a purchase can start:
 * add-to-cart, the checkout pre-flight rule, and the atomic reservation at order placement.
 */
jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const setVariant = (variantId: string, set: any) => h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(variantId) }, { $set: set });

describe.each([0, -3])('stock = %i', (stock) => {
  it('add-to-cart refuses a physical variant (any quantity) — but allows unlimited and backorder variants', async () => {
    const s = await seedStore(h, { stock: 5 });
    await setVariant(s.variantId, { stock, status: 'active', currency: 'USD' });
    const cart = new CartService({ repositories: h.repos } as any);
    const dto: any = { storeId: s.storeId, productId: s.productId, productVariantId: s.variantId, quantity: 1 };
    await expect(cart.addToCart('buyer-1', s.storeId, dto)).rejects.toThrow(/out of stock/i);
    expect(await h.repos.cartModel.countDocuments({})).toBe(0);

    await setVariant(s.variantId, { allowBackorder: true });
    await expect(cart.addToCart('buyer-1', s.storeId, dto)).resolves.toBeTruthy();
  });

  it('the checkout pre-flight rule (isPurchasableOnline) refuses it', () => {
    expect(isPurchasableOnline({ stock, committedStock: 0 } as any, 1)).toBe(false);
    expect(isPurchasableOnline({ stock, unlimitedStock: true } as any, 1)).toBe(true);
    expect(isPurchasableOnline({ stock, allowBackorder: true } as any, 1)).toBe(true);
    expect(isPurchasableOnline({ stock: 2, committedStock: 2 } as any, 1)).toBe(false); // everything reserved
    expect(isPurchasableOnline({ stock: 5 } as any, 5)).toBe(true);
    expect(isPurchasableOnline({ stock: 5 } as any, 6)).toBe(false);
  });

  it('the atomic reservation used at order placement does not reserve it (real Mongo, same filter as PaymentService)', async () => {
    const s = await seedStore(h, { stock: 5 });
    await setVariant(s.variantId, { stock });
    const res = await h.repos.productVariantModel.updateOne(
      { _id: s.variantId, isDelete: false, $expr: { $gte: [AVAILABLE_STOCK_EXPR, 1] } },
      { $inc: { committedStock: 1 } },
    );
    expect(res.modifiedCount).toBe(0);
    const v: any = await h.repos.productVariantModel.collection.findOne({ _id: new Types.ObjectId(s.variantId) });
    expect(v.committedStock).toBe(0);
    expect(v.stock).toBe(stock);
  });
});
