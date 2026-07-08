/* eslint-disable prettier/prettier */
import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from './payment-gateway/payment-gateway.service';
import { CurrencyDisplayService } from './currency-display.service';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { SubscriptionNotificationsService } from './subscription-notifications.service';
import { SubscriptionBenefitsService } from './subscription-benefits.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { ChangePlanDto } from './dto/change-plan.dto';
import { PlanBenefitDto } from './dto/plan-benefit.dto';

// Dunning: how many consecutive renewal-charge failures before we give up
// and cancel the subscription, and how long to wait before each retry.
const MAX_RENEWAL_ATTEMPTS = 3;
const RETRY_INTERVAL_DAYS = 1;

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly currency: CurrencyDisplayService,
    private readonly activityLogService: ActivityLogService,
    private readonly notifications: SubscriptionNotificationsService,
    private readonly benefitsService: SubscriptionBenefitsService,
  ) {}

  // ── Shorthand getters ────────────────────────────────────────────────────
  private get planModel()    { return this.db.repositories.subscriptionPlanModel; }
  private get subModel()     { return this.db.repositories.subscriptionModel; }
  private get invoiceModel() { return this.db.repositories.subscriptionInvoiceModel; }
  private get attemptModel() { return this.db.repositories.subscriptionPaymentAttemptModel; }
  private get storeModel()   { return this.db.repositories.storeModel; }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private round(n: number) { return Math.round(n * 100) / 100; }

  private generateInvoiceNumber(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `INV-${y}${m}-${rand}`;
  }

  private addPeriod(date: Date, interval: 'monthly' | 'yearly'): Date {
    const d = new Date(date);
    if (interval === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  // Monthly recurring revenue contribution of a single active subscription
  private toMrrContribution(amountUSD: number, interval: string): number {
    return interval === 'monthly' ? amountUSD : this.round(amountUSD / 12);
  }

  /** Same ownership pattern as FinanceService.verifyStoreOwnership. */
  private async verifyStoreOwnership(sellerId: string, storeId: string) {
    const store = await this.storeModel.findById(storeId);
    if (!store || store.isDelete) throw new NotFoundException('Store not found');
    if (store.sellerId.toString() !== sellerId) throw new ForbiddenException('Access denied');
    return store;
  }

  private async verifyPlanInStore(storeId: string, planId: string) {
    const plan = await this.planModel.findOne({ _id: planId, storeId, isDelete: false });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    return plan;
  }

  private async verifySubInStore(storeId: string, subId: string) {
    const sub = await this.subModel.findOne({ _id: subId, storeId, isDelete: false });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  private async verifyMySub(customerId: string, subId: string) {
    const sub = await this.subModel.findOne({ _id: subId, customerId, isDelete: false });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  private pendingCancellation(sub: any): boolean {
    return sub.status === 'active' && !!sub.canceledAt;
  }

  private async getCustomerAndStoreNames(customerId: string, storeId: string) {
    const [customer, store] = await Promise.all([
      this.db.repositories.userModel.findById(customerId).select('name email').lean(),
      this.storeModel.findById(storeId).select('name').lean(),
    ]);
    return {
      customerName: (customer as any)?.name ?? 'there',
      customerEmail: (customer as any)?.email ?? null,
      storeName: (store as any)?.name ?? 'the store',
    };
  }

  /** Records one row in the dunning/retry audit trail. Never throws — logging must not break billing. */
  private async recordPaymentAttempt(params: {
    subscriptionId: string; storeId: string; sellerId: string; customerId: string;
    attemptType: 'initial' | 'renewal' | 'proration';
    outcome: 'success' | 'failed';
    amountUSD: number;
    failureReason?: string | null;
    invoiceId?: string | null;
    providerChargeId?: string | null;
  }) {
    try {
      const attemptNumber = (await this.attemptModel.countDocuments({ subscriptionId: params.subscriptionId })) + 1;
      await this.attemptModel.create({ ...params, attemptNumber, failureReason: params.failureReason ?? null });
    } catch {
      // never let audit logging break the billing flow
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — PLANS (store-scoped)
  // ═══════════════════════════════════════════════════════════════════════════

  async createPlan(sellerId: string, storeId: string, dto: CreatePlanDto) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const displayCurrency = dto.displayCurrency ?? 'USD';
    let exchangeRateSnapshot: number | null = null;
    if (displayCurrency === 'PKR') {
      exchangeRateSnapshot = this.currency.getCurrentPkrRate();
    }

    const plan = await this.planModel.create({
      sellerId,
      storeId,
      name: dto.name,
      description: dto.description ?? null,
      monthlyPriceUSD: this.round(dto.monthlyPriceUSD),
      yearlyPriceUSD: dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null,
      displayCurrency,
      exchangeRateSnapshot,
      features: dto.features ?? [],
      benefits: dto.benefits ?? [],
      status: 'active',
    });

    this.activityLogService.log({
      storeId, category: 'subscriptions', action: 'plan_created',
      description: `Plan "${plan.name}" created — $${plan.monthlyPriceUSD}/mo`,
      actorId: sellerId, actorRole: 'seller',
      targetId: (plan as any)._id.toString(), targetType: 'subscription_plan',
    });

    return { success: true, data: plan };
  }

  private async enrichPlan(plan: any, includeHealth = true) {
    const planId = plan._id.toString();
    const [subscriberCount, mrrAgg, healthEstimate] = await Promise.all([
      this.subModel.countDocuments({ planId, status: 'active' }),
      this.subModel.aggregate([
        { $match: { planId, status: 'active' } },
        { $group: { _id: '$billingInterval', total: { $sum: '$amountUSD' } } },
      ]),
      includeHealth
        ? this.benefitsService.estimatePlanProfitability(plan.storeId, plan.benefits ?? [], plan.monthlyPriceUSD)
        : Promise.resolve(null),
    ]);

    let monthlyRecurringRevenueUSD = 0;
    for (const row of mrrAgg) monthlyRecurringRevenueUSD += this.toMrrContribution(row.total, row._id);

    return {
      ...plan,
      subscriberCount,
      monthlyRecurringRevenueUSD: this.round(monthlyRecurringRevenueUSD),
      displayMonthlyPrice: this.currency.formatForDisplay(
        plan.monthlyPriceUSD, plan.displayCurrency as 'USD' | 'PKR', plan.exchangeRateSnapshot,
      ),
      healthEstimate,
    };
  }

  async listPlans(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const plans = await this.planModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean();
    const enriched = await Promise.all(plans.map((p) => this.enrichPlan(p)));

    return { success: true, data: enriched };
  }

  async getPlanById(sellerId: string, storeId: string, planId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const plan = await this.verifyPlanInStore(storeId, planId);
    const enriched = await this.enrichPlan(plan.toObject());
    return { success: true, data: enriched };
  }

  async updatePlan(sellerId: string, storeId: string, planId: string, dto: UpdatePlanDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const plan = await this.verifyPlanInStore(storeId, planId);

    if (dto.name !== undefined)           plan.name = dto.name;
    if (dto.description !== undefined)    plan.description = dto.description ?? null;
    if (dto.monthlyPriceUSD !== undefined) plan.monthlyPriceUSD = this.round(dto.monthlyPriceUSD);
    if (dto.yearlyPriceUSD !== undefined)
      plan.yearlyPriceUSD = dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null;
    if (dto.features !== undefined)       plan.features = dto.features;
    if (dto.benefits !== undefined)       plan.benefits = dto.benefits;
    if (dto.status !== undefined) {
      if (plan.status === 'suspended') {
        throw new BadRequestException('This plan was suspended by an admin and cannot be reactivated by the seller');
      }
      plan.status = dto.status;
    }

    if (dto.displayCurrency !== undefined) {
      plan.displayCurrency = dto.displayCurrency;
      plan.exchangeRateSnapshot = dto.displayCurrency === 'PKR' ? this.currency.getCurrentPkrRate() : null;
    }

    await plan.save();
    return { success: true, data: plan };
  }

  async archivePlan(sellerId: string, storeId: string, planId: string, force: boolean) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const plan = await this.verifyPlanInStore(storeId, planId);

    const activeCount = await this.subModel.countDocuments({ planId, status: 'active' });
    if (activeCount > 0 && !force) {
      throw new BadRequestException(
        `This plan has ${activeCount} active subscriber(s). Pass ?force=true to archive anyway (existing subscriptions will continue until canceled).`,
      );
    }

    plan.status = 'archived';
    await plan.save();

    this.activityLogService.log({
      storeId, category: 'subscriptions', action: 'plan_archived',
      description: `Plan "${plan.name}" archived`,
      actorId: sellerId, actorRole: 'seller',
      targetId: planId, targetType: 'subscription_plan',
    });

    return { success: true, message: `Plan archived. ${activeCount} active subscription(s) unaffected.` };
  }

  /** Live profitability preview for the plan builder — before the seller saves anything. */
  async estimatePlanHealth(sellerId: string, storeId: string, benefits: PlanBenefitDto[], monthlyPriceUSD: number) {
    await this.verifyStoreOwnership(sellerId, storeId);
    if (!monthlyPriceUSD || monthlyPriceUSD <= 0) {
      throw new BadRequestException('monthlyPriceUSD is required to estimate plan health');
    }
    const estimate = await this.benefitsService.estimatePlanProfitability(storeId, benefits ?? [], monthlyPriceUSD);
    return { success: true, data: estimate };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — SUBSCRIBERS (store-scoped)
  // ═══════════════════════════════════════════════════════════════════════════

  private async enrichSubForSeller(sub: any) {
    const [customer, plan] = await Promise.all([
      this.db.repositories.userModel.findById(sub.customerId).select('name email profileImage').lean(),
      this.planModel.findById(sub.planId).select('name').lean(),
    ]);
    return {
      ...sub,
      customer: customer ?? { name: 'Unknown', email: 'N/A' },
      planName: (plan as any)?.name ?? 'Plan not found',
      pendingCancellation: this.pendingCancellation(sub),
    };
  }

  async listSubscriptions(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(sellerId, storeId);

    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.planId) filter.planId = query.planId;

    const [subs, total] = await Promise.all([
      this.subModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.subModel.countDocuments(filter),
    ]);

    const rows = await Promise.all(subs.map((s) => this.enrichSubForSeller(s)));

    return {
      success: true,
      data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, subscriptions: rows },
    };
  }

  async getSubscriptionById(sellerId: string, storeId: string, subId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.verifySubInStore(storeId, subId);

    const [customer, plan, invoices] = await Promise.all([
      this.db.repositories.userModel.findById(sub.customerId).select('name email phone profileImage').lean(),
      this.planModel.findById(sub.planId).select('name monthlyPriceUSD yearlyPriceUSD features').lean(),
      this.invoiceModel.find({ subscriptionId: subId, isDelete: false }).sort({ createdAt: -1 }).lean(),
    ]);

    return {
      success: true,
      data: {
        ...sub.toObject(),
        customer: customer ?? { name: 'Unknown', email: 'N/A' },
        plan: plan ?? null,
        invoices,
        pendingCancellation: this.pendingCancellation(sub),
      },
    };
  }

  // ── Shared status-transition logic (used by both seller override and buyer self-serve) ──

  private applyPause(sub: any) {
    if (sub.status !== 'active') {
      throw new BadRequestException(`Cannot pause a subscription with status "${sub.status}"`);
    }
    sub.status = 'paused';
    sub.pausedAt = new Date();
  }

  private applyResume(sub: any) {
    if (sub.status !== 'paused') {
      throw new BadRequestException(`Cannot resume a subscription with status "${sub.status}"`);
    }
    const now = new Date();
    const newPeriodEnd = this.addPeriod(now, sub.billingInterval as 'monthly' | 'yearly');
    sub.status = 'active';
    sub.pausedAt = null;
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = newPeriodEnd;
    sub.nextBillingDate = newPeriodEnd;
    sub.failedPaymentAttempts = 0;
  }

  private applyCancel(sub: any, atPeriodEnd: boolean, reason?: string): string {
    if (sub.status === 'canceled') throw new BadRequestException('Subscription is already canceled');

    const now = new Date();
    if (reason) sub.cancellationReason = reason;
    if (atPeriodEnd) {
      sub.canceledAt = sub.currentPeriodEnd;
      // Status stays 'active' — finalizeEndOfPeriodCancellations() flips it
      // to 'canceled' once currentPeriodEnd passes.
    } else {
      sub.status = 'canceled';
      sub.canceledAt = now;
    }

    return atPeriodEnd
      ? `Subscription will cancel at end of current period (${sub.currentPeriodEnd.toISOString().split('T')[0]})`
      : 'Subscription canceled immediately';
  }

  async pauseSubscription(sellerId: string, storeId: string, subId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.verifySubInStore(storeId, subId);
    this.applyPause(sub);
    await sub.save();
    return { success: true, message: 'Subscription paused successfully', data: sub };
  }

  async resumeSubscription(sellerId: string, storeId: string, subId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.verifySubInStore(storeId, subId);
    this.applyResume(sub);
    await sub.save();
    return { success: true, message: 'Subscription resumed successfully', data: sub };
  }

  async cancelSubscription(sellerId: string, storeId: string, subId: string, atPeriodEnd: boolean, reason?: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.verifySubInStore(storeId, subId);

    if (sub.providerSubscriptionId) await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
    const message = this.applyCancel(sub, atPeriodEnd, reason);
    await sub.save();

    this.activityLogService.log({
      storeId, category: 'subscriptions', action: 'subscription_canceled_by_seller',
      description: `Subscription ${subId} canceled by seller${atPeriodEnd ? ' (at period end)' : ''}`,
      actorId: sellerId, actorRole: 'seller',
      targetId: subId, targetType: 'subscription',
    });

    return { success: true, message, data: sub };
  }

  async exportCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(sellerId, storeId);

    const filter: any = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.planId) filter.planId = query.planId;

    const subs = await this.subModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const customerIds = [...new Set(subs.map((s: any) => s.customerId))];
    const planIds     = [...new Set(subs.map((s: any) => s.planId))];

    const [customers, plans] = await Promise.all([
      this.db.repositories.userModel.find({ _id: { $in: customerIds } }).select('name email').lean(),
      this.planModel.find({ _id: { $in: planIds } }).select('name').lean(),
    ]);

    const customerMap = Object.fromEntries(customers.map((c: any) => [c._id.toString(), c]));
    const planMap     = Object.fromEntries(plans.map((p: any) => [p._id.toString(), p]));

    const header = 'Subscription ID,Customer Name,Customer Email,Plan,Interval,Amount USD,Status,Started At,Next Billing Date,Total Paid USD\n';

    const rows = subs.map((sub: any) => {
      const c = customerMap[sub.customerId] ?? {};
      const p = planMap[sub.planId] ?? {};
      const started = new Date(sub.startedAt).toISOString().split('T')[0];
      const nextBill = new Date(sub.nextBillingDate).toISOString().split('T')[0];
      return [
        sub._id.toString(), `"${c.name ?? ''}"`, `"${c.email ?? ''}"`, `"${(p as any).name ?? ''}"`,
        sub.billingInterval, sub.amountUSD.toFixed(2), sub.status, started, nextBill, sub.totalPaidUSD.toFixed(2),
      ].join(',');
    });

    return header + rows.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SELLER — DASHBOARD (store-scoped)
  // ═══════════════════════════════════════════════════════════════════════════

  private async computeDashboard(filter: { storeId?: string; sellerId?: string }) {
    const match: any = { isDelete: false, ...filter };
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [
      activeSubs, newThisMonth, canceledThisMonth, totalRevenueAgg,
      planBreakdownRaw, recentInvoices, activeLastMonth,
    ] = await Promise.all([
      this.subModel.find({ ...match, status: 'active' }).lean(),
      this.subModel.countDocuments({ ...match, startedAt: { $gte: thisMonthStart } }),
      this.subModel.countDocuments({ ...match, status: 'canceled', canceledAt: { $gte: thisMonthStart } }),
      this.invoiceModel.aggregate([
        { $match: { ...match, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amountUSD' } } },
      ]),
      this.subModel.aggregate([
        { $match: { ...match, status: 'active' } },
        {
          $group: {
            _id: '$planId',
            subscriberCount: { $sum: 1 },
            monthlyRevenue: { $sum: { $cond: [{ $eq: ['$billingInterval', 'monthly'] }, '$amountUSD', { $divide: ['$amountUSD', 12] }] } },
          },
        },
      ]),
      this.invoiceModel.find({ ...match, status: 'paid' }).sort({ paidAt: -1 }).limit(10).lean(),
      this.subModel.countDocuments({ ...match, status: { $in: ['active', 'canceled', 'paused'] }, startedAt: { $lt: thisMonthStart } }),
    ]);

    const mrr = this.round(activeSubs.reduce((acc: number, sub: any) => acc + this.toMrrContribution(sub.amountUSD, sub.billingInterval), 0));
    const arr = this.round(mrr * 12);
    const churnRate = activeLastMonth > 0 ? this.round((canceledThisMonth / activeLastMonth) * 100) : 0;
    const totalRevenue = this.round(totalRevenueAgg[0]?.total ?? 0);

    const planIds = planBreakdownRaw.map((r: any) => r._id);
    const plans = await this.planModel.find({ _id: { $in: planIds } }).select('name').lean();
    const planNameMap = Object.fromEntries(plans.map((p: any) => [p._id.toString(), p.name]));
    const planBreakdown = planBreakdownRaw.map((r: any) => ({
      planId: r._id, planName: planNameMap[r._id] ?? 'Unknown',
      subscriberCount: r.subscriberCount, mrrContributionUSD: this.round(r.monthlyRevenue),
    }));

    const [thisMonthRevAgg, lastMonthRevAgg] = await Promise.all([
      this.invoiceModel.aggregate([{ $match: { ...match, status: 'paid', paidAt: { $gte: thisMonthStart } } }, { $group: { _id: null, total: { $sum: '$amountUSD' } } }]),
      this.invoiceModel.aggregate([{ $match: { ...match, status: 'paid', paidAt: { $gte: lastMonthStart, $lte: lastMonthEnd } } }, { $group: { _id: null, total: { $sum: '$amountUSD' } } }]),
    ]);
    const revenueThisMonth = this.round(thisMonthRevAgg[0]?.total ?? 0);
    const revenueLastMonth = this.round(lastMonthRevAgg[0]?.total ?? 0);
    const revenueGrowthPercent = revenueLastMonth > 0 ? this.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100) : 0;

    // Cancellation reasons — works for both a single store and platform-wide (admin).
    const cancellationReasonsRaw = await this.subModel.aggregate([
      { $match: { ...match, status: 'canceled', cancellationReason: { $ne: null } } },
      { $group: { _id: '$cancellationReason', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    const cancellationReasons = cancellationReasonsRaw.map((r: any) => ({ reason: r._id, count: r.count }));

    // Subscriber-vs-regular revenue & benefit usage — only meaningful (and
    // affordable to compute) at the single-store level, not platform-wide.
    let subscriberEconomics: {
      subscriberRevenue: number; regularRevenue: number;
      subscriberOrderCount: number; regularOrderCount: number;
      avgOrdersPerSubscriber: number; avgOrdersPerRegularCustomer: number;
      totalCustomerSavingsUSD: number;
    } | null = null;

    if (filter.storeId) {
      const storeId = filter.storeId;
      const [subscriberIds, orders] = await Promise.all([
        this.subModel.distinct('customerId', { storeId }),
        this.db.repositories.orderModel.find({
          'sellerOrders.storeId': storeId, isDelete: false, paymentStatus: 'paid',
        }).select('userId sellerOrders subscriberDiscountTotal').lean(),
      ]);
      const subscriberIdSet = new Set(subscriberIds);

      let subscriberRevenue = 0, regularRevenue = 0, subscriberOrderCount = 0, regularOrderCount = 0, totalCustomerSavingsUSD = 0;
      const subscriberCustomers = new Set<string>();
      const regularCustomers = new Set<string>();

      for (const order of orders as any[]) {
        const orderValue = (order.sellerOrders as any[])
          .filter(so => so.storeId === storeId)
          .reduce((s, so) => s + so.subtotal, 0);
        totalCustomerSavingsUSD += order.subscriberDiscountTotal ?? 0;

        if (subscriberIdSet.has(order.userId)) {
          subscriberRevenue += orderValue;
          subscriberOrderCount += 1;
          subscriberCustomers.add(order.userId);
        } else {
          regularRevenue += orderValue;
          regularOrderCount += 1;
          regularCustomers.add(order.userId);
        }
      }

      subscriberEconomics = {
        subscriberRevenue: this.round(subscriberRevenue),
        regularRevenue: this.round(regularRevenue),
        subscriberOrderCount,
        regularOrderCount,
        avgOrdersPerSubscriber: subscriberCustomers.size > 0 ? this.round(subscriberOrderCount / subscriberCustomers.size) : 0,
        avgOrdersPerRegularCustomer: regularCustomers.size > 0 ? this.round(regularOrderCount / regularCustomers.size) : 0,
        totalCustomerSavingsUSD: this.round(totalCustomerSavingsUSD),
      };
    }

    return {
      mrr, arr, activeSubscribersCount: activeSubs.length, totalRevenue,
      newSubscribersThisMonth: newThisMonth, canceledThisMonth, churnRate,
      revenueThisMonth, revenueLastMonth, revenueGrowthPercent,
      planBreakdown, recentInvoices, cancellationReasons, subscriberEconomics,
    };
  }

  async getDashboard(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const data = await this.computeDashboard({ storeId });
    return { success: true, data };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BUYER — DISCOVERY & SELF-SERVICE
  // ═══════════════════════════════════════════════════════════════════════════

  async browsePlans(storeId: string) {
    const store = await this.storeModel.findById(storeId);
    if (!store || store.isDelete) throw new NotFoundException('Store not found');

    const plans = await this.planModel.find({ storeId, status: 'active', isDelete: false }).sort({ monthlyPriceUSD: 1 }).lean();

    const data = plans.map((plan: any) => ({
      _id: plan._id, name: plan.name, description: plan.description,
      monthlyPriceUSD: plan.monthlyPriceUSD, yearlyPriceUSD: plan.yearlyPriceUSD,
      features: plan.features,
      // Structured benefits — the storefront renders these into concrete
      // "Save 15% storewide" / "Free shipping" bullets, not the seller's
      // free-text `features`.
      benefits: plan.benefits ?? [],
      displayCurrency: plan.displayCurrency,
      displayMonthlyPrice: this.currency.formatForDisplay(plan.monthlyPriceUSD, plan.displayCurrency, plan.exchangeRateSnapshot),
      displayYearlyPrice: plan.yearlyPriceUSD != null
        ? this.currency.formatForDisplay(plan.yearlyPriceUSD, plan.displayCurrency, plan.exchangeRateSnapshot)
        : null,
    }));

    return { success: true, data };
  }

  /** Buyer subscribes to a store's plan. This is the (formerly-dead) internal createSubscription, now reachable. */
  async subscribe(customerId: string, dto: SubscribeDto) {
    const plan = await this.planModel.findOne({ _id: dto.planId, isDelete: false, status: 'active' });
    if (!plan) throw new NotFoundException('Subscription plan not found or inactive');

    const store = await this.storeModel.findById(plan.storeId);
    if (!store || store.isDelete || store.status !== 'active') {
      throw new BadRequestException('This store is not currently accepting subscriptions');
    }

    const amountUSD = dto.billingInterval === 'yearly'
      ? (plan.yearlyPriceUSD ?? this.round(plan.monthlyPriceUSD * 12))
      : plan.monthlyPriceUSD;

    const existing = await this.subModel.findOne({
      customerId, planId: dto.planId, status: { $in: ['active', 'paused'] }, isDelete: false,
    });
    if (existing) throw new ConflictException('You already have an active subscription to this plan');

    const now = new Date();
    const periodEnd = this.addPeriod(now, dto.billingInterval);

    const sub = await this.subModel.create({
      planId: dto.planId,
      customerId,
      storeId: plan.storeId,
      sellerId: plan.sellerId,
      billingInterval: dto.billingInterval,
      amountUSD: this.round(amountUSD),
      status: 'active',
      startedAt: now,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      nextBillingDate: periodEnd,
      paymentProvider: 'manual',
    });

    const { providerSubscriptionId } = await this.gateway.createProviderSubscription(
      (sub as any)._id.toString(), plan.name, amountUSD, dto.billingInterval,
    );
    sub.providerSubscriptionId = providerSubscriptionId;

    const charge = await this.gateway.chargeSubscription((sub as any)._id.toString(), amountUSD);
    const subId = (sub as any)._id.toString();

    const invoice = await this.invoiceModel.create({
      subscriptionId: subId,
      storeId: plan.storeId,
      sellerId: plan.sellerId,
      customerId,
      invoiceNumber: this.generateInvoiceNumber(),
      type: 'initial',
      amountUSD: this.round(amountUSD),
      status: charge.success ? 'paid' : 'failed',
      paidAt: charge.success ? now : null,
      providerChargeId: charge.providerChargeId,
    });

    await this.recordPaymentAttempt({
      subscriptionId: subId, storeId: plan.storeId, sellerId: plan.sellerId, customerId,
      attemptType: 'initial', outcome: charge.success ? 'success' : 'failed',
      amountUSD: this.round(amountUSD),
      failureReason: charge.success ? null : (charge.failureReason ?? 'Payment declined'),
      invoiceId: (invoice as any)._id.toString(), providerChargeId: charge.providerChargeId,
    });

    if (charge.success) sub.totalPaidUSD = this.round(amountUSD);
    else sub.status = 'past_due';

    await sub.save();

    this.activityLogService.log({
      storeId: plan.storeId, category: 'subscriptions', action: 'subscriber_joined',
      description: `New subscriber on "${plan.name}" (${dto.billingInterval})`,
      actorId: customerId, actorRole: 'user',
      targetId: (sub as any)._id.toString(), targetType: 'subscription',
    });

    return { success: true, data: { subscription: sub, invoice } };
  }

  async listMySubscriptions(customerId: string, query: any) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { customerId, isDelete: false };
    if (query.status) filter.status = query.status;

    const [subs, total] = await Promise.all([
      this.subModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.subModel.countDocuments(filter),
    ]);

    const rows = await Promise.all(subs.map(async (sub: any) => {
      const [store, plan] = await Promise.all([
        this.storeModel.findById(sub.storeId).select('name logo slug').lean(),
        this.planModel.findById(sub.planId).select('name features').lean(),
      ]);
      return {
        ...sub,
        store: store ?? null,
        plan: plan ?? null,
        pendingCancellation: this.pendingCancellation(sub),
      };
    }));

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, subscriptions: rows } };
  }

  async getMySubscriptionById(customerId: string, subId: string) {
    const sub = await this.verifyMySub(customerId, subId);

    const [store, plan, invoices] = await Promise.all([
      this.storeModel.findById(sub.storeId).select('name logo slug').lean(),
      this.planModel.findById(sub.planId).select('name monthlyPriceUSD yearlyPriceUSD features').lean(),
      this.invoiceModel.find({ subscriptionId: subId, isDelete: false }).sort({ createdAt: -1 }).lean(),
    ]);

    return {
      success: true,
      data: { ...sub.toObject(), store: store ?? null, plan: plan ?? null, invoices, pendingCancellation: this.pendingCancellation(sub) },
    };
  }

  async selfPauseSubscription(customerId: string, subId: string) {
    const sub = await this.verifyMySub(customerId, subId);
    this.applyPause(sub);
    await sub.save();
    return { success: true, message: 'Subscription paused successfully', data: sub };
  }

  async selfResumeSubscription(customerId: string, subId: string) {
    const sub = await this.verifyMySub(customerId, subId);
    this.applyResume(sub);
    await sub.save();
    return { success: true, message: 'Subscription resumed successfully', data: sub };
  }

  async selfCancelSubscription(customerId: string, subId: string, atPeriodEnd: boolean, reason?: string) {
    const sub = await this.verifyMySub(customerId, subId);

    if (sub.providerSubscriptionId) await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
    const message = this.applyCancel(sub, atPeriodEnd, reason);
    await sub.save();

    this.activityLogService.log({
      storeId: sub.storeId, category: 'subscriptions', action: 'subscription_canceled_by_customer',
      description: `Subscription ${subId} canceled by the customer${atPeriodEnd ? ' (at period end)' : ''}`,
      actorId: customerId, actorRole: 'user',
      targetId: subId, targetType: 'subscription',
    });

    return { success: true, message, data: sub };
  }

  /**
   * Buyer switches plan and/or billing interval mid-cycle. Proration mirrors
   * standard SaaS behavior (e.g. Stripe):
   *  - Unused time on the current plan is converted to a USD credit
   *    (currentAmount × remaining-time-ratio), combined with any existing
   *    creditBalanceUSD.
   *  - The new plan's full price is charged, minus that credit.
   *  - If the credit exceeds the new price (e.g. yearly → monthly downgrade
   *    mid-cycle), the leftover becomes account credit for the next charge —
   *    never an instant cash refund, since there's no real gateway to refund
   *    through yet.
   *  - The new period always restarts from now (today = new currentPeriodStart).
   */
  async changePlan(customerId: string, subId: string, dto: ChangePlanDto) {
    const sub = await this.verifyMySub(customerId, subId);

    if (sub.status !== 'active') {
      throw new BadRequestException(`Cannot change plan while subscription status is "${sub.status}" — resume it first`);
    }

    const [oldPlan, newPlan] = await Promise.all([
      this.planModel.findById(sub.planId),
      this.planModel.findOne({ _id: dto.newPlanId, isDelete: false }),
    ]);
    if (!newPlan) throw new NotFoundException('Target subscription plan not found');
    if (newPlan.storeId !== sub.storeId) throw new BadRequestException('Cannot switch to a plan from a different store');
    if (newPlan.status !== 'active') throw new BadRequestException('This plan is not currently available');
    if (dto.newPlanId === sub.planId && dto.newBillingInterval === sub.billingInterval) {
      throw new BadRequestException('This is already your current plan and billing interval');
    }

    const newAmountUSD = dto.newBillingInterval === 'yearly'
      ? (newPlan.yearlyPriceUSD ?? this.round(newPlan.monthlyPriceUSD * 12))
      : newPlan.monthlyPriceUSD;

    const now = new Date();
    const totalPeriodMs = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
    const remainingMs = Math.max(0, sub.currentPeriodEnd.getTime() - now.getTime());
    const remainingRatio = totalPeriodMs > 0 ? Math.min(1, remainingMs / totalPeriodMs) : 0;

    const unusedCredit = this.round(sub.amountUSD * remainingRatio);
    const totalCreditAvailable = this.round(unusedCredit + (sub.creditBalanceUSD ?? 0));
    const netDue = this.round(newAmountUSD - totalCreditAvailable);

    const historyEntry = {
      fromPlanId: sub.planId, fromPlanName: oldPlan?.name ?? 'Unknown plan',
      fromBillingInterval: sub.billingInterval, fromAmountUSD: sub.amountUSD,
      toPlanId: dto.newPlanId, toPlanName: newPlan.name,
      toBillingInterval: dto.newBillingInterval, toAmountUSD: this.round(newAmountUSD),
      proratedAmountUSD: netDue, changedAt: now,
    };

    let invoice: any = null;
    let description: string;

    if (netDue > 0) {
      // Upgrade (or credit didn't fully cover it) — charge the difference now.
      const charge = await this.gateway.chargeSubscription(subId, netDue);

      invoice = await this.invoiceModel.create({
        subscriptionId: subId, storeId: sub.storeId, sellerId: sub.sellerId, customerId,
        invoiceNumber: this.generateInvoiceNumber(), type: 'proration',
        amountUSD: netDue, status: charge.success ? 'paid' : 'failed',
        paidAt: charge.success ? now : null, providerChargeId: charge.providerChargeId,
      });

      await this.recordPaymentAttempt({
        subscriptionId: subId, storeId: sub.storeId, sellerId: sub.sellerId, customerId,
        attemptType: 'proration', outcome: charge.success ? 'success' : 'failed',
        amountUSD: netDue, failureReason: charge.success ? null : (charge.failureReason ?? 'Payment declined'),
        invoiceId: (invoice as any)._id.toString(), providerChargeId: charge.providerChargeId,
      });

      if (!charge.success) {
        throw new BadRequestException(`Proration payment of $${netDue.toFixed(2)} failed — plan was not changed`);
      }

      sub.totalPaidUSD = this.round(sub.totalPaidUSD + netDue);
      sub.creditBalanceUSD = 0;
      description = `Changed from "${historyEntry.fromPlanName}" (${sub.billingInterval}) to "${newPlan.name}" (${dto.newBillingInterval}) — $${netDue.toFixed(2)} charged`;
    } else {
      // Downgrade — credit covers the new plan in full; leftover carries forward.
      sub.creditBalanceUSD = this.round(-netDue);
      description = `Changed from "${historyEntry.fromPlanName}" (${sub.billingInterval}) to "${newPlan.name}" (${dto.newBillingInterval}) — $${sub.creditBalanceUSD.toFixed(2)} credited to account`;
    }

    sub.planId = dto.newPlanId;
    sub.billingInterval = dto.newBillingInterval;
    sub.amountUSD = this.round(newAmountUSD);
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = this.addPeriod(now, dto.newBillingInterval);
    sub.nextBillingDate = sub.currentPeriodEnd;
    sub.failedPaymentAttempts = 0;
    sub.canceledAt = null; // changing plan implies the buyer wants to continue
    sub.planHistory = [...(sub.planHistory ?? []), historyEntry];

    await sub.save();

    this.activityLogService.log({
      storeId: sub.storeId, category: 'subscriptions', action: 'plan_changed_by_customer',
      description, actorId: customerId, actorRole: 'user',
      targetId: subId, targetType: 'subscription',
      metadata: historyEntry,
    });

    const { customerName, customerEmail, storeName } = await this.getCustomerAndStoreNames(customerId, sub.storeId);
    if (customerEmail) {
      if (netDue > 0) {
        await this.notifications.sendProrationCharged(customerEmail, {
          customerName, storeName,
          fromPlanName: historyEntry.fromPlanName, toPlanName: newPlan.name,
          fromInterval: historyEntry.fromBillingInterval, toInterval: dto.newBillingInterval,
          amountUSD: netDue,
        });
      } else {
        await this.notifications.sendProrationCredited(customerEmail, {
          customerName, storeName,
          fromPlanName: historyEntry.fromPlanName, toPlanName: newPlan.name,
          fromInterval: historyEntry.fromBillingInterval, toInterval: dto.newBillingInterval,
          creditUSD: sub.creditBalanceUSD,
        });
      }
    }

    return { success: true, message: description, data: { subscription: sub, invoice } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN — PLATFORM OVERSIGHT
  // ═══════════════════════════════════════════════════════════════════════════

  async adminGetOverview() {
    const data = await this.computeDashboard({});
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [planCount, storeCount, failedPaymentsLast30Days, pastDueCount] = await Promise.all([
      this.planModel.countDocuments({ isDelete: false, status: 'active' }),
      this.planModel.distinct('storeId', { isDelete: false, status: 'active' }).then((ids) => ids.length),
      this.attemptModel.countDocuments({ outcome: 'failed', createdAt: { $gte: thirtyDaysAgo } }),
      this.subModel.countDocuments({ status: 'past_due', isDelete: false }),
    ]);

    return {
      success: true,
      data: { ...data, activePlanCount: planCount, storesWithActivePlans: storeCount, failedPaymentsLast30Days, pastDueSubscriptionsCount: pastDueCount },
    };
  }

  // ── Dunning / retry history ──────────────────────────────────────────────

  async adminGetPaymentFailures(query: any) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { outcome: 'failed' };
    if (query.storeId) filter.storeId = query.storeId;
    if (query.attemptType) filter.attemptType = query.attemptType;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to)   filter.createdAt.$lte = new Date(query.to);
    }

    const [attempts, total] = await Promise.all([
      this.attemptModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.attemptModel.countDocuments(filter),
    ]);

    const storeIds = [...new Set(attempts.map((a: any) => a.storeId))];
    const customerIds = [...new Set(attempts.map((a: any) => a.customerId))];
    const [stores, customers] = await Promise.all([
      this.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean(),
      this.db.repositories.userModel.find({ _id: { $in: customerIds } }).select('name email').lean(),
    ]);
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));
    const customerMap = Object.fromEntries(customers.map((c: any) => [c._id.toString(), c]));

    const rows = attempts.map((a: any) => ({
      ...a,
      store: storeMap[a.storeId] ?? null,
      customer: customerMap[a.customerId] ?? null,
    }));

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, failures: rows } };
  }

  async adminGetSubscriptionDetail(subId: string) {
    const sub = await this.subModel.findOne({ _id: subId, isDelete: false }).lean();
    if (!sub) throw new NotFoundException('Subscription not found');

    const [store, customer, plan, invoices, attempts] = await Promise.all([
      this.storeModel.findById((sub as any).storeId).select('name slug sellerId').lean(),
      this.db.repositories.userModel.findById((sub as any).customerId).select('name email phone').lean(),
      this.planModel.findById((sub as any).planId).select('name monthlyPriceUSD yearlyPriceUSD').lean(),
      this.invoiceModel.find({ subscriptionId: subId, isDelete: false }).sort({ createdAt: -1 }).lean(),
      this.attemptModel.find({ subscriptionId: subId }).sort({ createdAt: -1 }).lean(),
    ]);

    return {
      success: true,
      data: { ...sub, store, customer, plan, invoices, paymentAttempts: attempts, pendingCancellation: this.pendingCancellation(sub) },
    };
  }

  async adminGetSubscriptionPaymentAttempts(subId: string, query: any) {
    const exists = await this.subModel.exists({ _id: subId });
    if (!exists) throw new NotFoundException('Subscription not found');

    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { subscriptionId: subId };
    if (query.outcome) filter.outcome = query.outcome;

    const [attempts, total] = await Promise.all([
      this.attemptModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.attemptModel.countDocuments(filter),
    ]);

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, attempts } };
  }

  async adminGetStoreBreakdown(query: any) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const grouped = await this.subModel.aggregate([
      { $match: { status: 'active', isDelete: false } },
      {
        $group: {
          _id: '$storeId',
          subscriberCount: { $sum: 1 },
          monthlyRevenue: { $sum: { $cond: [{ $eq: ['$billingInterval', 'monthly'] }, '$amountUSD', { $divide: ['$amountUSD', 12] }] } },
        },
      },
      { $sort: { monthlyRevenue: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]);

    const total = (await this.subModel.aggregate([
      { $match: { status: 'active', isDelete: false } },
      { $group: { _id: '$storeId' } },
      { $count: 'total' },
    ]))[0]?.total ?? 0;

    const storeIds = grouped.map((r: any) => r._id);
    const stores = await this.storeModel.find({ _id: { $in: storeIds } }).select('name slug sellerId').lean();
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));

    const planCounts = await this.planModel.aggregate([
      { $match: { storeId: { $in: storeIds }, isDelete: false } },
      { $group: { _id: '$storeId', count: { $sum: 1 } } },
    ]);
    const planCountMap = Object.fromEntries(planCounts.map((r: any) => [r._id, r.count]));

    const rows = grouped.map((r: any) => ({
      storeId: r._id,
      storeName: storeMap[r._id]?.name ?? 'Unknown store',
      storeSlug: storeMap[r._id]?.slug ?? null,
      sellerId: storeMap[r._id]?.sellerId ?? null,
      subscriberCount: r.subscriberCount,
      mrrUSD: this.round(r.monthlyRevenue),
      planCount: planCountMap[r._id] ?? 0,
    }));

    return { success: true, data: { pagination: { page, limit, total, pages: Math.ceil(total / limit) }, stores: rows } };
  }

  async adminGetStoreDetail(storeId: string) {
    const store = await this.storeModel.findById(storeId).select('name slug sellerId').lean();
    if (!store) throw new NotFoundException('Store not found');

    const [plans, dashboard] = await Promise.all([
      this.planModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).lean().then((ps) => Promise.all(ps.map((p) => this.enrichPlan(p)))),
      this.computeDashboard({ storeId }),
    ]);

    return { success: true, data: { store, plans, ...dashboard } };
  }

  async adminSuspendPlan(planId: string) {
    const plan = await this.planModel.findOne({ _id: planId, isDelete: false });
    if (!plan) throw new NotFoundException('Subscription plan not found');

    plan.status = 'suspended';
    await plan.save();

    this.activityLogService.log({
      storeId: plan.storeId, category: 'subscriptions', action: 'plan_suspended_by_admin',
      description: `Plan "${plan.name}" suspended by admin`,
      actorRole: 'admin', targetId: planId, targetType: 'subscription_plan', isSecurityAlert: true,
    });

    return { success: true, message: 'Plan suspended. Existing subscribers are unaffected; no new subscriptions can be created.', data: plan };
  }

  async adminUnsuspendPlan(planId: string) {
    const plan = await this.planModel.findOne({ _id: planId, isDelete: false });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    if (plan.status !== 'suspended') throw new BadRequestException('Plan is not suspended');

    plan.status = 'active';
    await plan.save();

    this.activityLogService.log({
      storeId: plan.storeId, category: 'subscriptions', action: 'plan_unsuspended_by_admin',
      description: `Plan "${plan.name}" reinstated by admin`,
      actorRole: 'admin', targetId: planId, targetType: 'subscription_plan',
    });

    return { success: true, message: 'Plan reinstated.', data: plan };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BILLING AUTOMATION — called by SchedulerService cron jobs.
  // Uses PaymentGatewayService (currently ManualPaymentProvider, always
  // succeeds) so the full renewal/dunning state machine is real and testable
  // today. Swapping in a real provider later requires no changes here.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Charges every subscription whose period has ended, and drives dunning on failure. */
  async processRenewals(): Promise<{ processed: number; succeeded: number; failed: number; canceled: number }> {
    const now = new Date();
    const due = await this.subModel.find({
      status: { $in: ['active', 'past_due'] },
      canceledAt: null, // a pending at-period-end cancellation should lapse, not renew
      nextBillingDate: { $lte: now },
      isDelete: false,
    });

    let succeeded = 0, failed = 0, canceled = 0;

    for (const sub of due) {
      try {
        const subId = (sub as any)._id.toString();

        // Apply any standing account credit (from a prior downgrade) before charging.
        const creditToApply = this.round(Math.min(sub.creditBalanceUSD ?? 0, sub.amountUSD));
        const chargeAmount = this.round(sub.amountUSD - creditToApply);

        const charge = chargeAmount > 0
          ? await this.gateway.chargeSubscription(subId, chargeAmount)
          : { success: true, providerChargeId: null as string | null }; // fully covered by credit — no real charge needed

        const invoice = await this.invoiceModel.create({
          subscriptionId: subId,
          storeId: sub.storeId,
          sellerId: sub.sellerId,
          customerId: sub.customerId,
          invoiceNumber: this.generateInvoiceNumber(),
          type: 'recurring',
          amountUSD: chargeAmount,
          status: charge.success ? 'paid' : 'failed',
          paidAt: charge.success ? now : null,
          providerChargeId: charge.providerChargeId,
        });

        await this.recordPaymentAttempt({
          subscriptionId: subId, storeId: sub.storeId, sellerId: sub.sellerId, customerId: sub.customerId,
          attemptType: 'renewal', outcome: charge.success ? 'success' : 'failed',
          amountUSD: chargeAmount,
          failureReason: charge.success ? null : ((charge as any).failureReason ?? 'Payment declined'),
          invoiceId: (invoice as any)._id.toString(), providerChargeId: charge.providerChargeId,
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

          if (creditToApply > 0) {
            this.activityLogService.log({
              storeId: sub.storeId, category: 'subscriptions', action: 'renewal_credit_applied',
              description: `$${creditToApply.toFixed(2)} account credit applied to renewal — $${chargeAmount.toFixed(2)} charged`,
              actorRole: 'system', targetId: subId, targetType: 'subscription',
            });
          }
        } else {
          sub.failedPaymentAttempts = (sub.failedPaymentAttempts ?? 0) + 1;
          const { customerName, customerEmail, storeName } = await this.getCustomerAndStoreNames(sub.customerId, sub.storeId);
          const plan = await this.planModel.findById(sub.planId).select('name').lean();
          const planName = (plan as any)?.name ?? 'your plan';

          if (sub.failedPaymentAttempts >= MAX_RENEWAL_ATTEMPTS) {
            sub.status = 'canceled';
            sub.canceledAt = now;
            canceled++;
            this.activityLogService.log({
              storeId: sub.storeId, category: 'subscriptions', action: 'subscription_auto_canceled',
              description: `Subscription ${subId} auto-canceled after ${MAX_RENEWAL_ATTEMPTS} failed renewal attempts`,
              actorRole: 'system', targetId: subId, targetType: 'subscription',
            });
            if (customerEmail) {
              await this.notifications.sendSubscriptionCanceledDueToFailedPayments(customerEmail, {
                customerName, storeName, planName, maxAttempts: MAX_RENEWAL_ATTEMPTS,
              });
            }
          } else {
            sub.status = 'past_due';
            const retryAt = new Date(now);
            retryAt.setDate(retryAt.getDate() + RETRY_INTERVAL_DAYS);
            sub.nextBillingDate = retryAt;
            if (customerEmail) {
              await this.notifications.sendPaymentFailed(customerEmail, {
                customerName, storeName, planName, amountUSD: chargeAmount,
                attemptNumber: sub.failedPaymentAttempts, maxAttempts: MAX_RENEWAL_ATTEMPTS, nextRetryDate: retryAt,
              });
            }
          }
          failed++;
        }

        await sub.save();
      } catch (err) {
        // Never let one bad subscription break the whole batch.
        failed++;
      }
    }

    return { processed: due.length, succeeded, failed, canceled };
  }

  /** Finalizes subscriptions whose "cancel at period end" date has arrived. */
  async finalizeEndOfPeriodCancellations(): Promise<{ canceled: number }> {
    const now = new Date();
    const due = await this.subModel.find({
      status: 'active',
      canceledAt: { $ne: null, $lte: now },
      isDelete: false,
    });

    for (const sub of due) {
      sub.status = 'canceled';
      await sub.save();
      this.activityLogService.log({
        storeId: sub.storeId, category: 'subscriptions', action: 'subscription_canceled',
        description: `Subscription ${(sub as any)._id.toString()} canceled at period end`,
        actorRole: 'system', targetId: (sub as any)._id.toString(), targetType: 'subscription',
      });
    }

    return { canceled: due.length };
  }
}
