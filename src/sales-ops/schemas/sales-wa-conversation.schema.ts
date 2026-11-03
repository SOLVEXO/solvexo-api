/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesWaConversationDocument = SalesWaConversation & Document;

/** One person's WhatsApp chat with Solvexo's sales number. Always linked to a lead (created on their first message). */
@Schema({ timestamps: true, collection: 'sales_wa_conversations' })
export class SalesWaConversation {
  /** Their WhatsApp id: international digits, e.g. 923001234567. */
  @Prop({ type: String, required: true, unique: true }) waId: string;
  @Prop({ type: String, default: null }) profileName: string | null;
  @Prop({ type: String, default: null, index: true }) leadId: string | null;
  /** Their last message: free-form replies are allowed for 24 hours after it. */
  @Prop({ type: Date, default: null }) lastInboundAt: Date | null;
  @Prop({ type: Date, default: null, index: true }) lastMessageAt: Date | null;
  @Prop({ type: String, default: null }) lastMessageText: string | null;
  @Prop({ type: Number, default: 0 }) unread: number;
  /** The AI assistant's suggested reply to their latest message; a person sends it (or edits it). */
  @Prop({ type: Object, default: null }) aiDraft: {
    text: string;
    createdAt: Date;
    forMessageId: string | null;
  } | null;
}

export const SalesWaConversationSchema =
  SchemaFactory.createForClass(SalesWaConversation);
