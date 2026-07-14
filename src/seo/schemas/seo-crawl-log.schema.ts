/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoCrawlLogDocument = SeoCrawlLog & Document;

/**
 * Bot-hit log — written in batches by `SeoMonitoringService`'s in-memory
 * buffer (flushed via `insertMany` every ~10s), never one write per request
 * (see architecture plan Refinement #5: a synchronous DB write per crawler
 * hit would put unbounded external traffic directly on a hot write path).
 * TTL-indexed so old rows self-purge rather than growing forever.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class SeoCrawlLog {
  @Prop({ type: String, required: true })
  userAgent: string;

  @Prop({ type: String, required: true })
  path: string;

  @Prop({ type: Number, required: true })
  statusCode: number;

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: String, default: null })
  ip: string | null;

  @Prop({ type: String, default: null })
  botName: string | null; // e.g. 'Googlebot', 'Bingbot' — parsed from userAgent once, not re-parsed on read

  @Prop({ type: Date, default: Date.now, expires: 60 * 60 * 24 * 60 }) // 60-day retention
  createdAt: Date;
}

export const SeoCrawlLogSchema = SchemaFactory.createForClass(SeoCrawlLog);
SeoCrawlLogSchema.index({ storeId: 1, createdAt: -1 });
SeoCrawlLogSchema.index({ botName: 1, createdAt: -1 });
