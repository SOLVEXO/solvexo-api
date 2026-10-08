import { StoreService } from './store.service';

/**
 * The category id picked in a storefront section / nav link / query string can be a
 * store MAIN category (`Product.categoryId`) or a SUBCATEGORY (`Product.subCategoryId`).
 * The public product listing must match both, otherwise a section filtered to a main
 * category shows "Nothing here yet".
 */
function make() {
  const countDocuments = jest.fn().mockRejectedValue(new Error('stop-after-filter'));
  const db: any = {
    repositories: {
      storeModel: { findOne: jest.fn(() => ({ lean: async () => ({ _id: 's1', status: 'active' }) })) },
      productModel: { countDocuments },
      productVariantModel: {},
    },
  };
  const svc: any = Object.create(StoreService.prototype);
  svc.databaseService = db;
  return { svc, countDocuments };
}

describe('StoreService.getPublicStoreProducts — category filter', () => {
  it('matches the id against both categoryId and subCategoryId', async () => {
    const { svc, countDocuments } = make();
    await expect(svc.getPublicStoreProducts('s1', { categoryId: 'cat1' })).rejects.toThrow('stop-after-filter');
    const filter = countDocuments.mock.calls[0][0];
    expect(filter.$or).toEqual([{ categoryId: 'cat1' }, { subCategoryId: 'cat1' }]);
    expect(filter.storeId).toBe('s1');
  });

  it('adds no category clause for "all" or when omitted', async () => {
    for (const query of [{ categoryId: 'all' }, {}]) {
      const { svc, countDocuments } = make();
      await expect(svc.getPublicStoreProducts('s1', query)).rejects.toThrow('stop-after-filter');
      expect(countDocuments.mock.calls[0][0].$or).toBeUndefined();
    }
  });
});
