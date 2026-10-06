/* eslint-disable prettier/prettier */
import { importTaxRegionsCsv } from './store-tax-regions-bulk-import';

describe('tax regions bulk import', () => {
  it('adds new regions, updates a changed rate, skips an unchanged one', async () => {
    const saved: any[] = [];
    const deps = {
      existing: [{ country: 'US', state: 'CA', rate: 7 }, { country: 'PK', state: null, rate: 17 }],
      save: jest.fn(async (r: any) => { saved.push(r); }),
    };
    const csv = 'Country,State/Province,Tax Rate (%)\nus,ca,7.25\nPK,,17\nGB,,20';
    const res = await importTaxRegionsCsv(deps, csv);
    expect(res.data).toMatchObject({ created: 1, updated: 1, skipped: 1, failedCount: 0 });
    const last = saved[saved.length - 1];
    expect(last).toEqual([
      { country: 'US', state: 'CA', rate: 7.25 },
      { country: 'PK', state: null, rate: 17 },
      { country: 'GB', state: null, rate: 20 },
    ]);
  });

  it('rejects bad country / rate, duplicate key in file, and missing columns', async () => {
    const deps = { existing: [], save: jest.fn(async () => undefined) };
    const res = await importTaxRegionsCsv(deps, 'Country,State/Province,Tax Rate (%)\nUSA,,5\nUS,,150\nUS,,abc\nDE,,19\nde,,19');
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(4);
    expect(res.data.failed[0].error).toContain('Country');
    expect(res.data.failed[1].error).toContain('Tax Rate');
    expect(res.data.failed[3].error).toContain('Duplicate');
    await expect(importTaxRegionsCsv(deps, 'Country\nUS')).rejects.toThrow('Tax Rate');
  });

  it('a save failure (service validation) fails only that row and leaves the list unchanged', async () => {
    let n = 0;
    const deps = { existing: [], save: jest.fn(async (_list: any) => { if (++n === 1) throw new Error('nope'); }) };
    const res = await importTaxRegionsCsv(deps, 'Country,Tax Rate (%)\nUS,5\nGB,20');
    expect(res.data).toMatchObject({ created: 1, failedCount: 1 });
    expect(deps.save.mock.calls[1][0]).toEqual([{ country: 'GB', state: null, rate: 20 }]);
  });
});
