/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';

export type PosFiscalRecordDocument = HydratedDocument<PosFiscalRecord>;
/**
 * G5.5 — one fiscalisation ATTEMPT of a tax invoice / credit note, and its outcome. APPEND-ONLY (a retry is a new row with attempt + 1); the document's
 * fiscal block is the latest row. Our own invoice / credit-note numbers are never changed.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosFiscalRecord {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, enum: ['invoice', 'credit_note'], required: true }) documentType: 'invoice' | 'credit_note';
  @Prop({ type: String, required: true }) documentId: string;
  @Prop({ type: String, required: true }) saleId: string;
  @Prop({ type: String, required: true }) documentNumber: string;
  @Prop({ type: Number, required: true }) attempt: number;
  @Prop({ type: String, enum: ['confirmed', 'rejected', 'pending'], required: true }) status: 'confirmed' | 'rejected' | 'pending';
  @Prop({ type: String, default: null }) fiscalInvoiceNumber: string | null;
  @Prop({ type: String, default: null }) qrPayload: string | null;
  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ type: String, required: true }) providerKey: string;
  @Prop({ type: Boolean, default: false }) testMode: boolean;
}
export const PosFiscalRecordSchema = SchemaFactory.createForClass(PosFiscalRecord);
PosFiscalRecordSchema.index({ documentType: 1, documentId: 1, attempt: 1 }, { unique: true });
PosFiscalRecordSchema.index({ storeId: 1, status: 1, createdAt: -1 });
makeAppendOnly(PosFiscalRecordSchema);
