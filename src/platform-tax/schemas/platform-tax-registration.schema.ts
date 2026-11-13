/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformTaxRegistrationDocument = PlatformTaxRegistration & Document;

/** One tax registration of an entity (e.g. NTN / STRN in Pakistan). The authority decides which adapter would file for it. */
@Schema({ timestamps: true, collection: 'platform_tax_registrations' })
export class PlatformTaxRegistration {
  @Prop({ type: String, required: true }) entityKey: string;
  @Prop({ type: String, required: true }) country: string;
  /** 'NTN' | 'STRN' | ... */
  @Prop({ type: String, required: true }) type: string;
  @Prop({ type: String, default: '' }) number: string;
  /** PK_FBR | PK_SRB | ... | OTHER */
  @Prop({ type: String, default: 'OTHER' }) authority: string;
}

export const PlatformTaxRegistrationSchema = SchemaFactory.createForClass(PlatformTaxRegistration);
PlatformTaxRegistrationSchema.index({ entityKey: 1, country: 1, type: 1 }, { unique: true });
