import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreChatSettingsDocument = HydratedDocument<StoreChatSettings>;

/** How a store presents itself in the buyer chat header and empty chat. A missing field falls back to the store logo,
 *  the store name and the default line, so a store that never opens this screen looks exactly as before. */
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
}

export const StoreChatSettingsSchema = SchemaFactory.createForClass(StoreChatSettings);
