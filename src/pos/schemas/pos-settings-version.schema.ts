/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosSettingsVersionDocument = PosSettingsVersion & Document;

/**
 * History of the POS settings that change how a sale is PRICED (tax rate, and the currency/rounding exponent the
 * maths is done in). `PosSettings.settingsVersion` always names the current row; every earlier row keeps
 * `supersededAt` so the server can still price a late (offline-synced) sale with the version the device used —
 * as long as that version was superseded no longer ago than the offline window.
 */
@Schema({ timestamps: true })
export class PosSettingsVersion {
  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: Number, required: true })
  version: number;

  @Prop({ type: Number, required: true, default: 0 })
  taxRate: number;

  @Prop({ type: String, required: true })
  currency: string;

  @Prop({ type: Number, required: true })
  currencyExponent: number;

  @Prop({ type: Date, required: true })
  effectiveFrom: Date;

  // null while this is the current version
  @Prop({ type: Date, default: null })
  supersededAt: Date | null;
}

export const PosSettingsVersionSchema = SchemaFactory.createForClass(PosSettingsVersion);
PosSettingsVersionSchema.index({ storeId: 1, version: 1 }, { unique: true });
