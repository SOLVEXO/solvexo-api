/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoIndexSnapshotDocument = SeoIndexSnapshot & Document;

/** Periodic GSC/Bing coverage pull — one row per (scope, provider, day). */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class SeoIndexSnapshot {
  @Prop({ type: String, enum: ['platform', 'store'], required: true })
  scope: 'platform' | 'store';

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: String, enum: ['gsc', 'bing'], required: true })
  provider: 'gsc' | 'bing';

  @Prop({ type: Number, default: 0 })
  indexedCount: number;

  @Prop({ type: Number, default: 0 })
  excludedCount: number;

  @Prop({ type: [String], default: [] })
  errors: string[];

  @Prop({ type: Date, required: true })
  snapshotDate: Date;
}

export const SeoIndexSnapshotSchema = SchemaFactory.createForClass(SeoIndexSnapshot);
SeoIndexSnapshotSchema.index({ scope: 1, storeId: 1, provider: 1, snapshotDate: -1 });
