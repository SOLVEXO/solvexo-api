/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ShippingZoneDocument = ShippingZone & Document;

@Schema({ timestamps: true })
export class ShippingZone {

  // null = platform-wide default zone (the original, pre-existing behavior —
  // admin-managed, used as a checkout fallback for any store with none of
  // its own zones). Set = a real seller's own store-scoped zone/rate.
  @Prop({ type: Types.ObjectId, ref: 'Store', default: null })
  storeId: Types.ObjectId | null;

  // 'shipping' = a normal zone (matched checkout option). 'local_delivery' =
  // Shopify-style local delivery — same shape (city/price/eta), just a
  // separate seller-managed list shown in its own tab/section.
  @Prop({ enum: ['shipping', 'local_delivery'], default: 'shipping' })
  zoneType: 'shipping' | 'local_delivery';

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
ShippingZoneSchema.index({ storeId: 1 });