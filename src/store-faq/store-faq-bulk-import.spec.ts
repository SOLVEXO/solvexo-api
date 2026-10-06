/* eslint-disable prettier/prettier */
import { importStoreFaqsCsv } from './store-faq-bulk-import';

function setup(seed: any[] = []) {
  const rows: any[] = [...seed];
  const storeFaqModel = {
    findOne: async (f: any) => rows.find((r) => r.storeId === f.storeId && f.question.test(r.question)) ?? null,
  };
  const storeFaqService = {
    create: async (storeId: string, _s: string, dto: any) => { const row = { storeId, ...dto }; rows.push(row); return { data: row }; },
  };
  return { deps: { storeFaqModel, storeFaqService }, rows };
}
const H = 'Question,Answer,Order,Status';

describe('store faq bulk import', () => {
  it('creates valid rows and reports invalid ones', async () => {
    const { deps, rows } = setup();
    const res = await importStoreFaqsCsv(deps, 'sel', 's1', [H, 'Q one?,A1,2,inactive', 'Q two?,,0,', 'Q three?,A3,-1,', 'Q four?,A4,,maybe'].join('\n'));
    expect(res.data.created).toBe(1);
    expect(rows[0]).toMatchObject({ question: 'Q one?', order: 2, isActive: false });
    expect(res.data.failedCount).toBe(3);
    expect(res.data.failed[0].error).toContain('Answer');
    expect(res.data.failed[1].error).toContain('Order');
    expect(res.data.failed[2].error).toContain('Status');
  });

  it('skips existing question (case/space-insensitive) and fails repeats in file; scoped to store', async () => {
    const { deps, rows } = setup([{ storeId: 's1', question: 'Do you ship?' }, { storeId: 's2', question: 'Other?' }]);
    const res = await importStoreFaqsCsv(deps, 'sel', 's1', [H, 'do  you SHIP?,x,,', 'Other?,y,,', 'other?,z,,'].join('\n'));
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(rows.length).toBe(3);
  });

  it('requires the Question and Answer columns', async () => {
    const { deps } = setup();
    await expect(importStoreFaqsCsv(deps, 'sel', 's1', 'Question\nX')).rejects.toThrow();
  });
});
