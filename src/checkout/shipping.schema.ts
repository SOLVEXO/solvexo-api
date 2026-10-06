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
  // 'pickup' = Shopify-style local pickup (always free; address/instructions shown to the buyer).
  @Prop({ enum: ['shipping', 'local_delivery', 'pickup'], default: 'shipping' })
  zoneType: 'shipping' | 'local_delivery' | 'pickup';

  // Shopify shipping profile this rate belongs to. null/absent = the implicit "General profile"
  // (every zone created before profiles existed).
  @Prop({ type: String, default: null })
  profileId: string | null;

  // Optional region label ("Domestic", "Europe") — rows sharing country+province+regionName are shown as one
  // region card with several named rates in the seller UI. Purely presentational.
  @Prop({ type: String, default: null })
  regionName: string | null;

  // Local delivery radius (km) from the profile's first ship-from location. null = no radius rule.
  @Prop({ type: Number, default: null })
  radiusKm: number | null;

  // Optional display name for the rate/option (e.g. "Standard", "Express", "Pick up at our shop").
  @Prop({ type: String, default: null })
  name: string | null;

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

  // How the rate is worked out (Shopify: flat / by weight / by price). For 'weight' tiers are in kg,
  // for 'price' tiers are in the store's own currency (order subtotal). 'flat' uses shippingPrice.
  @Prop({ enum: ['flat', 'weight', 'price'], default: 'flat' })
  rateType: 'flat' | 'weight' | 'price';

  @Prop({
    type: [{ _id: false, min: { type: Number, required: true }, max: { type: Number, default: null }, price: { type: Number, required: true } }],
    default: [],
  })
  rateTiers: { min: number; max: number | null; price: number }[];

  // Order subtotal (store currency) at/above which this option is free. null = no free-shipping rule.
  @Prop({ type: Number, default: null })
  freeShippingThreshold: number | null;

  // Local pickup details (zoneType 'pickup').
  @Prop({ type: String, default: null })
  pickupAddress: string | null;

  @Prop({ type: String, default: null })
  pickupInstructions: string | null;

  // Numeric delivery window in days (optional) — lets checkout show "Arrives <date range>".
  @Prop({ type: Number, default: null })
  minDays: number | null;

  @Prop({ type: Number, default: null })
  maxDays: number | null;

  // Local delivery (zoneType 'local_delivery') by postcode list. Empty = fall back to the city/area match.
  @Prop({ type: [String], default: [] })
  postalCodes: string[];

  // Minimum order subtotal (store currency) for this option. null = none.
  @Prop({ type: Number, default: null })
  minOrderAmount: number | null;

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
ShippingZoneSchema.index({ storeId: 1, profileId: 1 });

export type ShippingProfileDocument = ShippingProfile & Document;

/**
 * Shopify "shipping profile": a set of shipping rates (ShippingZone rows with this profileId) applied to the
 * products assigned to it (Product.shippingProfileId), shipped from the profile's origin locations.
 * Exactly one per store is the General profile (isGeneral) — it is created lazily and owns every zone/product
 * whose profileId is null.
 */
@Schema({ timestamps: true })
export class ShippingProfile {
  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 80 })
  name: string;

  @Prop({ type: Boolean, default: false })
  isGeneral: boolean;

  // StoreLocation ids that ship this profile. The first one is the Shippo origin / local-delivery origin.
  @Prop({ type: [String], default: [] })
  originLocationIds: string[];

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const ShippingProfileSchema = SchemaFactory.createForClass(ShippingProfile);
ShippingProfileSchema.index({ storeId: 1, isDelete: 1 });
// Exactly one live General profile per store.
ShippingProfileSchema.index(
  { storeId: 1 },
  { unique: true, partialFilterExpression: { isGeneral: true, isDelete: false }, name: 'uniq_general_profile_per_store' },
);