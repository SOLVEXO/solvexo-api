/* eslint-disable prettier/prettier */
import { importProductsCsv, PRODUCT_IMPORT_COLUMNS } from './product-bulk-import';

const chain = (rows: any) => {
  const c: any = {};
  c.select = () => c;
  c.lean = async () => rows;
  c.then = (res: any, rej: any) => Promise.resolve(rows).then(res, rej);
  return c;
};

function setup(opts: { products?: any[]; variants?: any[]; categories?: any[]; storeCategoryId?: string | null } = {}) {
  const products = opts.products ?? [];
  const variants = opts.variants ?? [];
  const calls: any = { add: [] as any[], edit: [] as any[], updVariant: [] as any[] };
  let seq = 0;
  const deps: any = {
    repos: {
      storeModel: { findOne: async (q: any) => (q._id === 'S1' && q.sellerId === 'SEL' ? { _id: 'S1', categoryId: opts.storeCategoryId ?? null } : null) },
      categoryModel: { find: () => chain(opts.categories ?? [{ _id: 'C1', name: 'Clothing' }]) },
      productModel: {
        find: () => chain(products),
        findOne: (q: any) => chain(products.find((p) => String(p._id) === q._id && q.storeId === 'S1') ?? null),
      },
      productVariantModel: {
        find: () => chain(variants),
        findOne: (q: any) => chain(variants.find((v) => String(v._id) === q._id) ?? null),
      },
    },
    addPhysicalProduct: async (s: string, body: any) => {
      calls.add.push(body);
      seq++;
      return { data: { product: { _id: 'NP' + seq }, defaultVariant: { _id: 'NV' + seq } } };
    },
    editProduct: async (s: string, body: any) => { calls.edit.push(body); return {}; },
    updateVariant: async (s: string, p: string, v: string, dto: any) => { calls.updVariant.push({ p, v, dto }); return {}; },
  };
  return { deps, calls };
}

const HEADER = 'Name,Price,Description,SKU,Compare-at Price,Stock,Weight,Tags,Status,Category';
const run = (deps: any, rows: string[], storeId = 'S1') =>
  importProductsCsv(deps, 'SEL', storeId, [HEADER, ...rows].join('\n'));

describe('product bulk import', () => {
  it('creates valid rows and reports invalid ones with the column in the message', async () => {
    const { deps, calls } = setup();
    const res = await run(deps, ['Tee,10,,TEE-1,,5,,a;b,active,clothing', 'Bad,abc,,,,,,,,', ',5,,,,,,,,', 'Mug,5,,,,,,,,Nope']);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(3);
    expect(calls.add[0]).toMatchObject({ storeId: 'S1', name: 'Tee', categoryId: 'C1', status: 'active', tags: ['a', 'b'] });
    expect(calls.add[0].variants[0]).toMatchObject({ price: 10, sku: 'TEE-1', stock: 5 });
    const errors = res.data.failed.map((f: any) => f.error).join(' | ');
    expect(errors).toContain('Price');
    expect(errors).toContain('Name is required');
    expect(errors).toContain('Category "Nope" not found');
  });

  it('existing SKU (case-insensitive) updates non-blank cells only and never creates', async () => {
    const { deps, calls } = setup({
      products: [{ _id: 'P1', type: 'physical', name: 'Tee', description: 'old', status: 'draft', tags: [], categoryId: 'C1' }],
      variants: [{ _id: 'V1', productId: 'P1', sku: 'TEE-1', price: 10, compareAtPrice: null }],
    });
    const res = await run(deps, ['Tee,12,,tee-1,,999,,,active,']);
    expect(res.data).toMatchObject({ created: 0, updated: 1, failedCount: 0 });
    expect(calls.add.length).toBe(0);
    expect(calls.edit[0]).toEqual({ productId: 'P1', status: 'active' });
    expect(calls.updVariant[0]).toMatchObject({ p: 'P1', v: 'V1', dto: { price: 12 } });
  });

  it('existing SKU with nothing different is skipped', async () => {
    const { deps, calls } = setup({
      products: [{ _id: 'P1', type: 'physical', name: 'Tee', description: 'd', status: 'draft', tags: [], categoryId: 'C1' }],
      variants: [{ _id: 'V1', productId: 'P1', sku: 'TEE-1', price: 10, compareAtPrice: null }],
    });
    const res = await run(deps, ['Tee,10,,TEE-1,,,,,,']);
    expect(res.data).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(calls.edit.length + calls.updVariant.length).toBe(0);
  });

  it('a repeated SKU or repeated Name with blank SKU inside the file fails the later row', async () => {
    const { deps, calls } = setup();
    const res = await run(deps, ['A,1,,X-1,,,,,,', 'B,2,,x-1,,,,,,', 'Same,1,,,,,,,,', 'same,2,,,,,,,,']);
    expect(res.data.created).toBe(2);
    expect(res.data.failedCount).toBe(2);
    expect(res.data.failed[0].error).toContain('Duplicate of row 2');
    expect(calls.add.length).toBe(2);
  });

  it('a SKU belonging to ANOTHER store is not visible (store scoping) so the row creates a new product', async () => {
    // product list is store-scoped by the query; other-store variants never appear here
    const { deps, calls } = setup({ products: [], variants: [] });
    const res = await run(deps, ['Tee,10,,OTHER-STORE-SKU,,,,,,']);
    expect(res.data.created).toBe(1);
    expect(calls.updVariant.length).toBe(0);
  });

  it('rejects a store the seller does not own', async () => {
    const { deps } = setup();
    await expect(run(deps, ['Tee,10,,,,,,,,'], 'OTHER')).rejects.toThrow();
  });

  it('requires the Name and Price columns in the header', async () => {
    const { deps } = setup();
    await expect(importProductsCsv(deps, 'SEL', 'S1', 'SKU,Stock\nA,1')).rejects.toThrow(/missing required column/);
    expect(PRODUCT_IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.key)).toEqual(['Name', 'Price']);
  });

  it('surfaces plan-limit errors thrown by addPhysicalProduct per row', async () => {
    const { deps } = setup();
    deps.addPhysicalProduct = async () => { throw new Error('Product limit reached (1) for your current plan'); };
    const res = await run(deps, ['A,1,,,,,,,,']);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Product limit reached');
  });
});
