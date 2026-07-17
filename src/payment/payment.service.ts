

import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'src/database/databaseservice';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
// import Stripe from 'stripe';

@Injectable()
export class PaymentService {
  // private stripe: InstanceType<typeof Stripe>;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
    // private readonly configService: ConfigService,
  ) {
    // const secretKey = this.configService.get<string>('stripe_Secret_Key')?.trim() || '';
    // this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
  }

  private round(n: number) { return Math.round(n * 100) / 100; }

// async initiatePayment(userId: string, body: any) {
//   const { checkoutId } = body;
//   if (!checkoutId) throw new BadRequestException('checkoutId is required');
//   const { checkoutModel, paymentTransactionModel, productVariantModel } = this.databaseService.repositories;
//   const checkout = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
//   if (!checkout) throw new NotFoundException('Checkout not found');
//   if (checkout.status === 'completed') throw new BadRequestException('Checkout already completed');
//   if (checkout.status === 'cancelled') throw new BadRequestException('Checkout is cancelled');
//   if (checkout.status === 'expired') throw new BadRequestException('Checkout has expired');
//   if (checkout.expiredAt && checkout.expiredAt < new Date()) {
//     await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'expired' });
//     throw new BadRequestException('Checkout has expired');
//   }
//   const physicalItems = checkout.items.filter((i: any) => i.type === 'physical');
//   for (const item of physicalItems) {
//     const variant = await productVariantModel.findOne({ _id: item.variantId, isDelete: false });
//     if (!variant) throw new BadRequestException(`Item not available: ${item.name}`);
//     if (variant.stock < item.quantity) throw new BadRequestException(`Insufficient stock for ${item.name}`);
//   }
//   const existing = await paymentTransactionModel.findOne({ checkoutId: checkout._id.toString(), status: 'pending', paymentType: 'stripe', isDelete: false });
//   if (existing && existing.stripePaymentIntentId) {
//     try {
//       const pi = await this.stripe.paymentIntents.retrieve(existing.stripePaymentIntentId);
//       const reusable = ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status);
//       const amountMatches = pi.amount === Math.round(checkout.totalAmount * 100);
//       if (reusable && amountMatches) return { success: true, message: 'Payment already initiated', data: { clientSecret: pi.client_secret, paymentIntentId: pi.id, amount: checkout.totalAmount } };
//       if (reusable) await this.stripe.paymentIntents.cancel(pi.id).catch(() => null);
//       await paymentTransactionModel.findByIdAndUpdate(existing._id, { status: 'failed' });
//     } catch { await paymentTransactionModel.findByIdAndUpdate(existing._id, { status: 'failed' }); }
//   }
//   let paymentIntent: any;
//   try {
//     paymentIntent = await this.stripe.paymentIntents.create({ amount: Math.round(checkout.totalAmount * 100), currency: checkout.currency?.toLowerCase() || 'usd', metadata: { checkoutId: checkout._id.toString(), userId }, automatic_payment_methods: { enabled: true, allow_redirects: 'never' } }, { idempotencyKey: `checkout_${checkout._id.toString()}` });
//   } catch (err: any) { throw new BadRequestException(`Payment initiation failed: ${err?.message || 'Stripe error'}`); }
//   await paymentTransactionModel.create({ userId, checkoutId: checkout._id.toString(), paymentType: 'stripe', amount: checkout.totalAmount, status: 'pending', stripePaymentIntentId: paymentIntent.id, stripeClientSecret: paymentIntent.client_secret });
//   await checkoutModel.findByIdAndUpdate(checkoutId, { paymentType: 'stripe', status: 'payment_pending' });
//   return { success: true, message: 'Payment initiated', data: { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id, amount: checkout.totalAmount } };
// }

// async stripeWebhook(rawBody: Buffer, signature: string) {
//   const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET_TEST') || '';
//   let event: any;
//   try { event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret); }
//   catch { throw new BadRequestException('Invalid Stripe webhook signature'); }
//   if (event.type !== 'payment_intent.succeeded') return { received: true };
//   const paymentIntent = event.data.object as any;
//   const checkoutId = paymentIntent.metadata?.checkoutId;
//   const userId = paymentIntent.metadata?.userId;
//   if (!checkoutId || !userId) return { received: true };
//   const { checkoutModel, paymentTransactionModel, orderModel, addressModel, cartModel } = this.databaseService.repositories;
//   const transaction = await paymentTransactionModel.findOneAndUpdate({ stripePaymentIntentId: paymentIntent.id, status: 'pending', isDelete: false }, { status: 'completed', paidAt: new Date() }, { new: true });
//   if (!transaction) return { received: true };
//   const checkout = await checkoutModel.findOne({ _id: checkoutId, isDelete: false });
//   if (!checkout || checkout.status === 'completed') return { received: true };
//   let orders: any[];
//   try { orders = await this.createOrder(userId, checkout, orderModel, addressModel); }
//   catch (err: any) {
//     await paymentTransactionModel.findByIdAndUpdate(transaction._id, { status: 'pending', paidAt: null });
//     console.error('createOrder failed in webhook:', err?.message, { checkoutId, userId });
//     throw new BadRequestException('Order creation failed, will retry');
//   }
//   await paymentTransactionModel.findByIdAndUpdate(transaction._id, { orderIds: orders.map((o) => o._id.toString()) });
//   await checkoutModel.findByIdAndUpdate(checkoutId, { status: 'completed' });
//   await cartModel.findOneAndUpdate({ userId, status: 'active', isDelete: false }, { status: 'inactive' });
//   return { received: true };
// }

async placeOrder(userId: string, body: any) {
  const { checkoutId } = body;
  if (!checkoutId) throw new BadRequestException('checkoutId is required');

  const { checkoutModel, paymentTransactionModel, orderModel, addressModel, productVariantModel, cartModel } =
    this.databaseService.repositories;

  const checkout = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
  if (!checkout) throw new NotFoundException('Checkout not found');
  if (checkout.status === 'completed') throw new BadRequestException('Checkout already completed');
  if (checkout.status === 'cancelled') throw new BadRequestException('Checkout is cancelled');
  if (checkout.status === 'expired') throw new BadRequestException('Checkout has expired');
  if (checkout.expiredAt && checkout.expiredAt < new Date()) {
    await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'expired' });
    throw new BadRequestException('Checkout has expired');
  }

  const physicalItems = checkout.items.filter((i: any) => i.type === 'physical');
  for (const item of physicalItems) {
    const variant = await productVariantModel.findOne({ _id: item.variantId, isDelete: false });
    if (!variant) throw new BadRequestException(`Item not available: ${item.name}`);
    if (variant.stock < item.quantity) {
      throw new BadRequestException(
        `Insufficient stock for ${item.name}. Available: ${variant.stock}, required: ${item.quantity}`,
      );
    }
  }

  await checkoutModel.findByIdAndUpdate(checkoutId, {
    paymentType: 'stripe',
    status: 'payment_pending',
  });

  const orders = await this.createOrder(userId, checkout, orderModel, addressModel, 'stripe', true);

  await paymentTransactionModel.create({
    userId,
    checkoutId: checkout._id.toString(),
    orderIds: orders.map((o: any) => o._id.toString()),
    paymentType: 'stripe',
    amount: checkout.totalAmount,
    status: 'completed',
    stripePaymentIntentId: null,
    stripeClientSecret: null,
    paidAt: new Date(),
  });

  await checkoutModel.findByIdAndUpdate(checkoutId, { status: 'completed' });
  await this.removeCheckedOutItemsFromCart(userId, checkout, cartModel);

  return {
    success: true,
    message: 'Order placed successfully',
    data: { orders: orders.map((o: any) => this.formatOrder(o)) },
  };
}

// Remove ONLY the lines that were part of this checkout — a checkout created
// from selected cart items must leave the unselected lines in the cart.
// (Previously this blanked the whole cart with `{ items: [] }`.)
private async removeCheckedOutItemsFromCart(userId: string, checkout: any, cartModel: any) {
  const purchasedLines = (checkout.items as any[]).map((i: any) => ({
    productId: i.productId,
    productVariantId: i.variantId,
  }));
  if (purchasedLines.length === 0) return;

  await cartModel.findOneAndUpdate(
    { userId, status: 'active', isDelete: false },
    { $pull: { items: { $or: purchasedLines } } },
  );
}

async codPayment(userId: string, body: any) {
  const { checkoutId } = body;
  if (!checkoutId) throw new BadRequestException('checkoutId is required');

  const { checkoutModel, paymentTransactionModel, orderModel, addressModel, productVariantModel, cartModel } =
    this.databaseService.repositories;

  const checkout = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
  if (!checkout) throw new NotFoundException('Checkout not found');
  if (checkout.status === 'completed') throw new BadRequestException('Checkout already completed');
  if (checkout.status === 'cancelled') throw new BadRequestException('Checkout is cancelled');
  if (checkout.status === 'expired') throw new BadRequestException('Checkout has expired');
  if (checkout.expiredAt && checkout.expiredAt < new Date()) {
    await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'expired' });
    throw new BadRequestException('Checkout has expired');
  }

  const hasDigital = checkout.items.some((i: any) => i.type === 'digital');
  if (hasDigital) throw new BadRequestException('Cash on Delivery is not available for digital products');

  for (const item of checkout.items) {
    const variant = await productVariantModel.findOne({ _id: item.variantId, isDelete: false });
    if (!variant) throw new BadRequestException(`Item not available: ${item.name}`);
    if (variant.stock < item.quantity) {
      throw new BadRequestException(
        `Insufficient stock for ${item.name}. Available: ${variant.stock}, required: ${item.quantity}`,
      );
    }
  }

  await checkoutModel.findByIdAndUpdate(checkoutId, {
    paymentType: 'cash_on_delivery',
    status: 'payment_pending',
  });

  const orders = await this.createOrder(userId, checkout, orderModel, addressModel, 'cash_on_delivery', false);

  await paymentTransactionModel.create({
    userId,
    checkoutId: checkout._id.toString(),
    orderIds: orders.map((o: any) => o._id.toString()),
    paymentType: 'cash_on_delivery',
    amount: checkout.totalAmount,
    status: 'completed',
    stripePaymentIntentId: null,
    stripeClientSecret: null,
    paidAt: null,
  });

  await checkoutModel.findByIdAndUpdate(checkoutId, { status: 'completed' });
  await this.removeCheckedOutItemsFromCart(userId, checkout, cartModel);

  return {
    success: true,
    message: 'Order placed successfully (Cash on Delivery)',
    data: { orders: orders.map((o: any) => this.formatOrder(o)) },
  };
}

private formatOrder(order: any) {
  const allItems = order.sellerOrders.flatMap((so: any) =>
    so.items.map((item: any) => ({
      name: item.name,
      image: item.image ?? null,
      sku: item.sku ?? null,
      quantity: item.quantity,
      price: item.price,
      totalPrice: item.totalPrice,
      type: item.type,
    })),
  );

  return {
    orderId: order._id,
    orderNumber: order.orderNumber,
    orderDate: order.createdAt,
    paymentDate: order.paidAt ?? null,
    paymentMethod: order.paymentType,
    isPaid: order.isPaid,
    orderStatus: order.orderStatus,
    deliveryAddress: order.shippingAddress ?? null,
    items: allItems,
    summary: {
      subtotal: order.subtotal,
      shipping: order.shippingFee,
      total: order.totalAmount,
    },
  };
}

private async createOrder(
  userId: string,
  checkout: any,
  orderModel: any,
  addressModel: any,
  paymentType: string = 'stripe',
  isPaid: boolean = true,
) {
  const { productVariantModel, productModel } = this.databaseService.repositories;

  const physicalItems = checkout.items.filter((i: any) => i.type === 'physical');
  const digitalItems = checkout.items.filter((i: any) => i.type === 'digital');

  // --- STOCK MINUS (atomic, sirf physical) ---
  const decremented: { variantId: string; quantity: number }[] = [];

  for (const item of physicalItems) {
    const res = await productVariantModel.updateOne(
      { _id: item.variantId, stock: { $gte: item.quantity }, isDelete: false },
      { $inc: { stock: -item.quantity } },
    );

    if (res.modifiedCount === 0) {
      for (const d of decremented) {
        await productVariantModel.updateOne(
          { _id: d.variantId },
          { $inc: { stock: d.quantity } },
        );
      }
      throw new BadRequestException(`Stock not available for item: ${item.name}`);
    }
    decremented.push({ variantId: item.variantId, quantity: item.quantity });
  }

  // --- shipping address (physical ke liye) ---
  let shippingAddress: any = null;
  if (checkout.addressId) {
    const address = await addressModel.findOne({ _id: checkout.addressId, isDelete: false });
    if (address) {
      shippingAddress = {
        recipientName: address.recipientName,
        phoneNumber: address.phoneNumber,
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2 ?? null,
        city: address.city,
        state: address.state,
        zipCode: address.zipCode,
      };
    }
  }

  // --- helper: ek type ke items ko store-wise sellerOrders me ---
  const buildSellerOrders = (items: any[]) => {
    const storeMap: Record<string, any[]> = {};
    for (const item of items) {
      const key = item.storeId || item.sellerId;
      if (!storeMap[key]) storeMap[key] = [];
      storeMap[key].push(item);
    }

    return Object.values(storeMap).map((storeItems) => {
      const subtotal = storeItems.reduce((s, i) => s + i.totalPrice, 0);
      return {
        sellerId: storeItems[0].sellerId,
        storeId: storeItems[0].storeId,
        fulfillmentType: storeItems[0].type, // 'physical' ya 'digital'
        items: storeItems.map((i) => ({
          productId: i.productId,
          variantId: i.variantId,
          type: i.type,
          name: i.name,
          image: i.image ?? null,
          sku: i.sku ?? null,
          size: i.size ?? null,
          color: i.color ?? null,
          licenseType: i.licenseType ?? null,
          quantity: i.quantity,
          price: i.price,
          totalPrice: i.totalPrice,
          originalPrice: i.originalPrice ?? null,
          subscriberDiscountUSD: i.subscriberDiscountUSD ?? 0,
          status: 'pending',
        })),
        subtotal,
        status: 'pending',
        tracking: null,
        shippedAt: null,
        deliveredAt: null,
        cancelledAt: null,
        cancelReason: null,
      };
    });
  };

  // unique orderNumber (counter se taaki same-ms collision na ho)
  let seq = 0;
  const genOrderNumber = () =>
    `ORD-${Date.now()}-${seq++}-${Math.floor(Math.random() * 9000 + 1000)}`;

  const createdOrders: any[] = [];

  // Coupon discount was computed against the WHOLE checkout's subtotal
  // (CheckoutService.applyCoupon) but a checkout can split into a physical +
  // digital Order pair here — prorate it by each group's share of the
  // checkout subtotal, same reasoning as the existing per-item
  // subscriberDiscountUSD split above.
  const couponDiscountRatio = checkout.subtotal > 0 ? (checkout.couponDiscountUSD || 0) / checkout.subtotal : 0;

  // === PHYSICAL ORDER ===
  if (physicalItems.length > 0) {
    const sellerOrders = buildSellerOrders(physicalItems);
    const subtotal = physicalItems.reduce((s: number, i: any) => s + i.totalPrice, 0);
    const shippingFee = checkout.shippingFee || 0;
    const subscriberDiscountTotal = physicalItems.reduce((s: number, i: any) => s + (i.subscriberDiscountUSD ?? 0), 0);
    const couponDiscountUSD = this.round(subtotal * couponDiscountRatio);

    const physicalOrder = await orderModel.create({
      orderNumber: genOrderNumber(),
      userId,
      checkoutId: checkout._id.toString(),
      currency: checkout.currency || 'USD',
      sellerOrders,
      shippingAddress,
      subtotal,
      shippingFee,
      taxAmount: 0,
      subscriberDiscountTotal,
      couponCode: checkout.couponCode ?? null,
      couponDiscountUSD,
      totalAmount: this.round(subtotal + shippingFee - couponDiscountUSD),
      paymentType,
      paymentStatus: isPaid ? 'paid' : 'unpaid',
      isPaid,
      paidAt: isPaid ? new Date() : null,
      orderStatus: 'pending',
      attributionSource: checkout.attributionSource ?? 'other',
      isDelete: false,
    });
    createdOrders.push(physicalOrder);
  }

  // === DIGITAL ORDER ===
  if (digitalItems.length > 0) {
    const sellerOrders = buildSellerOrders(digitalItems);
    const subtotal = digitalItems.reduce((s: number, i: any) => s + i.totalPrice, 0);
    const subscriberDiscountTotal = digitalItems.reduce((s: number, i: any) => s + (i.subscriberDiscountUSD ?? 0), 0);
    const couponDiscountUSD = this.round(subtotal * couponDiscountRatio);

    const digitalOrder = await orderModel.create({
      orderNumber: genOrderNumber(),
      userId,
      checkoutId: checkout._id.toString(),
      currency: checkout.currency || 'USD',
      sellerOrders,
      shippingAddress: null,
      subtotal,
      shippingFee: 0,
      taxAmount: 0,
      subscriberDiscountTotal,
      couponCode: checkout.couponCode ?? null,
      couponDiscountUSD,
      totalAmount: this.round(subtotal - couponDiscountUSD),
      paymentType,
      paymentStatus: isPaid ? 'paid' : 'unpaid',
      isPaid,
      paidAt: isPaid ? new Date() : null,
      orderStatus: 'pending',
      attributionSource: checkout.attributionSource ?? 'other',
      isDelete: false,
    });
    createdOrders.push(digitalOrder);
  }

  // purchaseCount increment — har item ke product pe
  for (const item of checkout.items) {
    await productModel.findByIdAndUpdate(item.productId, {
      $inc: { purchaseCount: item.quantity },
    });
  }

  const notifiedSellers = new Set<string>();
  for (const createdOrder of createdOrders) {
    for (const so of createdOrder.sellerOrders) {
      if (notifiedSellers.has(`${createdOrder._id}:${so.sellerId}`)) continue;
      notifiedSellers.add(`${createdOrder._id}:${so.sellerId}`);
      this.notificationsService.notify({
        recipientId: so.sellerId,
        recipientRole: 'seller',
        type: NOTIFICATION_TYPES.ORDER_PLACED,
        title: 'New order received',
        body: `You have a new order #${createdOrder.orderNumber} for ${so.items.length} item(s).`,
        data: { orderId: createdOrder._id.toString() },
      }).catch(() => {});
    }
  }

  return createdOrders;
}
}
