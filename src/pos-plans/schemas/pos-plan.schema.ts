import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosPlanDocument = PosPlan & Document;

/**
 * Admin-authored POS access plan — fixed-term, one-time purchase (no
 * recurring billing). `durationInDays` is admin-set directly rather than a
 * month/quarter/year enum, per the "completely dynamic" requirement.
 *
 * Never hard-deleted once a PosPurchase references it — `isActive: false`
 * retires a plan from the seller-facing list while past purchases keep
 * referring to a real document (see PosPurchase's *Snapshot fields for why
 * this still doesn't matter for historical display).
 */
@Schema({ timestamps: true })
export class PosPlan {
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: Number, required: true }) price: number;
  @Prop({ type: String, required: true, default: 'USD' }) currency: string;
  @Prop({ type: Number, required: true }) durationInDays: number;
  @Prop({ type: String, default: null }) description: string | null;
  @Prop({ type: Boolean, default: true }) isActive: boolean;
}

export const PosPlanSchema = SchemaFactory.createForClass(PosPlan);
PosPlanSchema.index({ isActive: 1 });
