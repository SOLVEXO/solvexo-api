/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import { importMetafieldDefinitionsCsv } from './metafield-definitions-bulk-import';

function setup(seed: any[] = []) {
  const rows: any[] = [...seed];
  const definitionModel = {
    findOne: async (f: any) =>
      rows.find((r) => r.storeId === f.storeId && r.ownerResource === f.ownerResource && r.key === f.key) ?? null,
  };
  const metafieldsService = {
    createDefinition: async (storeId: string, _s: string, dto: any) => { const row = { storeId, ...dto }; rows.push(row); return { data: row }; },
  };
  return { deps: { definitionModel, metafieldsService }, rows };
}
const H = 'Owner Resource,Key,Name,Type,Description,Required,Storefront Access';

describe('metafield definitions bulk import', () => {
  it('creates valid rows with parsed booleans', async () => {
    const { deps, rows } = setup();
    const res = await importMetafieldDefinitionsCsv(deps, 'sel', 's1', [H, 'Product,fabric,Fabric,single_line_text_field,,yes,no'].join('\n'));
    expect(res.data.created).toBe(1);
    expect(rows[0]).toMatchObject({ ownerResource: 'product', key: 'fabric', required: true, storefrontAccess: false });
  });

  it('reports invalid owner, type, key format and booleans', async () => {
    const { deps } = setup();
    const csv = [H, 'shop,k1,N,json,,,', 'product,k2,N,weird,,,', 'product,Bad Key,N,json,,,', 'product,k4,N,json,,maybe,'].join('\n');
    const res = await importMetafieldDefinitionsCsv(deps, 'sel', 's1', csv);
    expect(res.data.failedCount).toBe(4);
    expect(res.data.failed[0].error).toContain('Owner Resource');
    expect(res.data.failed[1].error).toContain('Type');
    expect(res.data.failed[2].error).toContain('key');
    expect(res.data.failed[3].error).toContain('Required');
  });

  it('skips an existing owner+key in this store, fails a repeat in the file, ignores other stores', async () => {
    const { deps, rows } = setup([{ storeId: 's1', ownerResource: 'product', key: 'fabric' }, { storeId: 's2', ownerResource: 'page', key: 'note' }]);
    const csv = [H, 'product,fabric,F,json,,,', 'page,note,N,json,,,', 'page,note,N2,json,,,', 'category,fabric,F,json,,,'].join('\n');
    const res = await importMetafieldDefinitionsCsv(deps, 'sel', 's1', csv);
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(2);
    expect(res.data.failedCount).toBe(1);
    expect(rows.length).toBe(4);
  });

  it('requires the template columns', async () => {
    const { deps } = setup();
    await expect(importMetafieldDefinitionsCsv(deps, 'sel', 's1', 'Key,Name\nx,y')).rejects.toThrow();
  });
});
