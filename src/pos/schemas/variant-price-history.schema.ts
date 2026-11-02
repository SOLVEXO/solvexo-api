/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VariantPriceHistoryDocument = VariantPriceHistory & Document;

/**
 * One row per price a variant USED TO have, written whenever a variant's `price` changes (see
 * products/variant-price-history.hooks.ts). Its only job: when an offline POS sale is synced, the server can tell
 * whether the price the till charged was a genuine price of that variant while the sale was being made
 * ("price valid within the offline window") instead of trusting the device. Short-lived by design — rows expire.
 */
@Schema({ timestamps: true })
export class VariantPriceHistory {
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: Number, required: true }) price: number;
  /** When this price stopped being the variant's price. */
  @Prop({ type: Date, required: true }) supersededAt: Date;
}

export const VariantPriceHistorySchema = SchemaFactory.createForClass(VariantPriceHistory);
VariantPriceHistorySchema.index({ variantId: 1, supersededAt: -1 });
// Prices older than the longest offline window (72h by default) can never matter — keep 30 days.
VariantPriceHistorySchema.index({ supersededAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
