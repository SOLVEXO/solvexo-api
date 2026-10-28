import { fulfilStockForSellerOrders } from './fulfil-stock.util';

describe('fulfilStockForSellerOrders', () => {
  it('sends its aggregation-pipeline update with updatePipeline (Mongoose 9 rejects it otherwise: Mark as paid returned 500)', async () => {
    const calls: any[] = [];
    const model: any = { updateOne: async (...a: any[]) => { calls.push(a); } };
    await fulfilStockForSellerOrders(model, [{ status: 'pending', items: [{ type: 'physical', variantId: 'v1', quantity: 2 }] }]);
    expect(calls).toHaveLength(1);
    expect(Array.isArray(calls[0][1])).toBe(true);
    expect(calls[0][2]).toEqual({ updatePipeline: true });
  });

  it('skips orders that are already fulfilled or cancelled', async () => {
    const calls: any[] = [];
    const model: any = { updateOne: async (...a: any[]) => { calls.push(a); } };
    await fulfilStockForSellerOrders(model, [{ status: 'cancelled', items: [{ type: 'physical', variantId: 'v1', quantity: 1 }] }]);
    expect(calls).toHaveLength(0);
  });
});
