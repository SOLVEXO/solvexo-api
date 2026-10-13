/* eslint-disable prettier/prettier */
jest.mock('../database/databaseservice', () => ({ DatabaseService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrderExchangeService } from './order-exchange.service';
import { availableStock } from '../common/stock-availability.util';

const STORE = 'store1';
const SELLER = 'seller1';

/** ---- order cancellation: what happens to stock ---- */
describe('order cancellation stock handling', () => {
  const chain = (rows: any[]) => { const c: any = { lean: () => Promise.resolve(rows), session: () => c, sort: () => c }; return c; };

  function build(order: any, locationRows: any[] = []) {
    const productVariantModel: any = { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    const variantLocationStockModel: any = {
      find: jest.fn(() => chain(locationRows)),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const storeLocationModel: any = { findOne: jest.fn(() => chain([]) ) };
    storeLocationModel.findOne = jest.fn(() => ({ session: () => ({ lean: () => Promise.resolve(null) }), lean: () => Promise.resolve(null) }));
    const orderModel: any = {
      findById: jest.fn().mockResolvedValue(null),
      findOne: jest.fn().mockResolvedValue(order),
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: 'o1' }),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const storeModel: any = { findOne: jest.fn().mockResolvedValue({ _id: STORE, sellerId: SELLER }) };
    const db: any = { repositories: { orderModel, storeModel, productVariantModel, variantLocationStockModel, storeLocationModel } };
    const service = new OrdersService(
      db, {} as any, {} as any, {} as any,
      { recordRefund: jest.fn().mockResolvedValue({}) } as any, {} as any, { convertWithSnapshots: (n: number) => n } as any, { log: jest.fn() } as any,
      {} as any, { notify: jest.fn().mockResolvedValue(undefined), sendWhatsAppEvent: jest.fn().mockResolvedValue(undefined), sendCustomerEmail: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any, {} as any, {} as any,
    );
    jest.spyOn(service as any, 'pushTimeline').mockResolvedValue(undefined);
    return { service, productVariantModel, variantLocationStockModel, orderModel };
  }

  const makeOrder = (soExtra: any = {}, orderExtra: any = {}) => ({
    _id: { toString: () => 'o1' }, userId: 'u1', isPaid: false, isDelete: false, orderStatus: 'pending', updatedAt: new Date(),
    sellerOrders: [{
      storeId: STORE, sellerId: SELLER, status: 'pending', subtotal: 50, taxAmount: 0,
      items: [{ _id: { toString: () => 'it1' }, type: 'physical', variantId: 'v1', quantity: 3, status: 'pending', name: 'Shirt', totalPrice: 50 }],
      ...soExtra,
    }],
    ...orderExtra,
  });

  it('a normal (reserved) order releases only its reservation — on-hand stock is not touched', async () => {
    const { service, productVariantModel } = build(makeOrder());
    await service.cancelOrderAsSeller(SELLER, STORE, 'o1', { reason: 'out of stock' });
    const calls = productVariantModel.updateOne.mock.calls;
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0][1])).toContain('committedStock');
    expect(JSON.stringify(calls[0][1])).not.toContain('"$inc"');
  });

  it('a draft-order sale (stock already deducted) puts the units BACK on the shelf and does not release anyone else\'s reservation', async () => {
    const { service, productVariantModel } = build(makeOrder({ stockAlreadyDeducted: true }));
    await service.cancelOrderAsSeller(SELLER, STORE, 'o1', { reason: 'customer changed mind' });
    const calls = productVariantModel.updateOne.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ $inc: { stock: 3 } });
  });

  it('a draft-order cancel also returns the units to the location row when the variant has location stock', async () => {
    const { service, variantLocationStockModel } = build(makeOrder({ stockAlreadyDeducted: true }), [{ _id: 'row1', locationId: 'L1', stock: 5 }]);
    await service.cancelOrderAsSeller(SELLER, STORE, 'o1', { reason: 'x' });
    expect(variantLocationStockModel.updateOne).toHaveBeenCalledWith({ _id: 'row1' }, { $inc: { stock: 3 } }, expect.anything());
  });

  it('an exchange (replacement) order that is not yet shipped releases its reservation like any other order', async () => {
    const { service, productVariantModel } = build(makeOrder({}, { exchangeOf: { orderId: 'orig' } }));
    await service.cancelOrderAsSeller(SELLER, STORE, 'o1', { reason: 'x' });
    expect(JSON.stringify(productVariantModel.updateOne.mock.calls[0][1])).toContain('committedStock');
  });

  it('a shipped item cannot be cancelled and no stock moves', async () => {
    const order: any = makeOrder();
    order.sellerOrders[0].items[0].status = 'shipped';
    const { service, productVariantModel } = build(order);
    await expect(service.cancelOrderAsSeller(SELLER, STORE, 'o1', { reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(productVariantModel.updateOne).not.toHaveBeenCalled();
  });

  it('losing the optimistic-lock race touches no stock', async () => {
    const { service, productVariantModel, orderModel } = build(makeOrder());
    orderModel.findOneAndUpdate.mockResolvedValue(null);
    await expect(service.cancelOrderAsSeller(SELLER, STORE, 'o1', { reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(productVariantModel.updateOne).not.toHaveBeenCalled();
  });
});

/** ---- exchange orders: replacement stock ---- */
describe('exchange order stock handling', () => {
  const lean = (v: any) => ({ lean: () => Promise.resolve(v), select: () => ({ lean: () => Promise.resolve(v) }) });

  function build(variantsById: Record<string, any>, reserveResults: any[]) {
    const plain: any = {
      orderStatus: 'delivered', isPaid: true, currency: 'USD', fxSnapshots: [],
      sellerOrders: [{
        storeId: STORE, sellerId: SELLER, status: 'delivered', subtotal: 100, taxAmount: 0,
        items: [{ _id: 'ret1', type: 'physical', variantId: 'old', quantity: 1, totalPrice: 100, taxUSD: 0, status: 'delivered', returnStatus: 'received', name: 'Old' }],
      }],
    };
    const order: any = { ...plain, toObject: () => plain };
    const productVariantModel: any = {
      findOne: jest.fn((f: any) => lean(variantsById[f._id] ? { _id: f._id, ...variantsById[f._id] } : null)),
      updateOne: jest.fn(),
    };
    reserveResults.forEach((r) => productVariantModel.updateOne.mockResolvedValueOnce(r));
    productVariantModel.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const productModel: any = { findOne: jest.fn((f: any) => lean({ _id: f._id, name: 'Prod-' + f._id, status: 'active', type: 'physical' })) };
    const db: any = { repositories: {
      storeModel: { findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ baseCurrency: 'USD', name: 'S' }) }) })) },
      orderModel: { findOne: jest.fn().mockResolvedValue(order), updateOne: jest.fn().mockResolvedValue({}), findOneAndUpdate: jest.fn().mockResolvedValue(null) },
      productVariantModel, productModel,
    } };
    const svc = new OrderExchangeService(db, { log: jest.fn() } as any, {} as any, { convertWithSnapshots: (n: number) => n } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, productVariantModel };
  }
  const variant = (over: any = {}) => ({ productId: 'p', price: 100, status: 'active', stock: 10, committedStock: 0, damagedStock: 0, inTransitStock: 0, expiredStock: 0, ...over });
  const dto = (reps: { variantId: string; quantity: number }[]): any => ({ returnItemIds: ['ret1'], replacements: reps });

  it('availability counts expired lot units as unsellable (shared formula)', () => {
    expect(availableStock({ stock: 10, expiredStock: 4 })).toBe(6);
    expect(availableStock({ stock: 10, committedStock: 2, damagedStock: 1, inTransitStock: 1, expiredStock: 3 })).toBe(3);
  });

  it('refuses a replacement whose sellable stock is only expired units — before reserving anything', async () => {
    const { svc, productVariantModel } = build({ r1: variant({ stock: 5, expiredStock: 5 }) }, []);
    await expect(svc.createExchange(SELLER, STORE, '64b000000000000000000001', { actorId: 's', actorRole: 'seller' } as any, dto([{ variantId: 'r1', quantity: 1 }]))).rejects.toThrow(/Not enough stock/);
    expect(productVariantModel.updateOne).not.toHaveBeenCalled();
  });

  it('if a later replacement line cannot be reserved, the earlier reservation is rolled back (no stock left stuck in committed)', async () => {
    const { svc, productVariantModel } = build({ r1: variant(), r2: variant() }, [{ modifiedCount: 1 }, { modifiedCount: 0 }]);
    await expect(svc.createExchange(SELLER, STORE, '64b000000000000000000001', { actorId: 's', actorRole: 'seller' } as any, dto([{ variantId: 'r1', quantity: 2 }, { variantId: 'r2', quantity: 1 }]))).rejects.toThrow(/Not enough stock/);
    const calls = productVariantModel.updateOne.mock.calls;
    expect(calls[0][1]).toEqual({ $inc: { committedStock: 2 } }); // r1 reserved
    const rollback = calls.find((c: any[]) => Array.isArray(c[1]) && JSON.stringify(c[1]).includes('$subtract'));
    expect(rollback).toBeTruthy();
    expect(rollback![0]._id).toBe('r1'); // r1's reservation was released
  });

  it('the reservation itself is guarded by the shared availability expression (expired units included)', async () => {
    const { svc, productVariantModel } = build({ r1: variant() }, [{ modifiedCount: 0 }]);
    await expect(svc.createExchange(SELLER, STORE, '64b000000000000000000001', { actorId: 's', actorRole: 'seller' } as any, dto([{ variantId: 'r1', quantity: 1 }]))).rejects.toThrow(/Not enough stock/);
    expect(JSON.stringify(productVariantModel.updateOne.mock.calls[0][0])).toContain('expiredStock');
  });
});
