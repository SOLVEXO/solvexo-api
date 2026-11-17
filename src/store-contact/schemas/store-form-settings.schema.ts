/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreFormSettingsDocument = HydratedDocument<StoreFormSettings>;

/** Per-store settings of the storefront forms that must never sit in a (public) section: the CAPTCHA keys. */
@Schema({ timestamps: true })
export class StoreFormSettings {
  _id: string;

  @Prop({ required: true, unique: true })
  storeId: string;

  /** Cloudflare Turnstile site key (public by design: the visitor's browser needs it). */
  @Prop({ type: String, default: null })
  turnstileSiteKey: string | null;

  /** Cloudflare Turnstile secret key, AES-GCM encrypted. Never returned to any browser. */
  @Prop({ type: String, default: null, select: false })
  turnstileSecretEnc: string | null;
}

export const StoreFormSettingsSchema = SchemaFactory.createForClass(StoreFormSettings);
