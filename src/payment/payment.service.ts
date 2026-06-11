// import {
//   Injectable,
//   BadRequestException,
//   NotFoundException,
// } from '@nestjs/common';
// import { ConfigService } from '@nestjs/config';
// import { DatabaseService } from 'src/database/databaseservice';
// import Stripe from 'stripe';

// @Injectable()
// export class PaymentProcessingService {
//   private stripe: InstanceType<typeof Stripe>;

//   constructor(
//     private readonly databaseService: DatabaseService,
//     private readonly configService: ConfigService,
//   ) {
//     const secretKey =
//       this.configService.get<string>('stripe_Secret_Key')?.trim() || '';
//     this.stripe = new Stripe(secretKey, {
//       apiVersion: '2025-04-30.basil' as any,
//     });
//   }

//   async selectPayment(userId: string, body: any) {
//     const { checkoutId, paymentType } = body;

//     if (!checkoutId) throw new BadRequestException('checkoutId is required');
//     if (!paymentType) throw new BadRequestException('paymentType is required');
//     if (!['cash_on_delivery', 'stripe'].includes(paymentType)) {
//       throw new BadRequestException(
//         'paymentType must be cash_on_delivery or stripe',
//       );
//     }

//     const checkout =
//       await this.databaseService.repositories.checkoutModel.findOne({
//         _id: checkoutId,
//         userId,
//         isDelete: false,
//       });

//     if (!checkout) throw new NotFoundException('Checkout not found');

//     if (checkout.status === 'completed')
//       throw new BadRequestException('Checkout already completed');

//     if (checkout.status === 'expired')
//       throw new BadRequestException('Checkout has expired');

//     if (!checkout.shippingOptionId)
//       throw new BadRequestException(
//         'Please add shipping option to checkout first',
//       );

//     if (paymentType === 'cash_on_delivery') {
//       return this.processCOD(userId, checkout);
//     } else {
//       return this.processStripe(userId, checkout);
//     }
//   }

//   private async processCOD(userId: string, checkout: any) {
//     const order = await this.createOrderFromCheckout(
//       userId,
//       checkout,
//       'cash_on_delivery',
//       false,
//     );

//     await this.databaseService.repositories.paymentTransactionModel.create({
//       userId,
//       checkoutId: checkout._id.toString(),
//       orderId: order._id.toString(),
//       paymentType: 'cash_on_delivery',
//       amount: checkout.totalAmount,
//       status: 'completed',
//       paidAt: null,
//     });

//     checkout.status = 'completed';
//     await checkout.save();

//     await this.clearUserCart(userId);

//     return {
//       success: true,
//       message: 'Order placed successfully (Cash on Delivery)',
//       data: { order },
//     };
//   }

//   private async processStripe(userId: string, checkout: any) {
//     const paymentIntent = await this.stripe.paymentIntents.create({
//       amount: Math.round(checkout.totalAmount * 100),
//       currency: 'usd',
//       metadata: {
//         checkoutId: checkout._id.toString(),
//         userId,
//       },
//     });

//     const transaction =
//       await this.databaseService.repositories.paymentTransactionModel.create({
//         userId,
//         checkoutId: checkout._id.toString(),
//         orderId: null,
//         paymentType: 'stripe',
//         amount: checkout.totalAmount,
//         status: 'pending',
//         stripePaymentIntentId: paymentIntent.id,
//         stripeClientSecret: paymentIntent.client_secret,
//       });

//     checkout.status = 'payment_pending';
//     await checkout.save();

//     return {
//       success: true,
//       message: 'Stripe payment initiated',
//       data: {
//         clientSecret: paymentIntent.client_secret,
//         paymentIntentId: paymentIntent.id,
//         transactionId: transaction._id,
//         amount: checkout.totalAmount,
//       },
//     };
//   }

//   async verifyStripePayment(userId: string, body: any) {
//     const { checkoutId, paymentIntentId } = body;

//     if (!checkoutId) throw new BadRequestException('checkoutId is required');
//     if (!paymentIntentId)
//       throw new BadRequestException('paymentIntentId is required');

//     const checkout =
//       await this.databaseService.repositories.checkoutModel.findOne({
//         _id: checkoutId,
//         userId,
//         isDelete: false,
//       });

//     if (!checkout) throw new NotFoundException('Checkout not found');

//     if (checkout.status === 'completed')
//       throw new BadRequestException('Checkout already completed');

//     const transaction =
//       await this.databaseService.repositories.paymentTransactionModel.findOne({
//         checkoutId: checkoutId.toString(),
//         stripePaymentIntentId: paymentIntentId,
//         userId,
//         isDelete: false,
//       });

//     if (!transaction) throw new NotFoundException('Transaction not found');

//     if (transaction.status === 'completed')
//       throw new BadRequestException('Payment already verified');

//     const paymentIntent =
//       await this.stripe.paymentIntents.retrieve(paymentIntentId);

//     if (paymentIntent.status !== 'succeeded') {
//       transaction.status = 'failed';
//       await transaction.save();
//       throw new BadRequestException(
//         `Payment not successful. Stripe status: ${paymentIntent.status}`,
//       );
//     }

//     const order = await this.createOrderFromCheckout(
//       userId,
//       checkout,
//       'stripe',
//       true,
//     );

//     transaction.status = 'completed';
//     transaction.orderId = order._id.toString();
//     transaction.paidAt = new Date();
//     await transaction.save();

//     checkout.status = 'completed';
//     await checkout.save();

//     await this.clearUserCart(userId);

//     return {
//       success: true,
//       message: 'Payment verified and order placed successfully',
//       data: { order, transaction },
//     };
//   }

//   private async createOrderFromCheckout(
//     userId: string,
//     checkout: any,
//     paymentType: string,
//     isPaid: boolean,
//   ) {
//     const address =
//       await this.databaseService.repositories.addressModel.findOne({
//         _id: checkout.addressId,
//         isDelete: false,
//       });

//     if (!address) throw new NotFoundException('Address not found');

//     const orderItems: any[] = [];

//     for (const item of checkout.items) {
//       const product =
//         await this.databaseService.repositories.productModel.findOne({
//           _id: item.productId,
//           isDelete: false,
//         });

//       if (!product)
//         throw new NotFoundException(`Product not found: ${item.productId}`);

//       let image: string | null = null;

//       if (item.variantId) {
//         const variant =
//           await this.databaseService.repositories.productVariantModel.findOne({
//             _id: item.variantId,
//             isDelete: false,
//           });
//         image = variant?.images?.[0] || null;
//       }

//       orderItems.push({
//         productId: item.productId,
//         variantId: item.variantId || null,
//         sellerId: item.sellerId,
//         name: product.name,
//         image,
//         quantity: item.quantity,
//         price: item.price,
//         totalPrice: item.totalPrice,
//       });
//     }

//     const shippingAddress = {
//       recipientName: address.recipientName,
//       phoneNumber: address.phoneNumber,
//       addressLine1: address.addressLine1,
//       addressLine2: address.addressLine2 || null,
//       city: address.city,
//       state: address.state,
//       zipCode: address.zipCode,
//     };

//     const order = await this.databaseService.repositories.orderModel.create({
//       userId,
//       checkoutId: checkout._id.toString(),
//       orderItems,
//       shippingAddress,
//       subtotal: checkout.subtotal,
//       shippingFee: checkout.shippingFee || 0,
//       taxAmount: checkout.taxAmount || 0,
//       totalAmount: checkout.totalAmount,
//       paymentType,
//       paymentStatus: isPaid ? 'paid' : 'unpaid',
//       isPaid,
//       paidAt: isPaid ? new Date() : null,
//       orderStatus: 'pending',
//       isDelivered: false,
//       deliveredAt: null,
//     });

//     return order;
//   }

//   private async clearUserCart(userId: string) {
//     await this.databaseService.repositories.cartModel.findOneAndUpdate(
//       { userId, status: 'active', isDelete: false },
//       { status: 'inactive' },
//     );
//   }
// }

import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'src/database/databaseservice';
import Stripe from 'stripe';

@Injectable()
export class PaymentService {
  private stripe: InstanceType<typeof Stripe>;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim() || '';
    this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
  }

async initiatePayment(userId: string, body: any) {
  const { checkoutId } = body;

  if (!checkoutId) throw new BadRequestException('checkoutId is required');

  const { checkoutModel, paymentTransactionModel } = this.databaseService.repositories;

  const checkout = await checkoutModel.findOne({ _id: checkoutId, userId, isDelete: false });
  if (!checkout) throw new NotFoundException('Checkout not found');
  if (checkout.status === 'completed') throw new BadRequestException('Checkout already completed');
  if (checkout.status === 'cancelled') throw new BadRequestException('Checkout is cancelled');

  // --- ISSUE 5: expiry — status + actual date dono check ---
  if (checkout.status === 'expired') {
    throw new BadRequestException('Checkout has expired');
  }
  if (checkout.expiredAt && checkout.expiredAt < new Date()) {
    // cron ne update nahi kiya to bhi yahin mark kar do (lazy expiry)
    await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'expired' });
    throw new BadRequestException('Checkout has expired');
  }

  // --- ISSUE 1 + 2: duplicate intent guard — pehle se pending transaction hai to reuse ---
  const existing = await paymentTransactionModel.findOne({
    checkoutId: checkout._id.toString(),
    status: 'pending',
    paymentType: 'stripe',
    isDelete: false,
  });

  if (existing && existing.stripePaymentIntentId) {
    try {
      const pi = await this.stripe.paymentIntents.retrieve(existing.stripePaymentIntentId);

      // intent abhi bhi usable hai (succeeded/canceled nahi) + amount same → reuse
      const reusable = ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status);
      const amountMatches = pi.amount === Math.round(checkout.totalAmount * 100);

      if (reusable && amountMatches) {
        return {
          success: true,
          message: 'Payment already initiated',
          data: {
            clientSecret: pi.client_secret,
            paymentIntentId: pi.id,
            amount: checkout.totalAmount,
          },
        };
      }

      // purana intent ab valid nahi (amount badla ya cancel ho gaya) → cancel karke naya banayenge
      if (reusable) {
        await this.stripe.paymentIntents.cancel(pi.id).catch(() => null);
      }
      await paymentTransactionModel.findByIdAndUpdate(existing._id, { status: 'failed' });
    } catch {
      // retrieve fail hua to neeche naya intent ban jaayega
      await paymentTransactionModel.findByIdAndUpdate(existing._id, { status: 'failed' });
    }
  }

  // --- ISSUE 3 + 4: try/catch + idempotency key ---
  let paymentIntent: any;
  try {
    paymentIntent = await this.stripe.paymentIntents.create(
      {
        amount: Math.round(checkout.totalAmount * 100),
        currency: checkout.currency?.toLowerCase() || 'usd',
        metadata: { checkoutId: checkout._id.toString(), userId },
        // redirect-based methods (Klarna/Affirm/CashApp/etc.) off — sirf card
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never',
        },
      },
      {
        // same checkout pe retry pe Stripe duplicate intent nahi banayega
        idempotencyKey: `checkout_${checkout._id.toString()}`,
      },
    );
  } catch (err: any) {
    throw new BadRequestException(
      `Payment initiation failed: ${err?.message || 'Stripe error'}`,
    );
  }

  await paymentTransactionModel.create({
    userId,
    checkoutId: checkout._id.toString(),
    orderId: null,
    paymentType: 'stripe',
    amount: checkout.totalAmount,
    status: 'pending',
    stripePaymentIntentId: paymentIntent.id,
    stripeClientSecret: paymentIntent.client_secret,
  });

  await checkoutModel.findByIdAndUpdate(checkoutId, {
    paymentType: 'stripe',
    status: 'payment_pending',
  });

  return {
    success: true,
    message: 'Payment initiated',
    data: {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: checkout.totalAmount,
    },
  };
}
async stripeWebhook(rawBody: Buffer, signature: string) {
  const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET') || '';

  let event: any;
  try {
    event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch {
    throw new BadRequestException('Invalid Stripe webhook signature');
  }

  if (event.type !== 'payment_intent.succeeded') {
    return { received: true };
  }

  const paymentIntent = event.data.object as any;
  const checkoutId = paymentIntent.metadata?.checkoutId;
  const userId = paymentIntent.metadata?.userId;

  if (!checkoutId || !userId) return { received: true };

  const { checkoutModel, paymentTransactionModel, orderModel, addressModel, cartModel } =
    this.databaseService.repositories;

  // --- ISSUE 3: atomic lock — pending => completed ek hi atomic step me ---
  // agar webhook dobara aaya, doosri baar ye null return karega (kyunki status pending nahi raha)
  const transaction = await paymentTransactionModel.findOneAndUpdate(
    {
      stripePaymentIntentId: paymentIntent.id,
      status: 'pending',
      isDelete: false,
    },
    { status: 'completed', paidAt: new Date() },
    { new: true },
  );

  // null => ya to transaction nahi mila, ya already completed (duplicate webhook) => kuch mat karo
  if (!transaction) return { received: true };

  const checkout = await checkoutModel.findOne({ _id: checkoutId, isDelete: false });
  if (!checkout || checkout.status === 'completed') {
    return { received: true };
  }

  // --- ISSUE 2: order creation try/catch ---
  let order: any;
  try {
    order = await this.createOrder(userId, checkout, orderModel, addressModel);
  } catch (err: any) {
    // lock wapas khol do taaki Stripe ka retry dobara try kar sake
    await paymentTransactionModel.findByIdAndUpdate(transaction._id, {
      status: 'pending',
      paidAt: null,
    });
    console.error('createOrder failed in webhook:', err?.message, { checkoutId, userId });
    // Stripe ko 4xx/5xx do taaki wo retry kare (received:true mat bhejo)
    throw new BadRequestException('Order creation failed, will retry');
  }

  // order ban gaya => transaction me orderId set
  await paymentTransactionModel.findByIdAndUpdate(transaction._id, {
    orderId: order._id.toString(),
  });

  // checkout complete
  await checkoutModel.findByIdAndUpdate(checkoutId, { status: 'completed' });

  // cart clear
  await cartModel.findOneAndUpdate(
    { userId, status: 'active', isDelete: false },
    { status: 'inactive' },
  );

  return { received: true };
}

  private async createOrder(userId: string, checkout: any, orderModel: any, addressModel: any) {
    // items ko storeId ke hisaab se group karo
    const storeMap: Record<string, any[]> = {};

    for (const item of checkout.items) {
      const key = item.storeId || item.sellerId;
      if (!storeMap[key]) storeMap[key] = [];
      storeMap[key].push(item);
    }

    const sellerOrders = Object.entries(storeMap).map(([key, items]) => {
      const hasPhysical = items.some((i) => i.type === 'physical');
      const hasDigital = items.some((i) => i.type === 'digital');
      const fulfillmentType = hasPhysical && hasDigital ? 'mixed' : hasPhysical ? 'physical' : 'digital';
      const subtotal = items.reduce((s, i) => s + i.totalPrice, 0);

      return {
        sellerId: items[0].sellerId,
        storeId: items[0].storeId,
        fulfillmentType,
        items: items.map((i) => ({
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

    // shipping address (sirf physical ho to)
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

    const orderNumber = `ORD-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;

    const order = await orderModel.create({
      orderNumber,
      userId,
      checkoutId: checkout._id.toString(),
      currency: checkout.currency || 'USD',
      sellerOrders,
      shippingAddress,
      subtotal: checkout.subtotal,
      shippingFee: checkout.shippingFee || 0,
      taxAmount: checkout.taxAmount || 0,
      totalAmount: checkout.totalAmount,
      paymentType: 'stripe',
      paymentStatus: 'paid',
      isPaid: true,
      paidAt: new Date(),
      orderStatus: 'pending',
      isDelete: false,
    });

    return order;
  }
}
