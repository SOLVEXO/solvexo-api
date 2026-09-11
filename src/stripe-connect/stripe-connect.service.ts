/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import Stripe from 'stripe';

@Injectable()
export class StripeConnectService {
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

  /** Current DB-cached status — fast, no live Stripe call. What the seller's
   *  settings page reads on load; live truth only ever enters the DB via
   *  syncAccountStatus (either right after onboarding-link return, or the
   *  `account.updated` webhook — see PaymentService.stripeWebhook). */
  async getStatus(sellerId: string) {
    const seller = await this.r.sellerModel.findById(sellerId).select(
      'stripeConnectedAccountId stripeConnectStatus stripeConnectChargesEnabled stripeConnectPayoutsEnabled',
    );
    if (!seller) throw new ForbiddenException('Seller not found');
    return {
      success: true,
      data: {
        connected: !!seller.stripeConnectedAccountId,
        status: seller.stripeConnectStatus,
        chargesEnabled: seller.stripeConnectChargesEnabled,
        payoutsEnabled: seller.stripeConnectPayoutsEnabled,
      },
    };
  }

  private async getOrCreateAccount(sellerId: string): Promise<string> {
    const seller = await this.r.sellerModel.findById(sellerId);
    if (!seller) throw new ForbiddenException('Seller not found');
    if (seller.stripeConnectedAccountId) return seller.stripeConnectedAccountId;

    const stripe = this.assertStripeConfigured();
    const account = await stripe.accounts.create({
      type: 'express',
      email: seller.email ?? undefined,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: 'individual',
    });

    await this.r.sellerModel.updateOne(
      { _id: sellerId },
      { stripeConnectedAccountId: account.id, stripeConnectStatus: 'pending' },
    );

    this.activityLogService.log({
      storeId: seller.storeId ?? 'platform',
      category: 'finance',
      action: 'stripe_connect_account_created',
      description: `Stripe Connect account ${account.id} created`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: account.id,
      targetType: 'stripe_connect_account',
    });

    return account.id;
  }

  /** Hosted onboarding — the seller finishes KYC/bank details directly on
   *  Stripe's own page, we never see or store bank account numbers. */
  async createOnboardingLink(sellerId: string, refreshUrl: string, returnUrl: string) {
    const stripe = this.assertStripeConfigured();
    const accountId = await this.getOrCreateAccount(sellerId);

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
  async syncAccountStatus(sellerId: string) {
    const stripe = this.assertStripeConfigured();
    const seller = await this.r.sellerModel.findById(sellerId).select('stripeConnectedAccountId storeId');
    if (!seller?.stripeConnectedAccountId) throw new BadRequestException('No Stripe Connect account to sync');

    const account = await stripe.accounts.retrieve(seller.stripeConnectedAccountId);
    await this.applyAccountUpdate(sellerId, account);
    return this.getStatus(sellerId);
  }

  /** Shared by syncAccountStatus and the `account.updated` webhook handler —
   *  the single place that turns a raw Stripe Account object into our
   *  status fields, so the two callers can never derive it differently. */
  private async applyAccountUpdate(sellerId: string, account: any) {
    const chargesEnabled = !!account.charges_enabled;
    const payoutsEnabled = !!account.payouts_enabled;
    const status: 'pending' | 'active' | 'restricted' =
      chargesEnabled && payoutsEnabled ? 'active'
      : (account.requirements?.disabled_reason ? 'restricted' : 'pending');

    await this.r.sellerModel.updateOne(
      { _id: sellerId },
      { stripeConnectChargesEnabled: chargesEnabled, stripeConnectPayoutsEnabled: payoutsEnabled, stripeConnectStatus: status },
    );
  }

  /** Called from PaymentService.stripeWebhook on `account.updated` — Stripe
   *  sends this to the PLATFORM's webhook endpoint (not a per-account one)
   *  for every Connect account this platform manages, with `event.account`
   *  set to that account's id. */
  async handleAccountUpdated(account: any) {
    const seller = await this.r.sellerModel.findOne({ stripeConnectedAccountId: account.id }).select('_id');
    if (!seller) return; // not one of our sellers (shouldn't happen, but never assume)
    await this.applyAccountUpdate(String(seller._id), account);
  }

  /** Used by PaymentService.initiatePayment to decide whether a checkout's
   *  single store can be routed via direct Connect transfer — returns the
   *  connected account id only when fully charges+payouts enabled, never a
   *  half-onboarded 'pending' account. */
  async getEligibleConnectAccountForStore(storeId: string): Promise<string | null> {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }).select('sellerId');
    if (!store?.sellerId) return null;

    const seller = await this.r.sellerModel.findById(store.sellerId).select(
      'stripeConnectedAccountId stripeConnectStatus stripeConnectChargesEnabled stripeConnectPayoutsEnabled',
    );
    if (!seller?.stripeConnectedAccountId) return null;
    if (seller.stripeConnectStatus !== 'active' || !seller.stripeConnectChargesEnabled || !seller.stripeConnectPayoutsEnabled) return null;

    return seller.stripeConnectedAccountId;
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
  // Approve." Both share the one Connect account per seller; Stripe doesn't
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
   * Cheap, DB-only read of a seller's Connect eligibility for the INTERNAL
   * ledger payout rail — deliberately not the same gate as
   * `getEligibleConnectAccountForStore` (which also requires the STORE to
   * exist/not be deleted, irrelevant here since a payout is seller-level
   * money already sitting in the platform balance, not a live checkout).
   */
  async getPayoutEligibility(sellerId: string): Promise<{ accountId: string; eligible: boolean; status: string } | null> {
    const seller = await this.r.sellerModel.findById(sellerId).select(
      'stripeConnectedAccountId stripeConnectStatus stripeConnectPayoutsEnabled',
    ).lean();
    if (!seller?.stripeConnectedAccountId) return null;
    return {
      accountId: seller.stripeConnectedAccountId,
      eligible: seller.stripeConnectStatus === 'active' && !!seller.stripeConnectPayoutsEnabled,
      status: seller.stripeConnectStatus,
    };
  }
}
