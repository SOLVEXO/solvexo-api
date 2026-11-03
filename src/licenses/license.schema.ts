import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LicenseKeyDocument = LicenseKey & Document;

@Schema({ timestamps: true, collection: 'licensekeys' })
export class LicenseKey {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) productId: string;
  @Prop({ required: true }) customerId: string;
  @Prop({ required: true }) orderId: string;
  @Prop({ required: true }) orderItemId: string;

  @Prop({ required: true }) keyHash: string; // sha256 of the normalised key: used for validation
  @Prop({ required: true, select: false }) keyEnc: string; // AES-GCM copy, only so the BUYER can see their key again
  @Prop({ required: true }) keyHint: string; // last 4 chars for the seller UI

  @Prop({ type: Number, default: 1, min: 1 }) activationLimit: number;
  @Prop({ type: [{ deviceHash: String, ip: String, firstSeen: Date, lastSeen: Date, _id: false }], default: [] })
  activations: { deviceHash: string; ip: string; firstSeen: Date; lastSeen: Date }[];

  @Prop({ type: String, enum: ['active', 'revoked'], default: 'active' }) status: string;
}
export const LicenseKeySchema = SchemaFactory.createForClass(LicenseKey);
LicenseKeySchema.index({ storeId: 1, keyHash: 1 }, { unique: true });
LicenseKeySchema.index({ storeId: 1, orderItemId: 1 }, { unique: true });
LicenseKeySchema.index({ storeId: 1, customerId: 1 });
