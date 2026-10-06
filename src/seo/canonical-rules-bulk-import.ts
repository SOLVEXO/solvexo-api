/* eslint-disable prettier/prettier */
import { ConflictException } from '@nestjs/common';
import { BulkColumn, BulkRowError, BulkRowResult, parseBoolCell } from '../common/bulk-import/bulk-import.util';

/**
 * CSV import for SEO canonical rules (seller store scope and admin platform
 * scope share the same columns). Rows go through `SeoCanonicalService.create`
 * (URL safety check, duplicate check, activity log). A rule whose path pattern
 * already exists in the scope — including a previously deleted one, exactly as
 * the single-create endpoint behaves — is reported as skipped.
 * The CSV does not edit existing rules (use the table's edit action).
 */
export const CANONICAL_COLUMNS: BulkColumn[] = [
  {
    key: 'Path pattern', required: true,
    description: 'Path the rule applies to, starting with "/". ":param" segments match any value, e.g. /collections/:handle. One rule per pattern.',
    example: '/collections/:handle',
  },
  {
    key: 'Canonical URL', required: true,
    description: 'Full https:// URL search engines should treat as canonical for matching paths.',
    example: 'https://example.com/collections/all',
  },
  {
    key: 'Active',
    description: 'yes or no. Blank = yes.',
    example: 'yes',
  },
];

export const CANONICAL_IMPORT_NOTES = [
  'A path pattern that already has a rule is skipped, never overwritten.',
  'Existing rules are not edited by import — change them in the table.',
];

export function canonicalFileDedupeKey(record: Record<string, string>): string | null {
  const p = String(record['Path pattern'] ?? '').trim();
  return p || null;
}

export function makeCanonicalRowHandler(
  create: (dto: { pathPattern: string; canonicalUrl: string; isActive?: boolean }) => Promise<unknown>,
) {
  return async (record: Record<string, string>): Promise<BulkRowResult> => {
    const pathPattern = String(record['Path pattern'] ?? '').trim();
    const canonicalUrl = String(record['Canonical URL'] ?? '').trim();
    if (!pathPattern) throw new BulkRowError('Path pattern is required');
    if (!pathPattern.startsWith('/')) throw new BulkRowError('Path pattern must start with "/"');
    if (pathPattern.length > 500) throw new BulkRowError('Path pattern is too long');
    if (!canonicalUrl) throw new BulkRowError('Canonical URL is required');
    if (!/^https?:\/\//i.test(canonicalUrl)) throw new BulkRowError('Canonical URL must start with http:// or https://');
    const isActive = parseBoolCell(String(record['Active'] ?? ''), 'Active');

    try {
      await create({ pathPattern, canonicalUrl, ...(isActive === undefined ? {} : { isActive }) });
    } catch (err) {
      if (err instanceof ConflictException) {
        return { outcome: 'skipped', note: `A rule for "${pathPattern}" already exists` };
      }
      throw err;
    }
    return { outcome: 'created' };
  };
}
