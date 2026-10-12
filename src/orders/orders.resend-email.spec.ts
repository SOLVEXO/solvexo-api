/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { DatabaseService } from '@/database/databaseservice';

const SELLER_ID = 'seller-1';
const STORE_ID = 'store-1';
const ORDER_ID = '64b0000000000000000000aa';
const ACTOR = { actorId: SELLER_ID, actorRole: 'seller' };

function lean<T>(value: T) {
  const q: any = { select: () => q, lean: () => Promise.resolve(value) };
  return q;
}

function makeOrder(over: Record<string, any> = {}, soOver: Record<string, any> = {}) {
  return {
    _id: ORDER_ID, orderNumber: 'SX-1001', userId: 'buyer-1', currency: 'PKR', paymentType: 'stripe',
    fulfillmentMethod: 'ship', shippingAddress: { recipientName: 'Sara Khan' }, timeline: [], pickupLocation: null,
    sellerOrders: [{
      storeId: STORE_ID, sellerId: SELLER_ID, status: 'shipped', refundedTotal: 0,
      items: [{ name: 'Tee', quantity: 2, status: 'active' }],
      tracking: { carrier: 'TCS', trackingNumber: 'T1', trackingUrl: 'https://track.test/T1' },
      ...soOver,
    }],
    ...over,
  };
}

describe('OrdersService.resendCustomerEmail', () => {
  let service: OrdersService;
  let order: any;
  let notifications: { sendCustomerEmail: jest.Mock };
  let paymentService: { resendOrderConfirmationEmail: jest.Mock };
  let activityLog: { log: jest.Mock };
  let buyer: any;

  beforeEach(() => {
    (OrdersService as any).resendLocks.clear();
    order = makeOrder();
    buyer = { email: 'sara@x.com', isGuest: false };
    notifications = { sendCustomerEmail: jest.fn().mockResolvedValue('sent') };
    paymentService = { resendOrderConfirmationEmail: jest.fn().mockResolvedValue('sent') };
    activityLog = { log: jest.fn() };
    const db = {
      repositories: {
        storeModel: { findOne: jest.fn((q: any) => lean(q.sellerId === SELLER_ID ? { _id: STORE_ID } : null)) },
        orderModel: { findOne: jest.fn(() => Promise.resolve(order)) },
        userModel: { findById: jest.fn(() => lean(buyer)) },
      },
    } as unknown as DatabaseService;
    service = new OrdersService(
      db, {} as any, {} as any, {} as any,
      {} as any, paymentService as any, {} as any, activityLog as any,
      {} as any, notifications as any,
      {} as any, {} as any, {} as any,
    );
  });

  const resend = (event: string, seller = SELLER_ID) => service.resendCustomerEmail(seller, STORE_ID, ORDER_ID, event, ACTOR);

  it('rejects an email that cannot be resent and an invalid order id', async () => {
    await expect(resend('order_edited')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.resendCustomerEmail(SELLER_ID, STORE_ID, 'not-an-id', 'order_shipped', ACTOR)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a seller who doesn't own the store", async () => {
    await expect(resend('order_shipped', 'someone-else')).rejects.toBeInstanceOf(ForbiddenException);
    expect(notifications.sendCustomerEmail).not.toHaveBeenCalled();
  });

  it('resends the confirmation through the payment service', async () => {
    await expect(resend('order_confirmation')).resolves.toMatchObject({ success: true });
    expect(paymentService.resendOrderConfirmationEmail).toHaveBeenCalledWith(order, STORE_ID);
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'order_email_resent', storeId: STORE_ID }));
  });

  it('resends the shipping email with the latest tracking, and ignores the store off-switch (force)', async () => {
    await resend('order_shipped');
    const args = notifications.sendCustomerEmail.mock.calls[0][0];
    expect(args).toMatchObject({ to: 'sara@x.com', storeId: STORE_ID, event: 'order_shipped', orderId: ORDER_ID, force: true, trackingUrl: 'https://track.test/T1' });
    expect(args.vars).toMatchObject({ customerName: 'Sara', orderNumber: 'SX-1001', carrier: 'TCS', trackingNumber: 'T1', itemList: 'Tee × 2' });
  });

  it('uses the most recent shipment of a partly fulfilled order — its tracking AND its items', async () => {
    order = makeOrder({}, {
      tracking: null,
      items: [{ _id: 'i1', name: 'Tee', quantity: 2, status: 'active' }, { _id: 'i2', name: 'Cap', quantity: 3, status: 'active' }],
      shipments: [
        { items: [{ itemId: 'i1', quantity: 2 }], tracking: { carrier: 'A', trackingNumber: '1' } },
        { items: [{ itemId: 'i2', quantity: 1 }], tracking: { carrier: 'B', trackingNumber: '2' } },
      ],
    });
    await resend('order_shipped');
    const vars = notifications.sendCustomerEmail.mock.calls[0][0].vars;
    expect(vars).toMatchObject({ carrier: 'B', trackingNumber: '2' });
    expect(vars.itemList).toBe('Cap × 1');
  });

  it('will not send "shipped" before the order shipped, "delivered" before it was delivered, or the wrong pickup/ship email', async () => {
    order = makeOrder({}, { status: 'processing' });
    await expect(resend('order_shipped')).rejects.toThrow(/not shipped/i);
    await expect(resend('order_delivered')).rejects.toThrow(/not been delivered/i);
    order = makeOrder({ fulfillmentMethod: 'pickup' });
    await expect(resend('order_shipped')).rejects.toThrow(/pickup/i);
    order = makeOrder({ fulfillmentMethod: 'ship' });
    await expect(resend('order_ready_for_pickup')).rejects.toThrow(/not a pickup/i);
  });

  it('refuses when the customer has no usable email (guest without contact email)', async () => {
    buyer = { email: 'guest-xyz@guest.invalid', isGuest: true };
    await expect(resend('order_shipped')).rejects.toThrow(/no email/i);
    expect(notifications.sendCustomerEmail).not.toHaveBeenCalled();
  });

  it('cancelled: lists only the canceled items, and refuses when nothing was canceled', async () => {
    await expect(resend('order_cancelled')).rejects.toThrow(/nothing was canceled/i);
    order = makeOrder({}, { items: [{ name: 'Tee', quantity: 1, status: 'cancelled' }, { name: 'Cap', quantity: 3, status: 'active' }] });
    await resend('order_cancelled');
    expect(notifications.sendCustomerEmail.mock.calls[0][0].vars.itemList).toBe('Tee × 1');
  });

  it('refund: sends the refunded total, and refuses when nothing was refunded', async () => {
    await expect(resend('order_refunded')).rejects.toThrow(/nothing has been refunded/i);
    order = makeOrder({}, { refundedTotal: 1200.5 });
    await resend('order_refunded');
    expect(notifications.sendCustomerEmail.mock.calls[0][0].vars).toMatchObject({ refundAmount: '1200.50 PKR', refundMethod: 'Original payment method' });
  });

  it('reports a delivery failure instead of pretending it was sent, and logs nothing', async () => {
    notifications.sendCustomerEmail.mockResolvedValue('failed');
    await expect(resend('order_shipped')).rejects.toThrow(/could not be sent/i);
    expect(activityLog.log).not.toHaveBeenCalled();
  });

  it('two parallel requests send the email only once', async () => {
    const results = await Promise.allSettled([resend('order_shipped'), resend('order_shipped')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(notifications.sendCustomerEmail).toHaveBeenCalledTimes(1);
  });

  it('a request that is refused or fails does not lock out the retry', async () => {
    order = makeOrder({}, { status: 'processing' });
    await expect(resend('order_shipped')).rejects.toThrow(/not shipped/i);
    order = makeOrder();
    notifications.sendCustomerEmail.mockResolvedValueOnce('failed');
    await expect(resend('order_shipped')).rejects.toThrow(/could not be sent/i);
    await expect(resend('order_shipped')).resolves.toMatchObject({ success: true });
  });

  it('blocks the same email being sent again within 30 seconds', async () => {
    order = makeOrder({ timeline: [{ type: 'email', message: 'Shipping confirmation email sent to sara@x.com', createdAt: new Date() }] });
    await expect(resend('order_shipped')).rejects.toThrow(/just sent/i);
    // a different email type is not blocked
    await expect(resend('order_delivered')).rejects.toThrow(/not been delivered/i);
  });
});
