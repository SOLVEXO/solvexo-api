import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { DatabaseService } from '../database/databaseservice';
import { StripeConnectService } from '../stripe-connect/stripe-connect.service';
import { stripeConnectCountries, resolveStoreCountry, countryName } from '../integrations/payment-availability.util';
import { toStripeAmount } from '../common/stripe-amount.util';
import { storePublicUrl } from '../newsletter/marketing-email.util';

export interface StripeAvailability { available: boolean; reason: string | null; }

/**
 * Automatic card renewal for memberships through Stripe, TEST MODE ONLY unless MEMBERSHIPS_STRIPE_ALLOW_LIVE=true.
 *
 * Money rule: a destination charge on the platform account whose whole amount is transferred to the seller's own
 * connected account (`transfer_data.destination`), NO application fee, no commission, nothing kept by Solvexo and
 * nothing parked in the internal ledger. Only stores whose country Stripe Connect serves here
 * (`STRIPE_CONNECT_COUNTRIES`, default US) and that finished Connect onboarding can use it; everything else
 * stays on manual billing (the seller marks each period paid, or sells the plan through checkout).
 */
@Injectable()
export class StripeMembershipProvider {
  readonly name = 'stripe' as const;
  private readonly logger = new Logger(StripeMembershipProvider.name);
  private _client: InstanceType<typeof Stripe> | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly connect: StripeConnectService,
    private readonly config: ConfigService,
  ) {}

  /** The Stripe SDK client. Refuses a live key unless explicitly allowed. */
  client(): InstanceType<typeof Stripe> {
    if (this._client) return this._client;
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    if (!key) throw new BadRequestException('Stripe is not configured on this server');
    if (key.startsWith('sk_live') && this.config.get<string>('MEMBERSHIPS_STRIPE_ALLOW_LIVE') !== 'true') {
      throw new BadRequestException('Automatic membership billing is limited to Stripe test mode until live mode is switched on');
    }
    this._client = new Stripe(key, { apiVersion: '2025-02-24.acacia' as any, typescript: true });
    return this._client;
  }

  /** Why a store can or cannot charge members automatically. */
  async availability(storeId: string): Promise<StripeAvailability> {
    if (this.config.get<string>('MEMBERSHIPS_STRIPE_ENABLED') !== 'true') {
      return { available: false, reason: 'Automatic card renewal is not switched on for this platform yet.' };
    }
    if (!this.config.get<string>('STRIPE_SECRET_KEY')) return { available: false, reason: 'Stripe is not configured on this server.' };
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('country baseCurrency').lean();
    if (!store) return { available: false, reason: 'Store not found.' };
    const country = resolveStoreCountry(store);
    const allowed = stripeConnectCountries();
    if (!country || !allowed.includes(country)) {
      return { available: false, reason: `Auto billing is not available in ${country ? countryName(country) : 'your country'} yet; use Manual billing.` };
    }
    const account = await this.connect.getEligibleConnectAccountForStore(storeId);
    if (!account) return { available: false, reason: 'Connect your Stripe account (Settings -> Integrations) and finish its setup to charge members automatically.' };
    return { available: true, reason: null };
  }

  private async assertAvailable(storeId: string): Promise<string> {
    const a = await this.availability(storeId);
    if (!a.available) throw new BadRequestException(a.reason ?? 'Automatic billing is not available');
    return (await this.connect.getEligibleConnectAccountForStore(storeId)) as string;
  }

  /** One Stripe product per plan, created lazily and remembered on the plan. */
  async ensureProduct(plan: any, planModel: any): Promise<string> {
    if (plan.stripeProductId) return plan.stripeProductId;
    const product = await this.client().products.create({ name: String(plan.name).slice(0, 250), metadata: { planId: String(plan._id), storeId: String(plan.storeId) } }, { idempotencyKey: `memplan:${plan._id}` });
    await planModel.updateOne({ _id: plan._id }, { $set: { stripeProductId: product.id } });
    return product.id;
  }

  private recurring(plan: any) {
    return { interval: plan.interval as 'week' | 'month' | 'year', interval_count: plan.intervalCount ?? 1 };
  }

  /** Hosted Checkout (subscription mode). The seller's connected account receives every payment in full. */
  async createCheckout(args: { storeId: string; plan: any; planModel: any; customerId: string; email: string; successUrl: string; cancelUrl: string }): Promise<{ url: string; id: string }> {
    const destination = await this.assertAvailable(args.storeId);
    const productId = await this.ensureProduct(args.plan, args.planModel);
    const meta = { purpose: 'member_subscription', storeId: args.storeId, customerId: args.customerId, planId: String(args.plan._id) };
    const bucket = Math.floor(Date.now() / 300_000); // the same buyer double-clicking inside 5 minutes gets the same session
    const session = await this.client().checkout.sessions.create(
      {
        mode: 'subscription',
        customer_email: args.email,
        client_reference_id: args.customerId,
        line_items: [{ quantity: 1, price_data: { currency: String(args.plan.currency).toLowerCase(), unit_amount: toStripeAmount(args.plan.amount, args.plan.currency), recurring: this.recurring(args.plan), product: productId } }],
        subscription_data: {
          transfer_data: { destination },
          ...(args.plan.trialDays > 0 ? { trial_period_days: args.plan.trialDays } : {}),
          metadata: meta,
        },
        metadata: meta,
        success_url: args.successUrl,
        cancel_url: args.cancelUrl,
      },
      { idempotencyKey: `memcheckout:${args.storeId}:${args.customerId}:${args.plan._id}:${bucket}` },
    );
    if (!session.url) throw new BadRequestException('Stripe did not return a checkout link');
    return { url: session.url, id: session.id };
  }

  async getSubscription(providerSubscriptionId: string): Promise<any> {
    return this.client().subscriptions.retrieve(providerSubscriptionId);
  }

  async setCancelAtPeriodEnd(providerSubscriptionId: string, cancel: boolean): Promise<void> {
    await this.client().subscriptions.update(providerSubscriptionId, { cancel_at_period_end: cancel });
  }

  /** Pause = stop collecting (invoices are voided); resume = collect again from the next invoice. */
  async setPaused(providerSubscriptionId: string, paused: boolean): Promise<void> {
    await this.client().subscriptions.update(providerSubscriptionId, { pause_collection: paused ? { behavior: 'void' } : ('' as any) });
  }

  /** Upgrade bills the prorated difference now; a downgrade is applied by us at the next period (no proration). */
  async changePlan(providerSubscriptionId: string, newPlan: any, planModel: any, mode: 'upgrade' | 'downgrade'): Promise<void> {
    const sub: any = await this.getSubscription(providerSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) throw new BadRequestException('The Stripe subscription has no item to change');
    const productId = await this.ensureProduct(newPlan, planModel);
    await this.client().subscriptions.update(providerSubscriptionId, {
      items: [{ id: item.id, price_data: { currency: String(newPlan.currency).toLowerCase(), unit_amount: toStripeAmount(newPlan.amount, newPlan.currency), recurring: this.recurring(newPlan), product: productId } }],
      proration_behavior: mode === 'upgrade' ? 'always_invoice' : 'none',
      metadata: { planId: String(newPlan._id) },
    });
  }

  /** End the subscription now (dunning exhausted). */
  async cancelNow(providerSubscriptionId: string): Promise<void> {
    await this.client().subscriptions.cancel(providerSubscriptionId);
  }

  /** Stripe's hosted page where the member replaces the card. */
  async paymentMethodUpdateUrl(providerCustomerId: string, storeId: string): Promise<string> {
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId }).select('slug customDomain customDomainStatus').lean();
    const base = storePublicUrl(store);
    const portal = await this.client().billingPortal.sessions.create({ customer: providerCustomerId, ...(base ? { return_url: `${base}/memberships` } : {}) });
    return portal.url;
  }

  /** Constructs the event from the raw body: throws on a bad signature. */
  verifyWebhook(rawBody: Buffer, signature: string | undefined): any {
    const secret = this.config.get<string>('MEMBERSHIPS_STRIPE_WEBHOOK_SECRET');
    if (!secret) throw new BadRequestException('MEMBERSHIPS_STRIPE_WEBHOOK_SECRET is not set');
    if (!signature) throw new BadRequestException('Missing Stripe signature');
    try {
      return this.client().webhooks.constructEvent(rawBody, signature, secret);
    } catch (e: any) {
      throw new BadRequestException(`Webhook signature verification failed: ${e?.message}`);
    }
  }
}
