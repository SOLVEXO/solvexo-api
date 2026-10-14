import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AdminRoleDocument = AdminRole & Document;

/** A named bundle of admin permissions (platform level — no store). `readOnly` roles can never change anything. */
@Schema({ timestamps: true })
export class AdminRole {
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, default: null }) description: string | null;
  @Prop({ type: [String], default: [] }) permissions: string[];
  @Prop({ default: false }) readOnly: boolean;
  @Prop({ default: false }) isPreset: boolean;
  @Prop({ type: String, default: null }) presetKey: string | null;
  @Prop({ default: false }) isDelete: boolean;
}

export const AdminRoleSchema = SchemaFactory.createForClass(AdminRole);
AdminRoleSchema.index({ isDelete: 1, name: 1 });
