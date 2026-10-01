/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { CreatePlatformPlanDto } from './dto/create-platform-plan.dto';
import { UpdatePlatformPlanDto } from './dto/update-platform-plan.dto';
import { UpdateTrialSettingsDto } from './dto/update-trial-settings.dto';
import { PlatformPlanCatalogService } from './platform-plan-catalog.service';
import { validatePlanLimits, validatePlanPricing, validateTierOrder } from './platform-plan.catalog';

/** Admin CRUD + public browse for PlatformPlan — the tiers on the pricing page. */
@Injectable()
export class PlatformPlansService {
  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly catalog: PlatformPlanCatalogService,
  ) {}

  private get planModel() { return this.db.repositories.platformPlanModel; }
  private get subModel() { return this.db.repositories.sellerPlatformSubscriptionModel; }
  private get trialSettingsModel() { return this.db.repositories.platformTrialSettingsModel; }

  private round(n: number) { return Math.round(n * 100) / 100; }

  // ── Admin ──────────────────────────────────────────────────────────────

  /** True for the plans defined in code (basic / grow / advanced / enterprise). */
  private isCatalogPlan(plan: any): boolean {
    return typeof plan?.key === 'string' && plan.key.length > 0;
  }

  /** Plans are defined by the platform (platform-plan.catalog.ts) and created at
   *  server start — an admin manages them, but doesn't build new ones. A
   *  special customer deal is the Enterprise plan assigned to that store. */
  async adminCreatePlan(_adminId: string, _dto: CreatePlatformPlanDto): Promise<never> {
    throw new BadRequestException(
      'Plans are defined by the platform and can\'t be created here. Edit an existing plan\'s price, offer or limits instead — for a special deal, assign the Enterprise plan to that store.',
    );
  }

  async adminListPlans(includeArchived: boolean) {
    const filter: any = { isDelete: false };
    if (!includeArchived) filter.status = 'active';
    const plans = await this.planModel.find(filter).sort({ sortOrder: 1 }).lean();

    const subscriberCounts = await this.subModel.aggregate([
      { $match: { isDelete: false } },
      { $group: { _id: '$platformPlanId', count: { $sum: 1 } } },
    ]);
    const countMap = Object.fromEntries(subscriberCounts.map((r: any) => [r._id, r.count]));

    return { success: true, data: plans.map((p: any) => ({ ...p, subscriberCount: countMap[p._id.toString()] ?? 0 })) };
  }

  async adminGetPlanById(id: string) {
    const plan = await this.planModel.findOne({ _id: id, isDelete: false }).lean();
    if (!plan) throw new NotFoundException('Platform plan not found');
    return { success: true, data: plan };
  }

  async adminUpdatePlan(adminId: string, id: string, dto: UpdatePlatformPlanDto) {
    const plan = await this.planModel.findOne({ _id: id, isDelete: false });
    if (!plan) throw new NotFoundException('Platform plan not found');
    const isCatalog = this.isCatalogPlan(plan);

    // What KIND of plan a core plan is — and its place in the tier order — is fixed in code.
    if (isCatalog) {
      const locked: string[] = [];
      if (dto.isFree !== undefined && dto.isFree !== plan.isFree) locked.push('free/paid');
      if (dto.isCustomPricing !== undefined && dto.isCustomPricing !== plan.isCustomPricing) locked.push('custom pricing');
      if (dto.sortOrder !== undefined && dto.sortOrder !== plan.sortOrder) locked.push('order');
      if (dto.status !== undefined && dto.status !== 'active') locked.push('archiving');
      if (locked.length) {
        throw new BadRequestException(`"${plan.name}" is one of the platform's core plans — ${locked.join(', ')} can't be changed.`);
      }
    }

    if (dto.name !== undefined) plan.name = dto.name;
    if (dto.description !== undefined) plan.description = dto.description ?? null;
    if (dto.badge !== undefined) plan.badge = dto.badge ?? null;
    if (!isCatalog && dto.sortOrder !== undefined) plan.sortOrder = dto.sortOrder;
    if (!isCatalog && dto.isFree !== undefined) plan.isFree = dto.isFree;
    if (!isCatalog && dto.isCustomPricing !== undefined) plan.isCustomPricing = dto.isCustomPricing;
    if (dto.monthlyPriceUSD !== undefined) {
      plan.monthlyPriceUSD = dto.monthlyPriceUSD != null ? this.round(dto.monthlyPriceUSD) : null;
      // Price changed — cached Stripe Price ids are now stale (Stripe Prices are
      // immutable); clear them so the next subscribe/renewal lazily creates fresh ones.
      plan.stripeMonthlyPriceId = null;
    }
    if (dto.yearlyPriceUSD !== undefined) {
      plan.yearlyPriceUSD = dto.yearlyPriceUSD != null ? this.round(dto.yearlyPriceUSD) : null;
      plan.stripeYearlyPriceId = null;
    }
    if (dto.trialDays !== undefined) plan.trialDays = dto.trialDays;
    // A core plan's bullets are generated from its limits — never typed — so text can't disagree with enforcement.
    if (!isCatalog && dto.featureBullets !== undefined) plan.featureBullets = dto.featureBullets;
    if (dto.limits !== undefined) plan.limits = { ...plan.limits, ...dto.limits } as any;
    if (!isCatalog && dto.status !== undefined) plan.status = dto.status;
    if (dto.isPubliclyVisible !== undefined) plan.isPubliclyVisible = dto.isPubliclyVisible;
    if (dto.gracePeriodDays !== undefined) plan.gracePeriodDays = dto.gracePeriodDays;

    if (dto.introOfferEnabled !== undefined) plan.introOfferEnabled = dto.introOfferEnabled;
    if (dto.introPriceUSD !== undefined) plan.introPriceUSD = dto.introPriceUSD != null ? this.round(dto.introPriceUSD) : null;
    if (dto.introDurationCycles !== undefined) plan.introDurationCycles = dto.introDurationCycles ?? null;
    if (dto.introOfferEnabled !== undefined || dto.introPriceUSD !== undefined || dto.introDurationCycles !== undefined) {
      // Any intro-offer field changed — the cached Stripe Coupon (if one was
      // ever created) reflects the OLD terms; Stripe Coupons are immutable
      // just like Prices, so clear it the same way price edits already do.
      plan.stripeIntroCouponId = null;
    }

    // ── Guard-rails — nothing below has been saved yet, so a failed check changes nothing ──
    const problems: string[] = [];
    problems.push(...validatePlanPricing({
      isFree: plan.isFree, isCustomPricing: plan.isCustomPricing,
      monthlyPriceUSD: plan.monthlyPriceUSD, yearlyPriceUSD: plan.yearlyPriceUSD,
      introOfferEnabled: plan.introOfferEnabled, introPriceUSD: plan.introPriceUSD, introDurationCycles: plan.introDurationCycles,
    }));
    if (dto.limits !== undefined) {
      problems.push(...validatePlanLimits(plan.limits));
      if (isCatalog && problems.length === 0) {
        // Each tier must include at least what the one below it includes.
        const others: any[] = await this.planModel
          .find({ key: { $type: 'string' }, isDelete: false, _id: { $ne: plan._id } }).select('name sortOrder limits').lean();
        const tiers = [...others, plan].sort((a: any, b: any) => a.sortOrder - b.sortOrder);
        const at = tiers.findIndex((t: any) => t === plan);
        if (at > 0) problems.push(...validateTierOrder(tiers[at - 1], plan as any));
        if (at < tiers.length - 1) problems.push(...validateTierOrder(plan as any, tiers[at + 1]));
      }
    }
    // The pricing page and onboarding must always have a plan a seller can buy.
    const sellable = !plan.isFree && !plan.isCustomPricing;
    const nowHidden = plan.isPubliclyVisible === false || plan.status !== 'active';
    if (sellable && nowHidden) {
      const stillBuyable = await this.planModel.countDocuments({
        _id: { $ne: plan._id }, status: 'active', isDelete: false, isPubliclyVisible: { $ne: false }, isFree: false, isCustomPricing: false,
      });
      if (stillBuyable === 0) problems.push('At least one paid plan must stay visible for sellers to buy.');
    }
    if (problems.length) throw new BadRequestException(problems.join(' '));

    await plan.save();
    if (isCatalog) await this.catalog.refreshBullets(); // a plan's bullets are "what's new vs the plan below"

    this.activityLogService.log({
      category: 'platform_plans', action: 'plan_updated',
      description: `Platform plan "${plan.name}" updated by admin`,
      actorId: adminId, actorRole: 'admin',
      targetId: id, targetType: 'platform_plan',
    });

    const fresh = await this.planModel.findById(plan._id).lean();
    // Limits/features apply to every store on this plan right away — tell the admin how many.
    const subscriberCount = await this.subModel.countDocuments({ platformPlanId: id, isDelete: false });
    return { success: true, data: fresh ?? plan, impact: { subscriberCount } };
  }

  async adminArchivePlan(adminId: string, id: string, force: boolean) {
    const plan = await this.planModel.findOne({ _id: id, isDelete: false });
    if (!plan) throw new NotFoundException('Platform plan not found');
    if (this.isCatalogPlan(plan)) throw new BadRequestException(`"${plan.name}" is one of the platform's core plans and can't be archived. Use "visible to sellers" to hide it instead.`);
    if (plan.isFree) throw new BadRequestException('The free/default plan cannot be archived');

    const activeCount = await this.subModel.countDocuments({ platformPlanId: id, status: { $in: ['trialing', 'active', 'past_due'] } });
    if (activeCount > 0 && !force) {
      throw new BadRequestException(
        `This plan has ${activeCount} store(s) currently on it. Pass ?force=true to archive anyway (existing stores are unaffected).`,
      );
    }

    plan.status = 'archived';
    await plan.save();

    this.activityLogService.log({
      category: 'platform_plans', action: 'plan_archived',
      description: `Platform plan "${plan.name}" archived by admin`,
      actorId: adminId, actorRole: 'admin',
      targetId: id, targetType: 'platform_plan',
    });

    return { success: true, message: `Plan archived. ${activeCount} existing store(s) unaffected.` };
  }

  async adminGetSubscribers(id: string, query: any) {
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    const [subs, total] = await Promise.all([
      this.subModel.find({ platformPlanId: id, isDelete: false }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.subModel.countDocuments({ platformPlanId: id, isDelete: false }),
    ]);

    const storeIds = subs.map((s: any) => s.storeId);
    const stores = await this.db.repositories.storeModel.find({ _id: { $in: storeIds } }).select('name slug').lean();
    const storeMap = Object.fromEntries(stores.map((s: any) => [s._id.toString(), s]));

    return {
      success: true,
      data: {
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        subscribers: subs.map((s: any) => ({ ...s, store: storeMap[s.storeId] ?? null })),
      },
    };
  }

  /** Platform-plan revenue — a completely separate line item from buyer-VIP-plan subscription revenue and order commission. */
  async adminGetRevenue(query: any) {
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const to = query.to ? new Date(query.to) : new Date();

    const [totalAgg, byPlanRaw, activeByPlan, activeSubs] = await Promise.all([
      this.db.repositories.platformPlanInvoiceModel.aggregate([
        { $match: { status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
      ]),
      this.db.repositories.platformPlanInvoiceModel.aggregate([
        { $match: { status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } } },
        { $group: { _id: '$platformPlanId', total: { $sum: '$amountUSD' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      this.subModel.aggregate([
        { $match: { isDelete: false, status: { $in: ['trialing', 'active', 'past_due'] } } },
        { $group: { _id: '$platformPlanId', count: { $sum: 1 } } },
      ]),
      // MRR/ARR — a live snapshot of currently-recurring revenue, not a
      // date-range sum of past invoices (that's totalRevenueUSD/byPlan below).
      this.subModel.find({
        isDelete: false, status: { $in: ['active', 'past_due'] }, amountUSD: { $gt: 0 },
      }).select('platformPlanId amountUSD billingInterval').lean(),
    ]);

    const planIds = [...new Set([...byPlanRaw.map((r: any) => r._id), ...activeByPlan.map((r: any) => r._id), ...activeSubs.map((s: any) => s.platformPlanId)])];
    const plans = await this.planModel.find({ _id: { $in: planIds } }).select('name isFree').lean();
    const planMap = Object.fromEntries(plans.map((p: any) => [p._id.toString(), p]));
    const activeCountMap = Object.fromEntries(activeByPlan.map((r: any) => [r._id, r.count]));

    const monthlyAmount = (s: any) => (s.billingInterval === 'yearly' ? s.amountUSD / 12 : s.amountUSD);
    const mrr = this.round(activeSubs.reduce((sum: number, s: any) => sum + monthlyAmount(s), 0));
    const mrrByPlan = new Map<string, number>();
    for (const s of activeSubs) {
      // A real (non-trialing, amountUSD > 0) subscription always has a plan
      // assigned in practice — this guard is just for the type narrowing.
      if (!s.platformPlanId) continue;
      mrrByPlan.set(s.platformPlanId, (mrrByPlan.get(s.platformPlanId) ?? 0) + monthlyAmount(s));
    }

    const activeSubscribersCount = await this.subModel.countDocuments({
      isDelete: false, status: { $in: ['trialing', 'active', 'past_due'] },
    });

    // Seller churn — Solvexo's own subscriber base (sellers paying for a
    // platform plan) churning off entirely, distinct from a buyer churning
    // off a seller's VIP plan (SubscriptionsService's own churnRate, a
    // different collection/relationship). Uses `canceledAt` — a real,
    // precise timestamp on this schema — rather than a startedAt-based
    // proxy, so this is an exact count, not an approximation.
    //
    // Deterministic definitions (never arbitrary):
    //   activeAtPeriodStart = subscriptions that had already started before
    //     `from` AND were not yet canceled as of `from` (canceledAt is null,
    //     or falls on/after `from`) AND are not a pure trial (a trial that
    //     never converts was never a paying subscriber to begin with, so its
    //     later cancellation isn't "churn" in the MRR sense).
    //   canceledInPeriod = subscriptions whose `canceledAt` falls within
    //     [from, to] — an exact, not-inferred, cancellation count.
    //   churnRatePercent = canceledInPeriod / activeAtPeriodStart * 100,
    //   0 when activeAtPeriodStart is 0 (nothing to churn from — not
    //   fabricated, not divide-by-zero).
    const [activeAtPeriodStart, canceledInPeriod] = await Promise.all([
      this.subModel.countDocuments({
        isDelete: false,
        startedAt: { $lt: from },
        status: { $ne: 'trialing' },
        $or: [{ canceledAt: null }, { canceledAt: { $gte: from } }],
      }),
      this.subModel.countDocuments({
        isDelete: false,
        status: 'canceled',
        canceledAt: { $gte: from, $lte: to },
      }),
    ]);
    const churnRatePercent = activeAtPeriodStart > 0 ? this.round((canceledInPeriod / activeAtPeriodStart) * 100) : 0;

    return {
      success: true,
      data: {
        mrr,
        arr: this.round(mrr * 12),
        activeSubscribers: activeSubscribersCount,
        churnRatePercent,
        canceledInPeriod,
        activeAtPeriodStart,
        planBreakdown: Object.keys(activeCountMap).map((planId) => ({
          planName: planMap[planId]?.name ?? 'Unknown',
          subscriberCount: activeCountMap[planId] ?? 0,
          mrrUSD: this.round(mrrByPlan.get(planId) ?? 0),
        })),
        totalRevenueUSD: this.round(totalAgg[0]?.total ?? 0),
        totalInvoicesPaid: totalAgg[0]?.count ?? 0,
        byPlan: byPlanRaw.map((r: any) => ({
          planId: r._id, planName: planMap[r._id]?.name ?? 'Unknown',
          revenueUSD: this.round(r.total), invoiceCount: r.count,
          currentActiveStores: activeCountMap[r._id] ?? 0,
        })),
        note: 'This is platform-plan (seller-to-Solvexo) revenue — a separate line item from buyer-VIP-plan subscription revenue (SubscriptionInvoice) and order commission (FinanceService). churnRatePercent is seller-subscriber churn (sellers canceling their platform plan), not buyer-VIP churn.',
      },
    };
  }

  // ── Trial Settings ─────────────────────────────────────────────────────
  // The ONE platform-wide "Solvexo Free Trial" policy — deliberately separate
  // from any PlatformPlan. Real callers: `SellerPlatformSubscriptionsService.
  // ensureDefaultSubscription` (reads it to start a new store's trial),
  // AdminPlatformPlans' new "Trial Settings" panel (reads/writes it), and
  // onboarding's public trial-duration display (reads it, unauthenticated).

  /** Same upsert-with-empty-filter singleton pattern as `AdminConfigService.getRawConfig`. */
  async getTrialSettings() {
    return this.trialSettingsModel.findOneAndUpdate({}, {}, { upsert: true, new: true, setDefaultsOnInsert: true });
  }

  async adminGetTrialSettings() {
    const settings = await this.getTrialSettings();
    return { success: true, data: settings };
  }

  async adminUpdateTrialSettings(adminId: string, dto: UpdateTrialSettingsDto) {
    const settings = await this.getTrialSettings();
    if (dto.enabled !== undefined) settings.enabled = dto.enabled;
    if (dto.durationDays !== undefined) settings.durationDays = dto.durationDays;
    if (dto.paymentMethodRequired !== undefined) settings.paymentMethodRequired = dto.paymentMethodRequired;
    if (dto.eligibility !== undefined) settings.eligibility = dto.eligibility;
    await settings.save();

    this.activityLogService.log({
      category: 'platform_plans', action: 'trial_settings_updated',
      description: `Store trial settings updated — enabled: ${settings.enabled}, duration: ${settings.durationDays} day(s)`,
      actorId: adminId, actorRole: 'admin',
      targetId: (settings as any)._id.toString(), targetType: 'platform_trial_settings',
    });

    return { success: true, data: settings };
  }

  /** Public, unauthenticated — onboarding reads this so its "your free N-day trial" copy is never hardcoded. */
  async publicTrialSettings() {
    const settings = await this.getTrialSettings();
    return { success: true, data: { enabled: settings.enabled, durationDays: settings.durationDays } };
  }

  // ── Public ─────────────────────────────────────────────────────────────

  async browsePlans() {
    // `isPubliclyVisible` defaults to true on new plans, but existing plans created
    // before this field existed have it entirely absent in Mongo (not backfilled) —
    // `{ $ne: false }` matches both `true` and "field missing", so no migration is
    // needed and no pre-existing plan silently disappears from the pricing page.
    const plans = await this.planModel.find({ status: 'active', isPubliclyVisible: { $ne: false }, isDelete: false }).sort({ sortOrder: 1 }).lean();
    return {
      success: true,
      data: plans.map((p: any) => ({
        _id: p._id, key: p.key ?? null, name: p.name, description: p.description, badge: p.badge,
        isFree: p.isFree, isCustomPricing: p.isCustomPricing,
        monthlyPriceUSD: p.monthlyPriceUSD, yearlyPriceUSD: p.yearlyPriceUSD, trialDays: p.trialDays,
        featureBullets: p.featureBullets, limits: p.limits,
        introOfferEnabled: p.introOfferEnabled ?? false,
        introPriceUSD: p.introPriceUSD ?? null,
        introDurationCycles: p.introDurationCycles ?? null,
      })),
    };
  }
}
