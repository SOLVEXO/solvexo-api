/* eslint-disable prettier/prettier */
import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, ConflictException,
} from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from './payment-gateway/payment-gateway.service';
import { CurrencyDisplayService } from './currency-display.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly currency: CurrencyDisplayService,
  ) {}

  // ── Shorthand getters ────────────────────────────────────────────────────
  private get planModel()    { return this.db.repositories.subscriptionPlanModel; }
  private get subModel()     { return this.db.repositories.subscriptionModel; }
  private get invoiceModel() { return this.db.repositories.subscriptionInvoiceModel; }

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

  private async verifyPlanOwnership(sellerId: string, planId: string) {
    const plan = await this.planModel.findOne({ _id: planId, isDelete: false });
    if (!plan) throw new NotFoundException('Subscription plan not found');
    if (plan.sellerId !== sellerId) throw new ForbiddenException('Access denied');
    return plan;
  }

  private async verifySubOwnership(sellerId: string, subId: string) {
    const sub = await this.subModel.findOne({ _id: subId, isDelete: false });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (sub.sellerId !== sellerId) throw new ForbiddenException('Access denied');
    return sub;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLANS
  // ═══════════════════════════════════════════════════════════════════════════

  async createPlan(sellerId: string, dto: CreatePlanDto) {
    const displayCurrency = dto.displayCurrency ?? 'USD';
    let exchangeRateSnapshot: number | null = null;

    if (displayCurrency === 'PKR') {
      exchangeRateSnapshot = this.currency.getCurrentPkrRate();
    }

    const plan = await this.planModel.create({
      sellerId,
      name: dto.name,
      description: dto.description ?? null,
      monthlyPriceUSD: this.round(dto.monthlyPriceUSD),
      yearlyPriceUSD: dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null,
      displayCurrency,
      exchangeRateSnapshot,
      features: dto.features ?? [],
      status: 'active',
    });

    return { success: true, data: plan };
  }

  async listPlans(sellerId: string) {
    const plans = await this.planModel
      .find({ sellerId, isDelete: false })
      .sort({ createdAt: -1 })
      .lean();

    // Attach computed metrics per plan
    const enriched = await Promise.all(
      plans.map(async (plan) => {
        const planId = (plan as any)._id.toString();

        const [subscriberCount, mrrAgg] = await Promise.all([
          this.subModel.countDocuments({ planId, status: 'active' }),
          this.subModel.aggregate([
            { $match: { planId, status: 'active' } },
            {
              $group: {
                _id: '$billingInterval',
                total: { $sum: '$amountUSD' },
              },
            },
          ]),
        ]);

        let monthlyRecurringRevenueUSD = 0;
        for (const row of mrrAgg) {
          monthlyRecurringRevenueUSD += this.toMrrContribution(row.total, row._id);
        }

        const displayPrice = this.currency.formatForDisplay(
          plan.monthlyPriceUSD,
          plan.displayCurrency as 'USD' | 'PKR',
          plan.exchangeRateSnapshot,
        );

        return {
          ...plan,
          subscriberCount,
          monthlyRecurringRevenueUSD: this.round(monthlyRecurringRevenueUSD),
          displayMonthlyPrice: displayPrice,
        };
      }),
    );

    return { success: true, data: enriched };
  }

  async getPlanById(sellerId: string, planId: string) {
    const plan = await this.verifyPlanOwnership(sellerId, planId);

    const [subscriberCount, mrrAgg] = await Promise.all([
      this.subModel.countDocuments({ planId, status: 'active' }),
      this.subModel.aggregate([
        { $match: { planId, status: 'active' } },
        { $group: { _id: '$billingInterval', total: { $sum: '$amountUSD' } } },
      ]),
    ]);

    let monthlyRecurringRevenueUSD = 0;
    for (const row of mrrAgg) {
      monthlyRecurringRevenueUSD += this.toMrrContribution(row.total, row._id);
    }

    return {
      success: true,
      data: {
        ...plan.toObject(),
        subscriberCount,
        monthlyRecurringRevenueUSD: this.round(monthlyRecurringRevenueUSD),
        displayMonthlyPrice: this.currency.formatForDisplay(
          plan.monthlyPriceUSD,
          plan.displayCurrency as 'USD' | 'PKR',
          plan.exchangeRateSnapshot,
        ),
      },
    };
  }

  async updatePlan(sellerId: string, planId: string, dto: UpdatePlanDto) {
    const plan = await this.verifyPlanOwnership(sellerId, planId);

    if (dto.name !== undefined)           plan.name = dto.name;
    if (dto.description !== undefined)    plan.description = dto.description ?? null;
    if (dto.monthlyPriceUSD !== undefined) plan.monthlyPriceUSD = this.round(dto.monthlyPriceUSD);
    if (dto.yearlyPriceUSD !== undefined)
      plan.yearlyPriceUSD = dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null;
    if (dto.features !== undefined)       plan.features = dto.features;
    if (dto.status !== undefined)         plan.status = dto.status;

    if (dto.displayCurrency !== undefined) {
      plan.displayCurrency = dto.displayCurrency;
      plan.exchangeRateSnapshot =
        dto.displayCurrency === 'PKR' ? this.currency.getCurrentPkrRate() : null;
    }

    await plan.save();
    return { success: true, data: plan };
  }

  async archivePlan(sellerId: string, planId: string, force: boolean) {
    const plan = await this.verifyPlanOwnership(sellerId, planId);

    const activeCount = await this.subModel.countDocuments({ planId, status: 'active' });

    if (activeCount > 0 && !force) {
      throw new BadRequestException(
        `This plan has ${activeCount} active subscriber(s). Pass ?force=true to archive anyway (existing subscriptions will continue until canceled).`,
      );
    }

    plan.status = 'archived';
    await plan.save();

    return { success: true, message: `Plan archived. ${activeCount} active subscription(s) unaffected.` };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUBSCRIPTIONS (seller management)
  // ═══════════════════════════════════════════════════════════════════════════

  async listSubscriptions(sellerId: string, query: any) {
    const page  = Math.max(1, parseInt(query.page)  || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter: any = { sellerId, isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.planId) filter.planId = query.planId;

    const [subs, total] = await Promise.all([
      this.subModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.subModel.countDocuments(filter),
    ]);

    // Enrich with customer info and plan name
    const rows = await Promise.all(
      subs.map(async (sub) => {
        const [customer, plan] = await Promise.all([
          this.db.repositories.userModel
            .findById(sub.customerId)
            .select('name email profileImage')
            .lean(),
          this.planModel.findById(sub.planId).select('name').lean(),
        ]);
        return {
          ...sub,
          customer: customer ?? { name: 'Unknown', email: 'N/A' },
          planName: (plan as any)?.name ?? 'Plan not found',
        };
      }),
    );

    return {
      success: true,
      data: {
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        subscriptions: rows,
      },
    };
  }

  async getSubscriptionById(sellerId: string, subId: string) {
    const sub = await this.verifySubOwnership(sellerId, subId);

    const [customer, plan, invoices] = await Promise.all([
      this.db.repositories.userModel
        .findById(sub.customerId)
        .select('name email phone profileImage')
        .lean(),
      this.planModel.findById(sub.planId).select('name monthlyPriceUSD yearlyPriceUSD features').lean(),
      this.invoiceModel
        .find({ subscriptionId: subId, isDelete: false })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    return {
      success: true,
      data: {
        ...sub.toObject(),
        customer: customer ?? { name: 'Unknown', email: 'N/A' },
        plan: plan ?? null,
        invoices,
      },
    };
  }

  async pauseSubscription(sellerId: string, subId: string) {
    const sub = await this.verifySubOwnership(sellerId, subId);

    if (sub.status !== 'active') {
      throw new BadRequestException(`Cannot pause a subscription with status "${sub.status}"`);
    }

    sub.status = 'paused';
    sub.pausedAt = new Date();
    await sub.save();

    return { success: true, message: 'Subscription paused successfully', data: sub };
  }

  async resumeSubscription(sellerId: string, subId: string) {
    const sub = await this.verifySubOwnership(sellerId, subId);

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
    await sub.save();

    return { success: true, message: 'Subscription resumed successfully', data: sub };
  }

  async cancelSubscription(sellerId: string, subId: string, atPeriodEnd: boolean) {
    const sub = await this.verifySubOwnership(sellerId, subId);

    if (sub.status === 'canceled') {
      throw new BadRequestException('Subscription is already canceled');
    }

    const now = new Date();

    if (atPeriodEnd) {
      // Keep active until period ends — just mark the intent
      sub.canceledAt = sub.currentPeriodEnd;
      // Keep status as active but flag it — UI shows "cancels on <date>"
      // In a real system, a cron job would flip to canceled on that date.
      // For now we set a canceledAt so the dashboard can compute it.
    } else {
      sub.status = 'canceled';
      sub.canceledAt = now;
    }

    // Cancel on the provider side
    if (sub.providerSubscriptionId) {
      await this.gateway.cancelProviderSubscription(sub.providerSubscriptionId);
    }

    await sub.save();

    const message = atPeriodEnd
      ? `Subscription will cancel at end of current period (${sub.currentPeriodEnd.toISOString().split('T')[0]})`
      : 'Subscription canceled immediately';

    return { success: true, message, data: sub };
  }

  async exportCsv(sellerId: string, query: any): Promise<string> {
    const filter: any = { sellerId, isDelete: false };
    if (query.status) filter.status = query.status;
    if (query.planId) filter.planId = query.planId;

    const subs = await this.subModel.find(filter).sort({ createdAt: -1 }).limit(5000).lean();

    const customerIds = [...new Set(subs.map((s: any) => s.customerId))];
    const planIds     = [...new Set(subs.map((s: any) => s.planId))];

    const [customers, plans] = await Promise.all([
      this.db.repositories.userModel
        .find({ _id: { $in: customerIds } })
        .select('name email')
        .lean(),
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
        sub._id.toString(),
        `"${c.name ?? ''}"`,
        `"${c.email ?? ''}"`,
        `"${(p as any).name ?? ''}"`,
        sub.billingInterval,
        sub.amountUSD.toFixed(2),
        sub.status,
        started,
        nextBill,
        sub.totalPaidUSD.toFixed(2),
      ].join(',');
    });

    return header + rows.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD  (all figures in USD, no currency grouping)
  // ═══════════════════════════════════════════════════════════════════════════

  async getDashboard(sellerId: string) {
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

    const [
      activeSubs,
      newThisMonth,
      canceledThisMonth,
      totalRevenueAgg,
      planBreakdownRaw,
      recentInvoices,
      activeLastMonth,
    ] = await Promise.all([
      // Active subscriptions (full docs for MRR calc)
      this.subModel.find({ sellerId, status: 'active', isDelete: false }).lean(),
      // New this month
      this.subModel.countDocuments({
        sellerId, isDelete: false,
        startedAt: { $gte: thisMonthStart },
      }),
      // Canceled this month
      this.subModel.countDocuments({
        sellerId, isDelete: false,
        status: 'canceled',
        canceledAt: { $gte: thisMonthStart },
      }),
      // Total revenue from paid invoices (all time)
      this.invoiceModel.aggregate([
        { $match: { sellerId, status: 'paid', isDelete: false } },
        { $group: { _id: null, total: { $sum: '$amountUSD' } } },
      ]),
      // Per-plan active subscriber count
      this.subModel.aggregate([
        { $match: { sellerId, status: 'active', isDelete: false } },
        {
          $group: {
            _id: '$planId',
            subscriberCount: { $sum: 1 },
            monthlyRevenue: {
              $sum: {
                $cond: [
                  { $eq: ['$billingInterval', 'monthly'] },
                  '$amountUSD',
                  { $divide: ['$amountUSD', 12] },
                ],
              },
            },
          },
        },
      ]),
      // Last 10 paid invoices
      this.invoiceModel
        .find({ sellerId, status: 'paid', isDelete: false })
        .sort({ paidAt: -1 })
        .limit(10)
        .lean(),
      // Active count at start of month for churn denominator
      this.subModel.countDocuments({
        sellerId, isDelete: false,
        status: { $in: ['active', 'canceled', 'paused'] },
        startedAt: { $lt: thisMonthStart },
      }),
    ]);

    // MRR = sum of monthly amounts + (yearly amounts / 12)
    const mrr = this.round(
      activeSubs.reduce((acc: number, sub: any) => acc + this.toMrrContribution(sub.amountUSD, sub.billingInterval), 0),
    );
    const arr = this.round(mrr * 12);

    // Churn rate = canceled this month / (subs active at start of month) * 100
    const churnRate = activeLastMonth > 0
      ? this.round((canceledThisMonth / activeLastMonth) * 100)
      : 0;

    const totalRevenue = this.round(totalRevenueAgg[0]?.total ?? 0);

    // Enrich plan breakdown with plan names
    const planIds = planBreakdownRaw.map((r: any) => r._id);
    const plans = await this.planModel.find({ _id: { $in: planIds } }).select('name').lean();
    const planNameMap = Object.fromEntries(plans.map((p: any) => [p._id.toString(), p.name]));

    const planBreakdown = planBreakdownRaw.map((r: any) => ({
      planId: r._id,
      planName: planNameMap[r._id] ?? 'Unknown',
      subscriberCount: r.subscriberCount,
      mrrContributionUSD: this.round(r.monthlyRevenue),
    }));

    // Revenue this month vs last month
    const [thisMonthRevAgg, lastMonthRevAgg] = await Promise.all([
      this.invoiceModel.aggregate([
        { $match: { sellerId, status: 'paid', isDelete: false, paidAt: { $gte: thisMonthStart } } },
        { $group: { _id: null, total: { $sum: '$amountUSD' } } },
      ]),
      this.invoiceModel.aggregate([
        { $match: { sellerId, status: 'paid', isDelete: false, paidAt: { $gte: lastMonthStart, $lte: lastMonthEnd } } },
        { $group: { _id: null, total: { $sum: '$amountUSD' } } },
      ]),
    ]);

    const revenueThisMonth = this.round(thisMonthRevAgg[0]?.total ?? 0);
    const revenueLastMonth = this.round(lastMonthRevAgg[0]?.total ?? 0);
    const revenueGrowthPercent = revenueLastMonth > 0
      ? this.round(((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100)
      : 0;

    return {
      success: true,
      data: {
        // Core metrics (all USD)
        mrr,
        arr,
        activeSubscribersCount: activeSubs.length,
        totalRevenue,

        // Growth
        newSubscribersThisMonth: newThisMonth,
        canceledThisMonth,
        churnRate,
        revenueThisMonth,
        revenueLastMonth,
        revenueGrowthPercent,

        // Breakdown
        planBreakdown,
        recentInvoices,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL — called by customer-facing module (future) to create a subscription
  // ═══════════════════════════════════════════════════════════════════════════

  async createSubscription(
    customerId: string,
    planId: string,
    billingInterval: 'monthly' | 'yearly',
  ) {
    const plan = await this.planModel.findOne({ _id: planId, isDelete: false, status: 'active' });
    if (!plan) throw new NotFoundException('Subscription plan not found or inactive');

    const amountUSD = billingInterval === 'yearly'
      ? (plan.yearlyPriceUSD ?? this.round(plan.monthlyPriceUSD * 12))
      : plan.monthlyPriceUSD;

    // Check no active duplicate
    const existing = await this.subModel.findOne({
      customerId, planId, status: { $in: ['active', 'paused'] }, isDelete: false,
    });
    if (existing) throw new ConflictException('Customer already has an active subscription to this plan');

    const now = new Date();
    const periodEnd = this.addPeriod(now, billingInterval);

    // Create the subscription record first (get an ID for provider)
    const sub = await this.subModel.create({
      planId,
      customerId,
      sellerId: plan.sellerId,
      billingInterval,
      amountUSD: this.round(amountUSD),
      status: 'active',
      startedAt: now,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      nextBillingDate: periodEnd,
      paymentProvider: 'manual',
    });

    // Create provider subscription
    const { providerSubscriptionId } = await this.gateway.createProviderSubscription(
      (sub as any)._id.toString(),
      plan.name,
      amountUSD,
      billingInterval,
    );
    sub.providerSubscriptionId = providerSubscriptionId;

    // Charge the first billing cycle
    const charge = await this.gateway.chargeSubscription((sub as any)._id.toString(), amountUSD);

    const invoice = await this.invoiceModel.create({
      subscriptionId: (sub as any)._id.toString(),
      sellerId: plan.sellerId,
      customerId,
      invoiceNumber: this.generateInvoiceNumber(),
      amountUSD: this.round(amountUSD),
      status: charge.success ? 'paid' : 'failed',
      paidAt: charge.success ? now : null,
      providerChargeId: charge.providerChargeId,
    });

    if (charge.success) {
      sub.totalPaidUSD = this.round(amountUSD);
    } else {
      sub.status = 'past_due';
    }

    await sub.save();

    return { success: true, data: { subscription: sub, invoice } };
  }
}
