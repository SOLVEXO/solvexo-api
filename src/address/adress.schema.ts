/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AddressDocument = Address & Document;

@Schema({ timestamps: true })
export class Address {

  // 👤 user reference
  @Prop({ type: String, required: true })
  userId: string;

  // 🏷 label (Home, Work, Other)
  @Prop({ type: String, required: true })
  label: string;

  // 👤 recipient name
  @Prop({ type: String, required: true })
  recipientName: string;

  // 📞 phone number
  @Prop({ type: String, required: true })
  phoneNumber: string;

  // 🏠 street / P.O Box
  @Prop({ type: String, required: true })
  addressLine1: string;

  // 🏢 apartment / suite / floor
  @Prop({ type: String, default: null })
  addressLine2: string;

  // 🌍 state
  @Prop({ type: String, required: true })
  state: string;

  // 🏙 city
  @Prop({ type: String, required: true })
  city: string;

  // 📮 zip code
  @Prop({ type: String, required: true })
  zipCode: string;

  // ⭐ default address
  @Prop({ type: Boolean, default: false })
  isDefault: boolean;

  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status: string;

  @Prop({ default: false })
  isDelete: boolean;
}

export const AddressSchema = SchemaFactory.createForClass(Address);

AddressSchema.index({ userId: 1 });
AddressSchema.index({ userId: 1, isDefault: 1 });