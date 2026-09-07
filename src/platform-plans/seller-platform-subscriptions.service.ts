/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DatabaseService } from 'src/database/databaseservice';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { PlatformPlanNotificationsService } from './platform-plan-notifications.service';
import { PaymentGatewayService } from 'src/subscriptions/payment-gateway/payment-gateway.service';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { SubscribePlatformPlanDto, ChangePlatformPlanDto } from './dto/subscribe-platform-plan.dto';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';

const MAX_RENEWAL_ATTEMPTS = 3;
const RETRY_INTERVAL_DAYS = 1;
// Every Stripe object created by THIS module is tagged with this so the shared
// webhook processor can tell a platform-plan event apart from a buyer-VIP-plan
// event (both flow through the same Stripe account/webhook endpoint).
export const PLATFORM_PLAN_STRIPE_METADATA_KIND = 'platform_plan';

@Injectable()
export class SellerPlatformSubscriptionsService {
  private readonly logger = new Logger(SellerPlatformSubscriptionsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly activityLogService: ActivityLogService,
    private readonly notifications: PlatformPlanNotificationsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get planModel() { return this.db.repositories.platformPlanModel; }
  private get subModel() { return this.db.repositories.sellerPlatformSubscriptionModel; }
  private get invoiceModel() { return this.db.repositories.platformPlanInvoiceModel; }
  private get attemptModel() { return this.db.repositories.platformPlanPaymentAttemptModel; }
  private get storeModel() { return this.db.repositories.storeModel; }
  private get counterModel() { return this.db.repositories.subscriptionCounterModel; } // reused — generic atomic counter

  private round(n: number) { return Math.round(n * 100) / 100; }

  private addPeriod(date: Date, interval: 'monthly' | 'yearly'): Date {
    const d = new Date(date);
    if (interval === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  private async generateInvoiceNumber(): Promise<string> {
    const now = new Date();
    const key = `platform-invoice-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const counter = await this.counterModel.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { upsert: true, new: true });
    return `PINV-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${String(counter.seq).padStart(6, '0')}`;
  }

  // Not private: also called directly by SellerPlatformSubscriptionsController's
  // getEntitlements route, which reads from EntitlementsService rather than this
  // service and otherwise has no ownership check of its own.
  async verifyStoreOwnership(storeId: string, sellerId: string) {
    return verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
  }

  /** Keeps Store.badges in sync with the `marketplaceFeaturedBadge` entitlement — reuses the existing admin-badge-driven marketplace sort/highlight logic verbatim, no changes needed there. */
  private async syncFeaturedBadge(storeId: string, plan: any) {
    try {
      const store = await this.storeModel.findById(storeId);
      if (!store) return;
      const shouldBeFeatured = !!plan?.limits?.marketplaceFeaturedBadge;
      const currentlyFeatured = (store.badges ?? []).includes('featured');
      if (shouldBeFeatured && !currentlyFeatured) {
        store.badges = [...(store.badges ?? []), 'featured'];
        await store.save();
      } else if (!shouldBeFeatured && currentlyFeatured) {
        store.badges = (store.badges ?? []).filter((b: string) => b !== 'featured');
        await store.save();
      }
    } catch (err: any) {
      this.logger.warn(`Featured-badge sync failed for store ${storeId}: ${err?.message}`);
    }
  }

  /**
   * Pure proration math, no side effects — shared by `changePlan` (which acts
   * on it) and `previewChangePlan` (which only shows it to the seller before
   * they confirm). Keeping this in one place is what guarantees the preview
   * the seller sees is EXACTLY what they'll be charged, never an approximation.
   */
  private computeProration(sub: any, newPlan: any, newInterval: 'monthly' | 'yearly') {
    const newAmountUSD = newPlan.isFree
      ? 0
      : (newInterval === 'yearly' ? (newPlan.yearlyPriceUSD ?? this.round((newPlan.monthlyPriceUSD ?? 0) * 12)) : (newPlan.monthlyPriceUSD ?? 0));

    const now = new Date();
    const totalPeriodMs = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
    const remainingMs = Math.max(0, sub.currentPeriodEnd.getTime() - now.getTime());
    const remainingRatio = totalPeriodMs > 0 ? Math.min(1, remainingMs / totalPeriodMs) : 0;
    const unusedCredit = this.round((sub.amountUSD ?? 0) * remainingRatio);
    const totalCreditAvailable = this.round(unusedCredit + (sub.creditBalanceUSD ?? 0));
    const netDue = this.round(newAmountUSD - totalCreditAvailable);

    return {
      newAmountUSD, remainingRatio, unusedCredit,
      existingCreditBalanceUSD: this.round(sub.creditBalanceUSD ?? 0),
      totalCreditAvailable, netDue, isFreeMoveIn: newAmountUSD === 0,
      willChargeUSD: netDue > 0 ? netDue : 0,
      willCreditUSD: netDue < 0 ? this.round(-netDue) : 0,
    };
  }

  /**
   * Moves a store to the platform's free plan — the terminal state for both
   * "dunning exhausted" (applyDunningFailure) and "cancellation reached period
   * end" (finalizeScheduledCancellations). No store is ever left with zero
   * plan record; it always lands on whichever plan has `isFree: true`.
   */
  private async downgradeToFree(sub: any): Promise<any | null> {
    const freePlan = await this.planModel.findOne({ isFree: true, status: 'active', isDelete: false });
    if (!freePlan) return null;
    sub.platformPlanId = (freePlan as any)._id.toString();
    sub.amountUSD = 0;
    sub.status = 'active';
    sub.failedPaymentAttempts = 0;
    sub.cancelAtPeriodEnd = false;
    sub.canceledAt = null;
    sub.cancelReason = null;
    await this.syncFeaturedBadge(sub.storeId, freePlan);
    return freePlan;
  }

  /**
   * The trial-based-model equivalent of `downgradeToFree()` — used instead
   * of it for any `legacyFreeEligible: false` store (i.e. every store that
   * entered the platform after the trial-based billing model shipped; see
   * that field's schema comment). There is no permanent free fallback for
   * these stores: trial expiry with no conversion, dunning exhaustion, and
   * cancellation reaching period end all land here. Selling/checkout access
   * is restricted (BillingAccessGuard reads `status`), but NOTHING about the
   * seller/store/product/order/customer data is touched — this only ever
   * changes the subscription record's own billing-state fields.
   */
  private async lockStore(sub: any): Promise<void> {
    sub.status = 'locked';
    sub.failedPaymentAttempts = 0;
    sub.cancelAtPeriodEnd = false;
    sub.canceledAt = null;
    sub.cancelReason = null;
    // platformPlanId/amountUSD deliberately left as-is — "you were on
    // Professional" is what the billing/recovery UI shows while locked, and
    // it's also what a simple "reactivate" (successful payment) resumes.
  }

  private async getSellerAndStoreNames(sellerId: string, storeId: string) {
    const [seller, store] = await Promise.all([
      this.db.repositories.sellerModel.findById(sellerId).select('name email').lean(),
      this.storeModel.findById(storeId).select('name').lean(),
    ]);
    return {
      sellerName: (seller as any)?.name ?? 'there',
      sellerEmail: (seller as any)?.email ?? null,
      storeName: (store as any)?.name ?? 'your store',
    };
  }

  private async recordAttempt(params: {
    storeId: string; sellerId: string; attemptType: 'initial' | 'renewal' | 'proration';
    outcome: 'success' | 'failed'; amountUSD: number; failureReason?: string | null; failureCode?: string | null;
    invoiceId?: string | null; providerChargeId?: string | null;
  }) {
    try {
      const attemptNumber = (await this.attemptModel.countDocuments({ storeId: params.storeId })) + 1;
      await this.attemptModel.create({ ...params, attemptNumber, failureReason: params.failureReason ?? null });
    } catch {
      // audit logging must never break billing
    }
  }

  private async applyDunningFailure(sub: any, chargeAmount?: number) {
    sub.failedPaymentAttempts = (sub.failedPaymentAttempts ?? 0) + 1;
    const { sellerName, sellerEmail, storeName } = await this.getSellerAndStoreNames(sub.sellerId, sub.storeId);

    if (sub.failedPaymentAttempts >= MAX_RENEWAL_ATTEMPTS) {
      // Legacy (pre-trial-model) grandfathered stores keep landing on the
      // free plan exactly as before — every other store has no permanent
      // free fallback and gets locked instead (see legacyFreeEligible's
      // schema comment).
      if (sub.legacyFreeEligible) {
        const freePlan = await this.downgradeToFree(sub);
        if (freePlan) {
          if (sellerEmail) {
            await this.notifications.sendDowngradedDueToFailedPayments(sellerEmail, {
              sellerName, storeName, planName: freePlan.name, maxAttempts: MAX_RENEWAL_ATTEMPTS,
            });
          }
          this.notificationsService.notify({
            recipientId: sub.sellerId,
            recipientRole: 'seller',
            type: NOTIFICATION_TYPES.PLATFORM_PLAN_PAYMENT_FAILED,
            title: 'Plan downgraded',
            body: `${storeName} was moved to the ${freePlan.name} plan after ${MAX_RENEWAL_ATTEMPTS} failed payment attempts.`,
            data: { subscriptionId: String(sub._id) },
          }).catch(() => {});
          this.activityLogService.log({
            storeId: sub.storeId, category: 'platform_plans', action: 'plan_downgraded_payment_failure',
            description: `Store auto-downgraded to free plan after ${MAX_RENEWAL_ATTEMPTS} failed payment attempts`,
            actorRole: 'system', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
          });
          return;
        }
      } else {
        await this.lockStore(sub);
        if (sellerEmail) {
          await this.notifications.sendStoreLocked(sellerEmail, { sellerName, storeName, reason: 'payment_failed' }).catch(() => {});
        }
        this.notificationsService.notify({
          recipientId: sub.sellerId,
          recipientRole: 'seller',
          type: NOTIFICATION_TYPES.PLATFORM_PLAN_PAYMENT_FAILED,
          title: 'Store locked',
          body: `${storeName} was locked after ${MAX_RENEWAL_ATTEMPTS} failed payment attempts — update your payment method to unlock it. Your data is safe.`,
          data: { subscriptionId: String(sub._id) },
        }).catch(() => {});
        this.activityLogService.log({
          storeId: sub.storeId, category: 'platform_plans', action: 'plan_locked_payment_failure',
          description: `Store locked (selling restricted) after ${MAX_RENEWAL_ATTEMPTS} failed payment attempts`,
          actorRole: 'system', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
        });
        return;
      }
    }

    sub.status = 'past_due';
    const retryAt = new Date();
    retryAt.setDate(retryAt.getDate() + RETRY_INTERVAL_DAYS);
    sub.nextBillingDate = retryAt;

    if (sellerEmail) {
      const plan = await this.planModel.findById(sub.platformPlanId).select('name').lean();
      await this.notifications.sendPaymentFailed(sellerEmail, {
        sellerName, storeName, planName: (plan as any)?.name ?? 'your plan',
        amountUSD: chargeAmount ?? sub.amountUSD, attemptNumber: sub.failedPaymentAttempts,
        maxAttempts: MAX_RENEWAL_ATTEMPTS, nextRetryDate: retryAt,
      });
    }
    this.notificationsService.notify({
      recipientId: sub.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PLATFORM_PLAN_PAYMENT_FAILED,
      title: 'Plan payment failed',
      body: `We couldn't process your ${storeName} plan payment — we'll retry on ${retryAt.toDateString()}.`,
      data: { subscriptionId: String(sub._id) },
    }).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  static readonly TRIAL_DAYS = 3;

  /**
   * Called by StoreService right after a new store is created — every store
   * always has exactly one of these. New sellers get NO permanent free
   * plan: a `'trialing'` record on a real paid plan, `trialEndsAt = now +
   * TRIAL_DAYS`, no card required, no Stripe subscription created yet (that
   * only happens if/when the seller commits — see `changePlan`'s
   * `trial_end` path). `legacyFreeEligible: false` by the schema default —
   * only pre-existing subscriptions (backfilled by
   * migrate-legacy-free-eligible.ts) are ever `true`.
   *
   * `desiredPlanId` — the seller's own choice, made during onboarding
   * (`OnboardingPage.tsx`'s Payment/Plan step); required in practice (the
   * frontend always sends it), but falls back to the cheapest real
   * (non-free, non-custom-pricing) active plan if genuinely omitted, so
   * this never hard-fails a store creation over a missing plan choice.
   *
   * One introductory trial per SELLER, not per store — `Seller.
   * platformTrialUsedAt` is checked first; a seller who already had a trial
   * (on any of their stores) gets this new store's subscription created
   * directly as `'locked'` instead of `'trialing'` — full dashboard/data
   * access, no selling until they pick a plan and pay. Prevents "create
   * another store" from ever producing a second free trial.
   */
  async ensureDefaultSubscription(storeId: string, sellerId: string, desiredPlanId?: string) {
    const existing = await this.subModel.findOne({ storeId });
    if (existing) return existing;

    const trialPlan = desiredPlanId
      ? await this.planModel.findOne({ _id: desiredPlanId, isFree: { $ne: true }, isCustomPricing: { $ne: true }, status: 'active', isDelete: false })
      : await this.planModel.findOne({ isFree: { $ne: true }, isCustomPricing: { $ne: true }, status: 'active', isDelete: false }).sort({ monthlyPriceUSD: 1 });
    if (!trialPlan) {
      this.logger.warn(`No paid PlatformPlan exists yet — store ${storeId} created without a platform-plan record (admin must create one)`);
      return null;
    }

    // Real document (not .lean()) — may need to write platformTrialUsedAt below.
    const seller = await this.db.repositories.sellerModel.findById(sellerId);
    // A seller who already put a card on file during onboarding (see
    // createOnboardingSetupIntent/confirmOnboardingPaymentMethod below) has a
    // Stripe customer waiting — seed it onto the record now so a later
    // upgrade never has to create a second customer for the same seller.
    // Purely informational at this point — no Stripe subscription is created
    // here, so nothing is charged just because a card happens to be on file.
    const stripeCustomerId = seller?.stripeCustomerId ?? null;

    const now = new Date();
    const alreadyUsedTrial = !!seller?.platformTrialUsedAt;
    const trialEndsAt = new Date(now.getTime() + SellerPlatformSubscriptionsService.TRIAL_DAYS * 24 * 60 * 60 * 1000);

    if (!alreadyUsedTrial && seller) {
      seller.platformTrialUsedAt = now;
      await seller.save();
    }

    if (alreadyUsedTrial) {
      return this.subModel.create({
        storeId, sellerId, platformPlanId: (trialPlan as any)._id.toString(),
        billingInterval: 'monthly', amountUSD: trialPlan.monthlyPriceUSD ?? 0, status: 'locked',
        startedAt: now, trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: trialEndsAt,
        nextBillingDate: trialEndsAt,
        stripeCustomerId, paymentProvider: stripeCustomerId ? 'stripe' : 'manual', legacyFreeEligible: false,
      });
    }

    return this.subModel.create({
      storeId, sellerId, platformPlanId: (trialPlan as any)._id.toString(),
      billingInterval: 'monthly', amountUSD: trialPlan.monthlyPriceUSD ?? 0, status: 'trialing',
      startedAt: now, trialEndsAt, currentPeriodStart: now, currentPeriodEnd: trialEndsAt,
      nextBillingDate: trialEndsAt,
      stripeCustomerId,
      paymentProvider: stripeCustomerId ? 'stripe' : 'manual',
      legacyFreeEligible: false,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Onboarding wizard — Payment step (before any store exists yet)
  // ═══════════════════════════════════════════════════════════════════════

  /** Creates (or reuses) this seller's Stripe customer and a SetupIntent so
   *  the onboarding wizard's Payment step can collect a card via Stripe
   *  Elements — called before the store itself has been created. */
  async createOnboardingSetupIntent(sellerId: string) {
    const seller = await this.db.repositories.sellerModel.findById(sellerId);
    if (!seller) throw new NotFoundException('Seller account not found');

    if (!seller.stripeCustomerId) {
      const { providerCustomerId } = await this.gateway.getOrCreateCustomer(sellerId, seller.email, seller.name ?? '');
      seller.stripeCustomerId = providerCustomerId;
      await seller.save();
    }

    const setupIntent = await this.gateway.createSetupIntent(seller.stripeCustomerId);
    return { success: true, data: { clientSecret: setupIntent.clientSecret, customerId: seller.stripeCustomerId } };
  }

  /** Verifies (server-side, against Stripe — never trusting the client's word
   *  that a card was saved) that the SetupIntent Stripe.js just confirmed
   *  really succeeded for THIS seller's customer, sets it as the customer's
   *  default payment method (so a later off-session platform-plan charge can
   *  find it — see chargeSubscription), and flips
   *  `Seller.hasPlatformPaymentMethod`, which is what lets StoreService.createStore
   *  activate the new store immediately instead of queuing it for admin review. */
  async confirmOnboardingPaymentMethod(sellerId: string, setupIntentId: string) {
    const seller = await this.db.repositories.sellerModel.findById(sellerId);
    if (!seller?.stripeCustomerId) throw new BadRequestException('No Stripe customer on file for this seller — start the Payment step again');

    const stripe = this.gateway.stripeClient;
    if (stripe) {
      const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
      if (setupIntent.customer !== seller.stripeCustomerId || setupIntent.status !== 'succeeded' || !setupIntent.payment_method) {
        throw new BadRequestException('Card setup was not completed successfully');
      }
      await stripe.customers.update(seller.stripeCustomerId, {
        invoice_settings: { default_payment_method: setupIntent.payment_method as string },
      });
    }
    // Manual provider (local dev/CI, no real Stripe client) — same
    // always-succeeds stub philosophy as every other ManualPaymentProvider
    // method, nothing real to verify against.

    seller.hasPlatformPaymentMethod = true;
    await seller.save();

    return { success: true };
  }

  /** What the onboarding wizard needs on load to resume exactly where the
   *  seller left off — their saved draft (if any) and whether the Payment
   *  step can be shown as already-done instead of asking for a card again. */
  async getOnboardingProgress(sellerId: string) {
    const seller = await this.db.repositories.sellerModel
      .findById(sellerId)
      .select('onboardingDraft hasPlatformPaymentMethod')
      .lean();
    if (!seller) throw new NotFoundException('Seller account not found');

    return {
      success: true,
      data: {
        draft: (seller as any).onboardingDraft ?? null,
        hasPlatformPaymentMethod: !!(seller as any).hasPlatformPaymentMethod,
      },
    };
  }

  /** Saved on every wizard step transition (not on every keystroke) — enough
   *  to survive a reload/lost connection without saving on every keystroke. */
  async saveOnboardingDraft(sellerId: string, step: number, maxReached: number, form: Record<string, unknown>) {
    await this.db.repositories.sellerModel.updateOne(
      { _id: sellerId },
      { $set: { onboardingDraft: { step, maxReached, form } } },
    );
    return { success: true };
  }

  async getStorePlan(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    let sub = await this.subModel.findOne({ storeId, isDelete: false }).lean();
    // Self-healing read, same lazy-backfill convention this codebase already
    // uses for StoreTheme/StorePage/CollectionTemplate — a store created
    // before this subscription system existed (or whose original
    // `ensureDefaultSubscription` call raced a not-yet-seeded free plan)
    // should never be permanently stuck with no plan record; found via a
    // live QA pass where a real pre-existing store's Billing Center/Finance
    // page surfaced this as a raw 404 with no recovery path in the UI.
    if (!sub) {
      const created = await this.ensureDefaultSubscription(storeId, sellerId);
      if (created) sub = (created as any).toObject ? (created as any).toObject() : created;
    }
    if (!sub) throw new NotFoundException('This store has no platform-plan record yet — no free plan is configured. Contact support.');
    const plan = await this.planModel.findById((sub as any).platformPlanId).lean();
    return { success: true, data: { ...sub, plan } };
  }

  /** Seller's own platform-plan billing history for one store — invoice list + download links. */
  async listInvoices(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(50, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;

    const [invoices, total] = await Promise.all([
      this.invoiceModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.invoiceModel.countDocuments(filter),
    ]);

    return { success: true, data: { invoices, total, page, limit, pages: Math.ceil(total / limit) } };
  }

  /**
   * Admin-only refund for a platform-plan invoice (seller-to-Solvexo billing
   * — there is no seller-balance credit to reverse here, unlike buyer-VIP-plan
   * invoices, since platform-plan revenue never touches SellerBalance).
   */
  async adminRefundInvoice(adminId: string, invoiceId: string, amountUSD?: number, reason?: string) {
    const invoice = await this.invoiceModel.findOne({ _id: invoiceId, isDelete: false });
    if (!invoice) throw new NotFoundException('Invoice not found');
    if (!['paid', 'partially_refunded'].includes(invoice.status)) {
      throw new BadRequestException(`Cannot refund an invoice with status "${invoice.status}"`);
    }
    if (!invoice.providerChargeId) {
      throw new BadRequestException('This invoice has no associated charge to refund');
    }

    const remaining = this.round(invoice.amountUSD - (invoice.refundedAmountUSD ?? 0));
    const refundAmount = amountUSD != null ? this.round(amountUSD) : remaining;
    if (refundAmount <= 0 || refundAmount > remaining) {
      throw new BadRequestException(`Refund amount must be between $0.01 and $${remaining.toFixed(2)}`);
    }

    const result = await this.gateway.refund(invoice.providerChargeId, refundAmount, reason);
    if (!result.success) {
      throw new BadRequestException(`Refund failed: ${result.failureReason ?? 'declined by payment provider'}`);
    }

    invoice.refundedAmountUSD = this.round((invoice.refundedAmountUSD ?? 0) + refundAmount);
    invoice.status = invoice.refundedAmountUSD >= invoice.amountUSD ? 'refunded' : 'partially_refunded';
    invoice.refundedAt = new Date();
    invoice.providerRefundId = result.providerRefundId ?? invoice.providerRefundId;
    await invoice.save();

    this.activityLogService.log({
      storeId: invoice.storeId, category: 'platform_plans', action: 'invoice_refunded',
      description: `Platform-plan invoice ${invoice.invoiceNumber} — $${refundAmount.toFixed(2)} refunded${reason ? ` (${reason})` : ''}`,
      actorId: adminId, actorRole: 'admin', targetId: (invoice as any)._id.toString(), targetType: 'platform_plan_invoice',
    });

    return { success: true, message: `$${refundAmount.toFixed(2)} refunded`, data: invoice };
  }

  /**
   * Upgrade/downgrade/first-paid-purchase for a store's platform plan.
   * Mirrors the buyer-facing `SubscriptionsService.changePlan()` proration
   * math exactly (unused-time credit + net-due charge or credit carryover) —
   * same engine, different collection.
   */
  async changePlan(sellerId: string, storeId: string, dto: ChangePlatformPlanDto | SubscribePlatformPlanDto, idempotencyKey?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    let sub = await this.subModel.findOne({ storeId, isDelete: false });
    if (!sub) sub = await this.ensureDefaultSubscription(storeId, sellerId) as any;
    if (!sub) throw new BadRequestException('No platform plans have been configured yet — contact support');

    const newPlanId = 'newPlatformPlanId' in dto ? dto.newPlatformPlanId : dto.platformPlanId;
    const newInterval = 'newBillingInterval' in dto ? dto.newBillingInterval : dto.billingInterval;

    const [oldPlan, newPlan] = await Promise.all([
      this.planModel.findById(sub.platformPlanId),
      this.planModel.findOne({ _id: newPlanId, isDelete: false, status: 'active' }),
    ]);
    if (!newPlan) throw new NotFoundException('Target platform plan not found or inactive');
    if (newPlan.isCustomPricing) throw new BadRequestException('This plan requires contacting sales — it has no self-serve checkout');
    if (String(sub.platformPlanId) === String(newPlanId) && sub.billingInterval === newInterval) {
      throw new BadRequestException('This is already your current plan');
    }

    const now = new Date();
    const { newAmountUSD, totalCreditAvailable, netDue, isFreeMoveIn } = this.computeProration(sub, newPlan, newInterval);
    void totalCreditAvailable; // surfaced via previewChangePlan; changePlan itself only needs netDue

    const historyEntry = {
      fromPlanId: sub.platformPlanId, fromPlanName: oldPlan?.name ?? 'Unknown',
      toPlanId: newPlanId, toPlanName: newPlan.name, proratedAmountUSD: netDue, changedAt: now,
    };

    let invoice: any = null;
    let message: string;

    if (isFreeMoveIn) {
      sub.creditBalanceUSD = 0; // moving to free forfeits any remaining paid-tier credit
      message = `Moved to the free "${newPlan.name}" plan`;
      if (sub.providerSubscriptionId) {
        await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
        sub.providerSubscriptionId = null;
      }
    } else if (netDue > 0) {
      const isFirstPaidPurchase = !sub.stripeCustomerId && this.gateway.isProviderDrivenBilling;
      // Still trialing (real time left) and not explicitly skipping the rest
      // of it — no charge is allowed yet, whether this is the seller's first
      // plan commitment or a second plan change made before the trial ends.
      const isMidTrial = sub.status === 'trialing' && sub.trialEndsAt && new Date(sub.trialEndsAt).getTime() > now.getTime();
      const billImmediately = !!(dto as any).billImmediately;

      if (isMidTrial && !billImmediately && sub.providerSubscriptionId) {
        // Already trial-converted once (has a Stripe subscription with
        // trial_end pending) and now switching to a DIFFERENT plan before
        // that trial ends — just re-point the pending subscription at the
        // new price, no charge now (mirrors the "existing subscription,
        // price sync only" tail below, entered early to skip the
        // immediate-top-up-charge path that's only correct outside a trial).
        if (this.gateway.isProviderDrivenBilling) {
          const newProviderPriceId = newInterval === 'yearly' ? newPlan.stripeYearlyPriceId : newPlan.stripeMonthlyPriceId;
          if (newProviderPriceId) {
            await this.gateway.updateProviderSubscriptionPrice(sub.providerSubscriptionId, newProviderPriceId, 'none');
          }
        }
        sub.platformPlanId = newPlanId;
        sub.billingInterval = newInterval;
        sub.amountUSD = this.round(newAmountUSD);
        sub.planHistory = [...(sub.planHistory ?? []), historyEntry];
        await sub.save();
        this.activityLogService.log({
          storeId, category: 'platform_plans', action: 'plan_changed',
          description: `Store switched its trial commitment to "${newPlan.name}" — still no charge until the trial ends`,
          actorId: sellerId, actorRole: 'seller', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
        });
        return { success: true, message: `Switched to "${newPlan.name}" — billing still starts when your trial ends`, data: { subscription: sub } };
      }

      if (this.gateway.isProviderDrivenBilling && !sub.providerSubscriptionId) {
        // First time this store goes onto a paid Stripe-billed plan.
        const seller = await this.db.repositories.sellerModel.findById(sellerId);
        if (!seller) throw new NotFoundException('Seller account not found');
        if (!seller.stripeCustomerId) {
          const { providerCustomerId } = await this.gateway.getOrCreateCustomer(sellerId, seller.email, seller.name ?? '');
          seller.stripeCustomerId = providerCustomerId;
          await seller.save();
        }
        if (!newPlan[newInterval === 'yearly' ? 'stripeYearlyPriceId' : 'stripeMonthlyPriceId']) {
          const { providerProductId, providerPriceId } = await this.gateway.getOrCreatePrice({
            planId: newPlan._id.toString(), planName: `Platform: ${newPlan.name}`, storeId,
            amountUSD: newAmountUSD, interval: newInterval,
            existingProductId: newPlan.stripeProductId,
          });
          newPlan.stripeProductId = providerProductId;
          if (newInterval === 'yearly') newPlan.stripeYearlyPriceId = providerPriceId; else newPlan.stripeMonthlyPriceId = providerPriceId;
          await newPlan.save();
        }
        const providerPriceId = newInterval === 'yearly' ? newPlan.stripeYearlyPriceId : newPlan.stripeMonthlyPriceId;

        // Trial-conversion: a still-trialing store that commits to a plan
        // without asking to skip the rest of its trial gets a REAL Stripe
        // subscription now, with Stripe's own `trial_end` set to the
        // existing trialEndsAt — Stripe charges nothing until then, and the
        // local status stays 'trialing' (not flipped to 'active') until the
        // invoice.payment_succeeded webhook actually confirms a charge.
        const trialEndUnixSeconds = isMidTrial && !billImmediately ? Math.floor(new Date(sub.trialEndsAt!).getTime() / 1000) : undefined;

        const created = await this.gateway.createProviderSubscription(
          sub._id.toString(), `Platform: ${newPlan.name}`, newAmountUSD, newInterval,
          { providerCustomerId: seller.stripeCustomerId, providerPriceId, idempotencyKey, trialEndUnixSeconds, metadata: { kind: PLATFORM_PLAN_STRIPE_METADATA_KIND, storeId } },
        );
        sub.providerSubscriptionId = created.providerSubscriptionId;
        sub.stripeCustomerId = seller.stripeCustomerId;
        sub.status = created.status === 'trialing' ? 'trialing' : (created.status === 'active' ? 'active' : 'past_due');

        sub.platformPlanId = newPlanId;
        sub.billingInterval = newInterval;
        sub.amountUSD = this.round(newAmountUSD);
        // A trial-conversion commit does NOT reset the billing period — the
        // store keeps its existing trialEndsAt/currentPeriodEnd until Stripe
        // actually bills at that date; only a real, non-trial subscription
        // creation starts a fresh period right now.
        if (!trialEndUnixSeconds) {
          sub.currentPeriodStart = now;
          sub.currentPeriodEnd = this.addPeriod(now, newInterval);
          sub.nextBillingDate = sub.currentPeriodEnd;
        }
        sub.planHistory = [...(sub.planHistory ?? []), historyEntry];
        await sub.save();

        this.activityLogService.log({
          storeId, category: 'platform_plans', action: 'plan_changed',
          description: trialEndUnixSeconds
            ? `Store committed to "${newPlan.name}" — billing starts when the trial ends`
            : `Store moved to "${newPlan.name}" (awaiting Stripe payment confirmation)`,
          actorId: sellerId, actorRole: 'seller', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
        });

        return {
          success: true,
          message: trialEndUnixSeconds
            ? `You're set for "${newPlan.name}" — billing starts automatically when your trial ends`
            : `Subscribing to "${newPlan.name}" — confirm payment to activate`,
          data: { subscription: sub, requiresAction: !!created.clientSecret, clientSecret: created.clientSecret ?? null },
        };
      }

      // Manual provider (or Stripe subscription already exists — proration top-up charge)
      const charge = await this.gateway.chargeSubscription(sub._id.toString(), netDue, { providerCustomerId: sub.stripeCustomerId ?? undefined, idempotencyKey });
      invoice = await this.invoiceModel.create({
        storeId, sellerId, platformPlanId: newPlanId,
        invoiceNumber: await this.generateInvoiceNumber(), type: isFirstPaidPurchase ? 'initial' : 'proration',
        amountUSD: netDue, status: charge.success ? 'paid' : 'failed',
        paidAt: charge.success ? now : null, providerChargeId: charge.providerChargeId,
        paymentMethodType: charge.paymentMethodType ?? 'manual',
      });
      await this.recordAttempt({
        storeId, sellerId, attemptType: 'proration', outcome: charge.success ? 'success' : 'failed',
        amountUSD: netDue, failureReason: charge.success ? null : (charge.failureReason ?? 'Payment declined'),
        failureCode: charge.failureCode ?? null, invoiceId: invoice._id.toString(), providerChargeId: charge.providerChargeId,
      });
      if (!charge.success) throw new BadRequestException(`Payment of $${netDue.toFixed(2)} failed — plan was not changed`);

      sub.totalPaidUSD = this.round((sub.totalPaidUSD ?? 0) + netDue);
      sub.creditBalanceUSD = 0;
      message = `Changed to "${newPlan.name}" — $${netDue.toFixed(2)} charged`;
    } else {
      sub.creditBalanceUSD = this.round(-netDue);
      message = `Changed to "${newPlan.name}" — $${sub.creditBalanceUSD.toFixed(2)} credited to your account`;
    }

    sub.platformPlanId = newPlanId;
    sub.billingInterval = newInterval;
    sub.amountUSD = this.round(newAmountUSD);
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = this.addPeriod(now, newInterval);
    sub.nextBillingDate = sub.currentPeriodEnd;
    sub.failedPaymentAttempts = 0;
    sub.canceledAt = null;
    // Any change of plan — including re-subscribing before a scheduled
    // cancellation reached period end — implicitly clears that schedule.
    const hadPendingCancellation = sub.cancelAtPeriodEnd;
    sub.cancelAtPeriodEnd = false;
    sub.cancelReason = null;
    sub.status = 'active';
    sub.planHistory = [...(sub.planHistory ?? []), historyEntry];
    await sub.save();
    await this.syncFeaturedBadge(storeId, newPlan);
    if (hadPendingCancellation && this.gateway.isProviderDrivenBilling && sub.providerSubscriptionId) {
      await this.gateway.unscheduleProviderCancellation(sub.providerSubscriptionId);
    }

    if (this.gateway.isProviderDrivenBilling && sub.providerSubscriptionId) {
      const newProviderPriceId = newInterval === 'yearly' ? newPlan.stripeYearlyPriceId : newPlan.stripeMonthlyPriceId;
      if (newProviderPriceId) {
        try {
          await this.gateway.updateProviderSubscriptionPrice(sub.providerSubscriptionId, newProviderPriceId, 'none');
        } catch (err: any) {
          this.logger.warn(`Failed to sync Stripe platform-plan price for store ${storeId}: ${err?.message}`);
        }
      }
    }

    this.activityLogService.log({
      storeId, category: 'platform_plans', action: 'plan_changed',
      description: message, actorId: sellerId, actorRole: 'seller',
      targetId: sub._id.toString(), targetType: 'seller_platform_subscription', metadata: historyEntry,
    });

    const { sellerName, sellerEmail, storeName } = await this.getSellerAndStoreNames(sellerId, storeId);
    if (sellerEmail) {
      if (isFreeMoveIn) {
        await this.notifications.sendMovedToFreePlan(sellerEmail, { sellerName, storeName, planName: newPlan.name });
      } else if (netDue > 0) {
        await this.notifications.sendPlanUpgraded(sellerEmail, {
          sellerName, storeName, fromPlanName: historyEntry.fromPlanName, toPlanName: newPlan.name, amountUSD: netDue,
        });
      } else {
        await this.notifications.sendPlanChangeCredited(sellerEmail, {
          sellerName, storeName, fromPlanName: historyEntry.fromPlanName, toPlanName: newPlan.name, creditUSD: sub.creditBalanceUSD,
        });
      }
    }

    return { success: true, message, data: { subscription: sub, invoice } };
  }

  /**
   * Dry-run of `changePlan`'s exact proration math — no DB write, no charge,
   * no Stripe call. This is what the seller-facing "confirm your plan change"
   * modal calls before showing an amount, so the number it shows can never
   * drift from what `changePlan` actually charges a moment later.
   */
  async previewChangePlan(sellerId: string, storeId: string, dto: ChangePlatformPlanDto | SubscribePlatformPlanDto) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const sub = await this.subModel.findOne({ storeId, isDelete: false }).lean();
    if (!sub) throw new NotFoundException('This store has no platform-plan record yet');

    const newPlanId = 'newPlatformPlanId' in dto ? dto.newPlatformPlanId : dto.platformPlanId;
    const newInterval = ('newBillingInterval' in dto ? dto.newBillingInterval : dto.billingInterval);

    const [currentPlan, newPlan] = await Promise.all([
      this.planModel.findById((sub as any).platformPlanId).lean(),
      this.planModel.findOne({ _id: newPlanId, isDelete: false, status: 'active' }).lean(),
    ]);
    if (!newPlan) throw new NotFoundException('Target platform plan not found or inactive');
    if ((newPlan as any).isCustomPricing) throw new BadRequestException('This plan requires contacting sales — it has no self-serve checkout');
    if (String((sub as any).platformPlanId) === String(newPlanId) && (sub as any).billingInterval === newInterval) {
      throw new BadRequestException('This is already your current plan');
    }

    const proration = this.computeProration(sub, newPlan, newInterval);
    const direction = String((sub as any).platformPlanId) === String(newPlanId)
      ? (newInterval === 'yearly' ? 'billing_interval_change' : 'billing_interval_change')
      : (proration.newAmountUSD > ((sub as any).amountUSD ?? 0) ? 'upgrade' : 'downgrade');

    return {
      success: true,
      data: {
        direction,
        currentPlanName: (currentPlan as any)?.name ?? 'Unknown',
        currentAmountUSD: (sub as any).amountUSD ?? 0,
        newPlanName: newPlan.name,
        newAmountUSD: proration.newAmountUSD,
        newBillingInterval: newInterval,
        remainingDaysInCurrentPeriod: Math.max(0, Math.ceil((new Date((sub as any).currentPeriodEnd).getTime() - Date.now()) / (24 * 60 * 60 * 1000))),
        unusedCreditFromCurrentPlanUSD: proration.unusedCredit,
        existingCreditBalanceUSD: proration.existingCreditBalanceUSD,
        totalCreditAppliedUSD: proration.totalCreditAvailable,
        amountDueTodayUSD: proration.willChargeUSD,
        creditAppliedToBalanceUSD: proration.willCreditUSD,
        effectiveImmediately: true,
      },
    };
  }

  /**
   * Explicit "Cancel Subscription" — schedules a downgrade to the free plan
   * at the end of the period the seller already paid for (Stripe/Shopify/
   * Paddle convention). Access and entitlements are unaffected until then;
   * `finalizeScheduledCancellations()` executes the actual downgrade.
   */
  async cancelSubscription(sellerId: string, storeId: string, reason?: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const sub = await this.subModel.findOne({ storeId, isDelete: false });
    if (!sub) throw new NotFoundException('This store has no platform-plan record yet');
    if ((sub.amountUSD ?? 0) === 0) throw new BadRequestException('You are already on the free plan — there is nothing to cancel');
    if (sub.cancelAtPeriodEnd) throw new BadRequestException(`Cancellation is already scheduled for ${sub.currentPeriodEnd.toDateString()}`);

    sub.cancelAtPeriodEnd = true;
    sub.canceledAt = new Date();
    sub.cancelReason = reason?.trim() || null;
    await sub.save();

    if (this.gateway.isProviderDrivenBilling && sub.providerSubscriptionId) {
      await this.gateway.scheduleProviderCancellation(sub.providerSubscriptionId);
    }

    this.activityLogService.log({
      storeId, category: 'platform_plans', action: 'plan_cancel_scheduled',
      description: `Cancellation scheduled — plan reverts to the free tier on ${sub.currentPeriodEnd.toDateString()}${reason ? ` (reason: ${reason})` : ''}`,
      actorId: sellerId, actorRole: 'seller', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
    });
    this.notificationsService.notify({
      recipientId: sellerId, recipientRole: 'seller',
      type: NOTIFICATION_TYPES.PLATFORM_PLAN_RENEWAL_REMINDER,
      title: 'Cancellation scheduled',
      body: `Your plan will revert to the free tier on ${sub.currentPeriodEnd.toDateString()}. You keep full access until then.`,
      data: { subscriptionId: String(sub._id) },
    }).catch(() => {});

    return {
      success: true,
      message: `Your plan will move to the free tier on ${sub.currentPeriodEnd.toDateString()} — you keep full access until then.`,
      data: { subscription: sub },
    };
  }

  /** Undoes a still-pending `cancelSubscription` — the subscription keeps renewing normally. */
  async reactivateSubscription(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    const sub = await this.subModel.findOne({ storeId, isDelete: false });
    if (!sub) throw new NotFoundException('This store has no platform-plan record yet');
    if (!sub.cancelAtPeriodEnd) {
      throw new BadRequestException('There is no pending cancellation to undo — choose a plan to subscribe instead.');
    }

    sub.cancelAtPeriodEnd = false;
    sub.canceledAt = null;
    sub.cancelReason = null;
    await sub.save();

    if (this.gateway.isProviderDrivenBilling && sub.providerSubscriptionId) {
      await this.gateway.unscheduleProviderCancellation(sub.providerSubscriptionId);
    }

    this.activityLogService.log({
      storeId, category: 'platform_plans', action: 'plan_cancel_reversed',
      description: 'Scheduled cancellation reversed — plan continues renewing normally',
      actorId: sellerId, actorRole: 'seller', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
    });

    return { success: true, message: 'Your subscription will continue renewing as normal.', data: { subscription: sub } };
  }

  /** Stripe-hosted self-service portal for platform-plan billing — card updates, past invoices — same gateway method the buyer-billing system already uses. */
  async createBillingPortalSession(sellerId: string, storeId: string, returnUrl: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const sub = await this.subModel.findOne({ storeId, isDelete: false }).lean();
    if (!sub || !(sub as any).stripeCustomerId) {
      throw new BadRequestException('No Stripe billing profile exists yet for this store — subscribe to a paid plan first.');
    }
    const result = await this.gateway.createBillingPortalSession((sub as any).stripeCustomerId, returnUrl);
    return { success: true, data: result };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Billing automation — mirrors SubscriptionsService.processRenewals()
  // ═══════════════════════════════════════════════════════════════════════

  async processRenewals(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const now = new Date();
    const due = await this.subModel.find({
      status: { $in: ['active', 'past_due'] },
      paymentProvider: 'manual',
      amountUSD: { $gt: 0 }, // free-plan stores never "renew" a charge
      cancelAtPeriodEnd: { $ne: true }, // a scheduled cancellation reverts to free at period end instead of renewing
      nextBillingDate: { $lte: now },
      isDelete: false,
    });

    let succeeded = 0, failed = 0;
    for (const sub of due) {
      try {
        const creditToApply = this.round(Math.min(sub.creditBalanceUSD ?? 0, sub.amountUSD));
        const chargeAmount = this.round(sub.amountUSD - creditToApply);
        const charge = chargeAmount > 0
          ? await this.gateway.chargeSubscription(sub._id.toString(), chargeAmount)
          : { success: true, providerChargeId: null as string | null, paymentMethodType: 'manual' };

        const invoice = await this.invoiceModel.create({
          storeId: sub.storeId, sellerId: sub.sellerId, platformPlanId: sub.platformPlanId,
          invoiceNumber: await this.generateInvoiceNumber(), type: 'recurring',
          amountUSD: chargeAmount, status: charge.success ? 'paid' : 'failed',
          paidAt: charge.success ? now : null, providerChargeId: charge.providerChargeId,
          paymentMethodType: (charge as any).paymentMethodType ?? 'manual',
        });

        await this.recordAttempt({
          storeId: sub.storeId, sellerId: sub.sellerId, attemptType: 'renewal',
          outcome: charge.success ? 'success' : 'failed', amountUSD: chargeAmount,
          failureReason: charge.success ? null : ((charge as any).failureReason ?? 'Payment declined'),
          invoiceId: invoice._id.toString(), providerChargeId: charge.providerChargeId,
        });

        if (charge.success) {
          const periodEnd = this.addPeriod(now, sub.billingInterval as 'monthly' | 'yearly');
          sub.status = 'active';
          sub.currentPeriodStart = now;
          sub.currentPeriodEnd = periodEnd;
          sub.nextBillingDate = periodEnd;
          sub.totalPaidUSD = this.round(sub.totalPaidUSD + chargeAmount);
          sub.creditBalanceUSD = this.round((sub.creditBalanceUSD ?? 0) - creditToApply);
          sub.failedPaymentAttempts = 0;
          succeeded++;
        } else {
          await this.applyDunningFailure(sub, chargeAmount);
          failed++;
        }
        await sub.save();
      } catch (err: any) {
        this.logger.error(`Platform-plan renewal failed for store ${sub.storeId}: ${err?.message}`);
        failed++;
      }
    }

    return { processed: due.length, succeeded, failed };
  }

  /**
   * Trials that have run out. A trial that was already converted to a real
   * Stripe subscription (see `changePlan`'s `trial_end` path) needs no
   * action here — Stripe itself invoices at `trial_end` and the result
   * arrives via the `invoice.payment_succeeded`/`invoice.payment_failed`
   * webhooks, which drive `status` from there. A trial that was NEVER
   * converted (no `providerSubscriptionId`) has nothing for Stripe to bill —
   * this is the only case this job actually acts on: `legacyFreeEligible`
   * stores (shouldn't structurally occur here, but handled for safety) fall
   * back to the free plan exactly as before; every other store — the normal
   * case for the trial-based model — gets locked. No permanent free
   * fallback, no data touched beyond the subscription's own billing fields.
   */
  async expireTrials(): Promise<{ expired: number }> {
    const now = new Date();
    const due = await this.subModel.find({ status: 'trialing', trialEndsAt: { $lte: now }, isDelete: false });

    let expired = 0;
    for (const sub of due) {
      if (sub.paymentProvider === 'stripe' && sub.providerSubscriptionId) {
        // A real Stripe subscription exists — Stripe itself will invoice at
        // trial end and we react via webhook; just clear our local flag.
        sub.status = 'active';
        sub.trialEndsAt = null;
        await sub.save();
        expired++;
        continue;
      }

      if (sub.legacyFreeEligible) {
        const freePlan = await this.downgradeToFree(sub);
        if (!freePlan) continue;
      } else {
        await this.lockStore(sub);
        const { sellerName, sellerEmail, storeName } = await this.getSellerAndStoreNames(sub.sellerId, sub.storeId);
        if (sellerEmail) {
          await this.notifications.sendStoreLocked(sellerEmail, { sellerName, storeName, reason: 'trial_ended' }).catch(() => {});
        }
        this.notificationsService.notify({
          recipientId: sub.sellerId, recipientRole: 'seller',
          type: NOTIFICATION_TYPES.PLATFORM_PLAN_PAYMENT_FAILED,
          title: 'Trial ended — store locked',
          body: `${storeName}'s trial ended without a paid plan — choose one to unlock selling again. Your data is safe.`,
          data: { subscriptionId: String(sub._id) },
        }).catch(() => {});
        this.activityLogService.log({
          storeId: sub.storeId, category: 'platform_plans', action: 'plan_locked_trial_expired',
          description: 'Store locked (selling restricted) — trial ended with no paid conversion',
          actorRole: 'system', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
        });
      }
      sub.trialEndsAt = null;
      await sub.save();
      expired++;
    }
    return { expired };
  }

  /**
   * Executes `cancelSubscription()`'s promise once the paid period the seller
   * already covered actually ends — for manual-provider subs only (a
   * Stripe-driven cancellation resolves itself via the `customer.subscription.deleted`
   * webhook once Stripe's own `cancel_at_period_end` fires). Runs daily via SchedulerService.
   */
  async finalizeScheduledCancellations(): Promise<{ downgraded: number }> {
    const now = new Date();
    const due = await this.subModel.find({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: { $lte: now },
      isDelete: false,
      $or: [{ paymentProvider: 'manual' }, { providerSubscriptionId: null }],
    });

    let downgraded = 0;
    for (const sub of due) {
      if (sub.legacyFreeEligible) {
        const freePlan = await this.downgradeToFree(sub);
        if (!freePlan) continue;
        await sub.save();
        downgraded++;
        this.activityLogService.log({
          storeId: sub.storeId, category: 'platform_plans', action: 'plan_downgraded_cancellation',
          description: `Scheduled cancellation reached period end — store moved to the ${freePlan.name} plan`,
          actorRole: 'system', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
        });
      } else {
        await this.lockStore(sub);
        await sub.save();
        downgraded++;
        const { sellerName, sellerEmail, storeName } = await this.getSellerAndStoreNames(sub.sellerId, sub.storeId);
        if (sellerEmail) {
          await this.notifications.sendStoreLocked(sellerEmail, { sellerName, storeName, reason: 'subscription_ended' }).catch(() => {});
        }
        this.activityLogService.log({
          storeId: sub.storeId, category: 'platform_plans', action: 'plan_locked_cancellation',
          description: 'Scheduled cancellation reached period end — store locked (selling restricted)',
          actorRole: 'system', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
        });
      }
    }
    return { downgraded };
  }

  /** Sends a one-time "trial ends in ≤3 days" email per store — runs daily via SchedulerService. */
  async sendTrialEndingReminders(): Promise<{ sent: number }> {
    const REMINDER_WINDOW_DAYS = 3;
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const due = await this.subModel.find({
      status: 'trialing', trialReminderSent: false,
      trialEndsAt: { $gte: now, $lte: windowEnd }, isDelete: false,
    });

    let sent = 0;
    for (const sub of due) {
      const [{ sellerName, sellerEmail, storeName }, plan] = await Promise.all([
        this.getSellerAndStoreNames(sub.sellerId, sub.storeId),
        this.planModel.findById(sub.platformPlanId).select('name').lean(),
      ]);
      const trialEndsAt: Date = sub.trialEndsAt ?? now;
      const daysLeft = Math.max(0, Math.round((trialEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
      if (sellerEmail) {
        await this.notifications.sendTrialEndingSoon(sellerEmail, {
          sellerName, storeName, planName: (plan as any)?.name ?? 'your plan',
          amountUSD: sub.amountUSD, daysLeft, trialEndsAt,
        });
      }
      this.notificationsService.notify({
        recipientId: sub.sellerId,
        recipientRole: 'seller',
        type: NOTIFICATION_TYPES.PLATFORM_PLAN_RENEWAL_REMINDER,
        title: 'Trial ending soon',
        body: `Your ${storeName} plan trial ends in ${daysLeft} day(s).`,
        data: { subscriptionId: String(sub._id) },
      }).catch(() => {});
      sub.trialReminderSent = true;
      await sub.save();
      sent++;
    }
    return { sent };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Stripe webhook handlers — same shape as SubscriptionsService's
  // ═══════════════════════════════════════════════════════════════════════

  @OnEvent('stripe.invoice.payment_succeeded')
  async handleInvoicePaymentSucceeded(invoice: any): Promise<void> {
    const providerSubscriptionId: string | undefined = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
    if (!providerSubscriptionId) return;
    const sub = await this.subModel.findOne({ providerSubscriptionId, isDelete: false });
    if (!sub) return; // not one of ours — belongs to the buyer-VIP-plan system instead
    if (await this.invoiceModel.exists({ stripeInvoiceId: invoice.id })) return; // duplicate webhook delivery

    const amountUSD = this.round((invoice.amount_paid ?? 0) / 100);
    const line = invoice.lines?.data?.[0];
    const periodEnd = line?.period?.end ? new Date(line.period.end * 1000) : this.addPeriod(new Date(), sub.billingInterval as any);
    const providerChargeId = typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent?.id ?? null;

    await this.invoiceModel.create({
      storeId: sub.storeId, sellerId: sub.sellerId, platformPlanId: sub.platformPlanId,
      invoiceNumber: await this.generateInvoiceNumber(),
      type: invoice.billing_reason === 'subscription_create' ? 'initial' : 'recurring',
      amountUSD, status: 'paid', paidAt: new Date(), providerChargeId, stripeInvoiceId: invoice.id,
      hostedInvoiceUrl: invoice.hosted_invoice_url ?? null, invoicePdfUrl: invoice.invoice_pdf ?? null,
      paymentMethodType: 'card',
    });

    sub.status = 'active';
    sub.currentPeriodStart = new Date();
    sub.currentPeriodEnd = periodEnd;
    sub.nextBillingDate = periodEnd;
    sub.totalPaidUSD = this.round(sub.totalPaidUSD + amountUSD);
    sub.failedPaymentAttempts = 0;
    await sub.save();

    const plan = await this.planModel.findById(sub.platformPlanId).lean();
    await this.syncFeaturedBadge(sub.storeId, plan);

    this.activityLogService.log({
      storeId: sub.storeId, category: 'platform_plans', action: 'plan_renewed',
      description: `Platform-plan Stripe invoice ${invoice.id} paid — $${amountUSD.toFixed(2)}`,
      actorRole: 'system', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
    });
  }

  @OnEvent('stripe.invoice.payment_failed')
  async handleInvoicePaymentFailed(invoice: any): Promise<void> {
    const providerSubscriptionId: string | undefined = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
    if (!providerSubscriptionId) return;
    const sub = await this.subModel.findOne({ providerSubscriptionId, isDelete: false });
    if (!sub) return; // not one of ours
    const amountUSD = this.round((invoice.amount_due ?? 0) / 100);
    await this.applyDunningFailure(sub, amountUSD);
    await sub.save();
  }

  @OnEvent('stripe.customer.subscription.deleted')
  async handleSubscriptionDeleted(subscription: any): Promise<void> {
    // Scoped to the exact deleted Stripe subscription id — if the seller
    // already resubscribed (a replacement subscription B), the local
    // record's providerSubscriptionId already points at B, so a
    // late-arriving `deleted` event for the OLD subscription A finds no
    // match here and safely no-ops. This is what prevents a superseded
    // webhook from overriding a valid newer subscription.
    const sub = await this.subModel.findOne({ providerSubscriptionId: subscription.id, isDelete: false });
    if (!sub) return;
    // Covers both a scheduled cancelSubscription() reaching its period end
    // on Stripe's side and any other way a Stripe subscription permanently
    // ends. Legacy grandfathered stores land on the free plan exactly as
    // before; every other store has no permanent free fallback and gets
    // locked instead (see legacyFreeEligible's schema comment).
    if (sub.legacyFreeEligible) {
      await this.downgradeToFree(sub);
    } else {
      await this.lockStore(sub);
      const { sellerName, sellerEmail, storeName } = await this.getSellerAndStoreNames(sub.sellerId, sub.storeId);
      if (sellerEmail) {
        await this.notifications.sendStoreLocked(sellerEmail, { sellerName, storeName, reason: 'subscription_ended' }).catch(() => {});
      }
      this.activityLogService.log({
        storeId: sub.storeId, category: 'platform_plans', action: 'plan_locked_subscription_deleted',
        description: 'Stripe subscription ended with no replacement — store locked (selling restricted)',
        actorRole: 'system', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
      });
    }
    sub.providerSubscriptionId = null;
    await sub.save();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Seller Overview — cross-store view
  // ═══════════════════════════════════════════════════════════════════════

  async getSellerOverview(sellerId: string) {
    const stores = await this.storeModel.find({ sellerId, isDelete: false }).select('name slug logo status').lean();
    const storeIds = stores.map((s: any) => s._id.toString());

    const [subs, plans] = await Promise.all([
      this.subModel.find({ storeId: { $in: storeIds }, isDelete: false }).lean(),
      this.planModel.find({ isDelete: false }).lean(),
    ]);
    const subByStore = Object.fromEntries(subs.map((s: any) => [s.storeId, s]));
    const planMap = Object.fromEntries(plans.map((p: any) => [p._id.toString(), p]));

    const rows = stores.map((store: any) => {
      const sub = subByStore[store._id.toString()];
      const plan = sub ? planMap[sub.platformPlanId] : null;
      return {
        storeId: store._id, storeName: store.name, storeSlug: store.slug, storeStatus: store.status,
        platformPlan: plan ? { id: plan._id, name: plan.name, isFree: plan.isFree } : null,
        subscriptionStatus: sub?.status ?? 'none', nextBillingDate: sub?.nextBillingDate ?? null,
        totalPaidUSD: sub?.totalPaidUSD ?? 0,
      };
    });

    return {
      success: true,
      data: {
        storeCount: stores.length,
        totalPlatformSpendUSD: this.round(rows.reduce((s, r) => s + r.totalPaidUSD, 0)),
        stores: rows,
      },
    };
  }
}
