/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesRepAccessDocument = SalesRepAccess & Document;
export const MESSAGING_LEVELS = ['off', 'templates', 'full'] as const;
export type MessagingLevel = (typeof MESSAGING_LEVELS)[number];

/**
 * What one sales rep may send to their own clients, set by a manager in Sales Ops → Team. No row means the
 * defaults: templates and their own text, every template (how it worked before this setting existed).
 * Managers (sales.manage) are never limited by it.
 */
@Schema({ timestamps: true, collection: 'sales_rep_access' })
export class SalesRepAccess {
  @Prop({ type: String, required: true, unique: true }) adminId: string;
  /** off · templates (approved templates only) · full (templates + their own replies). */
  @Prop({ type: String, enum: MESSAGING_LEVELS, default: 'full' }) whatsapp: MessagingLevel;
  @Prop({ type: String, enum: MESSAGING_LEVELS, default: 'full' }) email: MessagingLevel;
  /** WhatsApp template keys (`name:lang`) this rep may send; null = all approved templates. */
  @Prop({ type: [String], default: null }) waTemplateKeys: string[] | null;
  /** Email template ids this rep may send; null = all. */
  @Prop({ type: [String], default: null }) emailTemplateIds: string[] | null;
}

export const SalesRepAccessSchema = SchemaFactory.createForClass(SalesRepAccess);
