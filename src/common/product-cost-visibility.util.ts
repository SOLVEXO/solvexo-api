/* eslint-disable prettier/prettier */

/** Real split between Shopify's "View products" and "View cost per item"
 *  permissions — previously `products.view` silently also exposed
 *  `ProductVariant.costPrice` to any staff member with product view access
 *  at all, no separate gate (the Tier-1 audit's disclosed gap). A
 *  seller/admin caller always sees everything, same as every other
 *  permission check in this app. */
export function canViewProductCost(user: any): boolean {
  if (user.role !== 'staff') return true;
  const permissions: string[] = Array.isArray(user.permissions) ? user.permissions : [];
  return permissions.includes('products.view_cost');
}

/** Strips `costPrice` from a single variant-shaped object — a shallow,
 *  new-object copy (never mutates the original), safe to call on a lean
 *  Mongo doc/plain object either way. */
export function omitCostPrice<T extends Record<string, any>>(variant: T): Omit<T, 'costPrice'> {
  if (!variant) return variant;
  const { costPrice, ...rest } = variant;
  return rest;
}

/** Applies `omitCostPrice` across every variant in an array, in place of a
 *  bare `.map()` at every call site. */
export function omitCostPriceFromVariants<T extends Record<string, any>>(variants: T[]): Omit<T, 'costPrice'>[] {
  return (variants ?? []).map(omitCostPrice);
}
