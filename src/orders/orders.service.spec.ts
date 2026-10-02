/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { DatabaseService } from '@/database/databaseservice';
import { PaymentService } from '@/payment/payment.service';

const SELLER_ID = 'seller-1';
const STORE_ID = 'store-1';
const ORDER_ID = 'order-1';

/**
 * Focused on ONE real, safety-critical behavior added to
 * `updateSellerOrderStatus`: the auto-capture-on-fulfillment guard for
 * `Store.paymentCaptureMethod === 'manual'` orders (see PaymentService's
 * doc comments on `authorizePaymentIntent`/`captureOrderPayment`). This is
 * NOT a full test suite for `updateSellerOrderStatus` itself (a 400+ line
 * method touching a dozen collections, with no pre-existing test coverage
 * at all before this file) — that would be a much larger, separate
 * undertaking. Every other branch of that method (stock decrement,
 * recordSale-on-completed, notifications, etc.) is exercised here only to
 * the minimum extent needed to reach a real "status successfully updated"
 * or "status update blocked" outcome, never asserted on directly.
 */
function makeOrder(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: ORDER_ID,
    userId: 'buyer-1',
    paymentStatus: 'paid',
    shippingAddress: null,
    sellerOrders: [{
      storeId: STORE_ID, sellerId: SELLER_ID, status: 'pending',
      items: [{ type: 'physical', variantId: 'v1', quantity: 1, status: 'pending' }],
    }],
    ...overrides,
  };
}

describe('OrdersService — manual-capture auto-capture-on-fulfillment guard', () => {
  let service: OrdersService;
  let orderModel: any;
  let storeModel: any;
  let productVariantModel: any;
  let paymentService: { captureOrderPayment: jest.Mock };

  beforeEach(() => {
    // findOneAndUpdate = the atomic "claim this transition" write; updateOne = COGS follow-up.
    orderModel = { findOne: jest.fn(), findOneAndUpdate: jest.fn().mockResolvedValue({}), updateOne: jest.fn().mockResolvedValue({}) };
    storeModel = { findOne: jest.fn().mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID }) };
    productVariantModel = {
      findOne: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ unlimitedStock: true }) }) }),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    paymentService = { captureOrderPayment: jest.fn().mockResolvedValue({ captured: true }) };

    const db = {
      repositories: { orderModel, storeModel, productVariantModel },
    } as unknown as DatabaseService;

    service = new OrdersService(
      db, {} as any, {} as any, {} as any,
      {} as any, paymentService as unknown as PaymentService, {} as any, { log: jest.fn() } as any,
      {} as any, { notify: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any, {} as any, {} as any,
    );
  });

  it('never calls captureOrderPayment for a normal (already-paid) order', async () => {
    orderModel.findOne.mockResolvedValue(makeOrder({ paymentStatus: 'paid' }));

    await service.updateSellerOrderStatus(SELLER_ID, {
      orderId: ORDER_ID, storeId: STORE_ID, status: 'processing',
    });

    expect(paymentService.captureOrderPayment).not.toHaveBeenCalled();
    expect(orderModel.findOneAndUpdate).toHaveBeenCalled();
  });

  it('auto-captures the authorized payment before shipping, then proceeds with the status update', async () => {
    orderModel.findOne.mockResolvedValue(makeOrder({ paymentStatus: 'authorized' }));

    const result = await service.updateSellerOrderStatus(SELLER_ID, {
      orderId: ORDER_ID, storeId: STORE_ID, status: 'shipped',
      tracking: { carrier: 'DHL', trackingNumber: '123' },
    });

    expect(paymentService.captureOrderPayment).toHaveBeenCalledWith(SELLER_ID, ORDER_ID);
    expect(orderModel.findOneAndUpdate).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('blocks the status update entirely when the real Stripe capture fails (authorization already expired) — never ships an order that was never actually paid for', async () => {
    orderModel.findOne.mockResolvedValue(makeOrder({ paymentStatus: 'authorized' }));
    paymentService.captureOrderPayment.mockRejectedValue(new Error('Stripe capture failed: this PaymentIntent has already expired.'));

    await expect(
      service.updateSellerOrderStatus(SELLER_ID, {
        orderId: ORDER_ID, storeId: STORE_ID, status: 'shipped',
        tracking: { carrier: 'DHL', trackingNumber: '123' },
      }),
    ).rejects.toThrow(/expired/);

    // The status write must never happen if the capture didn't actually succeed.
    expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not auto-capture for a status not in the fulfilled set (processing), even on an authorized order', async () => {
    orderModel.findOne.mockResolvedValue(makeOrder({ paymentStatus: 'authorized' }));

    await service.updateSellerOrderStatus(SELLER_ID, {
      orderId: ORDER_ID, storeId: STORE_ID, status: 'processing',
    });

    expect(paymentService.captureOrderPayment).not.toHaveBeenCalled();
  });

  describe('status state machine (forward-only, terminal cancelled/refunded)', () => {
    const run = (currentStatus: string, status: string, extra: any = {}) => {
      orderModel.findOne.mockResolvedValue(makeOrder({
        sellerOrders: [{
          storeId: STORE_ID, sellerId: SELLER_ID, status: currentStatus,
          items: [{ type: 'physical', variantId: 'v1', quantity: 1, status: currentStatus }],
        }],
      }));
      return service.updateSellerOrderStatus(SELLER_ID, { orderId: ORDER_ID, storeId: STORE_ID, status, ...extra });
    };

    it.each([
      ['pending', 'processing'], ['pending', 'completed'], ['processing', 'shipped'],
      ['shipped', 'delivered'], ['delivered', 'completed'], ['completed', 'completed'],
    ])('allows %s -> %s', async (from, to) => {
      const extra = to === 'shipped' ? { tracking: { carrier: 'DHL', trackingNumber: '1' } } : {};
      await expect(run(from, to, extra)).resolves.toBeDefined();
    });

    it.each([
      ['cancelled', 'completed'], ['refunded', 'completed'], ['cancelled', 'processing'],
      ['completed', 'delivered'], ['completed', 'processing'], ['shipped', 'processing'], ['delivered', 'shipped'],
    ])('REGRESSION: rejects %s -> %s (a cancelled/refunded order can never be revived or credited)', async (from, to) => {
      await expect(run(from, to, { tracking: { carrier: 'DHL', trackingNumber: '1' } })).rejects.toBeInstanceOf(BadRequestException);
      expect(orderModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('claims the transition atomically — conditional on the status that was read', async () => {
      await run('pending', 'processing');
      const [filter] = orderModel.findOneAndUpdate.mock.calls[0];
      expect(filter).toEqual(expect.objectContaining({ _id: ORDER_ID, 'sellerOrders.0.status': 'pending' }));
    });

    it('REGRESSION: if a concurrent request already moved the order, it throws a conflict and moves NO stock', async () => {
      orderModel.findOneAndUpdate.mockResolvedValue(null); // lost the race
      // A finite-stock variant: if the claim did NOT gate the stock loop, updateOne WOULD run.
      productVariantModel.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ unlimitedStock: false, stock: 5, committedStock: 1 }) }) });
      await expect(run('pending', 'shipped', { tracking: { carrier: 'DHL', trackingNumber: '1' } })).rejects.toBeInstanceOf(ConflictException);
      expect(productVariantModel.updateOne).not.toHaveBeenCalled();
    });
  });
});
