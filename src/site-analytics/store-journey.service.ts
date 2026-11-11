/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { rangeDays, SiteRange } from './site-analytics.util';

/** What happens to a new store after it is created, from Solvexo's own data (Google Analytics doesn't see seller dashboards). */
export const JOURNEY_STEPS = [
  { key: 'store_created', label: 'Created a store' },
  { key: 'product_added', label: 'Added a product' },
  { key: 'plan_chosen', label: 'Chose a plan' },
  { key: 'first_order', label: 'Got a first order' },
] as const;

/** Subscription states that mean the seller picked a real plan (a trial alone has no plan). */
const PLAN_STATUSES = ['trialing', 'active', 'past_due'];
const FOLLOW_UP_LIMIT = 50;

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : null);

@Injectable()
export class StoreJourneyService {
  constructor(private readonly db: DatabaseService) {}

  private get r() { return this.db.repositories; }

  /**
   * Stores created in the period and how far each got: product added → plan chosen → first order.
   * Each step counts the stores that reached it. `followUp` lists the newest stores that have not added a product
   * yet, with the owner's contact details, so the team can help them finish setting up.
   */
  async journey(range: SiteRange, now = new Date()) {
    const since = new Date(now.getTime() - rangeDays(range) * 86_400_000);
    const stores: any[] = await this.r.storeModel
      .find({ isDelete: false, createdAt: { $gte: since } })
      .select('_id name slug sellerId createdAt')
      .sort({ createdAt: -1 })
      .lean();
    const ids = stores.map((s) => String(s._id));

    const [withProduct, withPlan, withOrder] = ids.length
      ? await Promise.all([
          this.r.productModel.distinct('storeId', { storeId: { $in: ids }, isDelete: false }),
          this.r.sellerPlatformSubscriptionModel.distinct('storeId', {
            storeId: { $in: ids }, platformPlanId: { $ne: null }, status: { $in: PLAN_STATUSES },
          }),
          this.r.orderModel.distinct('sellerOrders.storeId', { 'sellerOrders.storeId': { $in: ids }, isDelete: false }),
        ])
      : [[], [], []];
    const has = (list: unknown[]) => new Set(list.map(String).filter((id) => ids.includes(id)));
    const product = has(withProduct), plan = has(withPlan), order = has(withOrder);

    const counts = [ids.length, product.size, plan.size, order.size];
    const steps = JOURNEY_STEPS.map((step, i) => ({
      key: step.key,
      label: step.label,
      stores: counts[i],
      fromPrevious: i === 0 ? null : pct(counts[i], counts[i - 1]),
      fromStart: i === 0 ? null : pct(counts[i], counts[0]),
    }));

    const stuck = stores.filter((s) => !product.has(String(s._id))).slice(0, FOLLOW_UP_LIMIT);
    const sellers: any[] = stuck.length
      ? await this.r.sellerModel.find({ _id: { $in: stuck.map((s) => s.sellerId) } }).select('name email phone emailIsPlaceholder').lean()
      : [];
    const bySeller = new Map(sellers.map((s) => [String(s._id), s]));
    const followUp = stuck.map((s) => {
      const seller = bySeller.get(String(s.sellerId));
      return {
        storeId: String(s._id),
        storeName: s.name ?? '',
        storeUrl: s.slug ? `https://${s.slug}.solvexo.store` : null,
        createdAt: s.createdAt,
        ownerName: seller?.name ?? '',
        email: seller && !seller.emailIsPlaceholder ? seller.email ?? '' : '',
        phone: seller?.phone ?? '',
        planChosen: plan.has(String(s._id)),
      };
    });

    return { success: true, data: { range, steps, followUp, followUpTotal: stores.length - product.size } };
  }
}
