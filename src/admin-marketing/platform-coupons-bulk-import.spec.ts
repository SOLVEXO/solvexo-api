/* eslint-disable prettier/prettier */
import { ConflictException } from '@nestjs/common';
import { importPlatformCouponsCsv, PLATFORM_COUPON_IMPORT_COLUMNS } from './platform-coupons-bulk-import';

function setup(existing: string[] = []) {
  const codes = new Set(existing);
  const created: any[] = [];
  return {
    created,
    deps: {
      create: async (dto: any) => {
        if (codes.has(dto.code)) throw new ConflictException('exists');
        codes.add(dto.code);
        created.push(dto);
      },
    },
  };
}

const HEADER = 'Code,Discount Type,Discount Value,Min Order Amount,Usage Limit,Expires At';

describe('platform coupons bulk import', () => {
  it('creates valid rows (code upper-cased) and reports invalid ones with the column', async () => {
    const s = setup();
    const csv = [
      HEADER,
      'save5,fixed,5,,,',
      'big,percentage,150,,,',
      'x1,bogus,5,,,',
      'x2,fixed,abc,,,',
      'x3,fixed,5,,0,',
      'x4,fixed,5,,,notadate',
    ].join('\n');
    const res = await importPlatformCouponsCsv(s.deps, csv);
    expect(res.data.created).toBe(1);
    expect(res.data.failedCount).toBe(5);
    expect(s.created[0]).toMatchObject({ code: 'SAVE5', discountType: 'fixed', discountValue: 5 });
    const errs = res.data.failed.map((f) => f.error).join(' | ');
    expect(errs).toContain('100');
    expect(errs).toContain('Discount Type');
    expect(errs).toContain('Discount Value');
    expect(errs).toContain('Usage Limit');
    expect(errs).toContain('Expires At');
  });

  it('skips an existing code and does not create it again', async () => {
    const s = setup(['WELCOME']);
    const res = await importPlatformCouponsCsv(s.deps, [HEADER, 'welcome,fixed,5,,,', 'other,fixed,5,,,'].join('\n'));
    expect(res.data.skipped).toBe(1);
    expect(res.data.created).toBe(1);
    expect(s.created.length).toBe(1);
  });

  it('fails the second row when the code appears twice in the file', async () => {
    const s = setup();
    const res = await importPlatformCouponsCsv(s.deps, [HEADER, 'a1,fixed,5,,,', 'A1,fixed,6,,,'].join('\n'));
    expect(res.data.created).toBe(1);
    expect(res.data.failed[0].error).toContain('Duplicate');
  });

  it('accepts optional fields and requires the mandatory columns', async () => {
    const s = setup();
    await importPlatformCouponsCsv(s.deps, [HEADER, 'full,percentage,10,20,100,2027-12-31'].join('\n'));
    expect(s.created[0]).toMatchObject({ minOrderAmount: 20, usageLimit: 100 });
    expect(typeof s.created[0].expiresAt).toBe('string');
    await expect(importPlatformCouponsCsv(s.deps, 'Code\nA')).rejects.toThrow('Discount Type');
    expect(PLATFORM_COUPON_IMPORT_COLUMNS.filter((c) => c.required).length).toBe(3);
  });
});
