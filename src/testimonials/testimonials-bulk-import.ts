/* eslint-disable prettier/prettier */
import {
  BulkColumn, BulkRowError, BulkRowResult, parseBoolCell, parseNumberCell,
} from '../common/bulk-import/bulk-import.util';

/**
 * CSV import for platform testimonials (admin). Rows go through
 * `TestimonialsService.create` (same as the admin "Add testimonial" form).
 * Unique key = seller name + text (case-insensitive): an existing one is
 * skipped. Seller-self-submitted testimonials (moderation queue) are not part
 * of the CSV — they are created by sellers, not imported.
 */
export const TESTIMONIAL_COLUMNS: BulkColumn[] = [
  { key: 'Seller name', required: true, description: 'Name shown with the quote.', example: 'Amina Raza' },
  { key: 'Store name', description: 'Optional store name shown under the name.', example: 'Amina Crafts' },
  { key: 'Rating', required: true, description: 'Whole number from 1 to 5.', example: '5' },
  { key: 'Text', required: true, description: 'The testimonial quote.', example: 'Solvexo made it easy to launch my store.' },
  { key: 'Verified seller', description: 'yes or no. Blank = yes.', example: 'yes' },
  { key: 'Order', description: 'Display order, 0 or higher (lower shows first). Blank = 0.', example: '0' },
  { key: 'Active', description: 'yes or no — shown on the homepage. Blank = yes.', example: 'yes' },
];

export const TESTIMONIAL_IMPORT_NOTES = [
  'A testimonial with the same seller name and text is skipped, never duplicated.',
];

export function testimonialKey(name: string, text: string): string {
  return `${name.trim().toLowerCase()}||${text.trim().toLowerCase()}`;
}

export function testimonialFileDedupeKey(record: Record<string, string>): string | null {
  const n = String(record['Seller name'] ?? '');
  const t = String(record['Text'] ?? '');
  return n.trim() && t.trim() ? testimonialKey(n, t) : null;
}

export function makeTestimonialRowHandler(deps: {
  exists: (sellerName: string, text: string) => Promise<boolean>;
  create: (dto: {
    sellerName: string; storeName?: string; rating: number; text: string;
    isVerifiedSeller?: boolean; order?: number; isActive?: boolean;
  }) => Promise<unknown>;
}) {
  return async (record: Record<string, string>): Promise<BulkRowResult> => {
    const sellerName = String(record['Seller name'] ?? '').trim();
    const text = String(record['Text'] ?? '').trim();
    if (!sellerName) throw new BulkRowError('Seller name is required');
    if (sellerName.length > 120) throw new BulkRowError('Seller name cannot exceed 120 characters');
    if (!text) throw new BulkRowError('Text is required');
    if (text.length > 2000) throw new BulkRowError('Text cannot exceed 2,000 characters');
    const rating = parseNumberCell(String(record['Rating'] ?? ''), 'Rating', { required: true, min: 1, max: 5, integer: true })!;
    const storeName = String(record['Store name'] ?? '').trim();
    if (storeName.length > 120) throw new BulkRowError('Store name cannot exceed 120 characters');
    const isVerifiedSeller = parseBoolCell(String(record['Verified seller'] ?? ''), 'Verified seller');
    const order = parseNumberCell(String(record['Order'] ?? ''), 'Order', { min: 0, integer: true });
    const isActive = parseBoolCell(String(record['Active'] ?? ''), 'Active');

    if (await deps.exists(sellerName, text)) {
      return { outcome: 'skipped', note: `Testimonial from "${sellerName}" with this text already exists` };
    }

    await deps.create({
      sellerName,
      ...(storeName ? { storeName } : {}),
      rating,
      text,
      ...(isVerifiedSeller === undefined ? {} : { isVerifiedSeller }),
      ...(order === undefined ? {} : { order }),
      ...(isActive === undefined ? {} : { isActive }),
    });
    return { outcome: 'created' };
  };
}
