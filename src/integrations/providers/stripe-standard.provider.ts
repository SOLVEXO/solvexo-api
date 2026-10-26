/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectionTestResult,
  DecryptedPaymentConfig,
  PaymentEvent,
  PaymentOrderContext,
  PaymentProvider,
  PaymentSession,
  PaymentStatus,
  RefundResult,
} from '../interfaces/payment-provider.interface';
import { StripeOwnPaymentProvider } from './stripe-own.provider';

/**
 * Stripe Connect STANDARD account + DIRECT charges — the global, zero-fee card rail (Stripe's own docs name Shopify as a
 * Standard-account platform). The seller owns a normal Stripe account (created and onboarded through Stripe's hosted
 * flow, see StoreIntegrationsService.startStripeStandard); every Checkout Session is created ON that account with the
 * platform's key and the `Stripe-Account` header, so:
 *  - the buyer's money goes straight to the seller's Stripe balance, the platform never holds it (CORE RULE 2);
 *  - Stripe bills its processing fee to the seller directly, so there is NO application fee to pass through (the admin
 *    "custom per-seller rate" is not applied on this rail);
 *  - it works in every country Stripe supports, not only the platform's own country (unlike destination charges).
 * All request building is shared with StripeOwnPaymentProvider (hosted Checkout, verify, refund); this class only swaps
 * the credentials: platform secret key + the seller's connected account id (`config.config.accountId`).
 * Results arrive on the platform's Connect webhook (PaymentService.stripeWebhook -> reconcile) or through the return
 * page / stuck-payment safety net; this provider has no webhook of its own.
 * NOT run against a live/sandbox Stripe account.
 */
@Injectable()
export class StripeStandardPaymentProvider implements PaymentProvider {
  readonly providerKey = 'stripe_standard' as const;
  readonly callbackIsAuthoritative = false;

  constructor(
    private readonly inner: StripeOwnPaymentProvider,
    private readonly configService: ConfigService,
  ) {}

  /** The same request on the seller's connected account with the platform's own key. */
  private onSellerAccount(config: DecryptedPaymentConfig): DecryptedPaymentConfig {
    const accountId = config?.config?.accountId;
    if (!accountId || typeof accountId !== 'string') throw new Error('The seller has not connected a Stripe account yet');
    const key = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (!key) throw new Error('Stripe is not configured on the platform');
    return {
      ...config,
      mode: key.startsWith('sk_live_') ? 'live' : 'sandbox',
      credentials: { secretKey: key, connectedAccountId: accountId },
    };
  }

  testConnection(config: DecryptedPaymentConfig): Promise<ConnectionTestResult> {
    let mapped: DecryptedPaymentConfig;
    try { mapped = this.onSellerAccount(config); } catch (err: any) { return Promise.resolve({ ok: false, message: err.message }); }
    return this.inner.testConnection(mapped);
  }

  async initiatePayment(order: PaymentOrderContext, config: DecryptedPaymentConfig): Promise<PaymentSession> {
    return this.inner.initiatePayment(order, this.onSellerAccount(config));
  }

  async verifyPayment(sessionId: string, config: DecryptedPaymentConfig): Promise<PaymentStatus> {
    return this.inner.verifyPayment(sessionId, this.onSellerAccount(config));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- connected-account events are verified by the platform webhook, not here
  async handleWebhook(): Promise<PaymentEvent> {
    throw new Error('Stripe results for connected accounts arrive on the platform Stripe webhook');
  }

  refund(transactionId: string, amount: number, config: DecryptedPaymentConfig): Promise<RefundResult> {
    let mapped: DecryptedPaymentConfig;
    try { mapped = this.onSellerAccount(config); } catch { return Promise.resolve({ success: false, refundId: '', amount, status: 'failed' }); }
    return this.inner.refund(transactionId, amount, mapped);
  }

  getPublicConfig(config: Record<string, any>) {
    return { displayName: config.displayName ?? 'Card payment (Stripe)', currency: config.currency ?? '', logo: config.logo };
  }
}
