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

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
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
      // Unlike the buyer system, we never fully "cancel" a store's platform
      // access — every store must always be on SOME tier. Exhausting
      // dunning demotes the store back to the free plan instead.
      const freePlan = await this.planModel.findOne({ isFree: true, status: 'active', isDelete: false });
      if (freePlan) {
        sub.platformPlanId = (freePlan as any)._id.toString();
        sub.amountUSD = 0;
        sub.status = 'active';
        sub.failedPaymentAttempts = 0;
        await this.syncFeaturedBadge(sub.storeId, freePlan);
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

  /** Called by StoreService right after a new store is created — every store always has exactly one of these. */
  async ensureDefaultSubscription(storeId: string, sellerId: string) {
    const existing = await this.subModel.findOne({ storeId });
    if (existing) return existing;

    const freePlan = await this.planModel.findOne({ isFree: true, status: 'active', isDelete: false });
    if (!freePlan) {
      this.logger.warn(`No free PlatformPlan exists yet — store ${storeId} created without a platform-plan record (admin must create one)`);
      return null;
    }

    const now = new Date();
    return this.subModel.create({
      storeId, sellerId, platformPlanId: (freePlan as any)._id.toString(),
      billingInterval: 'monthly', amountUSD: 0, status: 'active',
      startedAt: now, currentPeriodStart: now, currentPeriodEnd: this.addPeriod(now, 'monthly'),
      nextBillingDate: this.addPeriod(now, 'monthly'),
    });
  }

  async getStorePlan(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const sub = await this.subModel.findOne({ storeId, isDelete: false }).lean();
    if (!sub) throw new NotFoundException('This store has no platform-plan record yet');
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

    const newAmountUSD = newPlan.isFree ? 0 : (newInterval === 'yearly' ? (newPlan.yearlyPriceUSD ?? this.round((newPlan.monthlyPriceUSD ?? 0) * 12)) : (newPlan.monthlyPriceUSD ?? 0));

    const now = new Date();
    const totalPeriodMs = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
    const remainingMs = Math.max(0, sub.currentPeriodEnd.getTime() - now.getTime());
    const remainingRatio = totalPeriodMs > 0 ? Math.min(1, remainingMs / totalPeriodMs) : 0;
    const unusedCredit = this.round((sub.amountUSD ?? 0) * remainingRatio);
    const totalCreditAvailable = this.round(unusedCredit + (sub.creditBalanceUSD ?? 0));
    const netDue = this.round(newAmountUSD - totalCreditAvailable);

    const historyEntry = {
      fromPlanId: sub.platformPlanId, fromPlanName: oldPlan?.name ?? 'Unknown',
      toPlanId: newPlanId, toPlanName: newPlan.name, proratedAmountUSD: netDue, changedAt: now,
    };

    let invoice: any = null;
    let message: string;
    const isFreeMoveIn = newAmountUSD === 0;

    if (isFreeMoveIn) {
      sub.creditBalanceUSD = 0; // moving to free forfeits any remaining paid-tier credit
      message = `Moved to the free "${newPlan.name}" plan`;
      if (sub.providerSubscriptionId) {
        await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
        sub.providerSubscriptionId = null;
      }
    } else if (netDue > 0) {
      const isFirstPaidPurchase = !sub.stripeCustomerId && this.gateway.isProviderDrivenBilling;

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

        const created = await this.gateway.createProviderSubscription(
          sub._id.toString(), `Platform: ${newPlan.name}`, newAmountUSD, newInterval,
          { providerCustomerId: seller.stripeCustomerId, providerPriceId, idempotencyKey, metadata: { kind: PLATFORM_PLAN_STRIPE_METADATA_KIND, storeId } },
        );
        sub.providerSubscriptionId = created.providerSubscriptionId;
        sub.stripeCustomerId = seller.stripeCustomerId;
        sub.status = created.status === 'active' ? 'active' : 'past_due';

        sub.platformPlanId = newPlanId;
        sub.billingInterval = newInterval;
        sub.amountUSD = this.round(newAmountUSD);
        sub.currentPeriodStart = now;
        sub.currentPeriodEnd = this.addPeriod(now, newInterval);
        sub.nextBillingDate = sub.currentPeriodEnd;
        sub.planHistory = [...(sub.planHistory ?? []), historyEntry];
        await sub.save();

        this.activityLogService.log({
          storeId, category: 'platform_plans', action: 'plan_changed',
          description: `Store moved to "${newPlan.name}" (awaiting Stripe payment confirmation)`,
          actorId: sellerId, actorRole: 'seller', targetId: sub._id.toString(), targetType: 'seller_platform_subscription',
        });

        return {
          success: true,
          message: `Subscribing to "${newPlan.name}" — confirm payment to activate`,
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
    sub.status = 'active';
    sub.planHistory = [...(sub.planHistory ?? []), historyEntry];
    await sub.save();
    await this.syncFeaturedBadge(storeId, newPlan);

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

  // ═══════════════════════════════════════════════════════════════════════
  // Billing automation — mirrors SubscriptionsService.processRenewals()
  // ═══════════════════════════════════════════════════════════════════════

  async processRenewals(): Promise<{ processed: number; succeeded: number; failed: number }> {
    const now = new Date();
    const due = await this.subModel.find({
      status: { $in: ['active', 'past_due'] },
      paymentProvider: 'manual',
      amountUSD: { $gt: 0 }, // free-plan stores never "renew" a charge
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

  /** Trials that have run out and were never converted to a paid card get moved to the free plan (not deleted/blocked). */
  async expireTrials(): Promise<{ expired: number }> {
    const now = new Date();
    const due = await this.subModel.find({ status: 'trialing', trialEndsAt: { $lte: now }, isDelete: false });
    const freePlan = await this.planModel.findOne({ isFree: true, status: 'active', isDelete: false });

    let expired = 0;
    for (const sub of due) {
      if (sub.paymentProvider === 'stripe' && sub.providerSubscriptionId) {
        // A real Stripe subscription exists — Stripe itself will invoice at
        // trial end and we react via webhook; just clear our local flag.
        sub.status = 'active';
      } else if (freePlan) {
        sub.platformPlanId = (freePlan as any)._id.toString();
        sub.amountUSD = 0;
        sub.status = 'active';
      }
      sub.trialEndsAt = null;
      await sub.save();
      expired++;
    }
    return { expired };
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
    const sub = await this.subModel.findOne({ providerSubscriptionId: subscription.id, isDelete: false });
    if (!sub) return;
    const freePlan = await this.planModel.findOne({ isFree: true, status: 'active', isDelete: false });
    if (freePlan) {
      sub.platformPlanId = (freePlan as any)._id.toString();
      sub.amountUSD = 0;
    }
    sub.providerSubscriptionId = null;
    sub.status = 'active';
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
