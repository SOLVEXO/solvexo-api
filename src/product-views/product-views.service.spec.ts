/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { ProductViewsService } from './product-views.service';
import { DatabaseService } from '@/database/databaseservice';

// Phase 5 — Product Tracking Foundation. This is the tracking infrastructure
// that must exist and be recording real events BEFORE any Products-tab view
// metric (Phase 6) is built on top of it — so its own correctness (real
// server-derived scope, real dedup, never fabricating a view) is tested here
// in isolation, before anything downstream depends on it.

function buildLeanChain(result: any) {
  return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }) };
}

describe('ProductViewsService', () => {
  let service: ProductViewsService;
  let productModel: any;
  let productViewModel: any;
  let db: DatabaseService;

  beforeEach(() => {
    productModel = {
      findOne: jest.fn().mockReturnValue(buildLeanChain({ storeId: 'store-1', sellerId: 'seller-1' })),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    productViewModel = {
      findOne: jest.fn().mockReturnValue(buildLeanChain(null)), // no recent view by default
      create: jest.fn().mockResolvedValue({}),
    };
    db = { repositories: { productModel, productViewModel } } as any;
    service = new ProductViewsService(db);
  });

  it('rejects a call with no productId', async () => {
    await expect(service.recordView('', { userId: 'u1' })).rejects.toThrow(BadRequestException);
  });

  it('rejects a call with neither a userId nor an anonId — there is no "Guest" identity here', async () => {
    await expect(service.recordView('p1', {})).rejects.toThrow(BadRequestException);
  });

  it('reports success without recording when the product is unknown/deleted (fire-and-forget beacon, never errors the page)', async () => {
    productModel.findOne.mockReturnValue(buildLeanChain(null));
    const result = await service.recordView('p1', { userId: 'u1' });
    expect(result).toEqual({ success: true, recorded: false });
    expect(productViewModel.create).not.toHaveBeenCalled();
  });

  it('derives storeId/sellerId from the Product document itself, never from client input', async () => {
    await service.recordView('p1', { userId: 'u1' });

    expect(productViewModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 'store-1', sellerId: 'seller-1', productId: 'p1', userId: 'u1', anonId: null }),
    );
  });

  it('increments Product.viewCount and sets lastViewedAt on a genuinely new view', async () => {
    await service.recordView('p1', { userId: 'u1' });

    expect(productModel.updateOne).toHaveBeenCalledWith(
      { _id: 'p1' },
      { $inc: { viewCount: 1 }, $set: { lastViewedAt: expect.any(Date) } },
    );
  });

  it('does not record a second view — or double-increment viewCount — from the same userId inside the dedup window', async () => {
    productViewModel.findOne.mockReturnValue(buildLeanChain({ _id: 'existing-view' }));

    const result = await service.recordView('p1', { userId: 'u1' });

    expect(result).toEqual({ success: true, recorded: false });
    expect(productViewModel.create).not.toHaveBeenCalled();
    expect(productModel.updateOne).not.toHaveBeenCalled();
  });

  it('dedups an anonymous visitor by anonId, not userId, when no userId is present', async () => {
    await service.recordView('p1', { anonId: 'anon-abc' });

    const dedupQuery = productViewModel.findOne.mock.calls[0][0];
    expect(dedupQuery.anonId).toBe('anon-abc');
    expect(dedupQuery.userId).toBeUndefined();
    expect(productViewModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, anonId: 'anon-abc' }),
    );
  });

  it('prefers a logged-in userId over anonId when both are somehow present (never double-identity)', async () => {
    await service.recordView('p1', { userId: 'u1', anonId: 'anon-abc' });

    expect(productViewModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', anonId: null }),
    );
  });
});
