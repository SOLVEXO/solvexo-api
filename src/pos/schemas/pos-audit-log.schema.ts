/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosAuditLogDocument = PosAuditLog & Document;

@Schema({ timestamps: true })
export class PosAuditLog {
  @Prop({ required: true })
  storeId: string;

  @Prop({ type: String, default: null })
  employeeId: string | null;

  @Prop({ required: true })
  action: string;

  @Prop({ type: String, default: null })
  targetId: string | null;

  @Prop({ type: String, default: null })
  targetType: string | null;

  @Prop({ type: Object, default: null })
  metadata: object | null;
}

export const PosAuditLogSchema = SchemaFactory.createForClass(PosAuditLog);

PosAuditLogSchema.index({ storeId: 1, createdAt: -1 });
PosAuditLogSchema.index({ employeeId: 1 });
PosAuditLogSchema.index({ action: 1 });
PosAuditLogSchema.index({ targetId: 1 });
