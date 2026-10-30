import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DigitalAccessDocument = DigitalAccess & Document;

/** Who may use what. DigitalAccessService.can() is the ONLY gate for digital files/pages/lessons/keys. */
@Schema({ timestamps: true, collection: 'digitalaccesses' })
export class DigitalAccess {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) customerId: string;

  @Prop({ type: String, enum: ['file', 'page', 'lesson', 'key', 'course'], default: 'file' }) resourceKind: string;
  @Prop({ required: true }) resourceRef: string; // productId for files

  @Prop({ type: String, enum: ['purchase', 'plan', 'manual', 'gift', 'coupon'], default: 'purchase' }) grantedBy: string;
  @Prop({ type: String, default: null }) sourceOrderId: string | null;
  @Prop({ type: String, default: '' }) sourceOrderItemId: string; // '' when not order based (keeps the unique index simple)
  @Prop({ type: String, default: null }) sourcePlanId: string | null;

  @Prop({ type: Date, default: null }) expiresAt: Date | null;
  @Prop({ type: String, enum: ['active', 'expired', 'revoked'], default: 'active' }) status: string;
  @Prop({ type: Number, default: 0 }) downloadCount: number;
  @Prop({ type: Boolean, default: false }) flagged: boolean;

  @Prop({ type: [{ at: Date, action: String, by: String, note: String, _id: false }], default: [] })
  audit: { at: Date; action: string; by: string; note: string }[];
}
export const DigitalAccessSchema = SchemaFactory.createForClass(DigitalAccess);
DigitalAccessSchema.index(
  { storeId: 1, customerId: 1, resourceKind: 1, resourceRef: 1, sourceOrderItemId: 1 },
  { unique: true },
);
DigitalAccessSchema.index({ storeId: 1, sourceOrderId: 1 });

export type DeliveryDocument = DeliveryLog & Document;

@Schema({ timestamps: { createdAt: 'at', updatedAt: false }, collection: 'deliverylogs' })
export class DeliveryLog {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) customerId: string;
  @Prop({ type: String, default: null }) productId: string | null;
  @Prop({ type: Number, default: null }) fileIndex: number | null;
  @Prop({ type: String, enum: ['ok', 'denied', 'failed'], required: true }) outcome: string;
  @Prop({ type: String, default: '' }) reason: string;
  @Prop({ type: String, default: '' }) ip: string;
  @Prop({ type: String, default: '' }) userAgent: string;
  @Prop({ type: Boolean, default: false }) flagged: boolean;
}
export const DeliveryLogSchema = SchemaFactory.createForClass(DeliveryLog);
DeliveryLogSchema.index({ storeId: 1, at: -1 });
DeliveryLogSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });
