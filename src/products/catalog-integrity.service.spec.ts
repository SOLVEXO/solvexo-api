import { CatalogIntegrityService } from './catalog-integrity.service';

const chain = (v: unknown) => ({ select: () => ({ limit: () => ({ lean: async () => v }), lean: async () => v }) });

function make(opts: { bulkError?: any; taken?: string[] } = {}) {
  const variants: any[] = [
    { _id: 'v1', productId: 'p1' },
    { _id: 'v2', productId: 'p1' },
    { _id: 'v3', productId: 'p2' },
  ];
  const stored = new Map<string, any>([['v2', { _id: 'v2', sku: 'DUP-1', isDelete: false }]]);
  const updates: any[] = [];
  const bulk: any[] = [];
  const model: any = {
    find: (q: any) => {
      const skip: string[] = q?.$and?.[1]?._id?.$nin ?? [];
      return chain(variants.filter((v) => !skip.includes(String(v._id)) && !v.done));
    },
    bulkWrite: async (ops: any[]) => {
      bulk.push(ops);
      if (opts.bulkError) throw opts.bulkError;
    },
    findById: (id: string) => chain(stored.get(id) ?? null),
    exists: async (q: any) => ((opts.taken ?? []).includes(q.sku) ? { _id: 'x' } : null),
    updateOne: async (f: any, u: any) => { updates.push([f, u]); variants.forEach((v) => { if (v._id === f._id) v.done = true; }); },
  };
  const products: any = { find: () => chain([{ _id: 'p1', storeId: 's1' }, { _id: 'p2', storeId: 's1' }]) };
  const db: any = { repositories: { productVariantModel: model, productModel: products } };
  return { svc: new CatalogIntegrityService(db, {} as any), updates, bulk };
}

describe('CatalogIntegrityService.backfillVariantStoreIds', () => {
  it('fills storeId for every variant when nothing collides', async () => {
    const { svc, bulk } = make();
    const n = await svc.backfillVariantStoreIds();
    expect(n).toBe(3);
    expect(bulk[0]).toHaveLength(3);
  });

  it('a duplicate-key error on one variant no longer aborts: that variant gets storeId + a -D1 SKU', async () => {
    const err: any = Object.assign(new Error('E11000'), { code: 11000, writeErrors: [{ index: 1, code: 11000 }] });
    const { svc, updates } = make({ bulkError: err });
    const n = await svc.backfillVariantStoreIds();
    expect(n).toBe(3);
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toEqual({ _id: 'v2' });
    expect(updates[0][1]).toEqual({ $set: { storeId: 's1', sku: 'DUP-1-D1' } });
  });

  it('skips a suffix that is already taken in the store', async () => {
    const err: any = Object.assign(new Error('E11000'), { code: 11000, writeErrors: [{ index: 1, code: 11000 }] });
    const { svc, updates } = make({ bulkError: err, taken: ['DUP-1-D1'] });
    await svc.backfillVariantStoreIds();
    expect(updates[0][1]).toEqual({ $set: { storeId: 's1', sku: 'DUP-1-D2' } });
  });

  it('still throws for an error that is not a duplicate key', async () => {
    const { svc } = make({ bulkError: Object.assign(new Error('boom'), { code: 5 }) });
    let thrown = false;
    try { await svc.backfillVariantStoreIds(); } catch { thrown = true; }
    expect(thrown).toBe(true);
  });
});
