/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { StripeConnectService } from '@/stripe-connect/stripe-connect.service';
import { CommissionRulesService } from '@/commission-rules/commission-rules.service';
import {
  DecryptedPaymentConfig,
  PaymentEvent,
  PaymentOrderContext,
  PaymentProvider,
  PaymentSession,
  PaymentStatus,
  RefundResult,
} from '../interfaces/payment-provider.interface';

/**
 * Stripe — international (USD) provider, deliberately NOT a raw-secret-key
 * integration like the Pakistani gateways.
 *
 * `PaymentService`/`StripeConnectService` (src/payment, src/stripe-connect)
 * already implement a working marketplace-model Stripe integration: ONE
 * platform Stripe account, each seller a Connect account under it
 * (`Seller.stripeConnectedAccountId`), charges routed to the seller via
 * `transfer_data.destination` (see payment.service.ts:289-316) once
 * `StripeConnectService.getEligibleConnectAccountForStore` confirms the
 * account is fully charges+payouts enabled. Asking sellers to additionally
 * paste in their own raw Stripe secret key here would create a second,
 * conflicting way to move their money and duplicate work that's already in
 * production — so this class is a thin adapter over that existing
 * mechanism, not a new credential store. `StoreIntegration.credentialsEncrypted`
 * stays null for `provider: 'stripe'`; `config` only ever holds non-secret
 * display fields, and status is derived from Connect onboarding state.
 *
 * Webhooks: also NOT routed through the new per-store `webhookToken` scheme.
 * Connect events for every seller already arrive at the existing platform
 * webhook endpoint (payment.controller.ts) against ONE platform webhook
 * secret, and are attributed to a store via the event's own `account` field
 * (the connected account id) — not a per-store URL. `handleWebhook` here
 * exists only so this provider satisfies the shared interface; it is not
 * wired to a new route.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly providerKey = 'stripe' as const;
  private readonly logger = new Logger(StripePaymentProvider.name);
  private readonly stripe: InstanceType<typeof Stripe> | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly stripeConnectService: StripeConnectService,
    private readonly commissionRulesService: CommissionRulesService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (secretKey) {
      this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
    } else {
      this.logger.warn('STRIPE_SECRET_KEY not set — Stripe integration provider is disabled.');
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `config` is part of the shared PaymentProvider signature; unused here since this provider never reads StoreIntegration.credentials (see class doc).
  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    if (!this.stripe) throw new Error('Stripe is not configured on this platform.');

    const connectAccountId = await this.stripeConnectService.getEligibleConnectAccountForStore(order.storeId);
    if (!connectAccountId) {
      throw new Error('This store has not completed Stripe Connect onboarding yet — cannot accept Stripe payments.');
    }

    const amountCents = Math.round(order.amount * 100);
    const { rate } = await this.commissionRulesService.resolveRate(order.storeId);
    const applicationFeeAmountCents = Math.round(amountCents * rate);

    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      metadata: { orderId: order.orderId, storeId: order.storeId },
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      transfer_data: { destination: connectAccountId },
      application_fee_amount: applicationFeeAmountCents,
    });

    return { clientToken: paymentIntent.client_secret ?? undefined, sessionId: paymentIntent.id };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see initiatePayment
  async verifyPayment(reference: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    if (!this.stripe) throw new Error('Stripe is not configured on this platform.');
    const paymentIntent = await this.stripe.paymentIntents.retrieve(reference);
    return {
      status: paymentIntent.status === 'succeeded' ? 'paid' : paymentIntent.status === 'canceled' ? 'failed' : 'pending',
      providerReference: paymentIntent.id,
      amount: paymentIntent.amount / 100,
      currency: 'USD',
      raw: paymentIntent as any,
    };
  }

  /** Not wired to a route — see class doc. Kept for interface completeness only. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/require-await -- see initiatePayment; constructEvent is synchronous but the interface is async for providers that do need to await
  async handleWebhook(rawBody: Buffer, headers: Record<string, string>, config: DecryptedPaymentConfig): Promise<PaymentEvent> {
    if (!this.stripe) throw new Error('Stripe is not configured on this platform.');
    const webhookSecret = this.configService.get<string>('STRIPE_WEBHOOK_SECRET');
    const signature = headers['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret!);
    const paymentIntent = event.data.object as any;
    const status: PaymentStatus['status'] = event.type === 'payment_intent.succeeded' ? 'paid' : 'failed';
    return {
      type: status === 'paid' ? 'payment_succeeded' : 'payment_failed',
      externalEventId: event.id,
      sessionId: paymentIntent.id,
      status: { status, providerReference: paymentIntent.id, currency: 'USD', raw: paymentIntent },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see initiatePayment
  async refund(transactionId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    if (!this.stripe) throw new Error('Stripe is not configured on this platform.');
    // Every charge through this provider is Connect-settled by construction
    // (initiatePayment refuses to run without an eligible connected
    // account) — a plain refund would try pulling funds from the platform's
    // own balance, which never received them, so the transfer must always
    // be explicitly reversed (mirrors payment.service.ts's own refund call).
    const refund = await this.stripe.refunds.create({
      payment_intent: transactionId,
      amount: Math.round(amount * 100),
      reverse_transfer: true,
      refund_application_fee: true,
    });
    return {
      success: refund.status === 'succeeded' || refund.status === 'pending',
      refundId: refund.id,
      amount,
      status: refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' ? 'failed' : 'pending',
    };
  }

  getPublicConfig(config: Record<string, any>) {
    return {
      displayName: config.displayName ?? 'Card payment (Stripe)',
      currency: 'USD' as const,
      logo: config.logo,
    };
  }
}
