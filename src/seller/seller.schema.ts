/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type SellerDocument = Seller & Document;

@Schema({ timestamps: true })
export class Seller {


 @Prop()                 
  name: string;

  @Prop({ required: true, unique: true })
  email: string;

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


    @Prop({ default: false })
    isDelete: boolean;

    @Prop({ default: null })
    storeId!: string;

    @Prop({ default: false })
    isOnboarded!: boolean;

    // Stripe Customer for PLATFORM-PLAN billing (seller paying Solvexo) — a
    // completely separate Stripe customer from any `User.stripeCustomerId`
    // the same person might also have as a buyer of someone else's VIP plan.
    @Prop({ type: String, default: null })
    stripeCustomerId: string | null;

    // Bumped whenever this account is suspended/deactivated so any
    // already-issued JWT is invalidated on its next request — see
    // JwtAuthGuard, which rejects a token whose tokenVersion claim doesn't
    // match this current DB value.
    @Prop({ default: 0 })
    tokenVersion: number;

    // Snapshot of the store ids this seller's own OWNED stores that were
    // auto-suspended as a side effect of THIS seller being suspended (see
    // AdminUsersService.suspend/unsuspend and AdminModerationService.remove).
    // Only these stores are restored to 'active' on unsuspend — a store that
    // was already suspended for an unrelated reason before this seller was
    // suspended is never in this list, so it's correctly left untouched.
    @Prop({ type: [String], default: [] })
    cascadeSuspendedStoreIds: string[];
}



export const SellerSchema = SchemaFactory.createForClass(Seller); 