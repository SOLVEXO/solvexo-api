/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
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

    if (event.type !== 'checkout.session.completed') {
      return { received: true };
    }

    const session = event.data.object;
    if (session.mode !== 'payment' || session.metadata?.type !== 'pos_purchase') {
      return { received: true };
    }

    const { storeId, sellerId, planId, durationInDays } = session.metadata as Record<string, string>;
    if (!storeId || !sellerId || !planId || !durationInDays) {
      this.logger.error(`checkout.session.completed missing pos_purchase metadata: ${session.id}`);
      return { received: true };
    }

    // Snapshot from the live plan at webhook time — durationInDays comes
    // from metadata instead (see PosPlansService.createCheckoutSession) so
    // it's immune to the plan being edited between checkout creation and
    // this webhook landing.
    const plan = await this.r.posPlanModel.findById(planId);
    const purchasedAt = new Date();
    const expiresAt = new Date(purchasedAt.getTime() + Number(durationInDays) * DAY_MS);

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
      // Stripe redelivers webhooks — the unique index on
      // stripeCheckoutSessionId makes a retry a no-op, not a duplicate
      // purchase.
      if (err.code === 11000) return { received: true, duplicate: true };
      throw err;
    }

    return { received: true };
  }
}
