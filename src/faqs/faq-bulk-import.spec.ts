/* eslint-disable prettier/prettier */
import { importFaqsCsv, FAQ_IMPORT_COLUMNS } from './faq-bulk-import';

function setup(existing: string[] = []) {
  const created: any[] = [];
  return {
    created,
    deps: {
      listQuestions: async () => existing,
      create: async (dto: any) => { created.push(dto); },
    },
  };
}

const HEADER = 'Question,Answer,Category,Order,Active';

describe('faq bulk import', () => {
  it('creates valid rows and reports invalid ones with the column name', async () => {
    const s = setup();
    const csv = [HEADER, 'Q1?,A1,billing,2,yes', 'Q2?,,,,', 'Q3?,A3,,abc,', 'Q4?,A4,,,maybe'].join('\n');
    const res = await importFaqsCsv(s.deps, csv);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(3);
    expect(res.data.failed[0].error).toContain('Answer');
    expect(res.data.failed[1].error).toContain('Order');
    expect(res.data.failed[2].error).toContain('Active');
    expect(s.created[0]).toMatchObject({ question: 'Q1?', answer: 'A1', category: 'billing', order: 2, isActive: true });
  });

  it('skips an existing question (case-insensitive) without creating it', async () => {
    const s = setup(['How do I RESET my password?']);
    const res = await importFaqsCsv(s.deps, [HEADER, 'how do i reset my password?,A,,,', 'New one?,B,,,'].join('\n'));
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(1);
    expect(s.created.length).toBe(1);
  });

  it('fails the second row when the same question appears twice in the file', async () => {
    const s = setup();
    const res = await importFaqsCsv(s.deps, [HEADER, 'Same?,A,,,', 'SAME?,B,,,'].join('\n'));
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(res.data.failed[0].error).toContain('Duplicate');
  });

  it('requires the Question and Answer columns', async () => {
    const s = setup();
    await expect(importFaqsCsv(s.deps, 'Question\nQ?')).rejects.toThrow('Answer');
    expect(FAQ_IMPORT_COLUMNS.filter((c) => c.required).length).toBe(2);
  });
});
