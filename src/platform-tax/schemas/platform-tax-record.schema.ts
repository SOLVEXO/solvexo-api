/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformTaxRecordDocument = PlatformTaxRecord & Document;

/** Solvexo's own tax actually collected on a one-off charge that has no invoice of its own (promotion, store-app fee, POS plan). One row per paid charge; plan invoices, add-ons and fee bills carry their own tax fields instead. */
@Schema({ timestamps: true })
export class PlatformTaxRecord {
  @Prop({ type: String, enum: ['promotion', 'store_app', 'pos_plan'], required: true }) source: string;
  /** Stripe PaymentIntent id (promotion, store app) or Checkout Session id (POS plan): makes a retried webhook/confirm a no-op. */
  @Prop({ type: String, required: true }) refId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: Number, required: true }) taxAmountUSD: number;
  @Prop({ type: Date, required: true }) collectedAt: Date;
}

export const PlatformTaxRecordSchema = SchemaFactory.createForClass(PlatformTaxRecord);
PlatformTaxRecordSchema.index({ source: 1, refId: 1 }, { unique: true });
PlatformTaxRecordSchema.index({ collectedAt: 1 });
