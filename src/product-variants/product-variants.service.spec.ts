/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductVariantsService } from './product-variants.service';

const chain = (value: any) => {
  const p: any = Promise.resolve(value);
  p.session = () => p;
  p.lean = () => p;
  p.select = () => p;
  return p;
};

function build(opts: { variant?: any; others?: any[]; skuClash?: boolean; locRows?: any[]; updateResult?: any } = {}) {
  const variant = opts.variant ?? { _id: 'v1', productId: 'p1', sku: 'A-1', stock: 10, committedStock: 2, inTransitStock: 0, isDefault: true, price: 5, unlimitedStock: false };
  const productVariantModel: any = {
    findOne: jest.fn(() => chain(variant)),
    find: jest.fn(() => chain(opts.others ?? [])),
    exists: jest.fn(async () => (opts.skuClash ? { _id: 'other' } : null)),
    findOneAndUpdate: jest.fn(async () => (opts.updateResult === undefined ? { ...variant } : opts.updateResult)),
    updateOne: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({})),
    findById: jest.fn(async () => variant),
    create: jest.fn(async (docs: any[]) => [{ ...docs[0], _id: 'new1' }]),
  };
  const variantLocationStockModel: any = { find: jest.fn(() => chain(opts.locRows ?? [])), updateOne: jest.fn(async () => ({})) };
  const cartModel: any = { updateMany: jest.fn(async () => ({})) };
  const wishListModel: any = { deleteMany: jest.fn(async () => ({})) };
  const productModel: any = {
    findOne: jest.fn(async () => ({ _id: 'p1', storeId: 's1', sellerId: 'sel', type: 'physical', name: 'P' })),
  };
  const storeModel: any = { findOne: jest.fn(async () => ({ baseCurrency: 'USD' })) };
  const db: any = { repositories: { productVariantModel, variantLocationStockModel, cartModel, wishListModel, productModel, storeModel } };
  const activity: any = { log: jest.fn(async () => undefined) };
  const connection: any = { transaction: jest.fn(async (fn: any) => fn({ id: 'session' })) };
  const svc = new ProductVariantsService(db, activity, connection);
  return { svc, productVariantModel, variantLocationStockModel, cartModel, wishListModel, activity, connection };
}

describe('ProductVariantsService hardening', () => {
  it('rejects a SKU already used in the store (409)', async () => {
    const { svc } = build({ skuClash: true });
    await expect(svc.updateVariant('sel', 'p1', 'v1', { sku: 'TAKEN' } as any)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects negative / fractional stock and negative price', async () => {
    const { svc } = build();
    await expect(svc.updateVariant('sel', 'p1', 'v1', { stock: -1 } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.updateVariant('sel', 'p1', 'v1', { stock: 1.5 } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.updateVariant('sel', 'p1', 'v1', { price: -5 } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses stock below what pending orders reserved', async () => {
    const { svc } = build();
    await expect(svc.updateVariant('sel', 'p1', 'v1', { stock: 1 } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stock write is compare-and-set on the stock that was read; stale write => 409', async () => {
    const { svc, productVariantModel } = build({ updateResult: null });
    await expect(svc.updateVariant('sel', 'p1', 'v1', { stock: 20 } as any)).rejects.toBeInstanceOf(ConflictException);
    expect(productVariantModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: 'v1', stock: 10 });
  });

  it('keeps the single location row in sync with the stock edit', async () => {
    const { svc, variantLocationStockModel, activity } = build({ locRows: [{ _id: 'l1' }] });
    await svc.updateVariant('sel', 'p1', 'v1', { stock: 25 } as any);
    expect(variantLocationStockModel.updateOne).toHaveBeenCalledWith({ _id: 'l1' }, { $set: { stock: 25 } }, expect.anything());
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'inventory_adjusted' }));
  });

  it('refuses a single-number stock edit when stock is spread over several locations', async () => {
    const { svc } = build({ locRows: [{ _id: 'l1' }, { _id: 'l2' }] });
    await expect(svc.updateVariant('sel', 'p1', 'v1', { stock: 25 } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot delete the last variant', async () => {
    const { svc } = build({ others: [] });
    await expect(svc.deleteVariant('sel', 'p1', 'v1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deleting a variant promotes the cheapest remaining one and cleans carts + wishlists', async () => {
    const { svc, productVariantModel, cartModel, wishListModel } = build({ others: [{ _id: 'v2', price: 9 }, { _id: 'v3', price: 4 }] });
    await svc.deleteVariant('sel', 'p1', 'v1');
    expect(productVariantModel.updateOne).toHaveBeenCalledWith({ _id: 'v3' }, { $set: { isDefault: true } }, expect.anything());
    expect(cartModel.updateMany).toHaveBeenCalled();
    expect(wishListModel.deleteMany).toHaveBeenCalledWith({ storeId: 's1', productVariantId: 'v1' }, expect.anything());
  });

  it('addVariant stamps storeId + currency and auto-generates a SKU', async () => {
    const { svc, productVariantModel } = build({ others: [] });
    await svc.addVariant('sel', 'p1', { price: 10, options: [] } as any);
    const doc = productVariantModel.create.mock.calls[0][0][0];
    expect(doc).toMatchObject({ storeId: 's1', currency: 'USD', isDefault: true });
    expect(doc.sku).toMatch(/^SKU-/);
  });

  it('addVariant maps a Mongo duplicate-key SKU race to 409', async () => {
    const { svc, connection } = build({ others: [] });
    connection.transaction.mockRejectedValueOnce({ code: 11000, keyPattern: { storeId: 1, sku: 1 } });
    await expect(svc.addVariant('sel', 'p1', { price: 10, sku: 'X', options: [] } as any)).rejects.toBeInstanceOf(ConflictException);
  });
});
