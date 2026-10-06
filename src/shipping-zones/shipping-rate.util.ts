/* eslint-disable prettier/prettier */

export interface ShippingRateTier {
  min: number;
  max: number | null;
  price: number;
}

export interface RateableZone {
  zoneType?: string | null;
  rateType?: string | null;
  rateTiers?: ShippingRateTier[] | null;
  shippingPrice?: number | null;
  freeShippingThreshold?: number | null;
}

/**
 * Shopify-style zone rate: flat, by order weight (kg) or by order price (store currency).
 * Local pickup is always free. A zone-level free-shipping threshold wins over any rate.
 * Returns `null` when a weight/price zone has no tier covering this cart (the option is not offered).
 * `subtotal` MUST be in the zone's own (store) currency.
 */
export function resolveZoneShippingPrice(
  zone: RateableZone,
  cart: { subtotal: number; weightKg: number },
): number | null {
  if (zone.zoneType === 'pickup') return 0;
  const threshold = zone.freeShippingThreshold;
  if (threshold != null && threshold >= 0 && cart.subtotal >= threshold) return 0;

  const type = zone.rateType ?? 'flat';
  if (type === 'flat') return zone.shippingPrice ?? 0;

  const value = type === 'weight' ? cart.weightKg : cart.subtotal;
  const tiers = [...(zone.rateTiers ?? [])].sort((a, b) => a.min - b.min);
  const hit = tiers.find((t) => value >= t.min && (t.max == null || value <= t.max));
  return hit ? hit.price : null;
}

/** Returns an error message for an invalid tier set (overlap, min>max, negatives), or null when valid. */
export function validateRateTiers(rateType: string | undefined, tiers: ShippingRateTier[] | undefined): string | null {
  if (rateType !== 'weight' && rateType !== 'price') return null;
  if (!tiers || tiers.length === 0) return 'Add at least one rate tier.';
  const sorted = [...tiers].sort((a, b) => a.min - b.min);
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (t.min < 0 || t.price < 0 || (t.max != null && t.max < 0)) return 'Tier values cannot be negative.';
    if (t.max != null && t.max <= t.min) return 'Each tier maximum must be greater than its minimum.';
    const next = sorted[i + 1];
    if (next && (t.max == null || t.max >= next.min)) return 'Rate tiers cannot overlap.';
  }
  return null;
}
