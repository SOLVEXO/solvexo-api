/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { DEFAULT_COD_SETTINGS } from './cod-risk.util';

/** One document per store: the seller's cash-on-delivery protection rules. Off by default. */
@Schema({ timestamps: true, collection: 'codprotectionsettings' })
export class CodProtectionSettings {
  @Prop({ required: true, unique: true }) storeId: string;
  @Prop({ type: Boolean, default: DEFAULT_COD_SETTINGS.enabled }) enabled: boolean;
  @Prop({ type: Number, default: null, min: 1 }) maxCodAmount: number | null;
  @Prop({ type: Boolean, default: DEFAULT_COD_SETTINGS.confirmNewCustomers }) confirmNewCustomers: boolean;
  @Prop({ type: Number, default: null, min: 1 }) confirmAboveAmount: number | null;
  @Prop({ type: [String], default: [] }) flaggedCities: string[];
  @Prop({ type: [String], default: [] }) blockedPhones: string[];
  @Prop({ type: [String], default: [] }) blockedAddresses: string[];
  @Prop({ type: Number, default: DEFAULT_COD_SETTINGS.highRiskScore, min: 10, max: 100 }) highRiskScore: number;
  @Prop({ type: Boolean, default: DEFAULT_COD_SETTINGS.highRiskPrepayOnly }) highRiskPrepayOnly: boolean;
  @Prop({ type: Number, default: DEFAULT_COD_SETTINGS.confirmationHours, min: 1, max: 168 }) confirmationHours: number;
}
export type CodProtectionSettingsDocument = CodProtectionSettings & Document;
export const CodProtectionSettingsSchema = SchemaFactory.createForClass(CodProtectionSettings);
