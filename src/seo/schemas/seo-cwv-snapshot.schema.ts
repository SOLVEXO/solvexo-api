/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoCoreWebVitalsSnapshotDocument = SeoCoreWebVitalsSnapshot & Document;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class SeoCoreWebVitalsSnapshot {
  @Prop({ type: String, required: true })
  url: string;

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: Number, default: null }) lcp: number | null; // Largest Contentful Paint, ms
  @Prop({ type: Number, default: null }) inp: number | null; // Interaction to Next Paint, ms
  @Prop({ type: Number, default: null }) cls: number | null; // Cumulative Layout Shift, unitless

  @Prop({ type: String, enum: ['crux', 'psi'], required: true })
  source: 'crux' | 'psi';

  @Prop({ type: Date, default: Date.now })
  measuredAt: Date;
}

export const SeoCoreWebVitalsSnapshotSchema = SchemaFactory.createForClass(SeoCoreWebVitalsSnapshot);
SeoCoreWebVitalsSnapshotSchema.index({ url: 1, measuredAt: -1 });
SeoCoreWebVitalsSnapshotSchema.index({ storeId: 1, measuredAt: -1 });
