/* eslint-disable prettier/prettier */
import { ConflictException } from '@nestjs/common';
import {
  BulkColumn,
  BulkRowError,
  parseEnumCell,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { CreatePlatformCouponDto } from './dto/create-platform-coupon.dto';

export const PLATFORM_COUPON_IMPORT_MAX_ROWS = 1000;

export const PLATFORM_COUPON_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Code', required: true, description: 'Coupon code (stored upper-case, max 40 characters). An existing platform coupon with the same code is skipped.', example: 'WELCOME10' },
  { key: 'Discount Type', required: true, description: 'percentage or fixed.', example: 'percentage' },
  { key: 'Discount Value', required: true, description: 'Number >= 0. For percentage it cannot exceed 100.', example: '10' },
  { key: 'Min Order Amount', description: 'Optional minimum order amount (>= 0).', example: '20' },
  { key: 'Usage Limit', description: 'Optional whole number >= 1 — total redemptions allowed. Blank = unlimited.', example: '1000' },
  { key: 'Expires At', description: 'Optional date, YYYY-MM-DD (or full ISO date-time). Blank = never expires.', example: '2027-12-31' },
];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export interface PlatformCouponImportDeps {
  /** `AdminMarketingService.createPlatformCoupon` bound to the admin audit meta. */
  create: (dto: CreatePlatformCouponDto) => Promise<unknown>;
}

export function importPlatformCouponsCsv(deps: PlatformCouponImportDeps, text: string) {
  return runBulkImport({
    text,
    columns: PLATFORM_COUPON_IMPORT_COLUMNS,
    maxRows: PLATFORM_COUPON_IMPORT_MAX_ROWS,
    label: 'platform coupon',
    fileDedupeKey: (r) => (r['Code'] ? r['Code'].trim().toUpperCase() : null),
    handler: async (r) => {
      const code = r['Code'].trim().toUpperCase();
      if (!code) throw new BulkRowError('Code is required');
      if (code.length > 40 || /\s/.test(code)) throw new BulkRowError('Code must be at most 40 characters with no spaces');
      const type = parseEnumCell(r['Discount Type'], 'Discount Type', ['percentage', 'fixed'] as const);
      if (!type) throw new BulkRowError('Discount Type is required (percentage or fixed)');
      const value = parseNumberCell(r['Discount Value'], 'Discount Value', { required: true, min: 0 }) as number;
      if (type === 'percentage' && value > 100) throw new BulkRowError('Discount Value cannot exceed 100 for a percentage coupon');
      const minOrder = parseNumberCell(r['Min Order Amount'], 'Min Order Amount', { min: 0 });
      const limit = parseNumberCell(r['Usage Limit'], 'Usage Limit', { min: 1, integer: true });
      let expiresAt: string | undefined;
      if (r['Expires At']) {
        if (!ISO_DATE_RE.test(r['Expires At']) || Number.isNaN(new Date(r['Expires At']).getTime())) {
          throw new BulkRowError('Expires At must be a date like 2027-12-31');
        }
        expiresAt = new Date(r['Expires At']).toISOString();
      }

      const dto = new CreatePlatformCouponDto();
      dto.code = code;
      dto.discountType = type;
      dto.discountValue = value;
      if (minOrder !== undefined) dto.minOrderAmount = minOrder;
      if (limit !== undefined) dto.usageLimit = limit;
      if (expiresAt) dto.expiresAt = expiresAt;
      try {
        await deps.create(dto);
      } catch (err) {
        if (err instanceof ConflictException) return { outcome: 'skipped', note: `Platform coupon ${code} already exists` };
        throw err;
      }
      return { outcome: 'created' };
    },
  });
}
