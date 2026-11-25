/* eslint-disable prettier/prettier */
import mongoose from 'mongoose';
import { AdminUsersService } from './admin-users.service';

/** Mongoose casts `_id: { $in }` before it queries: one non-id value throws a CastError (a 500 on Clients Manage). */
const castingFind = (model: mongoose.Model<any>, rows: any[]) => jest.fn((filter: any) => {
  model.find(filter).cast(); // throws like the real query would
  return { sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }), lean: async () => rows }), lean: async () => rows };
});

describe('AdminUsersService.list', () => {
  const Cat = mongoose.model('ProbeCategory', new mongoose.Schema({ name: String }));
  const Seller = mongoose.model('ProbeSeller', new mongoose.Schema({ name: String }));
  const sellerId = new mongoose.Types.ObjectId();
  const goodCat = new mongoose.Types.ObjectId();

  const build = (stores: any[]) => {
    const r: any = {
      sellerModel: { find: castingFind(Seller, [{ _id: sellerId, name: 'Ali', email: 'a@x.pk', status: 'active' }]), countDocuments: jest.fn(async () => 1) },
      storeModel: { find: jest.fn(() => ({ sort: () => ({ lean: async () => stores }) })), distinct: jest.fn(async () => [String(sellerId), 'legacy-seller', '']) },
      categoryModel: { find: castingFind(Cat, [{ _id: goodCat, name: 'Fashion' }]) },
    };
    return { svc: new AdminUsersService({ repositories: r } as any, {} as any), r };
  };

  it('a store saved with a category slug or blank does not break the page', async () => {
    const { svc, r } = build([
      { sellerId: String(sellerId), categoryId: 'fashion', createdAt: new Date(1) },
      { sellerId: String(sellerId), categoryId: '', createdAt: new Date(2) },
      { sellerId: String(sellerId), categoryId: String(goodCat), createdAt: new Date(3) },
    ]);
    const res: any = await svc.list({ page: 1, limit: 20 } as any);
    expect(res.data.items).toHaveLength(1);
    expect(res.data.items[0]).toMatchObject({ storeCount: 3, sells: 'Fashion' });
    expect(r.categoryModel.find.mock.calls[0][0]).toEqual({ _id: { $in: [String(goodCat)] } });
  });

  it('a filter over stores with a non-id sellerId still works', async () => {
    const { svc } = build([{ sellerId: String(sellerId), categoryId: null, createdAt: new Date() }]);
    const res: any = await svc.list({ page: 1, limit: 20, risk: 'high' } as any);
    expect(res.data.total).toBe(1);
  });
});
