/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformTaxSettingsDocument = PlatformTaxSettings & Document;

/** ONE document (key 'platform'): Solvexo's own tax identity + country-wise rates charged on platform-plan fees. */
@Schema({ timestamps: true })
export class PlatformTaxSettings {
  @Prop({ type: String, default: 'platform', unique: true }) key: string;

  @Prop({ type: String, default: '' }) legalName: string;
  @Prop({ type: String, default: '' }) ntn: string;
  @Prop({ type: String, default: '' }) strn: string;
  @Prop({ type: String, default: 'FBR' }) authority: string;
  @Prop({ type: String, default: '' }) address: string;

  @Prop({
    type: [{
      _id: false,
      id: { type: String, required: true },
      country: { type: String, required: true },
      label: { type: String, default: 'Sales Tax' },
      ratePercent: { type: Number, required: true, min: 0, max: 100 },
      status: { type: String, enum: ['draft', 'confirmed'], default: 'draft' },
      effectiveFrom: { type: Date, default: null },
      stripeTaxRateId: { type: String, default: null },
    }],
    default: [],
  })
  rates: Array<{ id: string; country: string; label: string; ratePercent: number; status: 'draft' | 'confirmed'; effectiveFrom: Date | null; stripeTaxRateId: string | null }>;

  @Prop({ type: String, default: null }) updatedBy: string | null;
}

export const PlatformTaxSettingsSchema = SchemaFactory.createForClass(PlatformTaxSettings);
