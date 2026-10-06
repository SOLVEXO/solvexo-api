/* eslint-disable prettier/prettier */
/** Pure helpers for Shopify-style "Customs information" (country of origin + HS code) and customs declarations (no DB, no network). */

/** Optional ISO-3166 alpha-2 code from untyped input -> upper-case code, or null when empty/invalid. */
export function normalizeCountryOfOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) ? v : null;
}

/** Optional HS (harmonized system) code: digits with optional dots/spaces, 6-10 digits. Returns the cleaned code
 *  (dots/spaces kept as dots, e.g. "6109.10.00") or null when empty/invalid. */
export function normalizeHsCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().replace(/\s+/g, '');
  if (!/^[0-9]+(\.[0-9]+)*$/.test(v)) return null;
  const digits = v.replace(/\./g, '').length;
  return digits >= 6 && digits <= 10 ? v : null;
}

export function isValidCountryOfOrigin(raw: unknown): boolean {
  return normalizeCountryOfOrigin(raw) !== null;
}

export function isValidHsCode(raw: unknown): boolean {
  return normalizeHsCode(raw) !== null;
}

/** Optional free-text customs description (max 200 chars, what Shippo accepts for an item description). */
export function normalizeCustomsDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v ? v.slice(0, 200) : null;
}

export interface CustomsFields {
  countryOfOrigin: string | null;
  hsCode: string | null;
  customsDescription: string | null;
}

/** Build the three stored customs fields from an untyped create/update body. Present-but-INVALID throws the message;
 *  absent keys are left undefined so an update does not wipe them. Empty string/null clears (-> null). */
export function parseCustomsInput(body: any): { value: Partial<CustomsFields>; error: string | null } {
  const value: Partial<CustomsFields> = {};
  const cleared = (x: unknown) => x === null || (typeof x === 'string' && x.trim() === '');
  if (body?.countryOfOrigin !== undefined) {
    if (cleared(body.countryOfOrigin)) value.countryOfOrigin = null;
    else if (!isValidCountryOfOrigin(body.countryOfOrigin)) return { value, error: 'Country/region of origin must be a 2-letter ISO country code (e.g. "PK").' };
    else value.countryOfOrigin = normalizeCountryOfOrigin(body.countryOfOrigin);
  }
  if (body?.hsCode !== undefined) {
    if (cleared(body.hsCode)) value.hsCode = null;
    else if (!isValidHsCode(body.hsCode)) return { value, error: 'HS code must be 6 to 10 digits (dots allowed), e.g. "6109.10".' };
    else value.hsCode = normalizeHsCode(body.hsCode);
  }
  if (body?.customsDescription !== undefined) {
    value.customsDescription = normalizeCustomsDescription(body.customsDescription);
  }
  return { value, error: null };
}

/** Same ISO-2 compare for two country strings (store/origin vs. destination). Unknown on either side = NOT international. */
export function isInternationalDestination(originCountry: unknown, destinationCountry: unknown): boolean {
  const o = normalizeCountryOfOrigin(originCountry);
  const d = normalizeCountryOfOrigin(destinationCountry);
  return !!o && !!d && o !== d;
}

export interface CustomsLine {
  name: string;
  quantity: number;
  /** Line total in `currency` (item price x quantity). */
  value: number;
  /** Net weight of ALL units of this line, kg. */
  netWeightKg: number;
  countryOfOrigin: string | null;
  hsCode: string | null;
  customsDescription: string | null;
}

/** Names of the lines lacking a country of origin or HS code (empty array = declaration can be built). */
export function findMissingCustoms(lines: CustomsLine[]): { name: string; missing: string[] }[] {
  const out: { name: string; missing: string[] }[] = [];
  for (const l of lines) {
    const missing: string[] = [];
    if (!normalizeCountryOfOrigin(l.countryOfOrigin)) missing.push('country of origin');
    if (!normalizeHsCode(l.hsCode)) missing.push('HS code');
    if (missing.length) out.push({ name: l.name, missing });
  }
  return out;
}

/** Seller-facing 400 message naming every product that lacks customs data. */
export function missingCustomsMessage(missing: { name: string; missing: string[] }[]): string {
  const list = missing.map((m) => `"${m.name}" (${m.missing.join(' and ')})`).join(', ');
  return `This is an international order, so the shipping label needs a customs declaration. Add the missing "Customs information" on the product variant(s): ${list}.`;
}

/** Shippo `/customs/items/` body for one line. */
export function buildShippoCustomsItem(line: CustomsLine, currency: string) {
  const qty = Math.max(1, Math.floor(line.quantity));
  return {
    description: (line.customsDescription || line.name || 'Merchandise').slice(0, 200),
    quantity: qty,
    net_weight: String(Math.max(Math.round(line.netWeightKg * 1000) / 1000, 0.001)),
    mass_unit: 'kg',
    value_amount: String(Math.round(Math.max(line.value, 0) * 100) / 100),
    value_currency: currency,
    origin_country: normalizeCountryOfOrigin(line.countryOfOrigin),
    tariff_number: normalizeHsCode(line.hsCode),
  };
}

/** Shopify "Duties and import taxes may be charged on delivery" notice: shown for an international destination
 *  unless the seller switched it off (`Store.showDutiesNotice`, default true). */
export function shouldShowDutiesNotice(storeCountry: unknown, destinationCountry: unknown, showFlag: unknown): boolean {
  if (showFlag === false) return false;
  return isInternationalDestination(storeCountry, destinationCountry);
}
