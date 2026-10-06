/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseEnumCell,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';

export const LOCATION_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Name', required: true, description: 'Location name. Unique per store (case-insensitive) — an existing location is skipped.', example: 'Main Warehouse' },
  { key: 'Type', description: 'store (retail/POS) or warehouse (fulfilment only). Default store.', example: 'warehouse' },
  { key: 'Address Line 1', description: 'Street address.', example: '12 Industrial Rd' },
  { key: 'Address Line 2', description: 'Max 200 characters.', example: '' },
  { key: 'City', description: 'City.', example: 'Karachi' },
  { key: 'State', description: 'State / province, max 100 characters.', example: 'Sindh' },
  { key: 'Postcode', description: 'ZIP / postal code, max 20 characters.', example: '74000' },
  { key: 'Country', description: 'Country (ISO code such as PK, US), max 60 characters.', example: 'PK' },
  { key: 'Phone', description: 'Contact phone number.', example: '' },
  { key: 'Latitude', description: 'Optional, -90 to 90 (only needed for local-delivery radius).', example: '' },
  { key: 'Longitude', description: 'Optional, -180 to 180. Give both Latitude and Longitude or neither.', example: '' },
];

export const LOCATION_IMPORT_MAX_ROWS = 200;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface LocationImportDeps {
  locationModel: any;
  /** StoreLocationService-like: the REAL create path (ownership, plan limit, default flag, activity log). */
  locationService: { createLocation(sellerId: string, storeId: string, dto: any): Promise<any> };
}

/** The first location of a store becomes its default, so rows run strictly in order (default concurrency 1). */
export async function importLocationsCsv(deps: LocationImportDeps, sellerId: string, storeId: string, text: string) {
  const { locationModel, locationService } = deps;

  return runBulkImport({
    text,
    columns: LOCATION_IMPORT_COLUMNS,
    maxRows: LOCATION_IMPORT_MAX_ROWS,
    label: 'location',
    fileDedupeKey: (r) => (r.Name ? r.Name.toLowerCase() : null),
    handler: async (r) => {
      const name = r.Name.trim();
      if (!name) throw new BulkRowError('Name is required');
      if (name.length > 120) throw new BulkRowError('Name cannot be more than 120 characters');
      const type = parseEnumCell(r.Type, 'Type', ['store', 'warehouse'] as const) ?? 'store';
      if (r['Address Line 2'].length > 200) throw new BulkRowError('Address Line 2 cannot be more than 200 characters');
      if (r.State.length > 100) throw new BulkRowError('State cannot be more than 100 characters');
      if (r.Postcode.length > 20) throw new BulkRowError('Postcode cannot be more than 20 characters');
      if (r.Country.length > 60) throw new BulkRowError('Country cannot be more than 60 characters');
      const latitude = parseNumberCell(r.Latitude, 'Latitude', { min: -90, max: 90 });
      const longitude = parseNumberCell(r.Longitude, 'Longitude', { min: -180, max: 180 });
      if ((latitude === undefined) !== (longitude === undefined)) {
        throw new BulkRowError('Give both Latitude and Longitude, or neither');
      }

      const existing = await locationModel.findOne({
        storeId,
        isDelete: false,
        name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
      });
      if (existing) return { outcome: 'skipped', note: `Location "${name}" already exists` };

      // createLocation enforces the plan's location limit (assertCanAddLocation) — its message fails the row.
      await locationService.createLocation(sellerId, storeId, {
        name,
        type,
        ...(r['Address Line 1'] ? { addressLine1: r['Address Line 1'] } : {}),
        ...(r['Address Line 2'] ? { addressLine2: r['Address Line 2'] } : {}),
        ...(r.City ? { city: r.City } : {}),
        ...(r.State ? { state: r.State } : {}),
        ...(r.Postcode ? { zipCode: r.Postcode } : {}),
        ...(r.Country ? { country: r.Country } : {}),
        ...(r.Phone ? { phone: r.Phone } : {}),
        ...(latitude !== undefined ? { latitude, longitude } : {}),
      });
      return { outcome: 'created' };
    },
  });
}
