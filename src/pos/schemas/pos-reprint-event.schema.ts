/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';

export type PosReprintEventDocument = HydratedDocument<PosReprintEvent>;
export const REPRINT_DOCUMENT_TYPES = ['sale', 'invoice', 'credit_note'] as const;
export type ReprintDocumentType = (typeof REPRINT_DOCUMENT_TYPES)[number];
/** G4.9: the first print of a tax invoice / credit note is the `original`; every later print is a `reprint`. Events written before G4.9 have no kind (= reprint). */
export const PRINT_KINDS = ['original', 'reprint'] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

/**
 * G4.8 — one reprint of a document (the sale's receipt, its tax invoice, or a credit note): who, on which till, who approved (when the store requires a
 * manager PIN to reprint), why. APPEND-ONLY; `reprintNumber` counts the reprints of that one document (1, 2, …) and is unique per document.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosReprintEvent {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true, enum: REPRINT_DOCUMENT_TYPES }) documentType: ReprintDocumentType;
  @Prop({ type: String, required: true }) documentId: string;
  /** the sale the document belongs to (the sale itself for a receipt / invoice) */
  @Prop({ type: String, required: true }) saleId: string;
  /** G4.9 (optional, so every older event stays valid): original | reprint. An original has reprintNumber 0. */
  @Prop({ type: String, enum: PRINT_KINDS }) kind?: PrintKind;
  @Prop({ type: Number, required: true }) reprintNumber: number;
  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) role: string | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  @Prop({ type: String, default: null }) reason: string | null;
}
export const PosReprintEventSchema = SchemaFactory.createForClass(PosReprintEvent);
PosReprintEventSchema.index({ documentType: 1, documentId: 1, reprintNumber: 1 }, { unique: true });
makeAppendOnly(PosReprintEventSchema);
