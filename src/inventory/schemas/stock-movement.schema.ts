/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import '../../common/schema-types/minor-money';
import { makeAppendOnly } from '../../pos/schemas/pos-immutable.util';

export type StockMovementDocument = StockMovement & Document;

export const STOCK_MOVEMENT_TYPES = ['sale', 'return', 'void', 'adjustment', 'count', 'receive', 'write_off', 'supplier_return', 'expired', 'transfer_out', 'transfer_in'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/**
 * THE stock ledger (G3.1): one APPEND-ONLY row for every change of the units of a variant — sale, return (restocked), void, manual adjustment, count posting, purchase
 * receipt, write-off, supplier return, expiry — with the signed quantity, the unit cost snapshot (weighted average at that moment, minor units, D5) and who / what caused it.
 * Sales / returns / voids are written INSIDE the same transaction as the sale / refund / void document, so a movement exists exactly when its document does;
 * every `StockAdjustment` (all manual and PO / supplier-return / write-off stock changes) writes its movement in the adjustment's own session.
 * History before this ledger existed is not reconstructed (it is shown as "before the ledger", never guessed). Never edited: a correction is a new row.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class StockMovement {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, default: null }) productId: string | null;
  @Prop({ type: String, default: null }) sku: string | null;
  @Prop({ type: String, default: null }) productName: string | null;
  @Prop({ type: String, default: null }) locationId: string | null;
  @Prop({ type: String, enum: STOCK_MOVEMENT_TYPES, required: true }) type: StockMovementType;
  /** signed: negative = units left (sale, write-off …), positive = units came in (return, receipt …) */
  @Prop({ type: Number, required: true }) qtyDelta: number;
  /** units moved into (+) / out of (−) the DAMAGED pool — those units stay on hand but are not sellable (a 'damaged' adjustment moves no `stock`; a write-off removes from both) */
  @Prop({ type: Number, default: 0 }) damagedDelta: number;
  /** unit cost at that moment (weighted average, minor units of the store currency); null = no cost was recorded for the variant */
  @Prop({ type: 'MinorMoney', default: null }) unitCostMinor: number | null;
  @Prop({ type: String, default: null }) lotId: string | null;
  /** the document that caused it: sale / refund / adjustment / count / purchase_order … */
  @Prop({ type: String, default: null }) refType: string | null;
  @Prop({ type: String, default: null }) refId: string | null;
  @Prop({ type: String, default: null }) reason: string | null;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) registerId: string | null;
  @Prop({ type: String, default: null }) sessionId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  /** at-most-once guard: `${type}:${refId}:${lineKey}` — a retried transaction can never double-write a movement */
  @Prop({ type: String, default: null }) dedupeKey: string | null;
  createdAt?: Date;
}
export const StockMovementSchema = SchemaFactory.createForClass(StockMovement);
StockMovementSchema.set('toJSON', { getters: true, virtuals: false });
StockMovementSchema.set('toObject', { getters: true, virtuals: false });
StockMovementSchema.index({ storeId: 1, variantId: 1, createdAt: -1 });
StockMovementSchema.index({ storeId: 1, createdAt: -1 });
StockMovementSchema.index({ storeId: 1, type: 1, createdAt: -1 });
StockMovementSchema.index({ storeId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } }, name: 'uniq_movement_dedupe' });
makeAppendOnly(StockMovementSchema);
