/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BackInStockRequestDocument = HydratedDocument<BackInStockRequest>;

/** A shopper's "Notify me when available" on an out-of-stock variant. The
 *  back-in-stock cron notifies every pending request once the variant has
 *  sellable stock again, then flips it to 'notified' — one email per request. */
@Schema({ timestamps: true })
export class BackInStockRequest {
  _id: string;

  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) productId: string;
  @Prop({ required: true }) variantId: string;
  @Prop({ required: true, lowercase: true, trim: true }) email: string;
  @Prop({ type: String, default: null }) userId: string | null;

  @Prop({ type: String, enum: ['pending', 'notified', 'cancelled'], default: 'pending' })
  status: 'pending' | 'notified' | 'cancelled';

  @Prop({ type: Date, default: null }) notifiedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const BackInStockRequestSchema = SchemaFactory.createForClass(BackInStockRequest);
BackInStockRequestSchema.index({ status: 1, variantId: 1 });
BackInStockRequestSchema.index({ storeId: 1, status: 1 });
// One open request per (variant, email) — asking twice is a no-op.
BackInStockRequestSchema.index(
  { variantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
