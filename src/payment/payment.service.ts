import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from 'src/database/databaseservice';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { PromotionsService } from 'src/promotions/promotions.service';
import { FinanceService } from 'src/finance/finance.service';
import { AdminConfigService } from 'src/admin-config/admin-config.service';
import Stripe from 'stripe';

@Injectable()
export class PaymentService {
  private stripe: InstanceType<typeof Stripe> | undefined;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
    private readonly promotionsService: PromotionsService,
    private readonly financeService: FinanceService,
    private readonly adminConfigService: AdminConfigService,
  ) {
    const secretKey = this.configService
      .get<string>('STRIPE_SECRET_KEY')
      ?.trim();
    if (secretKey) {
      this.stripe = new Stripe(secretKey, {
        apiVersion: '2025-04-30.basil' as any,
      });
    } else {
      // Matches the pattern in subscriptions/payment-gateway — degrade
      // gracefully rather than crash the whole app when the key hasn't
      // been provisioned yet. Cash on Delivery keeps working regardless.
      console.warn(
        '[PaymentService] STRIPE_SECRET_KEY not set — online card payments are disabled. Cash on Delivery still works.',
      );
    }
  }

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  private assertStripeConfigured(): InstanceType<typeof Stripe> {
    if (!this.stripe) {
      throw new BadRequestException(
        'Online payments are not configured yet. Please use Cash on Delivery.',
      );
    }
    return this.stripe;
  }

  /** Creates (or reuses) a Stripe PaymentIntent for a checkout and returns
   *  the client secret the app needs to present Stripe's PaymentSheet. */
  async initiatePayment(userId: string, body: any) {
    const stripe = this.assertStripeConfigured();

    // For a mixed (digital + physical) cart the buyer can choose either
    // 'full' (pay the whole checkout online, no COD) or 'split' (digital
    // online now, physical COD on delivery) — defaults to 'full' so a
    // non-mixed cart's single "Pay Online" button needs no changes.
    const { checkoutId, paymentMode } = body;
    if (!checkoutId) throw new BadRequestException('checkoutId is required');

    const { checkoutModel, paymentTransactionModel, productVariantModel } =
      this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'cancelled')
      throw new BadRequestException('Checkout is cancelled');
    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, {
        status: 'expired',
      });
      throw new BadRequestException('Checkout has expired');
    }

    const physicalItems = checkout.items.filter(
      (i: any) => i.type === 'physical',
    );
    for (const item of physicalItems) {
      const variant = await productVariantModel.findOne({
        _id: item.variantId,
        isDelete: false,
      });
      if (!variant)
        throw new BadRequestException(`Item not available: ${item.name}`);
      if (!variant.unlimitedStock && variant.stock < item.quantity) {
        throw new BadRequestException(`Insufficient stock for ${item.name}`);
      }
    }

    // A mixed cart (physical + digital together) charges only the
    // digital-items subtotal online when the buyer picked 'split' — the
    // physical portion is then settled via COD once this payment succeeds
    // (see `createOrder`/`finalizePaymentIntent`). Picking 'full' (or a
    // non-mixed cart, where this flag is meaningless) charges everything.
    const digitalItems = checkout.items.filter((i: any) => i.type === 'digital');
    const isMixed = physicalItems.length > 0 && digitalItems.length > 0;
    const useSplit = isMixed && paymentMode === 'split';

    // 'split' settles its physical portion via COD on delivery — same
    // per-seller opt-out check as plain COD (codPayment, above). Checkout
    // creation already hides 'split' as an option when this would fail, but
    // this endpoint doesn't trust that client-side state alone.
    if (useSplit) {
      const physicalStoreIds = [...new Set(physicalItems.map((i: any) => i.storeId))];
      const codDisabledStores = await this.databaseService.repositories.storeModel
        .find({ _id: { $in: physicalStoreIds }, codEnabled: false })
        .select('name')
        .lean();
      if (codDisabledStores.length > 0) {
        throw new BadRequestException(
          `Cash on Delivery isn't available for: ${codDisabledStores.map((s: any) => s.name).join(', ')} — please pay the full amount online instead.`,
        );
      }
    }
    const chargeAmount = useSplit
      ? this.round(digitalItems.reduce((s: number, i: any) => s + i.totalPrice, 0))
      : checkout.totalAmount;
    const paymentScope = useSplit ? 'digital_only' : 'full';

    const amountCents = Math.round(chargeAmount * 100);

    // Idempotency key includes the amount so a retry with the SAME total
    // safely dedupes (no duplicate PaymentIntents on a double-tap/network
    // retry), while a genuinely different total (e.g. shipping changed
    // after a first attempt was abandoned) gets a fresh key instead of
    // colliding with Stripe's idempotency cache of the old request.
    const idempotencyKey = `checkout_${checkout._id.toString()}_${amountCents}`;

    const existing = await paymentTransactionModel.findOne({
      checkoutId: checkout._id.toString(),
      status: 'pending',
      paymentType: 'stripe',
      isDelete: false,
    });

    if (existing?.stripePaymentIntentId) {
      try {
        const pi = await stripe.paymentIntents.retrieve(
          existing.stripePaymentIntentId,
        );
        const reusable = [
          'requires_payment_method',
          'requires_confirmation',
          'requires_action',
        ].includes(pi.status);
        const amountMatches = pi.amount === amountCents;
        if (reusable && amountMatches) {
          return {
            success: true,
            message: 'Payment already initiated',
            data: {
              clientSecret: pi.client_secret,
              paymentIntentId: pi.id,
              amount: chargeAmount,
              currency: checkout.currency,
            },
          };
        }
        if (reusable)
          await stripe.paymentIntents.cancel(pi.id).catch(() => null);
        await paymentTransactionModel.findByIdAndUpdate(existing._id, {
          status: 'failed',
        });
      } catch {
        await paymentTransactionModel.findByIdAndUpdate(existing._id, {
          status: 'failed',
        });
      }
    }

    let paymentIntent: any;
    try {
      paymentIntent = await stripe.paymentIntents.create(
        {
          amount: amountCents,
          currency: checkout.currency?.toLowerCase() || 'usd',
          metadata: { checkoutId: checkout._id.toString(), userId },
          automatic_payment_methods: {
            enabled: true,
            allow_redirects: 'never',
          },
        },
        { idempotencyKey },
      );
    } catch (err: any) {
      throw new BadRequestException(
        `Payment initiation failed: ${err?.message || 'Stripe error'}`,
      );
    }

    await paymentTransactionModel.create({
      userId,
      checkoutId: checkout._id.toString(),
      paymentType: 'stripe',
      amount: chargeAmount,
      paymentScope,
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
        amount: chargeAmount,
        currency: checkout.currency,
      },
    };
  }

  /** Verifies the Stripe signature and finalizes the order on
   *  `payment_intent.succeeded`. This is the source of truth for turning a
   *  paid PaymentIntent into real order(s) — `getPaymentStatus` below can
   *  also trigger the same finalize path as a client-polling fallback in
   *  case the webhook is delayed or (in local dev, without a public URL)
   *  never arrives at all. */
  async stripeWebhook(rawBody: Buffer, signature: string) {
    const stripe = this.assertStripeConfigured();
    const webhookSecret =
      this.configService.get<string>('STRIPE_WEBHOOK_SECRET_TEST') || '';

    let event: any;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      throw new BadRequestException('Invalid Stripe webhook signature');
    }

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object;
      await this.finalizePaymentIntent(paymentIntent.id).catch((err: any) => {
        console.error('Webhook finalize failed:', err?.message, {
          paymentIntentId: paymentIntent.id,
        });
      });
    } else if (event.type === 'payment_intent.payment_failed') {
      const paymentIntent = event.data.object;
      await this.databaseService.repositories.paymentTransactionModel.findOneAndUpdate(
        {
          stripePaymentIntentId: paymentIntent.id,
          status: 'pending',
          isDelete: false,
        },
        { status: 'failed' },
      );
    } else if (event.type === 'charge.refunded') {
      const charge = event.data.object;
      await this.handleChargeRefunded(charge).catch((err: any) => {
        console.error('Refund webhook handling failed:', err?.message, { chargeId: charge.id });
      });
    } else if (event.type === 'charge.dispute.created') {
      const dispute = event.data.object;
      await this.handleChargeDispute(dispute).catch((err: any) => {
        console.error('Dispute webhook handling failed:', err?.message, { disputeId: dispute.id });
      });
    }

    return { received: true };
  }

  /**
   * `charge.refunded` fires on every refund against a charge, with
   * `amount_refunded` always being the CUMULATIVE total refunded so far —
   * tracking `PaymentTransaction.amountRefunded` and only reversing the NEW
   * delta makes this safe against both partial refunds and a redelivered
   * webhook for the same event. Reverses each affected seller's ledger
   * proportional to their sellerOrder's share of the whole charge — the
   * platform's commission on that share is not clawed back (same policy as
   * `FinanceService.recordRefund` everywhere else).
   */
  private async handleChargeRefunded(charge: any) {
    const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    if (!paymentIntentId) return;

    const { paymentTransactionModel } = this.databaseService.repositories;
    const transaction = await paymentTransactionModel.findOne({
      stripePaymentIntentId: paymentIntentId, status: 'completed', isDelete: false,
    });
    if (!transaction || transaction.orderIds.length === 0) return;

    const totalRefundedSoFar = this.round((charge.amount_refunded ?? 0) / 100);
    const previouslyRefunded = transaction.amountRefunded ?? 0;
    const newRefundDelta = this.round(totalRefundedSoFar - previouslyRefunded);
    if (newRefundDelta <= 0) return; // already processed — replayed webhook or no new refund since last event

    await paymentTransactionModel.findByIdAndUpdate(transaction._id, { amountRefunded: totalRefundedSoFar });
    await this.reverseSellerLedgerForOrders(transaction.orderIds, newRefundDelta, 'Stripe refund');
  }

  /**
   * `charge.dispute.created` — a buyer-initiated chargeback. `dispute.amount`
   * is the disputed amount (not cumulative); `disputedChargeIds` on the
   * transaction guards against the same dispute event being redelivered.
   * Same proportional-reversal logic as refunds — see `recordRefund`'s
   * negative-balance/debt handling for what happens if the seller already
   * withdrew the funds being clawed back.
   */
  private async handleChargeDispute(dispute: any) {
    const paymentIntentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
    if (!paymentIntentId) return;

    const { paymentTransactionModel } = this.databaseService.repositories;
    const transaction = await paymentTransactionModel.findOne({
      stripePaymentIntentId: paymentIntentId, status: 'completed', isDelete: false,
    });
    if (!transaction || transaction.orderIds.length === 0) return;
    if ((transaction.disputedChargeIds ?? []).includes(dispute.id)) return;

    const disputeAmount = this.round((dispute.amount ?? 0) / 100);
    if (disputeAmount <= 0) return;

    await paymentTransactionModel.findByIdAndUpdate(transaction._id, { $addToSet: { disputedChargeIds: dispute.id } });
    await this.reverseSellerLedgerForOrders(transaction.orderIds, disputeAmount, 'Stripe dispute/chargeback');
  }

  /** Distributes a charge-level refund/dispute amount across every affected sellerOrder, proportional to its share of the orders' combined total. */
  private async reverseSellerLedgerForOrders(orderIds: string[], refundAmountTotal: number, reason: string) {
    const { orderModel } = this.databaseService.repositories;
    const orders = await orderModel.find({ _id: { $in: orderIds }, isDelete: false }).lean();
    if (orders.length === 0) return;

    const grandTotal = (orders as any[]).reduce((s: number, o: any) => s + o.totalAmount, 0);
    if (grandTotal <= 0) return;

    for (const order of orders as any[]) {
      for (const so of order.sellerOrders) {
        const share = this.round((so.subtotal / grandTotal) * refundAmountTotal);
        if (share <= 0) continue;
        try {
          await this.financeService.recordRefund(
            so.storeId, so.sellerId, order._id.toString(), share,
            'system', 'system',
            { description: `${reason} — Order #${order._id}`, targetType: 'order' },
          );
        } catch (err: any) {
          console.error(`${reason} ledger reversal failed:`, err?.message, { orderId: order._id, storeId: so.storeId });
        }
      }
    }
  }

  /** Turns a succeeded PaymentIntent into real order(s), idempotently.
   *  Shared by the webhook handler and `getPaymentStatus`'s polling
   *  fallback — the `findOneAndUpdate({status:'pending'})` guard means
   *  whichever caller gets there first wins; the other sees no matching
   *  document and just returns the already-finalized order ids. */
  /** Fetches order docs by id and shapes them the same way COD orders are
   *  shaped (`formatOrder`) — the frontend's order-success screen renders
   *  Stripe and COD orders identically, so both paths must hand it the same shape. */
  private async formatOrdersByIds(orderIds: string[]) {
    if (!orderIds.length) return [];
    const { orderModel } = this.databaseService.repositories;
    const orders = await orderModel
      .find({ _id: { $in: orderIds }, isDelete: false })
      .lean();
    return orders.map((o: any) => this.formatOrder(o));
  }

  private async finalizePaymentIntent(
    paymentIntentId: string,
  ): Promise<{ orderIds: string[] } | null> {
    const {
      checkoutModel,
      paymentTransactionModel,
      orderModel,
      addressModel,
      cartModel,
    } = this.databaseService.repositories;

    const transaction = await paymentTransactionModel.findOneAndUpdate(
      {
        stripePaymentIntentId: paymentIntentId,
        status: 'pending',
        isDelete: false,
      },
      { status: 'completed', paidAt: new Date() },
      { new: true },
    );

    if (!transaction) {
      const existing = await paymentTransactionModel.findOne({
        stripePaymentIntentId: paymentIntentId,
        isDelete: false,
      });
      return existing?.status === 'completed'
        ? { orderIds: existing.orderIds }
        : null;
    }

    const checkout = await checkoutModel.findOne({
      _id: transaction.checkoutId,
      isDelete: false,
    });
    if (!checkout || checkout.status === 'completed') {
      return { orderIds: transaction.orderIds };
    }

    // A 'digital_only' transaction means this Stripe charge only covered the
    // digital items of a mixed cart — the physical items are unpaid/COD,
    // collected by the courier on delivery. Everything else (full-checkout
    // Stripe payments, digital-only carts) pays 'stripe'/paid on both sides.
    const digitalPayment = { paymentType: 'stripe', isPaid: true };
    const physicalPayment = transaction.paymentScope === 'digital_only'
      ? { paymentType: 'cash_on_delivery', isPaid: false }
      : { paymentType: 'stripe', isPaid: true };

    let orders: any[];
    try {
      orders = await this.createOrder(transaction.userId, checkout, orderModel, addressModel, physicalPayment, digitalPayment);
    } catch (err: any) {
      await paymentTransactionModel.findByIdAndUpdate(transaction._id, {
        status: 'pending',
        paidAt: null,
      });
      console.error(
        'createOrder failed while finalizing payment:',
        err?.message,
        {
          checkoutId: checkout._id,
          paymentIntentId,
        },
      );
      throw new BadRequestException('Order creation failed, will retry');
    }

    await paymentTransactionModel.findByIdAndUpdate(transaction._id, {
      orderIds: orders.map((o: any) => o._id.toString()),
    });
    await checkoutModel.findByIdAndUpdate(checkout._id, {
      status: 'completed',
    });
    await this.removeCheckedOutItemsFromCart(
      transaction.userId,
      checkout,
      cartModel,
    );

    // Seller notifications are already sent inside `createOrder()` above —
    // no need to duplicate that here.
    return { orderIds: orders.map((o: any) => o._id.toString()) };
  }

  /** Lets the app poll after `stripe.confirmPayment()` resolves client-side,
   *  since webhook delivery timing can't be relied on (and won't reach
   *  `localhost` in local dev without a tunnel/Stripe CLI at all). Actively
   *  re-checks Stripe if the webhook hasn't landed yet. Returns the same
   *  `orders` shape as `codPayment` so the order-success screen doesn't need
   *  a separate code path per payment method. */
  async getPaymentStatus(userId: string, checkoutId: string) {
    if (!checkoutId) throw new BadRequestException('checkoutId is required');

    const { checkoutModel, paymentTransactionModel } =
      this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');

    if (checkout.status === 'completed') {
      const transaction = await paymentTransactionModel.findOne({
        checkoutId,
        status: 'completed',
        isDelete: false,
      });
      const orders = await this.formatOrdersByIds(transaction?.orderIds ?? []);
      return { success: true, data: { status: 'completed', orders } };
    }

    const pending = await paymentTransactionModel.findOne({
      checkoutId,
      status: 'pending',
      paymentType: 'stripe',
      isDelete: false,
    });

    if (this.stripe && pending?.stripePaymentIntentId) {
      try {
        const pi = await this.stripe.paymentIntents.retrieve(
          pending.stripePaymentIntentId,
        );
        if (pi.status === 'succeeded') {
          const result = await this.finalizePaymentIntent(pi.id);
          const orders = await this.formatOrdersByIds(result?.orderIds ?? []);
          return { success: true, data: { status: 'completed', orders } };
        }
        if (pi.status === 'canceled') {
          return { success: true, data: { status: 'failed', orders: [] } };
        }
      } catch (err: any) {
        console.error('getPaymentStatus Stripe retrieve failed:', err?.message);
      }
    }

    return { success: true, data: { status: 'pending', orders: [] } };
  }

  // Remove ONLY the lines that were part of this checkout — a checkout created
  // from selected cart items must leave the unselected lines in the cart.
  private async removeCheckedOutItemsFromCart(
    userId: string,
    checkout: any,
    cartModel: any,
  ) {
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

    const {
      checkoutModel,
      paymentTransactionModel,
      orderModel,
      addressModel,
      productVariantModel,
      cartModel,
    } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'cancelled')
      throw new BadRequestException('Checkout is cancelled');
    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, {
        status: 'expired',
      });
      throw new BadRequestException('Checkout has expired');
    }

    const hasDigital = checkout.items.some((i: any) => i.type === 'digital');
    if (hasDigital)
      throw new BadRequestException(
        'Cash on Delivery is not available for digital products',
      );

    // Per-seller opt-out — a store can disable COD on its own listings.
    // No platform-wide order-value ceiling — COD is available for any amount.
    const storeIds = [...new Set(checkout.items.map((i: any) => i.storeId))];
    const codDisabledStores = await this.databaseService.repositories.storeModel
      .find({ _id: { $in: storeIds }, codEnabled: false })
      .select('name')
      .lean();
    if (codDisabledStores.length > 0) {
      throw new BadRequestException(
        `Cash on Delivery isn't available for: ${codDisabledStores.map((s: any) => s.name).join(', ')} — please pay online, or remove those items from your cart.`,
      );
    }

    for (const item of checkout.items) {
      const variant = await productVariantModel.findOne({
        _id: item.variantId,
        isDelete: false,
      });
      if (!variant)
        throw new BadRequestException(`Item not available: ${item.name}`);
      if (!variant.unlimitedStock && variant.stock < item.quantity) {
        throw new BadRequestException(
          `Insufficient stock for ${item.name}. Available: ${variant.stock}, required: ${item.quantity}`,
        );
      }
    }

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      paymentType: 'cash_on_delivery',
      status: 'payment_pending',
    });

    const codPaymentInfo = { paymentType: 'cash_on_delivery', isPaid: false };
    const orders = await this.createOrder(userId, checkout, orderModel, addressModel, codPaymentInfo, codPaymentInfo);

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

  /**
   * The Pakistan "pay into the platform's own bank account" track — same
   * "place the order now, settle payment status later" shape as COD, except
   * the buyer has already sent money (just not yet admin-confirmed) rather
   * than paying on delivery. Called by ManualPaymentsService once it has a
   * proof image ready to attach; order creation itself lives here so all
   * three payment paths (Stripe, COD, manual-transfer) share one
   * `createOrder` implementation. Digital items ARE allowed (unlike COD) —
   * this is a Stripe-equivalent alternative, not a delivery-time settlement.
   */
  async manualBankTransferPayment(userId: string, checkoutId: string) {
    if (!checkoutId) throw new BadRequestException('checkoutId is required');

    const manualConfig = await this.adminConfigService.getManualPaymentConfig();
    if (!manualConfig?.enabled) {
      throw new BadRequestException('Bank transfer payment is not available right now — please use another payment method.');
    }

    const {
      checkoutModel,
      paymentTransactionModel,
      orderModel,
      addressModel,
      productVariantModel,
      cartModel,
    } = this.databaseService.repositories;

    const checkout = await checkoutModel.findOne({
      _id: checkoutId,
      userId,
      isDelete: false,
    });
    if (!checkout) throw new NotFoundException('Checkout not found');
    if (checkout.status === 'completed')
      throw new BadRequestException('Checkout already completed');
    if (checkout.status === 'cancelled')
      throw new BadRequestException('Checkout is cancelled');
    if (checkout.status === 'expired')
      throw new BadRequestException('Checkout has expired');
    if (checkout.expiredAt && checkout.expiredAt < new Date()) {
      await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'expired' });
      throw new BadRequestException('Checkout has expired');
    }

    for (const item of checkout.items) {
      if (item.type !== 'physical') continue;
      const variant = await productVariantModel.findOne({ _id: item.variantId, isDelete: false });
      if (!variant) throw new BadRequestException(`Item not available: ${item.name}`);
      if (!variant.unlimitedStock && variant.stock < item.quantity) {
        throw new BadRequestException(`Insufficient stock for ${item.name}. Available: ${variant.stock}, required: ${item.quantity}`);
      }
    }

    const fxRate = manualConfig.usdToPkrRate;
    const amountUSD = checkout.totalAmount;
    const amountPKR = this.round(amountUSD * fxRate);

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      paymentType: 'manual_bank_transfer',
      status: 'payment_pending',
    });

    const pendingVerificationInfo = { paymentType: 'manual_bank_transfer', isPaid: false, paymentStatus: 'pending_verification' };
    const orders = await this.createOrder(
      userId, checkout, orderModel, addressModel,
      pendingVerificationInfo, pendingVerificationInfo,
      { code: 'PKR', rate: fxRate },
    );

    await paymentTransactionModel.create({
      userId,
      checkoutId: checkout._id.toString(),
      orderIds: orders.map((o: any) => o._id.toString()),
      paymentType: 'manual_bank_transfer',
      amount: amountPKR,
      currency: 'PKR',
      status: 'pending', // flips to 'completed' only once an admin approves the proof
      stripePaymentIntentId: null,
      stripeClientSecret: null,
      paidAt: null,
    });

    await checkoutModel.findByIdAndUpdate(checkoutId, { status: 'completed' });
    await this.removeCheckedOutItemsFromCart(userId, checkout, cartModel);

    return { orders, amountUSD, amountPKR, fxRate };
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
        productType: item.productType ?? null,
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
    physicalPayment: { paymentType: string; isPaid: boolean; paymentStatus?: string } = { paymentType: 'stripe', isPaid: true },
    digitalPayment: { paymentType: string; isPaid: boolean; paymentStatus?: string } = { paymentType: 'stripe', isPaid: true },
    // Set only for the Pakistan manual-bank-transfer track — every USD figure
    // computed below (subtotal, fees, item prices, discounts) is converted to
    // the buyer-facing currency at `rate` before being stored, so the placed
    // Order (and everything downstream: seller ledger via FinanceService,
    // buyer/seller-facing order screens) is genuinely denominated in that
    // currency rather than just USD with a side-note. Omitted (rate 1, same
    // `checkout.currency`) for Stripe/COD, which stay USD exactly as before.
    currencyConversion?: { code: string; rate: number },
  ) {
    const { productVariantModel, productModel } =
      this.databaseService.repositories;

    // Guards a webhook/poll retry (e.g. after a crash between creating the
    // physical and digital order below) from creating duplicate orders —
    // `finalizePaymentIntent`'s own transaction-status flip already prevents
    // most double-invocations, but this is a cheap second line of defense
    // directly at the point where orders get created.
    const alreadyCreated = await orderModel.find({ checkoutId: checkout._id.toString(), isDelete: false });
    if (alreadyCreated.length > 0) return alreadyCreated;

    const physicalItems = checkout.items.filter((i: any) => i.type === 'physical');
    const digitalItems = checkout.items.filter((i: any) => i.type === 'digital');

    const fxRate = currencyConversion?.rate ?? 1;
    const orderCurrency = currencyConversion?.code ?? (checkout.currency || 'USD');
    const conv = (n: number | null | undefined) => (n == null ? n : this.round(n * fxRate));

    // --- STOCK MINUS (atomic, sirf physical, unlimited variants skip decrement) ---
    const decremented: { variantId: string; quantity: number }[] = [];

    for (const item of physicalItems) {
      const variant = await productVariantModel
        .findOne({ _id: item.variantId, isDelete: false })
        .select('unlimitedStock')
        .lean();
      if (!variant || (variant as any).unlimitedStock) continue;

      const res = await productVariantModel.updateOne(
        {
          _id: item.variantId,
          stock: { $gte: item.quantity },
          isDelete: false,
        },
        { $inc: { stock: -item.quantity } },
      );

      if (res.modifiedCount === 0) {
        for (const d of decremented) {
          await productVariantModel.updateOne(
            { _id: d.variantId },
            { $inc: { stock: d.quantity } },
          );
        }
        throw new BadRequestException(
          `Stock not available for item: ${item.name}`,
        );
      }
      decremented.push({ variantId: item.variantId, quantity: item.quantity });
    }

    // --- shipping address (physical ke liye) ---
    let shippingAddress: any = null;
    if (checkout.addressId) {
      const address = await addressModel.findOne({
        _id: checkout.addressId,
        isDelete: false,
      });
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
        // Only items whose campaign is platform-sponsored count toward this
        // restoring this seller's payout — see FinanceService.recordSale.
        const platformSponsoredDiscountUSD = storeItems.reduce(
          (s, i) =>
            s +
            (i.campaignSponsorType === 'platform'
              ? (i.campaignDiscountUSD ?? 0)
              : 0),
          0,
        );
        return {
          sellerId: storeItems[0].sellerId,
          storeId: storeItems[0].storeId,
          fulfillmentType: storeItems[0].type, // 'physical' ya 'digital'
          items: storeItems.map((i) => ({
            productId: i.productId,
            variantId: i.variantId,
            type: i.type,
            productType: i.productType ?? null,
            name: i.name,
            image: i.image ?? null,
            sku: i.sku ?? null,
            options: i.options ?? [],
            licenseType: i.licenseType ?? null,
            quantity: i.quantity,
            price: conv(i.price),
            totalPrice: conv(i.totalPrice),
            originalPrice: conv(i.originalPrice ?? null),
            subscriberDiscountUSD: conv(i.subscriberDiscountUSD ?? 0),
            couponDiscountUSD: conv(i.couponDiscountUSD ?? 0),
            campaignId: i.campaignId ?? null,
            campaignDiscountUSD: conv(i.campaignDiscountUSD ?? 0),
            campaignSponsorType: i.campaignSponsorType ?? null,
            status: 'pending',
          })),
          subtotal: conv(subtotal),
          platformSponsoredDiscountUSD: conv(platformSponsoredDiscountUSD),
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

    // Coupon discount was already distributed per-item at checkout time
    // (CheckoutService.distributeCouponDiscount mutates item.totalPrice
    // directly) — so each group's `subtotal` below is already net of the
    // discount; we just sum item.couponDiscountUSD for receipt/analytics display.

    // === PHYSICAL ORDER ===
    if (physicalItems.length > 0) {
      const sellerOrders = buildSellerOrders(physicalItems);
      const subtotal = physicalItems.reduce(
        (s: number, i: any) => s + i.totalPrice,
        0,
      );
      const shippingFee = checkout.shippingFee || 0;
      const subscriberDiscountTotal = physicalItems.reduce(
        (s: number, i: any) => s + (i.subscriberDiscountUSD ?? 0),
        0,
      );
      const couponDiscountTotal = physicalItems.reduce(
        (s: number, i: any) => s + (i.couponDiscountUSD ?? 0),
        0,
      );
      const campaignDiscountTotal = physicalItems.reduce(
        (s: number, i: any) => s + (i.campaignDiscountUSD ?? 0),
        0,
      );
      const platformSponsoredDiscountTotal = physicalItems.reduce(
        (s: number, i: any) =>
          s +
          (i.campaignSponsorType === 'platform'
            ? (i.campaignDiscountUSD ?? 0)
            : 0),
        0,
      );

      const physicalOrder = await orderModel.create({
        orderNumber: genOrderNumber(),
        userId,
        checkoutId: checkout._id.toString(),
        currency: orderCurrency,
        sellerOrders,
        shippingAddress,
        subtotal: conv(subtotal),
        shippingFee: conv(shippingFee),
        taxAmount: 0,
        subscriberDiscountTotal: conv(subscriberDiscountTotal),
        couponCode: couponDiscountTotal > 0 ? checkout.couponCode : null,
        couponDiscountTotal: conv(couponDiscountTotal),
        campaignDiscountTotal: conv(campaignDiscountTotal),
        platformSponsoredDiscountTotal: conv(platformSponsoredDiscountTotal),
        totalAmount: this.round((subtotal + shippingFee) * fxRate),
        paymentType: physicalPayment.paymentType,
        paymentStatus: physicalPayment.paymentStatus ?? (physicalPayment.isPaid ? 'paid' : 'unpaid'),
        isPaid: physicalPayment.isPaid,
        paidAt: physicalPayment.isPaid ? new Date() : null,
        orderStatus: 'pending',
        attributionSource: checkout.attributionSource ?? 'other',
        attributedBannerId: checkout.attributedBannerId ?? null,
        attributedStoreBannerId: checkout.attributedStoreBannerId ?? null,
        isDelete: false,
      });
      createdOrders.push(physicalOrder);
    }

    // === DIGITAL ORDER ===
    if (digitalItems.length > 0) {
      const sellerOrders = buildSellerOrders(digitalItems);
      const subtotal = digitalItems.reduce(
        (s: number, i: any) => s + i.totalPrice,
        0,
      );
      const subscriberDiscountTotal = digitalItems.reduce(
        (s: number, i: any) => s + (i.subscriberDiscountUSD ?? 0),
        0,
      );
      const couponDiscountTotal = digitalItems.reduce(
        (s: number, i: any) => s + (i.couponDiscountUSD ?? 0),
        0,
      );
      const campaignDiscountTotal = digitalItems.reduce(
        (s: number, i: any) => s + (i.campaignDiscountUSD ?? 0),
        0,
      );
      const platformSponsoredDiscountTotal = digitalItems.reduce(
        (s: number, i: any) =>
          s +
          (i.campaignSponsorType === 'platform'
            ? (i.campaignDiscountUSD ?? 0)
            : 0),
        0,
      );

      const digitalOrder = await orderModel.create({
        orderNumber: genOrderNumber(),
        userId,
        checkoutId: checkout._id.toString(),
        currency: orderCurrency,
        sellerOrders,
        shippingAddress: null,
        subtotal: conv(subtotal),
        shippingFee: 0,
        taxAmount: 0,
        subscriberDiscountTotal: conv(subscriberDiscountTotal),
        couponCode: couponDiscountTotal > 0 ? checkout.couponCode : null,
        couponDiscountTotal: conv(couponDiscountTotal),
        campaignDiscountTotal: conv(campaignDiscountTotal),
        platformSponsoredDiscountTotal: conv(platformSponsoredDiscountTotal),
        totalAmount: this.round(subtotal * fxRate),
        paymentType: digitalPayment.paymentType,
        paymentStatus: digitalPayment.paymentStatus ?? (digitalPayment.isPaid ? 'paid' : 'unpaid'),
        isPaid: digitalPayment.isPaid,
        paidAt: digitalPayment.isPaid ? new Date() : null,
        orderStatus: 'pending',
        attributionSource: checkout.attributionSource ?? 'other',
        attributedBannerId: checkout.attributedBannerId ?? null,
        attributedStoreBannerId: checkout.attributedStoreBannerId ?? null,
        isDelete: false,
      });
      createdOrders.push(digitalOrder);
    }

    if (checkout.attributedBannerId || checkout.attributedStoreBannerId) {
      // A checkout could in principle carry both (unlikely, but not
      // contradictory) — record a conversion row for whichever ids are set,
      // each attributed to the Banner/StoreBanner the buyer actually clicked
      // (never a PromotionRequest id directly; see the schema comment).
      const conversions = createdOrders.flatMap((o: any) => {
        const rows: { entityType: 'banner' | 'store_banner'; entityId: string; orderId: string; revenue: number }[] = [];
        if (checkout.attributedBannerId) rows.push({ entityType: 'banner', entityId: checkout.attributedBannerId, orderId: o._id.toString(), revenue: o.totalAmount });
        if (checkout.attributedStoreBannerId) rows.push({ entityType: 'store_banner', entityId: checkout.attributedStoreBannerId, orderId: o._id.toString(), revenue: o.totalAmount });
        return rows;
      });
      this.promotionsService.recordConversions(conversions).catch(() => {});
    }

    // purchaseCount increment — har item ke product pe
    for (const item of checkout.items) {
      await productModel.findByIdAndUpdate(item.productId, {
        $inc: { purchaseCount: item.quantity },
      });
    }

    // Coupon usage is only counted once the order is actually placed (not
    // at apply-coupon time) — an abandoned/expired checkout must not
    // consume a limited-use coupon.
    if (checkout.couponCode && checkout.couponStoreId) {
      await this.databaseService.repositories.couponModel.updateOne(
        { storeId: checkout.couponStoreId, code: checkout.couponCode },
        { $inc: { usageCount: 1 } },
      );
    }

    const notifiedSellers = new Set<string>();
    for (const createdOrder of createdOrders) {
      for (const so of createdOrder.sellerOrders) {
        if (notifiedSellers.has(`${createdOrder._id}:${so.sellerId}`)) continue;
        notifiedSellers.add(`${createdOrder._id}:${so.sellerId}`);
        this.notificationsService
          .notify({
            recipientId: so.sellerId,
            recipientRole: 'seller',
            type: NOTIFICATION_TYPES.ORDER_PLACED,
            title: 'New order received',
            body: `You have a new order #${createdOrder.orderNumber} for ${so.items.length} item(s).`,
            data: { orderId: createdOrder._id.toString() },
          })
          .catch(() => {});
      }
    }

    return createdOrders;
  }
}
