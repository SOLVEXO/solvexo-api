/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';

export type PlanBenefit = Record<string, any>;

export interface ProductDiscountResult {
  discountPercent:  number;
  subscriberPrice:  number;
  savingsUSD:       number;
  minOrderValueUSD: number | null;
  matchedScope:     'product' | 'category' | 'store';
}

export interface ShippingBenefitResult {
  free:                        boolean;
  discountPercent:             number;
  minOrderValueForShippingUSD: number | null;
}

export interface PlanHealthEstimate {
  avgOrderValueUSD:               number;
  avgMonthlyOrdersPerCustomer:    number;
  estimatedMonthlyCostPerSubscriberUSD: number;
  planPriceMonthlyUSD:            number;
  health:                         'healthy' | 'warning' | 'risky';
  message:                        string;
  lowConfidence:                  boolean;
}

/**
 * Central, reusable logic for resolving what a subscriber gets — product
 * pricing, shipping, loyalty multiplier — and for estimating whether a
 * seller's configured benefits are profitable. Every caller (product
 * listings, checkout, loyalty) goes through this service so enforcement
 * only lives in one place, server-side only.
 */
@Injectable()
export class SubscriptionBenefitsService {
  constructor(private readonly db: DatabaseService) {}

  private round(n: number) { return Math.round(n * 100) / 100; }

  // ── Active benefits lookup ───────────────────────────────────────────────

  async getActiveBenefits(customerId: string | null | undefined, storeId: string): Promise<{ benefits: PlanBenefit[]; planName: string } | null> {
    if (!customerId) return null;
    const sub = await this.db.repositories.subscriptionModel.findOne({
      customerId, storeId, status: 'active', isDelete: false,
    }).lean();
    if (!sub) return null;

    const plan = await this.db.repositories.subscriptionPlanModel.findOne({
      _id: (sub as any).planId, isDelete: false,
    }).select('benefits name status').lean();
    if (!plan || (plan as any).status === 'suspended') return null;

    return { benefits: (plan as any).benefits ?? [], planName: (plan as any).name };
  }

  /** Batch version for marketplace listings spanning many stores. */
  async getActiveBenefitsBatch(customerId: string | null | undefined, storeIds: string[]): Promise<Map<string, { benefits: PlanBenefit[]; planName: string }>> {
    const map = new Map<string, { benefits: PlanBenefit[]; planName: string }>();
    if (!customerId || storeIds.length === 0) return map;

    const uniqueStoreIds = [...new Set(storeIds)];
    const subs = await this.db.repositories.subscriptionModel.find({
      customerId, storeId: { $in: uniqueStoreIds }, status: 'active', isDelete: false,
    }).lean();
    if (subs.length === 0) return map;

    const planIds = subs.map((s: any) => s.planId);
    const plans = await this.db.repositories.subscriptionPlanModel.find({
      _id: { $in: planIds }, isDelete: false,
    }).select('benefits name status').lean();
    const planMap = new Map(plans.map((p: any) => [p._id.toString(), p]));

    for (const sub of subs as any[]) {
      const plan = planMap.get(sub.planId);
      if (!plan || plan.status === 'suspended') continue;
      map.set(sub.storeId, { benefits: plan.benefits ?? [], planName: plan.name });
    }
    return map;
  }

  // ── Discount resolution ──────────────────────────────────────────────────

  /** Best-matching discount benefit for a specific product, or null if none applies. */
  resolveProductDiscount(benefits: PlanBenefit[], product: { _id: string; categoryId?: string; subCategoryId?: string | null }, basePrice: number): ProductDiscountResult | null {
    const discountBenefits = benefits.filter(b => b.type === 'discount' && b.enabled !== false && b.discountPercent > 0);
    if (discountBenefits.length === 0) return null;

    const productId = product._id?.toString();
    const categoryIds = [product.categoryId, product.subCategoryId].filter(Boolean) as string[];

    // Precedence: product-specific > category > store-wide. Within the same
    // scope, the highest percent wins (sellers shouldn't stack discounts).
    const pick = (scope: 'product' | 'category' | 'store') => {
      const candidates = discountBenefits.filter(b => {
        if (b.scope !== scope) return false;
        if (scope === 'product') return (b.productIds ?? []).includes(productId);
        if (scope === 'category') return (b.categoryIds ?? []).some((c: string) => categoryIds.includes(c));
        return true; // store-wide
      });
      if (candidates.length === 0) return null;
      return candidates.reduce((best, b) => (b.discountPercent > best.discountPercent ? b : best));
    };

    const match = pick('product') ?? pick('category') ?? pick('store');
    if (!match) return null;

    const rawDiscount = basePrice * (match.discountPercent / 100);
    const cappedDiscount = match.maxDiscountAmountUSD != null ? Math.min(rawDiscount, match.maxDiscountAmountUSD) : rawDiscount;
    const savingsUSD = this.round(cappedDiscount);

    return {
      discountPercent:  match.discountPercent,
      subscriberPrice:  this.round(Math.max(0, basePrice - savingsUSD)),
      savingsUSD,
      minOrderValueUSD: match.minOrderValueUSD ?? null,
      matchedScope:     match.scope,
    };
  }

  resolveShippingBenefit(benefits: PlanBenefit[]): ShippingBenefitResult | null {
    const benefit = benefits.find(b => b.type === 'shipping' && b.enabled !== false);
    if (!benefit) return null;
    return {
      free:                        benefit.shippingType === 'free',
      discountPercent:             benefit.shippingType === 'free' ? 100 : (benefit.shippingDiscountPercent ?? 0),
      minOrderValueForShippingUSD: benefit.minOrderValueForShippingUSD ?? null,
    };
  }

  getLoyaltyMultiplier(benefits: PlanBenefit[]): number {
    const benefit = benefits.find(b => b.type === 'loyalty_multiplier' && b.enabled !== false);
    return benefit?.multiplier ?? 1;
  }

  hasEarlyAccess(benefits: PlanBenefit[]): boolean {
    return benefits.some(b => b.type === 'early_access' && b.enabled !== false);
  }

  /**
   * Longest `early_access` window configured across any of the store's
   * active plans — used to stamp `Product.earlyAccessUntil` at
   * publish/activation time (before any specific buyer is known). Returns
   * null if no active plan configures this benefit, so callers can skip the
   * early-access window entirely.
   */
  async getStoreEarlyAccessHours(storeId: string): Promise<number | null> {
    const plans = await this.db.repositories.subscriptionPlanModel
      .find({ storeId, status: 'active', isDelete: false }).select('benefits').lean();

    let maxHours: number | null = null;
    for (const plan of plans as any[]) {
      const benefit = (plan.benefits ?? []).find((b: any) => b.type === 'early_access' && b.enabled !== false && b.earlyAccessHours > 0);
      if (benefit && (maxHours === null || benefit.earlyAccessHours > maxHours)) {
        maxHours = benefit.earlyAccessHours;
      }
    }
    return maxHours;
  }

  // ── Profitability estimation ─────────────────────────────────────────────

  async estimatePlanProfitability(storeId: string, benefits: PlanBenefit[], planPriceMonthlyUSD: number): Promise<PlanHealthEstimate> {
    const { orderModel } = this.db.repositories;

    const orders = await orderModel.find({
      'sellerOrders.storeId': storeId, isDelete: false, paymentStatus: 'paid',
    }).select('sellerOrders userId createdAt').lean();

    const lowConfidence = orders.length < 10;

    let avgOrderValueUSD = 30; // sane fallback for a brand-new store with no history
    let avgMonthlyOrdersPerCustomer = 1;

    if (orders.length > 0) {
      const perCustomer: Record<string, { total: number; count: number; months: Set<string> }> = {};
      let totalValue = 0, totalCount = 0;

      for (const order of orders as any[]) {
        const relevant = ((order.sellerOrders as any[]) ?? []).filter(so => so.storeId === storeId);
        const orderValue = relevant.reduce((s, so) => s + so.subtotal, 0);
        if (orderValue <= 0) continue;

        totalValue += orderValue;
        totalCount += 1;

        const key = order.userId;
        const monthKey = new Date(order.createdAt).toISOString().slice(0, 7);
        if (!perCustomer[key]) perCustomer[key] = { total: 0, count: 0, months: new Set() };
        perCustomer[key].total += orderValue;
        perCustomer[key].count += 1;
        perCustomer[key].months.add(monthKey);
      }

      if (totalCount > 0) avgOrderValueUSD = this.round(totalValue / totalCount);

      const customers = Object.values(perCustomer);
      if (customers.length > 0) {
        const avgOrdersPerActiveMonth = customers.reduce((sum, c) => sum + c.count / Math.max(1, c.months.size), 0) / customers.length;
        avgMonthlyOrdersPerCustomer = Math.max(0.5, this.round(avgOrdersPerActiveMonth));
      }
    }

    const discountBenefit = benefits.find(b => b.type === 'discount' && b.enabled !== false);
    const discountPercent = discountBenefit?.discountPercent ?? 0;
    const costPerOrder = avgOrderValueUSD * (discountPercent / 100);

    const shippingBenefit = benefits.find(b => b.type === 'shipping' && b.enabled !== false);
    // Rough shipping-cost estimate — most stores don't track true carrier cost,
    // so this uses a conservative flat estimate rather than inventing precision.
    const estimatedShippingCostPerOrder = shippingBenefit?.shippingType === 'free' ? 6 : shippingBenefit ? 3 : 0;

    const estimatedMonthlyCostPerSubscriberUSD = this.round(
      (costPerOrder + estimatedShippingCostPerOrder) * avgMonthlyOrdersPerCustomer,
    );

    let health: PlanHealthEstimate['health'] = 'healthy';
    let message = `Based on your store's order history, a typical subscriber is estimated to cost ~$${estimatedMonthlyCostPerSubscriberUSD.toFixed(2)}/mo against a $${planPriceMonthlyUSD.toFixed(2)} plan price — comfortably profitable.`;

    if (estimatedMonthlyCostPerSubscriberUSD > planPriceMonthlyUSD) {
      health = 'risky';
      message = `Warning: this plan may reduce your profit. Estimated benefit cost (~$${estimatedMonthlyCostPerSubscriberUSD.toFixed(2)}/mo) exceeds the plan price ($${planPriceMonthlyUSD.toFixed(2)}/mo) based on your store's typical subscriber usage.`;
    } else if (estimatedMonthlyCostPerSubscriberUSD > planPriceMonthlyUSD * 0.7) {
      health = 'warning';
      message = `Caution: estimated benefit cost (~$${estimatedMonthlyCostPerSubscriberUSD.toFixed(2)}/mo) is close to your plan price ($${planPriceMonthlyUSD.toFixed(2)}/mo) — margin is thin once you account for payment processing.`;
    }

    if (lowConfidence) {
      message += ' (Low confidence — your store has limited order history; this estimate will improve over time.)';
    }

    return { avgOrderValueUSD, avgMonthlyOrdersPerCustomer, estimatedMonthlyCostPerSubscriberUSD, planPriceMonthlyUSD, health, message, lowConfidence };
  }
}
