import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RenewalInvoiceDocument = RenewalInvoice & Document;

export const OPEN_INVOICE = ['awaiting', 'submitted', 'overdue'];

/**
 * One payment the buyer owes for one membership cycle under MANUAL billing (the seller is paid directly:
 * bank transfer / JazzCash / EasyPaisa / the seller's own method). Solvexo only tracks the request and the proof.
 */
@Schema({ timestamps: true, collection: 'renewalinvoices' })
export class RenewalInvoice {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) subscriptionId: string;
  @Prop({ required: true }) customerId: string;
  @Prop({ required: true }) planId: string;
  @Prop({ required: true }) cycleKey: string; // 'first' or 'renew:<period end date>': one invoice per cycle

  @Prop({ type: Number, required: true, min: 0 }) amount: number;
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Date, required: true }) dueAt: Date;
  @Prop({ type: String, enum: ['awaiting', 'submitted', 'paid', 'overdue', 'void'], default: 'awaiting' }) status: string;

  /** The seller's payment instructions as they were when the invoice was created. */
  @Prop({ type: [{ label: String, details: String, _id: false }], default: [] }) instructions: { label: string; details: string }[];

  @Prop({ type: { publicId: String, fileName: String, mimeType: String, size: Number, uploadedAt: Date, _id: false }, default: null })
  proof: { publicId: string; fileName: string; mimeType: string; size: number; uploadedAt: Date } | null;
  @Prop({ type: String, default: null }) reference: string | null;
  @Prop({ type: String, default: null }) senderName: string | null;
  @Prop({ type: Date, default: null }) submittedAt: Date | null;
  @Prop({ type: Number, default: 0 }) submissionCount: number;

  @Prop({ type: String, default: null }) reviewedBy: string | null;
  @Prop({ type: Date, default: null }) reviewedAt: Date | null;
  @Prop({ type: String, default: null }) rejectionReason: string | null;
  @Prop({ type: Number, default: 0 }) rejectionCount: number;
  @Prop({ type: Date, default: null }) paidAt: Date | null;

  @Prop({ type: { d7: Date, d3: Date, d0: Date, manual: Date, _id: false }, default: () => ({}) })
  remindersSent: { d7?: Date; d3?: Date; d0?: Date; manual?: Date };

  @Prop({ type: [{ at: Date, action: String, by: String, note: String, _id: false }], default: [] })
  audit: { at: Date; action: string; by: string; note: string }[];
}
export const RenewalInvoiceSchema = SchemaFactory.createForClass(RenewalInvoice);
RenewalInvoiceSchema.index({ subscriptionId: 1, cycleKey: 1 }, { unique: true });
RenewalInvoiceSchema.index({ storeId: 1, status: 1, dueAt: 1 });
RenewalInvoiceSchema.index({ storeId: 1, customerId: 1, status: 1 });
