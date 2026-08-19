import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AutomaticDiscountDocument = AutomaticDiscount & Document;

/**
 * A seller's own no-code, auto-applied discount — the piece the manual
 * Coupon system doesn't cover (a buyer never types anything; it's resolved
 * server-side at checkout creation, same layer as an admin platform
 * Campaign — see CheckoutService.createCheckout's discount pass). Scoped
 * to the seller's own store, unlike Campaign (admin-created, seller opts in).
 */
@Schema({ timestamps: true })
export class AutomaticDiscount {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, enum: ['percentage', 'fixed'] })
  discountType: 'percentage' | 'fixed';

  @Prop({ required: true })
  discountValue: number;

  // Only meaningful when discountType === 'fixed' — the issuing store's own
  // baseCurrency, same convention as Coupon.currency for a seller coupon.
  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ required: true, enum: ['store', 'category', 'products'], default: 'store' })
  target: 'store' | 'category' | 'products';

  // Only meaningful when target === 'category'.
  @Prop({ type: [String], default: [] })
  categoryIds: string[];

  // Only meaningful when target === 'products'.
  @Prop({ type: [String], default: [] })
  productIds: string[];

  @Prop({ type: Number, default: null })
  minOrderAmount: number | null;

  // null = starts immediately / never ends — same "open-ended" convention as
  // Coupon.expiresAt: null.
  @Prop({ type: Date, default: null })
  startsAt: Date | null;

  @Prop({ type: Date, default: null })
  endsAt: Date | null;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const AutomaticDiscountSchema = SchemaFactory.createForClass(AutomaticDiscount);

AutomaticDiscountSchema.index({ storeId: 1, isActive: 1 });
