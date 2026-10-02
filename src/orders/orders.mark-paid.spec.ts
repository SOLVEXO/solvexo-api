/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { DatabaseService } from '@/database/databaseservice';

const SELLER_ID = 'seller-1';
const STORE_ID = 'store-1';
const OTHER_STORE_ID = 'store-2';
const ORDER_ID = 'order-1';
const ACTOR = { actorId: SELLER_ID, actorRole: 'seller' as const };

function makeOrder(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: ORDER_ID,
    isPaid: false,
    orderStatus: 'processing',
    totalAmount: 50,
    currency: 'USD',
    sellerOrders: [{ storeId: STORE_ID, sellerId: SELLER_ID, status: 'pending', items: [] }],
    ...overrides,
  };
}

/**
 * `markPaid` used to take only an orderId — any seller could mark any
 * store's order paid (completing it and crediting the ledger). It is now
 * scoped to (sellerId, storeId, orderId).
 */
describe('OrdersService.markPaid — store/seller scoping', () => {
  let service: OrdersService;
  let orderModel: any;
  let storeModel: any;
  let orderPaymentRecordModel: any;
  let finalizeSpy: jest.SpyInstance;

  beforeEach(() => {
    orderModel = { findOne: jest.fn() };
    // Store lookup honours the sellerId filter like Mongo would.
    storeModel = {
      findOne: jest.fn().mockImplementation((filter: any) => ({
        select: () => ({
          lean: () => Promise.resolve(filter._id === STORE_ID && filter.sellerId === SELLER_ID ? { _id: STORE_ID } : null),
        }),
      })),
    };
    orderPaymentRecordModel = { create: jest.fn().mockResolvedValue({}) };

    const db = { repositories: { orderModel, storeModel, orderPaymentRecordModel } } as unknown as DatabaseService;
    service = new OrdersService(
      db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      { log: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    finalizeSpy = jest.spyOn(service as any, 'finalizeOrderPayment').mockResolvedValue(undefined);
  });

  it('marks the order paid for the owning seller and records the payment against that store', async () => {
    orderModel.findOne.mockResolvedValue(makeOrder());

    const res = await service.markPaid(SELLER_ID, STORE_ID, ORDER_ID, ACTOR);

    expect(res.success).toBe(true);
    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(orderPaymentRecordModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, storeId: STORE_ID, sellerId: SELLER_ID, recordedBy: SELLER_ID }),
    );
  });

  it('REGRESSION: a different seller cannot mark someone else\'s store order paid', async () => {
    orderModel.findOne.mockResolvedValue(makeOrder());

    await expect(service.markPaid('attacker-seller', STORE_ID, ORDER_ID, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);

    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(orderPaymentRecordModel.create).not.toHaveBeenCalled();
  });

  it('REGRESSION: a seller cannot mark paid an order that belongs to another store, even using their own storeId', async () => {
    orderModel.findOne.mockResolvedValue(
      makeOrder({ sellerOrders: [{ storeId: OTHER_STORE_ID, sellerId: 'seller-2', status: 'pending', items: [] }] }),
    );

    await expect(service.markPaid(SELLER_ID, STORE_ID, ORDER_ID, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown order', async () => {
    orderModel.findOne.mockResolvedValue(null);
    await expect(service.markPaid(SELLER_ID, STORE_ID, ORDER_ID, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects an already-paid order', async () => {
    orderModel.findOne.mockResolvedValue(makeOrder({ isPaid: true }));
    await expect(service.markPaid(SELLER_ID, STORE_ID, ORDER_ID, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['order', { orderStatus: 'cancelled' }],
    ['order', { orderStatus: 'refunded' }],
    ['sub-order', { sellerOrders: [{ storeId: STORE_ID, sellerId: SELLER_ID, status: 'cancelled', items: [] }] }],
  ])('REGRESSION: a cancelled/refunded %s can never be revived by mark-paid', async (_label, overrides) => {
    orderModel.findOne.mockResolvedValue(makeOrder(overrides as any));

    await expect(service.markPaid(SELLER_ID, STORE_ID, ORDER_ID, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(orderPaymentRecordModel.create).not.toHaveBeenCalled();
  });
});
