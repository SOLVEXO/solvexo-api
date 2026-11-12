/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';

export type PosCashAttachmentDocument = HydratedDocument<PosCashAttachment>;
/**
 * G5.1 — a receipt photo / PDF attached to a CASH MOVEMENT (cash in / out on a shift, identified by its requestId). APPEND-ONLY: a newer photo is a new row
 * (the latest one is shown), never an edit. The file is in the same private storage as expense receipts (expiring links only).
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosCashAttachment {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sessionId: string;
  /** the cash movement's requestId (its id inside the shift's cashAdjustments) */
  @Prop({ type: String, required: true }) requestId: string;
  @Prop({ type: Object, required: true }) receipt: { publicId: string; resourceType: string; mimeType: string; fileSize: number };
  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
}
export const PosCashAttachmentSchema = SchemaFactory.createForClass(PosCashAttachment);
PosCashAttachmentSchema.index({ storeId: 1, requestId: 1, createdAt: -1 });
makeAppendOnly(PosCashAttachmentSchema);
