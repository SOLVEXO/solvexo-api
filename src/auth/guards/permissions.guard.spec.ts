import { ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';

const ID = '507f1f77bcf86cd799439011';
const doc = (v: any) => ({ findById: () => ({ select: () => ({ lean: async () => v }) }) });

function setup(required: string[], docs: Record<string, any> = {}) {
  const reflector: any = { getAllAndOverride: jest.fn((key: any) => (key === REQUIRE_PERMISSION_KEY ? required : false)) };
  const db: any = {
    repositories: {
      ratingModel: doc(docs.review), promotionRequestModel: doc(docs.promotion), categoryModel: doc(docs.category),
      productModel: doc(docs.product),
    },
  };
  const guard = new PermissionsGuard(reflector, db);
  const run = (user: any, params: Record<string, string>, routePath: string) =>
    guard.canActivate({
      getHandler: () => null, getClass: () => null,
      switchToHttp: () => ({ getRequest: () => ({ user, params, query: {}, body: {}, route: { path: routePath }, path: routePath }) }),
    } as any);
  return { run };
}

const staff = (permissions: string[]) => ({ role: 'staff', userId: 'st1', sellerId: 'own', storeId: 'S1', permissions });

describe('PermissionsGuard — permission + store pinning for the newer staff routes', () => {
  it('owner and admin always pass', async () => {
    const { run } = setup(['reviews.manage']);
    await expect(run({ role: 'seller', userId: 'own' }, { reviewId: ID }, '/api/rating/reply/:reviewId')).resolves.toBe(true);
  });

  it('staff without the permission is refused, with it is allowed', async () => {
    const { run } = setup(['reviews.manage'], { review: { storeId: 'S1' } });
    await expect(run(staff(['orders.view']), { reviewId: ID }, '/api/rating/reply/:reviewId')).rejects.toThrow(/doesn't have permission/);
    await expect(run(staff(['reviews.manage']), { reviewId: ID }, '/api/rating/reply/:reviewId')).resolves.toBe(true);
  });

  it('staff cannot touch a review, promotion or category that belongs to ANOTHER store of the same owner', async () => {
    const other = setup(['reviews.manage'], { review: { storeId: 'S2' } });
    await expect(other.run(staff(['reviews.manage']), { reviewId: ID }, '/api/rating/reply/:reviewId')).rejects.toBeInstanceOf(ForbiddenException);

    const promo = setup(['marketing.manage'], { promotion: { storeId: 'S2' } });
    await expect(promo.run(staff(['marketing.manage']), { id: ID }, '/api/promotions/:id/cancel')).rejects.toBeInstanceOf(ForbiddenException);

    const cat = setup(['categories.manage'], { category: { storeId: 'S2' } });
    await expect(cat.run(staff(['categories.manage']), { id: ID }, '/api/categories/category/:id')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("staff can never edit the platform's own category tree (a category with no store)", async () => {
    const { run } = setup(['categories.manage'], { category: { storeId: null } });
    await expect(run(staff(['categories.manage']), { id: ID }, '/api/categories/category/:id')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('staff can act on their own store resources', async () => {
    const { run } = setup(['categories.manage'], { category: { storeId: 'S1' } });
    await expect(run(staff(['categories.manage']), { id: ID }, '/api/categories/category/:id')).resolves.toBe(true);
  });

  it('a :storeId of another store is refused outright', async () => {
    const { run } = setup(['collections.manage']);
    await expect(run(staff(['collections.manage']), { storeId: 'S2' }, '/api/collections/:storeId')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run(staff(['collections.manage']), { storeId: 'S1' }, '/api/collections/:storeId')).resolves.toBe(true);
  });
});
