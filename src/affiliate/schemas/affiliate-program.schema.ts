import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AffiliateProgramDocument = AffiliateProgram & Document;

/** One doc per store — same singleton-per-store convention as
 *  AbandonedCartSettings/GiftCardSettings. Unlike abandoned-cart recovery
 *  (on by default), an affiliate program is OFF by default: a commission
 *  rate is a real business decision a seller has to make deliberately,
 *  there's no safe universal default the way "remind an abandoning buyer"
 *  is. Absence of a doc means "disabled, 10% default rate ready to go the
 *  moment the seller turns it on" — see AffiliateService.getOrDefaultProgram. */
@Schema({ timestamps: true })
export class AffiliateProgram {
  @Prop({ required: true, unique: true })
  storeId: string;

  @Prop({ type: Boolean, default: false })
  enabled: boolean;

  @Prop({ type: String, enum: ['percentage', 'fixed'], default: 'percentage' })
  commissionType: 'percentage' | 'fixed';

  // percentage: 0-100. fixed: a flat USD amount per converted order.
  @Prop({ type: Number, default: 10, min: 0 })
  commissionValue: number;

  // How long a click's attribution stays valid — mirrors the "cookie
  // window" concept from Shopify affiliate apps. Enforced client-side (the
  // storefront only keeps the ?ref= attribution in localStorage for this
  // many days); the backend doesn't independently re-check it against the
  // click timestamp, since AffiliateService doesn't record individual click
  // timestamps (only a running counter — see Affiliate.totalClicks).
  @Prop({ type: Number, default: 30, min: 1 })
  cookieWindowDays: number;

  @Prop({ default: false })
  isDelete: boolean;
}

export const AffiliateProgramSchema = SchemaFactory.createForClass(AffiliateProgram);
