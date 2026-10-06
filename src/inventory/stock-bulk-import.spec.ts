/* eslint-disable prettier/prettier */
import { importStockCsv, STOCK_IMPORT_COLUMNS } from './stock-bulk-import';

const chain = (rows: any) => {
  const c: any = {};
  c.select = () => c;
  c.lean = async () => rows;
  c.then = (res: any, rej: any) => Promise.resolve(rows).then(res, rej);
  return c;
};

function setup() {
  const variants = [
    { _id: 'V1', productId: 'P1', sku: 'A-1', stock: 10, unlimitedStock: false },
    { _id: 'V2', productId: 'P1', sku: 'B-1', stock: 3, unlimitedStock: true },
    { _id: 'V3', productId: 'P1', sku: 'C-1', stock: 4, unlimitedStock: false },
    { _id: 'V4', productId: 'P1', sku: 'c-1', stock: 4, unlimitedStock: false },
  ];
  const calls: any[] = [];
  const deps: any = {
    repos: {
      storeModel: { findOne: async (q: any) => (q._id === 'S1' && q.sellerId === 'SEL' ? { _id: 'S1' } : null) },
      productModel: { find: (q: any) => chain(q.storeId === 'S1' ? [{ _id: 'P1' }] : []) },
      productVariantModel: { find: (q: any) => chain(q.productId.$in.includes('P1') ? variants : []) },
    },
    adjust: async (variantId: string, delta: number, reason: string, note: string) => { calls.push({ variantId, delta, reason, note }); return {}; },
  };
  return { deps, calls };
}

const run = (deps: any, rows: string[], storeId = 'S1') => importStockCsv(deps, 'SEL', storeId, ['SKU,Quantity', ...rows].join('\n'));

describe('stock bulk import', () => {
  it('adjusts to the counted quantity through the adjustment path (delta, correction, note)', async () => {
    const { deps, calls } = setup();
    const res = await run(deps, ['a-1,15']);
    expect(res.data).toMatchObject({ updated: 1, failedCount: 0 });
    expect(calls[0]).toEqual({ variantId: 'V1', delta: 5, reason: 'correction', note: 'Bulk CSV reconciliation' });
  });

  it('unchanged quantity is skipped with "No change"', async () => {
    const { deps, calls } = setup();
    const res = await run(deps, ['A-1,10']);
    expect(res.data.skipped).toBe(1);
    expect(res.data.skippedRows[0].note).toBe('No change');
    expect(calls.length).toBe(0);
  });

  it('reports unknown SKU, unlimited SKU, ambiguous SKU and bad quantities per row', async () => {
    const { deps } = setup();
    const res = await run(deps, ['ZZZ,1', 'B-1,5', 'C-1,5', 'A-1,-2', 'A-1,1.5']);
    const errors = res.data.failed.map((f: any) => f.error);
    expect(res.data.failedCount).toBe(5); // the last A-1 row is a duplicate of the earlier A-1 row
    expect(errors[0]).toContain('No SKU matches');
    expect(errors[1]).toContain('unlimited');
    expect(errors[2]).toContain('more than one variant');
    expect(errors[3]).toContain('Quantity');
    expect(errors[4]).toContain('Duplicate of row 5');
  });

  it('same SKU twice in the file fails the second row', async () => {
    const { deps, calls } = setup();
    const res = await run(deps, ['A-1,11', 'a-1,12']);
    expect(calls.length).toBe(1);
    expect(res.data.failed[0].error).toContain('Duplicate of row 2');
  });

  it('cannot touch another store and enforces required columns', async () => {
    const { deps } = setup();
    await expect(run(deps, ['A-1,1'], 'OTHER')).rejects.toThrow();
    await expect(importStockCsv(deps, 'SEL', 'S1', 'SKU\nA-1')).rejects.toThrow(/missing required column/);
    expect(STOCK_IMPORT_COLUMNS.filter((c) => c.required).map((c) => c.key)).toEqual(['SKU', 'Quantity']);
  });
});
