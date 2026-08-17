/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { PromotionEntityType } from './promotion-daily-stats.schema';

export type PromotionClickEventDocument = HydratedDocument<PromotionClickEvent>;

// Raw click capture — device/city detail for spot-checking, not aggregated
// historically (see PromotionDailyStats for the rollup dashboards actually
// read). TTL-indexed so this collection self-prunes after ~90 days.
@Schema({ timestamps: true })
export class PromotionClickEvent {
  @Prop({ type: String, required: true })
  entityType: PromotionEntityType;

  @Prop({ required: true })
  entityId: string;

  @Prop({ type: String, enum: ['desktop', 'mobile', 'tablet'], default: 'desktop' })
  device: 'desktop' | 'mobile' | 'tablet';

  @Prop({ type: String, default: null })
  country: string | null;

  @Prop({ type: String, default: null })
  city: string | null;

  @Prop({ type: String, default: null })
  buyerId: string | null;

  createdAt?: Date;
}

export const PromotionClickEventSchema = SchemaFactory.createForClass(PromotionClickEvent);

PromotionClickEventSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
PromotionClickEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
