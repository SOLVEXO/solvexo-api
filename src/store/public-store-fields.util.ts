/** The only Store fields `getStoreById` returns to someone who is not the owner, staff or an admin (all of them are already public on the storefront). */
export const PUBLIC_STORE_BY_ID_FIELDS = [
  '_id', 'name', 'slug', 'logo', 'faviconUrl', 'description', 'tagline', 'status', 'baseCurrency', 'categoryId',
  'privacyMode', 'averageRating', 'reviewCount', 'followersCount', 'contactEmail', 'contactPhone', 'createdAt',
] as const;

export function pickPublicStoreFields(raw: Record<string, unknown>): Record<string, unknown> {
  const pub: Record<string, unknown> = {};
  for (const k of PUBLIC_STORE_BY_ID_FIELDS) if (raw[k] !== undefined) pub[k] = raw[k];
  return pub;
}
