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
}



export const SellerSchema = SchemaFactory.createForClass(Seller); 