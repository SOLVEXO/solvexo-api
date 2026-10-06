/* eslint-disable prettier/prettier */

export interface TaxRegionRate { country: string; state: string | null; rate: number }

/** Country+state match wins over a country-only entry; null when no region applies (caller uses the flat store rate). */
export function resolveRegionRate(
  regions: TaxRegionRate[] | null | undefined,
  address: { country?: string | null; state?: string | null } | null | undefined,
): number | null {
  if (!address?.country || !regions || regions.length === 0) return null;
  const country = address.country.trim().toLowerCase();
  const state = address.state?.trim().toLowerCase() ?? null;
  const exact = regions.find((r) => r.country.trim().toLowerCase() === country && r.state && r.state.trim().toLowerCase() === state);
  if (exact) return exact.rate;
  const countryOnly = regions.find((r) => r.country.trim().toLowerCase() === country && !r.state);
  return countryOnly ? countryOnly.rate : null;
}

/** Tax charged on a shipping fee (same currency as the fee). 0 unless the store opted in via `taxShipping`. */
export function shippingTaxFromRate(shippingFee: number, ratePercent: number, taxShipping: boolean): number {
  if (!taxShipping || !(shippingFee > 0) || !(ratePercent > 0)) return 0;
  return Math.round(shippingFee * (ratePercent / 100) * 100) / 100;
}
