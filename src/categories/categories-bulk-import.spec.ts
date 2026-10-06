/* eslint-disable prettier/prettier */
import { importCategoriesCsv, CATEGORY_IMPORT_COLUMNS } from './categories-bulk-import';
import { buildTemplatePayload } from '../common/bulk-import/bulk-import.util';

function setup(seed: any[] = []) {
  const rows: any[] = seed.map((r, i) => ({ _id: `seed${i}`, isDelete: false, status: 'active', ...r }));
  let n = 0;
  const matchName = (f: any, r: any) => (f.name instanceof RegExp ? f.name.test(r.name) : true);
  const categoryModel = {
    findOne: async (f: any) =>
      rows.find(
        (r) =>
          r.storeId === f.storeId &&
          matchName(f, r) &&
          (f.parentId === undefined || (r.parentId ?? null) === f.parentId) &&
          (f.status === undefined || r.status === f.status) &&
          r.isDelete === f.isDelete,
      ) ?? null,
  };
  const created: any[] = [];
  const categoriesService = {
    addCategory: async (_u: string, _role: string, dto: any) => {
      const row = { _id: `new${n++}`, isDelete: false, status: 'active', parentId: dto.parentId ?? null, ...dto };
      rows.push(row);
      created.push(row);
      return { data: row };
    },
    updateCategory: async (_u: string, _s: string, id: string, dto: any) => {
      const r = rows.find((x) => x._id === id);
      if (dto.isActive === false) r.status = 'inactive';
      return { data: r };
    },
  };
  return { deps: { categoryModel, categoriesService }, created, rows };
}

const H = 'Name,Parent,Description,Image URL,Status';

describe('categories bulk import', () => {
  it('creates valid rows (parent first, then child) and reports bad ones', async () => {
    const { deps, created } = setup();
    const csv = [H, 'Shoes,,,,', 'Boots,Shoes,,,inactive', ',,,,', 'Bad,Nope,,,'].join('\n');
    const res = await importCategoriesCsv(deps, 'u1', 's1', csv);
    expect(res.data.created).toBe(2);
    expect(created[1].parentId).toBe('new0');
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Parent');
  });

  it('skips an existing category (case-insensitive) and fails a repeat in the file', async () => {
    const { deps, created } = setup([{ storeId: 's1', name: 'Shoes', parentId: null }]);
    const res = await importCategoriesCsv(deps, 'u1', 's1', [H, 'shoes,,,,', 'Hats,,,,', 'HATS,,,,'].join('\n'));
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(created.length).toBe(1);
  });

  it('does not see another store parent and enforces one-level depth', async () => {
    const { deps } = setup([
      { storeId: 's2', name: 'Other', parentId: null },
      { storeId: 's1', name: 'Main', parentId: null },
      { storeId: 's1', name: 'Sub', parentId: 'seed1' },
    ]);
    const res = await importCategoriesCsv(deps, 'u1', 's1', [H, 'X,Other,,,', 'Y,Sub,,,'].join('\n'));
    expect(res.data.failedCount).toBe(2);
  });

  it('validates status, image url and the required column', async () => {
    const { deps } = setup();
    const res = await importCategoriesCsv(deps, 'u1', 's1', [H, 'A,,,notaurl,', 'B,,,,maybe'].join('\n'));
    expect(res.data.failed[0].error).toContain('Image URL');
    expect(res.data.failed[1].error).toContain('Status');
    await expect(importCategoriesCsv(deps, 'u1', 's1', 'Parent\nX')).rejects.toThrow();
  });

  it('template has all columns', () => {
    expect(buildTemplatePayload('t.csv', CATEGORY_IMPORT_COLUMNS).data.csv).toContain('Name,Parent');
  });
});
