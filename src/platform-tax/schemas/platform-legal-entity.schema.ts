/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformLegalEntityDocument = PlatformLegalEntity & Document;

/** A legal entity that issues Solvexo's own invoices. Today a read-only projection of Admin → Settings → Tax (see PlatformEntityService). */
@Schema({ timestamps: true, collection: 'platform_legal_entities' })
export class PlatformLegalEntity {
  @Prop({ type: String, required: true }) entityKey: string;
  @Prop({ type: String, default: '' }) legalName: string;
  @Prop({ type: String, default: '' }) address: string;
  /** Country of incorporation (ISO alpha-2), null when it cannot be derived. */
  @Prop({ type: String, default: null }) country: string | null;
  @Prop({ type: String, default: 'settings_projection' }) source: string;
}

export const PlatformLegalEntitySchema = SchemaFactory.createForClass(PlatformLegalEntity);
PlatformLegalEntitySchema.index({ entityKey: 1 }, { unique: true });
