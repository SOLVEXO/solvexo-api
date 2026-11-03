/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PosDeviceDocument = PosDevice & Document;

/**
 * A registered POS terminal. The owner signs in once on the device, registers it for ONE store + register, and the
 * app then keeps only the long-lived device token (JWT `type:'pos_device'`, `jti` = this document's _id) — the
 * owner's own session is discarded. The token is only honoured while this row is `active`, so the owner can revoke
 * a lost/stolen/retired device instantly (PosAuthGuard looks the row up on every request).
 */
@Schema({ timestamps: true })
export class PosDevice {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) registerId: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 80 }) name: string;
  @Prop({ type: String, default: null }) platform: string | null;
  @Prop({ type: String, enum: ['active', 'revoked'], default: 'active', index: true }) status: 'active' | 'revoked';
  @Prop({ type: Date, default: null }) lastSeenAt: Date | null;
  @Prop({ type: String, default: null }) lastIp: string | null;
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ type: String, default: null }) revokedBy: string | null;
}

export const PosDeviceSchema = SchemaFactory.createForClass(PosDevice);
PosDeviceSchema.index({ storeId: 1, status: 1 });
