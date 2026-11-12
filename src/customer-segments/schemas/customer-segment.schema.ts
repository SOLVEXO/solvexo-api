/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import type { SegmentFilter } from '../segment-filter.util';

export type CustomerSegmentDocument = CustomerSegment & Document;

/** A saved, DYNAMIC customer segment: only the filter is stored; members are always computed at use time. */
@Schema({ timestamps: true })
export class CustomerSegment {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true, maxlength: 80 }) name: string;
  @Prop({ type: String, default: '', maxlength: 300 }) description: string;
  /** Normalized by normalizeSegmentFilter before it is ever saved. */
  @Prop({ type: Object, required: true }) filter: SegmentFilter;
  @Prop({ type: String, default: null }) createdBy: string | null;
}

export const CustomerSegmentSchema = SchemaFactory.createForClass(CustomerSegment);
CustomerSegmentSchema.index({ storeId: 1, createdAt: -1 });
