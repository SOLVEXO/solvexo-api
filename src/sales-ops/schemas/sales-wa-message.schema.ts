/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesWaMessageDocument = SalesWaMessage & Document;

@Schema({ timestamps: true, collection: 'sales_wa_messages' })
export class SalesWaMessage {
  @Prop({ type: String, required: true, index: true }) conversationId: string;
  @Prop({ type: String, enum: ['in', 'out'], required: true })
  direction: string;
  /** Meta's message id (wamid…): makes webhook deliveries idempotent and carries status updates. */
  @Prop({ type: String, default: null, unique: true, sparse: true })
  waMessageId: string | null;
  /** text, image, audio, template… */
  @Prop({ type: String, default: 'text' }) type: string;
  @Prop({ type: String, default: '' }) text: string;
  /** Outgoing: queued → sent → delivered → read, or failed. Incoming: received. */
  @Prop({ type: String, default: 'received' }) status: string;
  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ type: String, default: null }) sentByAdminId: string | null;
  /** Sent from the AI assistant's draft (possibly edited). */
  @Prop({ type: Boolean, default: false }) fromAiDraft: boolean;
  @Prop({ type: Date, required: true }) at: Date;
}

export const SalesWaMessageSchema =
  SchemaFactory.createForClass(SalesWaMessage);
SalesWaMessageSchema.index({ conversationId: 1, at: -1 });
