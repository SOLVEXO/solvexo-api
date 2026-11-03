/* eslint-disable prettier/prettier */

/**
 * Merchant health score: 0-100 per store, from fixed, documented rules (no learned or AI scoring), in the same spirit
 * as PlatformAlertsService. Five parts, each with a maximum:
 *
 *   Sales          30  days since the last order (20) + revenue trend, last 30 days vs the 30 before (10)
 *   Engagement     20  days since the seller last signed in
 *   Billing        25  the store's plan subscription state
 *   Catalog        15  active products, reduced by the share that is out of stock
 *   Customers      10  refund rate over the last 90 days
 *
 * Bands: healthy >= 70, attention 40-69, at_risk < 40. Every point lost comes with a plain-language reason.
 */

export type HealthBand = 'healthy' | 'attention' | 'at_risk';
export type HealthFactor = 'sales' | 'engagement' | 'billing' | 'catalog' | 'customers';

export interface HealthInput {
  storeCreatedAt: Date | string;
  /** Last non-cancelled order, ever. */
  lastOrderAt: Date | string | null;
  revenueLast30: number;
  revenuePrev30: number;
  /** Over the last 90 days; null when there were no sales to refund. */
  refundRatePercent90: number | null;
  /** Last seller sign-in seen in the activity log (kept 90+ days); null = none found. */
  lastSellerLoginAt: Date | string | null;
  activeProducts: number;
  /** Active products with limited stock and none available. */
  outOfStockProducts: number;
  subscription: {
    status: string; amountUSD: number; billingInterval?: string | null; cancelAtPeriodEnd?: boolean;
    failedPaymentAttempts?: number; trialEndsAt?: Date | string | null; platformPlanId?: string | null;
  } | null;
}

export interface HealthResult {
  score: number;
  band: HealthBand;
  parts: Record<HealthFactor, { points: number; max: number }>;
  /** Most points lost first. */
  reasons: { factor: HealthFactor; lost: number; text: string }[];
  mrr: number;
}

export const HEALTH_MAX: Record<HealthFactor, number> = { sales: 30, engagement: 20, billing: 25, catalog: 15, customers: 10 };
const DAY = 86_400_000;
const days = (from: Date | string | null, now: number) => (from ? Math.floor((now - new Date(from).getTime()) / DAY) : null);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export const bandOf = (score: number): HealthBand => (score >= 70 ? 'healthy' : score >= 40 ? 'attention' : 'at_risk');

export function scoreMerchant(i: HealthInput, now = Date.now()): HealthResult {
  const reasons: HealthResult['reasons'] = [];
  const lose = (factor: HealthFactor, lost: number, text: string) => { if (lost > 0) reasons.push({ factor, lost, text }); };
  const storeAge = days(i.storeCreatedAt, now) ?? 0;
  const isNew = storeAge <= 30;

  // ── Sales (30) ──
  let sales = 0;
  const sinceOrder = days(i.lastOrderAt, now);
  if (sinceOrder === null) {
    // A brand-new store gets half credit while it finds its first customer.
    sales = isNew ? 15 : 0;
    lose('sales', 30 - sales, isNew ? 'No orders yet (store opened in the last 30 days)' : `No orders since the store opened ${plural(storeAge, 'day')} ago`);
  } else {
    const recency = sinceOrder <= 7 ? 20 : sinceOrder <= 30 ? 15 : sinceOrder <= 60 ? 8 : sinceOrder <= 90 ? 3 : 0;
    if (recency < 20) lose('sales', 20 - recency, `Last order ${plural(sinceOrder, 'day')} ago`);
    let trend = 0;
    if (i.revenueLast30 > 0 && i.revenuePrev30 <= 0) trend = 10;
    else if (i.revenuePrev30 > 0) {
      const change = (i.revenueLast30 - i.revenuePrev30) / i.revenuePrev30;
      trend = change >= 0 ? 10 : change >= -0.5 ? 5 : 0;
      if (trend < 10) lose('sales', 10 - trend, `Revenue down ${Math.round(-change * 100)}% vs the previous 30 days`);
    } else lose('sales', 10, 'No revenue in the last 60 days');
    sales = recency + trend;
  }

  // ── Engagement (20) ──
  const sinceLogin = days(i.lastSellerLoginAt, now);
  const engagement = sinceLogin === null ? 0 : sinceLogin <= 7 ? 20 : sinceLogin <= 14 ? 15 : sinceLogin <= 30 ? 8 : sinceLogin <= 60 ? 3 : 0;
  if (engagement < 20) lose('engagement', 20 - engagement, sinceLogin === null ? 'Seller hasn\'t signed in for over 90 days' : `Seller last signed in ${plural(sinceLogin, 'day')} ago`);

  // ── Billing (25) ──
  const sub = i.subscription;
  let billing = 10;
  let billingText = 'No plan subscription on record';
  if (sub) {
    const trialLeft = sub.trialEndsAt ? Math.ceil((new Date(sub.trialEndsAt).getTime() - now) / DAY) : null;
    switch (sub.status) {
      case 'active':
        if (sub.cancelAtPeriodEnd) { billing = 5; billingText = 'Cancellation scheduled at the end of the billing period'; }
        else if (!(sub.amountUSD > 0)) { billing = 15; billingText = 'On a free plan'; }
        else { billing = 25; billingText = ''; }
        break;
      case 'trialing':
        if (sub.platformPlanId) { billing = 22; billingText = 'Plan bought; trial still running'; }
        else if (trialLeft !== null && trialLeft <= 3) { billing = 8; billingText = `Trial ends in ${plural(Math.max(trialLeft, 0), 'day')} and no plan chosen`; }
        else { billing = 15; billingText = 'On a free trial, no plan chosen yet'; }
        break;
      case 'past_due': {
        const n = sub.failedPaymentAttempts ?? 0;
        billing = n >= 2 ? 2 : 6;
        billingText = `Payment failed${n > 0 ? ` (${plural(n, 'attempt')})` : ''}`;
        break;
      }
      case 'locked': billing = 0; billingText = 'Store locked for non-payment'; break;
      case 'trial_ended': billing = 0; billingText = 'Trial ended without choosing a plan'; break;
      case 'canceled': billing = 0; billingText = 'Plan canceled'; break;
    }
  }
  lose('billing', 25 - billing, billingText);

  // ── Catalog (15) ──
  const base = i.activeProducts === 0 ? 0 : i.activeProducts < 5 ? 6 : i.activeProducts < 20 ? 11 : 15;
  const oosShare = i.activeProducts > 0 ? Math.min(1, i.outOfStockProducts / i.activeProducts) : 0;
  const catalog = Math.round(base * (1 - oosShare * 0.5));
  if (i.activeProducts === 0) lose('catalog', 15, 'No active products');
  else {
    if (base < 15) lose('catalog', 15 - base, `Only ${plural(i.activeProducts, 'active product')}`);
    if (base - catalog > 0) lose('catalog', base - catalog, `${Math.round(oosShare * 100)}% of products out of stock`);
  }

  // ── Customers (10) ──
  const r = i.refundRatePercent90;
  const customers = r === null ? 5 : r <= 2 ? 10 : r <= 5 ? 7 : r <= 10 ? 3 : 0;
  if (r !== null && customers < 10) lose('customers', 10 - customers, `Refunds are ${Math.round(r * 10) / 10}% of revenue (90 days)`);

  const parts = {
    sales: { points: sales, max: 30 }, engagement: { points: engagement, max: 20 }, billing: { points: billing, max: 25 },
    catalog: { points: catalog, max: 15 }, customers: { points: customers, max: 10 },
  };
  const score = sales + engagement + billing + catalog + customers;
  const mrr = sub && ['active', 'past_due'].includes(sub.status) && sub.amountUSD > 0
    ? Math.round((sub.billingInterval === 'yearly' ? sub.amountUSD / 12 : sub.amountUSD) * 100) / 100 : 0;
  return { score, band: bandOf(score), parts, reasons: reasons.sort((a, b) => b.lost - a.lost), mrr };
}
