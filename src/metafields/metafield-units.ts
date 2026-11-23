/* eslint-disable prettier/prettier */
/** Measurement types: a number and a unit, stored as one string ("12.5 cm"), like every other metafield value.
 *  Keep in sync with the web copy (src/features/seller/store/Dashboard/StoreSection/products/metafieldUnits.ts). */
export const MEASURE_UNITS = {
  dimension: ['mm', 'cm', 'm', 'in', 'ft', 'yd'],
  weight: ['g', 'kg', 'oz', 'lb'],
  volume: ['ml', 'cl', 'l', 'fl oz', 'gal'],
} as const;
export type MeasureType = keyof typeof MEASURE_UNITS;

export const isMeasureType = (t: string): t is MeasureType => t in MEASURE_UNITS;

/** "12.5 cm" -> { amount: 12.5, unit: 'cm' }; null when it is not a number followed by one of the type's units. */
export function parseMeasure(type: MeasureType, value: string): { amount: number; unit: string } | null {
  const m = /^(-?\d+(?:\.\d+)?)\s+(.+)$/.exec(value.trim());
  if (!m) return null;
  const unit = m[2].trim();
  return (MEASURE_UNITS[type] as readonly string[]).includes(unit) ? { amount: Number(m[1]), unit } : null;
}
