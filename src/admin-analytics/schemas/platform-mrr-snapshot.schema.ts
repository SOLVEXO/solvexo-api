/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformMrrSnapshotDocument = PlatformMrrSnapshot & Document;

/** End-of-day MRR of every paying store (one row per UTC day), written by SaasMetricsService's daily job.
 *  Lets the SaaS metrics see every movement exactly, including a lapse that was later reactivated. */
@Schema({ timestamps: true, collection: 'platform_mrr_snapshots' })
export class PlatformMrrSnapshot {
  /** UTC day, 'YYYY-MM-DD'. */
  @Prop({ type: String, required: true, unique: true }) date: string;
  @Prop({ type: [{ storeId: String, planId: String, mrr: Number }], default: [], _id: false })
  stores: { storeId: string; planId: string | null; mrr: number }[];
  @Prop({ type: Number, default: 0 }) totalMrr: number;
  @Prop({ type: Number, default: 0 }) payingStores: number;
}

export const PlatformMrrSnapshotSchema = SchemaFactory.createForClass(PlatformMrrSnapshot);
