/* eslint-disable prettier/prettier */
import { importCollectionsCsv } from './collections-bulk-import';

function setup(opts: { existingNames?: string[] } = {}) {
  const existing = new Set((opts.existingNames ?? []).map((s) => s.toLowerCase()));
  const created: any[] = [];
  const findCalls: any[] = [];
  const deps: any = {
    collectionModel: {
      findOne: jest.fn(async (q: any) => {
        const re: RegExp | undefined = q.$or?.[0]?.name;
        for (const n of existing) if (re && re.test(n)) return { _id: 'x' };
        return null;
      }),
    },
    productVariantModel: {
      find: jest.fn((q: any) => ({
        select: () => ({
          lean: async () =>
            q.sku.$in.filter((s: string) => s.startsWith('OK') || s.startsWith('OTHER')).map((s: string) => ({ sku: s, productId: s.startsWith('OTHER') ? 'pOther' : 'p' + s })),
        }),
      })),
    },
    productModel: {
      find: jest.fn((q: any) => {
        findCalls.push(q);
        return { select: () => ({ lean: async () => q._id.$in.filter((id: string) => id !== 'pOther').map((id: string) => ({ _id: id })) }) };
      }),
    },
    collectionsService: {
      create: jest.fn(async (storeId: string, sellerId: string, dto: any) => {
        existing.add(dto.name.toLowerCase());
        created.push({ storeId, sellerId, dto });
        return { data: {} };
      }),
    },
  };
  return { deps, created, findCalls };
}

describe('collections bulk import', () => {
  it('creates a manual collection with product ids resolved from SKUs, scoped to the store', async () => {
    const { deps, created, findCalls } = setup();
    const res = await importCollectionsCsv(deps, 'seller1', 'store1', 'Title,Status,Product SKUs\nSale,active,OK1;OK2');
    expect(res.data.created).toBe(1);
    expect(created[0].dto).toMatchObject({ name: 'Sale', type: 'manual', status: 'active', productIds: ['pOK1', 'pOK2'] });
    expect(created[0].storeId).toBe('store1');
    expect(findCalls[0].storeId).toBe('store1');
  });

  it('fails the row naming an unknown SKU or a SKU of another store', async () => {
    const { deps, created } = setup();
    const res = await importCollectionsCsv(deps, 's', 'store1', 'Title,Product SKUs\nA,OK1;NOPE\nB,OTHER1');
    expect(created.length).toBe(0);
    expect(res.data.failed[0].error).toContain('NOPE');
    expect(res.data.failed[1].error).toContain('OTHER1');
  });

  it('skips an existing collection (case-insensitive) and fails a repeated title in the same file', async () => {
    const { deps } = setup({ existingNames: ['Sale'] });
    const res = await importCollectionsCsv(deps, 's', 'store1', 'Title,Product SKUs\nSALE,OK1\nNew,OK1\nnew,OK2');
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
  });

  it('requires SKUs, a valid status and the Title column', async () => {
    const { deps } = setup();
    const res = await importCollectionsCsv(deps, 's', 'store1', 'Title,Status,Product SKUs\nA,active,\nB,bogus,OK1');
    expect(res.data.failed[0].error).toContain('Product SKUs');
    expect(res.data.failed[1].error).toContain('Status');
    await expect(importCollectionsCsv(deps, 's', 'store1', 'Product SKUs\nOK1')).rejects.toThrow('Title');
  });
});
