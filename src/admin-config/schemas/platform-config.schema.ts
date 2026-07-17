/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformConfigDocument = PlatformConfig & Document;

@Schema({ _id: false })
export class FeatureFlags {
  @Prop({ type: Boolean, default: true }) aiStudio: boolean;
  @Prop({ type: Boolean, default: true }) marketplace: boolean;
  @Prop({ type: Boolean, default: true }) digitalUploads: boolean;
  @Prop({ type: Boolean, default: false }) affiliateProgram: boolean;
  @Prop({ type: Boolean, default: false }) giftCards: boolean;
  @Prop({ type: Boolean, default: true }) posMode: boolean;
  @Prop({ type: Boolean, default: true }) storeBuilder: boolean;
  @Prop({ type: Boolean, default: false }) bulkProductImport: boolean;
}
export const FeatureFlagsSchema = SchemaFactory.createForClass(FeatureFlags);

@Schema({ _id: false })
export class AiConfig {
  @Prop({ type: Number, default: 1000 }) monthlyCreditLimit: number;
  @Prop({ type: String, default: 'claude-sonnet-5' }) aiModel: string;
}
export const AiConfigSchema = SchemaFactory.createForClass(AiConfig);

@Schema({ _id: false })
export class EmailConfig {
  @Prop({ type: String, default: 'Solvexo' }) fromName: string;
  @Prop({ type: String, default: null }) fromEmail: string | null;
  @Prop({ type: String, default: null }) replyToEmail: string | null;
  @Prop({ type: String, default: 'SendGrid' }) provider: string;
}
export const EmailConfigSchema = SchemaFactory.createForClass(EmailConfig);

// Singleton collection — exactly one document ever exists, fetched/updated via
// upsert with an empty filter (see AdminConfigService), same convention used
// for other platform-wide single-doc settings in this codebase.
@Schema({ timestamps: true })
export class PlatformConfig {
  @Prop({ type: Boolean, default: false })
  maintenanceMode: boolean;

  @Prop({ type: FeatureFlagsSchema, default: () => ({}) })
  featureFlags: FeatureFlags;

  @Prop({ type: AiConfigSchema, default: () => ({}) })
  aiConfig: AiConfig;

  @Prop({ type: EmailConfigSchema, default: () => ({}) })
  emailConfig: EmailConfig;
}

export const PlatformConfigSchema = SchemaFactory.createForClass(PlatformConfig);
