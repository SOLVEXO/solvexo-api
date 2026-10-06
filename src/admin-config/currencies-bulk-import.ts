/* eslint-disable prettier/prettier */
import { BulkColumn, BulkRowError, BulkRowResult, parseNumberCell } from '../common/bulk-import/bulk-import.util';
import { isRealCurrencyCode } from '../common/currency-metadata.const';

/**
 * CSV import for the platform's enabled-currency list (admin, Markets). Rows
 * go through `AdminConfigService.addCurrency` (ISO-4217 check, band rules,
 * audit log, cache invalidation). A currency that is already enabled is
 * skipped — the CSV never changes an existing band (use the band editor).
 * It only ENABLES currencies; it never removes any and never sets FX rates.
 */
export const CURRENCY_COLUMNS: BulkColumn[] = [
  { key: 'Code', required: true, description: 'Real ISO-4217 3-letter code (not USD — USD is always on).', example: 'EUR' },
  { key: 'Sanity band min', required: true, description: 'Lowest plausible units of this currency per 1 USD (> 0). Rates outside the band are rejected.', example: '0.6' },
  { key: 'Sanity band max', required: true, description: 'Highest plausible units per 1 USD (must be greater than min).', example: '1.3' },
];

export const CURRENCY_IMPORT_NOTES = [
  'An already-enabled currency is skipped; its band is not changed by import.',
  'This only enables currencies. It does not set exchange rates or remove currencies.',
];

export function currencyFileDedupeKey(record: Record<string, string>): string | null {
  const c = String(record['Code'] ?? '').trim().toUpperCase();
  return c || null;
}

export function makeCurrencyRowHandler(deps: {
  listEnabledCodes: () => Promise<string[]>;
  addCurrency: (code: string, min: number, max: number) => Promise<unknown>;
}) {
  return async (record: Record<string, string>): Promise<BulkRowResult> => {
    const code = String(record['Code'] ?? '').trim().toUpperCase();
    if (!code) throw new BulkRowError('Code is required');
    if (!/^[A-Z]{3}$/.test(code)) throw new BulkRowError('Code must be a 3-letter ISO-4217 code');
    if (code === 'USD') throw new BulkRowError('USD is always enabled as the platform pivot');
    if (!isRealCurrencyCode(code)) throw new BulkRowError(`"${code}" is not a real ISO-4217 currency code`);
    const min = parseNumberCell(String(record['Sanity band min'] ?? ''), 'Sanity band min', { required: true, min: 0.0001 })!;
    const max = parseNumberCell(String(record['Sanity band max'] ?? ''), 'Sanity band max', { required: true, min: 0.0001 })!;
    if (max <= min) throw new BulkRowError('Sanity band max must be greater than Sanity band min');

    const enabled = await deps.listEnabledCodes();
    if (enabled.includes(code)) return { outcome: 'skipped', note: `${code} is already enabled` };

    await deps.addCurrency(code, min, max);
    return { outcome: 'created' };
  };
}
