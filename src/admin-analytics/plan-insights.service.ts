/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { monthKey, monthPoints } from './saas-metrics.util';
import { type InsightSub, type PlanRecord, buildPlanInsights } from './plan-insights.util';

const CACHE_MS = 10 * 60_000;
const SUB_FIELDS = 'storeId status platformPlanId amountUSD billingInterval startedAt trialEndsAt canceledAt lockedAt gracePeriodEndsAt updatedAt planHistory cancelAtPeriodEnd scheduledPlanChange';

/**
 * Admin → SaaS Metrics → Plans: how each platform plan sells, plan moves, real price paid vs list price, and stores
 * outgrowing their product limit. The maths lives in plan-insights.util.ts and shares MRR rules with SaaS metrics.
 */
@Injectable()
export class PlanInsightsService {
  private cache = new Map<number, { at: number; value: any }>();

  constructor(private readonly db: DatabaseService) {}

  async getInsights(monthsWanted = 12, now = Date.now()) {
    const months = Math.min(Math.max(Math.trunc(monthsWanted) || 12, 3), 24);
    const hit = this.cache.get(months);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    const value = await this.compute(months, now);
    this.cache.set(months, { at: now, value });
    return value;
  }

  private async compute(months: number, now: number) {
    const r = this.db.repositories;
    const [subs, plans] = await Promise.all([
      r.sellerPlatformSubscriptionModel.find({ isDelete: { $ne: true } }).select(SUB_FIELDS).lean() as Promise<any[]>,
      r.platformPlanModel.find({ isDelete: { $ne: true } })
        .select('name status isFree isCustomPricing isPubliclyVisible sortOrder monthlyPriceUSD yearlyPriceUSD gracePeriodDays trialDays limits.maxProducts limits.transactionFeeRate')
        .lean() as Promise<any[]>,
    ]);
    const points = monthPoints(months, now);
    const d = new Date(now);
    const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (months - 1), 1);

    // Product counts only for stores on a plan with a product limit (the rest can't outgrow it).
    const limited = new Set(plans.filter((p) => typeof p.limits?.maxProducts === 'number' && p.limits.maxProducts > 0).map((p) => String(p._id)));
    const storeIds = subs.filter((s) => ['active', 'past_due'].includes(s.status) && limited.has(String(s.platformPlanId))).map((s) => String(s.storeId));
    const counts: any[] = storeIds.length
      ? await r.productModel.aggregate([{ $match: { storeId: { $in: storeIds }, isDelete: false } }, { $group: { _id: '$storeId', n: { $sum: 1 } } }])
      : [];

    const out = buildPlanInsights({
      subs: subs as InsightSub[], plans: plans.map((p) => ({ ...p, _id: String(p._id) })) as PlanRecord[],
      from, now, months: points.map(monthKey), productCounts: new Map(counts.map((c) => [String(c._id), c.n])),
    });

    const top = out.candidates.slice(0, 25);
    const stores: any[] = top.length ? await r.storeModel.find({ _id: { $in: top.map((c) => c.storeId) } }).select('name sellerId').lean() : [];
    const storeMap = new Map(stores.map((s) => [String(s._id), s]));

    return {
      success: true,
      data: {
        months, from: new Date(from).toISOString(),
        ...out,
        candidates: top.map((c) => {
          const s = storeMap.get(c.storeId);
          return { ...c, storeName: s?.name ?? 'Unknown store', sellerId: s?.sellerId ? String(s.sellerId) : null };
        }),
      },
    };
  }
}
