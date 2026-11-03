/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RefreshTokenFamilyDocument = RefreshTokenFamily & Document;

/**
 * One document per portal (cookie-mode) login session. The refresh JWT carries `fam` (this id) and `jti` (the current
 * token's id); only SHA-256 hashes of jtis are stored. Rotating moves the current hash into `usedJtis`; presenting an
 * already-used jti is reuse → the whole family is revoked. Mobile (body-mode) refresh tokens never create one.
 */
@Schema({ timestamps: true })
export class RefreshTokenFamily {
  @Prop({ type: String, required: true, unique: true }) familyId: string;
  @Prop({ type: String, required: true, index: true }) userId: string;
  @Prop({ type: String, required: true }) role: string;
  @Prop({ type: String, required: true }) currentJtiHash: string;
  @Prop({ type: String, default: null }) prevJtiHash: string | null;
  @Prop({ type: Date, default: null }) rotatedAt: Date | null;
  @Prop({ type: [String], default: [] }) usedJtis: string[];
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ type: String, default: null }) revokedReason: string | null;
  @Prop({ type: Date, required: true }) expiresAt: Date;
}
export const RefreshTokenFamilySchema = SchemaFactory.createForClass(RefreshTokenFamily);
RefreshTokenFamilySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
