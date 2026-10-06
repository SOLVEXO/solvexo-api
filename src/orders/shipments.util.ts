/* eslint-disable prettier/prettier */
/**
 * Pure helpers for Shopify-style partial fulfilment (SellerOrder.shipments[]).
 * No DB access — the service validates through these and then does the atomic write.
 */

export interface ShipmentLike { items?: { itemId: string; quantity: number }[] }
export interface LineLike { _id?: any; type?: string; quantity: number; status?: string }
export interface FulfilLine { itemIndex: number; itemId: string; quantity: number }

const DEAD_ITEM_STATES = ['cancelled', 'refunded'];

/** A line that must physically ship: a physical item that is not cancelled/refunded. */
export function isShippableItem(item: LineLike): boolean {
  return item.type === 'physical' && !DEAD_ITEM_STATES.includes(item.status ?? '');
}

/** Units already covered by existing shipments, per OrderItem._id. */
export function shippedQtyByItem(shipments: ShipmentLike[] | null | undefined): Map<string, number> {
  const map = new Map<string, number>();
  for (const sh of shipments ?? []) {
    for (const l of sh.items ?? []) map.set(String(l.itemId), (map.get(String(l.itemId)) ?? 0) + (l.quantity ?? 0));
  }
  return map;
}

/** Remaining (unshipped) quantity per shippable line. Lines with nothing left are omitted. */
export function unshippedLines(items: LineLike[], shipments: ShipmentLike[] | null | undefined): FulfilLine[] {
  const shipped = shippedQtyByItem(shipments);
  const out: FulfilLine[] = [];
  items.forEach((item, itemIndex) => {
    if (!isShippableItem(item)) return;
    const itemId = String(item._id);
    const left = item.quantity - (shipped.get(itemId) ?? 0);
    if (left > 0) out.push({ itemIndex, itemId, quantity: left });
  });
  return out;
}

export type ValidatedFulfil = { ok: true; lines: FulfilLine[]; allShipped: boolean } | { ok: false; error: string };

/** Validates a requested fulfilment against what is still unshipped. */
export function validateFulfilRequest(
  items: LineLike[],
  shipments: ShipmentLike[] | null | undefined,
  requested: { itemId: string; quantity: number }[],
): ValidatedFulfil {
  if (!Array.isArray(requested) || requested.length === 0) return { ok: false, error: 'Select at least one item to fulfil.' };
  const shipped = shippedQtyByItem(shipments);
  const seen = new Set<string>();
  const lines: FulfilLine[] = [];
  for (const r of requested) {
    const itemId = String(r.itemId);
    if (seen.has(itemId)) return { ok: false, error: 'Each item may appear only once.' };
    seen.add(itemId);
    if (!Number.isInteger(r.quantity) || r.quantity < 1) return { ok: false, error: 'Quantity must be a whole number of at least 1.' };
    const itemIndex = items.findIndex((i) => String(i._id) === itemId);
    if (itemIndex === -1) return { ok: false, error: 'An item does not belong to this order.' };
    const item = items[itemIndex];
    if (DEAD_ITEM_STATES.includes(item.status ?? '')) return { ok: false, error: 'A cancelled or refunded item cannot be fulfilled.' };
    if (item.type !== 'physical') return { ok: false, error: 'Only physical items are shipped.' };
    const left = item.quantity - (shipped.get(itemId) ?? 0);
    if (r.quantity > left) return { ok: false, error: left <= 0 ? 'That item is already fully fulfilled.' : `Only ${left} unit(s) of an item are left to fulfil.` };
    lines.push({ itemIndex, itemId, quantity: r.quantity });
  }
  const after = new Map(shipped);
  for (const l of lines) after.set(l.itemId, (after.get(l.itemId) ?? 0) + l.quantity);
  const allShipped = items.every((i) => !isShippableItem(i) || (after.get(String(i._id)) ?? 0) >= i.quantity);
  return { ok: true, lines, allShipped };
}

/** Whether every shippable line is fully covered by shipments (and at least one line exists). */
export function isFullyShipped(items: LineLike[], shipments: ShipmentLike[] | null | undefined): boolean {
  if (!items.some(isShippableItem)) return false;
  return unshippedLines(items, shipments).length === 0;
}

/** Buyer/seller-facing tracking fields only (never label data from client input). */
export function cleanTrackingInput(t: Record<string, unknown> | null | undefined): { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null } | null {
  if (!t || typeof t !== 'object') return null;
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const carrier = s(t.carrier, 80);
  const trackingNumber = s(t.trackingNumber, 120);
  let trackingUrl = s(t.trackingUrl, 500);
  if (trackingUrl && !/^https?:\/\//i.test(trackingUrl)) trackingUrl = null;
  if (!carrier && !trackingNumber && !trackingUrl) return null;
  return { carrier, trackingNumber, trackingUrl };
}

/** Parses the `?items=itemId:qty,itemId:qty` query used by the partial-shipment label-rates call. Returns null when malformed. */
export function parseLabelItemsQuery(raw: unknown): { itemId: string; quantity: number }[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const out: { itemId: string; quantity: number }[] = [];
  for (const part of raw.split(',')) {
    const [itemId, qty] = part.split(':');
    const quantity = Number(qty);
    if (!itemId || !/^[a-f\d]{24}$/i.test(itemId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) return null;
    out.push({ itemId, quantity });
  }
  return out.length > 0 && out.length <= 100 ? out : null;
}

export interface ReturnLineLike extends LineLike { returnStatus?: string; returnLabel?: unknown }

export type ValidatedReturnLabelItems = { ok: true; indexes: number[] } | { ok: false; error: string };

/** A return label can be bought only for approved, physical lines that do not have one yet. */
export function validateReturnLabelItems(items: ReturnLineLike[], itemIds: string[]): ValidatedReturnLabelItems {
  if (!Array.isArray(itemIds) || itemIds.length === 0) return { ok: false, error: 'Select at least one returned item.' };
  const seen = new Set<string>();
  const indexes: number[] = [];
  for (const raw of itemIds) {
    const id = String(raw);
    if (seen.has(id)) return { ok: false, error: 'Each item may appear only once.' };
    seen.add(id);
    const idx = items.findIndex((i) => String(i._id) === id);
    if (idx === -1) return { ok: false, error: 'An item does not belong to this order.' };
    const it = items[idx];
    if (it.type !== 'physical') return { ok: false, error: 'Only physical items can be returned by post.' };
    if (it.returnStatus !== 'approved') return { ok: false, error: 'A return label can be bought only for an approved return.' };
    if (it.returnLabel) return { ok: false, error: 'A return label was already issued for an item.' };
    indexes.push(idx);
  }
  return { ok: true, indexes };
}
