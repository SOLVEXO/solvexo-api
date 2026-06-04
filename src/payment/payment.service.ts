import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'src/database/databaseservice';
import Stripe from 'stripe';

@Injectable()
export class PaymentProcessingService {
  private stripe: InstanceType<typeof Stripe>;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly configService: ConfigService,
  ) {
    const secretKey =
      this.configService.get<string>('stripe_Secret_Key')?.trim() || '';
    this.stripe = new Stripe(secretKey, {
      apiVersion: '2025-04-30.basil' as any,
    });
  }

  async selectPayment(userId: string, body: any) {
    const { checkoutId, paymentType } = body;

    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!paymentType) throw new BadRequestException('paymentType is required');
    if (!['cash_on_delivery', 'stripe'].includes(paymentType)) {
      throw new BadRequestException(
        'paymentType must be cash_on_delivery or stripe',
      );
    }

    const checkout =
      await this.databaseService.repositories.checkoutModel.findOne({
        _id: checkoutId,
        userId,
        isDelete: false,
      });

    if (!checkout) throw new NotFoundException('Checkout not found');

    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');

    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');

    if (!checkout.shippingOptionId)
      throw new BadRequestException(
        'Please add shipping option to checkout first',
      );

    if (paymentType === 'cash_on_delivery') {
      return this.processCOD(userId, checkout);
    } else {
      return this.processStripe(userId, checkout);
    }
  }

  private async processCOD(userId: string, checkout: any) {
    const order = await this.createOrderFromCheckout(
      userId,
      checkout,
      'cash_on_delivery',
      false,
    );

    await this.databaseService.repositories.paymentTransactionModel.create({
      userId,
      checkoutId: checkout._id.toString(),
      orderId: order._id.toString(),
      paymentType: 'cash_on_delivery',
      amount: checkout.totalAmount,
      status: 'completed',
      paidAt: null,
    });

    checkout.status = 'completed';
    await checkout.save();

    await this.clearUserCart(userId);

    return {
      success: true,
      message: 'Order placed successfully (Cash on Delivery)',
      data: { order },
    };
  }

  private async processStripe(userId: string, checkout: any) {
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: Math.round(checkout.totalAmount * 100),
      currency: 'usd',
      metadata: {
        checkoutId: checkout._id.toString(),
        userId,
      },
    });

    const transaction =
      await this.databaseService.repositories.paymentTransactionModel.create({
        userId,
        checkoutId: checkout._id.toString(),
        orderId: null,
        paymentType: 'stripe',
        amount: checkout.totalAmount,
        status: 'pending',
        stripePaymentIntentId: paymentIntent.id,
        stripeClientSecret: paymentIntent.client_secret,
      });

    checkout.status = 'payment_pending';
    await checkout.save();

    return {
      success: true,
      message: 'Stripe payment initiated',
      data: {
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        transactionId: transaction._id,
        amount: checkout.totalAmount,
      },
    };
  }

  async verifyStripePayment(userId: string, body: any) {
    const { checkoutId, paymentIntentId } = body;

    if (!checkoutId) throw new BadRequestException('checkoutId is required');
    if (!paymentIntentId)
      throw new BadRequestException('paymentIntentId is required');

    const checkout =
      await this.databaseService.repositories.checkoutModel.findOne({
        _id: checkoutId,
        userId,
        isDelete: false,
      });

    if (!checkout) throw new NotFoundException('Checkout not found');

    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');

    const transaction =
      await this.databaseService.repositories.paymentTransactionModel.findOne({
        checkoutId: checkoutId.toString(),
        stripePaymentIntentId: paymentIntentId,
        userId,
        isDelete: false,
      });

    if (!transaction) throw new NotFoundException('Transaction not found');

    if (transaction.status === 'completed')
      throw new BadRequestException('Payment already verified');

    const paymentIntent =
      await this.stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status !== 'succeeded') {
      transaction.status = 'failed';
      await transaction.save();
      throw new BadRequestException(
        `Payment not successful. Stripe status: ${paymentIntent.status}`,
      );
    }

    const order = await this.createOrderFromCheckout(
      userId,
      checkout,
      'stripe',
      true,
    );

    transaction.status = 'completed';
    transaction.orderId = order._id.toString();
    transaction.paidAt = new Date();
    await transaction.save();

    checkout.status = 'completed';
    await checkout.save();

    await this.clearUserCart(userId);

    return {
      success: true,
      message: 'Payment verified and order placed successfully',
      data: { order, transaction },
    };
  }

  private async createOrderFromCheckout(
    userId: string,
    checkout: any,
    paymentType: string,
    isPaid: boolean,
  ) {
    const address =
      await this.databaseService.repositories.addressModel.findOne({
        _id: checkout.addressId,
        isDelete: false,
      });

    if (!address) throw new NotFoundException('Address not found');

    const orderItems: any[] = [];

    for (const item of checkout.items) {
      const product =
        await this.databaseService.repositories.productModel.findOne({
          _id: item.productId,
          isDelete: false,
        });

      if (!product)
        throw new NotFoundException(`Product not found: ${item.productId}`);

      let image: string | null = null;

      if (item.variantId) {
        const variant =
          await this.databaseService.repositories.productVariantModel.findOne({
            _id: item.variantId,
            isDelete: false,
          });
        image = variant?.images?.[0] || null;
      }

      orderItems.push({
        productId: item.productId,
        variantId: item.variantId || null,
        sellerId: item.sellerId,
        name: product.name,
        image,
        quantity: item.quantity,
        price: item.price,
        totalPrice: item.totalPrice,
      });
    }

    const shippingAddress = {
      recipientName: address.recipientName,
      phoneNumber: address.phoneNumber,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2 || null,
      city: address.city,
      state: address.state,
      zipCode: address.zipCode,
    };

    const order = await this.databaseService.repositories.orderModel.create({
      userId,
      checkoutId: checkout._id.toString(),
      orderItems,
      shippingAddress,
      subtotal: checkout.subtotal,
      shippingFee: checkout.shippingFee || 0,
      taxAmount: checkout.taxAmount || 0,
      totalAmount: checkout.totalAmount,
      paymentType,
      paymentStatus: isPaid ? 'paid' : 'unpaid',
      isPaid,
      paidAt: isPaid ? new Date() : null,
      orderStatus: 'pending',
      isDelivered: false,
      deliveredAt: null,
    });

    return order;
  }

  private async clearUserCart(userId: string) {
    await this.databaseService.repositories.cartModel.findOneAndUpdate(
      { userId, status: 'active', isDelete: false },
      { status: 'inactive' },
    );
  }
}
