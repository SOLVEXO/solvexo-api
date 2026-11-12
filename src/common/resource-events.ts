import { EventEmitter } from 'events';

/**
 * In-process signal "this product / variant stock / customer was written". Emitted by schema hooks, so EVERY write path is covered
 * without each service knowing about webhooks (same idea as order-events.ts). Listeners must be idempotent and cheap: they coalesce.
 */
export const resourceEvents = new EventEmitter();
resourceEvents.setMaxListeners(20);
export const RESOURCE_CHANGED = 'resource.changed';

export type ResourceKind = 'product' | 'variant_stock' | 'customer';
export interface ResourceChange { kind: ResourceKind; id: string; created: boolean }

export function emitResourceChanged(change: ResourceChange): void {
  try { resourceEvents.emit(RESOURCE_CHANGED, change); } catch { /* a listener must never break a write */ }
}

const flat = (update: any): string => { try { return JSON.stringify(update ?? {}); } catch { return ''; } };
const COUNTER_ONLY = /^(?:viewCount|wishlistCount|purchaseCount|averageRating|ratingSum|totalRatings|updatedAt)$/;

/** A product update that matters to a merchant: anything beyond the storefront counters (views, ratings...). */
export function productUpdateMatters(update: any): boolean {
  if (!update) return false;
  if (Array.isArray(update)) return true;
  const keys = Object.keys(update.$set ?? {}).concat(Object.keys(update.$unset ?? {}), Object.keys(update.$push ?? {}), Object.keys(update.$pull ?? {}), Object.keys(update.$addToSet ?? {}));
  const plainKeys = Object.keys(update).filter((k) => !k.startsWith('$'));
  return keys.concat(plainKeys).some((k) => !COUNTER_ONLY.test(k.split('.')[0]));
}

/** A variant update that moves stock (on-hand, reservation, damaged, in transit, expired). */
export function stockUpdateMatters(update: any): boolean {
  return /"(?:stock|committedStock|damagedStock|inTransitStock|expiredStock)"/.test(flat(update)) || /\$(?:stock|committedStock)/.test(flat(update));
}

const idOfFilter = (q: any): string | null => {
  const id = q?.getFilter?.()?._id;
  return typeof id === 'string' || (id && typeof id === 'object' && /^[a-f0-9]{24}$/i.test(String(id))) ? String(id) : null;
};

/** Registers the hooks on a schema. `created` hooks fire once per new document (customers); `matters` filters updates. */
export function attachResourceHooks(schema: any, kind: ResourceKind, opts: { matters?: (update: any) => boolean; onCreate?: boolean; onUpdate?: boolean; createFilter?: (doc: any) => boolean } = {}): void {
  const { matters = () => true, onCreate = false, onUpdate = true, createFilter = () => true } = opts;
  schema.pre('save', function (this: any) { this.$locals.wasNew = this.isNew; });
  schema.post('save', function (doc: any) {
    const wasNew = !!doc?.$locals?.wasNew;
    if (wasNew ? (onCreate && createFilter(doc)) : onUpdate) emitResourceChanged({ kind, id: String(doc._id), created: wasNew });
  });
  if (!onUpdate) return;
  schema.post('findOneAndUpdate', function (this: any, doc: any) { if (doc?._id && matters(this.getUpdate?.())) emitResourceChanged({ kind, id: String(doc._id), created: false }); });
  schema.post('updateOne', function (this: any) { const id = idOfFilter(this); if (id && matters(this.getUpdate?.())) emitResourceChanged({ kind, id, created: false }); });
}
