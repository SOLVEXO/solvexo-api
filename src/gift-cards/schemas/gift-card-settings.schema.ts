import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GiftCardSettingsDocument = GiftCardSettings & Document;

/** One doc per store — same singleton-per-store convention as LoyaltyProgram. */
@Schema({ timestamps: true })
export class GiftCardSettings {
  @Prop({ required: true, unique: true })
  storeId: string;

  // Whether buyers can purchase a gift card on this store's storefront.
  // Manual issuance (GiftCardsService.issueManual) is always available to
  // the seller regardless of this flag — it's a seller tool, not a
  // storefront feature.
  @Prop({ type: Boolean, default: false })
  purchaseEnabled: boolean;

  // Preset amounts the buyer picks from, in the store's own baseCurrency.
  @Prop({ type: [Number], default: [10, 25, 50, 100] })
  denominations: number[];

  @Prop({ type: Boolean, default: true })
  neverExpires: boolean;

  // Only meaningful when neverExpires is false.
  @Prop({ type: Number, default: 12 })
  expiryMonths: number;
}

export const GiftCardSettingsSchema = SchemaFactory.createForClass(GiftCardSettings);
