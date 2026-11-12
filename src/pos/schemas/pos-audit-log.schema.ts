import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';

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

  // G1a: where it happened (nullable — older rows and store-level events have none)
  @Prop({ type: String, default: null })
  sessionId: string | null;

  @Prop({ type: String, default: null })
  registerId: string | null;

  @Prop({ type: String, default: null })
  shiftId: string | null;

  @Prop({ type: String, default: null })
  deviceId: string | null;
}

export const PosAuditLogSchema = SchemaFactory.createForClass(PosAuditLog);

PosAuditLogSchema.index({ storeId: 1, createdAt: -1 });
PosAuditLogSchema.index({ employeeId: 1 });
PosAuditLogSchema.index({ action: 1 });
PosAuditLogSchema.index({ targetId: 1 });

// Append-only: no update or delete path through the model (see pos-immutable.util.ts).
makeAppendOnly(PosAuditLogSchema);
