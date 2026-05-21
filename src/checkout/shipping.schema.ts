/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ShippingZoneDocument = ShippingZone & Document;

@Schema({ timestamps: true })
export class ShippingZone {

  // country name
  @Prop({ required: true })
  country: string;

  // province / state
  @Prop({ type: String, default: null })
  province: string | null;

  // city
  @Prop({ type: String, default: null })
  city: string | null;

  // shipping charges
  @Prop({ required: true, default: 0 })
  shippingPrice: number;

  // estimated delivery time
  // example: 3-5 Days
  @Prop({ type: String, default: null })
  estimatedDeliveryTime: string;

  
  // shipping active/inactive
  @Prop({
    enum: ['active', 'inactive'],
    default: 'active',
  })
  status: string;

  // soft delete
  @Prop({ default: false })
  isDelete: boolean;

}

export const ShippingZoneSchema =
  SchemaFactory.createForClass(ShippingZone);

// indexes
ShippingZoneSchema.index({ country: 1 });
ShippingZoneSchema.index({ province: 1 });
ShippingZoneSchema.index({ city: 1 });