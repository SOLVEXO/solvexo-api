/* eslint-disable prettier/prettier */
import { aggregateProductViews, viewToPurchaseConversionPercent } from './product-view-aggregation.util';

describe('aggregateProductViews — Phase 6 real view counts', () => {
  it('keys the resulting map by productId with the real summed count', async () => {
    const productViewModel = {
      aggregate: jest.fn().mockResolvedValue([
        { _id: 'p1', views: 42 },
        { _id: 'p2', views: 7 },
      ]),
    };

    const result = await aggregateProductViews(productViewModel as any, new Date('2026-01-01'), new Date('2026-01-31'));

    expect(result.get('p1')).toBe(42);
    expect(result.get('p2')).toBe(7);
  });

  it('adds a storeId filter to the match stage only when scoped to one store', async () => {
    const productViewModel = { aggregate: jest.fn().mockResolvedValue([]) };

    await aggregateProductViews(productViewModel as any, new Date('2026-01-01'), new Date('2026-01-31'), { storeId: 'store-9' });

    const pipeline = productViewModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.storeId).toBe('store-9');
  });

  it('omits storeId/sellerId from the match stage for a platform-wide (unscoped) query', async () => {
    const productViewModel = { aggregate: jest.fn().mockResolvedValue([]) };

    await aggregateProductViews(productViewModel as any, new Date('2026-01-01'), new Date('2026-01-31'));

    const pipeline = productViewModel.aggregate.mock.calls[0][0];
    expect(pipeline[0].$match.storeId).toBeUndefined();
    expect(pipeline[0].$match.sellerId).toBeUndefined();
  });

  it('returns an empty map for a window with no recorded views, rather than throwing', async () => {
    const productViewModel = { aggregate: jest.fn().mockResolvedValue([]) };
    const result = await aggregateProductViews(productViewModel as any, new Date('2026-01-01'), new Date('2026-01-31'));
    expect(result.size).toBe(0);
  });
});

describe('viewToPurchaseConversionPercent — Phase 6, never a fabricated rate', () => {
  it('computes orderCount/views as a rounded percentage', () => {
    expect(viewToPurchaseConversionPercent(5, 100)).toBe(5);
  });

  it('returns null — never 0 — when there are zero tracked views to divide by', () => {
    expect(viewToPurchaseConversionPercent(3, 0)).toBeNull();
  });

  it('returns null for a negative/corrupt view count rather than a nonsense negative rate', () => {
    expect(viewToPurchaseConversionPercent(3, -5)).toBeNull();
  });

  it('does not clamp above 100% — a real repeat-buyer pattern can legitimately exceed it', () => {
    expect(viewToPurchaseConversionPercent(12, 10)).toBe(120);
  });

  it('rounds to 2 decimal places, matching the shared money-rounding convention', () => {
    expect(viewToPurchaseConversionPercent(1, 3)).toBe(33.33);
  });
});
