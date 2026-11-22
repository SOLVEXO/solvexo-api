/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import {
  IPaymentGateway, ChargeResult, CreateProviderSubResult, ChargeContext,
  CreateCustomerResult, SetupIntentResult, BillingPortalResult, CheckoutSessionResult, RefundResult,
} from './payment-gateway.interface';
import { ManualPaymentProvider } from './manual-payment.provider';
import { StripePaymentProvider } from './stripe-payment.provider';

/**
 * PaymentGatewayService — Stripe is the single production payment provider.
 *
 * PAYMENT_PROVIDER=stripe  → StripePaymentProvider (default — real Stripe;
 *   test vs. live mode is controlled entirely by which STRIPE_SECRET_KEY
 *   value is configured, sk_test_... vs sk_live_..., never by code).
 * PAYMENT_PROVIDER=manual  → ManualPaymentProvider, a no-op stub that moves
 *   no real money — kept ONLY as an explicit local-dev/CI opt-in (refuses to
 *   start under NODE_ENV=production) so tests never need live Stripe
 *   credentials; it is not a second real payment provider.
 */
@Injectable()
export class PaymentGatewayService implements IPaymentGateway, OnModuleInit {
  private readonly logger = new Logger(PaymentGatewayService.name);
  private readonly provider: IPaymentGateway;
  readonly providerName: 'manual' | 'stripe';

  constructor(private readonly config: ConfigService) {
    this.providerName = (config.get<string>('PAYMENT_PROVIDER') as 'manual' | 'stripe') ?? 'stripe';

    if (this.providerName === 'manual' && config.get<string>('NODE_ENV') === 'production') {
      throw new Error('PAYMENT_PROVIDER=manual is not allowed in production — Stripe is the only supported production payment provider. Set PAYMENT_PROVIDER=stripe (or leave it unset) with a real STRIPE_SECRET_KEY.');
    }

    if (this.providerName === 'stripe') {
      const secretKey = config.get<string>('STRIPE_SECRET_KEY');
      if (!secretKey) {
        throw new Error('PAYMENT_PROVIDER=stripe requires STRIPE_SECRET_KEY to be set in the environment');
      }
      this.provider = new StripePaymentProvider(secretKey);
    } else {
      this.provider = new ManualPaymentProvider();
    }
  }

  onModuleInit() {
    this.logger.log(`Subscription billing running on payment provider: "${this.providerName}"`);
    if (this.providerName === 'manual') {
      this.logger.warn('PAYMENT_PROVIDER=manual — no real money will move. This is a dev/CI-only stub; production always requires PAYMENT_PROVIDER=stripe.');
    }
  }

  /** True when the active provider bills subscriptions itself via its own async webhook-driven cycle (Stripe), as opposed to our own cron actively charging (manual). */
  get isProviderDrivenBilling(): boolean {
    return this.providerName === 'stripe';
  }

  /** Exposes the raw Stripe client for webhook signature verification — undefined for the manual provider. */
  get stripeClient(): InstanceType<typeof Stripe> | undefined {
    return this.provider instanceof StripePaymentProvider ? this.provider.client : undefined;
  }

  chargeSubscription(subscriptionId: string, amountUSD: number, context?: ChargeContext): Promise<ChargeResult> {
    return this.provider.chargeSubscription(subscriptionId, amountUSD, context);
  }

  /**
   * Live status of a PaymentIntent we created for `internalSubscriptionId` (null if it is not ours / not found / manual provider).
   * Used to verify a 3DS confirmation server-side instead of trusting the browser.
   */
  async getPaymentIntentStatus(paymentIntentId: string, internalSubscriptionId: string): Promise<string | null> {
    const client = this.stripeClient;
    if (!client || !paymentIntentId) return null;
    try {
      const pi = await client.paymentIntents.retrieve(paymentIntentId);
      if (String(pi.metadata?.internalSubscriptionId ?? '') !== String(internalSubscriptionId)) return null;
      return pi.status;
    } catch (err: any) {
      this.logger.warn(`getPaymentIntentStatus(${paymentIntentId}) failed: ${err?.message}`);
      return null;
    }
  }

  /**
   * The latest invoice of a Stripe subscription WE created for `internalSubscriptionId` (its metadata must match), with
   * its PaymentIntent expanded — or null when it is not ours / not found / manual provider. Lets a paid purchase be
   * applied from Stripe's own record when its webhook is late or never arrived. Never throws.
   */
  async getLatestSubscriptionInvoice(providerSubscriptionId: string, internalSubscriptionId: string): Promise<any> {
    const client = this.stripeClient;
    if (!client || !providerSubscriptionId) return null;
    try {
      const subscription: any = await client.subscriptions.retrieve(providerSubscriptionId, { expand: ['latest_invoice'] });
      if (String(subscription?.metadata?.internalSubscriptionId ?? '') !== String(internalSubscriptionId)) return null;
      const latest = subscription.latest_invoice;
      const invoiceId = typeof latest === 'string' ? latest : latest?.id;
      if (!invoiceId) return null;
      return await client.invoices.retrieve(invoiceId);
    } catch (err: any) {
      this.logger.warn(`getLatestSubscriptionInvoice(${providerSubscriptionId}) failed: ${err?.message}`);
      return null;
    }
  }

  /** Card brand + last 4 of the payment method behind a PaymentIntent (null for non-card / not found / manual provider). Best-effort, never throws. */
  async getCardForPaymentIntent(paymentIntentId: string | null | undefined): Promise<{ brand: string; last4: string } | null> {
    const client = this.stripeClient;
    if (!client || !paymentIntentId || !paymentIntentId.startsWith('pi_')) return null;
    try {
      const pi: any = await client.paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] });
      const card = pi?.payment_method?.card;
      return card?.last4 ? { brand: String(card.brand ?? 'card'), last4: String(card.last4) } : null;
    } catch (err: any) {
      this.logger.warn(`getCardForPaymentIntent(${paymentIntentId}) failed: ${err?.message}`);
      return null;
    }
  }

  chargeOneTime(referenceId: string, amountUSD: number, context?: ChargeContext): Promise<ChargeResult> {
    return this.provider.chargeOneTime(referenceId, amountUSD, context);
  }

  createProviderSubscription(
    subscriptionId: string,
    planName: string,
    amountUSD: number,
    interval: string,
    context?: ChargeContext,
  ): Promise<CreateProviderSubResult> {
    return this.provider.createProviderSubscription(subscriptionId, planName, amountUSD, interval, context);
  }

  /** Stripe only; the manual provider has no tax-rate objects (returns null). */
  async getOrCreateTaxRate(params: { percentage: number; label: string; country: string; existingId?: string | null }): Promise<string | null> {
    return this.provider instanceof StripePaymentProvider ? this.provider.getOrCreateTaxRate(params) : null;
  }

  async setSubscriptionTaxRate(providerSubscriptionId: string, taxRateId: string | null): Promise<boolean> {
    if (!(this.provider instanceof StripePaymentProvider)) return false;
    await this.provider.setSubscriptionTaxRate(providerSubscriptionId, taxRateId);
    return true;
  }

  cancelProviderSubscription(providerSubscriptionId: string): Promise<void> {
    return this.provider.cancelProviderSubscription(providerSubscriptionId);
  }

  scheduleProviderCancellation(providerSubscriptionId: string): Promise<void> {
    return this.provider.scheduleProviderCancellation(providerSubscriptionId);
  }

  unscheduleProviderCancellation(providerSubscriptionId: string): Promise<void> {
    return this.provider.unscheduleProviderCancellation(providerSubscriptionId);
  }

  getOrCreateCustomer(customerId: string, email: string, name: string, replacingStaleProviderCustomerId?: string): Promise<CreateCustomerResult> {
    return this.provider.getOrCreateCustomer(customerId, email, name, replacingStaleProviderCustomerId);
  }

  customerExists(providerCustomerId: string): Promise<boolean> {
    return this.provider.customerExists(providerCustomerId);
  }

  createSetupIntent(providerCustomerId: string): Promise<SetupIntentResult> {
    return this.provider.createSetupIntent(providerCustomerId);
  }

  createBillingPortalSession(providerCustomerId: string, returnUrl: string): Promise<BillingPortalResult> {
    return this.provider.createBillingPortalSession(providerCustomerId, returnUrl);
  }

  createCheckoutSession(params: {
    providerCustomerId: string; providerPriceId: string; successUrl: string; cancelUrl: string; metadata?: Record<string, string>;
  }): Promise<CheckoutSessionResult> {
    return this.provider.createCheckoutSession(params);
  }

  refund(providerChargeId: string, amountUSD: number, reason?: string): Promise<RefundResult> {
    return this.provider.refund(providerChargeId, amountUSD, reason);
  }

  updateProviderSubscriptionPrice(
    providerSubscriptionId: string,
    newProviderPriceId: string,
    prorationBehavior: 'create_prorations' | 'none' | 'always_invoice',
    resetBillingCycleAnchor?: boolean,
  ): Promise<{ latestInvoiceId?: string }> {
    return this.provider.updateProviderSubscriptionPrice(providerSubscriptionId, newProviderPriceId, prorationBehavior, resetBillingCycleAnchor);
  }

  getOrCreatePrice(params: {
    planId: string; planName: string; storeId: string;
    amountUSD: number; interval: 'monthly' | 'yearly';
    existingProductId?: string | null; existingPriceId?: string | null;
  }): Promise<{ providerProductId: string; providerPriceId: string }> {
    return this.provider.getOrCreatePrice(params);
  }

  getOrCreateCoupon(params: {
    planId: string; fullPriceUSD: number; introPriceUSD: number; durationCycles: number;
    existingCouponId?: string | null;
  }): Promise<{ providerCouponId: string }> {
    return this.provider.getOrCreateCoupon(params);
  }
}
