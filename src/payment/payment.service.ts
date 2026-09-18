import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/database/databaseservice';
import { NotificationsService } from '@/notifications/notifications.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';
import { PromotionsService } from '@/promotions/promotions.service';
import { FinanceService } from '@/finance/finance.service';
import { AdminConfigService } from '@/admin-config/admin-config.service';
import { ExchangeRateService } from '@/exchange-rate/exchange-rate.service';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { GiftCardsService } from '@/gift-cards/gift-cards.service';
import { StripeConnectService } from '@/stripe-connect/stripe-connect.service';
import { CommissionRulesService } from '@/commission-rules/commission-rules.service';
import { AbandonedCartService } from '@/abandoned-cart/abandoned-cart.service';
import { AffiliateService } from '@/affiliate/affiliate.service';
import { DraftOrdersService } from '@/draft-orders/draft-orders.service';
import { EmailService } from '@/otp/services/email.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { deriveRollupStatus } from '@/orders/order-status.util';
import Stripe from 'stripe';

@Injectable()
export class PaymentService {
  private stripe: InstanceType<typeof Stripe> | undefined;
  // Derived once from the actual configured secret key, not a second env
  // var someone has to remember to keep in sync — see stripeWebhook() below
  // for why this matters.
  private isLiveMode = false;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: ConfigService,
    private readonly promotionsService: PromotionsService,
    private readonly financeService: FinanceService,
    private readonly adminConfigService: AdminConfigService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly activityLogService: ActivityLogService,
    private readonly giftCardsService: GiftCardsService,
    private readonly stripeConnectService: StripeConnectService,
    private readonly commissionRulesService: CommissionRulesService,
    private readonly abandonedCartService: AbandonedCartService,
    private readonly affiliateService: AffiliateService,
    private readonly draftOrdersService: DraftOrdersService,
    private readonly emailService: EmailService,
  ) {
    const secretKey = this.configService
      .get<string>('STRIPE_SECRET_KEY')
      ?.trim();
    if (secretKey) {
      this.isLiveMode = secretKey.startsWith('sk_live_');
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

  /**
   * Issues a real Stripe refund for a specific amount against an already-
   * completed PaymentTransaction — used by the admin/seller-initiated
   * refund-request flow (RefundRequestService), which needs a targeted,
   * item-level refund rather than the whole charge. `amountInPaymentCurrency`
   * must already be in the same currency Stripe actually charged
   * (PaymentTransaction.currency — always USD, per the currency-rail
   * guard in `initiatePayment`) — Stripe enforces it can never exceed the
   * original charge or be issued in a different currency, which is exactly
   * the "refund never uses today's FX rate" guarantee for this rail.
   */
  /** Issues a targeted Stripe refund for a caller (e.g. RefundRequestService)
   *  that has ALREADY done its own correctly-attributed ledger reversal.
   *  Stripe will still emit a `charge.refunded` webhook for this refund —
   *  we immediately bump `PaymentTransaction.amountRefunded` here (rather
   *  than waiting for that webhook) so `handleChargeRefunded`'s
   *  `newRefundDelta` computes to ~0 and skips re-reversing the ledger a
   *  second time via its own proportional-across-all-sellers math. Without
   *  this, the caller's precise per-seller reversal gets silently redone
   *  (and double-counted) by the generic webhook handler once it lands. */
  async refundStripePaymentIntent(
    stripePaymentIntentId: string,
    amountInPaymentCurrency: number,
    idempotencyKey: string,
  ): Promise<{ id: string } | null> {
    if (!this.stripe) return null;

    // A Connect-settled charge already transferred the buyer's money to the
    // seller's own account — a plain refund would try to pull it back out of
    // the PLATFORM's balance instead (which never received it), so it must
    // explicitly reverse the original transfer. `refund_application_fee`
    // likewise gives back Solvexo's own commission cut on the refunded
    // portion, matching real-world refund expectations.
    const transaction = await this.databaseService.repositories.paymentTransactionModel
      .findOne({ stripePaymentIntentId, isDelete: false })
      .select('settledViaConnect');
    const connectFlags = transaction?.settledViaConnect
      ? { reverse_transfer: true, refund_application_fee: true }
      : {};

    const refund = await this.stripe.refunds.create(
      {
        payment_intent: stripePaymentIntentId,
        amount: Math.round(amountInPaymentCurrency * 100),
        ...connectFlags,
      },
      { idempotencyKey },
    );
    await this.databaseService.repositories.paymentTransactionModel.findOneAndUpdate(
      { stripePaymentIntentId, isDelete: false },
      { $inc: { amountRefunded: this.round(amountInPaymentCurrency) } },
    );
    return { id: refund.id };
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
      // Same real-availability pre-check as the other pre-flight checks in
      // this file — see ProductVariant.committedStock.
      const availablePreCheck = variant.stock - (variant.committedStock || 0);
      if (!variant.unlimitedStock && availablePreCheck < item.quantity) {
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
    // digitalItems[].totalPrice is each item's OWN native seller currency
    // (never converted at checkout-item level — only checkout.totalAmount
    // is) — must be converted per line into checkout.currency before
    // summing, same rule as CheckoutService.convertedSubtotal, using this
    // checkout's own frozen fxSnapshots rather than a fresh rate.
    const chargeAmount = useSplit
      ? this.round(
          digitalItems.reduce(
            (s: number, i: any) =>
              s +
              this.exchangeRateService.convertWithSnapshots(
                i.totalPrice,
                i.currency ?? checkout.currency,
                checkout.currency,
                (checkout.fxSnapshots as any) ?? [],
              ),
            0,
          ),
        )
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

    // Seller's own payment gateway (Stripe Connect) — route the charge
    // directly to a connected seller's own account instead of the
    // platform's shared one, IF this checkout is single-store (a
    // PaymentIntent's `transfer_data.destination` only supports ONE
    // destination account, so a legacy/edge-case multi-store cart is never
    // routed this way — it falls back to today's shared-account + internal
    // ledger/payout flow, unchanged) AND the whole checkout is being paid
    // online in one go (not 'split' — a partial digital-only charge routed
    // to one seller while the rest settles via COD to nobody-in-particular
    // would be a confusing mix, so Connect only ever applies to a 'full'
    // charge). See StripeConnectService/OrdersService.recordSale's gate on
    // SellerOrder.settledViaConnect for the other half of this feature.
    const checkoutStoreIds = [...new Set(checkout.items.map((i: any) => i.storeId))];
    let connectAccountId: string | null = null;
    let applicationFeeAmountCents = 0;
    // Manual capture, like Connect direct-charge routing just above, only
    // ever applies to a genuinely single-store, pay-in-full checkout —
    // Stripe's `capture_method` is one setting per PaymentIntent, so a
    // multi-store cart spanning stores with different capture preferences
    // has no single correct answer and always falls back to 'automatic'.
    let manualCapture = false;
    if (!useSplit && checkoutStoreIds.length === 1) {
      connectAccountId = await this.stripeConnectService.getEligibleConnectAccountForStore(checkoutStoreIds[0]);
      if (connectAccountId) {
        const { rate } = await this.commissionRulesService.resolveRate(checkoutStoreIds[0]);
        applicationFeeAmountCents = Math.round(amountCents * rate);
      }
      const store = await this.databaseService.repositories.storeModel
        .findById(checkoutStoreIds[0]).select('paymentCaptureMethod').lean();
      manualCapture = (store as any)?.paymentCaptureMethod === 'manual';
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
          ...(manualCapture ? { capture_method: 'manual' as const } : {}),
          ...(connectAccountId
            ? {
                transfer_data: { destination: connectAccountId },
                application_fee_amount: applicationFeeAmountCents,
              }
            : {}),
        },
        { idempotencyKey },
      );
    } catch (err: any) {
      // Stripe sets `param: 'currency'` specifically when it rejects the
      // request because it doesn't support this presentment currency at
      // all (as opposed to a card decline or any other failure) — learn
      // that fact once, here, from Stripe's own real response, so
      // CheckoutService stops ever offering "Pay Online" for this currency
      // again instead of every future buyer hitting the same Stripe error.
      // Never a hand-maintained currency list — Stripe's own support can
      // change, and a hardcoded guess could wrongly block a real one.
      if (err?.param === 'currency' && checkout.currency) {
        await this.adminConfigService
          .markStripeCardPaymentUnsupported(checkout.currency)
          .catch(() => {}); // best-effort — never let this block the error response below
        throw new BadRequestException(
          `Online card payment isn't available for ${checkout.currency} — please use Cash on Delivery or Bank Transfer instead.`,
        );
      }
      throw new BadRequestException(
        `Payment initiation failed: ${err?.message || 'Stripe error'}`,
      );
    }

    await paymentTransactionModel.create({
      userId,
      checkoutId: checkout._id.toString(),
      paymentType: 'stripe',
      amount: chargeAmount,
      currency: checkout.currency,
      fxSnapshots: checkout.fxSnapshots,
      paymentScope,
      status: 'pending',
      stripePaymentIntentId: paymentIntent.id,
      stripeClientSecret: paymentIntent.client_secret,
      settledViaConnect: !!connectAccountId,
      stripeConnectedAccountId: connectAccountId,
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
    // A live STRIPE_SECRET_KEY always verifies against STRIPE_WEBHOOK_SECRET
    // only — never STRIPE_WEBHOOK_SECRET_TEST, even if that var is still
    // sitting in the environment from an earlier test-mode setup. Stripe
    // signs a live endpoint's events with that endpoint's own secret, so a
    // stale test secret taking priority here would fail every real webhook's
    // signature check in production. Test mode keeps preferring the TEST
    // secret (falling back to the general one) exactly as before.
    const webhookSecret = this.isLiveMode
      ? this.configService.get<string>('STRIPE_WEBHOOK_SECRET') || ''
      : this.configService.get<string>('STRIPE_WEBHOOK_SECRET_TEST') ||
        this.configService.get<string>('STRIPE_WEBHOOK_SECRET') ||
        '';

    let event: any;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      throw new BadRequestException('Invalid Stripe webhook signature');
    }

    // Dedup on the Stripe event id — a redelivered event fails this unique
    // insert and is treated as an already-processed no-op, independent of
    // the incidental protection PaymentTransaction's own status-transition
    // guard happens to provide. See StripeWebhookEvent's schema comment.
    try {
      await this.databaseService.repositories.stripeWebhookEventModel.create({
        eventId: event.id,
        eventType: event.type,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        return { received: true }; // already processed this exact event
      }
      throw err;
    }

    // Everything below used to swallow its own errors (`.catch(console.error)`)
    // and unconditionally `return { received: true }` regardless of outcome —
    // meaning a transient failure here (a DB hiccup, an unhandled edge case)
    // silently dropped the event forever: Stripe saw HTTP 200 so it never
    // retried, and there was no queue behind this handler to retry it either.
    // Now a failure here is rethrown (→ a non-2xx response), which puts the
    // event back into Stripe's own retry schedule — and the dedup row we just
    // inserted is deleted first so the retry isn't immediately swallowed as
    // "already processed" by the dedup check above.
    try {
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        // A gift-card purchase (GiftCardsService.createPurchaseIntent) is a
        // standalone PaymentIntent with no PaymentTransaction/Checkout
        // behind it — route it to its own finalizer instead of
        // finalizePaymentIntent, which only knows about checkout orders.
        if (paymentIntent.metadata?.purpose === 'gift_card_purchase') {
          await this.giftCardsService.finalizeGiftCardPurchase(paymentIntent);
        } else if (paymentIntent.metadata?.purpose === 'draft_order_invoice') {
          // Real "Send invoice" online payment — standalone PaymentIntent
          // with no PaymentTransaction/Checkout behind it either, same
          // shape as the gift-card branch above. See
          // DraftOrdersService.finalizeInvoicePayment.
          await this.draftOrdersService.finalizeInvoicePayment(paymentIntent);
        } else {
          await this.finalizePaymentIntent(paymentIntent);
        }
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
      } else if (event.type === 'payment_intent.amount_capturable_updated') {
        // Manual-capture authorization succeeded (card valid, funds held,
        // nothing charged) — see authorizePaymentIntent's doc comment. Never
        // fires for the default automatic-capture path.
        const paymentIntent = event.data.object;
        await this.authorizePaymentIntent(paymentIntent);
      } else if (event.type === 'payment_intent.canceled') {
        // A manual-capture authorization that was never captured in time —
        // Stripe cancels it itself once the ~7-day authorization window
        // lapses (or a seller/admin explicitly voids it via Stripe). Same
        // real-world outcome as Shopify's own "authorization expired": the
        // hold is released, the seller gets nothing, and the order needs to
        // visibly reflect that instead of sitting silently as "Authorized"
        // forever.
        const paymentIntent = event.data.object;
        await this.handleAuthorizationCanceled(paymentIntent);
      } else if (event.type === 'charge.refunded') {
        const charge = event.data.object;
        await this.handleChargeRefunded(charge);
      } else if (event.type === 'charge.succeeded') {
        // Real Stripe Radar fraud-risk read (`outcome.risk_level`) — purely
        // informational metadata, never touches the ledger. See
        // captureChargeRiskLevel / getHighRiskOrderCount.
        const charge = event.data.object;
        await this.captureChargeRiskLevel(charge);
      } else if (event.type === 'charge.dispute.created') {
        const dispute = event.data.object;
        await this.handleChargeDispute(dispute);
      } else if (event.type === 'charge.dispute.updated' || event.type === 'charge.dispute.closed') {
        // Status-only transition (evidence submitted, or a final won/lost
        // outcome) — never re-reverses the ledger, that already happened on
        // `charge.dispute.created`. See handleChargeDisputeStatusChange.
        const dispute = event.data.object;
        await this.handleChargeDisputeStatusChange(dispute);
      } else if (event.type === 'account.updated') {
        // Stripe Connect account status change (KYC completed, a capability
        // revoked, etc.) — arrives on the platform's own webhook endpoint
        // for every connected account, not a per-account one.
        await this.stripeConnectService.handleAccountUpdated(event.data.object);
      } else if (event.type === 'transfer.reversed') {
        // A previously-successful FinanceService payout Transfer (platform
        // balance → seller's connected account, for a store's internal
        // ledger balance — see FinanceService.runStripeConnectTransfer) was
        // clawed back — e.g. Stripe itself later restricted the connected
        // account. This is a genuinely separate money path from the direct-
        // charge routing above (`event.account`/`getEligibleConnectAccountForStore`);
        // a reversed direct charge is a `charge.refunded`/`charge.dispute.created`
        // event instead, already handled above.
        const transfer = event.data.object as any;
        await this.financeService.handleConnectTransferReversed(transfer.id);
      }
    } catch (err: any) {
      console.error(`Stripe webhook handling failed (${event.type}):`, err?.message, { eventId: event.id });
      await this.databaseService.repositories.stripeWebhookEventModel
        .deleteOne({ eventId: event.id })
        .catch(() => {});
      await this.activityLogService.log({
        storeId: 'platform',
        category: 'finance',
        action: 'stripe_webhook_processing_failed',
        description: `Stripe webhook ${event.type} (event ${event.id}) failed to process: ${err?.message}`,
        actorId: 'system',
        actorRole: 'system',
        isSecurityAlert: true,
        targetId: event.id,
        targetType: 'stripe_webhook_event',
      });
      throw err;
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

    // Also appends a real `disputes[]` entry (separate from the replay-guard
    // `disputedChargeIds` above) — powers the seller dashboard's "N order(s)
    // need your dispute response" task (mirrors Shopify Home's "Submit
    // evidence for chargebacks" order task), which previously had no
    // surface at all beyond the silent ledger reversal.
    const storeIds = await this.resolveStoreIdsForOrders(transaction.orderIds);
    const dueBy = dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null;

    await paymentTransactionModel.findByIdAndUpdate(transaction._id, {
      $addToSet: { disputedChargeIds: dispute.id },
      $push: {
        disputes: {
          disputeId: dispute.id,
          status: dispute.status || 'needs_response',
          reason: dispute.reason ?? null,
          amount: disputeAmount,
          currency: (dispute.currency || 'usd').toUpperCase(),
          storeIds,
          evidenceDueBy: dueBy,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    });
    await this.reverseSellerLedgerForOrders(transaction.orderIds, disputeAmount, 'Stripe dispute/chargeback');

    // Real, actionable notification — previously a dispute only ever showed
    // up as a silent ledger reversal + the "Needs Attention" count; a seller
    // had no push/notification-feed signal that a new dispute exists at all.
    for (const storeId of storeIds) {
      const store = await this.databaseService.repositories.storeModel.findById(storeId).select('sellerId').lean();
      if (!store) continue;
      this.notificationsService
        .notify({
          recipientId: (store as any).sellerId,
          recipientRole: 'seller',
          storeId,
          type: NOTIFICATION_TYPES.DISPUTE_OPENED,
          title: 'New payment dispute',
          body: `A buyer disputed a ${disputeAmount} ${(dispute.currency || 'usd').toUpperCase()} charge${dueBy ? ` — evidence due by ${dueBy.toLocaleDateString()}` : ''}.`,
          data: { disputeId: dispute.id, storeId },
        })
        .catch(() => {});
    }
  }

  /**
   * `charge.dispute.updated`/`charge.dispute.closed` — Stripe's own dispute
   * status transitions (evidence submitted → 'under_review', final outcome
   * → 'won'/'lost'/'warning_closed'). Updates the matching `disputes[]`
   * entry's `status` in place so the dashboard's open-dispute count
   * automatically drops off once a dispute is no longer actionable.
   */
  private async handleChargeDisputeStatusChange(dispute: any) {
    const { paymentTransactionModel } = this.databaseService.repositories;
    const transaction = await paymentTransactionModel.findOneAndUpdate(
      { 'disputes.disputeId': dispute.id },
      { $set: { 'disputes.$.status': dispute.status, 'disputes.$.updatedAt': new Date() } },
    );
    if (!transaction) return;

    const entry = (transaction.disputes ?? []).find((d: any) => d.disputeId === dispute.id);
    if (!entry) return;
    for (const storeId of entry.storeIds ?? []) {
      const store = await this.databaseService.repositories.storeModel.findById(storeId).select('sellerId').lean();
      if (!store) continue;
      this.notificationsService
        .notify({
          recipientId: (store as any).sellerId,
          recipientRole: 'seller',
          storeId,
          type: NOTIFICATION_TYPES.DISPUTE_UPDATED,
          title: 'Dispute status updated',
          body: `A dispute is now "${String(dispute.status).replace(/_/g, ' ')}".`,
          data: { disputeId: dispute.id, storeId },
        })
        .catch(() => {});
    }
  }

  /** Resolves the distinct set of storeIds a batch of orderIds belongs to (via each order's own `sellerOrders[].storeId`). */
  private async resolveStoreIdsForOrders(orderIds: string[]): Promise<string[]> {
    const { orderModel } = this.databaseService.repositories;
    const orders = await orderModel.find({ _id: { $in: orderIds }, isDelete: false }).select('sellerOrders.storeId').lean();
    const storeIds = new Set<string>();
    for (const order of orders as any[]) {
      for (const so of order.sellerOrders ?? []) storeIds.add(so.storeId);
    }
    return [...storeIds];
  }

  /**
   * Real, actionable signal for the store dashboard's "Needs Attention"
   * card — how many currently-open disputes (Stripe status
   * 'needs_response'/'warning_needs_response' — genuinely awaiting the
   * seller's evidence submission, not merely "under review") this store has
   * right now.
   */
  async getOpenDisputeCount(storeId: string, sellerId: string): Promise<number> {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const { paymentTransactionModel } = this.databaseService.repositories;
    return paymentTransactionModel.countDocuments({
      disputes: { $elemMatch: { storeIds: storeId, status: { $in: ['needs_response', 'warning_needs_response'] } } },
    });
  }

  /** Real "Disputes" list for the seller dashboard — closes the previously-
   *  disclosed gap where only an open-dispute COUNT existed, no detail view.
   *  Flattens every store-scoped `disputes[]` entry across every
   *  `PaymentTransaction`, newest first. */
  async listDisputes(storeId: string, sellerId: string, status?: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const { paymentTransactionModel } = this.databaseService.repositories;
    const match: Record<string, unknown> = { storeIds: storeId };
    if (status) match.status = status;

    const transactions = await paymentTransactionModel
      .find({ disputes: { $elemMatch: match } })
      .select('disputes orderIds stripePaymentIntentId')
      .lean();

    const rows: any[] = [];
    for (const t of transactions as any[]) {
      for (const d of t.disputes ?? []) {
        if (!d.storeIds?.includes(storeId)) continue;
        if (status && d.status !== status) continue;
        rows.push({ ...d, orderIds: t.orderIds, stripePaymentIntentId: t.stripePaymentIntentId });
      }
    }
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return rows;
  }

  /** Real Stripe evidence submission — `stripe.disputes.update` with
   *  `submit: true` files the dispute for Stripe's review (never a local-
   *  only "acknowledged" flag). Stripe's own `charge.dispute.updated`
   *  webhook (handleChargeDisputeStatusChange, above) is what actually
   *  advances the locally-tracked `status` afterward — this call doesn't
   *  optimistically set it here, to avoid drifting from Stripe's own truth. */
  async submitDisputeEvidence(
    storeId: string,
    sellerId: string,
    disputeId: string,
    evidence: { productDescription?: string; customerCommunication?: string; shippingDocumentation?: string; uncategorizedText?: string },
  ) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const stripe = this.assertStripeConfigured();

    const { paymentTransactionModel } = this.databaseService.repositories;
    const transaction = await paymentTransactionModel.findOne({
      disputes: { $elemMatch: { disputeId, storeIds: storeId } },
    }).select('disputes');
    if (!transaction) throw new BadRequestException('Dispute not found for this store');

    const hasContent = Object.values(evidence).some((v) => v && v.trim());
    if (!hasContent) throw new BadRequestException('At least one piece of evidence is required');

    await stripe.disputes.update(disputeId, {
      evidence: {
        product_description: evidence.productDescription || undefined,
        customer_communication: evidence.customerCommunication || undefined,
        shipping_documentation: evidence.shippingDocumentation || undefined,
        uncategorized_text: evidence.uncategorizedText || undefined,
      },
      submit: true,
    });

    return { success: true, message: 'Evidence submitted to Stripe for review' };
  }

  /**
   * `charge.succeeded` — captures Stripe Radar's own real risk assessment
   * for this charge (never touches the ledger, purely informational). Not
   * gated on the transaction's own status (this event can arrive slightly
   * before or after `payment_intent.succeeded`), so this is a plain
   * best-effort metadata write keyed only by the payment intent id.
   */
  private async captureChargeRiskLevel(charge: any) {
    const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
    const riskLevel = charge.outcome?.risk_level;
    if (!paymentIntentId || !riskLevel) return;

    await this.databaseService.repositories.paymentTransactionModel.updateOne(
      { stripePaymentIntentId: paymentIntentId },
      { $set: { riskLevel } },
    );
  }

  /**
   * Real, actionable signal for the store dashboard's "Needs Attention"
   * card — mirrors Shopify Home's "Review high-risk orders" order task.
   * "Needs review" = Stripe Radar flagged the charge 'elevated'/'highest'
   * AND the underlying seller order hasn't shipped yet (`pending`/
   * `processing`) — once fulfilled/cancelled/refunded there is nothing left
   * to review before it goes out the door, so the count naturally clears
   * itself without a separate "reviewed" flag to maintain.
   */
  async getHighRiskOrderCount(storeId: string, sellerId: string): Promise<number> {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const { paymentTransactionModel, orderModel } = this.databaseService.repositories;

    const riskyTx = await paymentTransactionModel
      .find({ riskLevel: { $in: ['elevated', 'highest'] }, orderIds: { $exists: true, $ne: [] } })
      .select('orderIds')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    const orderIds = [...new Set((riskyTx as any[]).flatMap((t) => t.orderIds))];
    if (orderIds.length === 0) return 0;

    return orderModel.countDocuments({
      _id: { $in: orderIds },
      isDelete: false,
      sellerOrders: { $elemMatch: { storeId, status: { $in: ['pending', 'processing'] } } },
    });
  }

  /**
   * Distributes a charge-level refund/dispute amount across every affected
   * sellerOrder, proportional to its share of the orders' combined total.
   * `refundAmountTotal` is always in the ORDER's own currency (Stripe only
   * ever processes USD checkouts in this codebase — see initiatePayment's
   * currency-rail guard — so this is always USD). Each seller's share is
   * then converted from that order currency into THEIR OWN settlement
   * currency (so.settlementCurrency) using the order's own frozen
   * fxSnapshots before being recorded against their wallet — a seller
   * priced in PKR must never have their ledger debited in USD.
   */
  private async reverseSellerLedgerForOrders(orderIds: string[], refundAmountTotal: number, reason: string) {
    const { orderModel } = this.databaseService.repositories;
    const orders = await orderModel.find({ _id: { $in: orderIds }, isDelete: false }).lean();
    if (orders.length === 0) return;

    const grandTotal = (orders as any[]).reduce((s: number, o: any) => s + o.totalAmount, 0);
    if (grandTotal <= 0) return;

    for (const order of orders as any[]) {
      for (const so of order.sellerOrders) {
        // A Connect-settled sellerOrder was never credited to the internal
        // ledger in the first place (OrdersService.recordSale skips it) —
        // the real Stripe-side reversal already happened via
        // refundStripePaymentIntent's reverse_transfer flag, so there is
        // nothing here to reverse. Ledger-reversing it anyway would either
        // no-op against a balance that was never incremented, or worse,
        // push it negative.
        if (so.settledViaConnect) continue;
        const shareInOrderCurrency = this.round((so.subtotal / grandTotal) * refundAmountTotal);
        if (shareInOrderCurrency <= 0) continue;
        const settlementCurrency = so.settlementCurrency ?? order.currency ?? 'USD';
        const share = this.exchangeRateService.convertWithSnapshots(
          shareInOrderCurrency,
          order.currency || 'USD',
          settlementCurrency,
          (order.fxSnapshots as any) ?? [],
        );
        try {
          await this.financeService.recordRefund(
            so.storeId, so.sellerId, order._id.toString(), share,
            'system', 'system',
            { description: `${reason} — Order #${order._id}`, targetType: 'order', currency: settlementCurrency },
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

  /** `paymentIntent` is the full Stripe object (from the webhook event or a
   *  direct `retrieve()`), not just an id — its own `amount`/`currency` are
   *  cross-checked against the stored Checkout below before any order is
   *  created, so a bug elsewhere in the amount-computation path can never
   *  silently produce an order whose value disagrees with what Stripe
   *  actually confirmed it charged. */
  private async finalizePaymentIntent(
    paymentIntent: { id: string; amount?: number; currency?: string },
  ): Promise<{ orderIds: string[] } | null> {
    const paymentIntentId = paymentIntent.id;
    const {
      checkoutModel,
      paymentTransactionModel,
      orderModel,
      addressModel,
      cartModel,
    } = this.databaseService.repositories;

    // Matches BOTH a first-ever automatic-capture success ('pending' — the
    // overwhelming default case, unchanged) AND a manual-capture order's
    // real Stripe capture completing ('authorized' — see
    // `authorizePaymentIntent`, which is what put it in that state). Both
    // land here because Stripe fires the identical `payment_intent.succeeded`
    // event for either — an auto-captured charge succeeding immediately, or
    // a manual-capture PaymentIntent finishing a real `capture()` call.
    const transaction = await paymentTransactionModel.findOneAndUpdate(
      {
        stripePaymentIntentId: paymentIntentId,
        status: { $in: ['pending', 'authorized'] },
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

    // The order(s) already exist — this transaction was 'authorized', which
    // only ever happens after `authorizePaymentIntent` already ran
    // `createOrder` once. This `payment_intent.succeeded` delivery is the
    // CAPTURE completing, not the first creation — finish it by flipping the
    // existing orders to paid, never by creating a second set of orders.
    if (transaction.orderIds.length > 0) {
      await this.markOrdersCaptured(transaction.orderIds);
      return { orderIds: transaction.orderIds };
    }

    const checkout = await checkoutModel.findOne({
      _id: transaction.checkoutId,
      isDelete: false,
    });
    if (!checkout || checkout.status === 'completed') {
      return { orderIds: transaction.orderIds };
    }

    // Amount/currency safety net: what Stripe confirms it actually charged
    // must match what this checkout's own record says it should have
    // charged. A mismatch here means something upstream (a bug, a race, a
    // corrupted request) diverged from what was authorized — refuse to
    // create an order from it and surface it as a security alert rather
    // than silently trusting either side.
    if (typeof paymentIntent.amount === 'number' && typeof paymentIntent.currency === 'string') {
      const expectedAmountCents = Math.round(transaction.amount * 100);
      const expectedCurrency = (checkout.currency || 'USD').toUpperCase();
      const actualCurrency = paymentIntent.currency.toUpperCase();
      if (paymentIntent.amount !== expectedAmountCents || actualCurrency !== expectedCurrency) {
        await paymentTransactionModel.findByIdAndUpdate(transaction._id, { status: 'pending', paidAt: null });
        await this.activityLogService.log({
          storeId: 'platform',
          category: 'finance',
          action: 'payment_amount_currency_mismatch',
          description: `Stripe confirmed ${paymentIntent.amount} ${actualCurrency} but checkout ${checkout._id} expected ${expectedAmountCents} ${expectedCurrency} — order NOT created, needs manual review`,
          actorId: 'system',
          actorRole: 'system',
          isSecurityAlert: true,
          targetId: checkout._id.toString(),
          targetType: 'checkout',
        });
        throw new BadRequestException('Payment amount/currency mismatch — this charge requires manual review');
      }
    }

    // A 'digital_only' transaction means this Stripe charge only covered the
    // digital items of a mixed cart — the physical items are unpaid/COD,
    // collected by the courier on delivery. Everything else (full-checkout
    // Stripe payments, digital-only carts) pays 'stripe'/paid on both sides.
    const digitalPayment = { paymentType: 'stripe', isPaid: true };
    const physicalPayment = transaction.paymentScope === 'digital_only'
      ? { paymentType: 'cash_on_delivery', isPaid: false }
      : { paymentType: 'stripe', isPaid: true };

    // Only ever set when initiatePayment gated this charge to a single-store
    // checkout and routed it via Stripe Connect — that gate guarantees every
    // item in `checkout.items` shares the same storeId, so the first item's
    // is safe to use here.
    const connectInfo = transaction.settledViaConnect && transaction.stripeConnectedAccountId
      ? { storeId: checkout.items[0]?.storeId, accountId: transaction.stripeConnectedAccountId }
      : null;

    let orders: any[];
    try {
      orders = await this.createOrder(transaction.userId, checkout, orderModel, addressModel, physicalPayment, digitalPayment, undefined, connectInfo);
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

  /**
   * `payment_intent.amount_capturable_updated` — fires once a manual-capture
   * PaymentIntent's authorization succeeds (card valid, funds held, nothing
   * charged yet). Only ever reached for a store with
   * `Store.paymentCaptureMethod === 'manual'` (see `initiatePayment`'s
   * `capture_method` gate) — every automatic-capture checkout (the default)
   * never emits this event at all, so this method is a strict addition with
   * zero effect on the existing path.
   *
   * Creates the real order NOW, same as an automatic-capture success would —
   * a manual-capture seller needs to actually see the order (to decide
   * whether to fulfill/capture it) well before the money is taken, exactly
   * like Shopify's own "Authorized" order state. `isPaid` stays false and
   * `paymentStatus` is 'authorized' until a real Stripe capture happens (see
   * `captureOrderPayment` and `finalizePaymentIntent`'s
   * `transaction.orderIds.length > 0` branch, which finishes this once
   * captured).
   */
  private async authorizePaymentIntent(
    paymentIntent: { id: string; amount?: number; currency?: string },
  ): Promise<void> {
    const paymentIntentId = paymentIntent.id;
    const { checkoutModel, paymentTransactionModel, orderModel, addressModel, cartModel } =
      this.databaseService.repositories;

    const transaction = await paymentTransactionModel.findOneAndUpdate(
      { stripePaymentIntentId: paymentIntentId, status: 'pending', isDelete: false },
      { status: 'authorized' },
      { new: true },
    );
    // No match = either already authorized (redelivered webhook — the first
    // findOneAndUpdate already flipped it out of 'pending') or genuinely not
    // ours; either way there's nothing new to do.
    if (!transaction) return;

    const checkout = await checkoutModel.findOne({ _id: transaction.checkoutId, isDelete: false });
    if (!checkout || checkout.status === 'completed') return;

    // Same amount/currency safety net as `finalizePaymentIntent` — a
    // mismatch here must never silently create an order either.
    if (typeof paymentIntent.amount === 'number' && typeof paymentIntent.currency === 'string') {
      const expectedAmountCents = Math.round(transaction.amount * 100);
      const expectedCurrency = (checkout.currency || 'USD').toUpperCase();
      const actualCurrency = paymentIntent.currency.toUpperCase();
      if (paymentIntent.amount !== expectedAmountCents || actualCurrency !== expectedCurrency) {
        await paymentTransactionModel.findByIdAndUpdate(transaction._id, { status: 'pending' });
        await this.activityLogService.log({
          storeId: 'platform',
          category: 'finance',
          action: 'payment_amount_currency_mismatch',
          description: `Stripe authorized ${paymentIntent.amount} ${actualCurrency} but checkout ${checkout._id} expected ${expectedAmountCents} ${expectedCurrency} — order NOT created, needs manual review`,
          actorId: 'system',
          actorRole: 'system',
          isSecurityAlert: true,
          targetId: checkout._id.toString(),
          targetType: 'checkout',
        });
        throw new BadRequestException('Payment amount/currency mismatch — this charge requires manual review');
      }
    }

    // Manual capture is only ever offered for a single-store, pay-in-full
    // checkout (see `initiatePayment`'s gate) — there is no digital_only/
    // split-payment branch to consider here, unlike `finalizePaymentIntent`.
    const paymentInfo = { paymentType: 'stripe', isPaid: false, paymentStatus: 'authorized' };

    let orders: any[];
    try {
      orders = await this.createOrder(transaction.userId, checkout, orderModel, addressModel, paymentInfo, paymentInfo);
    } catch (err: any) {
      await paymentTransactionModel.findByIdAndUpdate(transaction._id, { status: 'pending' });
      console.error('createOrder failed while authorizing payment:', err?.message, {
        checkoutId: checkout._id, paymentIntentId,
      });
      throw new BadRequestException('Order creation failed, will retry');
    }

    await paymentTransactionModel.findByIdAndUpdate(transaction._id, {
      orderIds: orders.map((o: any) => o._id.toString()),
    });
    await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'completed' });
    await this.removeCheckedOutItemsFromCart(transaction.userId, checkout, cartModel);
    // Seller notifications (real "new order" push) already fire inside
    // `createOrder()` — a manual-capture seller sees it exactly like any
    // other new order, just with an "Authorized" payment badge instead of "Paid".
  }

  /**
   * Flips already-created orders from 'authorized' to genuinely 'paid' —
   * the real Stripe capture already happened by the time this runs (either
   * `captureOrderPayment`'s inline call right after a successful
   * `stripe.paymentIntents.capture()`, or the `payment_intent.succeeded`
   * webhook that same capture call triggers — both call this, and it's a
   * safe no-op on the second call via the `order.isPaid` guard below, so a
   * redelivered webhook or a slow webhook arriving after the inline call
   * both land here harmlessly).
   *
   * `capturedTotal` (omitted = full amount, the common case) is the REAL
   * amount Stripe actually captured across every order this PaymentIntent
   * covers (a single-store checkout can produce up to 2 — physical +
   * digital). When it's less than what was originally authorized (a
   * genuine partial capture — Shopify supports this too, e.g. an item
   * turned out to be out of stock), every order/sellerOrder's
   * money fields are scaled down by the same ratio BEFORE being marked
   * paid — critical correctness: `OrdersService.recordSale` later reads
   * `sellerOrder.settlementAmount` to credit the seller's ledger, and it
   * must never credit them for money that was authorized but never
   * actually captured.
   */
  private async markOrdersCaptured(orderIds: string[], capturedTotal?: number): Promise<void> {
    const { orderModel } = this.databaseService.repositories;
    const orders = await orderModel.find({ _id: { $in: orderIds }, isDelete: false });
    const unpaid = (orders as any[]).filter((o) => !o.isPaid);
    if (unpaid.length === 0) return;

    const originalTotal = unpaid.reduce((s, o) => s + o.totalAmount, 0);
    const isPartial = capturedTotal != null && originalTotal > 0 && capturedTotal < originalTotal - 0.01;
    const ratio = isPartial ? capturedTotal! / originalTotal : 1;

    for (const order of unpaid) {
      if (isPartial) {
        order.totalAmount = this.round(order.totalAmount * ratio);
        for (const so of order.sellerOrders) {
          so.settlementAmount = this.round(so.settlementAmount * ratio);
          so.subtotal = this.round(so.subtotal * ratio);
        }
      }
      order.isPaid = true;
      order.paymentStatus = 'paid';
      order.paidAt = new Date();
      await order.save();

      if (isPartial) {
        this.activityLogService.log({
          storeId: order.sellerOrders[0]?.storeId ?? 'platform',
          category: 'finance',
          action: 'payment_partially_captured',
          description: `Order #${order.orderNumber} — only ${this.round(order.totalAmount)} of the originally-authorized amount was captured; the rest was released back to the buyer.`,
          actorId: 'system',
          actorRole: 'system',
          targetId: order._id.toString(),
          targetType: 'order',
        });
      }
    }
  }

  /**
   * A manual-capture authorization was never captured in time and Stripe
   * itself canceled it (the ~7-day authorization window lapsed) — or a
   * seller/admin explicitly voided it via the Stripe Dashboard. No money was
   * ever taken, so there is nothing to reverse in the finance ledger (that
   * only ever gets credited later, on real fulfillment — see
   * OrdersService.updateSellerOrderStatus — and this order can now never
   * reach that point). Releases the physical-item stock reservation
   * (mirrors `createOrder`'s own reservation-rollback) and marks the
   * order(s) cancelled so they stop appearing as "awaiting capture".
   */
  private async handleAuthorizationCanceled(paymentIntent: { id: string }): Promise<void> {
    const { paymentTransactionModel, orderModel, productVariantModel } = this.databaseService.repositories;

    const transaction = await paymentTransactionModel.findOneAndUpdate(
      { stripePaymentIntentId: paymentIntent.id, status: 'authorized', isDelete: false },
      { status: 'failed' },
      { new: true },
    );
    if (!transaction || transaction.orderIds.length === 0) return;

    const orders = await orderModel.find({ _id: { $in: transaction.orderIds }, isDelete: false });
    for (const order of orders as any[]) {
      if (order.paymentStatus !== 'authorized') continue; // already resolved some other way

      for (const so of order.sellerOrders) {
        for (const item of so.items) {
          if (item.type !== 'physical' || !item.variantId) continue;
          await productVariantModel.updateOne(
            { _id: item.variantId },
            { $inc: { committedStock: -item.quantity } },
          );
        }
        so.status = 'cancelled';
        so.cancelledAt = new Date();
        so.cancelReason = 'Payment authorization expired before capture';
        for (const item of so.items) item.status = 'cancelled';
      }
      order.paymentStatus = 'failed';
      order.orderStatus = deriveRollupStatus(order.sellerOrders.map((so: any) => so.status));
      await order.save();

      for (const so of order.sellerOrders) {
        this.notificationsService.notify({
          recipientId: so.sellerId,
          recipientRole: 'seller',
          storeId: so.storeId,
          type: NOTIFICATION_TYPES.ORDER_CANCELLED,
          title: 'Order cancelled — payment authorization expired',
          body: `Order #${order.orderNumber} was cancelled because the payment authorization wasn't captured in time.`,
          data: { orderId: order._id.toString() },
        }).catch(() => {});
      }
    }
  }

  /**
   * Seller-facing manual capture — the real "Capture Payment" action (see
   * PaymentController). Only ever valid for an order still 'authorized'
   * (Store.paymentCaptureMethod === 'manual'); calls the real Stripe
   * `paymentIntents.capture()` API — no ledger/notification logic lives
   * here directly, it's delegated to `markOrdersCaptured` (the same method
   * the webhook path uses) so both routes to "actually captured" can never
   * drift apart.
   *
   * `amountToCapture` (omitted = capture the full authorized amount) is a
   * real Stripe partial capture — Shopify supports this too (e.g. one item
   * in the order turned out to be unavailable, so the seller only wants to
   * charge for the rest). Stripe releases the un-captured remainder back to
   * the buyer and settles the PaymentIntent at the lower amount; a single
   * Stripe PaymentIntent can cover up to 2 of this codebase's orders
   * (physical + digital, from one single-store checkout — see
   * `initiatePayment`'s manual-capture gate), so the amount is validated
   * and scaled against their COMBINED authorized total, not just this one
   * order's.
   */
  async captureOrderPayment(sellerId: string, orderId: string, amountToCapture?: number): Promise<any> {
    const { orderModel, paymentTransactionModel } = this.databaseService.repositories;

    const order = await orderModel.findOne({ _id: orderId, isDelete: false });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.sellerOrders.some((so: any) => so.sellerId === sellerId)) {
      throw new ForbiddenException('Unauthorized');
    }
    if (order.paymentStatus !== 'authorized') {
      throw new BadRequestException(`Cannot capture — this order's payment status is "${order.paymentStatus}", not "authorized"`);
    }

    const transaction = await paymentTransactionModel.findOne({
      orderIds: orderId, status: 'authorized', isDelete: false,
    });
    if (!transaction?.stripePaymentIntentId) {
      throw new BadRequestException('No authorized Stripe payment found for this order');
    }

    const coveredOrders = await orderModel.find({ _id: { $in: transaction.orderIds }, isDelete: false }).lean();
    const authorizedTotal = this.round((coveredOrders as any[]).reduce((s, o) => s + o.totalAmount, 0));

    let stripeParams: { amount_to_capture?: number } = {};
    if (amountToCapture != null) {
      if (!(amountToCapture > 0) || amountToCapture > authorizedTotal + 0.01) {
        throw new BadRequestException(`Amount to capture must be between 0 and ${authorizedTotal.toFixed(2)} (the authorized total)`);
      }
      stripeParams = { amount_to_capture: Math.round(amountToCapture * 100) };
    }

    const stripe = this.assertStripeConfigured();
    try {
      await stripe.paymentIntents.capture(transaction.stripePaymentIntentId, stripeParams);
    } catch (err: any) {
      throw new BadRequestException(`Stripe capture failed: ${err?.message || 'unknown error'}`);
    }

    // Capture succeeded synchronously — finish immediately rather than
    // waiting for Stripe's own `payment_intent.succeeded` webhook round-trip
    // (that webhook still arrives and safely no-ops via markOrdersCaptured's
    // `order.isPaid` guard, in case this response is ever lost mid-flight).
    await paymentTransactionModel.updateOne(
      { _id: transaction._id },
      { status: 'completed', paidAt: new Date() },
    );
    const capturedTotal = amountToCapture ?? authorizedTotal;
    await this.markOrdersCaptured(transaction.orderIds, capturedTotal);

    return { captured: true, orderIds: transaction.orderIds, capturedAmount: capturedTotal };
  }

  /** Real count for the store dashboard's "Needs Attention" card — orders sitting in 'authorized' (manual-capture, not yet captured). */
  async getAwaitingCaptureCount(storeId: string, sellerId: string): Promise<number> {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const { orderModel } = this.databaseService.repositories;
    return orderModel.countDocuments({
      isDelete: false,
      paymentStatus: 'authorized',
      'sellerOrders.storeId': storeId,
    });
  }

  /** Generic-gateway equivalent of `finalizePaymentIntent` — for the new
   *  per-store payment module (`src/integrations`), whose webhook only ever
   *  reports a `providerSessionId` + success/failure, never a Stripe-shaped
   *  PaymentIntent object. Idempotent the same way: the `findOneAndUpdate({
   *  status:'pending'})` guard means a redelivered webhook event (already
   *  deduped upstream by `IntegrationWebhookEventService`, but defense in
   *  depth costs nothing) just returns the already-finalized order ids
   *  instead of creating a second order.
   *
   *  Known, disclosed trade-off vs. the Stripe path: there is no
   *  amount/currency cross-check here, because `SafepayPaymentProvider.
   *  handleWebhook` doesn't surface a confirmed charged amount in its event
   *  payload today (only `currency`, not `amount`) — nothing to compare
   *  against. Revisit if a future provider's webhook does carry one. */
  async finalizeGatewayPayment(providerSessionId: string, paymentType: string): Promise<{ orderIds: string[] } | null> {
    const { checkoutModel, paymentTransactionModel, orderModel, addressModel, cartModel } =
      this.databaseService.repositories;

    const transaction = await paymentTransactionModel.findOneAndUpdate(
      { providerSessionId, paymentType, status: 'pending', isDelete: false },
      { status: 'completed', paidAt: new Date() },
      { new: true },
    );

    if (!transaction) {
      const existing = await paymentTransactionModel.findOne({ providerSessionId, paymentType, isDelete: false });
      return existing?.status === 'completed' ? { orderIds: existing.orderIds } : null;
    }

    const checkout = await checkoutModel.findOne({ _id: transaction.checkoutId, isDelete: false });
    if (!checkout || checkout.status === 'completed') {
      return { orderIds: transaction.orderIds };
    }

    const paymentInfo = { paymentType, isPaid: true };

    let orders: any[];
    try {
      orders = await this.createOrder(transaction.userId, checkout, orderModel, addressModel, paymentInfo, paymentInfo);
    } catch (err: any) {
      await paymentTransactionModel.findByIdAndUpdate(transaction._id, { status: 'pending', paidAt: null });
      console.error('createOrder failed while finalizing gateway payment:', err?.message, {
        checkoutId: checkout._id, providerSessionId, paymentType,
      });
      throw new BadRequestException('Order creation failed, will retry');
    }

    await paymentTransactionModel.findByIdAndUpdate(transaction._id, {
      orderIds: orders.map((o: any) => o._id.toString()),
    });
    await checkoutModel.findByIdAndUpdate(checkout._id, { status: 'completed' });
    await this.removeCheckedOutItemsFromCart(transaction.userId, checkout, cartModel);

    // Seller notifications are already sent inside `createOrder()` above —
    // no need to duplicate that here (same as `finalizePaymentIntent`).
    return { orderIds: orders.map((o: any) => o._id.toString()) };
  }

  /** Marks a pending gateway transaction as failed — no order is ever
   *  created, and the checkout is left exactly as it was so the buyer can
   *  retry (same checkout, same or a different payment method). */
  async failGatewayPayment(providerSessionId: string, paymentType: string, reason?: string): Promise<void> {
    const { paymentTransactionModel } = this.databaseService.repositories;
    await paymentTransactionModel.findOneAndUpdate(
      { providerSessionId, paymentType, status: 'pending', isDelete: false },
      { status: 'failed' },
    );
    if (reason) {
      console.error(`Gateway payment failed: ${paymentType} / ${providerSessionId} — ${reason}`);
    }
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
          const result = await this.finalizePaymentIntent(pi);
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

    // Cart is store-scoped — pull the storeId off the checkout's own items
    // (already carried per-item on CheckoutItem) rather than needing a new
    // field, since every item in a checkout now belongs to one store.
    const storeId = (checkout.items as any[])[0]?.storeId;

    await cartModel.findOneAndUpdate(
      { userId, storeId, status: 'active', isDelete: false },
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
      // Pre-flight check against real availability (some of `stock` may
      // already be reserved by another pending order — see
      // ProductVariant.committedStock). The actual atomic guard is
      // `createOrder`'s reserve step below; this is just a fast, friendly
      // fail before that.
      const availablePreCheck = variant.stock - (variant.committedStock || 0);
      // See ProductVariant.allowBackorder — never fails this friendly
      // pre-check; the real gate is createOrder's atomic reserve below.
      if (!variant.unlimitedStock && !(variant as any).allowBackorder && availablePreCheck < item.quantity) {
        throw new BadRequestException(
          `Insufficient stock for ${item.name}. Available: ${availablePreCheck}, required: ${item.quantity}`,
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
      currency: checkout.currency,
      fxSnapshots: checkout.fxSnapshots,
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
      // Same real-availability pre-check as the COD path above — see
      // ProductVariant.allowBackorder for why it's skipped here too.
      const availablePreCheck = variant.stock - (variant.committedStock || 0);
      if (!variant.unlimitedStock && !(variant as any).allowBackorder && availablePreCheck < item.quantity) {
        throw new BadRequestException(`Insufficient stock for ${item.name}. Available: ${availablePreCheck}, required: ${item.quantity}`);
      }
    }

    // If this checkout is already PKR-denominated (the normal case for a
    // Pakistani buyer post-multi-currency-checkout), no conversion is
    // needed at all — checkout.totalAmount already IS the PKR amount to
    // transfer. Only a USD-denominated checkout that still chose this rail
    // needs converting, and that conversion now uses THIS checkout's own
    // frozen fxSnapshots — never the separate, legacy
    // ManualPaymentConfig.usdToPkrRate, which this replaces as the
    // authoritative source (previously two disconnected PKR rates could
    // silently disagree; now there is exactly one).
    let currencyConversion: { code: string; rate: number } | undefined;
    let amountPKR: number;
    let effectiveSnapshots = (checkout.fxSnapshots as any) ?? [];
    if (checkout.currency === 'PKR') {
      amountPKR = checkout.totalAmount;
    } else {
      // PKR wasn't necessarily needed when this checkout's own fxSnapshots
      // were first built (e.g. an all-USD cart with no physical items) —
      // ensureCurrencyInSnapshots fetches+appends it now if missing, and the
      // extended array is persisted back onto the checkout below so this
      // addition becomes part of its permanent record too.
      effectiveSnapshots = await this.exchangeRateService.ensureCurrencyInSnapshots(effectiveSnapshots, 'PKR');
      const ratePerUSD = this.exchangeRateService.convertWithSnapshots(1, 'USD', 'PKR', effectiveSnapshots);
      currencyConversion = { code: 'PKR', rate: ratePerUSD };
      amountPKR = this.round(checkout.totalAmount * ratePerUSD);
    }

    await checkoutModel.findByIdAndUpdate(checkoutId, {
      paymentType: 'manual_bank_transfer',
      status: 'payment_pending',
      fxSnapshots: effectiveSnapshots,
    });
    checkout.fxSnapshots = effectiveSnapshots as any;

    const pendingVerificationInfo = { paymentType: 'manual_bank_transfer', isPaid: false, paymentStatus: 'pending_verification' };
    const orders = await this.createOrder(
      userId, checkout, orderModel, addressModel,
      pendingVerificationInfo, pendingVerificationInfo,
      currencyConversion,
    );

    await paymentTransactionModel.create({
      userId,
      checkoutId: checkout._id.toString(),
      orderIds: orders.map((o: any) => o._id.toString()),
      paymentType: 'manual_bank_transfer',
      amount: amountPKR,
      currency: 'PKR',
      fxSnapshots: checkout.fxSnapshots,
      status: 'pending', // flips to 'completed' only once an admin approves the proof
      stripePaymentIntentId: null,
      stripeClientSecret: null,
      paidAt: null,
    });

    await checkoutModel.findByIdAndUpdate(checkoutId, { status: 'completed' });
    await this.removeCheckedOutItemsFromCart(userId, checkout, cartModel);

    return {
      orders,
      amountPKR,
      fxRate: currencyConversion?.rate ?? 1,
      // Kept as `amountUSD` for backward compatibility with existing
      // consumers (ManualPaymentsService.submitPayment → ManualPaymentProof
      // schema's `amountUSD` field) — now means "the checkout's original
      // amount before PKR conversion," which is only ever literally USD
      // when checkout.currency === 'USD'; equal to amountPKR (no
      // conversion) when the checkout was already PKR. Renaming the
      // ManualPaymentProof field itself is a separate, wider-blast-radius
      // change intentionally left out of this phase.
      amountUSD: checkout.totalAmount,
      originalCurrency: checkout.currency,
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
      // The currency this order was ACTUALLY placed/charged in — permanent,
      // never re-derived from today's rate or the buyer's current display
      // preference (which may have changed since). This was previously
      // missing entirely, so the order-success screen had no choice but to
      // hardcode "$" regardless of what currency the order was really in.
      currency: order.currency,
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
    // Set only when this checkout's Stripe charge was routed directly to a
    // seller's own connected account (see initiatePayment's single-store
    // gate) — COD/manual-bank-transfer callers never pass this, since
    // Connect only ever applies to the online-Stripe-'full' rail.
    connectInfo?: { storeId: string; accountId: string } | null,
  ) {
    const { productVariantModel, productModel, storeModel } =
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

    const orderCurrency = currencyConversion?.code ?? (checkout.currency || 'USD');
    const fxSnapshots = (checkout.fxSnapshots as any) ?? [];
    // Phase 0 — currency normalization: units of `orderCurrency` per 1 USD,
    // captured once here from this checkout's OWN immutable fxSnapshots (see
    // Order.ratePerUSD's schema comment for the full formula/rationale).
    // null only when orderCurrency is non-USD and this checkout genuinely
    // has no matching fxSnapshots entry — should not happen for a real
    // checkout (CheckoutService always builds one), but never fabricated
    // here if it somehow does.
    const ratePerUSD: number | null = orderCurrency === 'USD'
      ? 1
      : (fxSnapshots.find((s: any) => s.currency === orderCurrency)?.ratePerUSD ?? null);
    // Converts `amount` from its OWN source currency into `orderCurrency`,
    // using this checkout's frozen fxSnapshots — never a fresh live rate.
    // Replaces the old single-blanket-multiplier conversion (correct only
    // when every figure shared one currency); a mixed-seller-currency cart
    // needs each figure converted from ITS OWN native currency, not a
    // single global rate applied uniformly.
    const convFrom = (n: number | null | undefined, fromCurrency: string) =>
      n == null ? n : this.exchangeRateService.convertWithSnapshots(n, fromCurrency, orderCurrency, fxSnapshots);
    // Sums `items[].totalPrice`/`[field]` by converting each line from its
    // own native currency into orderCurrency first — never summing raw
    // native-currency numbers across items that can belong to different-
    // currency sellers (mirrors CheckoutService.convertedSubtotal).
    const convertedSum = (items: any[], field: string, filter?: (i: any) => boolean) =>
      this.round(
        (filter ? items.filter(filter) : items).reduce(
          (s: number, i: any) => s + (convFrom(i[field] ?? 0, i.currency ?? checkout.currency) ?? 0),
          0,
        ),
      );

    // --- STOCK RESERVE (atomic, physical only, unlimited variants skip) ---
    // Real stock is NOT decremented here any more — this only reserves
    // (`committedStock += qty`) against the still-genuine on-hand `stock`.
    // The actual decrement happens once the seller marks the order
    // "shipped" (OrdersService.updateSellerOrderStatus) — see
    // ProductVariant.committedStock's doc comment for the full model.
    // Guard is `stock - committedStock >= quantity` (i.e. real availability),
    // via `$expr` since Mongo can't compare two of a document's own fields
    // in a plain query filter.
    const reserved: { variantId: string; quantity: number }[] = [];
    // See ProductVariant.allowBackorder — a checkout-only, per-variant
    // "continue selling when out of stock" toggle. A variant reserved here
    // while genuinely short is recorded so the built order line can be
    // flagged `isBackordered: true` below (informational only).
    const backorderedVariantIds = new Set<string>();

    for (const item of physicalItems) {
      const variant = await productVariantModel
        .findOne({ _id: item.variantId, isDelete: false })
        .select('unlimitedStock allowBackorder stock committedStock')
        .lean();
      if (!variant || (variant as any).unlimitedStock) continue;

      if ((variant as any).allowBackorder) {
        // No availability guard at all — this variant is explicitly allowed
        // to go negative. Still a real atomic $inc (never a blind write),
        // just without the $expr floor the strict path below enforces.
        await productVariantModel.updateOne(
          { _id: item.variantId, isDelete: false },
          { $inc: { committedStock: item.quantity } },
        );
        const availableBefore = ((variant as any).stock || 0) - ((variant as any).committedStock || 0);
        if (availableBefore < item.quantity) backorderedVariantIds.add(item.variantId);
        reserved.push({ variantId: item.variantId, quantity: item.quantity });
        continue;
      }

      const res = await productVariantModel.updateOne(
        {
          _id: item.variantId,
          isDelete: false,
          $expr: { $gte: [{ $subtract: ['$stock', '$committedStock'] }, item.quantity] },
        },
        { $inc: { committedStock: item.quantity } },
      );

      if (res.modifiedCount === 0) {
        for (const d of reserved) {
          await productVariantModel.updateOne(
            { _id: d.variantId },
            { $inc: { committedStock: -d.quantity } },
          );
        }
        throw new BadRequestException(
          `Stock not available for item: ${item.name}`,
        );
      }
      reserved.push({ variantId: item.variantId, quantity: item.quantity });
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
          country: address.country ?? null,
        };
      }
    }

    // Every seller is always credited in THEIR OWN Store.baseCurrency,
    // regardless of what currency the buyer paid in (see
    // SellerOrder.settlementCurrency/settlementAmount's schema comment) —
    // batch-fetched once per distinct store, same one-query-instead-of-N
    // pattern used elsewhere in this codebase.
    const allStoreIds = [...new Set(checkout.items.map((i: any) => i.storeId))] as string[];
    const storesById = new Map(
      (
        await storeModel.find({ _id: { $in: allStoreIds } }).select('baseCurrency').lean()
      ).map((s: any) => [s._id.toString(), s]),
    );

    // --- helper: ek type ke items ko store-wise sellerOrders me ---
    const buildSellerOrders = (items: any[]) => {
      const storeMap: Record<string, any[]> = {};
      for (const item of items) {
        const key = item.storeId || item.sellerId;
        if (!storeMap[key]) storeMap[key] = [];
        storeMap[key].push(item);
      }

      return Object.values(storeMap).map((storeItems) => {
        // Every item in one group belongs to the same store, hence the
        // same native currency — safe to sum raw here (unlike the
        // order-level rollups below, which span multiple stores/currencies).
        const storeCurrency = storeItems[0].currency ?? checkout.currency;
        const subtotalNative = storeItems.reduce((s, i) => s + i.totalPrice, 0);
        const sellerStoreId = storeItems[0].storeId;
        const settlementCurrency = storesById.get(sellerStoreId)?.baseCurrency ?? storeCurrency;
        // Only items whose campaign is platform-sponsored count toward this
        // restoring this seller's payout — see FinanceService.recordSale.
        const platformSponsoredDiscountUSDNative = storeItems.reduce(
          (s, i) =>
            s +
            (i.campaignSponsorType === 'platform'
              ? (i.campaignDiscountUSD ?? 0)
              : 0),
          0,
        );
        // Sum of this store's items' own taxUSD (see CheckoutItem.taxUSD) —
        // the buyer was actually charged this at checkout; folding it into
        // settlementAmount below is what makes the seller actually receive
        // it, instead of it being charged but never credited to anyone.
        const taxAmountNative = storeItems.reduce((s, i) => s + (i.taxUSD ?? 0), 0);
        // Settlement basis: `storeCurrency` IS this seller's own
        // Store.baseCurrency (settlementCurrency) by construction — an
        // item's `currency` was stamped from its owning store at
        // checkout-item-build time (see CheckoutService.createCheckout).
        // So the native (never-converted) figures ARE already exactly what
        // the seller is credited — no conversion, and no risk of
        // compounding rounding error from converting native→orderCurrency
        // and back again just to arrive at the same number.
        const settlementAmount = this.round(subtotalNative + platformSponsoredDiscountUSDNative + taxAmountNative);
        const isConnectSettled = connectInfo?.storeId === sellerStoreId;
        return {
          sellerId: storeItems[0].sellerId,
          storeId: storeItems[0].storeId,
          fulfillmentType: storeItems[0].type, // 'physical' ya 'digital'
          settlementCurrency,
          settlementAmount,
          settledViaConnect: isConnectSettled,
          stripeConnectedAccountId: isConnectSettled ? connectInfo!.accountId : null,
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
            price: convFrom(i.price, storeCurrency),
            totalPrice: convFrom(i.totalPrice, storeCurrency),
            originalPrice: convFrom(i.originalPrice ?? null, storeCurrency),
            subscriberDiscountUSD: convFrom(i.subscriberDiscountUSD ?? 0, storeCurrency),
            couponDiscountUSD: convFrom(i.couponDiscountUSD ?? 0, storeCurrency),
            giftCardDiscountUSD: convFrom(i.giftCardDiscountUSD ?? 0, storeCurrency),
            campaignId: i.campaignId ?? null,
            campaignDiscountUSD: convFrom(i.campaignDiscountUSD ?? 0, storeCurrency),
            campaignSponsorType: i.campaignSponsorType ?? null,
            autoDiscountId: i.autoDiscountId ?? null,
            autoDiscountUSD: convFrom(i.autoDiscountUSD ?? 0, storeCurrency),
            taxUSD: convFrom(i.taxUSD ?? 0, storeCurrency),
            isBackordered: i.variantId ? backorderedVariantIds.has(i.variantId) : false,
            status: 'pending',
          })),
          subtotal: convFrom(subtotalNative, storeCurrency),
          platformSponsoredDiscountUSD: convFrom(platformSponsoredDiscountUSDNative, storeCurrency),
          taxAmount: convFrom(taxAmountNative, storeCurrency),
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
      // Spans potentially multiple sellers/currencies — each item is
      // converted from its OWN native currency into orderCurrency before
      // summing (convertedSum), never summed raw across mixed currencies.
      const subtotal = convertedSum(physicalItems, 'totalPrice');
      // checkout.shippingFee is always already in checkout.currency (see
      // CheckoutService.addShippingInCheckout) — convert it into
      // orderCurrency the same way (a no-op when they're the same, as in
      // every case except manual-bank-transfer).
      const shippingFee = convFrom(checkout.shippingFee || 0, checkout.currency) ?? 0;
      const subscriberDiscountTotal = convertedSum(physicalItems, 'subscriberDiscountUSD');
      const couponDiscountTotal = convertedSum(physicalItems, 'couponDiscountUSD');
      const giftCardDiscountTotal = convertedSum(physicalItems, 'giftCardDiscountUSD');
      const autoDiscountTotal = convertedSum(physicalItems, 'autoDiscountUSD');
      const campaignDiscountTotal = convertedSum(physicalItems, 'campaignDiscountUSD');
      const platformSponsoredDiscountTotal = convertedSum(
        physicalItems, 'campaignDiscountUSD', (i) => i.campaignSponsorType === 'platform',
      );
      // See CheckoutItem.taxUSD's doc comment — this is the buyer's actual
      // tax charge for this order's items, real money already folded into
      // `checkout.totalAmount` at checkout time. Must be added into this
      // order's own `totalAmount` too, or the two would silently disagree.
      const taxTotal = convertedSum(physicalItems, 'taxUSD');

      const physicalOrder = await orderModel.create({
        orderNumber: genOrderNumber(),
        userId,
        checkoutId: checkout._id.toString(),
        currency: orderCurrency,
        fxSnapshots,
        ratePerUSD,
        sellerOrders,
        shippingAddress,
        subtotal,
        shippingFee,
        taxAmount: taxTotal,
        subscriberDiscountTotal,
        couponCode: couponDiscountTotal > 0 ? checkout.couponCode : null,
        couponDiscountTotal,
        giftCardCode: giftCardDiscountTotal > 0 ? checkout.giftCardCode : null,
        giftCardDiscountTotal,
        campaignDiscountTotal,
        autoDiscountTotal,
        platformSponsoredDiscountTotal,
        totalAmount: this.round(subtotal + shippingFee + taxTotal),
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
      const subtotal = convertedSum(digitalItems, 'totalPrice');
      const subscriberDiscountTotal = convertedSum(digitalItems, 'subscriberDiscountUSD');
      const couponDiscountTotal = convertedSum(digitalItems, 'couponDiscountUSD');
      const giftCardDiscountTotal = convertedSum(digitalItems, 'giftCardDiscountUSD');
      const autoDiscountTotal = convertedSum(digitalItems, 'autoDiscountUSD');
      const campaignDiscountTotal = convertedSum(digitalItems, 'campaignDiscountUSD');
      const platformSponsoredDiscountTotal = convertedSum(
        digitalItems, 'campaignDiscountUSD', (i) => i.campaignSponsorType === 'platform',
      );
      const taxTotal = convertedSum(digitalItems, 'taxUSD');

      const digitalOrder = await orderModel.create({
        orderNumber: genOrderNumber(),
        userId,
        checkoutId: checkout._id.toString(),
        currency: orderCurrency,
        fxSnapshots,
        ratePerUSD,
        sellerOrders,
        shippingAddress: null,
        subtotal,
        shippingFee: 0,
        taxAmount: taxTotal,
        subscriberDiscountTotal,
        couponCode: couponDiscountTotal > 0 ? checkout.couponCode : null,
        couponDiscountTotal,
        giftCardCode: giftCardDiscountTotal > 0 ? checkout.giftCardCode : null,
        giftCardDiscountTotal,
        campaignDiscountTotal,
        autoDiscountTotal,
        platformSponsoredDiscountTotal,
        totalAmount: this.round(subtotal + taxTotal),
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

    // Affiliate commission — a no-op unless this checkout carried a real
    // referral code from a click-through (see AffiliateService.recordConversion
    // for how a multi-store cart only credits the referring store's portion).
    if (checkout.attributedAffiliateCode) {
      this.affiliateService.recordConversion(String(checkout._id), checkout.attributedAffiliateCode, createdOrders).catch(() => {});
    }

    // purchaseCount increment — har item ke product pe
    for (const item of checkout.items) {
      await productModel.findByIdAndUpdate(item.productId, {
        $inc: { purchaseCount: item.quantity },
      });
    }

    // Coupon/reward-voucher usage is only counted once the order is
    // actually placed (not at apply time) — an abandoned/expired checkout
    // must not consume a limited-use coupon or a redeemed reward voucher.
    // `couponStoreId` is legitimately null for a scope:'platform' coupon
    // (see Coupon schema) — the old `&& checkout.couponStoreId` guard
    // treated that as "no coupon applied" and silently skipped the
    // increment, so a platform-wide coupon's `usageLimit` was never
    // enforced. Match on scope explicitly instead.
    if (checkout.couponCode) {
      if (checkout.couponSourceType === 'reward_voucher') {
        await this.databaseService.repositories.rewardVoucherModel.updateOne(
          { storeId: checkout.couponStoreId, code: checkout.couponCode, status: 'active' },
          { status: 'used', usedAt: new Date(), checkoutId: String(checkout._id), orderId: String(createdOrders[0]?._id ?? '') },
        );
      } else {
        await this.databaseService.repositories.couponModel.updateOne(
          checkout.couponStoreId
            ? { storeId: checkout.couponStoreId, code: checkout.couponCode, scope: 'seller' }
            : { code: checkout.couponCode, scope: 'platform' },
          { $inc: { usageCount: 1 } },
        );
      }
    }

    // Gift card balance is likewise only decremented once the order is
    // actually placed, not at apply-coupon-style time — an abandoned
    // checkout must not spend real gift-card value.
    if (checkout.giftCardCode && checkout.giftCardStoreId && checkout.giftCardDiscountTotalUSD > 0) {
      await this.giftCardsService.redeemAtOrderPlacement(
        checkout.giftCardStoreId,
        checkout.giftCardCode,
        checkout.giftCardDiscountTotalUSD,
        String(checkout._id),
        String(createdOrders[0]?._id ?? ''),
      );
    }

    // Closes the Abandoned Cart Recovery loop — a no-op unless a recovery
    // email had genuinely already been sent for THIS checkout (see the
    // method's own doc comment), so a normal same-session purchase is never
    // miscounted as a "recovery".
    this.abandonedCartService.markRecovered(String(checkout._id)).catch(() => {});

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

    // Order-confirmation email to the buyer — one per STORE in this
    // checkout (a checkout can still span >1 sellerOrder), same convention
    // as real Shopify: the store's own `contactEmail` becomes the email's
    // reply-to, so a buyer hitting "reply" reaches that seller directly,
    // never the platform's shared SMTP sender. Fire-and-forget, same as
    // every other side-effect above — a slow/broken SMTP must never block
    // order placement.
    this.sendOrderConfirmationEmails(userId, createdOrders, orderCurrency, storeModel).catch(() => {});

    return createdOrders;
  }

  private async sendOrderConfirmationEmails(
    userId: string,
    createdOrders: any[],
    orderCurrency: string,
    storeModel: any,
  ) {
    const buyer = await this.databaseService.repositories.userModel
      .findById(userId)
      .select('email')
      .lean();
    if (!buyer?.email) return;

    const byStore = new Map<string, { items: any[]; subtotal: number; orderNumbers: Set<string> }>();
    for (const createdOrder of createdOrders) {
      for (const so of createdOrder.sellerOrders) {
        const entry = byStore.get(so.storeId) ?? { items: [], subtotal: 0, orderNumbers: new Set<string>() };
        entry.items.push(...so.items);
        entry.subtotal += so.subtotal ?? 0;
        entry.orderNumbers.add(createdOrder.orderNumber);
        byStore.set(so.storeId, entry);
      }
    }
    if (byStore.size === 0) return;

    const stores = await storeModel
      .find({ _id: { $in: [...byStore.keys()] } })
      .select('name contactEmail')
      .lean();
    const storeById = new Map(stores.map((s: any) => [String(s._id), s]));

    for (const [storeId, entry] of byStore) {
      const store = storeById.get(storeId) as { name?: string; contactEmail?: string } | undefined;
      const storeName = store?.name ?? 'your order';
      const itemRows = entry.items
        .map(
          (i: any) =>
            `<tr><td style="padding:6px 0;">${i.name} &times; ${i.quantity}</td><td style="padding:6px 0; text-align:right;">${(i.totalPrice ?? 0).toFixed(2)} ${orderCurrency}</td></tr>`,
        )
        .join('');
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color:#222;">
          <h2 style="margin-bottom: 4px;">Thanks for your order!</h2>
          <p style="color:#555;">Order ${[...entry.orderNumbers].join(', ')} from <strong>${storeName}</strong> is confirmed.</p>
          <table style="width:100%; border-collapse:collapse; margin:16px 0;">${itemRows}</table>
          <p style="font-weight:bold; text-align:right;">Total: ${entry.subtotal.toFixed(2)} ${orderCurrency}</p>
          <p style="color:#888; font-size:13px;">Questions about this order? Just reply to this email.</p>
        </div>`;
      this.emailService
        .sendMail(buyer.email, `Your order from ${storeName} is confirmed`, html, store?.contactEmail ?? null)
        .catch(() => {});
    }
  }
}
