import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosPurchaseDocument = PosPurchase & Document;

/**
 * One row per POS plan purchase (not per store — a store accumulates
 * purchase history over time). A store's current status is derived from its
 * most recent PosPurchase by `purchasedAt`: `expiresAt > now` = active,
 * otherwise expired/none — never stored as a separate flag, so it can't
 * drift out of sync with `expiresAt`.
 *
 * `planNameSnapshot`/`priceSnapshot`/`currencySnapshot`/`durationInDaysSnapshot`
 * are copied at webhook time, not joined live from PosPlan — if admin edits
 * a plan's price/name/duration later, past purchases still show what was
 * actually charged (and `expiresAt`, already computed once at purchase time,
 * never recalculates against a since-edited duration).
 */
@Schema({ timestamps: true })
export class PosPurchase {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) planId: string;

  @Prop({ type: String, required: true }) planNameSnapshot: string;
  @Prop({ type: Number, required: true }) priceSnapshot: number;
  @Prop({ type: String, required: true }) currencySnapshot: string;
  @Prop({ type: Number, required: true }) durationInDaysSnapshot: number;

  @Prop({ type: String, required: true }) stripeCheckoutSessionId: string;
  @Prop({ type: String, default: null }) stripePaymentIntentId: string | null;

  @Prop({ type: Date, required: true }) purchasedAt: Date;
  @Prop({ type: Date, required: true }) expiresAt: Date;
}

export const PosPurchaseSchema = SchemaFactory.createForClass(PosPurchase);
PosPurchaseSchema.index({ storeId: 1, purchasedAt: -1 });
PosPurchaseSchema.index({ sellerId: 1 });
// Stripe redelivers webhooks — this is what makes a retry a no-op instead of
// a duplicate purchase record (see PosPlansWebhookService.receive).
PosPurchaseSchema.index({ stripeCheckoutSessionId: 1 }, { unique: true });
