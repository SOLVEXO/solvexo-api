/* eslint-disable prettier/prettier */
import { importCouponsCsv } from './coupons-bulk-import';

function setup(seed: any[] = []) {
  const rows: any[] = [...seed];
  const created: any[] = [];
  const updates: any[] = [];
  const couponModel = {
    findOne: async (f: any) => rows.find((r) => r.storeId === f.storeId && r.code === f.code && !r.isDelete) ?? null,
  };
  const marketingService = {
    createCoupon: async (_s: string, storeId: string, dto: any) => {
      const row = { _id: `c${rows.length}`, storeId, ...dto };
      rows.push(row);
      created.push(row);
      return { data: row };
    },
    updateCoupon: async (_s: string, _st: string, id: string, dto: any) => { updates.push({ id, dto }); return {}; },
  };
  return { deps: { couponModel, marketingService }, created, updates };
}
const H = 'Code,Discount Type,Discount Value,Minimum Order,Usage Limit,Start Date,End Date,Status';

describe('coupons bulk import', () => {
  it('creates valid rows with upper-cased code and typed numbers', async () => {
    const { deps, created } = setup();
    const res = await importCouponsCsv(deps, 'sel', 's1', [H, 'save10,percentage,10,50,100,2026-05-01,2026-06-30,'].join('\n'));
    expect(res.data.created).toBe(1);
    expect(created[0]).toMatchObject({ code: 'SAVE10', discountType: 'percentage', discountValue: 10, minOrderAmount: 50, usageLimit: 100 });
  });

  it('reports invalid rows naming the column', async () => {
    const { deps } = setup();
    const csv = [H, 'A,percentage,150,,,,,', 'B,bogus,5,,,,,', 'C,fixed,abc,,,,,', 'D,fixed,5,,,2026-02-30,,', 'E,fixed,5,,,2026-06-01,2026-05-01,', 'F,fixed,5,,0,,,'].join('\n');
    const res = await importCouponsCsv(deps, 'sel', 's1', csv);
    expect(res.data.failedCount).toBe(6);
    const errs = res.data.failed.map((f) => f.error).join('|');
    expect(errs).toContain('100');
    expect(errs).toContain('Discount Type');
    expect(errs).toContain('Discount Value');
    expect(errs).toContain('Start Date');
    expect(errs).toContain('End Date');
    expect(errs).toContain('Usage Limit');
  });

  it('skips an existing code in this store, fails a repeat in file, ignores other stores', async () => {
    const { deps, created } = setup([{ storeId: 's1', code: 'OLD' }, { storeId: 's2', code: 'NEW' }]);
    const res = await importCouponsCsv(deps, 'sel', 's1', [H, 'old,fixed,5,,,,,', 'new,fixed,5,,,,,', 'NEW,fixed,6,,,,,'].join('\n'));
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(1);
    expect(created.length).toBe(1);
  });

  it('inactive status pauses via updateCoupon; missing required column rejects', async () => {
    const { deps, updates } = setup();
    await importCouponsCsv(deps, 'sel', 's1', [H, 'P1,fixed,5,,,,,inactive'].join('\n'));
    expect(updates[0].dto).toEqual({ isActive: false });
    await expect(importCouponsCsv(deps, 'sel', 's1', 'Code\nX')).rejects.toThrow();
  });
});
