/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CampaignDocument = Campaign & Document;

// Platform-wide sale event (e.g. "Summer Sale Weekend") created by admin.
// Sellers opt individual stores in via participatingStoreIds — separate from
// a seller's own store-level Coupon, which stays entirely under their control.
@Schema({ timestamps: true })
export class Campaign {
  @Prop({ required: true })
  name: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: String, default: null })
  bannerImage: string | null;

  @Prop({ required: true })
  startDate: Date;

  @Prop({ required: true })
  endDate: Date;

  @Prop({ type: String, enum: ['draft', 'active', 'ended'], default: 'draft' })
  status: string;

  // optional platform-suggested default discount sellers can apply when opting in
  @Prop({ type: String, enum: ['percentage', 'fixed'], default: null })
  discountType: 'percentage' | 'fixed' | null;

  @Prop({ type: Number, default: null })
  discountValue: number | null;

  @Prop({ type: [String], default: [] })
  participatingStoreIds: string[];

  @Prop({ type: String, default: null })
  createdBy: string | null;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const CampaignSchema = SchemaFactory.createForClass(Campaign);

CampaignSchema.index({ status: 1, startDate: 1, endDate: 1 });
