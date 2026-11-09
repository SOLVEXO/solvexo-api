/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import '../../common/schema-types/minor-money';
import { isoExponent, toMinor } from '../../common/money-minor.util';

export type StockAdjustmentDocument = StockAdjustment & Document;

export const STOCK_ADJUSTMENT_REASONS = [
  'restocked', 'damaged', 'return', 'correction', 'other',
  // 'purchase_received' — a Purchase Order receipt (PurchaseOrdersService.receive)
  // gets its own reason so history reads "PO #123 received" instead of the
  // generic 'restocked', without needing a schema change.
  'purchase_received',
  // 'write_off' — permanently discarding units already sitting in the
  // damagedStock pool (InventoryService.writeOffDamagedStock) — distinct
  // from 'damaged' itself, which only MOVES units into that pool (they stay
  // on-hand, just unsellable) rather than removing them from existence.
  'write_off',
  // 'supplier_return' — units sent back to a supplier (SupplierReturnsService); 'expired' — a lot that passed its expiry
  // date was written off (InventoryService.writeOffLot).
  'supplier_return', 'expired',
] as const;
export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number];

/** A real, immutable audit-trail row for every manual stock change made from
 *  the Inventory page — Shopify's own "Inventory History" equivalent. Never
 *  written for a checkout/order-driven decrement (those are a normal,
 *  expected part of selling, not something a seller needs to review) —
 *  only for a seller's own deliberate adjustment (restock, damage, count
 *  correction, etc.), which is the actual thing worth a reviewable history. */
@Schema({ timestamps: true })
export class StockAdjustment {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;

  // Which physical branch this adjustment happened at — null for a
  // single-location store (the overwhelming majority) where this concept
  // doesn't apply at all. See VariantLocationStock/StoreLocation.
  @Prop({ type: String, default: null }) locationId: string | null;

  // Denormalized so history reads don't need a join back to Product/Variant
  // for data that never changes after the fact anyway.
  @Prop({ type: String, required: true }) productName: string;
  @Prop({ type: String, default: null }) sku: string | null;

  @Prop({ type: Number, required: true }) previousStock: number;
  @Prop({ type: Number, required: true }) newStock: number;
  @Prop({ type: Number, required: true }) delta: number;

  @Prop({ type: String, enum: STOCK_ADJUSTMENT_REASONS, required: true })
  reason: StockAdjustmentReason;
  @Prop({ type: String, default: null }) note: string | null;

  @Prop({ type: String, required: true }) adjustedBy: string;
  @Prop({ type: String, default: null }) adjustedByName: string | null;

  /** G3.1 (D5): unit cost to record on the stock-ledger row (e.g. a purchase receipt's own cost); when absent the variant's weighted-average cost at that moment is used */
  @Prop({ type: 'MinorMoney', default: null }) unitCostMinor?: number | null;
}

export const StockAdjustmentSchema = SchemaFactory.createForClass(StockAdjustment);
StockAdjustmentSchema.index({ variantId: 1, createdAt: -1 });
StockAdjustmentSchema.index({ storeId: 1, createdAt: -1 });

const MOVEMENT_TYPE: Record<string, string> = { restocked: 'adjustment', damaged: 'adjustment', correction: 'adjustment', other: 'adjustment', return: 'return', purchase_received: 'receive', write_off: 'write_off', supplier_return: 'supplier_return', expired: 'expired' };

/**
 * G3.1: every stock adjustment — manual, purchase receipt, supplier return, write-off, expiry, count posting — also writes its row in the stock ledger (`StockMovement`),
 * in the adjustment's OWN session, so the two commit or abort together. Skipped only when the ledger model is not registered on this connection.
 */
StockAdjustmentSchema.post('save', async function (doc: any) {
  const models = doc?.db?.models;
  const Movement = models?.StockMovement;
  if (!Movement || !doc.delta) return;
  // the ON-HAND effect is what the adjustment really did to `stock` (a 'damaged' adjustment moves units to the damaged pool and leaves `stock` alone)
  const stockEffect = typeof doc.newStock === 'number' && typeof doc.previousStock === 'number' ? doc.newStock - doc.previousStock : doc.delta;
  const damagedDelta = doc.reason === 'damaged' ? Math.abs(doc.delta) : doc.reason === 'write_off' ? -Math.abs(doc.delta) : 0;
  let cost: number | null = doc.unitCostMinor ?? null;
  if (cost === null && models.ProductVariant) {
    const q = models.ProductVariant.findById(doc.variantId).select('costPrice costPriceMinor');
    const sess = typeof doc.$session === 'function' ? doc.$session() : null;
    const v: any = await (sess ? q.session(sess) : q).lean();
    if (v?.costPriceMinor !== null && v?.costPriceMinor !== undefined) cost = Number(v.costPriceMinor);
    else if (v?.costPrice !== null && v?.costPrice !== undefined) {
      const st: any = models.Store ? await models.Store.findById(doc.storeId).select('baseCurrency').lean() : null;
      cost = toMinor(Number(v.costPrice), isoExponent(st?.baseCurrency));
    }
  }
  try {
    await Movement.create([{
      storeId: doc.storeId, variantId: doc.variantId, productId: doc.productId, sku: doc.sku ?? null, productName: doc.productName ?? null, locationId: doc.locationId ?? null,
      type: MOVEMENT_TYPE[doc.reason] ?? 'adjustment', qtyDelta: stockEffect, damagedDelta, unitCostMinor: cost, refType: 'adjustment', refId: String(doc._id), reason: doc.reason, note: doc.note ?? null,
      employeeId: doc.adjustedBy ?? null, dedupeKey: `adjustment:${String(doc._id)}`,
    }], typeof doc.$session === 'function' && doc.$session() ? { session: doc.$session() } : undefined);
  } catch (e: any) {
    if (e?.code !== 11000) throw e; // a duplicate = already written
  }
});
