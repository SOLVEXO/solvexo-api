/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PackagePurchaseDocument = PackagePurchase & Document;

/** A buyer's purchase of a ServicePackage — tracks remaining sessions/expiry, redeemed one-by-one via Booking.packagePurchaseId. */
@Schema({ timestamps: true })
export class PackagePurchase {
  @Prop({ type: String, required: true }) packageId: string;
  @Prop({ type: String, required: true }) serviceId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) buyerId: string;

  @Prop({ type: Number, required: true }) sessionsTotal: number;
  @Prop({ type: Number, required: true }) sessionsRemaining: number;

  @Prop({ type: Date, required: true }) purchasedAt: Date;
  @Prop({ type: Date, required: true }) expiresAt: Date;

  @Prop({ type: Number, required: true }) amountPaid: number;
  @Prop({ type: String, default: 'USD' }) currency: string;

  @Prop({ type: String, default: null }) paymentProvider: string | null;
  @Prop({ type: String, default: null }) providerChargeId: string | null;

  @Prop({
    type: String,
    enum: ['active', 'expired', 'fully_used', 'cancelled'],
    default: 'active',
  })
  status: string;
}

export const PackagePurchaseSchema = SchemaFactory.createForClass(PackagePurchase);
PackagePurchaseSchema.index({ buyerId: 1, status: 1 });
PackagePurchaseSchema.index({ storeId: 1 });
PackagePurchaseSchema.index({ serviceId: 1 });
