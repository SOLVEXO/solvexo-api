/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { User } from '@/users/schemas/user.schema';

export type AdminDocument = Admin & Document;

@Schema({ timestamps: true })
export class Admin {


 @Prop()
  name: string;

  @Prop({ required: true, unique: true })
  email: string;


  @Prop()
  phone: string;

  @Prop()
  address: string;


  @Prop()
  password: string;

  @Prop()
  otp: string;
  
   @Prop()
   otpExpiresAt: Date;

  // Wrong-guess counter for the current OTP (see common/otp.util.ts); reset when a code is issued.
  @Prop({ default: 0 })
  otpAttempts: number;

  @Prop({ default: false })
  isVerified: boolean;


  @Prop({ default: null })
  profileImage: string;


  @Prop({required: false })
  fcmToken: string;

  @Prop({required: false , default: "active" })
  status: string;

    @Prop({required: true})
  role: string;


    @Prop({default: false })
    isDelete: boolean ;

    // Bumped whenever this account is suspended/deactivated so any
    // already-issued JWT is invalidated on its next request — see
    // JwtAuthGuard, which rejects a token whose tokenVersion claim doesn't
    // match this current DB value.
    @Prop({ default: 0 })
    tokenVersion: number;

    // Language preference for the admin UI. Defaults to 'en'.
    @Prop({ type: String, default: 'en' })
    languagePreference: string;

    // ── Admin Team ──────────────────────────────────────────────────────────
    // The platform owner (and anyone the owner promotes) is a Super Admin: never permission-checked.
    @Prop({ default: false }) isSuperAdmin: boolean;
    // A team admin has a role (permissions live on AdminRole); no role + not super = legacy full access until migrated.
    @Prop({ type: String, default: null }) roleId: string | null;
    @Prop({ type: String, default: null }) createdByAdminId: string | null;
    @Prop({ type: String, default: null, select: false }) inviteTokenHash: string | null;
    @Prop({ type: Date, default: null }) inviteTokenExpiresAt: Date | null;
    @Prop({ type: Date, default: null }) inviteSentAt: Date | null;
    @Prop({ type: Date, default: null }) inviteAcceptedAt: Date | null;
    @Prop({ type: String, default: null, select: false }) resetTokenHash: string | null;
    @Prop({ type: Date, default: null }) resetTokenExpiresAt: Date | null;
    @Prop({ type: Number, default: 0 }) failedLoginCount: number;
    @Prop({ type: Date, default: null }) lockedUntil: Date | null;
    // Temporary access: after this moment the admin can no longer log in or use an open session.
    @Prop({ type: Date, default: null }) accessExpiresAt: Date | null;
    @Prop({ type: Date, default: null }) lastLoginAt: Date | null;
    @Prop({ type: String, default: null }) lastLoginIp: string | null;
    @Prop({ type: [{ sid: String, ip: String, userAgent: String, createdAt: Date, lastSeenAt: Date }], default: [], _id: false })
    sessions: { sid: string; ip: string | null; userAgent: string | null; createdAt: Date; lastSeenAt: Date }[];
    // sha256(ip|userAgent) of devices that already logged in: a new one triggers a login alert.
    @Prop({ type: [String], default: [] }) knownDevices: string[];
}



export const AdminSchema = SchemaFactory.createForClass(Admin);