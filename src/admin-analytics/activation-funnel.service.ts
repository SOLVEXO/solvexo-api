/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { type PlanInfo, firstPaidAt } from './saas-metrics.util';
import { type MerchantJourney, funnel, funnelByCohort, funnelBySource, monthOf, stuckMerchants } from './activation-funnel.util';

const STUCK_LIMIT = 50;

/**
 * Merchant activation funnel for sellers who signed up in the last `months` months (see activation-funnel.util.ts).
 * First-time dates per seller, across all their stores: first store, first product, first non-cancelled order,
 * first paid plan. Deleted stores and products still count: the step was reached.
 */
@Injectable()
export class ActivationFunnelService {
  constructor(private readonly db: DatabaseService) {}

  private get r() { return this.db.repositories; }

  async getFunnel(monthsWanted = 6, now = Date.now()) {
    const months = Math.min(Math.max(Math.trunc(monthsWanted) || 6, 1), 24);
    const d = new Date(now);
    const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (months - 1), 1));
    const monthKeys = Array.from({ length: months }, (_, i) => monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (months - 1) + i, 1)));

    const journeys = await this.journeys(from);
    return {
      success: true,
      data: {
        from: from.toISOString(), months,
        steps: funnel(journeys),
        byCohort: funnelByCohort(journeys, monthKeys),
        bySource: funnelBySource(journeys),
        stuck: stuckMerchants(journeys, now).slice(0, STUCK_LIMIT),
      },
    };
  }

  private async journeys(from: Date): Promise<MerchantJourney[]> {
    const sellers: any[] = await this.r.sellerModel.find({ isDelete: { $ne: true }, createdAt: { $gte: from } })
      .select('name email isVerified acquisitionSource createdAt').lean();
    if (sellers.length === 0) return [];
    const sellerIds = sellers.map((s) => String(s._id));

    const stores: any[] = await this.r.storeModel.find({ sellerId: { $in: sellerIds } }).select('sellerId createdAt').lean();
    const storeIds = stores.map((s) => String(s._id));
    const storeSeller = new Map(stores.map((s) => [String(s._id), String(s.sellerId)]));

    const [firstProducts, firstSales, subs, plans] = await Promise.all([
      this.r.productModel.aggregate([
        { $match: { storeId: { $in: storeIds } } },
        { $group: { _id: '$storeId', at: { $min: '$createdAt' } } },
      ]),
      this.r.orderModel.aggregate([
        { $match: { isDelete: false, 'sellerOrders.storeId': { $in: storeIds } } },
        { $unwind: '$sellerOrders' },
        { $match: { 'sellerOrders.storeId': { $in: storeIds }, 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $group: { _id: '$sellerOrders.storeId', at: { $min: '$createdAt' } } },
      ]),
      this.r.sellerPlatformSubscriptionModel.find({ storeId: { $in: storeIds }, isDelete: { $ne: true } })
        .select('storeId status platformPlanId amountUSD billingInterval startedAt trialEndsAt canceledAt lockedAt gracePeriodEndsAt updatedAt planHistory').lean() as Promise<any[]>,
      this.r.platformPlanModel.find({}).select('isFree monthlyPriceUSD yearlyPriceUSD gracePeriodDays').lean() as Promise<any[]>,
    ]);
    const planMap = new Map<string, PlanInfo>(plans.map((p) => [String(p._id), p]));

    // Earliest date per seller across all of their stores.
    const earliest = new Map<string, { store?: number; product?: number; sale?: number; paid?: number }>();
    const note = (sellerId: string | undefined, key: 'store' | 'product' | 'sale' | 'paid', at: number | null) => {
      if (!sellerId || at === null || Number.isNaN(at)) return;
      const e = earliest.get(sellerId) ?? {};
      if (e[key] === undefined || at < e[key]!) e[key] = at;
      earliest.set(sellerId, e);
    };
    for (const s of stores) note(String(s.sellerId), 'store', new Date(s.createdAt).getTime());
    for (const p of firstProducts) note(storeSeller.get(String(p._id)), 'product', new Date(p.at).getTime());
    for (const o of firstSales) note(storeSeller.get(String(o._id)), 'sale', new Date(o.at).getTime());
    for (const sub of subs) note(storeSeller.get(String(sub.storeId)), 'paid', firstPaidAt(sub, planMap));

    return sellers.map((s) => {
      const e = earliest.get(String(s._id)) ?? {};
      return {
        sellerId: String(s._id), name: s.name ?? null, email: s.email ?? null, source: s.acquisitionSource ?? null,
        signedUpAt: new Date(s.createdAt).getTime(), verified: !!s.isVerified,
        storeAt: e.store ?? null, productAt: e.product ?? null, saleAt: e.sale ?? null, paidAt: e.paid ?? null,
      };
    });
  }
}
