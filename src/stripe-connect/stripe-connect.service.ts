/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import Stripe from 'stripe';

@Injectable()
export class StripeConnectService implements OnModuleInit {
  private readonly logger = new Logger(StripeConnectService.name);
  private stripe: InstanceType<typeof Stripe> | undefined;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly configService: ConfigService,
  ) {
    const secretKey = this.configService.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (secretKey) {
      this.stripe = new Stripe(secretKey, { apiVersion: '2025-04-30.basil' as any });
    }
  }

  private get r() {
    return this.databaseService.repositories;
  }

  private assertStripeConfigured() {
    if (!this.stripe) throw new BadRequestException('Online payments are not configured');
    return this.stripe;
  }

  private readonly CONNECT_FIELDS = 'stripeConnectStatus stripeConnectChargesEnabled stripeConnectPayoutsEnabled sellerId name';

  /** The store must belong to `sellerId` (a staff caller is already pinned to their store by PermissionsGuard). */
  private async loadOwnedStore(sellerId: string, storeId: string) {
    const store = await this.r.storeModel
      .findOne({ _id: storeId, sellerId, isDelete: false })
      .select(`+stripeConnectedAccountId ${this.CONNECT_FIELDS}`);
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  /** Runs once per boot (idempotent): copies each legacy per-SELLER account onto all of that seller's existing
   *  stores so nobody loses the ability to take card payments when Connect became per-store. Stores created
   *  afterwards start with no account and connect their own. */
  async onModuleInit() {
    try {
      const sellers = await this.r.sellerModel
        .find({ stripeConnectedAccountId: { $ne: null }, stripeConnectMigratedToStoresAt: null })
        .select('stripeConnectedAccountId stripeConnectStatus stripeConnectChargesEnabled stripeConnectPayoutsEnabled')
        .lean();
      for (const seller of sellers as any[]) {
        await this.r.storeModel.updateMany(
          { sellerId: String(seller._id), stripeConnectedAccountId: null },
          {
            stripeConnectedAccountId: seller.stripeConnectedAccountId,
            stripeConnectStatus: seller.stripeConnectStatus ?? 'pending',
            stripeConnectChargesEnabled: !!seller.stripeConnectChargesEnabled,
            stripeConnectPayoutsEnabled: !!seller.stripeConnectPayoutsEnabled,
          },
        );
        await this.r.sellerModel.updateOne({ _id: seller._id }, { stripeConnectMigratedToStoresAt: new Date() });
      }
      if (sellers.length) this.logger.log(`Copied the legacy Stripe Connect account of ${sellers.length} seller(s) onto their stores`);
    } catch (err: any) {
      this.logger.error(`Legacy Stripe Connect migration failed: ${err?.message}`);
    }
  }

  /** Current DB-cached status of THIS store's account — fast, no live Stripe call. What the seller's settings page
   *  reads on load; live truth only ever enters the DB via syncAccountStatus (right after onboarding-link return)
   *  or the `account.updated` webhook — see PaymentService.stripeWebhook). */
  async getStatus(sellerId: string, storeId: string) {
    const store = await this.loadOwnedStore(sellerId, storeId);
    return {
      success: true,
      data: {
        connected: !!store.stripeConnectedAccountId,
        status: store.stripeConnectStatus,
        chargesEnabled: store.stripeConnectChargesEnabled,
        payoutsEnabled: store.stripeConnectPayoutsEnabled,
      },
    };
  }

  private async getOrCreateAccount(sellerId: string, store: any): Promise<string> {
    if (store.stripeConnectedAccountId) return store.stripeConnectedAccountId;

    const seller = await this.r.sellerModel.findById(sellerId).select('email');
    if (!seller) throw new ForbiddenException('Seller not found');

    const stripe = this.assertStripeConfigured();
    const account = await stripe.accounts.create({
      type: 'express',
      email: seller.email ?? undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
      metadata: { storeId: String(store._id) },
    });

    // Conditional write: if two requests raced, only one account id sticks and the loser's is returned.
    const res = await this.r.storeModel.updateOne(
      { _id: store._id, stripeConnectedAccountId: null },
      { stripeConnectedAccountId: account.id, stripeConnectStatus: 'pending' },
    );
    if ((res as any).modifiedCount === 0) {
      const fresh = await this.r.storeModel.findById(store._id).select('+stripeConnectedAccountId');
      if (fresh?.stripeConnectedAccountId) return fresh.stripeConnectedAccountId;
    }

    this.activityLogService.log({
      storeId: String(store._id),
      category: 'finance',
      action: 'stripe_connect_account_created',
      description: `Stripe Connect account ${account.id} created for store "${store.name ?? store._id}"`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: account.id,
      targetType: 'stripe_connect_account',
    });

    return account.id;
  }

  /** Hosted onboarding — the seller finishes KYC/bank details directly on
   *  Stripe's own page, we never see or store bank account numbers. */
  async createOnboardingLink(sellerId: string, storeId: string, refreshUrl: string, returnUrl: string) {
    const stripe = this.assertStripeConfigured();
    const store = await this.loadOwnedStore(sellerId, storeId);
    const accountId = await this.getOrCreateAccount(sellerId, store);

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    });

    return { success: true, data: { url: accountLink.url } };
  }

  /** Re-fetches live status from Stripe and updates the DB cache — called
   *  when the seller lands back on `returnUrl` after onboarding, and from
   *  the `account.updated` webhook for every subsequent change (verification
   *  completed, capability revoked, etc.). Never trusts a client-supplied
   *  status string — always re-derives from Stripe's own account object. */
  async syncAccountStatus(sellerId: string, storeId: string) {
    const stripe = this.assertStripeConfigured();
    const store = await this.loadOwnedStore(sellerId, storeId);
    if (!store.stripeConnectedAccountId) throw new BadRequestException('No Stripe Connect account to sync');

    const account = await stripe.accounts.retrieve(store.stripeConnectedAccountId);
    await this.applyAccountUpdate(account);
    return this.getStatus(sellerId, storeId);
  }

  /** Shared by syncAccountStatus and the `account.updated` webhook handler —
   *  the single place that turns a raw Stripe Account object into our
   *  status fields, so the two callers can never derive it differently.
   *  Updates EVERY store that uses this account (more than one only for a migrated legacy shared account). */
  private async applyAccountUpdate(account: any) {
    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    const status: 'pending' | 'active' | 'restricted' =
      chargesEnabled && payoutsEnabled ? 'active'
      : (account.requirements?.disabled_reason ? 'restricted' : 'pending');

    await this.r.storeModel.updateMany(
      { stripeConnectedAccountId: account.id },
      { stripeConnectChargesEnabled: chargesEnabled, stripeConnectPayoutsEnabled: payoutsEnabled, stripeConnectStatus: status },
    );
  }

  /** Called from PaymentService.stripeWebhook on `account.updated` — Stripe
   *  sends this to the PLATFORM's webhook endpoint (not a per-account one)
   *  for every Connect account this platform manages, with `event.account`
   *  set to that account's id. */
  async handleAccountUpdated(account: any) {
    if (!account?.id) return;
    await this.applyAccountUpdate(account); // no matching store → updateMany is a no-op
  }

  /** Used by PaymentService.initiatePayment to decide whether a checkout's
   *  single store can be routed via direct Connect transfer — returns the
   *  connected account id only when fully charges+payouts enabled, never a
   *  half-onboarded 'pending' account. THIS store's own account only. */
  async getEligibleConnectAccountForStore(storeId: string): Promise<string | null> {
    const store = await this.r.storeModel
      .findOne({ _id: storeId, isDelete: false })
      .select('+stripeConnectedAccountId stripeConnectStatus stripeConnectChargesEnabled stripeConnectPayoutsEnabled')
      .lean();
    if (!(store as any)?.stripeConnectedAccountId) return null;
    const st: any = store;
    if (st.stripeConnectStatus !== 'active' || !st.stripeConnectChargesEnabled || !st.stripeConnectPayoutsEnabled) return null;

    return st.stripeConnectedAccountId;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNAL LEDGER PAYOUTS — used by FinanceService, a DIFFERENT money path
  // from the direct-charge routing above. `getEligibleConnectAccountForStore`
  // decides whether a BUYER's charge can skip Solvexo's ledger entirely and
  // land straight in the seller's connected account. The methods below move
  // money that already DID land in Solvexo's own platform Stripe balance
  // (COD orders, split payments, multi-store carts, anything from before
  // Connect was active) OUT to that same connected account after the fact —
  // this is what makes FinanceService.requestPayout/processScheduledPayouts
  // genuinely automated instead of "an admin manually wires it and clicks
  // Approve." Both share the one Connect account per store; Stripe doesn't
  // care which of the two paths put money into it.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Moves money from the PLATFORM's own Stripe balance to a seller's
   * connected account. `idempotencyKey` must be stable per attempt (the
   * caller uses the Payout document's own _id) so a retried request after a
   * network timeout can never create two transfers for the same payout.
   */
  async createTransfer(
    destinationAccountId: string,
    amountCents: number,
    currency: string,
    idempotencyKey: string,
    metadata: Record<string, string>,
  ): Promise<any> {
    const stripe = this.assertStripeConfigured();
    return stripe.transfers.create(
      {
        amount: amountCents,
        currency: currency.toLowerCase(),
        destination: destinationAccountId,
        metadata,
      },
      { idempotencyKey },
    );
  }

  /**
   * Claws a previously-successful transfer back from the connected account
   * to the platform balance — used when a completed payout is later found
   * to be fraudulent/disputed (admin-initiated) or when Stripe itself
   * reverses one (`transfer.reversed` webhook). Fails with a real Stripe
   * error if the connected account no longer has enough balance to reverse
   * against — that failure is surfaced to the caller, never silently eaten.
   */
  async reverseTransfer(transferId: string, idempotencyKey: string): Promise<any> {
    const stripe = this.assertStripeConfigured();
    return stripe.transfers.createReversal(transferId, {}, { idempotencyKey });
  }

  /**
   * Cheap, DB-only read of a STORE's Connect eligibility for the INTERNAL
   * ledger payout rail — deliberately not the same gate as
   * `getEligibleConnectAccountForStore` (money already sitting in the platform
   * balance is being moved out, not a live checkout being routed).
   */
  async getPayoutEligibility(storeId: string): Promise<{ accountId: string; eligible: boolean; status: string } | null> {
    const store: any = await this.r.storeModel
      .findById(storeId)
      .select('+stripeConnectedAccountId stripeConnectStatus stripeConnectPayoutsEnabled')
      .lean();
    if (!store?.stripeConnectedAccountId) return null;
    return {
      accountId: store.stripeConnectedAccountId,
      eligible: store.stripeConnectStatus === 'active' && !!store.stripeConnectPayoutsEnabled,
      status: store.stripeConnectStatus,
    };
  }
}
