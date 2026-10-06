/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseEnumCell,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const COUPON_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Code', required: true, description: 'Coupon code (saved UPPER-CASE). Unique per store.', example: 'BACK2SCHOOL' },
  { key: 'Discount Type', required: true, description: 'percentage or fixed.', example: 'percentage' },
  { key: 'Discount Value', required: true, description: 'Number. For percentage max 100.', example: '20' },
  { key: 'Minimum Order', description: 'Optional minimum order amount.', example: '50' },
  { key: 'Usage Limit', description: 'Optional whole number (at least 1) — total redemptions allowed.', example: '100' },
  { key: 'Start Date', description: 'Optional, YYYY-MM-DD. Blank = active immediately.', example: '2026-05-01' },
  { key: 'End Date', description: 'Optional, YYYY-MM-DD, not before the start date.', example: '2026-06-30' },
  { key: 'Status', description: 'active or inactive (default active).', example: 'active' },
];

export const COUPON_IMPORT_MAX_ROWS = 1000;

/** Strict YYYY-MM-DD that is also a real calendar date. */
function parseDateCell(raw: string, column: string): string | undefined {
  if (!raw) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) throw new BulkRowError(`${column} must be a date in YYYY-MM-DD format (got "${raw}")`);
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new BulkRowError(`${column} is not a real calendar date (got "${raw}")`);
  }
  return raw;
}

export interface CouponImportDeps {
  couponModel: any;
  /** MarketingService-like: createCoupon / updateCoupon (the REAL create path). */
  marketingService: {
    createCoupon(sellerId: string, storeId: string, dto: any, ip?: string, ua?: string): Promise<any>;
    updateCoupon(sellerId: string, storeId: string, couponId: string, dto: any, ip?: string, ua?: string): Promise<any>;
  };
}

export async function importCouponsCsv(
  deps: CouponImportDeps,
  sellerId: string,
  storeId: string,
  text: string,
  ip?: string,
  userAgent?: string,
) {
  const { couponModel, marketingService } = deps;
  return runBulkImport({
    text,
    columns: COUPON_IMPORT_COLUMNS,
    maxRows: COUPON_IMPORT_MAX_ROWS,
    label: 'coupon',
    fileDedupeKey: (r) => (r.Code ? r.Code.trim().toUpperCase() : null),
    handler: async (r) => {
      const code = r.Code.trim().toUpperCase();
      if (!code) throw new BulkRowError('Code is required');
      if (code.length > 50) throw new BulkRowError('Code cannot be longer than 50 characters');
      const discountType = parseEnumCell(r['Discount Type'], 'Discount Type', ['percentage', 'fixed'] as const);
      if (!discountType) throw new BulkRowError('Discount Type is required (percentage or fixed)');
      const discountValue = parseNumberCell(r['Discount Value'], 'Discount Value', { required: true, min: 0 }) as number;
      if (discountType === 'percentage' && discountValue > 100) {
        throw new BulkRowError('Discount Value cannot exceed 100 for a percentage coupon');
      }
      const minOrderAmount = parseNumberCell(r['Minimum Order'], 'Minimum Order', { min: 0 });
      const usageLimit = parseNumberCell(r['Usage Limit'], 'Usage Limit', { min: 1, integer: true });
      const startsAt = parseDateCell(r['Start Date'], 'Start Date');
      const expiresAt = parseDateCell(r['End Date'], 'End Date');
      if (startsAt && expiresAt && expiresAt < startsAt) {
        throw new BulkRowError('End Date must not be before Start Date');
      }
      const status = parseEnumCell(r.Status, 'Status', ['active', 'inactive'] as const) ?? 'active';

      const existing = await couponModel.findOne({ storeId, code, isDelete: false });
      if (existing) return { outcome: 'skipped', note: `Coupon code ${code} already exists` };

      const created = await marketingService.createCoupon(
        sellerId,
        storeId,
        {
          code,
          discountType,
          discountValue,
          ...(minOrderAmount !== undefined ? { minOrderAmount } : {}),
          ...(usageLimit !== undefined ? { usageLimit } : {}),
          ...(startsAt ? { startsAt } : {}),
          ...(expiresAt ? { expiresAt } : {}),
        },
        ip,
        userAgent,
      );
      if (status === 'inactive') {
        await marketingService.updateCoupon(sellerId, storeId, String(created.data._id), { isActive: false }, ip, userAgent);
      }
      return { outcome: 'created' };
    },
  });
}
