/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';

export type PosReceiptDeliveryDocument = HydratedDocument<PosReceiptDelivery>;
export const RECEIPT_CHANNELS = ['email', 'sms'] as const;
export type ReceiptChannel = (typeof RECEIPT_CHANNELS)[number];
/**
 * G5.3 — one receipt sent out of the app (e-mail / SMS): only the public receipt link, the store name and the total were sent. APPEND-ONLY; the
 * recipient is kept masked (and as a hash, for the per-recipient rate limit), with where the consent came from.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosReceiptDelivery {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) saleId: string;
  @Prop({ type: String, enum: RECEIPT_CHANNELS, required: true }) channel: ReceiptChannel;
  @Prop({ type: String, required: true }) toMasked: string;
  @Prop({ type: String, required: true }) toHash: string;
  /** on_file = the customer's own contact on their record; given_for_sale = the customer gave it for this sale (the cashier confirmed) */
  @Prop({ type: String, enum: ['on_file', 'given_for_sale'], required: true }) consent: 'on_file' | 'given_for_sale';
  @Prop({ type: String, enum: ['sent', 'failed'], required: true }) status: 'sent' | 'failed';
  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
}
export const PosReceiptDeliverySchema = SchemaFactory.createForClass(PosReceiptDelivery);
PosReceiptDeliverySchema.index({ storeId: 1, saleId: 1, channel: 1, createdAt: -1 });
PosReceiptDeliverySchema.index({ storeId: 1, createdAt: -1 });
makeAppendOnly(PosReceiptDeliverySchema);
