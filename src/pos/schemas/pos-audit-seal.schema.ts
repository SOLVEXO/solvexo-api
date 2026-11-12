/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';

export type PosAuditSealDocument = PosAuditSeal & Document;
/**
 * G4.3 (owner decision 4): the nightly SEAL of one store-day — a SHA-256 over every append-only record the store wrote that day (by insertion time),
 * chained to the previous day's seal. APPEND-ONLY. `verify` recomputes the hash; any edit, deletion or back-dated insertion of a sealed record changes it.
 */
@Schema({ timestamps: { createdAt: 'sealedAt', updatedAt: false } })
export class PosAuditSeal {
  @Prop({ type: String, required: true }) storeId: string;
  /** the store-local calendar day, YYYY-MM-DD */
  @Prop({ type: String, required: true }) day: string;
  @Prop({ type: String, required: true }) timeZone: string;
  @Prop({ type: Date, required: true }) from: Date;
  @Prop({ type: Date, required: true }) to: Date;
  @Prop({ type: String, required: true }) algorithm: string;
  /** per collection: how many records and their own hash */
  @Prop({ type: Object, required: true }) parts: Record<string, { count: number; hash: string }>;
  @Prop({ type: Number, required: true }) count: number;
  @Prop({ type: String, default: null }) prevHash: string | null;
  @Prop({ type: String, required: true }) hash: string;
  sealedAt?: Date;
}
export const PosAuditSealSchema = SchemaFactory.createForClass(PosAuditSeal);
PosAuditSealSchema.index({ storeId: 1, day: 1 }, { unique: true });
makeAppendOnly(PosAuditSealSchema);
