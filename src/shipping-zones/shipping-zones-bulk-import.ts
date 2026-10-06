/* eslint-disable prettier/prettier */
import {
  BulkColumn,
  BulkRowError,
  parseEnumCell,
  parseNumberCell,
  runBulkImport,
} from '../common/bulk-import/bulk-import.util';
import { COUNTRY_NAMES } from '../common/country-names.const';
import { CreateShippingZoneDto } from './dto/create-shipping-zone.dto';

export const SHIPPING_ZONE_IMPORT_MAX_ROWS = 1000;

export const SHIPPING_ZONE_IMPORT_COLUMNS: BulkColumn[] = [
  { key: 'Country', required: true, description: 'English country name exactly as in the shipping-zone country dropdown (e.g. Pakistan) or its 2-letter ISO code (PK).', example: 'Pakistan' },
  { key: 'Province/State', description: 'Optional. Leave blank to cover the whole country.', example: 'Punjab' },
  { key: 'City', description: 'Optional. Leave blank to cover the whole province/country.', example: 'Lahore' },
  { key: 'Zone Name', description: 'Optional label (max 80 characters), e.g. Standard. Flat-rate zones only: tiered/weight/price rates, pickup, local delivery and shipping-profile links cannot be imported — set those in the editor.', example: 'Standard' },
  { key: 'Shipping Price', required: true, description: 'Flat shipping price in your store currency. Use 0 for free shipping.', example: '250' },
  { key: 'Free Shipping Threshold', description: 'Optional. Order subtotal at or above which shipping is free.', example: '5000' },
  { key: 'Estimated Delivery', description: 'Optional free text shown to buyers, e.g. 3-5 Days.', example: '3-5 Days' },
  { key: 'Status', description: 'active or inactive. Blank = active.', example: 'active' },
];

let codeMapCache: Map<string, string> | null = null;
/** lower-cased name/code -> canonical English name, from ISO alpha-2 codes + the project's own list. */
function countryLookup(): Map<string, string> {
  if (codeMapCache) return codeMapCache;
  const map = new Map<string, string>();
  let dn: Intl.DisplayNames | null = null;
  try { dn = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' }); } catch { dn = null; }
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of A) {
    for (const b of A) {
      const code = a + b;
      let name: string | undefined = COUNTRY_NAMES[code];
      if (!name && dn) { try { name = dn.of(code) ?? undefined; } catch { name = undefined; } }
      if (!name || name === code) continue;
      map.set(code.toLowerCase(), name);
      map.set(name.toLowerCase(), name);
      if (dn) { try { const n2 = dn.of(code); if (n2 && !map.has(n2.toLowerCase())) map.set(n2.toLowerCase(), n2); } catch { /* ignore */ } }
    }
  }
  codeMapCache = map;
  return map;
}

/** Returns the country to store, or throws a BulkRowError. A recognised NAME is stored as typed (it matches the dropdown the checkout compares against); a code is expanded. */
export function resolveImportCountry(raw: string): string {
  const v = raw.trim();
  if (!v) throw new BulkRowError('Country is required');
  const hit = countryLookup().get(v.toLowerCase());
  if (!hit) throw new BulkRowError(`Country "${v}" is not a recognised country — use the English name from the shipping-zone country dropdown or a 2-letter ISO code`);
  return v.length === 2 ? hit : v.replace(/\s+/g, ' ');
}

const norm = (s: unknown) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
export const zoneKey = (country: string, province?: string | null, city?: string | null) =>
  [norm(country), norm(province), norm(city)].join('|');

export interface ShippingZoneImportDeps {
  /** Existing zones of the store (ownership already verified by the caller's service). */
  listExisting: () => Promise<any[]>;
  /** The real `ShippingZonesService.createForSeller` bound to store + seller. */
  create: (dto: CreateShippingZoneDto) => Promise<unknown>;
}

export async function importShippingZonesCsv(deps: ShippingZoneImportDeps, text: string) {
  const existing = await deps.listExisting();
  // Only the default (General) profile's plain shipping zones take part in the unique key.
  const keys = new Set<string>();
  for (const z of existing) {
    if (z.isDelete) continue;
    if ((z.zoneType ?? 'shipping') !== 'shipping') continue;
    if (z.profileId) continue;
    keys.add(zoneKey(z.country, z.province, z.city));
  }

  return runBulkImport({
    text,
    columns: SHIPPING_ZONE_IMPORT_COLUMNS,
    maxRows: SHIPPING_ZONE_IMPORT_MAX_ROWS,
    label: 'shipping zone',
    fileDedupeKey: (r) => (r['Country'] ? `${zoneKey(r['Country'], r['Province/State'], r['City'])}` : null),
    handler: async (r) => {
      const country = resolveImportCountry(r['Country']);
      const province = r['Province/State'] || undefined;
      const city = r['City'] || undefined;
      const price = parseNumberCell(r['Shipping Price'], 'Shipping Price', { required: true, min: 0 });
      const threshold = parseNumberCell(r['Free Shipping Threshold'], 'Free Shipping Threshold', { min: 0 });
      const status = parseEnumCell(r['Status'], 'Status', ['active', 'inactive'] as const);
      if (r['Zone Name'].length > 80) throw new BulkRowError('Zone Name must be at most 80 characters');

      const key = zoneKey(country, province, city);
      if (keys.has(key)) {
        return { outcome: 'skipped', note: `A zone for ${[country, province, city].filter(Boolean).join(' / ')} already exists` };
      }

      const dto = new CreateShippingZoneDto();
      dto.country = country;
      if (province) dto.province = province;
      if (city) dto.city = city;
      dto.shippingPrice = price as number;
      dto.zoneType = 'shipping';
      dto.rateType = 'flat';
      if (r['Zone Name']) dto.name = r['Zone Name'];
      if (threshold !== undefined) dto.freeShippingThreshold = threshold;
      if (r['Estimated Delivery']) dto.estimatedDeliveryTime = r['Estimated Delivery'];
      if (status) dto.status = status;
      await deps.create(dto);
      keys.add(key);
      return { outcome: 'created' };
    },
  });
}
