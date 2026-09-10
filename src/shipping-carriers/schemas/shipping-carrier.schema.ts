import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ShippingCarrierDocument = HydratedDocument<ShippingCarrier>;

// A seller's own named carrier (e.g. "TCS", "Leopards Courier", "DHL") — feeds
// the Orders "mark as shipped" tracking-number dropdown instead of a free-text
// field, and (via `trackingUrlTemplate`) auto-builds a real tracking link.
@Schema({ timestamps: true })
export class ShippingCarrier {
  @Prop({ type: Types.ObjectId, ref: 'Store', required: true })
  storeId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  // Optional URL containing a literal `{tracking}` placeholder, e.g.
  // "https://www.tcscourier.com/track/{tracking}" — substituted client-side
  // once a seller enters a tracking number for an order shipped via this carrier.
  @Prop({ type: String, default: null })
  trackingUrlTemplate: string | null;

  @Prop({ default: true })
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const ShippingCarrierSchema = SchemaFactory.createForClass(ShippingCarrier);
ShippingCarrierSchema.index({ storeId: 1 });
