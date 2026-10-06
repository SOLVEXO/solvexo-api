/* eslint-disable prettier/prettier */

/** Group key of the implicit General profile (every product / zone without an explicit custom profile). */
export const GENERAL_GROUP_KEY = 'general';

export interface ProfileGroupItem {
  productId: string;
  type?: string | null;
}

/**
 * Shopify: a cart is split into one delivery group per shipping profile. Only PHYSICAL lines need shipping.
 * A product whose profile is unset, deleted, or unknown to the store falls back to the General group, so a
 * store that never created a custom profile always has exactly one group (today's behaviour).
 * `liveProfileIds` = ids of the store's non-deleted, non-General profiles.
 */
export function groupItemsByProfile<T extends ProfileGroupItem>(
  items: T[],
  profileByProductId: Map<string, string | null | undefined>,
  liveProfileIds: Set<string>,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    if (it.type && it.type !== 'physical') continue;
    const pid = profileByProductId.get(String(it.productId));
    const key = pid && liveProfileIds.has(String(pid)) ? String(pid) : GENERAL_GROUP_KEY;
    const list = groups.get(key);
    if (list) list.push(it);
    else groups.set(key, [it]);
  }
  return groups;
}

/** Does a zone row belong to a delivery group? Rows without `profileId` are the General profile's. */
export function zoneInGroup(zone: { profileId?: string | null }, groupKey: string): boolean {
  const zp = zone.profileId ? String(zone.profileId) : GENERAL_GROUP_KEY;
  return zp === groupKey;
}

export interface ShippingSelection {
  profileId?: string | null;
  shippingZoneId: string;
}

/**
 * Normalises what the buyer sent into `groupKey -> zoneId`. Accepts either `selections[]` (one per group) or the
 * legacy single `shippingZoneId` (only valid when the cart has exactly one group). Returns an error string for an
 * unknown/duplicate group or a missing group, else the map.
 */
export function normalizeSelections(
  groupKeys: string[],
  input: { selections?: ShippingSelection[] | null; shippingZoneId?: string | null },
): { error: string } | { byGroup: Map<string, string> } {
  const byGroup = new Map<string, string>();
  if (Array.isArray(input.selections) && input.selections.length > 0) {
    for (const s of input.selections) {
      if (!s || typeof s.shippingZoneId !== 'string' || !s.shippingZoneId) return { error: 'Invalid shipping selection.' };
      const key = s.profileId ? String(s.profileId) : GENERAL_GROUP_KEY;
      if (!groupKeys.includes(key)) return { error: 'This shipping option is not available for your cart.' };
      if (byGroup.has(key)) return { error: 'Choose only one shipping option per delivery group.' };
      byGroup.set(key, s.shippingZoneId);
    }
  } else if (input.shippingZoneId) {
    if (groupKeys.length !== 1) return { error: 'Choose a shipping option for each delivery group.' };
    byGroup.set(groupKeys[0], String(input.shippingZoneId));
  }
  for (const k of groupKeys) if (!byGroup.has(k)) return { error: 'Choose a shipping option for each delivery group.' };
  return { byGroup };
}

/** A delivery address is needed unless EVERY group chose a pickup zone. */
export function addressRequired(selectedZoneTypes: (string | null | undefined)[]): boolean {
  return selectedZoneTypes.length === 0 || selectedZoneTypes.some((t) => t !== 'pickup');
}

const EARTH_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in km between two lat/lng points. */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

const hasCoords = (p?: { latitude?: number | null; longitude?: number | null } | null): p is { latitude: number; longitude: number } =>
  !!p && typeof p.latitude === 'number' && typeof p.longitude === 'number' && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);

/**
 * Local-delivery radius rule. Returns `null` when it cannot be evaluated (no radius on the zone, the ship-from
 * location has no coordinates, or the buyer's address has none) so the caller falls back to the postcode / city
 * match; otherwise whether the buyer is inside the radius.
 */
export function radiusMatch(
  zone: { radiusKm?: number | null },
  origin?: { latitude?: number | null; longitude?: number | null } | null,
  dest?: { latitude?: number | null; longitude?: number | null } | null,
): boolean | null {
  const r = zone.radiusKm;
  if (r == null || !(r > 0)) return null;
  if (!hasCoords(origin) || !hasCoords(dest)) return null;
  return haversineKm(origin, dest) <= r;
}
