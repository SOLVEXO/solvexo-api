import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreChatSettingsDocument = HydratedDocument<StoreChatSettings>;

/** One weekday of the store's chat hours (0 = Sunday ... 6 = Saturday), times as "HH:mm" in the store time zone. */
export interface ChatHoursDay { day: number; open: boolean; from: string; to: string }
export interface QuickReply { title: string; text: string }

/** How a store presents itself in the buyer chat, plus its auto-reply and canned replies. A missing field falls back to the
 *  store logo, the store name and the default line, so a store that never opens this screen looks exactly as before. */
@Schema({ timestamps: true })
export class StoreChatSettings {
  @Prop({ type: String, required: true, unique: true })
  storeId: string;

  @Prop({ type: String, default: null })
  avatarUrl: string | null;

  @Prop({ type: String, default: null })
  name: string | null;

  @Prop({ type: String, default: null })
  statusLine: string | null;

  @Prop({ type: String, default: null })
  greeting: string | null;

  /** Send `autoReplyText` when a buyer writes (at most once per 12 h per conversation). */
  @Prop({ type: Boolean, default: false })
  autoReplyEnabled: boolean;

  @Prop({ type: String, default: null })
  autoReplyText: string | null;

  /** true = only while the store is closed according to `hours`; false = whenever it is switched on. */
  @Prop({ type: Boolean, default: false })
  autoReplyOnlyOutsideHours: boolean;

  @Prop({ type: [Object], default: [] })
  hours: ChatHoursDay[];

  /** Seller-only canned replies: typing "/" in the seller chat suggests them. */
  @Prop({ type: [Object], default: [] })
  quickReplies: QuickReply[];
}

export const StoreChatSettingsSchema = SchemaFactory.createForClass(StoreChatSettings);
