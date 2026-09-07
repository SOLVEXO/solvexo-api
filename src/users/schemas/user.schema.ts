/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {


 @Prop()
  name: string;

  @Prop({ required: true })
  email: string;

  // null = a legacy/apex-era global account (works on every store, same as
  // before this field existed). A non-null value means this account was
  // created through THAT specific store's own storefront — a genuinely
  // separate identity from any other account sharing the same email,
  // exactly like a real Shopify store's own customer accounts. Uniqueness
  // is enforced on {storeId, email} below, not on email alone, so the same
  // email can have one row per store plus at most one legacy null row.
  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ required: false})
  providerId: string;
  
  @Prop({ required: false  })
  authProvider: string;

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

    // One Stripe Customer object per platform user, shared across every seller's
    // subscription plan they subscribe to (a buyer should never get a second
    // Stripe Customer just because they joined a second store's plan).
    @Prop({ type: String, default: null, index: true })
    stripeCustomerId: string | null;

    // Explicit buyer currency choice (see UpdateProfileDto.currencyPreference)
    // — null means "not yet chosen", in which case CheckoutService falls
    // back to a guest-style cookie/location-based default rather than
    // forcing one. Once set here, it's the cross-device source of truth and
    // is never silently overridden by IP/locale detection again.
    @Prop({ type: String, default: null })
    currencyPreference: string | null;

    // Bumped whenever this account is suspended/deactivated so any
    // already-issued JWT is invalidated on its next request — see
    // JwtAuthGuard, which rejects a token whose tokenVersion claim doesn't
    // match this current DB value.
    @Prop({ default: 0 })
    tokenVersion: number;
}



export const UserSchema = SchemaFactory.createForClass(User);

// Replaces the old bare unique index on `email` alone — see migration
// script `scripts/migrate-user-store-scoped-email.ts`, which must run once
// against any pre-existing database before this is enforced there (a fresh
// database gets this correctly via autoIndex with no migration needed).
UserSchema.index({ storeId: 1, email: 1 }, { unique: true });