/* eslint-disable prettier/prettier */
import { type HealthInput, bandOf, scoreMerchant } from './merchant-health.util';

const NOW = new Date('2026-10-30T12:00:00Z').getTime();
const ago = (d: number) => new Date(NOW - d * 86_400_000);
const thriving: HealthInput = {
  storeCreatedAt: ago(400), lastOrderAt: ago(1), revenueLast30: 5000, revenuePrev30: 4000, refundRatePercent90: 1,
  lastSellerLoginAt: ago(2), activeProducts: 40, outOfStockProducts: 0,
  subscription: { status: 'active', amountUSD: 49, billingInterval: 'monthly' },
};

describe('merchant health score', () => {
  it('a thriving store scores 100 with no reasons, and reports its MRR', () => {
    const r = scoreMerchant(thriving, NOW);
    expect(r).toMatchObject({ score: 100, band: 'healthy', reasons: [], mrr: 49 });
  });

  it('a fading, unpaid store is at risk, with the biggest problems first', () => {
    const r = scoreMerchant({
      ...thriving, lastOrderAt: ago(75), revenueLast30: 0, revenuePrev30: 300, lastSellerLoginAt: ago(40),
      activeProducts: 10, outOfStockProducts: 6, refundRatePercent90: 12,
      subscription: { status: 'past_due', amountUSD: 490, billingInterval: 'yearly', failedPaymentAttempts: 2 },
    }, NOW);
    // sales 3+0, engagement 3, billing 2, catalog round(11*0.7)=8, customers 0
    expect(r.score).toBe(16);
    expect(r.band).toBe('at_risk');
    expect(r.mrr).toBe(40.83); // still billed (past due): yearly / 12
    expect(r.reasons[0]).toEqual({ factor: 'billing', lost: 23, text: 'Payment failed (2 attempts)' });
    expect(r.reasons.map((x) => x.text)).toEqual(expect.arrayContaining([
      'Last order 75 days ago', 'Revenue down 100% vs the previous 30 days', 'Seller last signed in 40 days ago',
      'Only 10 active products', '60% of products out of stock', 'Refunds are 12% of revenue (90 days)',
    ]));
    const lost = r.reasons.reduce((s, x) => s + x.lost, 0);
    expect(r.score + lost).toBe(100); // every lost point is explained
  });

  it('gives a brand-new store half the sales points while it finds its first customer', () => {
    const fresh = { ...thriving, storeCreatedAt: ago(10), lastOrderAt: null, revenueLast30: 0, revenuePrev30: 0, refundRatePercent90: null };
    expect(scoreMerchant(fresh, NOW).parts.sales.points).toBe(15);
    const old = { ...fresh, storeCreatedAt: ago(120) };
    expect(scoreMerchant(old, NOW).parts.sales.points).toBe(0);
    expect(scoreMerchant(old, NOW).reasons[0].text).toBe('No orders since the store opened 120 days ago');
  });

  it('scores billing states', () => {
    const billing = (subscription: HealthInput['subscription']) => scoreMerchant({ ...thriving, subscription }, NOW).parts.billing.points;
    expect(billing({ status: 'active', amountUSD: 49, cancelAtPeriodEnd: true })).toBe(5);
    expect(billing({ status: 'active', amountUSD: 0 })).toBe(15);
    expect(billing({ status: 'trialing', amountUSD: 0, trialEndsAt: new Date(NOW + 2 * 86_400_000) })).toBe(8);
    expect(billing({ status: 'trialing', amountUSD: 0, trialEndsAt: new Date(NOW + 10 * 86_400_000) })).toBe(15);
    expect(billing({ status: 'trialing', amountUSD: 49, platformPlanId: 'p' })).toBe(22);
    expect(billing({ status: 'locked', amountUSD: 49 })).toBe(0);
    expect(billing(null)).toBe(10);
  });

  it('only counts MRR for active / past-due plans', () => {
    expect(scoreMerchant({ ...thriving, subscription: { status: 'locked', amountUSD: 49 } }, NOW).mrr).toBe(0);
    expect(scoreMerchant({ ...thriving, subscription: { status: 'trialing', amountUSD: 49 } }, NOW).mrr).toBe(0);
  });

  it('bands', () => {
    expect([bandOf(70), bandOf(69), bandOf(40), bandOf(39)]).toEqual(['healthy', 'attention', 'attention', 'at_risk']);
  });
});
