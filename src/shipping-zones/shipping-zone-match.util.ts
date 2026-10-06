/* eslint-disable prettier/prettier */

/** Postcodes compare case/space/dash-insensitively ("sw1a 1aa" === "SW1A-1AA"). */
export function normalizePostcode(v?: string | null): string {
  return String(v ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

/** Cleans a seller-entered postcode list: normalised, de-duplicated, blanks dropped. */
export function cleanPostalCodes(list?: string[] | null): string[] {
  return [...new Set((list ?? []).map(normalizePostcode).filter(Boolean))];
}

/**
 * Local-delivery postcode rule (Shopify matches local delivery by postal-code list).
 * Returns `null` when the zone has no postcode list (caller falls back to the city/area match),
 * otherwise whether the buyer's postcode is on the list.
 */
export function postcodeMatch(zone: { postalCodes?: string[] | null }, zip?: string | null): boolean | null {
  const codes = cleanPostalCodes(zone.postalCodes);
  if (codes.length === 0) return null;
  const z = normalizePostcode(zip);
  return !!z && codes.includes(z);
}

/** Minimum order for a zone (store currency). null/undefined/<=0 = no minimum. */
export function meetsMinOrderAmount(zone: { minOrderAmount?: number | null }, subtotal: number): boolean {
  const min = zone.minOrderAmount;
  return min == null || min <= 0 || subtotal >= min;
}
