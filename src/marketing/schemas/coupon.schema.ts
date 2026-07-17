/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CouponDocument = Coupon & Document;

@Schema({ timestamps: true })
export class Coupon {
  // 'platform' coupons (admin-issued, e.g. WELCOME10) have no single store —
  // storeId/sellerId stay null and the code is looked up globally instead.
  @Prop({ type: String, enum: ['seller', 'platform'], default: 'seller' })
  scope: 'seller' | 'platform';

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: String, default: null })
  sellerId: string | null;

  // set only for scope: 'platform' — which admin created it
  @Prop({ type: String, default: null })
  adminId: string | null;

  @Prop({ required: true, uppercase: true, trim: true })
  code: string;

  @Prop({ required: true, enum: ['percentage', 'fixed'] })
  discountType: 'percentage' | 'fixed';

  @Prop({ required: true })
  discountValue: number;

  @Prop({ type: Number, default: null })
  minOrderAmount: number | null;

  @Prop({ type: Number, default: null })
  usageLimit: number | null;

  @Prop({ type: Number, default: 0 })
  usageCount: number;

  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const CouponSchema = SchemaFactory.createForClass(Coupon);

// Uniqueness is scope-specific: a seller's code only needs to be unique within
// their own store; a platform code (storeId null) must be unique globally.
CouponSchema.index(
  { storeId: 1, code: 1 },
  { unique: true, partialFilterExpression: { scope: 'seller' } },
);
CouponSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { scope: 'platform' } },
);
CouponSchema.index({ storeId: 1, isActive: 1 });
