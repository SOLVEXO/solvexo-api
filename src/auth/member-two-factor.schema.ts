/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** Two-factor state of one seller or staff member. Kept apart from the account document on purpose. */
@Schema({ timestamps: true, collection: 'member_two_factor' })
export class MemberTwoFactor {
  @Prop({ required: true, enum: ['seller', 'staff'] }) kind: string;
  @Prop({ required: true }) memberId: string;
  @Prop({ default: false }) enabled: boolean;
  @Prop({ type: Date, default: null }) enabledAt: Date | null;
  @Prop({ type: String, default: null }) secretEnc: string | null;
  @Prop({ type: String, default: null }) pendingSecretEnc: string | null;
  @Prop({ type: [String], default: [] }) recoveryHashes: string[];
  /** Highest TOTP step already used, so the same code cannot be used twice. */
  @Prop({ default: 0 }) lastStep: number;
  @Prop({ default: 0 }) failedCount: number;
  @Prop({ type: Date, default: null }) lockedUntil: Date | null;
}
export type MemberTwoFactorDocument = HydratedDocument<MemberTwoFactor>;
export const MemberTwoFactorSchema = SchemaFactory.createForClass(MemberTwoFactor);
MemberTwoFactorSchema.index({ kind: 1, memberId: 1 }, { unique: true });
