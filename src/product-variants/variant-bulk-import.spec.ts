/* eslint-disable prettier/prettier */
import { importVariantsCsv, VARIANT_IMPORT_COLUMNS } from './variant-bulk-import';

const chain = (rows: any) => {
  const c: any = {};
  c.select = () => c;
  c.lean = async () => rows;
  return c;
};

function setup() {
  const products = [
    { _id: 'P1', name: 'Tee', type: 'physical' },
    { _id: 'P2', name: 'Dup', type: 'physical' },
    { _id: 'P3', name: 'dup', type: 'physical' },
    { _id: 'P4', name: 'Ebook', type: 'digital' },
  ];
  const variants = [
    { _id: 'V1', productId: 'P1', sku: 'TEE-S', price: 10, compareAtPrice: null },
    { _id: 'V2', productId: 'P2', sku: 'DUP-1', price: 5, compareAtPrice: null },
  ];
  const calls: any = { add: [] as any[], upd: [] as any[] };
  const deps: any = {
    repos: {
      storeModel: { findOne: async (q: any) => (q._id === 'S1' && q.sellerId === 'SEL' ? { _id: 'S1' } : null) },
      productModel: { find: (q: any) => chain(q.storeId === 'S1' ? products : []) },
      productVariantModel: { find: () => chain(variants) },
    },
    addVariant: async (_s: string, productId: string, dto: any) => { calls.add.push({ productId, dto }); return { data: { _id: 'NV' + calls.add.length } }; },
    updateVariant: async (_s: string, p: string, v: string, dto: any) => { calls.upd.push({ p, v, dto }); return {}; },
  };
  return { deps, calls };
}

const HEADER = 'Product SKU,Product Name,Option 1 Name,Option 1 Value,Option 2 Name,Option 2 Value,Option 3 Name,Option 3 Value,SKU,Price,Compare-at Price,Stock,Weight';
const run = (deps: any, rows: string[], storeId = 'S1') => importVariantsCsv(deps, 'SEL', storeId, [HEADER, ...rows].join('\n'));

describe('variant bulk import', () => {
  it('adds a variant to the product found by Product SKU, with options', async () => {
    const { deps, calls } = setup();
    const res = await run(deps, ['tee-s,,Size,M,Color,Red,,,TEE-M-RED,12,15,7,0.4 kg']);
    expect(res.data).toMatchObject({ created: 1, failedCount: 0 });
    expect(calls.add[0].productId).toBe('P1');
    expect(calls.add[0].dto).toMatchObject({ sku: 'TEE-M-RED', price: 12, compareAtPrice: 15, stock: 7, options: [{ name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }] });
  });

  it('falls back to a unique Product Name; ambiguous or unknown names fail', async () => {
    const { deps, calls } = setup();
    const res = await run(deps, [',Tee,Size,L,,,,,TEE-L,12,,,', ',Dup,Size,L,,,,,DUP-L,1,,,', ',Nope,Size,L,,,,,N-L,1,,,']);
    expect(res.data.created).toBe(1);
    expect(calls.add[0].productId).toBe('P1');
    const errors = res.data.failed.map((f: any) => f.error).join(' | ');
    expect(errors).toContain('matches 2 products');
    expect(errors).toContain('not found');
  });

  it('existing variant SKU updates price only; unchanged is skipped; never created', async () => {
    const { deps, calls } = setup();
    const res = await run(deps, ['TEE-S,,,,,,,,TEE-S,11,,,']);
    expect(res.data).toMatchObject({ created: 0, updated: 1 });
    expect(calls.upd[0]).toEqual({ p: 'P1', v: 'V1', dto: { price: 11 } });
    const res2 = await run(deps, [',,,,,,,,tee-s,11,,,']);
    expect(res2.data.updated).toBe(1);
    const res3 = await run(setup().deps, [',,,,,,,,TEE-S,10,,,']);
    expect(res3.data).toMatchObject({ skipped: 1, created: 0 });
    expect(calls.add.length).toBe(0);
  });

  it('SKU already used by a different product fails', async () => {
    const { deps } = setup();
    const res = await run(deps, ['DUP-1,,,,,,,,TEE-S,11,,,']);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('different product');
  });

  it('digital products, half-filled options and bad numbers are reported per row', async () => {
    const { deps } = setup();
    const res = await run(deps, [',Ebook,,,,,,,E-1,1,,,', 'TEE-S,,Size,,,,,,X-1,1,,,', 'TEE-S,,,,,,,,X-2,abc,,,', 'TEE-S,,,,,,,,X-3,1,,2.5,']);
    expect(res.data.failedCount).toBe(4);
    const errors = res.data.failed.map((f: any) => f.error).join(' | ');
    expect(errors).toContain('physical');
    expect(errors).toContain('Option 1 needs both');
    expect(errors).toContain('Price');
    expect(errors).toContain('Stock');
  });

  it('same SKU twice in the file fails the second; other-store access is rejected; required columns enforced', async () => {
    const { deps } = setup();
    const res = await run(deps, ['TEE-S,,Size,A,,,,,N-1,1,,,', 'TEE-S,,Size,B,,,,,n-1,1,,,']);
    expect(res.data.created).toBe(1);
    expect(res.data.failed[0].error).toContain('Duplicate of row 2');
    await expect(run(deps, ['TEE-S,,,,,,,,N-9,1,,,'], 'OTHER')).rejects.toThrow();
    await expect(importVariantsCsv(deps, 'SEL', 'S1', 'Product SKU,Price\nA,1')).rejects.toThrow(/missing required column/);
    expect(VARIANT_IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.key)).toEqual(['Product SKU', 'SKU', 'Price']);
  });
});
