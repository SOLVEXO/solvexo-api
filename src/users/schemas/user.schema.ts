

/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type UserDocument = User & Document;

@Schema({ timestamps: true })
export class User {


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


    @Prop({default: false })
    isDelete: boolean ;
}



export const UserSchema = SchemaFactory.createForClass(User);