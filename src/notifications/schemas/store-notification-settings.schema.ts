/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreNotificationSettingsDocument = StoreNotificationSettings & Document;

/** One doc per store (same singleton-per-store convention as AbandonedCartSettings). No doc = every customer email
 *  ON with the built-in template, the store's name as sender and its contact email as reply-to. */
@Schema({ timestamps: true })
export class StoreNotificationSettings {
  @Prop({ required: true, unique: true })
  storeId: string;

  /** Sender display name on customer emails (default: the store name). */
  @Prop({ type: String, default: null })
  senderName: string | null;

  /** Where a customer's reply goes (default: the store's contact email). */
  @Prop({ type: String, default: null })
  replyToEmail: string | null;

  /** Per customer-email overrides, keyed by event (see customer-email-events.ts). `enabled:false` = never sent;
   *  `subject`/`body` = the seller's own text (plain text + {{tags}}); null/absent = the built-in default. */
  @Prop({ type: Object, default: {} })
  events: Record<string, { enabled?: boolean; subject?: string | null; body?: string | null }>;

  /** Accent colour (#rrggbb) for the heading, button and logo text of customer emails. */
  @Prop({ type: String, default: null })
  accentColor: string | null;

  /** Extra line shown in the footer of every customer email (e.g. an address or support hours). */
  @Prop({ type: String, default: null })
  footerText: string | null;

  /** Show the store logo at the top of customer emails (default on). */
  @Prop({ type: Boolean, default: true })
  showLogo: boolean;

  /** Delivery health (written when a customer email is sent): failures in a row since the last success. */
  @Prop({ type: Number, default: 0 })
  consecutiveEmailFailures: number;

  @Prop({ type: Date, default: null })
  lastEmailFailureAt: Date | null;

  /** Extra addresses that also get the "New order" email (Shopify staff order notifications). */
  @Prop({ type: [String], default: [] })
  staffOrderEmails: string[];

  @Prop({ default: false })
  isDelete: boolean;
}

export const StoreNotificationSettingsSchema = SchemaFactory.createForClass(StoreNotificationSettings);
