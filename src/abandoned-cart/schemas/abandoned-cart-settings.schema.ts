import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AbandonedCartSettingsDocument = AbandonedCartSettings & Document;

/** One doc per store — same singleton-per-store convention as GiftCardSettings/
 *  LoyaltyProgram. Recovery is ON BY DEFAULT for every store (matches
 *  Shopify's own abandoned-checkout recovery, which is automatic/free/on —
 *  a seller who never visits this settings screen still gets a real
 *  reminder sent), so absence of a doc means "enabled with defaults", never
 *  "disabled" — see AbandonedCartService.getOrDefaultSettings. */
@Schema({ timestamps: true })
export class AbandonedCartSettings {
  @Prop({ required: true, unique: true })
  storeId: string;

  @Prop({ type: Boolean, default: true })
  enabled: boolean;

  // How long a checkout must sit untouched before it counts as abandoned.
  // A multi-seller cart is evaluated against every participating store's own
  // setting — see AbandonedCartService.processAbandonedCarts — so one
  // seller's shorter delay can trigger the single reminder email sooner.
  @Prop({ type: Number, default: 60, min: 5 })
  delayMinutes: number;

  @Prop({ type: String, default: "You left something in your cart" })
  subject: string;

  // Supports {{customerName}}, {{storeName}}, {{cartUrl}} tokens — replaced
  // at send time by AbandonedCartService.renderTemplate.
  @Prop({
    type: String,
    default:
      "Hi {{customerName}}, you still have items waiting in your cart at {{storeName}}. Complete your order before they're gone: {{cartUrl}}",
  })
  message: string;

  @Prop({ default: false })
  isDelete: boolean;
}

export const AbandonedCartSettingsSchema = SchemaFactory.createForClass(AbandonedCartSettings);
