/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { stockLinesForItem } from './bundle.util';

/**
 * Pre-order (Shopify purchase-option parity, WITHOUT deposits): payment is taken normally at checkout. A variant with
 * `preorder.enabled` can be ordered beyond its stock; each unit sold that way counts against `preorder.limit` and the
 * order line is flagged `isPreorder` with the expected date. Different from `allowBackorder`, which is untouched.
 */
export interface Preorder { enabled: boolean; expectedDate?: Date | string | null; limit?: number | null; message?: string | null; sold?: number }

export const MAX_PREORDER_MESSAGE = 200;

/** Whether the pre-order may fill a line the stock cannot (called only when stock is short). */
export function preorderCanFill(pre: Preorder | null | undefined): boolean {
  return !!pre?.enabled;
}

export function preorderRemaining(pre: Preorder | null | undefined): number | null {
  if (!pre?.enabled || !(typeof pre.limit === 'number' && pre.limit > 0)) return null;
  return Math.max(0, pre.limit - (pre.sold ?? 0));
}

/** What the storefront shows for a variant: only while pre-order is on AND the item is out of stock. */
export function preorderPublicView(pre: Preorder | null | undefined, available: number) {
  if (!pre?.enabled || available > 0) return null;
  const remaining = preorderRemaining(pre);
  return {
    label: 'Pre-order',
    expectedDate: pre.expectedDate ? new Date(pre.expectedDate).toISOString() : null,
    message: pre.message ?? null,
    remaining,
    soldOut: remaining === 0,
  };
}

/** Validates/normalizes a seller's pre-order settings. `null` input (or enabled:false with nothing else) turns it off. */
export function normalizePreorderInput(raw: unknown, previousSold = 0, now = new Date()): Preorder | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('preorder must be an object');
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['enabled', 'expectedDate', 'limit', 'message'].includes(k)) throw new BadRequestException(`Unknown preorder field "${k}"`);
  const enabled = r.enabled === true;
  let expectedDate: Date | null = null;
  if (r.expectedDate !== undefined && r.expectedDate !== null && r.expectedDate !== '') {
    const d = new Date(String(r.expectedDate));
    if (Number.isNaN(d.getTime())) throw new BadRequestException('Expected date is not a valid date');
    if (enabled && d.getTime() < now.getTime() - 86_400_000) throw new BadRequestException('Expected date must be in the future');
    expectedDate = d;
  }
  let limit: number | null = null;
  if (r.limit !== undefined && r.limit !== null && r.limit !== '') {
    if (typeof r.limit !== 'number' || !Number.isInteger(r.limit) || r.limit < 1 || r.limit > 1_000_000) throw new BadRequestException('Pre-order limit must be a whole number of at least 1');
    limit = r.limit;
  }
  let message: string | null = null;
  if (typeof r.message === 'string' && r.message.trim()) message = r.message.trim().slice(0, MAX_PREORDER_MESSAGE);
  return { enabled, expectedDate, limit, message, sold: previousSold };
}

/** Pre-order lines whose units are not on the shelf yet: on-hand stock < the units this shipment needs. */
export function preorderBlockers(lines: { item: any; quantity: number }[], variants: Map<string, any>): { name: string; expectedDate: Date | null }[] {
  const out: { name: string; expectedDate: Date | null }[] = [];
  for (const { item, quantity } of lines) {
    if (!item?.isPreorder) continue;
    for (const sl of stockLinesForItem({ ...item, quantity })) {
      const v = variants.get(sl.variantId);
      if (v && !v.unlimitedStock && (Number(v.stock) || 0) < sl.quantity) { out.push({ name: item.name, expectedDate: item.preorderExpectedDate ?? null }); break; }
    }
  }
  return out;
}

/**
 * Fulfilment guard: shipping a pre-order line before its stock arrived is refused unless the seller explicitly overrides
 * (`overridePreorder: true`). Returns whether an override was actually needed (caller writes the audit log).
 */
export async function assertPreorderShippable(productVariantModel: any, lines: { item: any; quantity: number }[], override: boolean): Promise<{ overridden: boolean; names: string[] }> {
  const pre = lines.filter((l) => l.item?.isPreorder);
  if (pre.length === 0) return { overridden: false, names: [] };
  const ids = [...new Set(pre.flatMap((l) => stockLinesForItem({ ...l.item, quantity: l.quantity }).map((s) => s.variantId)))];
  const rows: any[] = await productVariantModel.find({ _id: { $in: ids } }).select('stock unlimitedStock').lean();
  const blockers = preorderBlockers(pre, new Map(rows.map((r) => [String(r._id), r])));
  if (blockers.length === 0) return { overridden: false, names: [] };
  if (!override) {
    const when = blockers[0].expectedDate ? ` (expected ${new Date(blockers[0].expectedDate).toISOString().slice(0, 10)})` : '';
    throw new BadRequestException(`Pre-order item not in stock yet: ${blockers.map((b) => b.name).join(', ')}${when}. Receive stock first, or ship anyway with the pre-order override.`);
  }
  return { overridden: true, names: blockers.map((b) => b.name) };
}
