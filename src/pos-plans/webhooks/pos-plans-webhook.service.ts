/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { PlatformTaxService } from '@/platform-tax/platform-tax.service';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../database/databaseservice';
import { PaymentGatewayService } from '../../subscriptions/payment-gateway/payment-gateway.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The only event that matters for a fixed-term one-time-purchase model —
 * much simpler than a subscription webhook surface. No
 * customer.subscription.* handling: a failed one-time payment simply never
 * produces a checkout.session.completed, so there's nothing to reconcile.
 */
@Injectable()
export class PosPlansWebhookService {
  private readonly logger = new Logger(PosPlansWebhookService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly paymentGatewayService: PaymentGatewayService,
    private readonly config: ConfigService,
    @Optional() private readonly platformTax?: PlatformTaxService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  async receive(rawBody: Buffer, signatureHeader: string | string[] | undefined) {
    const stripe = this.paymentGatewayService.stripeClient;
    if (!stripe) throw new BadRequestException('Stripe is not configured on this environment');

    const webhookSecret = this.config.get<string>('POS_PLANS_STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) throw new Error('POS_PLANS_STRIPE_WEBHOOK_SECRET is not set');

    let event: any;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signatureHeader as string, webhookSecret);
    } catch (err: any) {
      throw new BadRequestException(`Webhook signature verification failed: ${err.message}`);
    }

    return this.handleEvent(event);
  }

  /** Public so the event handling can be tested without Stripe signatures. */
  async handleEvent(event: any) {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return this.onCheckoutPaid(event.data.object);
      case 'charge.refunded':
        return this.onChargeRefunded(event.data.object);
      case 'charge.dispute.created':
        return this.onDisputeCreated(event.data.object);
      default:
        return { received: true };
    }
  }

  private async onCheckoutPaid(session: any) {
    if (session.mode !== 'payment' || session.metadata?.type !== 'pos_purchase') {
      return { received: true };
    }
    // Async payment methods complete the session before the money arrives: only a PAID session grants access.
    if (session.payment_status && session.payment_status !== 'paid') {
      return { received: true, pending: true };
    }

    const { storeId, sellerId, planId, durationInDays } = session.metadata as Record<string, string>;
    if (!storeId || !sellerId || !planId || !durationInDays) {
      this.logger.error(`checkout.session.completed missing pos_purchase metadata: ${session.id}`);
      return { received: true };
    }

    // Redelivery (or the second of completed + async_payment_succeeded): already recorded → no-op, before any maths.
    if (await this.r.posPurchaseModel.exists({ stripeCheckoutSessionId: session.id })) return { received: true, duplicate: true };

    // Snapshot from the live plan at webhook time — durationInDays comes from metadata instead (see
    // PosPlansService.createCheckoutSession) so it's immune to the plan being edited between checkout and this webhook.
    const plan = await this.r.posPlanModel.findById(planId);
    const purchasedAt = new Date();
    // Buying BEFORE expiry stacks: the new term starts when the current one ends (never earlier than now).
    const latest: any = await this.r.posPurchaseModel.findOne({ storeId }).sort({ purchasedAt: -1 }).lean();
    const base = latest && new Date(latest.expiresAt).getTime() > purchasedAt.getTime() ? new Date(latest.expiresAt).getTime() : purchasedAt.getTime();
    const expiresAt = new Date(base + Number(durationInDays) * DAY_MS);

    try {
      await this.r.posPurchaseModel.create({
        storeId,
        sellerId,
        planId,
        planNameSnapshot: plan?.name ?? 'Unknown Plan',
        priceSnapshot: plan?.price ?? 0,
        currencySnapshot: plan?.currency ?? 'USD',
        durationInDaysSnapshot: Number(durationInDays),
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        purchasedAt,
        expiresAt,
      });
    } catch (err: any) {
      // Stripe redelivers webhooks — the unique index on stripeCheckoutSessionId makes a concurrent retry a no-op too.
      if (err.code === 11000) return { received: true, duplicate: true };
      throw err;
    }

    // Solvexo's own tax inside this checkout (Stripe Checkout line-item tax), for the admin's tax report.
    await this.platformTax?.recordCollected({
      source: 'pos_plan', refId: session.id, storeId,
      taxMinor: Number(session.total_details?.amount_tax) || 0, currency: session.currency ?? plan?.currency ?? 'usd',
    });

    return { received: true };
  }

  // ── Refunds & disputes ──────────────────────────────────────────────────────────────────────────

  /** A FULL refund takes the purchase's days back. A partial refund is left alone (the seller was only partly repaid). */
  private async onChargeRefunded(charge: any) {
    const full = Number(charge.amount) > 0 && Number(charge.amount_refunded) >= Number(charge.amount);
    if (!full) return { received: true, ignored: 'partial_refund' };
    return this.reverseByPaymentIntent(charge.payment_intent, 'refunded');
  }

  /** A dispute freezes the money, so access ends the same way; if it is later won the owner/admin can extend manually. */
  private async onDisputeCreated(dispute: any) {
    return this.reverseByPaymentIntent(dispute.payment_intent, 'disputed');
  }

  /**
   * Takes ONE purchase's days back, exactly once (atomic `reversedAt: null` claim → a redelivered event is a no-op):
   *  - the purchase is stamped reversed;
   *  - if its term is still running, the store's CURRENT latest expiry is shortened by that purchase's duration (floored at
   *    now) — so a refunded purchase that was stacked under a newer one shortens the newer expiry instead of being ignored,
   *    and a refunded latest purchase falls back to where the previous term ended;
   *  - a term that had already fully elapsed changes nothing but the stamp.
   * Manual admin rows are never reversed by Stripe events (they have no payment intent).
   */
  private async reverseByPaymentIntent(paymentIntent: unknown, reason: 'refunded' | 'disputed') {
    const pi = typeof paymentIntent === 'string' ? paymentIntent : null;
    if (!pi) return { received: true };
    const now = new Date();
    const purchase: any = await this.r.posPurchaseModel.findOneAndUpdate(
      { stripePaymentIntentId: pi, source: { $ne: 'manual' }, reversedAt: null },
      { $set: { reversedAt: now, reversedReason: reason } },
      { new: true },
    ).lean();
    if (!purchase) return { received: true, duplicate: true };
    if (purchase.revokedAt) return { received: true }; // an admin already ended it

    const latest: any = await this.r.posPurchaseModel.findOne({ storeId: purchase.storeId }).sort({ purchasedAt: -1 }).lean();
    if (!latest || new Date(latest.expiresAt).getTime() <= now.getTime()) return { received: true };
    // Only the part of the refunded term that has NOT been used yet is taken back (a term that already ended takes nothing).
    const unused = Math.min(Number(purchase.durationInDaysSnapshot) * DAY_MS, new Date(purchase.expiresAt).getTime() - now.getTime());
    if (unused <= 0) return { received: true };
    const shortened = Math.max(now.getTime(), new Date(latest.expiresAt).getTime() - unused);
    await this.r.posPurchaseModel.updateOne({ _id: latest._id }, { $set: { expiresAt: new Date(shortened) } });
    this.logger.warn(`POS purchase ${purchase._id} ${reason}: store ${purchase.storeId} access now ends ${new Date(shortened).toISOString()}`);
    return { received: true, reversed: true };
  }
}
