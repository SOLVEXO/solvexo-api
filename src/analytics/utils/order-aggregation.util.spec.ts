/* eslint-disable prettier/prettier */
import {
  allTimeCustomerAggregate,
  aggregateProductSales,
  deriveSellerSalesStatus,
  periodTotals,
  toUSDValue,
} from './order-aggregation.util';

describe('toUSDValue — Phase 0 currency normalization', () => {
  it('converts a native-currency amount to USD using ratePerUSD (units of currency per 1 USD)', () => {
    // 28,000 PKR at a rate of 280 PKR per USD = $100.
    expect(toUSDValue(28000, 280)).toBe(100);
  });

  it('is a no-op for an already-USD order (ratePerUSD: 1)', () => {
    expect(toUSDValue(42.5, 1)).toBe(42.5);
  });

  it('returns null (never 0, never a guess) when ratePerUSD is null — a genuine historical gap', () => {
    expect(toUSDValue(5000, null)).toBeNull();
  });

  it('returns null when ratePerUSD is undefined (field never set)', () => {
    expect(toUSDValue(5000, undefined)).toBeNull();
  });

  it('treats a zero ratePerUSD as unconvertible rather than dividing by zero', () => {
    expect(toUSDValue(5000, 0)).toBeNull();
  });

  it('treats a negative ratePerUSD (corrupt data) as unconvertible rather than returning a negative amount', () => {
    expect(toUSDValue(5000, -280)).toBeNull();
  });

  it('handles a zero amount without treating it as unconvertible', () => {
    expect(toUSDValue(0, 280)).toBe(0);
  });
});

describe('periodTotals — USD-normalized aggregation result shape', () => {
  it('subtracts USD-normalized refunds from USD-normalized gross to produce net, and passes through the unconvertible count', async () => {
    const orderModel = {
      aggregate: jest.fn().mockResolvedValue([
        {
          orderCount: 3, cancelledCount: 0, refundedCount: 1,
          grossRevenue: 300, refundAmount: 50, // already USD-summed by the (mocked) pipeline
          unconvertibleOrderCount: 2,
          buyerIds: ['u1', 'u2'],
        },
      ]),
    };

    const result = await periodTotals(orderModel as any, new Date('2026-01-01'), new Date('2026-01-31'));

    expect(result.grossRevenue).toBe(300);
    expect(result.refundAmount).toBe(50);
    expect(result.netRevenue).toBe(250);
    expect(result.unconvertibleOrderCount).toBe(2);
    expect(result.uniqueBuyerCount).toBe(2);
  });

  it('defaults every figure to 0 (including unconvertibleOrderCount) for a window with no orders at all', async () => {
    const orderModel = { aggregate: jest.fn().mockResolvedValue([]) };
    const result = await periodTotals(orderModel as any, new Date('2026-01-01'), new Date('2026-01-31'));

    expect(result.grossRevenue).toBe(0);
    expect(result.netRevenue).toBe(0);
    expect(result.unconvertibleOrderCount).toBe(0);
  });
});

describe('aggregateProductSales — USD-normalized per-product totals', () => {
  it('computes net revenue per product from USD-normalized gross/refunded sums', async () => {
    const orderModel = {
      aggregate: jest.fn().mockResolvedValue([
        { _id: 'p1', name: 'Widget', orderCount: 2, unitsSold: 5, grossRevenue: 100, refundedAmount: 10 },
      ]),
    };
    const rows = await aggregateProductSales(orderModel as any, new Date('2026-01-01'), new Date('2026-01-31'));
    expect(rows[0].netRevenue).toBe(90);
  });
});

describe('deriveSellerSalesStatus — Phase 3 deterministic seller status', () => {
  const NOW = new Date('2026-06-01T00:00:00Z');

  it('classifies a brand-new seller with no orders yet as "new"', () => {
    const registeredAt = new Date('2026-05-20T00:00:00Z'); // 12 days ago
    expect(deriveSellerSalesStatus(registeredAt, null, NOW)).toBe('new');
  });

  it('classifies an established seller with zero orders ever as "dormant", never "new"', () => {
    const registeredAt = new Date('2025-01-01T00:00:00Z'); // long ago
    expect(deriveSellerSalesStatus(registeredAt, null, NOW)).toBe('dormant');
  });

  it('classifies a seller with an order in the last 30 days as "active"', () => {
    const registeredAt = new Date('2025-01-01T00:00:00Z');
    const lastOrderAt = new Date('2026-05-15T00:00:00Z'); // 17 days ago
    expect(deriveSellerSalesStatus(registeredAt, lastOrderAt, NOW)).toBe('active');
  });

  it('classifies a seller whose last order was 31-90 days ago as "at_risk"', () => {
    const registeredAt = new Date('2025-01-01T00:00:00Z');
    const lastOrderAt = new Date('2026-03-15T00:00:00Z'); // ~78 days ago
    expect(deriveSellerSalesStatus(registeredAt, lastOrderAt, NOW)).toBe('at_risk');
  });

  it('classifies a seller whose last order was over 90 days ago as "dormant"', () => {
    const registeredAt = new Date('2025-01-01T00:00:00Z');
    const lastOrderAt = new Date('2026-01-01T00:00:00Z'); // ~151 days ago
    expect(deriveSellerSalesStatus(registeredAt, lastOrderAt, NOW)).toBe('dormant');
  });

  it('is a pure function of real dates only — same inputs always produce the same status, nothing random', () => {
    const registeredAt = new Date('2025-01-01T00:00:00Z');
    const lastOrderAt = new Date('2026-05-15T00:00:00Z');
    const a = deriveSellerSalesStatus(registeredAt, lastOrderAt, NOW);
    const b = deriveSellerSalesStatus(registeredAt, lastOrderAt, NOW);
    expect(a).toBe(b);
  });
});

describe('allTimeCustomerAggregate — USD-normalized lifetime value', () => {
  it('computes LTV as USD-normalized gross minus USD-normalized refunds', async () => {
    const orderModel = {
      aggregate: jest.fn().mockResolvedValue([
        { _id: 'u1', firstOrderAt: new Date('2026-01-01'), lastOrderAt: new Date('2026-03-01'), totalOrders: 3, grossRevenue: 300, refundAmount: 20 },
      ]),
    };
    const rows = await allTimeCustomerAggregate(orderModel as any);
    expect(rows[0].lifetimeValue).toBe(280);
  });
});
