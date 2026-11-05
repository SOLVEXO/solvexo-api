/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { availableStock } from './stock-availability.util';

/**
 * Product bundles (Shopify Bundles parity). A bundle is an ordinary physical product flagged `isBundle` whose OWN variant
 * carries no stock (`unlimitedStock: true`); selling one sells its components. Every stock movement therefore goes through
 * `stockLinesForItem`, which turns a bundle order/checkout line into one line per component (qty × component qty).
 */
export interface BundleComponent { productId: string; variantId: string; quantity: number }
export interface BundleSnapshotLine extends BundleComponent { name?: string | null }

export const MAX_BUNDLE_COMPONENTS = 20;
export const MAX_COMPONENT_QTY = 999;

export interface StockLine { variantId: string; quantity: number; name: string }

/** The real stock lines behind an order/checkout line: the line itself, or its components for a bundle snapshot. */
export function stockLinesForItem(item: { variantId?: string | null; quantity: number; name?: string | null; bundleComponents?: BundleSnapshotLine[] | null }): StockLine[] {
  const comps = item.bundleComponents;
  if (Array.isArray(comps) && comps.length > 0) {
    return comps.map((c) => ({ variantId: String(c.variantId), quantity: c.quantity * item.quantity, name: c.name ?? item.name ?? 'bundle component' }));
  }
  return item.variantId ? [{ variantId: String(item.variantId), quantity: item.quantity, name: item.name ?? '' }] : [];
}

/** How many whole bundles can be sold: min over components of floor(available / qty). null = every component is unlimited. */
export function bundleAvailability(components: BundleComponent[], variants: Map<string, any>): number | null {
  let min: number | null = null;
  for (const c of components) {
    const v = variants.get(String(c.variantId));
    if (!v) return 0; // a missing/deleted component makes the bundle unsellable
    if (v.unlimitedStock || v.allowBackorder) continue;
    const n = Math.max(0, Math.floor(availableStock(v) / c.quantity));
    min = min === null ? n : Math.min(min, n);
  }
  return min;
}

/** Shape rules that need no database: count, integer quantity ≥ 1, no duplicate variants, valid ids, not itself. */
export function validateBundleShape(raw: unknown, selfProductId: string): BundleComponent[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestException('A bundle needs at least one component');
  if (raw.length > MAX_BUNDLE_COMPONENTS) throw new BadRequestException(`A bundle can have at most ${MAX_BUNDLE_COMPONENTS} components`);
  const seen = new Set<string>();
  return raw.map((c: any, i) => {
    const productId = typeof c?.productId === 'string' ? c.productId : '';
    const variantId = typeof c?.variantId === 'string' ? c.variantId : '';
    const quantity = c?.quantity;
    if (!/^[a-f\d]{24}$/i.test(productId) || !/^[a-f\d]{24}$/i.test(variantId)) throw new BadRequestException(`Component ${i + 1}: invalid product or variant`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_COMPONENT_QTY) throw new BadRequestException(`Component ${i + 1}: quantity must be a whole number of at least 1`);
    if (productId === selfProductId) throw new BadRequestException('A bundle cannot contain itself');
    if (seen.has(variantId)) throw new BadRequestException('Each component variant can only be added once');
    seen.add(variantId);
    return { productId, variantId, quantity };
  });
}

/** Checkout/cart pre-flight: every component must be purchasable in qty × component qty (throws like the normal stock check). */
export async function assertBundleInStock(
  productVariantModel: any, components: BundleComponent[], quantity: number, productName: string,
  isPurchasable: (variant: any, qty: number) => boolean,
): Promise<void> {
  const ids = components.map((c) => c.variantId);
  const rows: any[] = await productVariantModel.find({ _id: { $in: ids }, isDelete: false }).lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  for (const c of components) {
    const v = byId.get(String(c.variantId));
    if (!v || !isPurchasable(v, c.quantity * quantity)) throw new BadRequestException(`Insufficient stock for: ${productName}`);
  }
}

/** An order/checkout line as stock-movement pseudo-lines (components of a bundle, else the line itself). */
export function expandForStock<T extends { type?: string; variantId?: string | null; quantity: number; name?: string | null; bundleComponents?: BundleSnapshotLine[] | null }>(item: T): any[] {
  if (Array.isArray(item.bundleComponents) && item.bundleComponents.length > 0) {
    return stockLinesForItem(item).map((l) => ({ type: 'physical', variantId: l.variantId, quantity: l.quantity, name: l.name }));
  }
  return [item];
}
