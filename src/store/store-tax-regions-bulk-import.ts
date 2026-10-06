/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const TAX_REGION_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Country', required: true, description: '2-letter country code (e.g. US, PK, GB).', example: 'US' },
  { key: 'State/Province', description: 'Leave blank to cover the whole country. Matched case-insensitively against the buyer\'s state at checkout.', example: 'CA' },
  { key: 'Tax Rate (%)', required: true, description: 'Number from 0 to 100. If the country + state already exists with a different rate, its rate is UPDATED; the same rate is skipped.', example: '7.25' },
];

export const TAX_REGION_IMPORT_MAX_ROWS = 1000;

export interface TaxRegionRow { country: string; state: string | null; rate: number }

export interface TaxRegionImportDeps {
  /** Regions currently saved on the store. */
  existing: TaxRegionRow[];
  /** Persists the FULL list through StoreService.updateStore (same validation + ownership). */
  save(regions: TaxRegionRow[]): Promise<unknown>;
}

const keyOf = (country: string, state: string | null) => `${country.trim().toLowerCase()}|${(state ?? '').trim().toLowerCase()}`;

export async function importTaxRegionsCsv(deps: TaxRegionImportDeps, text: string) {
  let regions: TaxRegionRow[] = (deps.existing ?? []).map((r) => ({ country: r.country, state: r.state ?? null, rate: r.rate }));

  return runBulkImport({
    text,
    columns: TAX_REGION_IMPORT_COLUMNS,
    maxRows: TAX_REGION_IMPORT_MAX_ROWS,
    label: 'tax region',
    fileDedupeKey: (r) => (r.Country ? keyOf(r.Country, r['State/Province'] || null) : null),
    handler: async (r) => {
      const country = r.Country.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) throw new BulkRowError('Country must be a 2-letter country code (e.g. US, PK, GB)');
      const state = r['State/Province'].trim() || null;
      if (state && state.length > 100) throw new BulkRowError('State/Province cannot be more than 100 characters');
      const rate = parseNumberCell(r['Tax Rate (%)'], 'Tax Rate (%)', { required: true, min: 0, max: 100 }) as number;

      const k = keyOf(country, state);
      const idx = regions.findIndex((x) => keyOf(x.country, x.state) === k);
      if (idx >= 0) {
        if (regions[idx].rate === rate) {
          return { outcome: 'skipped', note: `${country}${state ? ' / ' + state : ''} already has ${rate}%` };
        }
        const next = regions.map((x, i) => (i === idx ? { ...x, rate } : x));
        await deps.save(next);
        regions = next;
        return { outcome: 'updated' };
      }
      const next = [...regions, { country, state, rate }];
      await deps.save(next);
      regions = next;
      return { outcome: 'created' };
    },
  });
}
