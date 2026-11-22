/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PartnerProgrammeSettingsDocument = PartnerProgrammeSettings & Document;

/** One document (key 'default'): the programme values, see partner-programme.util.ts ProgrammeSettings. */
@Schema({ timestamps: true, collection: 'partner_programme_settings' })
export class PartnerProgrammeSettings {
  @Prop({ type: String, required: true, unique: true, default: 'default' }) key: string;
  @Prop({ type: Object, required: true }) values: Record<string, unknown>;
  @Prop({ type: String, default: null }) updatedBy: string | null;
}

export const PartnerProgrammeSettingsSchema = SchemaFactory.createForClass(PartnerProgrammeSettings);
