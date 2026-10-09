/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformAddonPurchaseDocument = PlatformAddonPurchase & Document;

/** One-off or recurring add-on purchases (Extra AI Credits, Additional Staff Seats, Priority Marketplace Placement, etc.) — independent of the base PlatformPlan. */
@Schema({ timestamps: true })
export class PlatformAddonPurchase {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({
    type: String,
    enum: ['extra_ai_credits', 'extra_staff_seat', 'priority_marketplace_placement', 'advanced_tax_compliance', 'sms_notifications'],
    required: true,
  })
  addonType: string;

  @Prop({ type: Boolean, default: false }) recurring: boolean; // one-time (e.g. AI credits top-up) vs monthly (e.g. extra seat, priority placement)
  @Prop({ type: Number, required: true }) priceUSD: number;
  @Prop({ type: Number, default: 1 }) quantity: number;

  @Prop({ type: String, enum: ['active', 'canceled'], default: 'active' }) status: string;
  @Prop({ type: Date, default: null }) nextBillingDate: Date | null; // only for recurring add-ons

  @Prop({ type: String, default: null }) providerChargeId: string | null;

  // Every successful charge of this add-on (the purchase itself, then each monthly renewal) — what the admin's
  // platform revenue is summed from. Purchases made before this field existed have none; readers fall back to
  // one charge of `priceUSD` at `createdAt`.
  @Prop({
    type: [{ _id: false, amountUSD: Number, chargedAt: Date, providerChargeId: { type: String, default: null } }],
    default: [],
  })
  charges: Array<{ amountUSD: number; chargedAt: Date; providerChargeId: string | null }>;
}

export const PlatformAddonPurchaseSchema = SchemaFactory.createForClass(PlatformAddonPurchase);
PlatformAddonPurchaseSchema.index({ storeId: 1, addonType: 1 });
PlatformAddonPurchaseSchema.index({ storeId: 1, status: 1 });
PlatformAddonPurchaseSchema.index({ nextBillingDate: 1, status: 1 });
