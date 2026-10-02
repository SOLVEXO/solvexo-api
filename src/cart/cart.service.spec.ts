/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { CartService } from './cart.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { DatabaseService } from '../database/databaseservice';

const USER_ID = 'buyer-1';
const STORE_ID = 'store-1';
const PRODUCT_ID = 'prod-1';
const VARIANT_ID = 'var-1';

const PRODUCT = { _id: PRODUCT_ID, storeId: STORE_ID, status: 'active', isDelete: false, name: 'Mug', images: [] };
const VARIANT = { _id: VARIANT_ID, productId: PRODUCT_ID, status: 'active', isDelete: false, price: 10, currency: 'USD', images: [], options: [] };

/** Mongoose-like `.findOne(filter).lean()` that honours `_id` + `isDelete`. */
function leanModel(rows: any[]) {
  return {
    findOne: jest.fn().mockImplementation((filter: any) => {
      const hit = rows.find((r) => String(r._id) === String(filter._id) && r.isDelete === filter.isDelete) ?? null;
      const chain: any = { lean: () => Promise.resolve(hit), select: () => chain };
      return chain;
    }),
  };
}

describe('CartService.addToCart — store/product/quantity validation', () => {
  let service: CartService;
  let cartModel: any;
  let productModel: any;
  let variantModel: any;
  let wishListModel: any;

  const dto = (over: Partial<AddToCartDto> = {}): AddToCartDto =>
    ({ storeId: STORE_ID, productId: PRODUCT_ID, productVariantId: VARIANT_ID, quantity: 1, ...over }) as AddToCartDto;

  beforeEach(() => {
    cartModel = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(async (d: any) => d) };
    productModel = leanModel([PRODUCT, { ...PRODUCT, _id: 'prod-other', storeId: 'store-2' }, { ...PRODUCT, _id: 'prod-draft', status: 'draft' }, { ...PRODUCT, _id: 'prod-deleted', isDelete: true }]);
    variantModel = leanModel([VARIANT, { ...VARIANT, _id: 'var-foreign', productId: 'prod-other' }, { ...VARIANT, _id: 'var-off', status: 'inactive' }]);
    wishListModel = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ _id: 'w1' }) };
    const db = {
      repositories: { cartModel, productModel, productVariantModel: variantModel, wishListModel },
    } as unknown as DatabaseService;
    service = new CartService(db);
  });

  it('adds a live product of this store with a valid quantity', async () => {
    const res = await service.addToCart(USER_ID, STORE_ID, dto({ quantity: 3 }));
    expect(cartModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, storeId: STORE_ID, items: [expect.objectContaining({ productId: PRODUCT_ID, quantity: 3, price: 10 })] }),
    );
    expect(res.message).toMatch(/added/i);
  });

  it('defaults a missing quantity to 1', async () => {
    await service.addToCart(USER_ID, STORE_ID, dto({ quantity: undefined }));
    expect(cartModel.create).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({ quantity: 1 })] }));
  });

  it.each([0, -1, -5, 1.5, NaN])('REGRESSION: rejects invalid quantity %p (would make a negative/free line total)', async (q) => {
    await expect(service.addToCart(USER_ID, STORE_ID, dto({ quantity: q }))).rejects.toThrow(/positive whole number/);
    expect(cartModel.create).not.toHaveBeenCalled();
  });

  it('REGRESSION: rejects another store\'s product', async () => {
    await expect(service.addToCart(USER_ID, STORE_ID, dto({ productId: 'prod-other', productVariantId: 'var-foreign' }))).rejects.toThrow('Product not found');
    expect(cartModel.create).not.toHaveBeenCalled();
  });

  it.each(['prod-draft', 'prod-deleted', 'missing'])('rejects a non-live product (%s)', async (productId) => {
    await expect(service.addToCart(USER_ID, STORE_ID, dto({ productId }))).rejects.toThrow('Product not found');
  });

  it('REGRESSION: rejects a variant that belongs to a different product', async () => {
    await expect(service.addToCart(USER_ID, STORE_ID, dto({ productVariantId: 'var-foreign' }))).rejects.toThrow('Product variant not found');
    expect(cartModel.create).not.toHaveBeenCalled();
  });

  it('rejects an inactive variant', async () => {
    await expect(service.addToCart(USER_ID, STORE_ID, dto({ productVariantId: 'var-off' }))).rejects.toThrow('Product variant not found');
  });

  describe('addToWishlist', () => {
    it('REGRESSION: rejects another store\'s product', async () => {
      await expect(service.addToWishlist(USER_ID, STORE_ID, { productId: 'prod-other', productVariantId: 'var-foreign' })).rejects.toBeInstanceOf(BadRequestException);
      expect(wishListModel.create).not.toHaveBeenCalled();
    });

    it('rejects a variant of a different product', async () => {
      await expect(service.addToWishlist(USER_ID, STORE_ID, { productId: PRODUCT_ID, productVariantId: 'var-foreign' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

describe('AddToCartDto validation (what the global ValidationPipe enforces)', () => {
  const pipe = new ValidationPipe({ transform: false });
  const meta = { type: 'body' as const, metatype: AddToCartDto };
  const base = { storeId: STORE_ID, productId: PRODUCT_ID, productVariantId: VARIANT_ID };

  it('accepts a valid body and returns the SAME plain object (no shape change)', async () => {
    const body = { ...base, quantity: 2 };
    await expect(pipe.transform(body, meta)).resolves.toBe(body);
  });

  it.each([0, -3, 1.5, 1000, '5'])('rejects quantity %p', async (quantity) => {
    await expect(pipe.transform({ ...base, quantity }, meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('treats null/missing quantity as "absent" (@IsOptional) — the service then defaults it to 1', async () => {
    await expect(pipe.transform({ ...base, quantity: null }, meta)).resolves.toBeDefined();
  });

  it('rejects a missing storeId', async () => {
    await expect(pipe.transform({ productId: PRODUCT_ID, quantity: 1 }, meta)).rejects.toBeInstanceOf(BadRequestException);
  });
});
