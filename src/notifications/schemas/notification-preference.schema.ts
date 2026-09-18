/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NotificationPreferenceDocument = NotificationPreference & Document;

@Schema({ _id: false })
class PrefFlags {
  @Prop({ default: true })
  orders: boolean;

  @Prop({ default: true })
  messages: boolean;

  @Prop({ default: true })
  promotions: boolean;

  @Prop({ default: true })
  loyalty: boolean;

  @Prop({ default: true })
  subscriptions: boolean;

  @Prop({ default: true })
  finance: boolean;
}

const PrefFlagsSchema = SchemaFactory.createForClass(PrefFlags);

@Schema({ timestamps: true })
export class NotificationPreference {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true, enum: ['user', 'seller'] })
  role: string;

  // Store-scoped preferences — a seller with multiple stores gets a
  // genuinely separate preference doc per store (e.g. push on for a live
  // store, off for a dormant one), matching this app's existing convention
  // of scoping the notification INBOX itself by storeId (see
  // NotificationsService.unreadCount/markAllRead). `null` is the
  // account-wide row: every buyer (role:'user', which has no store
  // context at all) and the seller's own cross-store pages
  // (/seller/analytics, /seller/settings) both read/write this row.
  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: PrefFlagsSchema, default: () => ({}) })
  prefs: PrefFlags;

  @Prop({ default: true })
  pushEnabled: boolean;

  @Prop({ default: true })
  emailEnabled: boolean;
}

export const NotificationPreferenceSchema = SchemaFactory.createForClass(NotificationPreference);
// Replaces the old single-field unique index on `userId` alone (a real
// production DB needs that old index dropped once —
// `db.notificationpreferences.dropIndex('userId_1')` — before a second
// per-store row for the same seller can be inserted there).
NotificationPreferenceSchema.index({ userId: 1, storeId: 1 }, { unique: true });
